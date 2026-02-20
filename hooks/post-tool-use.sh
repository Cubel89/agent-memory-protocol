#!/usr/bin/env bash
# post-tool-use.sh - Claude Code PostToolUse hook for agent-memory-protocol
# Captures tool usage (Write, Edit, Bash) and stores as auto_capture experience.
# Matcher: Write|Edit|Bash  |  async: true  |  timeout: 5s
# Dependencies: sqlite3, jq

set -euo pipefail

DB="$HOME/.agent-memory-protocol/data/memory.db"

# Bail if DB doesn't exist
if [ ! -f "$DB" ]; then
  exit 0
fi

# Read JSON from stdin
INPUT="$(cat)"

# Extract fields
TOOL_NAME="$(echo "$INPUT" | jq -r '.tool_name // empty')"
TOOL_INPUT="$(echo "$INPUT" | jq -r '.tool_input // {} | tostring')"
CWD="$(echo "$INPUT" | jq -r '.cwd // empty')"

# Determine project
if [ -n "$CWD" ]; then
  PROJECT="$(basename "$CWD")"
else
  PROJECT=""
fi

# Skip if no tool name
if [ -z "$TOOL_NAME" ]; then
  exit 0
fi

# --- Filter trivial Bash commands ---
if [ "$TOOL_NAME" = "Bash" ]; then
  COMMAND="$(echo "$INPUT" | jq -r '.tool_input.command // empty')"
  # Skip trivial commands
  if echo "$COMMAND" | grep -qE '^\s*(cd|ls|pwd|cat|head|tail|echo|true|false|:|test|which|whoami|date|clear)\b'; then
    exit 0
  fi
  # Skip very short commands (likely trivial)
  if [ "${#COMMAND}" -lt 5 ]; then
    exit 0
  fi
  CONTEXT="Bash: ${COMMAND:0:200}"
else
  # Write or Edit
  FILE_PATH="$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // empty')"
  if [ -n "$FILE_PATH" ]; then
    CONTEXT="${TOOL_NAME}: ${FILE_PATH}"
  else
    CONTEXT="${TOOL_NAME}: (unknown file)"
  fi
fi

# Truncate context for storage
CONTEXT="${CONTEXT:0:500}"

# --- Compute normalized_hash (SHA-256 of lowercase + normalized spaces) ---
NORMALIZED="$(echo "$CONTEXT" | tr '[:upper:]' '[:lower:]' | tr -s '[:space:]' ' ' | sed 's/^ //;s/ $//')"
HASH="$(echo -n "$NORMALIZED" | shasum -a 256 | cut -d' ' -f1)"

# --- Check if normalized_hash column exists (Fase 2 may or may not be applied) ---
HAS_HASH_COL="$(sqlite3 "$DB" "SELECT COUNT(*) FROM pragma_table_info('experiences') WHERE name='normalized_hash';" 2>/dev/null || echo '0')"

# --- Deduplication: check for same hash in last 15 minutes ---
if [ "$HAS_HASH_COL" = "1" ]; then
  EXISTING_ID="$(sqlite3 "$DB" "
    SELECT id FROM experiences
    WHERE normalized_hash = '${HASH}'
      AND created_at > datetime('now', '-15 minutes')
      AND type = 'auto_capture'
    LIMIT 1;
  " 2>/dev/null || echo '')"

  if [ -n "$EXISTING_ID" ]; then
    # Check if duplicate_count column exists
    HAS_DUP_COL="$(sqlite3 "$DB" "SELECT COUNT(*) FROM pragma_table_info('experiences') WHERE name='duplicate_count';" 2>/dev/null || echo '0')"
    if [ "$HAS_DUP_COL" = "1" ]; then
      sqlite3 "$DB" "
        PRAGMA trusted_schema=ON;
        UPDATE experiences
        SET duplicate_count = duplicate_count + 1,
            last_seen_at = datetime('now')
        WHERE id = ${EXISTING_ID};
      " 2>/dev/null || true
    fi
    exit 0
  fi
fi

# --- Insert new experience ---
# Escape single quotes in context for SQL
CONTEXT_ESCAPED="${CONTEXT//\'/\'\'}"
PROJECT_ESCAPED="${PROJECT//\'/\'\'}"

# Build INSERT depending on which columns exist
if [ "$HAS_HASH_COL" = "1" ]; then
  # Has dedup columns from Fase 2
  HAS_DELETED_COL="$(sqlite3 "$DB" "SELECT COUNT(*) FROM pragma_table_info('experiences') WHERE name='deleted_at';" 2>/dev/null || echo '0')"

  EXTRA_COLS="normalized_hash"
  EXTRA_VALS="'${HASH}'"

  HAS_DUP_COL="$(sqlite3 "$DB" "SELECT COUNT(*) FROM pragma_table_info('experiences') WHERE name='duplicate_count';" 2>/dev/null || echo '0')"
  if [ "$HAS_DUP_COL" = "1" ]; then
    EXTRA_COLS="${EXTRA_COLS}, duplicate_count, last_seen_at"
    EXTRA_VALS="${EXTRA_VALS}, 1, datetime('now')"
  fi

  sqlite3 "$DB" "
    PRAGMA trusted_schema=ON;
    INSERT INTO experiences (type, context, action, result, success, tags, project, ${EXTRA_COLS})
    VALUES ('auto_capture', '${CONTEXT_ESCAPED}', 'tool_use', '${TOOL_NAME}', 1, 'auto,hook', '${PROJECT_ESCAPED}', ${EXTRA_VALS});
  " 2>/dev/null || true
else
  # Original schema only
  sqlite3 "$DB" "
    PRAGMA trusted_schema=ON;
    INSERT INTO experiences (type, context, action, result, success, tags, project)
    VALUES ('auto_capture', '${CONTEXT_ESCAPED}', 'tool_use', '${TOOL_NAME}', 1, 'auto,hook', '${PROJECT_ESCAPED}');
  " 2>/dev/null || true
fi
