/**
 * telemetry.ts - Lightweight output-size telemetry.
 *
 * Records how many characters (and items) each retrieval channel returns:
 *   - session_start    (socket server + CLI get_context fallback)
 *   - on_prompt        (UserPromptSubmit injection, only when it injects)
 *   - get_preferences  (MCP tool output)
 *
 * One cheap INSERT per event, never on the critical path of correctness:
 * every write is wrapped in try/catch so telemetry can never break a
 * response. Summaries (avg / p95 chars per channel, ~tokens at chars/4)
 * are exposed through the memory_stats tool.
 *
 * Functions take the database handle as a parameter so they can be tested
 * against in-memory databases (same pattern as consolidate.ts).
 */

import type BetterSqlite3 from "better-sqlite3";

/** Days of history included in the telemetry summary. */
export const TELEMETRY_SUMMARY_DAYS = 30;

export interface TelemetryEntry {
  channel: string;
  project?: string;
  chars: number;
  items?: number;
}

export interface TelemetryChannelSummary {
  channel: string;
  count: number;
  avgChars: number;
  p95Chars: number;
  avgItems: number;
}

/** Create the telemetry table and index (idempotent). */
export function ensureTelemetryTable(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS telemetry (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      ts      TEXT DEFAULT (datetime('now')),
      channel TEXT NOT NULL,
      project TEXT DEFAULT '',
      chars   INTEGER NOT NULL,
      items   INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_telemetry_channel_ts ON telemetry(channel, ts);
  `);
}

/**
 * Record one telemetry event. Swallows every error: a failed telemetry
 * write must never break the response it is measuring.
 */
export function recordTelemetry(db: BetterSqlite3.Database, entry: TelemetryEntry): void {
  try {
    db.prepare(
      `INSERT INTO telemetry (channel, project, chars, items)
       VALUES (@channel, @project, @chars, @items)`
    ).run({
      channel: entry.channel,
      project: entry.project || "",
      chars: Math.max(0, Math.round(entry.chars)),
      items: Math.max(0, Math.round(entry.items ?? 0)),
    });
  } catch {
    /* telemetry is best-effort */
  }
}

/** p95 of a non-empty sorted-ascending numeric array (nearest-rank). */
function p95(sortedAsc: number[]): number {
  const idx = Math.max(0, Math.ceil(sortedAsc.length * 0.95) - 1);
  return sortedAsc[idx];
}

/**
 * Per-channel summary over the last `days` days: event count, average and
 * p95 of chars, average items. Returns [] when there is no data (or the
 * table is missing).
 */
export function summarizeTelemetry(
  db: BetterSqlite3.Database,
  days: number = TELEMETRY_SUMMARY_DAYS
): TelemetryChannelSummary[] {
  let rows: { channel: string; chars: number; items: number }[];
  try {
    rows = db
      .prepare(
        `SELECT channel, chars, items FROM telemetry
         WHERE ts >= datetime('now', '-' || @days || ' days')`
      )
      .all({ days }) as any[];
  } catch {
    return [];
  }

  const byChannel = new Map<string, { chars: number[]; items: number[] }>();
  for (const r of rows) {
    const bucket = byChannel.get(r.channel) || { chars: [], items: [] };
    bucket.chars.push(r.chars);
    bucket.items.push(r.items);
    byChannel.set(r.channel, bucket);
  }

  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

  return [...byChannel.entries()]
    .map(([channel, { chars, items }]) => {
      const sorted = [...chars].sort((a, b) => a - b);
      return {
        channel,
        count: chars.length,
        avgChars: Math.round(avg(chars)),
        p95Chars: p95(sorted),
        avgItems: Math.round(avg(items) * 10) / 10,
      };
    })
    .sort((a, b) => a.channel.localeCompare(b.channel));
}

/** Estimated tokens for a char count (rough heuristic: chars / 4). */
export function estimateTokens(chars: number): number {
  return Math.round(chars / 4);
}

/** Human-readable telemetry block for memory_stats. */
export function formatTelemetrySummary(
  summaries: TelemetryChannelSummary[],
  days: number = TELEMETRY_SUMMARY_DAYS
): string {
  if (summaries.length === 0) {
    return `Telemetry (last ${days} days): no data yet.`;
  }
  const lines = [`Telemetry (last ${days} days, tokens ~ chars/4):`];
  for (const s of summaries) {
    lines.push(
      `- ${s.channel}: ${s.count} events | avg ${s.avgChars} chars (~${estimateTokens(s.avgChars)} tokens)` +
        ` | p95 ${s.p95Chars} chars (~${estimateTokens(s.p95Chars)} tokens) | avg items ${s.avgItems}`
    );
  }
  return lines.join("\n");
}
