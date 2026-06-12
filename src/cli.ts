#!/usr/bin/env node
/**
 * cli.ts - CLI wrapper for agent-memory-protocol
 *
 * Used by the Claude Code hooks to record experiences, corrections and
 * preferences, and to capture session context. Shares database.ts with the
 * MCP server.
 *
 * Usage:
 *   node cli.js <command> --param value ...
 *   echo '{"param": "value"}' | node cli.js <command>
 *
 * Commands:
 *   auto_capture       Records tool usage (post-tool-use hook)
 *   get_context        Returns additionalContext JSON (session-start hook)
 *   session_summary    Records a session summary (session-end hook)
 *   consolidate        Offline maintenance: dedupe preferences, purge old
 *                      soft-deleted rows, clean orphans, VACUUM.
 *                      Dry-run by default; pass --apply to execute.
 */

import db, {
  insertOrDeduplicate,
  getMergedPreferences,
  getRecentExperiences,
  getExperiencesByType,
  getPatterns,
  getStats,
  checkpoint,
} from "./database.js";
import { recordTelemetry } from "./telemetry.js";
import {
  formatSessionIndex,
  formatMinimalContext,
  AUTO_MIN_EFFECTIVE_CONFIDENCE,
} from "./context-format.js";
import { runConsolidation, formatConsolidationReport } from "./consolidate.js";

// ── CLI argument parsing ────────────────────────────────

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 3; i < argv.length; i++) {
    const key = argv[i];
    if (key.startsWith("--")) {
      const name = key.slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : "true";
      args[name] = value;
      if (value !== "true") i++;
    }
  }
  return args;
}

// ── Read stdin when not a TTY ───────────────────────────

async function readStdin(): Promise<Record<string, any>> {
  if (process.stdin.isTTY) return {};
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
    process.stdin.on("error", () => resolve({}));
  });
}

// ── Main ─────────────────────────────────────────────────

async function main() {
  const command = process.argv[2];
  const cliArgs = parseArgs(process.argv);
  const stdinData = await readStdin();

  // CLI args take priority over stdin
  const params: Record<string, any> = { ...stdinData, ...cliArgs };

  switch (command) {

    // Used by post-tool-use.sh
    case "auto_capture": {
      const context = params.context || "";
      if (!context) {
        console.log(JSON.stringify({ ok: true, skipped: true }));
        break;
      }
      const { id, deduplicated } = await insertOrDeduplicate({
        type: "auto_capture",
        context,
        action: "tool_use",
        result: params.tool || "",
        success: 1,
        tags: "auto,hook",
        project: params.project || "",
      });
      checkpoint();
      console.log(JSON.stringify({ ok: true, id, deduplicated }));
      break;
    }

    // Used by session-start.sh (socket-less fallback — same index format)
    case "get_context": {
      const project = params.project || "";
      const source = params.source || "startup";

      // Automatic output: apply the effective-confidence floor
      const prefs = getMergedPreferences(project, {
        minEffectiveConfidence: AUTO_MIN_EFFECTIVE_CONFIDENCE,
      });

      // After compaction or /clear: minimal reminder, not the full dump
      if (source === "compact" || source === "clear") {
        const stats = getStats();
        const contextText = formatMinimalContext({
          project,
          source,
          prefCount: prefs.length,
          expCount: stats.experiences,
        });
        recordTelemetry(db, { channel: "session_start", project, chars: contextText.length, items: 0 });
        console.log(JSON.stringify({ additionalContext: contextText }));
        break;
      }

      const allExp = getRecentExperiences.all({ limit: 20 }) as any[];
      const recentExp = allExp
        .filter((e) => !["auto_capture", "session_summary"].includes(e.type))
        .slice(0, 5);
      const topPatterns = getPatterns.all({ limit: 3 }) as any[];
      const corrections = getExperiencesByType.all({ type: "correction", limit: 3 }) as any[];

      const contextText = formatSessionIndex({
        project,
        source,
        prefs,
        experiences: recentExp,
        patterns: topPatterns,
        corrections,
      });
      recordTelemetry(db, {
        channel: "session_start",
        project,
        chars: contextText.length,
        items: prefs.length + recentExp.length + topPatterns.length + corrections.length,
      });

      console.log(JSON.stringify({ additionalContext: contextText }));
      break;
    }

    // Used by session-end.sh
    case "session_summary": {
      const project = params.project || "";
      const count = parseInt(params.count || "0", 10);
      if (count > 0) {
        const summary = `Session ended. ${count} tool actions captured for project ${project}.`;
        insertOrDeduplicate({
          type: "session_summary",
          context: summary,
          action: "session_end",
          result: `${count} actions captured`,
          success: 1,
          tags: "session,hook",
          project,
        });
        checkpoint();
      }
      console.log(JSON.stringify({ ok: true, count }));
      break;
    }

    // Manual/cron maintenance: dedupe + purge + orphan cleanup + VACUUM.
    // Dry-run by default; --apply executes the changes.
    case "consolidate": {
      const apply = params.apply === "true" || params.apply === true;
      const report = runConsolidation(db, { apply });
      if (apply) checkpoint();
      console.log(formatConsolidationReport(report));
      break;
    }

    default:
      console.error(JSON.stringify({ ok: false, error: `Unknown command: ${command}` }));
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: String(e) }));
  process.exit(1);
});
