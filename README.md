# Agent Memory Protocol

[Leer en Español](README_ES.md)

**Give your AI agents persistent memory across sessions.**

An MCP (Model Context Protocol) server that lets AI agents remember experiences, learn from corrections, and adapt to your preferences. Works with Claude Code, Codex CLI, Gemini CLI, and any MCP-compatible client.

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

## CLI compatibility

| Feature | Claude Code | Codex CLI | Gemini CLI |
|---|---|---|---|
| MCP add command | `claude mcp add` | `codex mcp add` | `gemini mcp add` |
| Config format | JSON (`~/.claude.json`) | TOML (`~/.codex/config.toml`) | JSON (`~/.gemini/settings.json`) |
| Global instructions | `~/.claude/CLAUDE.md` | `~/.codex/AGENTS.md` | `~/.gemini/GEMINI.md` |
| Global scope flag | `--scope user` | — | — |

## Auto-load on startup

To make the agent check its memory automatically at the start of every session, add the following snippet to the global instructions file for your CLI.

- **Claude Code** — `~/.claude/CLAUDE.md`
- **Codex CLI** — `~/.codex/AGENTS.md`
- **Gemini CLI** — `~/.gemini/GEMINI.md`

```markdown
## Persistent memory (MCP: agent-memory)

Project name = folder name where working
(e.g., /Users/me/projects/my-app -> "my-app")

### Session startup — ALWAYS:
1. Call `get_preferences` with current project name
2. Apply preferences throughout session

### WRITING to memory — be AGGRESSIVE:

**Corrections (`record_correction`) — MANDATORY:**
- Every time the user rejects, corrects or says "no" → record immediately
- Every time the user repeats an instruction they already gave → record as correction
- One rejection = one correction recorded, no batching

**Preferences (`learn_preference`) — MANDATORY:**
- Detect user preferences and save them (scope: global or project)
- If the user says "always do X" or "never do Y" → save as preference
- If a pattern emerges from their corrections → save as preference

**Experiences (`record_experience`) — for meaningful tasks:**
- Bug or error resolution
- Investigations of 2-3+ steps
- Feature implementations
- Architecture discoveries about the project
- DO NOT record: greetings, trivial text changes, simple questions

### READING memory — BEFORE acting:

**Query (`query_memory`) BEFORE:**
- Writing or modifying code
- Planning implementations
- Investigating problems or errors
- Making architecture decisions

**DO NOT query for:**
- Greetings or casual conversation
- Trivial tasks with no risk of repeating mistakes

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

> **Note:** Claude Code supports hooks (see "Claude Code hooks" section above) which automate context recovery after compaction. For Codex and Gemini, the instruction-based approach is the only reliable method.

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
