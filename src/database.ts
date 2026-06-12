import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import path from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import { EMBEDDING_DIMS } from "./embeddings.js";
import { normalizeTextPaths } from "./paths.js";
import { ensureTelemetryTable } from "./telemetry.js";
import { applyPreferenceOptions, type PreferenceOptions } from "./context-format.js";
import { clampSimilarity, computeFtsScore, fuseScores, applyDecay } from "./scoring.js";

// Temporal decay moved to scoring.ts (pure module); re-exported here so
// existing importers keep working.
export { computeDecayFactor, applyDecay } from "./scoring.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "data", "memory.db");

// ── Database initialization ──────────────────────────────

// Flag global: indica si sqlite-vec cargó correctamente
export let vectorsAvailable = false;

export function initDatabase(dbPath?: string) {
  const db = new Database(dbPath || DB_PATH);

  // Intentar cargar sqlite-vec; si falla, continuar sin vectores
  try {
    sqliteVec.load(db);
    vectorsAvailable = true;
  } catch (err) {
    console.error("sqlite-vec no disponible, búsqueda vectorial desactivada:", err);
    vectorsAvailable = false;
  }

  // WAL mode = better performance for concurrent reads
  if (dbPath !== ":memory:") {
    db.pragma("journal_mode = WAL");
  }

  // ── Schema ─────────────────────────────────────────────

  db.exec(`
    CREATE TABLE IF NOT EXISTS experiences (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      type        TEXT NOT NULL,       -- 'experience' | 'correction' | 'insight'
      context     TEXT,                -- what was happening
      action      TEXT,                -- what was done
      result      TEXT,                -- what happened
      success     INTEGER DEFAULT 1,   -- 1 = success, 0 = failure
      tags        TEXT DEFAULT '',     -- comma-separated tags
      project     TEXT DEFAULT '',     -- related project
      created_at  TEXT DEFAULT (datetime('now')),
      -- Phase 1: Soft Delete
      deleted_at  TEXT DEFAULT NULL,
      -- Phase 2: Deduplication
      normalized_hash  TEXT,
      duplicate_count  INTEGER DEFAULT 1,
      last_seen_at     TEXT,
      -- Phase 3: Topic Upserts
      topic_key       TEXT,
      revision_count  INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS patterns (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      description TEXT NOT NULL,
      category    TEXT DEFAULT '',      -- 'error', 'success', 'workflow', etc.
      frequency   INTEGER DEFAULT 1,
      examples    TEXT DEFAULT '[]',    -- JSON array of examples
      last_seen   TEXT DEFAULT (datetime('now'))
    );
  `);

  // ── Migration: preferences with scope ───────────────────

  const tableInfo = db.prepare(`PRAGMA table_info(preferences)`).all() as any[];
  const hasScope = tableInfo.some((col: any) => col.name === "scope");

  if (tableInfo.length === 0) {
    db.exec(`
      CREATE TABLE preferences (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        key         TEXT NOT NULL,
        value       TEXT NOT NULL,
        confidence  REAL DEFAULT 0.3,
        source      TEXT DEFAULT '',
        scope       TEXT DEFAULT 'global',
        updated_at  TEXT DEFAULT (datetime('now')),
        -- Phase 6: Temporal decay
        confirmed_count   INTEGER DEFAULT 1,
        last_confirmed_at TEXT DEFAULT (datetime('now')),
        -- Retrieval v3: reversible invalidation
        invalidated_at    TEXT DEFAULT NULL,
        superseded_by     TEXT DEFAULT NULL,
        UNIQUE(key, scope)
      );
    `);
  } else if (!hasScope) {
    db.exec(`
      ALTER TABLE preferences ADD COLUMN scope TEXT DEFAULT 'global';
    `);
    db.exec(`
      CREATE TABLE preferences_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        key         TEXT NOT NULL,
        value       TEXT NOT NULL,
        confidence  REAL DEFAULT 0.3,
        source      TEXT DEFAULT '',
        scope       TEXT DEFAULT 'global',
        updated_at  TEXT DEFAULT (datetime('now')),
        confirmed_count   INTEGER DEFAULT 1,
        last_confirmed_at TEXT DEFAULT (datetime('now')),
        UNIQUE(key, scope)
      );
      INSERT INTO preferences_new (id, key, value, confidence, source, scope, updated_at)
        SELECT id, key, value, confidence, source, COALESCE(scope, 'global'), updated_at FROM preferences;
      DROP TABLE preferences;
      ALTER TABLE preferences_new RENAME TO preferences;
    `);
  }

  // ── Migrations for existing databases ──────────────────

  // Phase 1: Soft Delete migration
  const expCols = db.prepare(`PRAGMA table_info(experiences)`).all() as any[];
  const hasDeletedAt = expCols.some((col: any) => col.name === "deleted_at");
  if (!hasDeletedAt) {
    db.exec(`ALTER TABLE experiences ADD COLUMN deleted_at TEXT DEFAULT NULL`);
  }

  // Phase 2: Deduplication migration
  const hasNormalizedHash = expCols.some((col: any) => col.name === "normalized_hash");
  if (!hasNormalizedHash) {
    db.exec(`ALTER TABLE experiences ADD COLUMN normalized_hash TEXT`);
    db.exec(`ALTER TABLE experiences ADD COLUMN duplicate_count INTEGER DEFAULT 1`);
    db.exec(`ALTER TABLE experiences ADD COLUMN last_seen_at TEXT`);
  }

  // Phase 3: Topic Upserts migration
  const hasTopicKey = expCols.some((col: any) => col.name === "topic_key");
  if (!hasTopicKey) {
    db.exec(`ALTER TABLE experiences ADD COLUMN topic_key TEXT`);
    db.exec(`ALTER TABLE experiences ADD COLUMN revision_count INTEGER DEFAULT 1`);
  }

  // Phase 6: Temporal decay migration for preferences
  const prefCols = db.prepare(`PRAGMA table_info(preferences)`).all() as any[];
  const hasConfirmedCount = prefCols.some((col: any) => col.name === "confirmed_count");
  if (!hasConfirmedCount) {
    db.exec(`ALTER TABLE preferences ADD COLUMN confirmed_count INTEGER DEFAULT 1`);
    db.exec(`ALTER TABLE preferences ADD COLUMN last_confirmed_at TEXT DEFAULT (datetime('now'))`);
  }

  // Retrieval v3: reversible invalidation for preferences (Zep-style).
  // Invalidated rows are hidden from automatic retrieval but kept in the
  // table so they can be restored or inspected via explicit key lookup.
  const hasInvalidatedAt = prefCols.some((col: any) => col.name === "invalidated_at");
  if (!hasInvalidatedAt) {
    db.exec(`ALTER TABLE preferences ADD COLUMN invalidated_at TEXT DEFAULT NULL`);
    db.exec(`ALTER TABLE preferences ADD COLUMN superseded_by TEXT DEFAULT NULL`);
  }

  // Retrieval v3: output-size telemetry (see telemetry.ts)
  ensureTelemetryTable(db);

  // ── Indexes ────────────────────────────────────────────

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_experiences_deleted_at ON experiences(deleted_at);
    CREATE INDEX IF NOT EXISTS idx_experiences_normalized_hash ON experiences(normalized_hash, project, created_at);
    CREATE INDEX IF NOT EXISTS idx_experiences_topic_key ON experiences(topic_key, project);
  `);

  // ── Vector search (sqlite-vec) ─────────────────────────

  if (vectorsAvailable) {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_experiences USING vec0(
        experience_id INTEGER PRIMARY KEY,
        embedding float[${EMBEDDING_DIMS}] distance_metric=cosine
      );
    `);

    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_preferences USING vec0(
        preference_id INTEGER PRIMARY KEY,
        embedding float[${EMBEDDING_DIMS}] distance_metric=cosine
      );
    `);
  }

  // ── FTS5: Full-text search ──────────────────────────────

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS experiences_fts USING fts5(
      context, action, result, tags,
      content=experiences,
      content_rowid=id
    );

    CREATE TRIGGER IF NOT EXISTS experiences_ai AFTER INSERT ON experiences BEGIN
      INSERT INTO experiences_fts(rowid, context, action, result, tags)
      VALUES (new.id, new.context, new.action, new.result, new.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS experiences_ad AFTER DELETE ON experiences BEGIN
      INSERT INTO experiences_fts(experiences_fts, rowid, context, action, result, tags)
      VALUES ('delete', old.id, old.context, old.action, old.result, old.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS experiences_au AFTER UPDATE ON experiences BEGIN
      INSERT INTO experiences_fts(experiences_fts, rowid, context, action, result, tags)
      VALUES ('delete', old.id, old.context, old.action, old.result, old.tags);
      INSERT INTO experiences_fts(rowid, context, action, result, tags)
      VALUES (new.id, new.context, new.action, new.result, new.tags);
    END;
  `);

  return db;
}

