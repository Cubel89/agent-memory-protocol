# Agent Memory Protocol

[Leer en Español](README_ES.md)

**Give your AI agents persistent memory across sessions.**

An MCP (Model Context Protocol) server that lets AI agents remember experiences, learn from corrections, and adapt to your preferences. Works with Claude Code, Codex CLI, Gemini CLI, Pi, and any MCP-compatible client.

## What it does

- **Remembers experiences** — What worked, what failed, in what context
- **Learns from corrections** — Every time you correct the agent, it records the lesson
- **Adapts to preferences** — Detects patterns in how you work and remembers them
- **Scoped memory** — Global preferences + project-specific overrides
- **Full-text search** — Find relevant past experiences instantly (progressive disclosure: compact → timeline → full detail)
- **Pattern detection** — Identifies recurring mistakes and successful workflows
- **Automatic deduplication** — SHA-256 hashing with 15-minute window prevents duplicate entries
- **Topic upserts** — Recurring topics update in place instead of creating duplicates
- **Confidence decay** — Preferences lose confidence over time if not re-confirmed
- **Soft delete** — Deleted memories can be recovered (marked, not destroyed)
- **Claude Code hooks** — Auto-injects context on session start, captures actions automatically, summarizes sessions
- **Memory management** — Forget specific memories or prune stale data automatically

## Quick start

```bash
# Clone the repo
git clone https://github.com/cubel89/agent-memory-protocol.git
cd agent-memory-protocol

# Install dependencies
npm install

# Build
npm run build
```

Then add the server to your CLI of choice (see setup below).

## Setup

### Claude Code

**Via CLI:**

```bash
claude mcp add agent-memory -- node /absolute/path/to/agent-memory-protocol/build/index.js
```

To make it available across all projects:

```bash
claude mcp add --scope user agent-memory -- node /absolute/path/to/agent-memory-protocol/build/index.js
```

**Manual config** (`~/.claude.json`):

```json
{
  "mcpServers": {
    "agent-memory": {
      "command": "node",
      "args": ["/absolute/path/to/agent-memory-protocol/build/index.js"]
    }
  }
}
```

Restart Claude Code and run `/mcp` — you should see `agent-memory` with a green checkmark.

### Codex CLI

**Via CLI:**

```bash
codex mcp add agent-memory -- node /absolute/path/to/agent-memory-protocol/build/index.js
```

**Manual config** (`~/.codex/config.toml`):

```toml
[mcp_servers.agent-memory]
command = "node"
args = ["/absolute/path/to/agent-memory-protocol/build/index.js"]
```

### Gemini CLI

**Via CLI:**

```bash
gemini mcp add agent-memory -- node /absolute/path/to/agent-memory-protocol/build/index.js
```

**Manual config** (`~/.gemini/settings.json`):

```json
{
  "mcpServers": {
    "agent-memory": {
      "command": "node",
      "args": ["/absolute/path/to/agent-memory-protocol/build/index.js"]
    }
  }
}
```

### Pi (coding agent)

Pi doesn't support MCP natively — it uses [extensions](https://github.com/badlogic/pi-mono) instead. Agent Memory connects to Pi via a TypeScript extension that acts as an MCP client, spawning the server process over stdio and exposing all tools natively.

**1. Create the extension directory:**

```bash
mkdir -p ~/.pi/agent/extensions/agent-memory
```

**2. Create `~/.pi/agent/extensions/agent-memory/package.json`:**

```json
{
  "name": "pi-agent-memory",
  "private": true,
  "version": "0.3.0",
  "type": "module",
  "pi": { "extensions": ["./index.ts"] },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.26.0"
  }
}
```

**3. Create `~/.pi/agent/extensions/agent-memory/index.ts`:**

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import path from "node:path";
import os from "node:os";

const MCP_SERVER_PATH = path.join(
  os.homedir(), ".agent-memory-protocol", "build", "index.js"
);

