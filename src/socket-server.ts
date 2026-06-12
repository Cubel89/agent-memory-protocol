import net from "net";
import fs from "fs";
import { getEmbedding } from "./embeddings.js";
import db, {
  hybridSearch,
  sanitizeFtsQuery,
  getMergedPreferences,
  getExperienceById,
  getExperiencesByType,
  getPreferenceById,
  getPatterns,
  getStats,
} from "./database.js";
import { recordTelemetry } from "./telemetry.js";
import { selectRelevant, applyDecay } from "./scoring.js";
import {
  formatSessionIndex,
  formatMinimalContext,
  AUTO_MIN_EFFECTIVE_CONFIDENCE,
} from "./context-format.js";

const SOCKET_PATH = "/tmp/agent-memory.sock";

// ── Socket server for hooks ──────────────────────────────

export function startSocketServer(): net.Server {
  // Clean up stale socket from previous run
  if (fs.existsSync(SOCKET_PATH)) {
    try {
      fs.unlinkSync(SOCKET_PATH);
    } catch { /* ignore */ }
  }

  const server = net.createServer((conn) => {
    let data = "";
    let processed = false;

    const processRequest = () => {
      if (processed) return;
      processed = true;
      handleConnection(data)
        .then((response) => {
          try {
            conn.write(JSON.stringify(response));
          } catch { /* connection may be closed */ }
          try { conn.end(); } catch { /* ignore */ }
        })
        .catch(() => {
          try { conn.write("{}"); } catch { /* ignore */ }
          try { conn.end(); } catch { /* ignore */ }
        });
    };

    conn.on("data", (chunk) => {
      data += chunk.toString();
      // Try to parse as complete JSON on each chunk
      try {
        JSON.parse(data);
        processRequest();
      } catch { /* not yet complete, wait for more data */ }
    });

    // Also process on end (fallback if JSON parsing didn't trigger)
    conn.on("end", processRequest);
    conn.on("error", () => { processed = true; });
  });

  server.listen(SOCKET_PATH, () => {
    try {
      fs.chmodSync(SOCKET_PATH, 0o666);
    } catch { /* ignore */ }
    console.error(`Socket server listening on ${SOCKET_PATH}`);
  });

  server.on("error", (err) => {
    console.error("Socket server error:", err);
  });

  // Cleanup on exit
  const cleanup = () => {
    try { fs.unlinkSync(SOCKET_PATH); } catch { /* ignore */ }
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });

  return server;
}

// ── Request handler ──────────────────────────────────────

async function handleConnection(rawData: string): Promise<{ additionalContext?: string }> {
  const req = JSON.parse(rawData);
  const requestType: string = req.type || "";
  const prompt: string = req.prompt || "";
  const project: string = req.project || "";

  // Handler para session_start: contexto inicial con búsqueda híbrida
  if (requestType === "session_start") {
    return handleSessionStart(project, req.source || "startup");
  }

  if (!prompt) return {};

  // 1. Generate embedding for the user's prompt
  const queryEmbedding = await getEmbedding(prompt);

  // 2. Hybrid search with absolute scores (see database.ts / scoring.ts)
  const safeQuery = sanitizeFtsQuery(prompt);
  const results = hybridSearch({
    safeQuery,
    queryEmbedding,
    project: project || undefined,
    limit: 10,
  });

  // 3. Relevance threshold: only inject memories that clear MIN_PROMPT_RELEVANCE,
  //    capped at MAX_PROMPT_MEMORIES. Preferences and corrections are NOT
  //    injected unconditionally here — they already arrive via session_start.
  const relevant = selectRelevant(results);
  if (relevant.length === 0) return {};

  const memories: string[] = [];
  for (const r of relevant) {
    if (r.source === "preference") {
      const pref = getPreferenceById.get({ id: r.id }) as any;
      // Automatic injection floor: skip invalidated preferences and those
      // whose decayed confidence fell below the automatic-output threshold.
      if (pref && !pref.invalidated_at && applyDecay(pref).effective_confidence >= AUTO_MIN_EFFECTIVE_CONFIDENCE) {
        memories.push(`- [preference] **${pref.key}**: ${pref.value}`);
      }
    } else {
      const exp = getExperienceById.get({ id: r.id }) as any;
      if (exp) {
        memories.push(`- [${exp.type}] ${(exp.context || "").substring(0, 150)} → ${(exp.result || "").substring(0, 100)}`);
      }
    }
  }

  if (memories.length === 0) return {};

  const parts: string[] = [];
  parts.push(
    `IMPORTANT: The following is information you KNOW about the user and their projects. It comes from your persistent memory database.\n`
  );
  parts.push(`Project: ${project || "(unknown)"}\n`);
  parts.push(`RELEVANT MEMORIES:\n${memories.join("\n")}\n`);

  const additionalContext = parts.join("\n");
  // Telemetry: only recorded when something is actually injected
  recordTelemetry(db, { channel: "on_prompt", project, chars: additionalContext.length, items: memories.length });

  return { additionalContext };
}

// ── Session start handler (index format with hard budget) ──

async function handleSessionStart(project: string, source: string): Promise<{ additionalContext?: string }> {
  // Merged preferences (global + project), already decayed and sorted.
  // Automatic output: prefs below the effective-confidence floor are
  // excluded (still reachable via get_preferences key=/all=true).
  const prefs = getMergedPreferences(project || "", {
    minEffectiveConfidence: AUTO_MIN_EFFECTIVE_CONFIDENCE,
  });

  // After compaction or /clear the conversation summary already preserves
  // the working context: send a minimal reminder instead of the index.
  if (source === "compact" || source === "clear") {
    const stats = getStats();
    const minimal = formatMinimalContext({
      project,
      source,
      prefCount: prefs.length,
      expCount: stats.experiences,
    });
    recordTelemetry(db, { channel: "session_start", project, chars: minimal.length, items: 0 });
    return { additionalContext: minimal };
  }

  // Experiences relevant to the project (hybrid search, top 5)
  const experiences: { id: number; type: string; context?: string; result?: string }[] = [];
  if (project) {
    try {
      const queryEmbedding = await getEmbedding(project);
      const safeQuery = sanitizeFtsQuery(project);
      const results = hybridSearch({
        safeQuery,
        queryEmbedding,
        project,
        limit: 5,
      });
      for (const r of results) {
        if (r.source !== "preference") {
          const exp = getExperienceById.get({ id: r.id }) as any;
          if (exp) experiences.push(exp);
        }
      }
    } catch { /* hybrid search failed, continue without semantic experiences */ }
  }

  const patterns = getPatterns.all({ limit: 3 }) as any[];
  const corrections = getExperiencesByType.all({ type: "correction", limit: 3 }) as any[];

  const index = formatSessionIndex({
    project,
    source,
    prefs,
    experiences,
    patterns,
    corrections,
  });
  recordTelemetry(db, {
    channel: "session_start",
    project,
    chars: index.length,
    items: prefs.length + experiences.length + patterns.length + corrections.length,
  });

  return { additionalContext: index };
}