// ── Production instance ─────────────────────────────────

const db = initDatabase();

// ── Helper: normalize text for deduplication ────────────

export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export function computeHash(context: string, action: string, result: string): string {
  const normalized = normalizeText(`${context}|${action}|${result}`);
  return createHash("sha256").update(normalized).digest("hex");
}

// ── Prepared queries ────────────────────────────────────
// All SELECT queries include WHERE deleted_at IS NULL (Phase 1)

export const insertExperience = db.prepare(`
  INSERT INTO experiences (type, context, action, result, success, tags, project, normalized_hash, last_seen_at)
  VALUES (@type, @context, @action, @result, @success, @tags, @project, @normalized_hash, datetime('now'))
`);

// Phase 2: Deduplication - find duplicate within time window
export const findDuplicate = db.prepare(`
  SELECT * FROM experiences
  WHERE normalized_hash = @hash
    AND project = @project
    AND deleted_at IS NULL
    AND created_at >= datetime('now', '-15 minutes')
  LIMIT 1
`);

// Phase 2: Increment duplicate count
export const incrementDuplicate = db.prepare(`
  UPDATE experiences
  SET duplicate_count = duplicate_count + 1,
      last_seen_at = datetime('now')
  WHERE id = @id
`);

// Phase 2: insertOrDeduplicate (async for embedding generation)
export async function insertOrDeduplicate(params: {
  type: string;
  context: string;
  action: string;
  result: string;
  success: number;
  tags: string;
  project: string;
  topic_key?: string;
}): Promise<{ id: number; deduplicated: boolean; upserted?: boolean }> {
  // Normalizar paths absolutos del sandbox a `$SANDBOX_ROOT` antes de guardar
  // para que las experiencias sean portables entre máquinas con distintos
  // paths de sandbox (~/.sandbox, ~/sandbox, ...).
  params = {
    ...params,
    context: normalizeTextPaths(params.context),
    action: normalizeTextPaths(params.action),
    result: normalizeTextPaths(params.result),
  };

  const hash = computeHash(params.context, params.action, params.result);
  const embeddingText = `${params.context} ${params.action} ${params.result}`;

  // Phase 3: Topic upsert takes priority
  if (params.topic_key) {
    const existing = findByTopicKey.get({
      topic_key: params.topic_key,
      project: params.project,
    }) as any;

    if (existing) {
      updateByTopicKey.run({
        context: params.context,
        action: params.action,
        result: params.result,
        success: params.success,
        tags: params.tags,
        normalized_hash: hash,
        id: existing.id,
      });
      // Regenerar embedding para el registro actualizado
      if (vectorsAvailable) {
        try {
          const { getEmbedding } = await import("./embeddings.js");
          const embedding = await getEmbedding(embeddingText);
          if (embedding) upsertVector(existing.id, embedding);
        } catch { /* fallo de embedding, continuar sin él */ }
      }
      return { id: existing.id, deduplicated: false, upserted: true };
    }
  }

  // Phase 2: Check for duplicate
  const dup = findDuplicate.get({ hash, project: params.project }) as any;
  if (dup) {
    incrementDuplicate.run({ id: dup.id });
    return { id: dup.id, deduplicated: true };
  }

  // Insert new
  const info = db.prepare(`
    INSERT INTO experiences (type, context, action, result, success, tags, project, normalized_hash, last_seen_at, topic_key)
    VALUES (@type, @context, @action, @result, @success, @tags, @project, @normalized_hash, datetime('now'), @topic_key)
  `).run({
    ...params,
    normalized_hash: hash,
    topic_key: params.topic_key || null,
  });

  const newId = Number(info.lastInsertRowid);

  // Generar y almacenar embedding del nuevo registro
  if (vectorsAvailable && insertVector) {
    try {
      const { getEmbedding } = await import("./embeddings.js");
      const embedding = await getEmbedding(embeddingText);
      if (embedding) insertVector.run(BigInt(newId), embedding);
    } catch { /* fallo de embedding, continuar sin él */ }
  }

  return { id: newId, deduplicated: false };
}

