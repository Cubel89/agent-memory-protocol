# Agent Memory Protocol

**Give your AI agents persistent memory across sessions.**

An MCP (Model Context Protocol) server that lets AI agents remember experiences, learn from corrections, and adapt to your preferences. Works with Claude Code CLI and any MCP-compatible client.

## What it does

- **Remembers experiences** — What worked, what failed, in what context
- **Learns from corrections** — Every time you correct the agent, it records the lesson
- **Adapts to preferences** — Detects patterns in how you work and remembers them
- **Scoped memory** — Global preferences + project-specific overrides
- **Full-text search** — Find relevant past experiences instantly
- **Pattern detection** — Identifies recurring mistakes and successful workflows

## Quick start

```bash
# Clone the repo
git clone https://github.com/cubel89/agent-memory-protocol.git
cd agent-memory-protocol

# Install dependencies
npm install

# Build
npm run build

# Add to Claude Code CLI
claude mcp add agent-memory -- node /absolute/path/to/agent-memory-protocol/build/index.js
```

Restart Claude Code. Check it's connected:

```
/mcp
```

You should see `agent-memory` with a green checkmark.

## Tools available

Once connected, Claude gets these tools:

| Tool | What it does |
|---|---|
| `record_experience` | Save what was done, the result, and context |
| `record_correction` | Learn from user corrections (intention compiler) |
| `learn_preference` | Store preferences with global or project scope |
| `query_memory` | Search past experiences by full text |
| `get_patterns` | View recurring patterns (errors, successes) |
| `get_preferences` | List learned preferences (merged global + project) |
| `memory_stats` | Dashboard with memory statistics |

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

## Auto-load on startup

Add this to your `~/CLAUDE.md` to make Claude check memory automatically:

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

## Make it available in all projects

Instead of adding it per-project, register it globally:

```bash
claude mcp add --scope user agent-memory -- node /absolute/path/to/build/index.js
```

Or manually add to `~/.claude.json`:

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

## How it works

```
Claude Code CLI
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
- Claude Code CLI (or any MCP-compatible client)

## License

MIT
