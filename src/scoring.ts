/**
 * scoring.ts - Pure scoring helpers for hybrid retrieval.
 *
 * Kept free of database imports so the fusion logic can be unit-tested
 * in isolation and reused by both the search layer and the socket server.
 */

/** Minimum fused score required to inject a memory into the prompt context. */
export const MIN_PROMPT_RELEVANCE = 0.4;

/** Maximum number of memories injected per user prompt. */
export const MAX_PROMPT_MEMORIES = 3;

/** Weight of the vector channel in the fused score. */
export const VECTOR_WEIGHT = 0.7;

/** Weight of the FTS channel in the fused score. */
export const FTS_WEIGHT = 0.3;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Clamp a cosine similarity (1 - cosine distance) into [0, 1]. */
export function clampSimilarity(value: number): number {
  return clamp01(value);
}

/**
 * Normalize an FTS5 bm25 rank into [0, 1).
 * FTS5 bm25() returns negative values where more negative = better match,
 * so relevance = -bm25 and we squash it with x / (x + 1).
 */
export function normalizeBm25(bm25: number): number {
  const relevance = Math.max(0, -bm25);
  return relevance / (relevance + 1);
}

/**
 * FTS signal proportional to how well the document matches the query:
 * term coverage (matched terms / total query terms) scaled by the
 * normalized BM25 rank. A document that matches a single term out of many
 * (the FTS query joins terms with OR for recall) gets a low score instead
 * of a flat "it appeared" bonus.
 */
export function computeFtsScore(bm25: number, matchedTerms: number, totalTerms: number): number {
  if (totalTerms <= 0) return 0;
  const coverage = clamp01(matchedTerms / totalTerms);
  return coverage * normalizeBm25(bm25);
}

/**
 * Fused absolute score in [0, 1]:
 *   score = VECTOR_WEIGHT * vectorSimilarity + FTS_WEIGHT * ftsScore
 * A channel that did not match contributes 0, so the result is an absolute
 * value comparable against MIN_PROMPT_RELEVANCE regardless of which
 * channels were available for a given row.
 */
export function fuseScores(vectorSimilarity: number, ftsScore: number): number {
  return VECTOR_WEIGHT * clamp01(vectorSimilarity) + FTS_WEIGHT * clamp01(ftsScore);
}

/**
 * Keep only results above the relevance threshold, capped at
 * MAX_PROMPT_MEMORIES. Used by the on-prompt injection path: when nothing
 * passes the threshold, nothing is injected.
 */
export function selectRelevant<T extends { score: number }>(results: T[]): T[] {
  return results
    .filter((r) => r.score >= MIN_PROMPT_RELEVANCE)
    .slice(0, MAX_PROMPT_MEMORIES);
}

// ── Temporal decay for preferences ───────────────────────

/**
 * Decay ladder for preference confidence, based on days since the
 * preference was last confirmed. There is NO floor: stale preferences
 * keep losing weight until they fall below AUTO_MIN_EFFECTIVE_CONFIDENCE
 * (see context-format.ts) and drop out of automatic outputs, while staying
 * reachable through explicit lookups (key= / all=true).
 *
 *   <= 30 days  -> 1.00   fresh, full confidence
 *   <= 90 days  -> 0.90
 *   <= 180 days -> 0.70
 *   <= 365 days -> 0.50   same value the old ladder used as its floor,
 *                         now bounded to one year
 *   <= 730 days -> 0.30   a never-reconfirmed pref at max confidence (1.0)
 *                         sits exactly on the automatic-output threshold
 *   >  730 days -> 0.15   hidden from automatic outputs at any confidence
 *
 * A null confirmation date means the age is unknown: treat it as
 * moderately stale (0.5) rather than fresh or ancient.
 */
export function computeDecayFactor(lastConfirmedAt: string | null, nowMs: number = Date.now()): number {
  if (!lastConfirmedAt) return 0.5;
  const confirmed = new Date(lastConfirmedAt + "Z").getTime();
  const daysSince = (nowMs - confirmed) / (1000 * 60 * 60 * 24);

  if (daysSince <= 30) return 1.0;
  if (daysSince <= 90) return 0.9;
  if (daysSince <= 180) return 0.7;
  if (daysSince <= 365) return 0.5;
  if (daysSince <= 730) return 0.3;
  return 0.15;
}

/** Attach effective_confidence (confidence * decay) and decay_factor to a preference row. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyDecay(pref: any): any {
  const decay = computeDecayFactor(pref.last_confirmed_at);
  const effectiveConfidence = Math.round(pref.confidence * decay * 100) / 100;
  return {
    ...pref,
    effective_confidence: effectiveConfidence,
    decay_factor: decay,
  };
}