// Phase 3: Find by topic key
export const findByTopicKey = db.prepare(`
  SELECT * FROM experiences
  WHERE topic_key = @topic_key
    AND project = @project
    AND deleted_at IS NULL
  LIMIT 1
`);

// Phase 3: Update by topic key
export const updateByTopicKey = db.prepare(`
  UPDATE experiences
  SET context = @context,
      action = @action,
      result = @result,
      success = @success,
      tags = @tags,
      normalized_hash = @normalized_hash,
      revision_count = revision_count + 1,
      last_seen_at = datetime('now')
  WHERE id = @id
`);

// ── Search queries (Phase 1: exclude soft-deleted) ──────

export const searchExperiences = db.prepare(`
  SELECT e.*,
    bm25(experiences_fts) AS text_score,
    (1.0 / (1.0 + julianday('now') - julianday(e.created_at))) AS recency_score,
    CASE WHEN e.success = 1 THEN 1.0 ELSE 0.5 END AS success_score
  FROM experiences e
  JOIN experiences_fts fts ON e.id = fts.rowid
  WHERE experiences_fts MATCH @query
    AND e.deleted_at IS NULL
  ORDER BY (bm25(experiences_fts) * -1.0) * 0.5 + recency_score * 0.3 + success_score * 0.2 DESC
  LIMIT @limit
`);

