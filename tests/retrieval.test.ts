import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";

import {
  MIN_PROMPT_RELEVANCE,
  MAX_PROMPT_MEMORIES,
  normalizeBm25,
  computeFtsScore,
  fuseScores,
  selectRelevant,
  clampSimilarity,
} from "../src/scoring";

import {
  SESSION_CONTEXT_BUDGET,
  SESSION_MAX_PREFS,
  SESSION_MAX_PINNED,
  SESSION_PREF_VALUE_MAX,
  PREFS_OUTPUT_BUDGET,
  PREF_VALUE_MAX,
  truncateText,
  limitWords,
  applyPreferenceOptions,
  formatSessionIndex,
  formatMinimalContext,
  formatPreferencesOutput,
} from "../src/context-format";

// ═══════════════════════════════════════════════════════
// Scoring (hybrid search fusion)
// ═══════════════════════════════════════════════════════

describe("scoring helpers", () => {
  it("clampSimilarity bounds values into [0, 1]", () => {
    expect(clampSimilarity(-0.5)).toBe(0);
    expect(clampSimilarity(0.42)).toBeCloseTo(0.42);
    expect(clampSimilarity(1.7)).toBe(1);
  });

  it("normalizeBm25 maps better (more negative) ranks to higher scores in [0, 1)", () => {
    const strong = normalizeBm25(-5);
    const weak = normalizeBm25(-0.5);
    expect(strong).toBeGreaterThan(weak);
    expect(strong).toBeLessThan(1);
    expect(weak).toBeGreaterThan(0);
    // Positive bm25 (should not happen in FTS5) yields 0
    expect(normalizeBm25(2)).toBe(0);
  });

  it("computeFtsScore is proportional to term coverage, not a flat bonus", () => {
    const fullMatch = computeFtsScore(-3, 3, 3);
    const partialMatch = computeFtsScore(-3, 1, 3);
    expect(fullMatch).toBeGreaterThan(partialMatch);
    expect(partialMatch).toBeCloseTo(fullMatch / 3, 5);
    expect(computeFtsScore(-3, 0, 3)).toBe(0);
    expect(computeFtsScore(-3, 1, 0)).toBe(0);
  });

  it("fuseScores produces an absolute score in [0, 1]", () => {
    expect(fuseScores(1, 1)).toBeCloseTo(1.0);
    expect(fuseScores(0, 0)).toBe(0);
    // Vector-only result
    expect(fuseScores(0.8, 0)).toBeCloseTo(0.56);
    // FTS-only result
    expect(fuseScores(0, 0.9)).toBeCloseTo(0.27);
  });

  it("a strong semantic match clears the threshold, a weak one does not", () => {
    const strong = fuseScores(0.75, 0.5); // 0.525 + 0.15 = 0.675
    const weak = fuseScores(0.2, 0.1); // 0.14 + 0.03 = 0.17
    expect(strong).toBeGreaterThanOrEqual(MIN_PROMPT_RELEVANCE);
    expect(weak).toBeLessThan(MIN_PROMPT_RELEVANCE);
  });
});

describe("selectRelevant (on-prompt threshold)", () => {
  it("returns empty when nothing clears the threshold", () => {
    const results = [
      { id: 1, score: MIN_PROMPT_RELEVANCE - 0.05, source: "experience" },
      { id: 2, score: 0.1, source: "preference" },
    ];
    expect(selectRelevant(results)).toHaveLength(0);
  });

  it("keeps results above the threshold, capped at MAX_PROMPT_MEMORIES", () => {
    const results = [
      { id: 1, score: 0.9 },
      { id: 2, score: 0.8 },
      { id: 3, score: 0.7 },
      { id: 4, score: 0.6 },
      { id: 5, score: 0.2 },
    ];
    const selected = selectRelevant(results);
    expect(selected).toHaveLength(MAX_PROMPT_MEMORIES);
    expect(selected.map((r) => r.id)).toEqual([1, 2, 3]);
  });
});

