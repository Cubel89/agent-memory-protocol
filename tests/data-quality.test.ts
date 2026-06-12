/**
 * Tests for the data-quality features (retrieval v3, phase 2):
 *   - semantic dedupe on write (preference-dedupe.ts)
 *   - reversible invalidation (schema + SQL mirrored from database.ts)
 *   - temporal decay without floor (scoring.ts)
 *   - consolidate command: dry-run vs apply, purge, orphan cleanup
 *
 * Embeddings: real MiniLM is never loaded here. The vector channel is
 * exercised with handcrafted 4-dimensional Float32Array fixtures stored in
 * vec0 tables (float[4]), which tests the actual similarity/merge logic
 * without the model download.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

import {
  PREF_SIMILARITY_THRESHOLD,
  preferenceEmbeddingText,
  cosineSimilarity,
  findMostSimilarPreference,
  mergeIntoExistingPreference,
  findSimilarPreferencePairs,
} from "../src/preference-dedupe";
import { runConsolidation, formatConsolidationReport, PURGE_SOFT_DELETED_DAYS } from "../src/consolidate";
import { computeDecayFactor, applyDecay } from "../src/scoring";
import { applyPreferenceOptions, AUTO_MIN_EFFECTIVE_CONFIDENCE } from "../src/context-format";

// ── Test database (schema mirrors database.ts, vectors are float[4]) ──

function createTestDb(): BetterSqlite3.Database {
  const db = new Database(":memory:");
  sqliteVec.load(db);

  db.exec(`
    CREATE TABLE experiences (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      type        TEXT NOT NULL,
      context     TEXT,
      action      TEXT,
      result      TEXT,
      success     INTEGER DEFAULT 1,
      tags        TEXT DEFAULT '',
      project     TEXT DEFAULT '',
      created_at  TEXT DEFAULT (datetime('now')),
      deleted_at       TEXT DEFAULT NULL,
      normalized_hash  TEXT,
      duplicate_count  INTEGER DEFAULT 1,
      last_seen_at     TEXT,
      topic_key       TEXT,
      revision_count  INTEGER DEFAULT 1
    );

    CREATE TABLE preferences (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      key         TEXT NOT NULL,
      value       TEXT NOT NULL,
      confidence  REAL DEFAULT 0.3,
      source      TEXT DEFAULT '',
      scope       TEXT DEFAULT 'global',
      updated_at  TEXT DEFAULT (datetime('now')),
      confirmed_count   INTEGER DEFAULT 1,
      last_confirmed_at TEXT DEFAULT (datetime('now')),
      invalidated_at    TEXT DEFAULT NULL,
      superseded_by     TEXT DEFAULT NULL,
      UNIQUE(key, scope)
    );

    CREATE VIRTUAL TABLE experiences_fts USING fts5(
      context, action, result, tags,
      content=experiences,
      content_rowid=id
    );

    CREATE TRIGGER experiences_ai AFTER INSERT ON experiences BEGIN
      INSERT INTO experiences_fts(rowid, context, action, result, tags)
      VALUES (new.id, new.context, new.action, new.result, new.tags);
    END;

    CREATE TRIGGER experiences_ad AFTER DELETE ON experiences BEGIN
      INSERT INTO experiences_fts(experiences_fts, rowid, context, action, result, tags)
      VALUES ('delete', old.id, old.context, old.action, old.result, old.tags);
    END;

    CREATE VIRTUAL TABLE vec_experiences USING vec0(
      experience_id INTEGER PRIMARY KEY,
      embedding float[4] distance_metric=cosine
    );

    CREATE VIRTUAL TABLE vec_preferences USING vec0(
      preference_id INTEGER PRIMARY KEY,
      embedding float[4] distance_metric=cosine
    );
  `);

  return db;
}

function insertPref(
  db: BetterSqlite3.Database,
  params: {
    key: string;
    value: string;
    scope?: string;
    confidence?: number;
    lastConfirmedAt?: string;
    vec?: number[];
  }
): number {
  const info = db
    .prepare(
      `INSERT INTO preferences (key, value, confidence, scope, last_confirmed_at)
       VALUES (@key, @value, @confidence, @scope, COALESCE(@lastConfirmedAt, datetime('now')))`
    )
    .run({
      key: params.key,
      value: params.value,
      confidence: params.confidence ?? 0.3,
      scope: params.scope ?? "global",
      lastConfirmedAt: params.lastConfirmedAt ?? null,
    });
  const id = Number(info.lastInsertRowid);
  if (params.vec) {
    db.prepare(`INSERT INTO vec_preferences(preference_id, embedding) VALUES (?, ?)`).run(
      BigInt(id),
      new Float32Array(params.vec)
    );
  }
  return id;
}

function insertExp(
  db: BetterSqlite3.Database,
  params: { context: string; deletedDaysAgo?: number; vec?: number[] }
): number {
  const info = db
    .prepare(
      `INSERT INTO experiences (type, context, action, result, deleted_at)
       VALUES ('experience', @context, 'act', 'res',
         CASE WHEN @deletedDaysAgo IS NULL THEN NULL
              ELSE datetime('now', '-' || @deletedDaysAgo || ' days') END)`
    )
    .run({ context: params.context, deletedDaysAgo: params.deletedDaysAgo ?? null });
  const id = Number(info.lastInsertRowid);
  if (params.vec) {
    db.prepare(`INSERT INTO vec_experiences(experience_id, embedding) VALUES (?, ?)`).run(
      BigInt(id),
      new Float32Array(params.vec)
    );
  }
  return id;
}

// Mirror of the invalidation/restore SQL in database.ts
function invalidateByKey(db: BetterSqlite3.Database, key: string, scope: string, supersededBy?: string): boolean {
  return (
    db
      .prepare(
        `UPDATE preferences
         SET invalidated_at = datetime('now'), superseded_by = @superseded_by
         WHERE key = @key AND scope = @scope AND invalidated_at IS NULL`
      )
      .run({ key, scope, superseded_by: supersededBy ?? null }).changes > 0
  );
}

function restoreByKey(db: BetterSqlite3.Database, key: string, scope: string): boolean {
  return (
    db
      .prepare(
        `UPDATE preferences
         SET invalidated_at = NULL, superseded_by = NULL
         WHERE key = @key AND scope = @scope AND invalidated_at IS NOT NULL`
      )
      .run({ key, scope }).changes > 0
  );
}

// Mirror of the filtered listing query in database.ts (getGlobalPreferences)
function listActiveByScope(db: BetterSqlite3.Database, scope: string) {
  return db
    .prepare(
      `SELECT * FROM preferences WHERE scope = @scope AND invalidated_at IS NULL ORDER BY confidence DESC`
    )
    .all({ scope }) as any[];
}

// Vector fixtures: cosine(SIMILAR_A, SIMILAR_B) ≈ 0.95, ORTHOGONAL ⟂ both
const BASE = [1, 0, 0, 0];
const SIMILAR = [0.95, 0.3122, 0, 0]; // unit vector, cos with BASE = 0.95
const ORTHOGONAL = [0, 1, 0, 0];

let db: BetterSqlite3.Database;

beforeEach(() => {
  db = createTestDb();
});

// ═══════════════════════════════════════════════════════
// 2.1 Semantic dedupe on write
// ═══════════════════════════════════════════════════════

describe("cosineSimilarity / embedding text", () => {
  it("computes cosine similarity for the fixtures", () => {
    expect(cosineSimilarity(new Float32Array(BASE), new Float32Array(BASE))).toBeCloseTo(1.0, 5);
    expect(cosineSimilarity(new Float32Array(BASE), new Float32Array(SIMILAR))).toBeCloseTo(0.95, 3);
    expect(cosineSimilarity(new Float32Array(BASE), new Float32Array(ORTHOGONAL))).toBeCloseTo(0, 5);
    expect(cosineSimilarity(new Float32Array([0, 0, 0, 0]), new Float32Array(BASE))).toBe(0);
  });

  it("preferenceEmbeddingText uses the canonical format with key words", () => {
    expect(preferenceEmbeddingText("code_style", "functional")).toBe(
      "user preference code style: functional"
    );
  });
});

describe("findMostSimilarPreference (write-path dedupe)", () => {
  it("returns the most similar active preference of the same scope", () => {
    insertPref(db, { key: "language", value: "english", vec: BASE });
    insertPref(db, { key: "framework", value: "react", vec: ORTHOGONAL });

    const match = findMostSimilarPreference(db, {
      scope: "global",
      excludeKey: "preferred_language",
      embedding: new Float32Array(SIMILAR),
    });

    expect(match).toBeTruthy();
    expect(match!.key).toBe("language");
    expect(match!.similarity).toBeCloseTo(0.95, 3);
    expect(match!.similarity).toBeGreaterThan(PREF_SIMILARITY_THRESHOLD);
  });

  it("never returns the candidate's own key", () => {
    insertPref(db, { key: "language", value: "english", vec: BASE });
    const match = findMostSimilarPreference(db, {
      scope: "global",
      excludeKey: "language",
      embedding: new Float32Array(BASE),
    });
    expect(match).toBeNull();
  });

  it("ignores preferences from other scopes", () => {
    insertPref(db, { key: "language", value: "english", scope: "other-project", vec: BASE });
    const match = findMostSimilarPreference(db, {
      scope: "global",
      excludeKey: "candidate",
      embedding: new Float32Array(BASE),
    });
    expect(match).toBeNull();
  });

  it("ignores invalidated preferences", () => {
    insertPref(db, { key: "language", value: "english", vec: BASE });
    insertPref(db, { key: "tone", value: "casual", vec: ORTHOGONAL });
    invalidateByKey(db, "language", "global");

    const match = findMostSimilarPreference(db, {
      scope: "global",
      excludeKey: "candidate",
      embedding: new Float32Array(SIMILAR),
    });

    // Only the orthogonal one remains: similarity far below the threshold
    expect(match!.key).toBe("tone");
    expect(match!.similarity).toBeLessThan(PREF_SIMILARITY_THRESHOLD);
  });

  it("skips preferences without a stored vector", () => {
    insertPref(db, { key: "no_vector", value: "whatever" }); // no vec
    const match = findMostSimilarPreference(db, {
      scope: "global",
      excludeKey: "candidate",
      embedding: new Float32Array(BASE),
    });
    expect(match).toBeNull();
  });
});

describe("mergeIntoExistingPreference", () => {
  it("bumps confidence, increments confirmed_count and refreshes last_confirmed_at", () => {
    const id = insertPref(db, {
      key: "language",
      value: "english",
      lastConfirmedAt: "2020-01-01 00:00:00",
      vec: BASE,
    });

    const merged = mergeIntoExistingPreference(db, { id, newValue: "english" });
    expect(merged.key).toBe("language");

    const row = db.prepare(`SELECT * FROM preferences WHERE id = ?`).get(id) as any;
    // Same formula as the upsert: MIN(1.0, 0.3 + (1 + 1) * 0.1) = 0.5
    expect(row.confidence).toBeCloseTo(0.5, 5);
    expect(row.confirmed_count).toBe(2);
    expect(row.last_confirmed_at).not.toBe("2020-01-01 00:00:00");
  });

  it("updates the value only when the new one is longer (more complete)", () => {
    const id = insertPref(db, { key: "language", value: "english", vec: BASE });

    const longer = mergeIntoExistingPreference(db, {
      id,
      newValue: "english, both in code comments and in chat replies",
    });
    expect(longer.valueUpdated).toBe(true);
    expect(longer.value).toBe("english, both in code comments and in chat replies");

    const shorter = mergeIntoExistingPreference(db, { id, newValue: "en" });
    expect(shorter.valueUpdated).toBe(false);
    expect(shorter.value).toBe("english, both in code comments and in chat replies");

    const row = db.prepare(`SELECT value FROM preferences WHERE id = ?`).get(id) as any;
    expect(row.value).toBe("english, both in code comments and in chat replies");
  });
});

// ═══════════════════════════════════════════════════════
// 2.2 Reversible invalidation
// ═══════════════════════════════════════════════════════

describe("reversible invalidation", () => {
  it("invalidation hides the preference from filtered retrieval without deleting it", () => {
    insertPref(db, { key: "language", value: "english" });
    insertPref(db, { key: "tone", value: "formal" });

    expect(invalidateByKey(db, "language", "global", "tone")).toBe(true);

    const active = listActiveByScope(db, "global");
    expect(active.map((p) => p.key)).toEqual(["tone"]);

    // Row still exists with metadata
    const row = db.prepare(`SELECT * FROM preferences WHERE key = 'language'`).get() as any;
    expect(row).toBeTruthy();
    expect(row.invalidated_at).toBeTruthy();
    expect(row.superseded_by).toBe("tone");
  });

  it("invalidating twice is a no-op (returns false)", () => {
    insertPref(db, { key: "language", value: "english" });
    expect(invalidateByKey(db, "language", "global")).toBe(true);
    expect(invalidateByKey(db, "language", "global")).toBe(false);
  });

  it("restore brings the preference back to filtered retrieval", () => {
    insertPref(db, { key: "language", value: "english" });
    invalidateByKey(db, "language", "global", "other");

    expect(restoreByKey(db, "language", "global")).toBe(true);

    const active = listActiveByScope(db, "global");
    expect(active.map((p) => p.key)).toEqual(["language"]);
    const row = db.prepare(`SELECT * FROM preferences WHERE key = 'language'`).get() as any;
    expect(row.invalidated_at).toBeNull();
    expect(row.superseded_by).toBeNull();
  });

  it("re-learning (upsert ON CONFLICT) revalidates an invalidated preference", () => {
    insertPref(db, { key: "language", value: "english" });
    invalidateByKey(db, "language", "global", "other");

    // Mirror of the upsert in database.ts (including revalidation)
    db.prepare(
      `INSERT INTO preferences (key, value, confidence, source, scope, confirmed_count, last_confirmed_at)
       VALUES (@key, @value, @confidence, @source, @scope, 1, datetime('now'))
       ON CONFLICT(key, scope) DO UPDATE SET
         value = @value,
         confidence = MIN(1.0, 0.3 + (confirmed_count + 1) * 0.1),
         source = @source,
         updated_at = datetime('now'),
         confirmed_count = confirmed_count + 1,
         last_confirmed_at = datetime('now'),
         invalidated_at = NULL,
         superseded_by = NULL`
    ).run({ key: "language", value: "spanish", confidence: 0.3, source: "test", scope: "global" });

    const row = db.prepare(`SELECT * FROM preferences WHERE key = 'language'`).get() as any;
    expect(row.invalidated_at).toBeNull();
    expect(row.superseded_by).toBeNull();
    expect(row.value).toBe("spanish");
    expect(listActiveByScope(db, "global")).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════
// 2.3 Decay without floor + automatic-output exclusion
// ═══════════════════════════════════════════════════════

describe("decay without floor", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.parse("2026-06-12T00:00:00Z");
  const daysAgo = (d: number) => new Date(now - d * DAY).toISOString().replace("Z", "").replace("T", " ").slice(0, 19);

  it("follows the documented ladder with no floor", () => {
    expect(computeDecayFactor(daysAgo(10), now)).toBe(1.0);
    expect(computeDecayFactor(daysAgo(60), now)).toBe(0.9);
    expect(computeDecayFactor(daysAgo(150), now)).toBe(0.7);
    expect(computeDecayFactor(daysAgo(300), now)).toBe(0.5);
    expect(computeDecayFactor(daysAgo(500), now)).toBe(0.3);
    expect(computeDecayFactor(daysAgo(1000), now)).toBe(0.15);
    expect(computeDecayFactor(null, now)).toBe(0.5);
  });

  it("a stale max-confidence preference eventually falls below the automatic floor", () => {
    const fresh = applyDecay({ confidence: 1.0, last_confirmed_at: daysAgo(5) });
    expect(fresh.effective_confidence).toBeGreaterThanOrEqual(AUTO_MIN_EFFECTIVE_CONFIDENCE);

    // Beyond two years even a 1.0-confidence pref drops out of automatic outputs
    const ancient = applyDecay({ confidence: 1.0, last_confirmed_at: daysAgo(800) });
    expect(ancient.effective_confidence).toBeLessThan(AUTO_MIN_EFFECTIVE_CONFIDENCE);
  });

  it("prefs below the automatic floor are excluded by applyPreferenceOptions", () => {
    expect(AUTO_MIN_EFFECTIVE_CONFIDENCE).toBe(0.3);

    const prefs = [
      applyDecay({ key: "fresh", value: "v", confidence: 0.5, last_confirmed_at: daysAgo(5) }), // 0.5
      applyDecay({ key: "stale", value: "v", confidence: 0.5, last_confirmed_at: daysAgo(400) }), // 0.15
      applyDecay({ key: "old_but_strong", value: "v", confidence: 1.0, last_confirmed_at: daysAgo(400) }), // 0.3
    ];

    const visible = applyPreferenceOptions(prefs, {
      minEffectiveConfidence: AUTO_MIN_EFFECTIVE_CONFIDENCE,
    });
    expect(visible.map((p: any) => p.key)).toEqual(["fresh", "old_but_strong"]);
  });
});

// ═══════════════════════════════════════════════════════
// 2.4 Consolidate: pair detection, dry-run vs apply, purge
// ═══════════════════════════════════════════════════════

describe("findSimilarPreferencePairs", () => {
  it("detects same-scope pairs above the threshold and picks the survivor", () => {
    insertPref(db, { key: "language", value: "english", confidence: 0.7, vec: BASE });
    insertPref(db, { key: "preferred_language", value: "english please", confidence: 0.3, vec: SIMILAR });
    insertPref(db, { key: "framework", value: "react", confidence: 0.5, vec: ORTHOGONAL });

    const pairs = findSimilarPreferencePairs(db);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].scope).toBe("global");
    expect(pairs[0].similarity).toBeCloseTo(0.95, 3);
    expect(pairs[0].survivor.key).toBe("language"); // higher confidence
    expect(pairs[0].loser.key).toBe("preferred_language");
  });

  it("does NOT pair preferences across different scopes", () => {
    insertPref(db, { key: "language", value: "english", scope: "global", vec: BASE });
    insertPref(db, { key: "language", value: "english", scope: "my-project", vec: BASE });
    expect(findSimilarPreferencePairs(db)).toHaveLength(0);
  });

  it("on equal confidence the more recently confirmed one survives", () => {
    insertPref(db, {
      key: "old_pref", value: "english", confidence: 0.5,
      lastConfirmedAt: "2020-01-01 00:00:00", vec: BASE,
    });
    insertPref(db, {
      key: "new_pref", value: "english too", confidence: 0.5,
      lastConfirmedAt: "2026-01-01 00:00:00", vec: SIMILAR,
    });

    const pairs = findSimilarPreferencePairs(db);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].survivor.key).toBe("new_pref");
    expect(pairs[0].loser.key).toBe("old_pref");
  });
});

describe("consolidate dry-run", () => {
  it("detects pairs and purgeable rows but modifies nothing", () => {
    insertPref(db, { key: "language", value: "english", confidence: 0.7, vec: BASE });
    insertPref(db, { key: "preferred_language", value: "english", confidence: 0.3, vec: SIMILAR });
    insertExp(db, { context: "old soft-deleted", deletedDaysAgo: 120 });
    insertExp(db, { context: "active row" });

    const report = runConsolidation(db, { apply: false });

    expect(report.applied).toBe(false);
    expect(report.pairs).toHaveLength(1);
    expect(report.invalidated).toBe(0);
    expect(report.purgeable).toBe(1);
    expect(report.purged).toBe(0);
    expect(report.bytesReclaimed).toBe(0);

    // Nothing changed in the database
    expect(listActiveByScope(db, "global")).toHaveLength(2);
    expect(db.prepare(`SELECT COUNT(*) AS c FROM experiences`).get()).toEqual({ c: 2 });

    const text = formatConsolidationReport(report);
    expect(text).toContain("dry-run");
    expect(text).toContain("--apply");
  });
});

describe("consolidate --apply", () => {
  it("invalidates the loser with superseded_by pointing at the survivor", () => {
    insertPref(db, { key: "language", value: "english", confidence: 0.7, vec: BASE });
    insertPref(db, { key: "preferred_language", value: "english", confidence: 0.3, vec: SIMILAR });

    const report = runConsolidation(db, { apply: true });
    expect(report.applied).toBe(true);
    expect(report.invalidated).toBe(1);

    const loser = db.prepare(`SELECT * FROM preferences WHERE key = 'preferred_language'`).get() as any;
    expect(loser.invalidated_at).toBeTruthy();
    expect(loser.superseded_by).toBe("language");

    const survivor = db.prepare(`SELECT * FROM preferences WHERE key = 'language'`).get() as any;
    expect(survivor.invalidated_at).toBeNull();

    expect(listActiveByScope(db, "global").map((p) => p.key)).toEqual(["language"]);
  });

  it("never invalidates the survivor of an earlier pair (chains)", () => {
    // Three near-identical prefs: only one should be invalidated per run,
    // and the strongest must always stay active.
    insertPref(db, { key: "a", value: "english", confidence: 0.9, vec: BASE });
    insertPref(db, { key: "b", value: "english", confidence: 0.5, vec: SIMILAR });
    insertPref(db, { key: "c", value: "english", confidence: 0.3, vec: [0.97, 0.243, 0, 0] });

    const report = runConsolidation(db, { apply: true });

    const strongest = db.prepare(`SELECT * FROM preferences WHERE key = 'a'`).get() as any;
    expect(strongest.invalidated_at).toBeNull();
    expect(report.invalidated).toBeGreaterThanOrEqual(1);
    expect(listActiveByScope(db, "global").length).toBeGreaterThanOrEqual(2);
  });

  it("purges soft-deleted experiences older than the cutoff, keeps the rest", () => {
    const oldId = insertExp(db, { context: "ancient soft-deleted", deletedDaysAgo: 120, vec: BASE });
    insertExp(db, { context: "recent soft-deleted", deletedDaysAgo: 10 });
    insertExp(db, { context: "active row" });

    const report = runConsolidation(db, { apply: true });

    expect(report.purged).toBe(1);
    const remaining = db.prepare(`SELECT id, context FROM experiences ORDER BY id`).all() as any[];
    expect(remaining.map((r) => r.context)).toEqual(["recent soft-deleted", "active row"]);

    // Its vector is gone too
    const vecCount = (db.prepare(`SELECT COUNT(*) AS c FROM vec_experiences WHERE experience_id = ?`).get(BigInt(oldId)) as any).c;
    expect(vecCount).toBe(0);
    expect(report.ftsRebuilt).toBe(true);
  });

  it("respects a custom purge window (default constant is 90 days)", () => {
    expect(PURGE_SOFT_DELETED_DAYS).toBe(90);
    insertExp(db, { context: "soft-deleted 50 days ago", deletedDaysAgo: 50 });

    const defaultRun = runConsolidation(db, { apply: false });
    expect(defaultRun.purgeable).toBe(0); // 50 < 90

    const aggressive = runConsolidation(db, { apply: true, purgeDays: 30 });
    expect(aggressive.purged).toBe(1);
  });

  it("removes orphaned vector rows", () => {
    // Vector rows pointing at rows that no longer exist
    db.prepare(`INSERT INTO vec_experiences(experience_id, embedding) VALUES (?, ?)`).run(
      BigInt(999),
      new Float32Array(BASE)
    );
    db.prepare(`INSERT INTO vec_preferences(preference_id, embedding) VALUES (?, ?)`).run(
      BigInt(888),
      new Float32Array(BASE)
    );

    const dry = runConsolidation(db, { apply: false });
    expect(dry.orphanExperienceVectors).toBe(1);
    expect(dry.orphanPreferenceVectors).toBe(1);
    // Dry-run does not remove them
    expect((db.prepare(`SELECT COUNT(*) AS c FROM vec_experiences`).get() as any).c).toBe(1);

    const report = runConsolidation(db, { apply: true });
    expect(report.orphanExperienceVectors).toBe(1);
    expect(report.orphanPreferenceVectors).toBe(1);
    expect((db.prepare(`SELECT COUNT(*) AS c FROM vec_experiences`).get() as any).c).toBe(0);
    expect((db.prepare(`SELECT COUNT(*) AS c FROM vec_preferences`).get() as any).c).toBe(0);
  });

  it("reports non-negative bytes reclaimed by VACUUM", () => {
    insertExp(db, { context: "filler ".repeat(500), deletedDaysAgo: 120 });
    const report = runConsolidation(db, { apply: true });
    expect(report.bytesReclaimed).toBeGreaterThanOrEqual(0);
  });
});