export default function agentMemory(pi: ExtensionAPI) {
  let client: InstanceType<typeof Client> | null = null;
  let transport: InstanceType<typeof StdioClientTransport> | null = null;
  let connected = false;

  async function connectToServer(): Promise<boolean> {
    if (connected && client) return true;
    try {
      client = new Client({ name: "pi-agent-memory", version: "0.3.0" });
      transport = new StdioClientTransport({
        command: "node", args: [MCP_SERVER_PATH],
      });
      await client.connect(transport);
      connected = true;
      return true;
    } catch (err: any) {
      client = null; transport = null; connected = false;
      return false;
    }
  }

  async function disconnectFromServer() {
    try { await transport?.close(); } catch {}
    client = null; transport = null; connected = false;
  }

  async function callMcpTool(name: string, args: Record<string, any>): Promise<string> {
    if (!connected || !client) {
      if (!(await connectToServer())) return "Error: could not connect to MCP server.";
    }
    try {
      const result = await client!.request(
        { method: "tools/call", params: { name, arguments: args } },
        CallToolResultSchema,
      );
      return result.content.map((c: any) => c.type === "text" ? c.text : JSON.stringify(c)).join("\n");
    } catch (err: any) {
      return `Error calling ${name}: ${err?.message ?? err}`;
    }
  }

  function mcpTool(name: string, label: string, description: string, parameters: any) {
    pi.registerTool({
      name, label, description, parameters,
      async execute(_id, params) {
        const text = await callMcpTool(name, params as Record<string, any>);
        return { content: [{ type: "text", text }], details: {} };
      },
    });
  }

  // Register all 11 tools
  mcpTool("record_experience", "Record Experience",
    "Save an experience to memory.",
    Type.Object({
      context: Type.String(), action: Type.String(), result: Type.String(),
      success: Type.Boolean(),
      tags: Type.Optional(Type.String()), project: Type.Optional(Type.String()),
      topic_key: Type.Optional(Type.String()),
    }));

  mcpTool("record_correction", "Record Correction",
    "Record when the user corrects or rejects an action.",
    Type.Object({
      what_i_did: Type.String(), what_user_wanted: Type.String(), lesson: Type.String(),
      tags: Type.Optional(Type.String()), project: Type.Optional(Type.String()),
    }));

  mcpTool("learn_preference", "Learn Preference",
    "Save or update a user preference.",
    Type.Object({
      key: Type.String(), value: Type.String(),
      scope: Type.Optional(Type.String()), source: Type.Optional(Type.String()),
    }));

  mcpTool("query_memory", "Query Memory",
    "Search memory for relevant experiences.",
    Type.Object({
      query: Type.String(),
      project: Type.Optional(Type.String()), limit: Type.Optional(Type.Number()),
    }));

  mcpTool("get_preferences", "Get Preferences",
    "Returns user preferences (global + project).",
    Type.Object({ project: Type.Optional(Type.String()) }));

  mcpTool("get_experience", "Get Experience",
    "Get full details of an experience by ID.",
    Type.Object({ id: Type.Number() }));

  mcpTool("get_timeline", "Get Timeline",
    "Get chronological context around an experience.",
    Type.Object({ id: Type.Number() }));

  mcpTool("get_patterns", "Get Patterns",
    "Returns the most frequent patterns detected.",
    Type.Object({ limit: Type.Optional(Type.Number()) }));

  mcpTool("forget_memory", "Forget Memory",
    "Soft-delete memories by id, tag, or project.",
    Type.Object({
      id: Type.Optional(Type.Number()), tag: Type.Optional(Type.String()),
      project: Type.Optional(Type.String()),
    }));

  mcpTool("prune_memory", "Prune Memory",
    "Delete old experiences or low-confidence preferences.",
    Type.Object({
      older_than_days: Type.Optional(Type.Number()),
      only_failures: Type.Optional(Type.Boolean()),
      min_confidence: Type.Optional(Type.Number()),
    }));

  mcpTool("memory_stats", "Memory Stats",
    "Shows memory statistics.",
    Type.Object({}));

  pi.on("session_start", async (_event, ctx) => {
    const ok = await connectToServer();
    ctx.ui.notify(ok ? "🧠 Agent Memory connected" : "⚠️ Agent Memory: connection failed", ok ? "info" : "error");
  });

  pi.on("session_shutdown", async () => { await disconnectFromServer(); });
}
```

**4. Install dependencies and reload:**

```bash
cd ~/.pi/agent/extensions/agent-memory && npm install
```

Then restart Pi or run `/reload`. You should see "🧠 Agent Memory connected" on startup.

> **Note:** Pi does not use MCP. This extension spawns the MCP server as a child process and communicates over stdio, so the same `build/index.js` is reused without modification.

## CLI compatibility

| Feature | Claude Code | Codex CLI | Gemini CLI | Pi |
|---|---|---|---|---|
| MCP add command | `claude mcp add` | `codex mcp add` | `gemini mcp add` | — (extension) |
| Config format | JSON (`~/.claude.json`) | TOML (`~/.codex/config.toml`) | JSON (`~/.gemini/settings.json`) | TypeScript extension |
| Global instructions | `~/.claude/CLAUDE.md` | `~/.codex/AGENTS.md` | `~/.gemini/GEMINI.md` | `~/.pi/agent/AGENTS.md` |
| Global scope flag | `--scope user` | — | — | — |

## Auto-load on startup

To make the agent check its memory automatically at the start of every session, add the following snippet to the global instructions file for your CLI.

- **Claude Code** — `~/.claude/CLAUDE.md`
- **Codex CLI** — `~/.codex/AGENTS.md`
- **Gemini CLI** — `~/.gemini/GEMINI.md`
- **Pi** — `~/.pi/agent/AGENTS.md`

```markdown
## Persistent memory (MCP: agent-memory) — AGGRESSIVE USAGE