export const searchExperiencesByProject = db.prepare(`
  SELECT e.*,
    bm25(experiences_fts) AS text_score,
    (1.0 / (1.0 + julianday('now') - julianday(e.created_at))) AS recency_score,
    CASE WHEN e.success = 1 THEN 1.0 ELSE 0.5 END AS success_score,
    CASE WHEN e.project = @project THEN 0.1 ELSE 0.0 END AS project_bonus
  FROM experiences e
  JOIN experiences_fts fts ON e.id = fts.rowid
  WHERE experiences_fts MATCH @query AND (e.project = @project OR e.project = '')
    AND e.deleted_at IS NULL
  ORDER BY (bm25(experiences_fts) * -1.0) * 0.5 + recency_score * 0.3 + success_score * 0.2 + project_bonus DESC
  LIMIT @limit
`);

// Phase 5: Compact search (snippet only)
export const searchExperiencesCompact = db.prepare(`
  SELECT e.id, e.type, e.tags, e.created_at, e.success, e.project,
    substr(e.context, 1, 120) AS snippet,
    e.topic_key, e.duplicate_count, e.revision_count
  FROM experiences e
  JOIN experiences_fts fts ON e.id = fts.rowid
  WHERE experiences_fts MATCH @query
    AND e.deleted_at IS NULL
  ORDER BY (bm25(experiences_fts) * -1.0) * 0.5
    + (1.0 / (1.0 + julianday('now') - julianday(e.created_at))) * 0.3
    + (CASE WHEN e.success = 1 THEN 1.0 ELSE 0.5 END) * 0.2
    DESC
  LIMIT @limit
`);

export const searchExperiencesCompactByProject = db.prepare(`
  SELECT e.id, e.type, e.tags, e.created_at, e.success, e.project,
    substr(e.context, 1, 120) AS snippet,
    e.topic_key, e.duplicate_count, e.revision_count
  FROM experiences e
  JOIN experiences_fts fts ON e.id = fts.rowid
  WHERE experiences_fts MATCH @query AND (e.project = @project OR e.project = '')
    AND e.deleted_at IS NULL
  ORDER BY (bm25(experiences_fts) * -1.0) * 0.5
    + (1.0 / (1.0 + julianday('now') - julianday(e.created_at))) * 0.3
    + (CASE WHEN e.success = 1 THEN 1.0 ELSE 0.5 END) * 0.2
    + (CASE WHEN e.project = @project THEN 0.1 ELSE 0.0 END)
    DESC
  LIMIT @limit
`);

