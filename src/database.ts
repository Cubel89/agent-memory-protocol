import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "data", "memory.db");

// ── Database initialization ──────────────────────────────

export function initDatabase(dbPath?: string) {
  const db = new Database(dbPath || DB_PATH);

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

  // ── Indexes ────────────────────────────────────────────

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_experiences_deleted_at ON experiences(deleted_at);
    CREATE INDEX IF NOT EXISTS idx_experiences_normalized_hash ON experiences(normalized_hash, project, created_at);
    CREATE INDEX IF NOT EXISTS idx_experiences_topic_key ON experiences(topic_key, project);
  `);

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

// Phase 2: insertOrDeduplicate
export function insertOrDeduplicate(params: {
  type: string;
  context: string;
  action: string;
  result: string;
  success: number;
  tags: string;
  project: string;
  topic_key?: string;
}): { id: number; deduplicated: boolean; upserted?: boolean } {
  const hash = computeHash(params.context, params.action, params.result);

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

  return { id: Number(info.lastInsertRowid), deduplicated: false };
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

export const upsertPreference = db.prepare(`
  INSERT INTO preferences (key, value, confidence, source, scope, confirmed_count, last_confirmed_at)
  VALUES (@key, @value, @confidence, @source, @scope, 1, datetime('now'))
  ON CONFLICT(key, scope) DO UPDATE SET
    value = @value,
    confidence = MIN(1.0, 0.3 + (confirmed_count) * 0.1),
    source = @source,
    updated_at = datetime('now'),
    confirmed_count = confirmed_count + 1,
    last_confirmed_at = datetime('now')
`);

// Returns global preferences
export const getGlobalPreferences = db.prepare(`
  SELECT * FROM preferences
  WHERE scope = 'global'
  ORDER BY confidence DESC
`);

// Returns preferences for a specific project
export const getProjectPreferences = db.prepare(`
  SELECT * FROM preferences
  WHERE scope = @scope
  ORDER BY confidence DESC
`);

// Phase 6: Decay factor calculation
export function computeDecayFactor(lastConfirmedAt: string | null): number {
  if (!lastConfirmedAt) return 0.5; // no confirmation date = max decay
  const now = Date.now();
  const confirmed = new Date(lastConfirmedAt + "Z").getTime();
  const daysSince = (now - confirmed) / (1000 * 60 * 60 * 24);

  if (daysSince <= 30) return 1.0;
  if (daysSince <= 90) return 0.9;
  if (daysSince <= 180) return 0.7;
  return 0.5;
}

export function applyDecay(pref: any): any {
  const decay = computeDecayFactor(pref.last_confirmed_at);
  const effectiveConfidence = Math.round(pref.confidence * decay * 100) / 100;
  return {
    ...pref,
    effective_confidence: effectiveConfidence,
    decay_factor: decay,
  };
}

// Returns merged preferences: project + global (project takes priority)
// Phase 6: Applies temporal decay
export function getMergedPreferences(project: string) {
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

  return Array.from(merged.values())
    .map(applyDecay)
    .sort((a, b) => b.effective_confidence - a.effective_confidence);
}

export const getPreference = db.prepare(`
  SELECT * FROM preferences WHERE key = @key AND scope = @scope
`);

// ── Patterns ────────────────────────────────────────────

export function recordPattern(description: string, category: string, example: string) {
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

// ── WAL Checkpoint ──────────────────────────────────────
export function checkpoint() {
  db.pragma("wal_checkpoint(TRUNCATE)");
}

export default db;
