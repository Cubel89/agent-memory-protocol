/**
 * consolidate.ts - Offline maintenance for the memory database.
 *
 * What it does:
 *   1. Detects near-duplicate preference pairs (same scope, cosine
 *      similarity above PREF_SIMILARITY_THRESHOLD) and, in apply mode,
 *      invalidates the weaker one (reversible: invalidated_at +
 *      superseded_by pointing at the survivor's key, never DELETE).
 *   2. Purges experiences that were soft-deleted more than
 *      PURGE_SOFT_DELETED_DAYS days ago (definitive DELETE of rows already
 *      marked as deleted; the FTS delete trigger keeps the index in sync).
 *   3. Removes orphaned vector rows (vec_experiences / vec_preferences
 *      entries whose parent row no longer exists) and rebuilds the FTS
 *      index from the content table.
 *   4. Runs VACUUM and reports the bytes reclaimed.
 *
 * Meant for manual or cron execution through the CLI (`consolidate`
 * subcommand) — NEVER called from the request hot path. Functions take the
 * database handle as a parameter so they can be tested against temporary
 * databases; production passes the singleton from database.ts.
 */

import type BetterSqlite3 from "better-sqlite3";
import {
  findSimilarPreferencePairs,
  PREF_SIMILARITY_THRESHOLD,
  type SimilarPreferencePair,
} from "./preference-dedupe.js";

/** Soft-deleted experiences older than this many days are purged for real. */
export const PURGE_SOFT_DELETED_DAYS = 90;

export interface ConsolidationReport {
  applied: boolean;
  similarityThreshold: number;
  /** Near-duplicate pairs detected (dry-run and apply). */
  pairs: SimilarPreferencePair[];
  /** Preferences actually invalidated (0 in dry-run). */
  invalidated: number;
  /** Soft-deleted experiences eligible for purge. */
  purgeable: number;
  /** Rows actually purged (0 in dry-run). */
  purged: number;
  /** Orphaned vec_experiences rows removed (0 in dry-run). */
  orphanExperienceVectors: number;
  /** Orphaned vec_preferences rows removed (0 in dry-run). */
  orphanPreferenceVectors: number;
  /** Whether the FTS index was rebuilt from the content table. */
  ftsRebuilt: boolean;
  /** Bytes reclaimed by VACUUM (0 in dry-run). */
  bytesReclaimed: number;
}

function dbSizeBytes(db: BetterSqlite3.Database): number {
  const pageCount = db.pragma("page_count", { simple: true }) as number;
  const pageSize = db.pragma("page_size", { simple: true }) as number;
  return pageCount * pageSize;
}

