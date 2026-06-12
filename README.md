# Agent Memory Protocol

[Leer en Español](README_ES.md)

**Give your AI agents persistent memory across sessions — with semantic search and a context-budget discipline.**

An MCP (Model Context Protocol) server that lets AI agents remember experiences, learn from corrections, and adapt to your preferences. v3.0.0 focuses on **retrieval quality and context economy**: every automatic output is budget-capped, session context is an index instead of a dump, prompt injection only happens above a relevance threshold, and built-in telemetry measures exactly how many characters (and tokens) each channel consumes. Works with Claude Code, Codex CLI, Gemini CLI, and any MCP-compatible client.

## What it does

- **Semantic search** — Finds relevant memories by meaning, not just keywords. "How did I fix the payments?" matches experiences about billing, invoices, and transactions
- **Hybrid search** — Combines FTS5 keyword search + vector similarity into an absolute, thresholdable score
- **Local embeddings** — all-MiniLM-L6-v2 model (23 MB) runs locally via ONNX. Auto-downloads on first use, works 100% offline after that
- **Budget-capped outputs** — Session context and `get_preferences` respect hard character budgets; nothing dumps unbounded text into the context window
- **Index-first session context** — Session start injects a compact index (one line per item) and the agent drills down on demand with `get_memory(ids)`
- **Relevance-gated prompt injection** — The `UserPromptSubmit` hook only injects memories that clear a relevance threshold; irrelevant prompts get nothing
- **Unix socket for hooks** — The MCP server exposes a local socket so Claude Code hooks can perform semantic search in ~25ms per query
- **Remembers experiences** — What worked, what failed, in what context
- **Learns from corrections** — Every time you correct the agent, it records the lesson
- **Scoped memory** — Global preferences + project-specific overrides
- **Pattern detection** — Identifies recurring mistakes and successful workflows
- **Semantic dedupe on write** — A new preference whose meaning matches an existing one merges into it instead of creating a near-duplicate key
- **Automatic deduplication** — SHA-256 hashing with 15-minute window prevents duplicate entries
- **Topic upserts** — Recurring topics update in place instead of creating duplicates
- **Confidence decay without floor** — Stale preferences keep losing weight until they drop out of automatic outputs (below 0.3 effective confidence); they stay reachable via explicit lookup
- **Reversible invalidation** — Forgotten preferences are invalidated (`invalidated_at` / `superseded_by`), never destroyed; re-learning restores them
- **Offline consolidation** — `consolidate` CLI command dedupes preferences, purges old soft-deleted rows, cleans orphan vectors and VACUUMs (dry-run by default, `--apply` to execute)
- **Output telemetry** — `memory_stats` reports avg/p95 characters (and estimated tokens) per retrieval channel over the last 30 days
- **Memory management** — Forget specific memories or prune stale data automatically

## What's new in v3.0.0

| Feature | v2.x | v3.0.0 |
|---|---|---|
| Session context | Full dump of preferences + experiences | **Compact index** under a hard 4,000-char budget |
| Prompt injection | Always injected something | **Relevance threshold** (score ≥ 0.4); silent when nothing qualifies |
| `get_preferences` | Unbounded list | **Bounded by default** (limit 15, min confidence 0.4, 6,000-char budget); `key=` / `all=true` escape hatches |
| Preference decay | Floored at 0.5 | **No floor** — drops out of automatic outputs below 0.3 effective confidence |
| Forgetting preferences | Hard delete | **Reversible invalidation** (`invalidated_at`, `superseded_by`) |
| Duplicate preferences | Accumulated | **Semantic dedupe on write** + offline `consolidate` command |
| Tool surface | 11 tools | **9 tools** (see breaking changes) |
| Measurement | None | **Telemetry**: chars/tokens per channel in `memory_stats` |

### Breaking changes (v2 → v3)

Three tools were consolidated. If you have instructions or scripts referencing them, update:

| Removed tool | Replacement |
|---|---|
| `get_experience(id)` | `get_memory({ ids: [id, ...] })` — batch, returns full detail for several memories at once |
| `get_timeline(id)` | `get_memory({ ids: [id], timeline: true })` |
| `get_patterns()` | `memory_stats({ include: ["patterns"] })` |

The five core tool names are unchanged: `get_preferences`, `query_memory`, `learn_preference`, `record_experience`, `record_correction`.

Also note: the `UserPromptSubmit` hook no longer injects context on every message — only when a memory clears the relevance threshold. Without the vector channel (sqlite-vec unavailable), the on-prompt hook injects nothing.

### Architecture

```
User sends message
       |
  [UserPromptSubmit hook]  ← fires automatically
       |
       | sends prompt via Unix socket
       v
  [MCP Server]  ← already running, model in RAM
       |
       | 1. Generates embedding (~20ms)
       | 2. Hybrid search: FTS5 + vector KNN, fused into an absolute score
       | 3. Keeps only results above the relevance threshold (0.4, max 3)
       v
  Relevant memories found?  ── no ──> nothing injected
       |
      yes
       |
  [Hook returns context]
       |
  Agent receives message + only the memories that matter
```

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

