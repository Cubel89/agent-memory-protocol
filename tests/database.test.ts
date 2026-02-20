import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { createHash } from "crypto";

// ── Helpers ─────────────────────────────────────────────

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function computeHash(context: string, action: string, result: string): string {
  const normalized = normalizeText(`${context}|${action}|${result}`);
  return createHash("sha256").update(normalized).digest("hex");
}

function computeDecayFactor(lastConfirmedAt: string | null): number {
  if (!lastConfirmedAt) return 0.5;
  const now = Date.now();
  const confirmed = new Date(lastConfirmedAt + "Z").getTime();
  const daysSince = (now - confirmed) / (1000 * 60 * 60 * 24);
  if (daysSince <= 30) return 1.0;
  if (daysSince <= 90) return 0.9;
  if (daysSince <= 180) return 0.7;
  return 0.5;
}

// Helper: creates an in-memory DB with the full v1.0.0 schema
function createTestDb() {
  const db = new Database(":memory:");

  db.exec(`
    CREATE TABLE IF NOT EXISTS experiences (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      type        TEXT NOT NULL,
      context     TEXT,
      action      TEXT,
      result      TEXT,
      success     INTEGER DEFAULT 1,
      tags        TEXT DEFAULT '',
      project     TEXT DEFAULT '',
      created_at  TEXT DEFAULT (datetime('now')),
      -- Phase 1: Soft Delete
      deleted_at       TEXT DEFAULT NULL,
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
      category    TEXT DEFAULT '',
      frequency   INTEGER DEFAULT 1,
      examples    TEXT DEFAULT '[]',
      last_seen   TEXT DEFAULT (datetime('now'))
    );

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

    CREATE INDEX IF NOT EXISTS idx_experiences_deleted_at ON experiences(deleted_at);
    CREATE INDEX IF NOT EXISTS idx_experiences_normalized_hash ON experiences(normalized_hash, project, created_at);
    CREATE INDEX IF NOT EXISTS idx_experiences_topic_key ON experiences(topic_key, project);

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

// Helper: prepares queries for a given DB (v1.0.0)
function prepareQueries(db: BetterSqlite3.Database) {
  const insertExperience = db.prepare(`
    INSERT INTO experiences (type, context, action, result, success, tags, project, normalized_hash, last_seen_at)
    VALUES (@type, @context, @action, @result, @success, @tags, @project, @normalized_hash, datetime('now'))
  `);

  const searchExperiences = db.prepare(`
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

  const searchExperiencesByProject = db.prepare(`
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

  // Phase 5: Compact search
  const searchExperiencesCompact = db.prepare(`
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

  // Phase 5: Get full experience by ID
  const getExperienceById = db.prepare(`
    SELECT * FROM experiences
    WHERE id = @id AND deleted_at IS NULL
  `);

  // Phase 5: Timeline around an experience
  const getExperienceTimeline = db.prepare(`
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

  // Phase 6: Base confidence 0.3, confirmed_count tracking
  const upsertPreference = db.prepare(`
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

  const getGlobalPreferences = db.prepare(`
    SELECT * FROM preferences WHERE scope = 'global' ORDER BY confidence DESC
  `);

  const getProjectPreferences = db.prepare(`
    SELECT * FROM preferences WHERE scope = @scope ORDER BY confidence DESC
  `);

  const getPatterns = db.prepare(`
    SELECT * FROM patterns ORDER BY frequency DESC LIMIT @limit
  `);

  // Phase 1: Soft delete
  const softDeleteExperienceById = db.prepare(`
    UPDATE experiences SET deleted_at = datetime('now')
    WHERE id = @id AND deleted_at IS NULL
  `);
  const softDeleteExperiencesByTag = db.prepare(`
    UPDATE experiences SET deleted_at = datetime('now')
    WHERE tags LIKE '%' || @tag || '%' AND deleted_at IS NULL
  `);
  const softDeleteExperiencesByProject = db.prepare(`
    UPDATE experiences SET deleted_at = datetime('now')
    WHERE project = @project AND deleted_at IS NULL
  `);

  // Phase 1: Prune uses soft delete
  const pruneOldExperiences = db.prepare(`
    UPDATE experiences SET deleted_at = datetime('now')
    WHERE created_at < datetime('now', '-' || @days || ' days')
      AND (@only_failures = 0 OR success = 0)
      AND deleted_at IS NULL
  `);

  const pruneLowConfidencePreferences = db.prepare(`
    DELETE FROM preferences WHERE confidence < @min_confidence
  `);

  // Phase 2: Deduplication
  const findDuplicate = db.prepare(`
    SELECT * FROM experiences
    WHERE normalized_hash = @hash
      AND project = @project
      AND deleted_at IS NULL
      AND created_at >= datetime('now', '-15 minutes')
    LIMIT 1
  `);

  const incrementDuplicate = db.prepare(`
    UPDATE experiences
    SET duplicate_count = duplicate_count + 1,
        last_seen_at = datetime('now')
    WHERE id = @id
  `);

  // Phase 3: Topic upsert
  const findByTopicKey = db.prepare(`
    SELECT * FROM experiences
    WHERE topic_key = @topic_key
      AND project = @project
      AND deleted_at IS NULL
    LIMIT 1
  `);

  const updateByTopicKey = db.prepare(`
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

  function insertOrDeduplicate(params: {
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

  function getMergedPreferences(project: string) {
    const global = getGlobalPreferences.all() as any[];
    const projectPrefs = getProjectPreferences.all({ scope: project }) as any[];
    const merged = new Map<string, any>();
    for (const pref of global) merged.set(pref.key, { ...pref, _origin: "global" });
    for (const pref of projectPrefs) merged.set(pref.key, { ...pref, _origin: "project" });
    return Array.from(merged.values())
      .map((p) => {
        const decay = computeDecayFactor(p.last_confirmed_at);
        return { ...p, effective_confidence: Math.round(p.confidence * decay * 100) / 100, decay_factor: decay };
      })
      .sort((a, b) => b.effective_confidence - a.effective_confidence);
  }

  function recordPattern(description: string, category: string, example: string) {
    const existing = db.prepare(`SELECT * FROM patterns WHERE description = ?`).get(description) as any;
    if (existing) {
      const examples = JSON.parse(existing.examples || "[]");
      examples.push(example);
      if (examples.length > 10) examples.shift();
      db.prepare(`UPDATE patterns SET frequency = frequency + 1, last_seen = datetime('now'), examples = ? WHERE id = ?`)
        .run(JSON.stringify(examples), existing.id);
    } else {
      db.prepare(`INSERT INTO patterns (description, category, examples) VALUES (?, ?, ?)`)
        .run(description, category, JSON.stringify([example]));
    }
  }

  function getStats() {
    const experiences = (db.prepare(`SELECT COUNT(*) as count FROM experiences WHERE deleted_at IS NULL`).get() as any).count;
    const corrections = (db.prepare(`SELECT COUNT(*) as count FROM experiences WHERE type = 'correction' AND deleted_at IS NULL`).get() as any).count;
    const softDeleted = (db.prepare(`SELECT COUNT(*) as count FROM experiences WHERE deleted_at IS NOT NULL`).get() as any).count;
    const globalPrefs = (db.prepare(`SELECT COUNT(*) as count FROM preferences WHERE scope = 'global'`).get() as any).count;
    const projectPrefs = (db.prepare(`SELECT COUNT(*) as count FROM preferences WHERE scope != 'global'`).get() as any).count;
    const patterns = (db.prepare(`SELECT COUNT(*) as count FROM patterns`).get() as any).count;
    return { experiences, corrections, softDeleted, globalPrefs, projectPrefs, patterns };
  }

  return {
    insertExperience,
    searchExperiences,
    searchExperiencesByProject,
    searchExperiencesCompact,
    getExperienceById,
    getExperienceTimeline,
    upsertPreference,
    getGlobalPreferences,
    getProjectPreferences,
    getMergedPreferences,
    getPatterns,
    recordPattern,
    getStats,
    softDeleteExperienceById,
    softDeleteExperiencesByTag,
    softDeleteExperiencesByProject,
    pruneOldExperiences,
    pruneLowConfidencePreferences,
    insertOrDeduplicate,
    findDuplicate,
    incrementDuplicate,
    findByTopicKey,
    updateByTopicKey,
  };
}

// ── Tests ───────────────────────────────────────────────

let db: BetterSqlite3.Database;
let q: ReturnType<typeof prepareQueries>;

beforeEach(() => {
  db = createTestDb();
  q = prepareQueries(db);
});

// ═══════════════════════════════════════════════════════
// EXISTING TESTS (updated for v1.0.0)
// ═══════════════════════════════════════════════════════

describe("experiences", () => {
  it("inserts an experience and retrieves it", () => {
    q.insertExperience.run({
      type: "experience", context: "test context", action: "test action",
      result: "test result", success: 1, tags: "test", project: "",
      normalized_hash: computeHash("test context", "test action", "test result"),
    });
    const rows = db.prepare("SELECT * FROM experiences WHERE deleted_at IS NULL").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].context).toBe("test context");
    expect(rows[0].success).toBe(1);
  });

  it("searches via FTS and gets results", () => {
    q.insertExperience.run({
      type: "experience", context: "error en typescript imports",
      action: "fix imports", result: "resuelto", success: 1, tags: "typescript", project: "",
      normalized_hash: computeHash("error en typescript imports", "fix imports", "resuelto"),
    });
    const results = q.searchExperiences.all({ query: "typescript", limit: 5 }) as any[];
    expect(results).toHaveLength(1);
    expect(results[0].context).toContain("typescript");
  });

  it("filters correctly when searching by project", () => {
    q.insertExperience.run({
      type: "experience", context: "bug en api", action: "fix",
      result: "ok", success: 1, tags: "api", project: "proyecto-a",
      normalized_hash: computeHash("bug en api", "fix", "ok"),
    });
    q.insertExperience.run({
      type: "experience", context: "bug en api diferente", action: "fix",
      result: "ok", success: 1, tags: "api", project: "proyecto-b",
      normalized_hash: computeHash("bug en api diferente", "fix", "ok"),
    });

    const results = q.searchExperiencesByProject.all({
      query: "api", project: "proyecto-a", limit: 10,
    }) as any[];

    expect(results).toHaveLength(1);
    expect(results[0].project).toBe("proyecto-a");
  });

  it("FTS syncs after UPDATE (trigger au)", () => {
    q.insertExperience.run({
      type: "experience", context: "alpha unique keyword", action: "some action",
      result: "some result", success: 1, tags: "misc", project: "",
      normalized_hash: computeHash("alpha unique keyword", "some action", "some result"),
    });

    const before = q.searchExperiences.all({ query: "alpha", limit: 5 }) as any[];
    expect(before).toHaveLength(1);

    db.prepare("UPDATE experiences SET context = 'beta updated keyword' WHERE id = 1").run();

    const results = q.searchExperiences.all({ query: "beta", limit: 5 }) as any[];
    expect(results).toHaveLength(1);
    expect(results[0].context).toBe("beta updated keyword");

    const oldResults = q.searchExperiences.all({ query: "alpha", limit: 5 }) as any[];
    expect(oldResults).toHaveLength(0);
  });
});

describe("preferences", () => {
  it("upsert increments confidence using Phase 6 formula", () => {
    q.upsertPreference.run({ key: "idioma", value: "es", confidence: 0.3, source: "test", scope: "global" });
    q.upsertPreference.run({ key: "idioma", value: "es", confidence: 0.3, source: "test", scope: "global" });

    const pref = db.prepare("SELECT * FROM preferences WHERE key = 'idioma'").get() as any;
    // First insert: confidence = 0.3, confirmed_count = 1
    // Second upsert: confidence = MIN(1.0, 0.3 + 1 * 0.1) = 0.4, confirmed_count = 2
    expect(pref.confidence).toBe(0.4);
    expect(pref.confirmed_count).toBe(2);
  });

  it("merge preferences: project wins over global", () => {
    q.upsertPreference.run({ key: "framework", value: "react", confidence: 0.3, source: "test", scope: "global" });
    q.upsertPreference.run({ key: "framework", value: "vue", confidence: 0.3, source: "test", scope: "mi-proyecto" });

    const merged = q.getMergedPreferences("mi-proyecto");
    const fw = merged.find((p: any) => p.key === "framework");
    expect(fw.value).toBe("vue");
    expect(fw._origin).toBe("project");
  });
});

describe("patterns", () => {
  it("recordPattern increments frequency", () => {
    q.recordPattern("siempre usar strict mode", "workflow", "ejemplo 1");
    q.recordPattern("siempre usar strict mode", "workflow", "ejemplo 2");

    const patterns = q.getPatterns.all({ limit: 10 }) as any[];
    expect(patterns).toHaveLength(1);
    expect(patterns[0].frequency).toBe(2);
    expect(JSON.parse(patterns[0].examples)).toHaveLength(2);
  });
});

describe("stats", () => {
  it("returns correct counters including soft-deleted", () => {
    q.insertExperience.run({
      type: "experience", context: "a", action: "b", result: "c",
      success: 1, tags: "", project: "",
      normalized_hash: computeHash("a", "b", "c"),
    });
    q.insertExperience.run({
      type: "correction", context: "d", action: "e", result: "f",
      success: 0, tags: "", project: "",
      normalized_hash: computeHash("d", "e", "f"),
    });
    q.upsertPreference.run({ key: "k1", value: "v1", confidence: 0.3, source: "", scope: "global" });
    q.upsertPreference.run({ key: "k2", value: "v2", confidence: 0.3, source: "", scope: "my-project" });
    q.recordPattern("p1", "test", "ex1");

    const stats = q.getStats();
    expect(stats.experiences).toBe(2);
    expect(stats.corrections).toBe(1);
    expect(stats.softDeleted).toBe(0);
    expect(stats.globalPrefs).toBe(1);
    expect(stats.projectPrefs).toBe(1);
    expect(stats.patterns).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════
// PHASE 1: SOFT DELETE
// ═══════════════════════════════════════════════════════

describe("soft delete (Phase 1)", () => {
  it("soft deletes by id (sets deleted_at instead of removing)", () => {
    q.insertExperience.run({
      type: "experience", context: "a", action: "b", result: "c",
      success: 1, tags: "x", project: "",
      normalized_hash: computeHash("a", "b", "c"),
    });
    q.insertExperience.run({
      type: "experience", context: "d", action: "e", result: "f",
      success: 1, tags: "y", project: "",
      normalized_hash: computeHash("d", "e", "f"),
    });

    const result = q.softDeleteExperienceById.run({ id: 1 });
    expect(result.changes).toBe(1);

    // Row still exists in DB
    const allRows = db.prepare("SELECT * FROM experiences").all();
    expect(allRows).toHaveLength(2);

    // But only 1 is active
    const activeRows = db.prepare("SELECT * FROM experiences WHERE deleted_at IS NULL").all();
    expect(activeRows).toHaveLength(1);
  });

  it("soft-deleted records are excluded from FTS search", () => {
    q.insertExperience.run({
      type: "experience", context: "findme unique keyword", action: "action",
      result: "result", success: 1, tags: "test", project: "",
      normalized_hash: computeHash("findme unique keyword", "action", "result"),
    });

    // Verify it's searchable
    const before = q.searchExperiences.all({ query: "findme", limit: 5 }) as any[];
    expect(before).toHaveLength(1);

    // Soft delete it
    q.softDeleteExperienceById.run({ id: 1 });

    // Should no longer appear in search
    const after = q.searchExperiences.all({ query: "findme", limit: 5 }) as any[];
    expect(after).toHaveLength(0);
  });

  it("stats count soft-deleted separately", () => {
    q.insertExperience.run({
      type: "experience", context: "a", action: "b", result: "c",
      success: 1, tags: "", project: "",
      normalized_hash: computeHash("a", "b", "c"),
    });
    q.insertExperience.run({
      type: "experience", context: "d", action: "e", result: "f",
      success: 1, tags: "", project: "",
      normalized_hash: computeHash("d", "e", "f"),
    });

    q.softDeleteExperienceById.run({ id: 1 });

    const stats = q.getStats();
    expect(stats.experiences).toBe(1);
    expect(stats.softDeleted).toBe(1);
  });
});

describe("forget_memory (Phase 1: soft delete)", () => {
  it("soft deletes by id only that record", () => {
    q.insertExperience.run({
      type: "experience", context: "a", action: "b", result: "c",
      success: 1, tags: "x", project: "",
      normalized_hash: computeHash("a", "b", "c"),
    });
    q.insertExperience.run({
      type: "experience", context: "d", action: "e", result: "f",
      success: 1, tags: "y", project: "",
      normalized_hash: computeHash("d", "e", "f"),
    });

    const result = q.softDeleteExperienceById.run({ id: 1 });
    expect(result.changes).toBe(1);

    const rows = db.prepare("SELECT * FROM experiences WHERE deleted_at IS NULL").all();
    expect(rows).toHaveLength(1);
  });

  it("soft deletes by tag matching records", () => {
    q.insertExperience.run({
      type: "experience", context: "a", action: "b", result: "c",
      success: 1, tags: "typescript,bug", project: "",
      normalized_hash: computeHash("a", "b", "c"),
    });
    q.insertExperience.run({
      type: "experience", context: "d", action: "e", result: "f",
      success: 1, tags: "python", project: "",
      normalized_hash: computeHash("d", "e", "f"),
    });
    q.insertExperience.run({
      type: "experience", context: "g", action: "h", result: "i",
      success: 1, tags: "typescript,api", project: "",
      normalized_hash: computeHash("g", "h", "i"),
    });

    const result = q.softDeleteExperiencesByTag.run({ tag: "typescript" });
    expect(result.changes).toBe(2);

    const rows = db.prepare("SELECT * FROM experiences WHERE deleted_at IS NULL").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].tags).toBe("python");
  });

  it("soft deletes by project all project records", () => {
    q.insertExperience.run({
      type: "experience", context: "a", action: "b", result: "c",
      success: 1, tags: "", project: "proj-a",
      normalized_hash: computeHash("a", "b", "c"),
    });
    q.insertExperience.run({
      type: "experience", context: "d", action: "e", result: "f",
      success: 1, tags: "", project: "proj-b",
      normalized_hash: computeHash("d", "e", "f"),
    });

    const result = q.softDeleteExperiencesByProject.run({ project: "proj-a" });
    expect(result.changes).toBe(1);

    const rows = db.prepare("SELECT * FROM experiences WHERE deleted_at IS NULL").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].project).toBe("proj-b");
  });
});

describe("prune_memory (Phase 1: soft delete)", () => {
  it("soft-deletes old experiences by days", () => {
    db.prepare(`
      INSERT INTO experiences (type, context, action, result, success, tags, project, created_at, normalized_hash)
      VALUES ('experience', 'old', 'old action', 'old result', 1, '', '', datetime('now', '-100 days'), 'hash1')
    `).run();
    q.insertExperience.run({
      type: "experience", context: "new", action: "new action", result: "new result",
      success: 1, tags: "", project: "",
      normalized_hash: computeHash("new", "new action", "new result"),
    });

    const result = q.pruneOldExperiences.run({ days: 30, only_failures: 0 });
    expect(result.changes).toBe(1);

    const activeRows = db.prepare("SELECT * FROM experiences WHERE deleted_at IS NULL").all() as any[];
    expect(activeRows).toHaveLength(1);
    expect(activeRows[0].context).toBe("new");

    // Old row still exists but is soft-deleted
    const allRows = db.prepare("SELECT * FROM experiences").all();
    expect(allRows).toHaveLength(2);
  });

  it("only_failures only soft-deletes failed experiences", () => {
    db.prepare(`
      INSERT INTO experiences (type, context, action, result, success, tags, project, created_at, normalized_hash)
      VALUES ('experience', 'old success', 'a', 'r', 1, '', '', datetime('now', '-100 days'), 'hash1')
    `).run();
    db.prepare(`
      INSERT INTO experiences (type, context, action, result, success, tags, project, created_at, normalized_hash)
      VALUES ('experience', 'old failure', 'a', 'r', 0, '', '', datetime('now', '-100 days'), 'hash2')
    `).run();

    const result = q.pruneOldExperiences.run({ days: 30, only_failures: 1 });
    expect(result.changes).toBe(1);

    const activeRows = db.prepare("SELECT * FROM experiences WHERE deleted_at IS NULL").all() as any[];
    expect(activeRows).toHaveLength(1);
    expect(activeRows[0].context).toBe("old success");
  });

  it("min_confidence cleans low-confidence preferences", () => {
    q.upsertPreference.run({ key: "low", value: "val", confidence: 0.2, source: "", scope: "global" });
    q.upsertPreference.run({ key: "high", value: "val", confidence: 0.8, source: "", scope: "global" });

    const result = q.pruneLowConfidencePreferences.run({ min_confidence: 0.5 });
    expect(result.changes).toBe(1);

    const rows = db.prepare("SELECT * FROM preferences").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe("high");
  });
});

// ═══════════════════════════════════════════════════════
// PHASE 2: DEDUPLICATION
// ═══════════════════════════════════════════════════════

describe("deduplication (Phase 2)", () => {
  it("deduplicates identical experiences within 15-min window", () => {
    const result1 = q.insertOrDeduplicate({
      type: "experience", context: "same context", action: "same action",
      result: "same result", success: 1, tags: "test", project: "proj",
    });
    expect(result1.deduplicated).toBe(false);

    const result2 = q.insertOrDeduplicate({
      type: "experience", context: "same context", action: "same action",
      result: "same result", success: 1, tags: "test", project: "proj",
    });
    expect(result2.deduplicated).toBe(true);
    expect(result2.id).toBe(result1.id);

    // Only one row, duplicate_count = 2
    const rows = db.prepare("SELECT * FROM experiences WHERE deleted_at IS NULL").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].duplicate_count).toBe(2);
  });

  it("does NOT deduplicate outside the 15-min window", () => {
    // Insert with old timestamp
    const hash = computeHash("old context", "old action", "old result");
    db.prepare(`
      INSERT INTO experiences (type, context, action, result, success, tags, project, created_at, normalized_hash, last_seen_at)
      VALUES ('experience', 'old context', 'old action', 'old result', 1, 'test', 'proj', datetime('now', '-30 minutes'), ?, datetime('now', '-30 minutes'))
    `).run(hash);

    const result = q.insertOrDeduplicate({
      type: "experience", context: "old context", action: "old action",
      result: "old result", success: 1, tags: "test", project: "proj",
    });
    expect(result.deduplicated).toBe(false);

    const rows = db.prepare("SELECT * FROM experiences WHERE deleted_at IS NULL").all();
    expect(rows).toHaveLength(2);
  });

  it("deduplication is case-insensitive", () => {
    q.insertOrDeduplicate({
      type: "experience", context: "Hello World", action: "Do Something",
      result: "It Worked", success: 1, tags: "", project: "",
    });
    const result2 = q.insertOrDeduplicate({
      type: "experience", context: "hello world", action: "do something",
      result: "it worked", success: 1, tags: "", project: "",
    });
    expect(result2.deduplicated).toBe(true);

    const rows = db.prepare("SELECT * FROM experiences WHERE deleted_at IS NULL").all();
    expect(rows).toHaveLength(1);
  });

  it("does NOT deduplicate across different projects", () => {
    q.insertOrDeduplicate({
      type: "experience", context: "same", action: "same",
      result: "same", success: 1, tags: "", project: "proj-a",
    });
    const result2 = q.insertOrDeduplicate({
      type: "experience", context: "same", action: "same",
      result: "same", success: 1, tags: "", project: "proj-b",
    });
    expect(result2.deduplicated).toBe(false);

    const rows = db.prepare("SELECT * FROM experiences WHERE deleted_at IS NULL").all();
    expect(rows).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════
// PHASE 3: TOPIC UPSERTS
// ═══════════════════════════════════════════════════════

describe("topic upserts (Phase 3)", () => {
  it("upserts an existing experience with the same topic_key", () => {
    const result1 = q.insertOrDeduplicate({
      type: "experience", context: "original context", action: "original action",
      result: "original result", success: 1, tags: "arch", project: "proj",
      topic_key: "arch:database",
    });
    expect(result1.deduplicated).toBe(false);
    expect(result1.upserted).toBeFalsy();

    const result2 = q.insertOrDeduplicate({
      type: "experience", context: "updated context", action: "updated action",
      result: "updated result", success: 1, tags: "arch", project: "proj",
      topic_key: "arch:database",
    });
    expect(result2.upserted).toBe(true);
    expect(result2.id).toBe(result1.id);

    // Only one row, revision_count = 2, content updated
    const rows = db.prepare("SELECT * FROM experiences WHERE deleted_at IS NULL").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].context).toBe("updated context");
    expect(rows[0].revision_count).toBe(2);
  });

  it("different projects with same topic_key create separate entries", () => {
    q.insertOrDeduplicate({
      type: "experience", context: "ctx a", action: "act a",
      result: "res a", success: 1, tags: "", project: "proj-a",
      topic_key: "config:tsconfig",
    });
    q.insertOrDeduplicate({
      type: "experience", context: "ctx b", action: "act b",
      result: "res b", success: 1, tags: "", project: "proj-b",
      topic_key: "config:tsconfig",
    });

    const rows = db.prepare("SELECT * FROM experiences WHERE deleted_at IS NULL").all();
    expect(rows).toHaveLength(2);
  });

  it("without topic_key, normal insert (no upsert)", () => {
    q.insertOrDeduplicate({
      type: "experience", context: "first", action: "a",
      result: "r", success: 1, tags: "", project: "proj",
    });
    q.insertOrDeduplicate({
      type: "experience", context: "second", action: "b",
      result: "s", success: 1, tags: "", project: "proj",
    });

    const rows = db.prepare("SELECT * FROM experiences WHERE deleted_at IS NULL").all();
    expect(rows).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════
// PHASE 5: PROGRESSIVE DISCLOSURE
// ═══════════════════════════════════════════════════════

describe("progressive disclosure (Phase 5)", () => {
  it("compact search returns snippet truncated to 120 chars", () => {
    const longContext = "A".repeat(200) + " searchable keyword";
    q.insertExperience.run({
      type: "experience", context: longContext, action: "action",
      result: "result", success: 1, tags: "test", project: "",
      normalized_hash: computeHash(longContext, "action", "result"),
    });

    const results = q.searchExperiencesCompact.all({ query: "searchable", limit: 5 }) as any[];
    expect(results).toHaveLength(1);
    expect(results[0].snippet.length).toBe(120);
    // Should NOT have the full context
    expect(results[0].context).toBeUndefined();
  });

  it("getExperienceById returns full details", () => {
    q.insertExperience.run({
      type: "experience", context: "full detail context", action: "full action",
      result: "full result", success: 1, tags: "detail", project: "proj",
      normalized_hash: computeHash("full detail context", "full action", "full result"),
    });

    const exp = q.getExperienceById.get({ id: 1 }) as any;
    expect(exp).toBeTruthy();
    expect(exp.context).toBe("full detail context");
    expect(exp.action).toBe("full action");
    expect(exp.result).toBe("full result");
  });

  it("getExperienceById excludes soft-deleted", () => {
    q.insertExperience.run({
      type: "experience", context: "deleted one", action: "a",
      result: "r", success: 1, tags: "", project: "",
      normalized_hash: computeHash("deleted one", "a", "r"),
    });
    q.softDeleteExperienceById.run({ id: 1 });

    const exp = q.getExperienceById.get({ id: 1 });
    expect(exp).toBeUndefined();
  });

  it("getExperienceTimeline returns events in time window", () => {
    // Insert multiple experiences (all created "now" so within 1-hour window)
    for (let i = 0; i < 5; i++) {
      q.insertExperience.run({
        type: "experience", context: `event ${i}`, action: `action ${i}`,
        result: `result ${i}`, success: 1, tags: "timeline", project: "",
        normalized_hash: computeHash(`event ${i}`, `action ${i}`, `result ${i}`),
      });
    }

    const timeline = q.getExperienceTimeline.all({ id: 3 }) as any[];
    expect(timeline.length).toBeGreaterThanOrEqual(1);
    // All should have snippet field
    timeline.forEach((t: any) => {
      expect(t.snippet).toBeDefined();
    });
  });
});

// ═══════════════════════════════════════════════════════
// PHASE 6: TEMPORAL DECAY
// ═══════════════════════════════════════════════════════

describe("temporal decay (Phase 6)", () => {
  it("initial confidence is 0.3", () => {
    q.upsertPreference.run({ key: "test_pref", value: "val", confidence: 0.3, source: "test", scope: "global" });

    const pref = db.prepare("SELECT * FROM preferences WHERE key = 'test_pref'").get() as any;
    expect(pref.confidence).toBe(0.3);
    expect(pref.confirmed_count).toBe(1);
  });

  it("re-confirmation increases confidence with formula", () => {
    q.upsertPreference.run({ key: "confirmed_pref", value: "val", confidence: 0.3, source: "test", scope: "global" });
    q.upsertPreference.run({ key: "confirmed_pref", value: "val", confidence: 0.3, source: "test", scope: "global" });
    q.upsertPreference.run({ key: "confirmed_pref", value: "val", confidence: 0.3, source: "test", scope: "global" });

    const pref = db.prepare("SELECT * FROM preferences WHERE key = 'confirmed_pref'").get() as any;
    // 1st insert: 0.3, count=1
    // 2nd upsert: MIN(1.0, 0.3 + 1*0.1) = 0.4, count=2
    // 3rd upsert: MIN(1.0, 0.3 + 2*0.1) = 0.5, count=3
    expect(pref.confidence).toBe(0.5);
    expect(pref.confirmed_count).toBe(3);
  });

  it("decay factor is correct for different time periods", () => {
    // Recent: no decay
    expect(computeDecayFactor(new Date().toISOString().replace("Z", ""))).toBe(1.0);

    // 60 days ago: 0.9 decay
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().replace("Z", "");
    expect(computeDecayFactor(sixtyDaysAgo)).toBe(0.9);

    // 120 days ago: 0.7 decay
    const oneHundredTwentyDaysAgo = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString().replace("Z", "");
    expect(computeDecayFactor(oneHundredTwentyDaysAgo)).toBe(0.7);

    // 200 days ago: 0.5 decay
    const twoHundredDaysAgo = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString().replace("Z", "");
    expect(computeDecayFactor(twoHundredDaysAgo)).toBe(0.5);

    // Null: 0.5 decay
    expect(computeDecayFactor(null)).toBe(0.5);
  });

  it("getMergedPreferences includes effective_confidence with decay", () => {
    q.upsertPreference.run({ key: "recent_pref", value: "val", confidence: 0.3, source: "test", scope: "global" });

    const merged = q.getMergedPreferences("some-project");
    const pref = merged.find((p: any) => p.key === "recent_pref");
    expect(pref).toBeTruthy();
    expect(pref.effective_confidence).toBeDefined();
    expect(pref.decay_factor).toBeDefined();
    // Recently created, so decay should be 1.0
    expect(pref.decay_factor).toBe(1.0);
    expect(pref.effective_confidence).toBe(0.3); // 0.3 * 1.0
  });
});

describe("scoring", () => {
  it("successful and recent experience comes first", () => {
    q.insertExperience.run({
      type: "experience", context: "error en typescript module resolution",
      action: "intente fix", result: "no funciono", success: 0, tags: "typescript", project: "",
      normalized_hash: computeHash("error en typescript module resolution", "intente fix", "no funciono"),
    });
    q.insertExperience.run({
      type: "experience", context: "error en typescript path aliases",
      action: "configure tsconfig paths", result: "resuelto", success: 1, tags: "typescript", project: "",
      normalized_hash: computeHash("error en typescript path aliases", "configure tsconfig paths", "resuelto"),
    });

    const results = q.searchExperiences.all({ query: "typescript", limit: 10 }) as any[];
    expect(results).toHaveLength(2);
    expect(results[0].success).toBe(1);
  });
});