Project name = folder name where working
(e.g., /Users/me/projects/my-app -> "my-app")

### Session startup — ALWAYS:
1. Call `get_preferences` with current project name
2. Apply preferences throughout session

### QUERYING memory (query_memory) — BE PROACTIVE:
Query memory in ALL these situations:
- At session start: quick query of the project to recover context
- Before implementing any feature or significant change
- Before investigating any error or bug
- When switching projects or modules within a project
- When the user asks something you might have solved before
- When making architecture or design decisions
- **Simple rule: when in doubt, query. It's cheap and prevents repeating mistakes.**

### WRITING to memory — BE GENEROUS:

**Corrections (`record_correction`) — ALWAYS, no exceptions:**
- Every time the user rejects, corrects or says "no" → record immediately
- Every time the user repeats an instruction they already gave → record as correction
- One rejection = one correction recorded, no batching

**Preferences (`learn_preference`) — ALWAYS when you detect one:**
- Any pattern the user repeats or explicitly requests
- If the user says "always do X" or "never do Y" → save as preference
- If a pattern emerges from their corrections → save as preference
- Don't wait for them to say it twice: if stated clearly once, save it

**Experiences (`record_experience`) — AFTER EVERY NON-TRIVIAL TASK:**
- Bug or error resolution (obvious or not)
- Investigations of 1-2+ steps
- New feature implementations or modifications
- Architecture discoveries about the project
- Infrastructure configuration or changes (git, deploy, servers, etc.)
- Refactors or migrations
- **Simple rule: if it took more than 2 minutes, it's probably worth saving**
- Only skip truly trivial tasks (a typo, a greeting, a direct question)

### Memory recovery after compaction

After compaction (`/compact`, `/compress`, or automatic):
1. Call `get_preferences` with project name to reload
2. Call `query_memory` if there was work in progress
3. Re-apply preferences before continuing work
```

## Surviving context compaction

All AI coding CLIs have a compaction or compression feature that summarizes the conversation to save tokens. When this happens, **preferences loaded at the start of the session can be lost** from the agent's working context.

Since the global instructions file (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`) is always reloaded with every request — even after compaction — the solution is to include the recovery instructions in the snippet above.

### How each CLI handles it

| CLI | Compaction command | Instructions file | Survives compaction? |
|---|---|---|---|
| Claude Code | `/compact` | `CLAUDE.md` / `MEMORY.md` | Yes — always in system prompt |
| Codex CLI | `/compact` | `AGENTS.md` | Yes — sent with every request |
| Gemini CLI | `/compress` | `GEMINI.md` | Yes — loaded as system instruction |
| Pi | `/compact` | `AGENTS.md` | Yes — reloaded with every request |