On first use, the embedding model (~23 MB) downloads automatically from Hugging Face Hub. After that, it works completely offline.

### Migrating from v2.x

The database schema migrates automatically on first start (new columns and the telemetry table are added in place). The only manual change is the tool consolidation — see [Breaking changes](#breaking-changes-v2--v3).

### Migrating from v1.x

If you have existing data from v1.x, run the migration to generate embeddings for your records:

```bash
npm run migrate
```

This will:
- Generate vector embeddings for all existing experiences and corrections
- Soft-delete `auto_capture` records (noise from the old `PostToolUse` hook)
- Takes ~20 seconds for 400 records

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

## CLI compatibility

| Feature | Claude Code | Codex CLI | Gemini CLI |
|---|---|---|---|
| MCP add command | `claude mcp add` | `codex mcp add` | `gemini mcp add` |
| Config format | JSON (`~/.claude.json`) | TOML (`~/.codex/config.toml`) | JSON (`~/.gemini/settings.json`) |
| Global instructions | `~/.claude/CLAUDE.md` | `~/.codex/AGENTS.md` | `~/.gemini/GEMINI.md` |
| Global scope flag | `--scope user` | — | — |
| Hooks support | Yes | No | No |

## Claude Code hooks

The MCP server runs a **Unix socket server** that enables Claude Code hooks to perform semantic search with near-zero latency. The server loads the embedding model once and keeps it in RAM, so hooks don't need to load it on every request.

Two hooks work together:

- `SessionStart` injects a **compact memory index** (top preferences, relevant experiences, patterns, corrections — one line each, hard 4,000-char budget). After `/compact` or `/clear` it sends only a minimal reminder, since the conversation summary already preserves the working context.
- `UserPromptSubmit` fires before every user message, but since v3.0.0 it is **relevance-gated**: it injects at most 3 memories whose fused score clears the 0.4 threshold, and injects **nothing** otherwise. Because the FTS-only channel can never reach that score by itself, the hook stays silent when the vector channel (sqlite-vec + embeddings) is unavailable.

### Setup

Copy `hooks/on-prompt.sh` to your installation directory and configure `~/.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/agent-memory-protocol/hooks/on-prompt.sh",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

| Hook | When | What it does |
|---|---|---|
| `session-start.sh` | Session start (startup, resume, compact, clear) | Tries Unix socket for the budget-capped memory index (vector + FTS5 + patterns + corrections), falls back to `cli.js get_context` (same index format, FTS5 + recent only) |
| `on-prompt.sh` | Every user message | Sends prompt to Unix socket; injects up to 3 memories that clear the relevance threshold, or nothing at all. Preferences and corrections arrive via session start, not here |

**Requirements:** `jq` and `nc` (netcat) — both included in macOS and most Linux distributions.

> **Important:** The hook outputs **plain text** (not JSON `additionalContext`). This ensures Claude Code injects it as a visible `system-reminder` that the LLM cannot ignore. Using JSON `additionalContext` resulted in the LLM silently discarding the context.

### How it works

1. When the MCP server starts, it opens a Unix socket at `/tmp/agent-memory.sock` (the embedding model loads lazily on the first query)
2. On every user message, `on-prompt.sh` sends the prompt to the socket
3. The server generates an embedding and runs hybrid search (FTS5 + vector KNN across experiences AND preferences), fusing both channels into an absolute score
4. Only results with a fused score ≥ 0.4 are kept (max 3); if none qualify, the hook injects nothing
5. The hook outputs the context as plain text — Claude Code injects it as a `system-reminder`
6. Total latency: **~25ms** (20ms embedding + 2ms vector search + 3ms FTS5)

## Auto-load instructions

To make the agent check its memory automatically, add the following snippet to the global instructions file for your CLI.

- **Claude Code** — `~/.claude/CLAUDE.md`
- **Codex CLI** — `~/.codex/AGENTS.md`
- **Gemini CLI** — `~/.gemini/GEMINI.md`

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
- Every time the user rejects, corrects or says "no" -> record immediately

**Preferences (`learn_preference`) — ALWAYS when you detect one:**
- Any pattern the user repeats or explicitly requests
- Don't wait for them to say it twice: if stated clearly once, save it

**Experiences (`record_experience`) — AFTER EVERY NON-TRIVIAL TASK:**
- Bug resolution, investigations, implementations, architecture discoveries
- **Simple rule: if it took more than 2 minutes, it's probably worth saving**

### Memory recovery after compaction
After compaction (`/compact`, `/compress`, or automatic):
1. Call `get_preferences` with project name to reload
2. Call `query_memory` if there was work in progress
```

## Tools available

Once connected, the agent gets these tools:

| Tool | What it does |
|---|---|
| `record_experience` | Save what was done, the result, and context. Supports `topic_key` for upserts and optional `type` (experience, decision, gotcha, discovery). Auto-generates vector embedding |
| `record_correction` | Learn from user corrections. Auto-generates vector embedding |
| `learn_preference` | Store preferences with global or project scope (confidence starts at 0.3, decays over time). Semantic dedupe: near-identical values merge into the existing preference |
| `query_memory` | Hybrid search — FTS5 keywords + vector semantic, fused into an absolute score. Returns a compact index (default limit 8); drill down with `get_memory(ids)`. Falls back to FTS5-only if embeddings unavailable |
| `get_memory` | **v3:** Full detail for one or more memories by id (batch, max 20). `timeline: true` adds the ±1-hour timeline around each experience |
| `get_preferences` | List learned preferences (merged global + project), bounded by default (limit 15, min effective confidence 0.4, 6,000-char budget). `key="name"` returns one full preference; `all: true` returns everything |
| `memory_stats` | Statistics + retrieval telemetry (avg/p95 chars and ~tokens per channel, last 30 days). `include: ["patterns"]` adds the full detected-patterns list |
| `forget_memory` | Soft-delete experiences by id, tag, or project; invalidate preferences reversibly (`preference_key`) |
| `prune_memory` | Clean up old, failed, or low-confidence data |

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
      ├── SQLite + FTS5 (keyword search)
      ├── sqlite-vec (vector KNN search)
      ├── ONNX Runtime (local embeddings)
      └── Unix socket (/tmp/agent-memory.sock)
      |
      v
data/memory.db (your local memory)
data/models/ (cached embedding model)
```

- **SQLite** — Zero external services, everything in one file
- **sqlite-vec** — Vector search extension for SQLite (cosine distance, brute-force KNN)
- **FTS5** — Full-text keyword search built into SQLite
- **ONNX Runtime** — Runs the embedding model locally (native C++ bindings, not WASM)
- **all-MiniLM-L6-v2** — 23 MB quantized model, 384 dimensions, ~20ms per embedding
- **stdio transport** — Direct MCP communication, no HTTP overhead
- **Automatic migrations** — Schema updates happen transparently

## Data storage

All data is stored locally. Nothing leaves your machine (except the one-time model download from Hugging Face Hub).

- `data/memory.db` — SQLite database with experiences, preferences, patterns, and vector embeddings
- `data/models/` — Cached ONNX embedding model (auto-downloaded on first use)

### Tables

- **experiences** — What happened, what was done, the outcome
- **preferences** — Key-value pairs with confidence scores, scopes, and reversible invalidation (`invalidated_at`, `superseded_by`)
- **patterns** — Recurring observations with frequency tracking
- **vec_experiences / vec_preferences** — Vector embeddings for semantic search (sqlite-vec virtual tables)
- **telemetry** — Output size per retrieval channel (`ts`, `channel`, `project`, `chars`, `items`), summarized by `memory_stats`

## Maintenance: the `consolidate` command

Run it manually or from cron to keep the database clean. Dry-run by default — nothing is modified until you pass `--apply`:

```bash
node build/cli.js consolidate            # report only
node build/cli.js consolidate --apply    # execute
```

It detects near-duplicate preference pairs (cosine similarity above the dedupe threshold) and invalidates the weaker one reversibly, purges experiences soft-deleted more than 90 days ago, removes orphaned vector rows, rebuilds the FTS index, and VACUUMs the database.

## Platform compatibility

| Component | macOS | Linux | Windows |
|---|---|---|---|
| MCP server (Node.js + SQLite) | Yes | Yes | Yes |
| sqlite-vec (npm binaries) | Yes (arm64 + x64) | Yes (x64) | Not yet (no prebuilt binaries) |
| Embeddings (ONNX Runtime) | Yes | Yes | Yes |
| Unix socket (hooks) | Yes | Yes | No (no Unix sockets) |
| Hook script (bash + nc) | Yes | Yes | No (needs PowerShell equivalent) |

**Full support:** macOS and Linux. The MCP server with hybrid search works on both.

**Partial support:** Windows can run the MCP server and use `query_memory` with hybrid search via MCP tools, but the `UserPromptSubmit` hook (automatic context injection) requires Unix sockets and bash, which are not available natively. WSL2 should work.

## Agent compatibility

| Feature | Claude Code | Codex CLI | Gemini CLI |
|---|---|---|---|
| MCP tools (query, record, etc.) | Yes | Yes | Yes |
| Hybrid search (FTS5 + vector) | Yes | Yes | Yes |
| UserPromptSubmit hook (automatic) | **Yes** | No | No |
| Auto-injected context per message | **Yes** | No | No |

All MCP-compatible agents benefit from the improved hybrid search in `query_memory`. However, the automatic context injection via hooks is **exclusive to Claude Code**. For Codex CLI and Gemini CLI, add the auto-load instructions (see above) to their global instructions file so the agent calls `query_memory` proactively.

## Requirements

- Node.js 18+
- An MCP-compatible CLI (Claude Code, Codex CLI, Gemini CLI, or similar)
- For hooks: `jq` and `nc` (netcat) — included in macOS and most Linux distributions

## License

MIT
