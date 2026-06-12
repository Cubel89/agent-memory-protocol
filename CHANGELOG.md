# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.0.0] - 2026-06-12

Retrieval v3: budget-capped outputs, relevance-gated injection, data-quality
on write, a smaller tool surface, and measurement.

### Breaking changes

- **Tool consolidation (11 → 9 tools).** Three tools were removed and their
  functionality folded into others:
  - `get_experience(id)` → `get_memory({ ids: [...] })` — batch tool that
    returns the full detail of several memories in one call (max 20 ids).
  - `get_timeline(id)` → `get_memory({ ids: [...], timeline: true })`.
  - `get_patterns()` → `memory_stats({ include: ["patterns"] })`.

  The five core tool names are unchanged: `get_preferences`, `query_memory`,
  `learn_preference`, `record_experience`, `record_correction`.
- **The `UserPromptSubmit` hook no longer injects context on every message.**
  It injects at most 3 memories whose fused relevance score clears the 0.4
  threshold, and nothing otherwise. Since the FTS-only channel cannot reach
  that score by itself, the hook injects nothing when the vector channel
  (sqlite-vec + embeddings) is unavailable.
- **`get_preferences` is bounded by default**: limit 15, minimum effective
  confidence 0.4, hard 6,000-character budget, truncated values. Use
  `key="name"` for one full preference or `all: true` for the unbounded dump.

### Added

- `get_memory` tool: batch detail retrieval by id with optional ±1-hour
  timeline per experience.
- Server `instructions` describing the recommended workflow (index first via
  `query_memory`, detail on demand via `get_memory`).
- **Telemetry**: every retrieval channel (`session_start`, `on_prompt`,
  `get_preferences`) records the size of what it returned (chars, items) in a
  new `telemetry` table — one cheap INSERT per event, never able to break a
  response. `memory_stats` reports avg and p95 characters per channel over
  the last 30 days, with estimated tokens (chars/4).
- `memory_stats` `include` parameter (`["patterns"]` adds the full
  detected-patterns list).
- **Semantic dedupe on write**: learning a preference whose meaning is
  near-identical to an existing one (cosine similarity above the threshold)
  merges into it instead of creating a duplicate key.
- **Reversible invalidation** for preferences: `forget_memory` with
  `preference_key` sets `invalidated_at` (and optionally `superseded_by`)
  instead of deleting; invalidated preferences are hidden from automatic
  retrieval and restored by re-learning them.
- `consolidate` CLI command (dry-run by default, `--apply` to execute):
  invalidates near-duplicate preferences, purges experiences soft-deleted
  more than 90 days ago, removes orphan vector rows, rebuilds the FTS index,
  and VACUUMs the database.

### Changed

- **Index-first session context**: the `SessionStart` hook injects a compact
  index (one line per preference/experience/pattern/correction) under a hard
  4,000-character budget instead of a full dump. After `/compact` or `/clear`
  only a minimal reminder is sent.
- **Hybrid search scoring**: FTS5 and vector channels are fused into an
  absolute score in [0, 1] (`0.7 * vector + 0.3 * fts`, with FTS proportional
  to term coverage), replacing rank-based fusion. Scores are comparable
  against a fixed threshold.
- **Preference decay has no floor**: stale preferences keep losing effective
  confidence (down to 0.15 of their base after two years) and drop out of all
  automatic outputs below 0.3 effective confidence, while remaining reachable
  through explicit lookups.
- Tool and parameter descriptions shortened (~50%) to reduce the schema
  footprint in the agent's context window.
- Help texts now point to `get_memory(ids)` instead of `get_experience(id)`.

### Removed

- `get_experience`, `get_timeline`, and `get_patterns` as standalone tools
  (see Breaking changes for replacements).

## [2.0.0] - 2026-04

- Hybrid search: FTS5 keyword search + local vector embeddings
  (all-MiniLM-L6-v2 via ONNX, sqlite-vec store).
- Unix socket server so Claude Code hooks get ~25ms semantic search.
- `UserPromptSubmit` hook with automatic context injection.
- Migration script for v1.x data (`npm run migrate`).

## [1.0.0]

- Initial release: MCP server with persistent memory (experiences,
  corrections, preferences, patterns) over SQLite + FTS5.