function countOrphans(db: BetterSqlite3.Database, vecTable: string, idColumn: string, parentTable: string): number {
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS count FROM ${vecTable}
         WHERE ${idColumn} NOT IN (SELECT id FROM ${parentTable})`
      )
      .get() as { count: number };
    return row.count;
  } catch {
    return 0; // vec table missing (sqlite-vec unavailable)
  }
}

function deleteOrphans(db: BetterSqlite3.Database, vecTable: string, idColumn: string, parentTable: string): number {
  try {
    const result = db
      .prepare(
        `DELETE FROM ${vecTable}
         WHERE ${idColumn} NOT IN (SELECT id FROM ${parentTable})`
      )
      .run();
    return result.changes;
  } catch {
    return 0;
  }
}

/**
 * Run the consolidation. Without `apply` it is a dry-run: everything is
 * detected and counted but nothing is modified.
 */
export function runConsolidation(
  db: BetterSqlite3.Database,
  options: { apply: boolean; similarityThreshold?: number; purgeDays?: number }
): ConsolidationReport {
  const threshold = options.similarityThreshold ?? PREF_SIMILARITY_THRESHOLD;
  const purgeDays = options.purgeDays ?? PURGE_SOFT_DELETED_DAYS;

  const pairs = findSimilarPreferencePairs(db, threshold);

  const purgeable = (
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM experiences
         WHERE deleted_at IS NOT NULL
           AND deleted_at < datetime('now', '-' || @days || ' days')`
      )
      .get({ days: purgeDays }) as { count: number }
  ).count;

  const report: ConsolidationReport = {
    applied: options.apply,
    similarityThreshold: threshold,
    pairs,
    invalidated: 0,
    purgeable,
    purged: 0,
    orphanExperienceVectors: 0,
    orphanPreferenceVectors: 0,
    ftsRebuilt: false,
    bytesReclaimed: 0,
  };

  if (!options.apply) {
    // Dry-run still reports orphan counts so the user knows what --apply would do
    report.orphanExperienceVectors = countOrphans(db, "vec_experiences", "experience_id", "experiences");
    report.orphanPreferenceVectors = countOrphans(db, "vec_preferences", "preference_id", "preferences");
    return report;
  }

  // 1. Invalidate the loser of each near-duplicate pair (reversible).
  //    Pairs are sorted by similarity; in chains (A~B~C) a preference
  //    already invalidated in this run is skipped, and survivors of earlier
  //    pairs are never invalidated by later ones.
  const invalidateById = db.prepare(
    `UPDATE preferences
     SET invalidated_at = datetime('now'), superseded_by = @superseded_by
     WHERE id = @id AND invalidated_at IS NULL`
  );
  const touched = new Set<number>();
  for (const pair of pairs) {
    if (touched.has(pair.loser.id) || touched.has(pair.survivor.id)) continue;
    const result = invalidateById.run({ id: pair.loser.id, superseded_by: pair.survivor.key });
    if (result.changes > 0) {
      report.invalidated++;
      touched.add(pair.loser.id);
      touched.add(pair.survivor.id);
    }
  }

  // 2. Purge soft-deleted experiences older than the cutoff. Their vectors
  //    are removed first (no trigger covers vec_experiences); the FTS
  //    delete trigger fires on each row DELETE.
  const purgeIds = (
    db
      .prepare(
        `SELECT id FROM experiences
         WHERE deleted_at IS NOT NULL
           AND deleted_at < datetime('now', '-' || @days || ' days')`
      )
      .all({ days: purgeDays }) as { id: number }[]
  ).map((r) => r.id);

  if (purgeIds.length > 0) {
    try {
      const deleteVec = db.prepare(`DELETE FROM vec_experiences WHERE experience_id = ?`);
      for (const id of purgeIds) deleteVec.run(BigInt(id));
    } catch {
      // vec table missing: nothing to clean
    }
    const result = db
      .prepare(
        `DELETE FROM experiences
         WHERE deleted_at IS NOT NULL
           AND deleted_at < datetime('now', '-' || @days || ' days')`
      )
      .run({ days: purgeDays });
    report.purged = result.changes;
  }

  // 3. Orphan cleanup + FTS rebuild from the content table.
  report.orphanExperienceVectors = deleteOrphans(db, "vec_experiences", "experience_id", "experiences");
  report.orphanPreferenceVectors = deleteOrphans(db, "vec_preferences", "preference_id", "preferences");
  try {
    db.exec(`INSERT INTO experiences_fts(experiences_fts) VALUES('rebuild')`);
    report.ftsRebuilt = true;
  } catch {
    report.ftsRebuilt = false;
  }

  // 4. VACUUM and measure the space reclaimed.
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
    // in-memory databases have no WAL
  }
  const before = dbSizeBytes(db);
  db.exec("VACUUM");
  const after = dbSizeBytes(db);
  report.bytesReclaimed = Math.max(0, before - after);

  return report;
}

/** Human-readable summary of a consolidation run (CLI output). */
export function formatConsolidationReport(report: ConsolidationReport): string {
  const lines: string[] = [];
  const mode = report.applied ? "apply" : "dry-run";
  lines.push(`=== Memory consolidation (${mode}) ===`);
  lines.push("");

  lines.push(`Near-duplicate preference pairs (similarity > ${report.similarityThreshold}): ${report.pairs.length}`);
  for (const pair of report.pairs) {
    lines.push(
      `  - [${pair.scope}] '${pair.loser.key}' (confidence ${pair.loser.confidence})` +
        ` -> superseded by '${pair.survivor.key}' (confidence ${pair.survivor.confidence})` +
        ` | similarity ${pair.similarity.toFixed(2)}`
    );
  }
  lines.push(
    report.applied
      ? `Preferences invalidated (reversible): ${report.invalidated}`
      : `Preferences that would be invalidated with --apply: ${report.pairs.length > 0 ? "see pairs above" : 0}`
  );
  lines.push("");

  lines.push(
    report.applied
      ? `Soft-deleted experiences purged (older than ${PURGE_SOFT_DELETED_DAYS} days): ${report.purged}`
      : `Soft-deleted experiences eligible for purge (older than ${PURGE_SOFT_DELETED_DAYS} days): ${report.purgeable}`
  );
  lines.push(
    `Orphan vector rows${report.applied ? " removed" : ""}: ` +
      `${report.orphanExperienceVectors} experiences, ${report.orphanPreferenceVectors} preferences`
  );

  if (report.applied) {
    lines.push(`FTS index rebuilt: ${report.ftsRebuilt ? "yes" : "no"}`);
    const kb = (report.bytesReclaimed / 1024).toFixed(1);
    lines.push(`Bytes reclaimed by VACUUM: ${report.bytesReclaimed} (${kb} KB)`);
  } else {
    lines.push("");
    lines.push("Dry-run: nothing was modified. Re-run with --apply to perform these changes.");
  }

  return lines.join("\n");
}
