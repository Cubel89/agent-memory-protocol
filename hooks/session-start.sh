#!/usr/bin/env bash
# session-start.sh - Claude Code SessionStart hook
# Usa búsqueda híbrida (socket) si está disponible, si no cae a cli.js
# Matcher: startup|resume|compact|clear

set -euo pipefail

CLI="$HOME/.agent-memory-protocol/build/cli.js"
SOCKET="/tmp/agent-memory.sock"

INPUT="$(cat)"
CWD="$(echo "$INPUT" | jq -r '.cwd // empty')"
SOURCE="$(echo "$INPUT" | jq -r '.source // "startup"')"

PROJECT=""
if [ -n "$CWD" ]; then
  PROJECT="$(basename "$CWD")"
fi

# Intentar búsqueda híbrida via socket (más rica: vector + FTS5)
if [ -S "$SOCKET" ]; then
  REQUEST="$(jq -nc --arg type "session_start" --arg project "$PROJECT" --arg source "$SOURCE" '{type: $type, project: $project, source: $source}')"
  RESPONSE="$(echo "$REQUEST" | nc -U "$SOCKET" -w 8 2>/dev/null || echo '{}')"

  # Verificar que la respuesta tiene contenido
  CONTEXT="$(echo "$RESPONSE" | jq -r '.additionalContext // empty' 2>/dev/null)"
  if [ -n "$CONTEXT" ]; then
    echo "$RESPONSE"
    exit 0
  fi
fi

# Fallback: cli.js get_context (solo FTS5 + recientes)
if [ -f "$CLI" ]; then
  node "$CLI" get_context --project "$PROJECT" --source "$SOURCE" 2>/dev/null || echo '{}'
else
  echo '{}'
fi
