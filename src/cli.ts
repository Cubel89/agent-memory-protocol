#!/usr/bin/env node
/**
 * cli.ts - CLI wrapper para agent-memory-protocol
 *
 * Usado por los hooks de Claude Code para registrar experiencias, correcciones,
 * preferencias y capturar contexto de sesión. Usa el mismo database.ts que el MCP.
 *
 * Uso:
 *   node cli.js <comando> --param valor ...
 *   echo '{"param": "valor"}' | node cli.js <comando>
 *
 * Comandos:
 *   auto_capture       Registra uso de herramienta (post-tool-use hook)
 *   get_context        Devuelve additionalContext JSON (session-start hook)
 *   session_summary    Registra resumen de sesión (session-end hook)
 */

import {
  insertOrDeduplicate,
  getMergedPreferences,
  getRecentExperiences,
  getPatterns,
  checkpoint,
} from "./database.js";

// ── Parseo de argumentos CLI ─────────────────────────────

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

// ── Lectura de stdin si no es TTY ────────────────────────

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

  // CLI args tienen prioridad sobre stdin
  const params: Record<string, any> = { ...stdinData, ...cliArgs };

  switch (command) {

    // Usado por post-tool-use.sh
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

    // Usado por session-start.sh
    case "get_context": {
      const project = params.project || "";
      const source = params.source || "startup";

      const prefs = getMergedPreferences(project);
      const allExp = getRecentExperiences.all({ limit: 20 }) as any[];
      const recentExp = allExp
        .filter((e) => !["auto_capture", "session_summary"].includes(e.type))
        .slice(0, 5);
      const topPatterns = (getPatterns.all({ limit: 3 }) as any[]);

      const prefLines = prefs
        .slice(0, 30)
        .map((p: any) => `- **${p.key}:** ${p.value} (confidence: ${p.effective_confidence ?? p.confidence})`)
        .join("\n") || "_(ninguna encontrada)_";

      const expLines = recentExp
        .map((e: any) => `- [${e.type}] ${(e.context || "").substring(0, 120)} (${e.created_at})`)
        .join("\n") || "_(ninguna encontrada)_";

      const patLines = topPatterns
        .map((p: any) => `- ${p.description} (freq: ${p.frequency}, cat: ${p.category})`)
        .join("\n") || "_(ninguna encontrada)_";

      const contextText = [
        "## Agent Memory Context (auto-injected via hook)",
        `**Project:** ${project || "(desconocido)"}`,
        `**Source:** ${source}`,
        "",
        `### Preferencias (${prefs.length} cargadas)`,
        prefLines,
        "",
        `### Experiencias recientes (${recentExp.length})`,
        expLines,
        "",
        `### Top Patrones (${topPatterns.length})`,
        patLines,
      ].join("\n");

      console.log(JSON.stringify({ additionalContext: contextText }));
      break;
    }

    // Usado por session-end.sh
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

    default:
      console.error(JSON.stringify({ ok: false, error: `Comando desconocido: ${command}` }));
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: String(e) }));
  process.exit(1);
});
