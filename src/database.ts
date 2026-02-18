import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "data", "memory.db");

const db = new Database(DB_PATH);

// WAL mode = mejor rendimiento para lecturas concurrentes
db.pragma("journal_mode = WAL");

// ── Esquema ──────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS experiences (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    type        TEXT NOT NULL,       -- 'experience' | 'correction' | 'insight'
    context     TEXT,                -- qué estaba pasando
    action      TEXT,                -- qué se hizo
    result      TEXT,                -- qué pasó
    success     INTEGER DEFAULT 1,   -- 1 = fue bien, 0 = falló
    tags        TEXT DEFAULT '',     -- tags separados por coma
    project     TEXT DEFAULT '',     -- proyecto relacionado
    created_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS patterns (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    description TEXT NOT NULL,
    category    TEXT DEFAULT '',      -- 'error', 'success', 'workflow', etc.
    frequency   INTEGER DEFAULT 1,
    examples    TEXT DEFAULT '[]',    -- JSON array de ejemplos
    last_seen   TEXT DEFAULT (datetime('now'))
  );
`);

// ── Migración: preferences con scope ────────────────────
// Si la tabla existe sin scope, migrarla. Si no existe, crearla nueva.

const tableInfo = db.prepare(`PRAGMA table_info(preferences)`).all() as any[];
const hasScope = tableInfo.some((col: any) => col.name === "scope");

if (tableInfo.length === 0) {
  // Tabla no existe, crearla con scope desde el inicio
  db.exec(`
    CREATE TABLE preferences (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      key         TEXT NOT NULL,
      value       TEXT NOT NULL,
      confidence  REAL DEFAULT 0.5,
      source      TEXT DEFAULT '',
      scope       TEXT DEFAULT 'global',  -- 'global' o ruta del proyecto
      updated_at  TEXT DEFAULT (datetime('now')),
      UNIQUE(key, scope)
    );
  `);
} else if (!hasScope) {
  // Tabla existe pero sin scope, migrar
  db.exec(`
    ALTER TABLE preferences ADD COLUMN scope TEXT DEFAULT 'global';
  `);
  // Recrear el índice UNIQUE para incluir scope
  // SQLite no permite modificar constraints, así que recreamos la tabla
  db.exec(`
    CREATE TABLE preferences_new (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      key         TEXT NOT NULL,
      value       TEXT NOT NULL,
      confidence  REAL DEFAULT 0.5,
      source      TEXT DEFAULT '',
      scope       TEXT DEFAULT 'global',
      updated_at  TEXT DEFAULT (datetime('now')),
      UNIQUE(key, scope)
    );
    INSERT INTO preferences_new (id, key, value, confidence, source, scope, updated_at)
      SELECT id, key, value, confidence, source, COALESCE(scope, 'global'), updated_at FROM preferences;
    DROP TABLE preferences;
    ALTER TABLE preferences_new RENAME TO preferences;
  `);
}

// ── FTS5: Búsqueda de texto completo ────────────────────

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
`);

// ── Queries preparadas ──────────────────────────────────

export const insertExperience = db.prepare(`
  INSERT INTO experiences (type, context, action, result, success, tags, project)
  VALUES (@type, @context, @action, @result, @success, @tags, @project)
`);

export const searchExperiences = db.prepare(`
  SELECT e.* FROM experiences e
  JOIN experiences_fts fts ON e.id = fts.rowid
  WHERE experiences_fts MATCH @query
  ORDER BY rank
  LIMIT @limit
`);

export const searchExperiencesByProject = db.prepare(`
  SELECT e.* FROM experiences e
  JOIN experiences_fts fts ON e.id = fts.rowid
  WHERE experiences_fts MATCH @query AND (e.project = @project OR e.project = '')
  ORDER BY rank
  LIMIT @limit
`);

export const getRecentExperiences = db.prepare(`
  SELECT * FROM experiences
  ORDER BY created_at DESC
  LIMIT @limit
`);

export const getExperiencesByType = db.prepare(`
  SELECT * FROM experiences
  WHERE type = @type
  ORDER BY created_at DESC
  LIMIT @limit
`);

// ── Preferences con scope ───────────────────────────────

export const upsertPreference = db.prepare(`
  INSERT INTO preferences (key, value, confidence, source, scope)
  VALUES (@key, @value, @confidence, @source, @scope)
  ON CONFLICT(key, scope) DO UPDATE SET
    value = @value,
    confidence = MIN(1.0, confidence + 0.1),
    source = @source,
    updated_at = datetime('now')
`);

// Devuelve preferencias globales
export const getGlobalPreferences = db.prepare(`
  SELECT * FROM preferences
  WHERE scope = 'global'
  ORDER BY confidence DESC
`);

// Devuelve preferencias de un proyecto específico
export const getProjectPreferences = db.prepare(`
  SELECT * FROM preferences
  WHERE scope = @scope
  ORDER BY confidence DESC
`);

// Devuelve preferencias combinadas: proyecto + globales (proyecto tiene prioridad)
export function getMergedPreferences(project: string) {
  const global = getGlobalPreferences.all() as any[];
  const projectPrefs = getProjectPreferences.all({ scope: project }) as any[];

  // Proyecto sobreescribe global
  const merged = new Map<string, any>();
  for (const pref of global) {
    merged.set(pref.key, { ...pref, _origin: "global" });
  }
  for (const pref of projectPrefs) {
    merged.set(pref.key, { ...pref, _origin: "project" });
  }

  return Array.from(merged.values()).sort((a, b) => b.confidence - a.confidence);
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

// ── Stats ───────────────────────────────────────────────

export const getStats = () => {
  const experiences = (db.prepare(`SELECT COUNT(*) as count FROM experiences`).get() as any).count;
  const corrections = (db.prepare(`SELECT COUNT(*) as count FROM experiences WHERE type = 'correction'`).get() as any).count;
  const globalPrefs = (db.prepare(`SELECT COUNT(*) as count FROM preferences WHERE scope = 'global'`).get() as any).count;
  const projectPrefs = (db.prepare(`SELECT COUNT(*) as count FROM preferences WHERE scope != 'global'`).get() as any).count;
  const patterns = (db.prepare(`SELECT COUNT(*) as count FROM patterns`).get() as any).count;

  return { experiences, corrections, globalPrefs, projectPrefs, patterns };
};

export default db;
