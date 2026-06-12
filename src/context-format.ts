/**
 * context-format.ts - Shared formatting helpers for memory context output.
 *
 * Used by the socket server (session_start), the CLI fallback (get_context)
 * and the get_preferences tool. Produces a compact index with hard character
 * budgets instead of a full dump: details are retrieved on demand via the
 * MCP tools (get_preferences, query_memory, get_memory).
 *
 * Pure module (no database imports) so it can be unit-tested in isolation.
 */

// ── Budgets and limits ───────────────────────────────────

/** Hard character budget for the session_start context. */
export const SESSION_CONTEXT_BUDGET = 4000;

/** Max preferences listed in the session index. */
export const SESSION_MAX_PREFS = 12;

/** Max preferences shown at full length (pinned) in the session index. */
export const SESSION_MAX_PINNED = 3;

/** Effective confidence at or above which a preference is pinned. */
export const PINNED_CONFIDENCE = 0.9;

/** Max chars for a non-pinned preference value in the session index. */
export const SESSION_PREF_VALUE_MAX = 120;

/** Max words per index line (experiences, patterns, corrections). */
export const LINE_MAX_WORDS = 15;

/** Hard character budget for the get_preferences tool output. */
export const PREFS_OUTPUT_BUDGET = 6000;

/** Max chars for a preference value in get_preferences output. */
export const PREF_VALUE_MAX = 140;

/** Default max preferences returned by get_preferences. */
export const PREFS_DEFAULT_LIMIT = 15;

/** Default minimum effective confidence for get_preferences. */
export const PREFS_DEFAULT_MIN_CONFIDENCE = 0.4;

/**
 * Floor for AUTOMATIC outputs (session_start, on-prompt injection,
 * CLI get_context): preferences whose effective confidence (after decay)
 * falls below this value are excluded. They remain accessible through
 * explicit retrieval (get_preferences with key= or all=true).
 */
export const AUTO_MIN_EFFECTIVE_CONFIDENCE = 0.3;

// ── Types ────────────────────────────────────────────────

export interface PrefEntry {
  key: string;
  value: string;
  confidence?: number;
  effective_confidence?: number;
  scope?: string;
  _origin?: string;
}

export interface ExpEntry {
  id: number;
  type: string;
  context?: string;
  result?: string;
}

export interface PatternEntry {
  frequency: number;
  description: string;
}

export interface CorrectionEntry {
  id: number;
  result?: string;
}

export interface PreferenceOptions {
  limit?: number;
  minEffectiveConfidence?: number;
}

// ── Generic helpers ──────────────────────────────────────

/** Truncate text to max chars, appending an ellipsis when cut. */
export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

/** Collapse whitespace and limit text to a number of words. */
export function limitWords(text: string, maxWords: number = LINE_MAX_WORDS): string {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  if (words.length <= maxWords) return words.join(" ");
  return words.slice(0, maxWords).join(" ") + "…";
}

function effectiveConfidence(pref: PrefEntry): number {
  return pref.effective_confidence ?? pref.confidence ?? 0;
}

/** Apply limit / minimum effective confidence to a sorted preference list. */
export function applyPreferenceOptions<T extends PrefEntry>(
  prefs: T[],
  options?: PreferenceOptions
): T[] {
  let out = prefs;
  if (options?.minEffectiveConfidence !== undefined) {
    const min = options.minEffectiveConfidence;
    out = out.filter((p) => effectiveConfidence(p) >= min);
  }
  if (options?.limit !== undefined) {
    out = out.slice(0, options.limit);
  }
  return out;
}

// ── Session index (session_start hook + CLI get_context) ─

export interface SessionIndexParams {
  project: string;
  source: string;
  prefs: PrefEntry[]; // already merged + decayed + sorted by effective confidence
  experiences: ExpEntry[];
  patterns: PatternEntry[];
  corrections: CorrectionEntry[];
}

/**
 * Compact index for session start. One line per item, hard budget of
 * SESSION_CONTEXT_BUDGET chars; items that do not fit are summarized as
 * "(+N more via query_memory)".
 */
export function formatSessionIndex(params: SessionIndexParams): string {
  const header = [
    `## Agent Memory Index (auto-injected via hook)`,
    `Project: ${params.project || "(unknown)"} | Source: ${params.source}`,
    `Details on demand: get_preferences / query_memory / get_memory(ids).`,
    ``,
  ];

  const body: string[] = [];

  if (params.prefs.length > 0) {
    const top = params.prefs.slice(0, SESSION_MAX_PREFS);
    body.push(`### Preferences (top ${top.length} of ${params.prefs.length})`);
    let pinnedUsed = 0;
    for (const p of top) {
      const eff = effectiveConfidence(p);
      const pinned = eff >= PINNED_CONFIDENCE && pinnedUsed < SESSION_MAX_PINNED;
      if (pinned) pinnedUsed++;
      const value = pinned ? p.value : truncateText(p.value, SESSION_PREF_VALUE_MAX);
      body.push(`- ${p.key}: ${value} (${eff.toFixed(1)})`);
    }
    body.push(``);
  }

  if (params.experiences.length > 0) {
    body.push(`### Experiences`);
    for (const e of params.experiences) {
      const summary = limitWords(`${e.context || ""} -> ${e.result || ""}`);
      body.push(`- [${e.type}] ${summary} (#${e.id})`);
    }
    body.push(``);
  }

  if (params.patterns.length > 0) {
    body.push(`### Patterns`);
    for (const p of params.patterns) {
      body.push(`- [x${p.frequency}] ${limitWords(p.description)}`);
    }
    body.push(``);
  }

  if (params.corrections.length > 0) {
    body.push(`### Corrections`);
    for (const c of params.corrections) {
      body.push(`- ${limitWords(c.result || "")} (#${c.id})`);
    }
    body.push(``);
  }

  // Hard budget: append line by line, reserving room for the overflow note.
  const out = [...header];
  let used = out.join("\n").length;
  let omitted = 0;
  let cut = false;
  const reserve = 40; // room for the "(+N more ...)" line
  for (const line of body) {
    if (!cut && used + line.length + 1 <= SESSION_CONTEXT_BUDGET - reserve) {
      out.push(line);
      used += line.length + 1;
    } else {
      cut = true;
      if (line.startsWith("- ")) omitted++;
    }
  }
  if (omitted > 0) out.push(`(+${omitted} more via query_memory)`);

  return out.join("\n").replace(/\n+$/, "");
}