// Phase 5: Get full experience by ID
export const getExperienceById = db.prepare(`
  SELECT * FROM experiences
  WHERE id = @id AND deleted_at IS NULL
`);

// Phase 5: Get timeline around an experience
export const getExperienceTimeline = db.prepare(`
  SELECT id, type, tags, created_at, success, project,
    substr(context, 1, 120) AS snippet
  FROM experiences
  WHERE deleted_at IS NULL
    AND created_at BETWEEN
      (SELECT datetime(created_at, '-1 hour') FROM experiences WHERE id = @id)
      AND
      (SELECT datetime(created_at, '+1 hour') FROM experiences WHERE id = @id)
  ORDER BY created_at ASC
  LIMIT 20
`);

export const getRecentExperiences = db.prepare(`
  SELECT * FROM experiences
  WHERE deleted_at IS NULL
  ORDER BY created_at DESC
  LIMIT @limit
`);

export const getExperiencesByType = db.prepare(`
  SELECT * FROM experiences
  WHERE type = @type AND deleted_at IS NULL
  ORDER BY created_at DESC
  LIMIT @limit
`);

// ── Preferences with scope ──────────────────────────────
// Phase 6: Base confidence 0.3, confirmed_count tracking

// Re-learning a preference explicitly revalidates it (clears invalidation).
export const upsertPreference = db.prepare(`
  INSERT INTO preferences (key, value, confidence, source, scope, confirmed_count, last_confirmed_at)
  VALUES (@key, @value, @confidence, @source, @scope, 1, datetime('now'))
  ON CONFLICT(key, scope) DO UPDATE SET
    value = @value,
    confidence = MIN(1.0, 0.3 + (confirmed_count + 1) * 0.1),
    source = @source,
    updated_at = datetime('now'),
    confirmed_count = confirmed_count + 1,
    last_confirmed_at = datetime('now'),
    invalidated_at = NULL,
    superseded_by = NULL
`);

// Returns global preferences (automatic retrieval: invalidated rows hidden)
export const getGlobalPreferences = db.prepare(`
  SELECT * FROM preferences
  WHERE scope = 'global' AND invalidated_at IS NULL
  ORDER BY confidence DESC
`);

// Returns preferences for a specific project (invalidated rows hidden)
export const getProjectPreferences = db.prepare(`
  SELECT * FROM preferences
  WHERE scope = @scope AND invalidated_at IS NULL
  ORDER BY confidence DESC
`);

// ── Reversible invalidation (retrieval v3) ──────────────
// Invalidation hides a preference from every automatic retrieval path
// (getGlobalPreferences, getMergedPreferences, session_start, on-prompt)
// without deleting the row, so it can always be restored. superseded_by
// optionally records the key of the preference that replaced it.

const invalidatePreferenceStmt = db.prepare(`
  UPDATE preferences
  SET invalidated_at = datetime('now'), superseded_by = @superseded_by
  WHERE key = @key AND scope = @scope AND invalidated_at IS NULL
`);

export function invalidatePreference(key: string, scope: string, supersededBy?: string): boolean {
  return invalidatePreferenceStmt.run({ key, scope, superseded_by: supersededBy ?? null }).changes > 0;
}

const restorePreferenceStmt = db.prepare(`
  UPDATE preferences
  SET invalidated_at = NULL, superseded_by = NULL
  WHERE key = @key AND scope = @scope AND invalidated_at IS NOT NULL
`);

export function restorePreference(key: string, scope: string): boolean {
  return restorePreferenceStmt.run({ key, scope }).changes > 0;
}

