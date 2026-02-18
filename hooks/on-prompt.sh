#!/usr/bin/env bash
# on-prompt.sh — Claude Code UserPromptSubmit hook for agent-memory-protocol
# Sends the user's prompt to the MCP server via Unix socket for semantic search.
# Returns context as plain text so Claude Code shows it prominently.
# Dependencies: jq, nc (netcat)

set -euo pipefail

SOCKET="/tmp/agent-memory.sock"
LOG="/tmp/agent-memory-hook.log"

echo "$(date '+%H:%M:%S') hook fired" >> "$LOG"

# Read JSON from stdin
INPUT="$(cat)"

# Extract prompt and cwd
PROMPT="$(echo "$INPUT" | jq -r '.prompt // empty')"
CWD="$(echo "$INPUT" | jq -r '.cwd // empty')"

# If no prompt or socket doesn't exist, exit cleanly
if [ -z "$PROMPT" ] || [ ! -S "$SOCKET" ]; then
  echo "$(date '+%H:%M:%S') no prompt or no socket" >> "$LOG"
  exit 0
fi

echo "$(date '+%H:%M:%S') sending to socket" >> "$LOG"

# Determine project name from cwd
PROJECT=""
if [ -n "$CWD" ]; then
  PROJECT="$(basename "$CWD")"
fi

# Build JSON request
REQUEST="$(jq -nc --arg prompt "$PROMPT" --arg project "$PROJECT" '{prompt: $prompt, project: $project}')"

# Send to socket and get response
RESPONSE="$(echo "$REQUEST" | nc -U "$SOCKET" -w 8 2>/dev/null || echo '{}')"

echo "$(date '+%H:%M:%S') response length: ${#RESPONSE}" >> "$LOG"

# Extract additionalContext from JSON and output as PLAIN TEXT
CONTEXT="$(echo "$RESPONSE" | jq -r '.additionalContext // empty' 2>/dev/null)"

if [ -n "$CONTEXT" ]; then
  echo "$CONTEXT"
else
  exit 0
fi
