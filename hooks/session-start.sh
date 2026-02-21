#!/usr/bin/env bash
# session-start.sh - Claude Code SessionStart hook for agent-memory-protocol
# Reads stdin JSON, queries memory DB, returns additionalContext JSON on stdout.
# Matcher: startup|resume|compact|clear
# Dependencies: sqlite3, jq

set -euo pipefail

DB="$HOME/.agent-memory-protocol/data/memory.db"

# Read JSON from stdin
INPUT="$(cat)"

# Extract cwd and source from input
CWD="$(echo "$INPUT" | jq -r '.cwd // empty')"
SOURCE="$(echo "$INPUT" | jq -r '.source // "startup"')"

# Determine project name from cwd (basename)
if [ -n "$CWD" ]; then
  PROJECT="$(basename "$CWD")"
else
  PROJECT=""
fi

# Bail if DB doesn't exist
if [ ! -f "$DB" ]; then
  echo '{}'
  exit 0
fi

# --- Query preferences (merged: global + project-specific, project overrides global) ---
# Get global preferences
GLOBAL_PREFS="$(sqlite3 -json "$DB" "
  SELECT key, value, confidence, source, scope
  FROM preferences
  WHERE scope = 'global'
  ORDER BY confidence DESC
  LIMIT 30;
" 2>/dev/null || echo '[]')"

# Get project-specific preferences (if project is known)
if [ -n "$PROJECT" ]; then
  PROJECT_PREFS="$(sqlite3 -json "$DB" "
    SELECT key, value, confidence, source, scope
    FROM preferences
    WHERE scope = '${PROJECT//\'/\'\'}'
    ORDER BY confidence DESC
    LIMIT 30;
  " 2>/dev/null || echo '[]')"
else
  PROJECT_PREFS="[]"
fi

# Merge: project prefs override global prefs with same key
MERGED_PREFS="$(jq -n --argjson global "$GLOBAL_PREFS" --argjson project "$PROJECT_PREFS" '
  ($global | map({(.key): .}) | add // {}) *
  ($project | map({(.key): .}) | add // {})
  | to_entries | map(.value)
  | sort_by(-.confidence)
  | .[0:30]
')"

# --- Query recent experiences (last 5, excluding auto_capture and session_summary) ---
# Check if deleted_at column exists (Fase 1 may or may not be applied)
HAS_DELETED_AT="$(sqlite3 "$DB" "SELECT COUNT(*) FROM pragma_table_info('experiences') WHERE name='deleted_at';" 2>/dev/null || echo '0')"

if [ "$HAS_DELETED_AT" = "1" ]; then
  DELETED_FILTER="AND deleted_at IS NULL"
else
  DELETED_FILTER=""
fi

if [ -n "$PROJECT" ]; then
  PROJECT_FILTER="AND (project = '${PROJECT//\'/\'\'}' OR project = '')"
else
  PROJECT_FILTER=""
fi

RECENT_EXP="$(sqlite3 -json "$DB" "
  SELECT id, type, context, action, result, success, tags, project, created_at
  FROM experiences
  WHERE type NOT IN ('auto_capture', 'session_summary')
    ${PROJECT_FILTER}
    ${DELETED_FILTER}
  ORDER BY created_at DESC
  LIMIT 5;
" 2>/dev/null || echo '[]')"

# --- Query top 3 patterns ---
TOP_PATTERNS="$(sqlite3 -json "$DB" "
  SELECT description, category, frequency
  FROM patterns
  ORDER BY frequency DESC
  LIMIT 3;
" 2>/dev/null || echo '[]')"

# --- Query last 3 corrections (guardadas en experiences con type='correction') ---
RECENT_CORRECTIONS="$(sqlite3 -json "$DB" "
  SELECT context as what_i_did, action as what_user_wanted, result as lesson, created_at
  FROM experiences
  WHERE type = 'correction'
    ${DELETED_FILTER}
  ORDER BY created_at DESC
  LIMIT 3;
" 2>/dev/null || echo '[]')"

# --- Build additionalContext output ---
CONTEXT_TEXT="$(jq -rn --argjson prefs "$MERGED_PREFS" --argjson exps "$RECENT_EXP" --argjson pats "$TOP_PATTERNS" --argjson corrs "$RECENT_CORRECTIONS" --arg project "$PROJECT" --arg source "$SOURCE" '
"## Agent Memory Context (auto-injected via hook)\n" +
"**Project:** \($project | if . == "" then "(unknown)" else . end)\n" +
"**Source:** \($source)\n\n" +

"### User Preferences (\($prefs | length) loaded)\n" +
(if ($prefs | length) > 0 then
  ($prefs | map("- **\(.key):** \(.value) (confidence: \(.confidence))") | join("\n")) + "\n"
else
  "_(none found)_\n"
end) +
"\n### Recent Experiences (\($exps | length))\n" +
(if ($exps | length) > 0 then
  ($exps | map("- [\(.type)] \(.context | .[0:120]) (\(.created_at))") | join("\n")) + "\n"
else
  "_(none found)_\n"
end) +
"\n### Top Patterns (\($pats | length))\n" +
(if ($pats | length) > 0 then
  ($pats | map("- \(.description) (freq: \(.frequency), cat: \(.category))") | join("\n")) + "\n"
else
  "_(none found)_\n"
end) +
"\n### Recent Corrections (\($corrs | length))\n" +
(if ($corrs | length) > 0 then
  ($corrs | map("- Did: \(.what_i_did | .[0:80]) -> Wanted: \(.what_user_wanted | .[0:80])") | join("\n")) + "\n"
else
  "_(none found)_\n"
end)
')"

# Return JSON with additionalContext for Claude Code to inject
jq -n --arg ctx "$CONTEXT_TEXT" '{"additionalContext": $ctx}'