// Returns merged preferences: project + global (project takes priority)
// Phase 6: Applies temporal decay
// Optional limit / minEffectiveConfidence applied after merge+decay+sort;
// without options the full merged list is returned (backwards compatible).
export function getMergedPreferences(project: string, options?: PreferenceOptions) {
  const global = getGlobalPreferences.all() as any[];
  const projectPrefs = getProjectPreferences.all({ scope: project }) as any[];

  // Project overrides global
  const merged = new Map<string, any>();
  for (const pref of global) {
    merged.set(pref.key, { ...pref, _origin: "global" });
  }
  for (const pref of projectPrefs) {
    merged.set(pref.key, { ...pref, _origin: "project" });
  }

  const sorted = Array.from(merged.values())
    .map(applyDecay)
    .sort((a, b) => b.effective_confidence - a.effective_confidence);

  return applyPreferenceOptions(sorted, options);
}

export const getPreference = db.prepare(`
  SELECT * FROM preferences WHERE key = @key AND scope = @scope
`);

// ── Patterns ────────────────────────────────────────────

export function recordPattern(description: string, category: string, example: string) {
  // Normalizar paths absolutos del sandbox para portabilidad entre máquinas.
  description = normalizeTextPaths(description);
  example = normalizeTextPaths(example);

  const existing = db.prepare(`SELECT * FROM patterns WHERE description = ?`).get(description) as any;

  if (existing) {
    const examples = JSON.parse(existing.examples || "[]");
    examples.push(example);
    if (examples.length > 10) examples.shift();

    db.prepare(`
      UPDATE patterns
      SET frequency = frequency + 1, last_seen = datetime('now'), examples = ?
      WHERE id = ?
    `).run(JSON.stringify(examples), existing.id);
  } else {
    db.prepare(`
      INSERT INTO patterns (description, category, examples)
      VALUES (?, ?, ?)
    `).run(description, category, JSON.stringify([example]));
  }
}

export const getPatterns = db.prepare(`
  SELECT * FROM patterns
  ORDER BY frequency DESC
  LIMIT @limit
`);

// ── Soft Delete (Phase 1) ───────────────────────────────
// DELETE operations become UPDATE SET deleted_at

export const softDeleteExperienceById = db.prepare(`
  UPDATE experiences SET deleted_at = datetime('now')
  WHERE id = @id AND deleted_at IS NULL
`);

export const softDeleteExperiencesByTag = db.prepare(`
  UPDATE experiences SET deleted_at = datetime('now')
  WHERE tags LIKE '%' || @tag || '%' AND deleted_at IS NULL
`);

export const softDeleteExperiencesByProject = db.prepare(`
  UPDATE experiences SET deleted_at = datetime('now')
  WHERE project = @project AND deleted_at IS NULL
`);

// ── Prune (Phase 1: soft delete) ────────────────────────

export const pruneOldExperiences = db.prepare(`
  UPDATE experiences SET deleted_at = datetime('now')
  WHERE created_at < datetime('now', '-' || @days || ' days')
    AND (@only_failures = 0 OR success = 0)
    AND deleted_at IS NULL
`);

export const pruneLowConfidencePreferences = db.prepare(`
  DELETE FROM preferences WHERE confidence < @min_confidence
`);

// ── Stats (Phase 1: includes soft-deleted count) ────────

export const getStats = () => {
  const experiences = (db.prepare(`SELECT COUNT(*) as count FROM experiences WHERE deleted_at IS NULL`).get() as any).count;
  const corrections = (db.prepare(`SELECT COUNT(*) as count FROM experiences WHERE type = 'correction' AND deleted_at IS NULL`).get() as any).count;
  const softDeleted = (db.prepare(`SELECT COUNT(*) as count FROM experiences WHERE deleted_at IS NOT NULL`).get() as any).count;
  const globalPrefs = (db.prepare(`SELECT COUNT(*) as count FROM preferences WHERE scope = 'global'`).get() as any).count;
  const projectPrefs = (db.prepare(`SELECT COUNT(*) as count FROM preferences WHERE scope != 'global'`).get() as any).count;
  const patterns = (db.prepare(`SELECT COUNT(*) as count FROM patterns`).get() as any).count;

  return { experiences, corrections, softDeleted, globalPrefs, projectPrefs, patterns };
};