/**
 * Minimal reminder used after compaction or /clear: the conversation summary
 * already preserves the working context, so a full dump would be redundant.
 */
export function formatMinimalContext(params: {
  project: string;
  source: string;
  prefCount: number;
  expCount: number;
}): string {
  return [
    `## Agent Memory (${params.source})`,
    `Persistent memory active for project ${params.project || "(unknown)"}: ${params.prefCount} preferences, ${params.expCount} experiences stored.`,
    `Use get_preferences / query_memory to retrieve details if the summary above is missing something.`,
  ].join("\n");
}

// ── get_memory output (batch experience detail) ──────────

/** Max ids served per get_memory call. */
export const GET_MEMORY_MAX_IDS = 20;

export interface ExperienceDetail {
  id: number;
  type: string;
  success: number;
  project?: string;
  tags?: string;
  created_at?: string;
  topic_key?: string;
  revision_count?: number;
  duplicate_count?: number;
  context?: string;
  action?: string;
  result?: string;
}

/** Full detail block for one experience. */
export function formatExperienceDetail(exp: ExperienceDetail): string {
  const extra =
    `${exp.topic_key ? `Topic:      ${exp.topic_key}\n` : ""}` +
    `${(exp.revision_count ?? 1) > 1 ? `Revisions:  ${exp.revision_count}\n` : ""}` +
    `${(exp.duplicate_count ?? 1) > 1 ? `Duplicates: ${exp.duplicate_count}\n` : ""}`;
  return `=== Experience #${exp.id} ===
Type:       ${exp.type}
Success:    ${exp.success ? "Yes" : "No"}
Project:    ${exp.project || "(global)"}
Tags:       ${exp.tags || "(none)"}
Created:    ${exp.created_at}
${extra}
Context:    ${exp.context}
Action:     ${exp.action}
Result:     ${exp.result}`;
}

export interface TimelineRow {
  id: number;
  type: string;
  created_at: string;
  success: number;
  snippet?: string;
}

/** Compact +-1h timeline block around an experience. */
export function formatTimeline(rows: TimelineRow[], aroundId: number): string {
  if (rows.length === 0) return "";
  const lines = rows.map((r) => {
    const marker = r.id === aroundId ? " <<<" : "";
    return `[${r.created_at}] #${r.id} [${r.type}] ${r.success ? "OK" : "FAIL"} | ${r.snippet || ""}${marker}`;
  });
  return `--- Timeline around #${aroundId} (+-1 hour) ---\n${lines.join("\n")}`;
}

/**
 * Assemble the get_memory batch output: one detail block per found
 * experience (each optionally followed by its timeline) plus a note for
 * ids that were not found.
 */
export function formatMemoryBatch(params: {
  blocks: string[];
  missingIds: number[];
}): string {
  const parts = [...params.blocks];
  if (params.missingIds.length > 0) {
    parts.push(`Not found (deleted or invalid ids): ${params.missingIds.map((id) => `#${id}`).join(", ")}`);
  }
  if (parts.length === 0) return "No memories found for the requested ids.";
  return parts.join("\n\n");
}

// ── get_preferences output ───────────────────────────────

/**
 * Format the get_preferences listing with value truncation and a hard
 * character budget. `prefs` is the filtered list (limit + min confidence
 * already applied); `totalCount` is the size before filtering.
 */
export function formatPreferencesOutput(params: {
  label: string;
  prefs: PrefEntry[];
  totalCount: number;
}): string {
  const header = `${params.label}:`;
  const lines: string[] = [];
  let used = header.length + 2;
  let shown = 0;
  const reserve = 80; // room for the trailing notes

  for (const p of params.prefs) {
    const eff = effectiveConfidence(p);
    const origin = p._origin === "project" ? " [project]" : "";
    const line = `- ${p.key}: "${truncateText(p.value, PREF_VALUE_MAX)}" (${eff.toFixed(1)})${origin}`;
    if (used + line.length + 1 > PREFS_OUTPUT_BUDGET - reserve) break;
    lines.push(line);
    used += line.length + 1;
    shown++;
  }

  const out = [header, ``, ...lines];

  const cutByBudget = params.prefs.length - shown;
  if (cutByBudget > 0) {
    out.push(`(+${cutByBudget} more, raise limit or pass all=true)`);
  }

  const filteredOut = params.totalCount - params.prefs.length;
  if (filteredOut > 0) {
    out.push(
      `(${filteredOut} more below limit/confidence threshold — raise limit, pass all=true, or fetch one with key="name")`
    );
  }

  return out.join("\n");
}
