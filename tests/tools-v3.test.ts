/**
 * Tests for the v3 tool-surface consolidation and telemetry:
 *   - tool registration: 9 tools, get_experience/get_patterns/get_timeline gone
 *   - get_memory batch formatting (detail blocks, timeline, missing ids)
 *   - telemetry: record + 30-day summary (avg / p95 / items) + formatting
 *
 * The MCP entry point (src/index.ts) opens the production database singleton
 * at import time, so the registered tool surface is asserted against the
 * source instead of importing the module. Behavior is tested through the
 * pure helpers (context-format.ts) and the handle-passing telemetry module
 * against in-memory databases — same pattern as consolidate.ts tests.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";

const testDir = path.dirname(fileURLToPath(import.meta.url));

import {
  formatExperienceDetail,
  formatTimeline,
  formatMemoryBatch,
  GET_MEMORY_MAX_IDS,
} from "../src/context-format";

import {
  ensureTelemetryTable,
  recordTelemetry,
  summarizeTelemetry,
  formatTelemetrySummary,
  estimateTokens,
  TELEMETRY_SUMMARY_DAYS,
} from "../src/telemetry";

// ═══════════════════════════════════════════════════════
// Tool surface (src/index.ts registrations)
// ═══════════════════════════════════════════════════════

describe("v3 tool surface", () => {
  const source = readFileSync(path.join(testDir, "..", "src", "index.ts"), "utf8");
  const registered = [...source.matchAll(/server\.registerTool\(\s*"([^"]+)"/g)].map((m) => m[1]);

  it("registers exactly the 9 consolidated tools", () => {
    expect(registered.sort()).toEqual(
      [
        "forget_memory",
        "get_memory",
        "get_preferences",
        "learn_preference",
        "memory_stats",
        "prune_memory",
        "query_memory",
        "record_correction",
        "record_experience",
      ].sort()
    );
  });

  it("does not register the removed tools", () => {
    expect(registered).not.toContain("get_experience");
    expect(registered).not.toContain("get_patterns");
    expect(registered).not.toContain("get_timeline");
  });

  it("keeps the 5 protocol tool names untouched", () => {
    for (const name of [
      "get_preferences",
      "query_memory",
      "learn_preference",
      "record_experience",
      "record_correction",
    ]) {
      expect(registered).toContain(name);
    }
  });

  it("help texts no longer point to removed tools", () => {
    expect(source).not.toContain("get_experience(id)");
    expect(source).toContain("get_memory(ids)");
  });

  it("declares server instructions under 400 chars", () => {
    const match = source.match(/instructions:\s*\n([\s\S]*?)\n\s*\}\s*\n\);/);
    expect(match).toBeTruthy();
    // Extract the concatenated string literals
    const literals = [...match![1].matchAll(/"([^"]*)"/g)].map((m) => m[1]).join("");
    expect(literals.length).toBeGreaterThan(100);
    expect(literals.length).toBeLessThan(400);
    expect(literals).toContain("query_memory");
    expect(literals).toContain("get_memory");
  });
});

// ═══════════════════════════════════════════════════════
// get_memory batch formatting
// ═══════════════════════════════════════════════════════

describe("get_memory formatting helpers", () => {
  const exp = {
    id: 7,
    type: "gotcha",
    success: 0,
    project: "demo",
    tags: "sql,migration",
    created_at: "2026-06-01 10:00:00",
    topic_key: "arch:db",
    revision_count: 3,
    duplicate_count: 1,
    context: "migration failed on prod schema",
    action: "added missing column guard",
    result: "migration idempotent",
  };

  it("formatExperienceDetail renders the full detail block", () => {
    const out = formatExperienceDetail(exp);
    expect(out).toContain("=== Experience #7 ===");
    expect(out).toContain("Type:       gotcha");
    expect(out).toContain("Success:    No");
    expect(out).toContain("Topic:      arch:db");
    expect(out).toContain("Revisions:  3");
    expect(out).not.toContain("Duplicates:"); // duplicate_count = 1
    expect(out).toContain("Context:    migration failed on prod schema");
  });

  it("formatTimeline marks the anchor experience and is empty without rows", () => {
    const rows = [
      { id: 6, type: "experience", created_at: "2026-06-01 09:30:00", success: 1, snippet: "before" },
      { id: 7, type: "gotcha", created_at: "2026-06-01 10:00:00", success: 0, snippet: "anchor" },
    ];
    const out = formatTimeline(rows, 7);
    expect(out).toContain("Timeline around #7");
    expect(out).toContain("#7 [gotcha] FAIL | anchor <<<");
    expect(out).not.toContain("#6 [experience] OK | before <<<");
    expect(formatTimeline([], 7)).toBe("");
  });

  it("formatMemoryBatch joins blocks and reports missing ids", () => {
    const out = formatMemoryBatch({
      blocks: [formatExperienceDetail(exp), formatExperienceDetail({ ...exp, id: 8 })],
      missingIds: [99, 100],
    });
    expect(out).toContain("=== Experience #7 ===");
    expect(out).toContain("=== Experience #8 ===");
    expect(out).toContain("Not found (deleted or invalid ids): #99, #100");
  });

  it("formatMemoryBatch handles the all-missing case", () => {
    const out = formatMemoryBatch({ blocks: [], missingIds: [] });
    expect(out).toBe("No memories found for the requested ids.");
  });

  it("exposes a sane batch cap", () => {
    expect(GET_MEMORY_MAX_IDS).toBeGreaterThanOrEqual(10);
    expect(GET_MEMORY_MAX_IDS).toBeLessThanOrEqual(50);
  });
});

// ═══════════════════════════════════════════════════════
// Telemetry (record + summary + memory_stats block)
// ═══════════════════════════════════════════════════════

describe("telemetry", () => {
  let db: BetterSqlite3.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    ensureTelemetryTable(db);
  });

  it("records one row per event with channel, project, chars and items", () => {
    recordTelemetry(db, { channel: "session_start", project: "demo", chars: 1234, items: 10 });
    recordTelemetry(db, { channel: "on_prompt", chars: 300 });

    const rows = db.prepare(`SELECT channel, project, chars, items, ts FROM telemetry ORDER BY id`).all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ channel: "session_start", project: "demo", chars: 1234, items: 10 });
    expect(rows[1]).toMatchObject({ channel: "on_prompt", project: "", chars: 300, items: 0 });
    expect(rows[0].ts).toBeTruthy();
  });

  it("never throws when the table is missing (best-effort write)", () => {
    const bare = new Database(":memory:");
    expect(() => recordTelemetry(bare, { channel: "get_preferences", chars: 10 })).not.toThrow();
    expect(summarizeTelemetry(bare)).toEqual([]);
  });

  it("summarizes per channel: count, avg and p95 of chars, avg items", () => {
    // 20 session_start events: chars 100, 200, ..., 2000
    for (let i = 1; i <= 20; i++) {
      recordTelemetry(db, { channel: "session_start", chars: i * 100, items: i });
    }
    recordTelemetry(db, { channel: "get_preferences", chars: 500, items: 5 });

    const summary = summarizeTelemetry(db, 30);
    expect(summary).toHaveLength(2);

    const session = summary.find((s) => s.channel === "session_start")!;
    expect(session.count).toBe(20);
    expect(session.avgChars).toBe(1050); // mean of 100..2000
    expect(session.p95Chars).toBe(1900); // nearest-rank p95 of 20 values
    expect(session.avgItems).toBe(10.5);

    const prefs = summary.find((s) => s.channel === "get_preferences")!;
    expect(prefs).toMatchObject({ count: 1, avgChars: 500, p95Chars: 500, avgItems: 5 });
  });

  it("excludes events older than the summary window", () => {
    recordTelemetry(db, { channel: "on_prompt", chars: 100 });
    db.prepare(`UPDATE telemetry SET ts = datetime('now', '-45 days')`).run();
    recordTelemetry(db, { channel: "on_prompt", chars: 900 });

    const summary = summarizeTelemetry(db, TELEMETRY_SUMMARY_DAYS);
    expect(summary).toHaveLength(1);
    expect(summary[0].count).toBe(1);
    expect(summary[0].avgChars).toBe(900);
  });

  it("formats a summary block with token estimates (chars/4)", () => {
    recordTelemetry(db, { channel: "session_start", chars: 4000, items: 12 });
    const out = formatTelemetrySummary(summarizeTelemetry(db));
    expect(out).toContain("Telemetry (last 30 days");
    expect(out).toContain("session_start: 1 events");
    expect(out).toContain("avg 4000 chars (~1000 tokens)");
    expect(out).toContain("p95 4000 chars (~1000 tokens)");
    expect(estimateTokens(4000)).toBe(1000);
  });

  it("reports 'no data yet' when empty", () => {
    expect(formatTelemetrySummary(summarizeTelemetry(db))).toContain("no data yet");
  });
});
