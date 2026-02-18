import net from "net";
import fs from "fs";
import { getEmbedding } from "./embeddings.js";
import {
  hybridSearch,
  sanitizeFtsQuery,
  getMergedPreferences,
  getExperienceById,
  getExperiencesByType,
  getPreferenceById,
  getPatterns,
} from "./database.js";

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

  // 2. Hybrid search: FTS5 + vector + RRF
  const safeQuery = sanitizeFtsQuery(prompt);
  const results = hybridSearch({
    safeQuery,
    queryEmbedding,
    project: project || undefined,
    limit: 5,
  });

  // 3. Load full records (experiences + preferences from vector search)
  const memories: string[] = [];
  const matchedPrefKeys = new Set<string>();

  for (const r of results) {
    if (r.source === "preference") {
      const pref = getPreferenceById.get({ id: r.id }) as any;
      if (pref) {
        memories.push(`- [preference] **${pref.key}**: ${pref.value}`);
        matchedPrefKeys.add(pref.key);
      }
    } else {
      const exp = getExperienceById.get({ id: r.id }) as any;
      if (exp) {
        memories.push(`- [${exp.type}] ${(exp.context || "").substring(0, 150)} → ${(exp.result || "").substring(0, 100)}`);
      }
    }
  }

  // 4. Load preferences: ALWAYS include user_* personal prefs + top by confidence
  const prefs = getMergedPreferences(project || "");
  const personalPrefs = prefs
    .filter((p: any) => !matchedPrefKeys.has(p.key) && p.key.startsWith("user_"))
    .map((p: any) => { matchedPrefKeys.add(p.key); return `- **${p.key}**: ${p.value}`; });
  const topPrefs = prefs
    .filter((p: any) => !matchedPrefKeys.has(p.key))
    .slice(0, 8)
    .map((p: any) => `- **${p.key}**: ${p.value}`);
  const allPrefs = [...personalPrefs, ...topPrefs];

  // 5. Load recent corrections (top 3)
  const corrections = (
    getExperiencesByType.all({ type: "correction", limit: 3 }) as any[]
  ).map((c: any) => `- ${c.result}`);

  // 6. Build additionalContext — use directive tone so the LLM treats it as knowledge
  const parts: string[] = [];
  parts.push(
    `IMPORTANT: The following is information you KNOW about the user and their projects. Use it to answer their questions. This data comes from your persistent memory database.\n`
  );
  parts.push(`Project: ${project || "(unknown)"}\n`);

  if (allPrefs.length > 0) {
    parts.push(
      `USER DATA AND PREFERENCES (you know this):\n${allPrefs.join("\n")}\n`
    );
  }
  if (memories.length > 0) {
    parts.push(
      `RELEVANT PAST EXPERIENCES:\n${memories.join("\n")}\n`
    );
  }
  if (corrections.length > 0) {
    parts.push(
      `CORRECTIONS TO REMEMBER:\n${corrections.join("\n")}\n`
    );
  }

  return { additionalContext: parts.join("\n") };
}

// ── Session start handler (búsqueda híbrida para contexto inicial) ──

async function handleSessionStart(project: string, source: string): Promise<{ additionalContext?: string }> {
  // 1. Preferencias merged (global + proyecto)
  const prefs = getMergedPreferences(project || "");
  const prefLines = prefs
    .slice(0, 30)
    .map((p: any) => {
      const decay = p.effective !== undefined ? `, decay: ${p.effective.toFixed(2)}` : "";
      return `- **${p.key}**: "${p.value}" (confidence: ${p.confidence}${decay}) [${p.scope}]`;
    });

  // 2. Búsqueda híbrida de experiencias relevantes al proyecto
  const memories: string[] = [];
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
          if (exp) {
            memories.push(`- [${exp.type}] ${(exp.context || "").substring(0, 150)} → ${(exp.result || "").substring(0, 100)}`);
          }
        }
      }
    } catch { /* búsqueda híbrida falló, continuamos sin experiencias semánticas */ }
  }

  // 3. Patrones top
  const topPatterns = (getPatterns.all({ limit: 3 }) as any[]);
  const patternLines = topPatterns.map(
    (p: any) => `- [freq:${p.frequency}] ${p.description}`
  );

  // 4. Correcciones recientes
  const corrections = (
    getExperiencesByType.all({ type: "correction", limit: 3 }) as any[]
  ).map((c: any) => `- ${c.result}`);

  // 5. Construir contexto
  const parts: string[] = [];
  parts.push(`## Agent Memory Context (auto-injected via hook)`);
  parts.push(`Project: ${project || "(unknown)"} | Source: ${source}\n`);

  if (prefLines.length > 0) {
    parts.push(`### Preferences\n${prefLines.join("\n")}\n`);
  }
  if (memories.length > 0) {
    parts.push(`### Relevant Experiences (hybrid search)\n${memories.join("\n")}\n`);
  }
  if (patternLines.length > 0) {
    parts.push(`### Top Patterns\n${patternLines.join("\n")}\n`);
  }
  if (corrections.length > 0) {
    parts.push(`### Recent Corrections\n${corrections.join("\n")}\n`);
  }

  return { additionalContext: parts.join("\n") };
}
