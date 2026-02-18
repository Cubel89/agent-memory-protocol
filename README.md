# Agent Memory Protocol

**Give your AI agents persistent memory across sessions.**

An MCP (Model Context Protocol) server that lets AI agents remember experiences, learn from corrections, and adapt to your preferences. Works with Claude Code, Codex CLI, Gemini CLI, and any MCP-compatible client.

## What it does

- **Remembers experiences** — What worked, what failed, in what context
- **Learns from corrections** — Every time you correct the agent, it records the lesson
- **Adapts to preferences** — Detects patterns in how you work and remembers them
- **Scoped memory** — Global preferences + project-specific overrides
- **Full-text search** — Find relevant past experiences instantly
- **Pattern detection** — Identifies recurring mistakes and successful workflows
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

At the start of each session, ALWAYS:
1. Call `get_preferences` with the current project name
2. Apply those preferences throughout the session

When the user corrects you:
- Use `record_correction` to register the lesson
- Use `learn_preference` if you detect a new preference

When you solve something complex:
- Use `record_experience` so future sessions can benefit
```

## Tools available

Once connected, the agent gets these tools:

| Tool | What it does |
|---|---|
| `record_experience` | Save what was done, the result, and context |
| `record_correction` | Learn from user corrections (intention compiler) |
| `learn_preference` | Store preferences with global or project scope |
| `query_memory` | Search past experiences by full text |
| `get_patterns` | View recurring patterns (errors, successes) |
| `get_preferences` | List learned preferences (merged global + project) |
| `memory_stats` | Dashboard with memory statistics |
| `forget_memory` | Delete specific memories by id, tag, or project |
| `prune_memory` | Clean up old, failed, or low-confidence data |

### forget_memory

Delete specific memories from the database. Requires at least one parameter.

| Parameter | Type | Description |
|---|---|---|
| `id` | number (optional) | Delete a single experience by its ID |
| `tag` | string (optional) | Delete all experiences matching a tag |
| `project` | string (optional) | Delete all experiences from a project |

Returns the number of records deleted.

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
