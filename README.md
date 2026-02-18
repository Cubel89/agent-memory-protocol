# Agent Memory Protocol

[Leer en Español](README_ES.md)

**Give your AI agents persistent memory across sessions — now with semantic search.**

An MCP (Model Context Protocol) server that lets AI agents remember experiences, learn from corrections, and adapt to your preferences. v2.0.0 adds **vector-based semantic search** powered by a local embedding model that auto-downloads on first use. Works with Claude Code, Codex CLI, Gemini CLI, and any MCP-compatible client.

## What it does

- **Semantic search** — Finds relevant memories by meaning, not just keywords. "How did I fix the payments?" matches experiences about billing, invoices, and transactions
- **Hybrid search** — Combines FTS5 keyword search + vector similarity with Reciprocal Rank Fusion for the best of both worlds
- **Local embeddings** — all-MiniLM-L6-v2 model (23 MB) runs locally via ONNX. Auto-downloads on first use, works 100% offline after that
- **Unix socket for hooks** — The MCP server exposes a local socket so Claude Code hooks can perform semantic search in ~25ms per query
- **Remembers experiences** — What worked, what failed, in what context
- **Learns from corrections** — Every time you correct the agent, it records the lesson
- **Adapts to preferences** — Detects patterns in how you work and remembers them
- **Scoped memory** — Global preferences + project-specific overrides
- **Pattern detection** — Identifies recurring mistakes and successful workflows
- **Automatic deduplication** — SHA-256 hashing with 15-minute window prevents duplicate entries
- **Topic upserts** — Recurring topics update in place instead of creating duplicates
- **Confidence decay** — Preferences lose confidence over time if not re-confirmed
- **Soft delete** — Deleted memories can be recovered (marked, not destroyed)
- **Claude Code hooks** — Auto-injects context before every response via `UserPromptSubmit` hook
- **Memory management** — Forget specific memories or prune stale data automatically

## What's new in v2.0.0

| Feature | v1.x | v2.0.0 |
|---|---|---|
| Search | FTS5 keywords only | **Hybrid: FTS5 + vector semantic** |
| Hook | SessionStart only | **UserPromptSubmit** (every message) |
| Context injection | Manual (agent decides) | **Automatic** (hook injects before every response) |
| Embedding model | None | **all-MiniLM-L6-v2** (23 MB, 384 dims, local ONNX) |
| Vector store | None | **sqlite-vec** (cosine distance, ~2ms KNN) |

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
       | 2. Hybrid search: FTS5 + vector KNN + RRF merge
       | 3. Loads preferences + corrections
       v
  Returns relevant context
       |
  [Hook returns additionalContext]
       |
  Agent receives message + memory context INJECTED
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
| Hooks support | Yes (v2.0.0) | No | No |

## Claude Code hooks (v2.0.0)

v2.0.0 introduces a **Unix socket server** that enables Claude Code hooks to perform semantic search with near-zero latency. The MCP server loads the embedding model once and keeps it in RAM, so hooks don't need to load it on every request.

The key hook is `UserPromptSubmit`, which fires **before every user message**. This means Claude always has relevant memory context injected automatically — no need to rely on the LLM remembering to call tools.

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
| `session-start.sh` | Session start (startup, resume, compact, clear) | Tries Unix socket for hybrid search context (vector + FTS5 + patterns + corrections), falls back to `cli.js get_context` (FTS5 + recent only) |
| `on-prompt.sh` | Every user message | Sends prompt to Unix socket, gets semantic search results + user data + preferences + corrections, injects as plain text context |

**Requirements:** `jq` and `nc` (netcat) — both included in macOS and most Linux distributions.

> **Important:** The hook outputs **plain text** (not JSON `additionalContext`). This ensures Claude Code injects it as a visible `system-reminder` that the LLM cannot ignore. Using JSON `additionalContext` resulted in the LLM silently discarding the context.

### How it works

1. When the MCP server starts, it opens a Unix socket at `/tmp/agent-memory.sock` and pre-loads the embedding model
2. On every user message, `on-prompt.sh` sends the prompt to the socket
3. The server generates an embedding, runs hybrid search (FTS5 + vector KNN across experiences AND preferences), and builds a context string
4. The hook outputs the context as plain text — Claude Code injects it as a `system-reminder`
5. Total latency: **~25ms** (20ms embedding + 2ms vector search + 3ms FTS5)
6. Personal preferences (`user_*`) are **always included** regardless of search relevance

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
| `record_experience` | Save what was done, the result, and context. Supports `topic_key` for upserts and optional `type` (experience, decision, gotcha, discovery). **v2: auto-generates vector embedding** |
| `record_correction` | Learn from user corrections. **v2: auto-generates vector embedding** |
| `learn_preference` | Store preferences with global or project scope (confidence starts at 0.3, decays over time) |
| `query_memory` | **v2: Hybrid search** — FTS5 keywords + vector semantic + RRF merge. Returns compact results (80 chars, default limit 8). Use `get_experience(id)` for details. Falls back to FTS5-only if embeddings unavailable |
| `get_experience` | Get full details of a specific experience by ID |
| `get_timeline` | Get chronological context around an experience |
| `get_patterns` | View recurring patterns (errors, successes) |
| `get_preferences` | List learned preferences with effective confidence (merged global + project) |
| `memory_stats` | Dashboard with memory statistics |
| `forget_memory` | Soft-delete specific memories by id, tag, or project |
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
- **preferences** — Key-value pairs with confidence scores and scopes
- **patterns** — Recurring observations with frequency tracking
- **vec_experiences** — Vector embeddings for semantic search (sqlite-vec virtual table)

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