// ── Vector operations (experiences) ──────────────────────
// Solo se preparan si sqlite-vec está disponible

const insertVector = vectorsAvailable
  ? db.prepare(`INSERT INTO vec_experiences(experience_id, embedding) VALUES (?, ?)`)
  : null;

const deleteVector = vectorsAvailable
  ? db.prepare(`DELETE FROM vec_experiences WHERE experience_id = ?`)
  : null;

const searchVectorKNN = vectorsAvailable
  ? db.prepare(`SELECT experience_id, distance FROM vec_experiences WHERE embedding MATCH ? AND k = ?`)
  : null;

export const getExperienceProject = db.prepare(
  `SELECT project FROM experiences WHERE id = @id AND deleted_at IS NULL`
);

/** Insert or replace a vector (vec0 doesn't support UPDATE). */
export function upsertVector(experienceId: number, embedding: Float32Array) {
  if (!vectorsAvailable || !insertVector || !deleteVector) return;
  const upsert = db.transaction(() => {
    deleteVector.run(BigInt(experienceId));
    insertVector.run(BigInt(experienceId), embedding);
  });
  upsert();
}

// ── Vector operations (preferences) ─────────────────────

const insertPrefVector = vectorsAvailable
  ? db.prepare(`INSERT INTO vec_preferences(preference_id, embedding) VALUES (?, ?)`)
  : null;

const deletePrefVector = vectorsAvailable
  ? db.prepare(`DELETE FROM vec_preferences WHERE preference_id = ?`)
  : null;

const searchPrefVectorKNN = vectorsAvailable
  ? db.prepare(`SELECT preference_id, distance FROM vec_preferences WHERE embedding MATCH ? AND k = ?`)
  : null;

/** Insert or replace a preference vector. */
export function upsertPrefVector(prefId: number, embedding: Float32Array) {
  if (!vectorsAvailable || !insertPrefVector || !deletePrefVector) return;
  const upsert = db.transaction(() => {
    deletePrefVector.run(BigInt(prefId));
    insertPrefVector.run(BigInt(prefId), embedding);
  });
  upsert();
}

/** Get preference by ID. */
export const getPreferenceById = db.prepare(
  `SELECT * FROM preferences WHERE id = @id`
);

// ── FTS5 query sanitization ──────────────────────────────

