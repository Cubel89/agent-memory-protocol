#!/usr/bin/env bash
# session-end.sh - Claude Code SessionEnd hook
# Registra resumen de sesión via cli.js session_summary

set -euo pipefail

CLI="$HOME/.agent-memory-protocol/build/cli.js"
DB="$HOME/.agent-memory-protocol/data/memory.db"

if [ ! -f "$CLI" ] || [ ! -f "$DB" ]; then
  exit 0
fi

INPUT="$(cat)"
CWD="$(echo "$INPUT" | jq -r '.cwd // empty')"

PROJECT=""
if [ -n "$CWD" ]; then
  PROJECT="$(basename "$CWD")"
fi

# Contar auto_capture de las últimas 24h para este proyecto
if [ -n "$PROJECT" ]; then
  COUNT="$(sqlite3 "$DB" "
    SELECT COUNT(*) FROM experiences
    WHERE type = 'auto_capture'
      AND project = '${PROJECT//\'/\'\'}'
      AND created_at > datetime('now', '-24 hours')
      AND deleted_at IS NULL;
  " 2>/dev/null || echo '0')"
else
  COUNT="$(sqlite3 "$DB" "
    SELECT COUNT(*) FROM experiences
    WHERE type = 'auto_capture'
      AND created_at > datetime('now', '-24 hours')
      AND deleted_at IS NULL;
  " 2>/dev/null || echo '0')"
fi

node "$CLI" session_summary --project "$PROJECT" --count "$COUNT" 2>/dev/null || true
