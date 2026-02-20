#!/usr/bin/env bash
# session-end.sh - Claude Code SessionEnd hook for agent-memory-protocol
# Counts auto_capture actions from current session and inserts a session_summary.
# Dependencies: sqlite3, jq

set -euo pipefail

DB="$HOME/.agent-memory-protocol/data/memory.db"

# Bail if DB doesn't exist
if [ ! -f "$DB" ]; then
  exit 0
fi

# Read JSON from stdin (may contain session info)
INPUT="$(cat)"

CWD="$(echo "$INPUT" | jq -r '.cwd // empty')"

# Determine project
if [ -n "$CWD" ]; then
  PROJECT="$(basename "$CWD")"
else
  PROJECT=""
fi

PROJECT_ESCAPED="${PROJECT//\'/\'\'}"

# --- Check if deleted_at column exists ---
HAS_DELETED_AT="$(sqlite3 "$DB" "SELECT COUNT(*) FROM pragma_table_info('experiences') WHERE name='deleted_at';" 2>/dev/null || echo '0')"
if [ "$HAS_DELETED_AT" = "1" ]; then
  DELETED_FILTER="AND deleted_at IS NULL"
else
  DELETED_FILTER=""
fi

# --- Count auto_capture experiences from this session (last 24h as approximation) ---
if [ -n "$PROJECT" ]; then
  ACTION_COUNT="$(sqlite3 "$DB" "
    SELECT COUNT(*)
    FROM experiences
    WHERE type = 'auto_capture'
      AND project = '${PROJECT_ESCAPED}'
      AND created_at > datetime('now', '-24 hours')
      ${DELETED_FILTER};
  " 2>/dev/null || echo '0')"
else
  ACTION_COUNT="$(sqlite3 "$DB" "
    SELECT COUNT(*)
    FROM experiences
    WHERE type = 'auto_capture'
      AND created_at > datetime('now', '-24 hours')
      ${DELETED_FILTER};
  " 2>/dev/null || echo '0')"
fi

# Skip summary if no actions were captured
if [ "$ACTION_COUNT" = "0" ]; then
  exit 0
fi

# --- Build summary context ---
SUMMARY="Session ended. ${ACTION_COUNT} tool actions captured for project ${PROJECT}."

# Escape for SQL
SUMMARY_ESCAPED="${SUMMARY//\'/\'\'}"

# --- Compute normalized_hash ---
NORMALIZED="$(echo "$SUMMARY" | tr '[:upper:]' '[:lower:]' | tr -s '[:space:]' ' ' | sed 's/^ //;s/ $//')"
HASH="$(echo -n "$NORMALIZED" | shasum -a 256 | cut -d' ' -f1)"

# --- Insert session_summary ---
HAS_HASH_COL="$(sqlite3 "$DB" "SELECT COUNT(*) FROM pragma_table_info('experiences') WHERE name='normalized_hash';" 2>/dev/null || echo '0')"

if [ "$HAS_HASH_COL" = "1" ]; then
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
    VALUES ('session_summary', '${SUMMARY_ESCAPED}', 'session_end', '${ACTION_COUNT} actions captured', 1, 'session,hook', '${PROJECT_ESCAPED}', ${EXTRA_VALS});
  " 2>/dev/null || true
else
  sqlite3 "$DB" "
    PRAGMA trusted_schema=ON;
    INSERT INTO experiences (type, context, action, result, success, tags, project)
    VALUES ('session_summary', '${SUMMARY_ESCAPED}', 'session_end', '${ACTION_COUNT} actions captured', 1, 'session,hook', '${PROJECT_ESCAPED}');
  " 2>/dev/null || true
fi