/** Sanitize user input for FTS5 MATCH. Returns null if query is empty after sanitization. */
export function sanitizeFtsQuery(query: string): string | null {
  // Replace hyphens with spaces (FTS5 treats - as NOT operator)
  let sanitized = query.replace(/-/g, " ");
  // Replace FTS5 special characters with spaces (not just remove, to keep words separate)
  sanitized = sanitized.replace(/[():*^"{}[\]]/g, " ");
  // Collapse whitespace
  sanitized = sanitized.replace(/\s+/g, " ").trim();
  // Filter out single-char words
  const words = sanitized.split(" ").filter((w) => w.length > 1);
  if (words.length === 0) return null;
  // Join with OR for flexible matching
  return words.join(" OR ");
}

// ── Hybrid search (FTS5 + vector fusion) ─────────────────

// FTS queries that expose the raw BM25 rank plus the searchable text,
// so the caller can compute a proportional score (term coverage * BM25).
export const searchExperiencesScored = db.prepare(`
  SELECT e.id, bm25(experiences_fts) AS bm25_score,
    lower(coalesce(e.context, '') || ' ' || coalesce(e.action, '') || ' ' ||
          coalesce(e.result, '') || ' ' || coalesce(e.tags, '')) AS haystack
  FROM experiences e
  JOIN experiences_fts fts ON e.id = fts.rowid
  WHERE experiences_fts MATCH @query
    AND e.deleted_at IS NULL
  ORDER BY bm25(experiences_fts)
  LIMIT @limit
`);

export const searchExperiencesScoredByProject = db.prepare(`
  SELECT e.id, bm25(experiences_fts) AS bm25_score,
    lower(coalesce(e.context, '') || ' ' || coalesce(e.action, '') || ' ' ||
          coalesce(e.result, '') || ' ' || coalesce(e.tags, '')) AS haystack
  FROM experiences e
  JOIN experiences_fts fts ON e.id = fts.rowid
  WHERE experiences_fts MATCH @query AND (e.project = @project OR e.project = '')
    AND e.deleted_at IS NULL
  ORDER BY bm25(experiences_fts)
  LIMIT @limit
`);

export type HybridResult = { id: number; score: number; source: "experience" | "preference" };

// Score fusion formula (absolute, thresholdable, range [0, 1]):
//   score = 0.7 * vectorSimilarity + 0.3 * ftsScore
// where vectorSimilarity = clamp01(1 - cosine distance) and
// ftsScore = termCoverage * normalizedBm25 (see scoring.ts). The FTS query
// still joins terms with OR for recall, but the score is proportional to
// how many query terms actually match instead of a flat presence bonus.
export function hybridSearch(params: {
  safeQuery: string | null;
  queryEmbedding: Float32Array | null;
  project?: string;
  limit?: number;
}): HybridResult[] {
  const k = params.limit || 10;
  const fetchK = k * 3;
  // Per-channel signals keyed by "exp:ID" or "pref:ID"
  const vecScores = new Map<string, number>();
  const ftsScores = new Map<string, number>();

  // 1. FTS5 search (experiences only — preferences don't have FTS)
  if (params.safeQuery) {
    const terms = params.safeQuery
      .split(" OR ")
      .map((t) => t.toLowerCase())
      .filter((t) => t.length > 0);
    try {
      const ftsResults = params.project
        ? searchExperiencesScoredByProject.all({
            query: params.safeQuery,
            project: params.project,
            limit: fetchK,
          }) as any[]
        : searchExperiencesScored.all({
            query: params.safeQuery,
            limit: fetchK,
          }) as any[];
      for (const r of ftsResults) {
        const matched = terms.filter((t) => (r.haystack || "").includes(t)).length;
        ftsScores.set(`exp:${r.id}`, computeFtsScore(r.bm25_score, matched, terms.length));
      }
    } catch {
      // FTS5 query failed, continue with vector-only
    }
  }

  // 2. Vector KNN search (experiences) — solo si hay embedding y sqlite-vec disponible
  if (params.queryEmbedding && vectorsAvailable && searchVectorKNN) {
    try {
      const vecResults = searchVectorKNN.all(params.queryEmbedding, fetchK) as any[];
      vecResults.forEach((r: any) => {
        const id = r.experience_id;
        if (params.project) {
          const exp = getExperienceProject.get({ id }) as any;
          if (exp && exp.project !== params.project && exp.project !== "") return;
        }
        const key = `exp:${id}`;
        const similarity = clampSimilarity(1.0 - r.distance); // cosine distance → similarity
        vecScores.set(key, Math.max(vecScores.get(key) || 0, similarity));
      });
    } catch {
      // Vector search failed (empty table or other issue)
    }
  }

  // 3. Vector KNN search (preferences) — solo si hay embedding y sqlite-vec disponible
  if (params.queryEmbedding && vectorsAvailable && searchPrefVectorKNN) {
    try {
      const prefResults = searchPrefVectorKNN.all(params.queryEmbedding, fetchK) as any[];
      prefResults.forEach((r: any) => {
        const key = `pref:${r.preference_id}`;
        const similarity = clampSimilarity(1.0 - r.distance);
        vecScores.set(key, Math.max(vecScores.get(key) || 0, similarity));
      });
    } catch {
      // Preference vector search failed
    }
  }

  // 4. Fuse channels into an absolute score, sort, return top K
  const keys = new Set<string>([...vecScores.keys(), ...ftsScores.keys()]);
  return [...keys]
    .map((key) => ({
      key,
      score: fuseScores(vecScores.get(key) || 0, ftsScores.get(key) || 0),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(({ key, score }) => {
      const [source, idStr] = key.split(":");
      return { id: Number(idStr), score, source: source as "experience" | "preference" };
    });
}

// ── WAL Checkpoint ──────────────────────────────────────
export function checkpoint() {
  db.pragma("wal_checkpoint(TRUNCATE)");
}

export default db;
