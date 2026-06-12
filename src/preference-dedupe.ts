/**
 * preference-dedupe.ts - Semantic deduplication helpers for preferences.
 *
 * Detects preferences that say the same thing under different keys by
 * comparing their embeddings (cosine similarity). Used in two places:
 *   - learn_preference (write path): before creating a new key, merge the
 *     candidate into an existing near-duplicate preference of the same scope.
 *   - consolidate (CLI maintenance): detect near-duplicate pairs across the
 *     whole table and invalidate the weaker one.
 *
 * Cheap by design: embeddings + a similarity rule, no LLM calls. All
 * functions take the database handle as a parameter so they can be tested
 * against temporary databases (production code passes the singleton from
 * database.ts).
 */

import type BetterSqlite3 from "better-sqlite3";

/** Cosine similarity above which two preferences are considered duplicates. */
export const PREF_SIMILARITY_THRESHOLD = 0.85;

// ── Embedding helpers ────────────────────────────────────

/** Canonical text used to embed a preference (same format everywhere). */
export function preferenceEmbeddingText(key: string, value: string): string {
  const keyWords = key.replace(/_/g, " ");
  return `user preference ${keyWords}: ${value}`;
}

/** Convert a sqlite-vec float32 BLOB back into a Float32Array. */
export function blobToVector(blob: Buffer): Float32Array {
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
}

/** Plain cosine similarity in [-1, 1]. Returns 0 for zero-length vectors. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Load all stored preference vectors keyed by preference id. */
export function loadPreferenceVectors(db: BetterSqlite3.Database): Map<number, Float32Array> {
  const vectors = new Map<number, Float32Array>();
  try {
    const rows = db
      .prepare(`SELECT preference_id, embedding FROM vec_preferences`)
      .all() as { preference_id: number | bigint; embedding: Buffer }[];
    for (const row of rows) {
      vectors.set(Number(row.preference_id), blobToVector(row.embedding));
    }
  } catch {
    // vec_preferences missing (sqlite-vec unavailable): no vectors
  }
  return vectors;
}

// ── Write-path dedupe (learn_preference) ─────────────────

export interface SimilarPreference {
  id: number;
  key: string;
  value: string;
  confidence: number;
  similarity: number;
}

/**
 * Find the most similar ACTIVE preference of the same scope, excluding the
 * candidate's own key and invalidated rows. Returns null when there is
 * nothing to compare against (no other prefs or no stored vectors).
 */
export function findMostSimilarPreference(
  db: BetterSqlite3.Database,
  params: { scope: string; excludeKey: string; embedding: Float32Array }
): SimilarPreference | null {
  const candidates = db
    .prepare(
      `SELECT id, key, value, confidence FROM preferences
       WHERE scope = @scope AND key != @excludeKey AND invalidated_at IS NULL`
    )
    .all({ scope: params.scope, excludeKey: params.excludeKey }) as {
    id: number;
    key: string;
    value: string;
    confidence: number;
  }[];
  if (candidates.length === 0) return null;

  const vectors = loadPreferenceVectors(db);
  let best: SimilarPreference | null = null;
  for (const pref of candidates) {
    const vector = vectors.get(pref.id);
    if (!vector) continue;
    const similarity = cosineSimilarity(params.embedding, vector);
    if (!best || similarity > best.similarity) {
      best = { ...pref, similarity };
    }
  }
  return best;
}

/**
 * Merge a candidate value into an existing preference: bump confidence with
 * the same formula the upsert uses, refresh last_confirmed_at, and replace
 * the value only when the new one is more complete (longer). Returns the
 * surviving key/value and whether the value changed (so the caller can
 * regenerate the stored embedding).
 */
export function mergeIntoExistingPreference(
  db: BetterSqlite3.Database,
  params: { id: number; newValue: string }
): { key: string; value: string; valueUpdated: boolean } {
  const existing = db
    .prepare(`SELECT id, key, value FROM preferences WHERE id = @id`)
    .get({ id: params.id }) as { id: number; key: string; value: string };

  const valueUpdated = params.newValue.length > existing.value.length;

  db.prepare(
    `UPDATE preferences
     SET value = CASE WHEN length(@value) > length(value) THEN @value ELSE value END,
         confidence = MIN(1.0, 0.3 + (confirmed_count + 1) * 0.1),
         confirmed_count = confirmed_count + 1,
         last_confirmed_at = datetime('now'),
         updated_at = datetime('now')
     WHERE id = @id`
  ).run({ id: params.id, value: params.newValue });

  return {
    key: existing.key,
    value: valueUpdated ? params.newValue : existing.value,
    valueUpdated,
  };
}

// ── Pair detection (consolidate command) ─────────────────

export interface PreferencePairMember {
  id: number;
  key: string;
  confidence: number;
  lastConfirmedAt: string | null;
}

export interface SimilarPreferencePair {
  scope: string;
  similarity: number;
  /** The preference that should be kept (higher confidence / more recent). */
  survivor: PreferencePairMember;
  /** The preference that should be invalidated, superseded by the survivor. */
  loser: PreferencePairMember;
}

function pickSurvivor(
  a: PreferencePairMember,
  b: PreferencePairMember
): [survivor: PreferencePairMember, loser: PreferencePairMember] {
  if (a.confidence !== b.confidence) {
    return a.confidence > b.confidence ? [a, b] : [b, a];
  }
  // Same confidence: the more recently confirmed one survives
  const aTime = a.lastConfirmedAt || "";
  const bTime = b.lastConfirmedAt || "";
  return aTime >= bTime ? [a, b] : [b, a];
}

/**
 * Detect pairs of active preferences within the same scope whose cosine
 * similarity exceeds the threshold. Pairs are returned sorted by similarity
 * (highest first). Preferences without a stored vector are skipped.
 */
export function findSimilarPreferencePairs(
  db: BetterSqlite3.Database,
  threshold: number = PREF_SIMILARITY_THRESHOLD
): SimilarPreferencePair[] {
  const prefs = db
    .prepare(
      `SELECT id, key, confidence, scope, last_confirmed_at FROM preferences
       WHERE invalidated_at IS NULL ORDER BY id ASC`
    )
    .all() as {
    id: number;
    key: string;
    confidence: number;
    scope: string;
    last_confirmed_at: string | null;
  }[];

  const vectors = loadPreferenceVectors(db);
  if (vectors.size === 0) return [];

  // Group by scope: cross-scope duplicates are intentional overrides
  const byScope = new Map<string, typeof prefs>();
  for (const pref of prefs) {
    if (!vectors.has(pref.id)) continue;
    const group = byScope.get(pref.scope) || [];
    group.push(pref);
    byScope.set(pref.scope, group);
  }

  const pairs: SimilarPreferencePair[] = [];
  for (const [scope, group] of byScope) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const similarity = cosineSimilarity(vectors.get(group[i].id)!, vectors.get(group[j].id)!);
        if (similarity <= threshold) continue;
        const a: PreferencePairMember = {
          id: group[i].id,
          key: group[i].key,
          confidence: group[i].confidence,
          lastConfirmedAt: group[i].last_confirmed_at,
        };
        const b: PreferencePairMember = {
          id: group[j].id,
          key: group[j].key,
          confidence: group[j].confidence,
          lastConfirmedAt: group[j].last_confirmed_at,
        };
        const [survivor, loser] = pickSurvivor(a, b);
        pairs.push({ scope, similarity, survivor, loser });
      }
    }
  }

  return pairs.sort((a, b) => b.similarity - a.similarity);
}