// ═══════════════════════════════════════════════════════
// Hybrid FTS scoring against a real FTS5 table
// (replicates the scored query used by hybridSearch)
// ═══════════════════════════════════════════════════════

describe("FTS scored query (hybridSearch FTS channel)", () => {
  let db: BetterSqlite3.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE experiences (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        context TEXT, action TEXT, result TEXT, tags TEXT DEFAULT '',
        deleted_at TEXT DEFAULT NULL
      );
      CREATE VIRTUAL TABLE experiences_fts USING fts5(
        context, action, result, tags, content=experiences, content_rowid=id
      );
      CREATE TRIGGER experiences_ai AFTER INSERT ON experiences BEGIN
        INSERT INTO experiences_fts(rowid, context, action, result, tags)
        VALUES (new.id, new.context, new.action, new.result, new.tags);
      END;
    `);
  });

  it("documents matching more query terms score higher than single-term matches", () => {
    const insert = db.prepare(
      `INSERT INTO experiences (context, action, result, tags) VALUES (?, ?, ?, ?)`
    );
    insert.run("flutter build error on android", "fixed gradle config", "build passes", "flutter");
    insert.run("random note about flutter widgets", "none", "nothing", "notes");

    const query = "flutter OR build OR error";
    const terms = query.split(" OR ").map((t) => t.toLowerCase());

    const rows = db.prepare(`
      SELECT e.id, bm25(experiences_fts) AS bm25_score,
        lower(coalesce(e.context, '') || ' ' || coalesce(e.action, '') || ' ' ||
              coalesce(e.result, '') || ' ' || coalesce(e.tags, '')) AS haystack
      FROM experiences e
      JOIN experiences_fts fts ON e.id = fts.rowid
      WHERE experiences_fts MATCH @query AND e.deleted_at IS NULL
      ORDER BY bm25(experiences_fts)
      LIMIT 10
    `).all({ query }) as any[];

    expect(rows).toHaveLength(2); // OR keeps recall: both match
    const scores = new Map<number, number>();
    for (const r of rows) {
      const matched = terms.filter((t) => r.haystack.includes(t)).length;
      scores.set(r.id, fuseScores(0, computeFtsScore(r.bm25_score, matched, terms.length)));
    }
    // Doc 1 matches all 3 terms, doc 2 matches only "flutter"
    expect(scores.get(1)!).toBeGreaterThan(scores.get(2)!);
    // No flat presence bonus: the weak match scores well below the strong one
    expect(scores.get(2)!).toBeLessThan(scores.get(1)! / 2);
  });
});

// ═══════════════════════════════════════════════════════
// Preference options (getMergedPreferences / get_preferences)
// ═══════════════════════════════════════════════════════

function makePrefs(n: number, opts?: { valueLength?: number }) {
  return Array.from({ length: n }, (_, i) => ({
    key: `pref_${i}`,
    value: "v".repeat(opts?.valueLength ?? 20),
    confidence: 0.9,
    effective_confidence: Math.round((0.9 - i * 0.01) * 100) / 100,
    scope: "global",
  }));
}

describe("applyPreferenceOptions", () => {
  it("returns everything unchanged without options (backwards compatible)", () => {
    const prefs = makePrefs(20);
    expect(applyPreferenceOptions(prefs)).toHaveLength(20);
    expect(applyPreferenceOptions(prefs, {})).toHaveLength(20);
  });

  it("applies limit after sorting", () => {
    const prefs = makePrefs(20);
    const limited = applyPreferenceOptions(prefs, { limit: 5 });
    expect(limited).toHaveLength(5);
    expect(limited[0].key).toBe("pref_0");
  });

  it("filters by minimum effective confidence", () => {
    const prefs = [
      { key: "high", value: "a", effective_confidence: 0.8 },
      { key: "mid", value: "b", effective_confidence: 0.4 },
      { key: "low", value: "c", effective_confidence: 0.2 },
    ];
    const filtered = applyPreferenceOptions(prefs, { minEffectiveConfidence: 0.4 });
    expect(filtered.map((p) => p.key)).toEqual(["high", "mid"]);
  });

  it("combines limit and min confidence", () => {
    const prefs = makePrefs(20); // effective from 0.9 down to 0.71
    const out = applyPreferenceOptions(prefs, { limit: 3, minEffectiveConfidence: 0.85 });
    expect(out.map((p) => p.key)).toEqual(["pref_0", "pref_1", "pref_2"]);
  });
});

describe("formatPreferencesOutput (get_preferences)", () => {
  it("truncates long values with an ellipsis", () => {
    const longValue = "x".repeat(300);
    const out = formatPreferencesOutput({
      label: "Global preferences",
      prefs: [{ key: "long_pref", value: longValue, effective_confidence: 0.5 }],
      totalCount: 1,
    });
    expect(out).toContain("…");
    expect(out).not.toContain(longValue);
    const line = out.split("\n").find((l) => l.startsWith("- long_pref"))!;
    expect(line.length).toBeLessThan(PREF_VALUE_MAX + 40);
  });

  it("shows reduced metadata: effective confidence with one decimal", () => {
    const out = formatPreferencesOutput({
      label: "Global preferences",
      prefs: [{ key: "k", value: "v", confidence: 0.78, effective_confidence: 0.55 }],
      totalCount: 1,
    });
    expect(out).toContain("(0.6)"); // 0.55 → one decimal
    expect(out).not.toContain("decay");
    expect(out).not.toContain("effective:");
  });

  it("stays within the hard budget and reports the cut", () => {
    const prefs = makePrefs(100, { valueLength: 200 });
    const out = formatPreferencesOutput({
      label: "Global preferences",
      prefs,
      totalCount: 100,
    });
    expect(out.length).toBeLessThanOrEqual(PREFS_OUTPUT_BUDGET);
    expect(out).toMatch(/\(\+\d+ more, raise limit or pass all=true\)/);
  });

  it("reports how many preferences were filtered out and how to see them", () => {
    const prefs = makePrefs(5);
    const out = formatPreferencesOutput({
      label: "Global preferences",
      prefs,
      totalCount: 40,
    });
    expect(out).toContain("35 more below limit/confidence threshold");
    expect(out).toContain("all=true");
  });
});

// ═══════════════════════════════════════════════════════
// Session index format (session_start hook + CLI fallback)
// ═══════════════════════════════════════════════════════

describe("formatSessionIndex", () => {
  it("lists at most SESSION_MAX_PREFS preferences with truncated values", () => {
    const prefs = makePrefs(30, { valueLength: 300 }).map((p) => ({
      ...p,
      effective_confidence: 0.5,
    }));
    const out = formatSessionIndex({
      project: "demo",
      source: "startup",
      prefs,
      experiences: [],
      patterns: [],
      corrections: [],
    });
    const prefLines = out.split("\n").filter((l) => l.startsWith("- pref_"));
    expect(prefLines.length).toBeLessThanOrEqual(SESSION_MAX_PREFS);
    for (const line of prefLines) {
      expect(line.length).toBeLessThan(SESSION_PREF_VALUE_MAX + 40);
      expect(line).toContain("…");
    }
    expect(out).toContain(`top ${SESSION_MAX_PREFS} of 30`);
  });

  it("pins high-confidence preferences at full length (max SESSION_MAX_PINNED)", () => {
    const longValue = "important full text preference ".repeat(6).trim(); // > 120 chars
    const prefs = [
      { key: "pinned_a", value: longValue, effective_confidence: 0.95 },
      { key: "pinned_b", value: longValue, effective_confidence: 0.93 },
      { key: "pinned_c", value: longValue, effective_confidence: 0.92 },
      { key: "pinned_d", value: longValue, effective_confidence: 0.91 },
      { key: "normal", value: longValue, effective_confidence: 0.5 },
    ];
    const out = formatSessionIndex({
      project: "demo",
      source: "startup",
      prefs,
      experiences: [],
      patterns: [],
      corrections: [],
    });
    const fullLines = out.split("\n").filter((l) => l.startsWith("- ") && !l.includes("…"));
    expect(fullLines).toHaveLength(SESSION_MAX_PINNED);
    // The 4th high-confidence pref exceeds the pinned quota → truncated
    const fourth = out.split("\n").find((l) => l.startsWith("- pinned_d"))!;
    expect(fourth).toContain("…");
  });

  it("formats experiences, patterns and corrections as one-line entries with ids", () => {
    const out = formatSessionIndex({
      project: "demo",
      source: "startup",
      prefs: [],
      experiences: [
        {
          id: 42,
          type: "experience",
          context: "a very long context that goes on and on and on with many many words beyond fifteen total words here",
          result: "it worked",
        },
      ],
      patterns: [{ frequency: 7, description: "always run the test suite before declaring success on any change at all whatsoever really" }],
      corrections: [{ id: 9, result: "use the wrapper instead of exiting the process directly" }],
    });
    const expLine = out.split("\n").find((l) => l.includes("(#42)"))!;
    expect(expLine).toBeTruthy();
    // <= 15 words plus type tag and id
    const words = expLine.replace(/\s+/g, " ").split(" ");
    expect(words.length).toBeLessThanOrEqual(19);
    expect(out).toContain("[x7]");
    expect(out).toContain("(#9)");
  });

  it("enforces the hard budget and reports omitted items", () => {
    const prefs = makePrefs(12, { valueLength: 119 }).map((p) => ({
      ...p,
      effective_confidence: 0.5,
    }));
    const experiences = Array.from({ length: 30 }, (_, i) => ({
      id: i + 1,
      type: "experience",
      context: "context word ".repeat(10),
      result: "result word ".repeat(10),
    }));
    const corrections = Array.from({ length: 3 }, (_, i) => ({
      id: 100 + i,
      result: "lesson learned ".repeat(8),
    }));
    const out = formatSessionIndex({
      project: "demo",
      source: "startup",
      prefs,
      experiences,
      patterns: [],
      corrections,
    });
    expect(out.length).toBeLessThanOrEqual(SESSION_CONTEXT_BUDGET);
    expect(out).toMatch(/\(\+\d+ more via query_memory\)/);
  });
});

describe("formatMinimalContext (post compact/clear)", () => {
  it("returns a short reminder with counts, not a dump", () => {
    const out = formatMinimalContext({
      project: "demo",
      source: "compact",
      prefCount: 78,
      expCount: 412,
    });
    const lines = out.split("\n");
    expect(lines.length).toBeLessThanOrEqual(3);
    expect(out).toContain("78 preferences");
    expect(out).toContain("412 experiences");
    expect(out).toContain("query_memory");
    expect(out.length).toBeLessThan(400);
  });
});

// ═══════════════════════════════════════════════════════
// Generic helpers
// ═══════════════════════════════════════════════════════

describe("text helpers", () => {
  it("truncateText keeps short text intact and cuts long text with ellipsis", () => {
    expect(truncateText("short", 140)).toBe("short");
    const cut = truncateText("a".repeat(200), 140);
    expect(cut.length).toBeLessThanOrEqual(140);
    expect(cut.endsWith("…")).toBe(true);
  });

  it("limitWords caps the number of words", () => {
    expect(limitWords("one two three", 5)).toBe("one two three");
    const out = limitWords("w ".repeat(30).trim(), 15);
    expect(out.split(" ")).toHaveLength(15);
    expect(out.endsWith("…")).toBe(true);
  });
});
