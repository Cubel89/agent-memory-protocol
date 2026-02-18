import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";

// Helper: creates an in-memory DB with the full schema
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
      created_at  TEXT DEFAULT (datetime('now'))
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
      confidence  REAL DEFAULT 0.5,
      source      TEXT DEFAULT '',
      scope       TEXT DEFAULT 'global',
      updated_at  TEXT DEFAULT (datetime('now')),
      UNIQUE(key, scope)
    );

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

// Helper: prepares queries for a given DB
function prepareQueries(db: BetterSqlite3.Database) {
  const insertExperience = db.prepare(`
    INSERT INTO experiences (type, context, action, result, success, tags, project)
    VALUES (@type, @context, @action, @result, @success, @tags, @project)
  `);

  const searchExperiences = db.prepare(`
    SELECT e.*,
      bm25(experiences_fts) AS text_score,
      (1.0 / (1.0 + julianday('now') - julianday(e.created_at))) AS recency_score,
      CASE WHEN e.success = 1 THEN 1.0 ELSE 0.5 END AS success_score
    FROM experiences e
    JOIN experiences_fts fts ON e.id = fts.rowid
    WHERE experiences_fts MATCH @query
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
    ORDER BY (bm25(experiences_fts) * -1.0) * 0.5 + recency_score * 0.3 + success_score * 0.2 + project_bonus DESC
    LIMIT @limit
  `);

  const upsertPreference = db.prepare(`
    INSERT INTO preferences (key, value, confidence, source, scope)
    VALUES (@key, @value, @confidence, @source, @scope)
    ON CONFLICT(key, scope) DO UPDATE SET
      value = @value,
      confidence = MIN(1.0, confidence + 0.1),
      source = @source,
      updated_at = datetime('now')
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

  const deleteExperienceById = db.prepare(`DELETE FROM experiences WHERE id = @id`);
  const deleteExperiencesByTag = db.prepare(`DELETE FROM experiences WHERE tags LIKE '%' || @tag || '%'`);
  const deleteExperiencesByProject = db.prepare(`DELETE FROM experiences WHERE project = @project`);

  const pruneOldExperiences = db.prepare(`
    DELETE FROM experiences
    WHERE created_at < datetime('now', '-' || @days || ' days')
      AND (@only_failures = 0 OR success = 0)
  `);

  const pruneLowConfidencePreferences = db.prepare(`
    DELETE FROM preferences WHERE confidence < @min_confidence
  `);

  function getMergedPreferences(project: string) {
    const global = getGlobalPreferences.all() as any[];
    const projectPrefs = getProjectPreferences.all({ scope: project }) as any[];
    const merged = new Map<string, any>();
    for (const pref of global) merged.set(pref.key, { ...pref, _origin: "global" });
    for (const pref of projectPrefs) merged.set(pref.key, { ...pref, _origin: "project" });
    return Array.from(merged.values()).sort((a, b) => b.confidence - a.confidence);
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
    const experiences = (db.prepare(`SELECT COUNT(*) as count FROM experiences`).get() as any).count;
    const corrections = (db.prepare(`SELECT COUNT(*) as count FROM experiences WHERE type = 'correction'`).get() as any).count;
    const globalPrefs = (db.prepare(`SELECT COUNT(*) as count FROM preferences WHERE scope = 'global'`).get() as any).count;
    const projectPrefs = (db.prepare(`SELECT COUNT(*) as count FROM preferences WHERE scope != 'global'`).get() as any).count;
    const patterns = (db.prepare(`SELECT COUNT(*) as count FROM patterns`).get() as any).count;
    return { experiences, corrections, globalPrefs, projectPrefs, patterns };
  }

  return {
    insertExperience,
    searchExperiences,
    searchExperiencesByProject,
    upsertPreference,
    getGlobalPreferences,
    getProjectPreferences,
    getMergedPreferences,
    getPatterns,
    recordPattern,
    getStats,
    deleteExperienceById,
    deleteExperiencesByTag,
    deleteExperiencesByProject,
    pruneOldExperiences,
    pruneLowConfidencePreferences,
  };
}

// ── Tests ───────────────────────────────────────────────

let db: BetterSqlite3.Database;
let q: ReturnType<typeof prepareQueries>;

beforeEach(() => {
  db = createTestDb();
  q = prepareQueries(db);
});

describe("experiences", () => {
  it("inserts an experience and retrieves it", () => {
    q.insertExperience.run({
      type: "experience", context: "test context", action: "test action",
      result: "test result", success: 1, tags: "test", project: "",
    });
    const rows = db.prepare("SELECT * FROM experiences").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].context).toBe("test context");
    expect(rows[0].success).toBe(1);
  });

  it("searches via FTS and gets results", () => {
    q.insertExperience.run({
      type: "experience", context: "error en typescript imports",
      action: "fix imports", result: "resuelto", success: 1, tags: "typescript", project: "",
    });
    const results = q.searchExperiences.all({ query: "typescript", limit: 5 }) as any[];
    expect(results).toHaveLength(1);
    expect(results[0].context).toContain("typescript");
  });

  it("filters correctly when searching by project", () => {
    q.insertExperience.run({
      type: "experience", context: "bug en api", action: "fix",
      result: "ok", success: 1, tags: "api", project: "proyecto-a",
    });
    q.insertExperience.run({
      type: "experience", context: "bug en api diferente", action: "fix",
      result: "ok", success: 1, tags: "api", project: "proyecto-b",
    });

    const results = q.searchExperiencesByProject.all({
      query: "api", project: "proyecto-a", limit: 10,
    }) as any[];

    // Should only return proyecto-a (not proyecto-b)
    expect(results).toHaveLength(1);
    expect(results[0].project).toBe("proyecto-a");
  });

  it("FTS syncs after UPDATE (trigger au)", () => {
    q.insertExperience.run({
      type: "experience", context: "alpha unique keyword", action: "some action",
      result: "some result", success: 1, tags: "misc", project: "",
    });

    // Verify it's found by the original text
    const before = q.searchExperiences.all({ query: "alpha", limit: 5 }) as any[];
    expect(before).toHaveLength(1);

    // Update the context
    db.prepare("UPDATE experiences SET context = 'beta updated keyword' WHERE id = 1").run();

    // Search by the updated text
    const results = q.searchExperiences.all({ query: "beta", limit: 5 }) as any[];
    expect(results).toHaveLength(1);
    expect(results[0].context).toBe("beta updated keyword");

    // The original text should no longer appear in FTS
    const oldResults = q.searchExperiences.all({ query: "alpha", limit: 5 }) as any[];
    expect(oldResults).toHaveLength(0);
  });
});

describe("preferences", () => {
  it("upsert increments confidence", () => {
    q.upsertPreference.run({ key: "idioma", value: "es", confidence: 0.5, source: "test", scope: "global" });
    q.upsertPreference.run({ key: "idioma", value: "es", confidence: 0.5, source: "test", scope: "global" });

    const pref = db.prepare("SELECT * FROM preferences WHERE key = 'idioma'").get() as any;
    expect(pref.confidence).toBe(0.6);
  });

  it("merge preferences: project wins over global", () => {
    q.upsertPreference.run({ key: "framework", value: "react", confidence: 0.5, source: "test", scope: "global" });
    q.upsertPreference.run({ key: "framework", value: "vue", confidence: 0.5, source: "test", scope: "mi-proyecto" });

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
  it("returns correct counters", () => {
    q.insertExperience.run({
      type: "experience", context: "a", action: "b", result: "c",
      success: 1, tags: "", project: "",
    });
    q.insertExperience.run({
      type: "correction", context: "d", action: "e", result: "f",
      success: 0, tags: "", project: "",
    });
    q.upsertPreference.run({ key: "k1", value: "v1", confidence: 0.5, source: "", scope: "global" });
    q.upsertPreference.run({ key: "k2", value: "v2", confidence: 0.5, source: "", scope: "my-project" });
    q.recordPattern("p1", "test", "ex1");

    const stats = q.getStats();
    expect(stats.experiences).toBe(2);
    expect(stats.corrections).toBe(1);
    expect(stats.globalPrefs).toBe(1);
    expect(stats.projectPrefs).toBe(1);
    expect(stats.patterns).toBe(1);
  });
});

describe("forget_memory", () => {
  it("deletes by id only that record", () => {
    q.insertExperience.run({ type: "experience", context: "a", action: "b", result: "c", success: 1, tags: "x", project: "" });
    q.insertExperience.run({ type: "experience", context: "d", action: "e", result: "f", success: 1, tags: "y", project: "" });

    const result = q.deleteExperienceById.run({ id: 1 });
    expect(result.changes).toBe(1);

    const rows = db.prepare("SELECT * FROM experiences").all();
    expect(rows).toHaveLength(1);
  });

  it("deletes by tag matching records", () => {
    q.insertExperience.run({ type: "experience", context: "a", action: "b", result: "c", success: 1, tags: "typescript,bug", project: "" });
    q.insertExperience.run({ type: "experience", context: "d", action: "e", result: "f", success: 1, tags: "python", project: "" });
    q.insertExperience.run({ type: "experience", context: "g", action: "h", result: "i", success: 1, tags: "typescript,api", project: "" });

    const result = q.deleteExperiencesByTag.run({ tag: "typescript" });
    expect(result.changes).toBe(2);

    const rows = db.prepare("SELECT * FROM experiences").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].tags).toBe("python");
  });

  it("deletes by project all project records", () => {
    q.insertExperience.run({ type: "experience", context: "a", action: "b", result: "c", success: 1, tags: "", project: "proj-a" });
    q.insertExperience.run({ type: "experience", context: "d", action: "e", result: "f", success: 1, tags: "", project: "proj-b" });

    const result = q.deleteExperiencesByProject.run({ project: "proj-a" });
    expect(result.changes).toBe(1);

    const rows = db.prepare("SELECT * FROM experiences").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].project).toBe("proj-b");
  });
});

describe("prune_memory", () => {
  it("deletes old experiences by days", () => {
    // Insert an experience with an old date manually
    db.prepare(`
      INSERT INTO experiences (type, context, action, result, success, tags, project, created_at)
      VALUES ('experience', 'old', 'old action', 'old result', 1, '', '', datetime('now', '-100 days'))
    `).run();
    q.insertExperience.run({ type: "experience", context: "new", action: "new action", result: "new result", success: 1, tags: "", project: "" });

    const result = q.pruneOldExperiences.run({ days: 30, only_failures: 0 });
    expect(result.changes).toBe(1);

    const rows = db.prepare("SELECT * FROM experiences").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].context).toBe("new");
  });

  it("only_failures only deletes failed experiences", () => {
    db.prepare(`
      INSERT INTO experiences (type, context, action, result, success, tags, project, created_at)
      VALUES ('experience', 'old success', 'a', 'r', 1, '', '', datetime('now', '-100 days'))
    `).run();
    db.prepare(`
      INSERT INTO experiences (type, context, action, result, success, tags, project, created_at)
      VALUES ('experience', 'old failure', 'a', 'r', 0, '', '', datetime('now', '-100 days'))
    `).run();

    const result = q.pruneOldExperiences.run({ days: 30, only_failures: 1 });
    expect(result.changes).toBe(1);

    const rows = db.prepare("SELECT * FROM experiences").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].context).toBe("old success");
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

describe("scoring", () => {
  it("successful and recent experience comes first", () => {
    // Insert a failed experience
    q.insertExperience.run({
      type: "experience", context: "error en typescript module resolution",
      action: "intenté fix", result: "no funcionó", success: 0, tags: "typescript", project: "",
    });
    // Insert a successful experience (more recent by ID and created_at)
    q.insertExperience.run({
      type: "experience", context: "error en typescript path aliases",
      action: "configuré tsconfig paths", result: "resuelto", success: 1, tags: "typescript", project: "",
    });

    const results = q.searchExperiences.all({ query: "typescript", limit: 10 }) as any[];
    expect(results).toHaveLength(2);
    // The successful one should have a higher score (success_score = 1.0 vs 0.5)
    expect(results[0].success).toBe(1);
  });
});