> **Note:** Claude Code supports hooks (see "Claude Code hooks" section above) which automate context recovery after compaction. For Codex and Gemini, the instruction-based approach is the only reliable method. Pi extensions can also hook into `session_before_compact` events for custom recovery logic.

## Claude Code hooks

v1.0.0 includes hooks that automate memory usage in Claude Code. Install them by copying the `hooks/` directory and configuring `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [{ "matcher": "startup|resume|compact|clear", "hooks": [{ "type": "command", "command": "~/.agent-memory-protocol/hooks/session-start.sh", "timeout": 10 }] }],
    "PostToolUse": [{ "matcher": "Write|Edit|Bash", "hooks": [{ "type": "command", "command": "~/.agent-memory-protocol/hooks/post-tool-use.sh", "async": true, "timeout": 5 }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "~/.agent-memory-protocol/hooks/session-end.sh", "timeout": 5 }] }]
  }
}
```

| Hook | When | What it does |
|---|---|---|
| `session-start.sh` | Session starts or compacts | Injects preferences, recent experiences, patterns, and corrections as context |
| `post-tool-use.sh` | After Write/Edit/Bash | Auto-captures actions without manual tool calls |
| `session-end.sh` | Session ends | Saves a session summary |

**Requirements:** `jq` and `sqlite3` CLI (both included in macOS).

## Tools available

Once connected, the agent gets these tools:

| Tool | What it does |
|---|---|
| `record_experience` | Save what was done, the result, and context. Supports `topic_key` for upserts |
| `record_correction` | Learn from user corrections (intention compiler) |
| `learn_preference` | Store preferences with global or project scope (confidence starts at 0.3, decays over time) |
| `query_memory` | Search past experiences — returns compact results (use `get_experience` for full details) |
| `get_experience` | Get full details of a specific experience by ID |
| `get_timeline` | Get chronological context around an experience |
| `get_patterns` | View recurring patterns (errors, successes) |
| `get_preferences` | List learned preferences with effective confidence (merged global + project) |
| `memory_stats` | Dashboard with memory statistics |
| `forget_memory` | Soft-delete specific memories by id, tag, or project |
| `prune_memory` | Clean up old, failed, or low-confidence data |

### forget_memory

Delete specific memories from the database. Requires at least one parameter.

| Parameter | Type | Description |
|---|---|---|
| `id` | number (optional) | Delete a single experience by its ID |
| `tag` | string (optional) | Delete all experiences matching a tag |
| `project` | string (optional) | Delete all experiences from a project |

Returns the number of records soft-deleted (can be recovered).

### prune_memory

Automatically clean up stale or low-quality data. Requires at least one parameter.

| Parameter | Type | Description |
|---|---|---|
| `older_than_days` | number (optional) | Delete experiences older than N days |
| `only_failures` | boolean (optional) | When `true`, only prune failed experiences (default: `false`) |
| `min_confidence` | number (optional) | Delete preferences with confidence below this threshold |

Returns the number of experiences and/or preferences deleted.

## How scopes work

Preferences support two levels:

- **`global`** — Applies to all projects (default)
- **`project-name`** — Applies only to that project, overrides global

```
Global:   code_style = "arrow functions"
Project:  code_style = "classic functions"   <-- wins in this project

Result when querying from the project:
  code_style = "classic functions"  (from project)
  language = "spanish"              (from global, no override)
```

## How it works

```
Any MCP-compatible CLI
      |
      | stdio (JSON-RPC)
      v
MCP Server (Node.js)
      |
      v
SQLite + FTS5
      |
      v
data/memory.db (your local memory)
```

- **SQLite** — Zero dependencies, no external services
- **FTS5** — Full-text search built into SQLite
- **stdio transport** — Direct communication, no HTTP overhead
- **Automatic migrations** — Schema updates happen transparently

## Data storage

All data is stored locally in `data/memory.db` (SQLite). Nothing leaves your machine.

### Tables

- **experiences** — What happened, what was done, the outcome
- **preferences** — Key-value pairs with confidence scores and scopes
- **patterns** — Recurring observations with frequency tracking

## Requirements

- Node.js 18+
- An MCP-compatible CLI (Claude Code, Codex CLI, Gemini CLI, or similar)

## License

MIT
