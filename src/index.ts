#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import db, {
  insertOrDeduplicate,
  searchExperiences,
  searchExperiencesByProject,
  searchExperiencesCompact,
  searchExperiencesCompactByProject,
  getExperienceById,
  getExperienceTimeline,
  getRecentExperiences,
  getExperiencesByType,
  upsertPreference,
  getGlobalPreferences,
  getMergedPreferences,
  getPreference,
  applyDecay,
  recordPattern,
  getPatterns,
  getStats,
  softDeleteExperienceById,
  softDeleteExperiencesByTag,
  softDeleteExperiencesByProject,
  pruneOldExperiences,
  pruneLowConfidencePreferences,
  checkpoint,
  sanitizeFtsQuery,
  hybridSearch,
  getPreferenceById,
  invalidatePreference,
  upsertPrefVector,
  vectorsAvailable,
} from "./database.js";

import {
  PREF_SIMILARITY_THRESHOLD,
  preferenceEmbeddingText,
  findMostSimilarPreference,
  mergeIntoExistingPreference,
} from "./preference-dedupe.js";

import { getEmbedding, preloadModel } from "./embeddings.js";
import { startSocketServer } from "./socket-server.js";
import { normalizeTextPaths } from "./paths.js";
import {
  applyPreferenceOptions,
  formatPreferencesOutput,
  formatExperienceDetail,
  formatTimeline,
  formatMemoryBatch,
  GET_MEMORY_MAX_IDS,
  PREFS_DEFAULT_LIMIT,
  PREFS_DEFAULT_MIN_CONFIDENCE,
} from "./context-format.js";

import {
  recordTelemetry,
  summarizeTelemetry,
  formatTelemetrySummary,
} from "./telemetry.js";

// ── MCP Server ──────────────────────────────────────────

const server = new McpServer(
  {
    name: "agent-memory",
    version: "3.0.0",
  },
  {
    instructions:
      "Persistent memory across sessions. Workflow: query_memory returns a compact index of matches; " +
      "call get_memory(ids) for full detail. get_preferences is bounded by default — use key= for one " +
      "full value or all=true for everything. Write back: record_experience for task outcomes, " +
      "record_correction when the user corrects you, learn_preference for stable habits.",
  }
);

// ════════════════════════════════════════════════════════
// TOOL 1: record_experience
// ════════════════════════════════════════════════════════

server.registerTool(
  "record_experience",
  {
    description:
      "Save an experience to memory: what was happening, what was done, and the outcome.",
    inputSchema: {
      context: z.string().describe("What was happening (the problem or situation)"),
      action: z.string().describe("What was done to resolve it"),
      result: z.string().describe("What happened after the action"),
      success: z.boolean().describe("Did it work? true/false"),
      tags: z.string().optional().describe("Comma-separated tags (e.g. 'typescript,bug,api')"),
      project: z.string().optional().describe("Project name or path. If omitted, saved as global."),
      topic_key: z.string().optional().describe("Stable topic id (e.g. 'arch:database-schema'). Updates the experience with the same topic_key+project in place — use for knowledge that evolves over time."),
      type: z.enum(["experience", "decision", "gotcha", "discovery"]).optional().describe("'experience' (default), 'decision' (architecture/design), 'gotcha' (pitfall to avoid), 'discovery' (research finding)"),
    },
  },
  async ({ context, action, result, success, tags, project, topic_key, type }) => {
    const { id, deduplicated, upserted } = await insertOrDeduplicate({
      type: type || "experience",
      context,
      action,
      result,
      success: success ? 1 : 0,
      tags: tags || "",
      project: project || "",
      topic_key,
    });
    checkpoint();

    const stats = getStats();
    let status = "saved";
    if (deduplicated) status = "deduplicated (existing updated)";
    if (upserted) status = "upserted (topic updated)";

    return {
      content: [
        {
          type: "text" as const,
          text: `Experience ${status} (id: ${id}). Memory: ${stats.experiences} experiences, ${stats.patterns} patterns, ${stats.globalPrefs} global prefs, ${stats.projectPrefs} project prefs.`,
        },
      ],
    };
  }
);

// ════════════════════════════════════════════════════════
// TOOL 2: record_correction
// ════════════════════════════════════════════════════════

server.registerTool(
  "record_correction",
  {
    description:
      "Record a user correction or rejection — call it whenever the user says 'no', 'not like that', or rejects an action.",
    inputSchema: {
      what_i_did: z.string().describe("What you did that was incorrect or rejected"),
      what_user_wanted: z.string().describe("What the user actually wanted"),
      lesson: z.string().describe("Lesson: what to do differently next time"),
      tags: z.string().optional().describe("Tags (e.g. 'style,code,communication')"),
      project: z.string().optional().describe("Project where the correction happened"),
    },
  },
  async ({ what_i_did, what_user_wanted, lesson, tags, project }) => {
    const { id, deduplicated } = await insertOrDeduplicate({
      type: "correction",
      context: what_i_did,
      action: what_user_wanted,
      result: lesson,
      success: 0,
      tags: tags || "correction",
      project: project || "",
    });

    recordPattern(
      lesson,
      "correction",
      `Did: ${what_i_did} → Wanted: ${what_user_wanted}`
    );
    checkpoint();

    const status = deduplicated ? " (deduplicated)" : "";
    return {
      content: [
        {
          type: "text" as const,
          text: `Correction recorded${status} (id: ${id}) and pattern updated. Lesson: "${lesson}"`,
        },
      ],
    };
  }
);

// ════════════════════════════════════════════════════════
// TOOL 3: learn_preference
// Phase 6: Base confidence 0.3, decay tracking
// ════════════════════════════════════════════════════════

server.registerTool(
  "learn_preference",
  {
    description:
      "Save or update a user preference. scope='global' (default) applies everywhere; scope='<project>' overrides the global for that project. Re-confirming raises confidence.",
    inputSchema: {
      key: z.string().describe("Preference name (e.g. 'language', 'code_style')"),
      value: z.string().describe("Preference value (e.g. 'english', 'functional')"),
      scope: z.string().optional().describe("'global' (default) or a project name/path"),
      source: z.string().optional().describe("Where it was learned (e.g. 'user said so')"),
    },
  },
  async ({ key, value, scope, source }) => {
    const effectiveScope = scope || "global";

    // Normalize absolute sandbox paths for portability across machines.
    const valueNorm = normalizeTextPaths(value);
    const sourceNorm = normalizeTextPaths(source || "observed");
    const scopeNorm = normalizeTextPaths(effectiveScope);
    const scopeLabel = effectiveScope === "global" ? "GLOBAL" : `project: ${effectiveScope}`;

    // Candidate embedding, computed once and reused for dedupe + storage
    let embedding: Float32Array | null = null;
    if (vectorsAvailable) {
      try {
        embedding = await getEmbedding(preferenceEmbeddingText(key, valueNorm));
      } catch { /* embedding failed, continue without it */ }
    }

    // Semantic dedupe on write: when the key is NEW for this scope but the
    // value is near-identical to an existing preference, merge into it
    // instead of creating a duplicate key. Same key = normal upsert.
    const sameKeyPref = getPreference.get({ key, scope: scopeNorm }) as any;
    if (!sameKeyPref && embedding) {
      const match = findMostSimilarPreference(db, {
        scope: scopeNorm,
        excludeKey: key,
        embedding,
      });

      if (match && match.similarity > PREF_SIMILARITY_THRESHOLD) {
        const merged = mergeIntoExistingPreference(db, { id: match.id, newValue: valueNorm });
        // Value changed (new one was more complete): refresh the stored vector
        if (merged.valueUpdated) {
          try {
            const newEmbedding = await getEmbedding(preferenceEmbeddingText(merged.key, merged.value));
            if (newEmbedding) upsertPrefVector(match.id, newEmbedding);
          } catch { /* embedding failed, continue without it */ }
        }
        checkpoint();

        const updated = getPreferenceById.get({ id: match.id }) as any;
        const withDecay = applyDecay(updated);
        return {
          content: [
            {
              type: "text" as const,
              text: `Preference "${key}" merged into existing preference '${merged.key}' (similarity ${match.similarity.toFixed(2)}) [${scopeLabel}]. Value ${merged.valueUpdated ? "updated to the more complete one" : "kept"} (confidence: ${updated?.confidence}, effective: ${withDecay.effective_confidence}).`,
            },
          ],
        };
      }
    }

    upsertPreference.run({
      key,
      value: valueNorm,
      confidence: 0.3,
      source: sourceNorm,
      scope: scopeNorm,
    });
    checkpoint();

    const pref = getPreference.get({ key, scope: scopeNorm }) as any;

    // Store the embedding for the saved preference (if vectors available)
    if (pref && embedding) {
      try {
        upsertPrefVector(pref.id, embedding);
      } catch { /* vector store failed, continue without it */ }
    }

    const withDecay = applyDecay(pref);

    return {
      content: [
        {
          type: "text" as const,
          text: `Preference "${key}" = "${value}" saved [${scopeLabel}] (confidence: ${pref?.confidence || 0.3}, effective: ${withDecay.effective_confidence}).`,
        },
      ],
    };
  }
);

// ════════════════════════════════════════════════════════
// TOOL 4: query_memory
// Phase 5: Returns compact format by default
// ════════════════════════════════════════════════════════

server.registerTool(
  "query_memory",
  {
    description:
      "Hybrid (keyword + semantic) search over stored memories. Returns a compact index; call get_memory(ids) for full details. Use before significant decisions.",
    inputSchema: {
      query: z.string().describe("What to search for (free text)"),
      project: z.string().optional().describe("Search this project's experiences + global ones"),
      limit: z.number().optional().describe("Maximum results (default: 8)"),
    },
  },
  async ({ query, project, limit }) => {
    const maxResults = limit || 8;

    try {
      // Hybrid search: FTS5 + vector + RRF merge
      const safeQuery = sanitizeFtsQuery(query);
      const queryEmbedding = await getEmbedding(query);

      const hybridResults = hybridSearch({
        safeQuery,
        queryEmbedding,
        project: project || undefined,
        limit: maxResults,
      });

      if (hybridResults.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No relevant experiences found in memory. This is uncharted territory.",
            },
          ],
        };
      }

      // Load full records by ID (experiences + preferences)
      const formatted = hybridResults
        .map((r, i) => {
          if (r.source === "preference") {
            const pref = getPreferenceById.get({ id: r.id }) as any;
            // Invalidated preferences are hidden from automatic retrieval
            if (!pref || pref.invalidated_at) return null;
            return `${i + 1}. [preference] ${pref.key}: "${pref.value}" [${pref.scope}] (confidence: ${pref.confidence})`;
          } else {
            const exp = getExperienceById.get({ id: r.id }) as any;
            if (!exp) return null;
            return `${i + 1}. [id:${exp.id}] [${exp.type}] ${exp.success ? "OK" : "FAIL"}${exp.project ? ` (${exp.project})` : ""} | ${(exp.context || "").substring(0, 80)}${exp.context && exp.context.length > 80 ? "..." : ""}\n   Tags: ${exp.tags} | ${exp.created_at}`;
          }
        })
        .filter(Boolean)
        .join("\n\n");

      return {
        content: [
          {
            type: "text" as const,
            text: `Found ${hybridResults.length} results (hybrid search):\n\n${formatted}\n\nUse get_memory(ids) for full details.`,
          },
        ],
      };
    } catch {
      // Fallback: FTS5-only or recent experiences
      try {
        const safeQuery = sanitizeFtsQuery(query);
        if (safeQuery) {
          const ftsResults = project
            ? searchExperiencesCompactByProject.all({ query: safeQuery, project, limit: maxResults }) as any[]
            : searchExperiencesCompact.all({ query: safeQuery, limit: maxResults }) as any[];
          if (ftsResults.length > 0) {
            const formatted = ftsResults
              .map(
                (r: any, i: number) =>
                  `${i + 1}. [id:${r.id}] [${r.type}] ${r.snippet}${r.snippet && r.snippet.length >= 120 ? "..." : ""}`
              )
              .join("\n\n");
            return {
              content: [{ type: "text" as const, text: `Found ${ftsResults.length} (FTS5 fallback):\n\n${formatted}` }],
            };
          }
        }
      } catch { /* FTS5 also failed */ }

      const recent = getRecentExperiences.all({ limit: maxResults }) as any[];
      const formatted = recent
        .map(
          (r: any, i: number) =>
            `${i + 1}. [id:${r.id}] [${r.type}] ${r.context} → ${r.result}`
        )
        .join("\n");

      return {
        content: [
          {
            type: "text" as const,
            text: `Search unavailable. Last ${recent.length} experiences:\n\n${formatted}`,
          },
        ],
      };
    }
  }
);

// ════════════════════════════════════════════════════════
// TOOL 5: get_preferences
// Phase 6: Shows effective_confidence with decay
// v3: patterns/timeline tools were folded into memory_stats/get_memory
// ════════════════════════════════════════════════════════

server.registerTool(
  "get_preferences",
  {
    description:
      "List user preferences (project overrides merged over global), bounded by default. Use key= for one full preference or all=true for everything. Check at session start.",
    inputSchema: {
      project: z.string().optional().describe("Project name/path. If omitted, global only."),
      key: z.string().optional().describe("Return ONLY this preference at full length."),
      all: z.boolean().optional().describe("If true, return every preference unbounded."),
      limit: z.number().optional().describe(`Maximum preferences (default: ${PREFS_DEFAULT_LIMIT}).`),
      min_confidence: z.number().optional().describe(`Minimum effective confidence (default: ${PREFS_DEFAULT_MIN_CONFIDENCE}).`),
    },
  },
  async ({ project, key, all, limit, min_confidence }) => {
    // Telemetry: record the size of whatever this tool returns
    const respond = (text: string, items: number) => {
      recordTelemetry(db, { channel: "get_preferences", project: project || "", chars: text.length, items });
      return { content: [{ type: "text" as const, text }] };
    };

    // Single-key lookup: full value, project scope first, then global
    if (key) {
      const found: any[] = [];
      if (project) {
        const p = getPreference.get({ key, scope: project }) as any;
        if (p) found.push({ ...applyDecay(p), _origin: "project" });
      }
      const g = getPreference.get({ key, scope: "global" }) as any;
      if (g) found.push({ ...applyDecay(g), _origin: "global" });

      if (found.length === 0) {
        return respond(
          `Preference "${key}" not found${project ? ` (checked project "${project}" and global)` : " (global scope)"}.`,
          0
        );
      }

      const formatted = found
        .map((p: any) => {
          const invalidated = p.invalidated_at
            ? ` [INVALIDATED${p.superseded_by ? ` — superseded by '${p.superseded_by}'` : ""}]`
            : "";
          return `- ${p.key} [${p._origin}]: "${p.value}" (confidence: ${p.confidence}, effective: ${p.effective_confidence})${invalidated}`;
        })
        .join("\n");

      return respond(formatted, found.length);
    }

    const allPrefs = project
      ? getMergedPreferences(project)
      : (getGlobalPreferences.all() as any[])
          .map(applyDecay)
          .sort((a: any, b: any) => b.effective_confidence - a.effective_confidence);

    if (allPrefs.length === 0) {
      return respond("No preferences saved yet. They will be learned with usage.", 0);
    }

    const label = project ? `Preferences for ${project} (global + project)` : "Global preferences";

    // Explicit escape: full dump with complete values and metadata
    if (all) {
      const formatted = allPrefs
        .map((p: any) => {
          const origin = p._origin ? ` [${p._origin}]` : ` [${p.scope || "global"}]`;
          return `- ${p.key}: "${p.value}" (confidence: ${p.confidence}, effective: ${p.effective_confidence}, decay: ${p.decay_factor})${origin}`;
        })
        .join("\n");

      return respond(`${label} (all ${allPrefs.length}):\n\n${formatted}`, allPrefs.length);
    }

    // Default: bounded output (limit + min confidence + hard char budget)
    const selected = applyPreferenceOptions(allPrefs, {
      limit: limit ?? PREFS_DEFAULT_LIMIT,
      minEffectiveConfidence: min_confidence ?? PREFS_DEFAULT_MIN_CONFIDENCE,
    });

    return respond(
      formatPreferencesOutput({ label, prefs: selected, totalCount: allPrefs.length }),
      selected.length
    );
  }
);

// ════════════════════════════════════════════════════════
// TOOL 6: forget_memory (Phase 1: soft delete)
// ════════════════════════════════════════════════════════

server.registerTool(
  "forget_memory",
  {
    description:
      "Soft-delete experiences by id, tag, or project, and/or invalidate a preference (reversible). Requires at least one parameter.",
    inputSchema: {
      id: z.number().optional().describe("ID of the experience to delete"),
      tag: z.string().optional().describe("Delete all experiences containing this tag"),
      project: z.string().optional().describe("Delete all experiences from this project"),
      preference_key: z.string().optional().describe("Invalidate this preference (reversible: re-learn it to restore)"),
      preference_scope: z.string().optional().describe("Scope of the preference (default: 'global')"),
    },
  },
  async ({ id, tag, project, preference_key, preference_scope }) => {
    if (!id && !tag && !project && !preference_key) {
      return {
        content: [
          {
            type: "text" as const,
            text: "Error: you must provide at least one of: id, tag, project, or preference_key.",
          },
        ],
      };
    }

    let totalDeleted = 0;
    let prefInvalidated = false;

    if (id) {
      const result = softDeleteExperienceById.run({ id });
      totalDeleted += result.changes;
    }

    if (tag) {
      const result = softDeleteExperiencesByTag.run({ tag });
      totalDeleted += result.changes;
    }

    if (project) {
      const result = softDeleteExperiencesByProject.run({ project });
      totalDeleted += result.changes;
    }

    if (preference_key) {
      prefInvalidated = invalidatePreference(preference_key, preference_scope || "global");
    }

    if (totalDeleted > 0 || prefInvalidated) checkpoint();

    const stats = getStats();
    const prefNote = preference_key
      ? prefInvalidated
        ? ` Preference '${preference_key}' invalidated [${preference_scope || "global"}] (reversible: re-learn it to restore).`
        : ` Preference '${preference_key}' not found or already invalidated [${preference_scope || "global"}].`
      : "";
    return {
      content: [
        {
          type: "text" as const,
          text: `Soft-deleted ${totalDeleted} experience(s).${prefNote} Active memory: ${stats.experiences} experiences, ${stats.softDeleted} soft-deleted, ${stats.patterns} patterns.`,
        },
      ],
    };
  }
);

// ════════════════════════════════════════════════════════
// TOOL 7: prune_memory (Phase 1: soft delete)
// ════════════════════════════════════════════════════════

server.registerTool(
  "prune_memory",
  {
    description:
      "Bulk cleanup: soft-delete experiences older than N days (optionally failures only) and/or delete low-confidence preferences.",
    inputSchema: {
      older_than_days: z.number().optional().describe("Delete experiences older than N days"),
      only_failures: z.boolean().optional().describe("If true, only delete failed experiences (default: false)"),
      min_confidence: z.number().optional().describe("Delete preferences with confidence below this value"),
    },
  },
  async ({ older_than_days, only_failures, min_confidence }) => {
    if (!older_than_days && min_confidence === undefined) {
      return {
        content: [
          {
            type: "text" as const,
            text: "Error: you must provide at least older_than_days or min_confidence.",
          },
        ],
      };
    }

    let deletedExperiences = 0;
    let deletedPreferences = 0;

    if (older_than_days) {
      const result = pruneOldExperiences.run({
        days: older_than_days,
        only_failures: only_failures ? 1 : 0,
      });
      deletedExperiences = result.changes;
    }

    if (min_confidence !== undefined) {
      const result = pruneLowConfidencePreferences.run({ min_confidence });
      deletedPreferences = result.changes;
    }

    if (deletedExperiences > 0 || deletedPreferences > 0) checkpoint();

    const stats = getStats();
    const parts: string[] = [];
    if (deletedExperiences > 0) parts.push(`${deletedExperiences} experience(s)`);
    if (deletedPreferences > 0) parts.push(`${deletedPreferences} preference(s)`);

    const summary = parts.length > 0
      ? `Pruned ${parts.join(" and ")}.`
      : "No records matched the criteria.";

    return {
      content: [
        {
          type: "text" as const,
          text: `${summary} Active memory: ${stats.experiences} experiences, ${stats.softDeleted} soft-deleted, ${stats.globalPrefs} global prefs, ${stats.projectPrefs} project prefs.`,
        },
      ],
    };
  }
);

// ════════════════════════════════════════════════════════
// TOOL 8: memory_stats (v3: + telemetry summary + include)
// Absorbs the old get_patterns tool via include=["patterns"]
// ════════════════════════════════════════════════════════

server.registerTool(
  "memory_stats",
  {
    description:
      "Memory statistics plus retrieval telemetry (avg/p95 chars per channel, last 30 days). include=['patterns'] adds the full detected-patterns list.",
    inputSchema: {
      include: z.array(z.enum(["patterns"])).optional().describe("Extra sections: 'patterns' (full list, up to 20)"),
    },
  },
  async ({ include }) => {
    const stats = getStats();
    const corrections = getExperiencesByType.all({ type: "correction", limit: 3 }) as any[];
    const topPatterns = getPatterns.all({ limit: 3 }) as any[];

    let text = `=== Memory Status ===
Experiences:        ${stats.experiences}
Corrections:        ${stats.corrections}
Soft-deleted:       ${stats.softDeleted}
Global prefs:       ${stats.globalPrefs}
Project prefs:      ${stats.projectPrefs}
Patterns:           ${stats.patterns}`;

    if (corrections.length > 0) {
      text += `\n\nLatest corrections:`;
      corrections.forEach((c: any) => {
        text += `\n- ${c.result}`;
      });
    }

    if (include?.includes("patterns")) {
      const fullPatterns = getPatterns.all({ limit: 20 }) as any[];
      text += `\n\nPatterns (${fullPatterns.length}):`;
      if (fullPatterns.length === 0) {
        text += `\n(none detected yet — they will form with usage)`;
      }
      fullPatterns.forEach((p: any) => {
        text += `\n- [x${p.frequency}] ${p.description}\n  Category: ${p.category} | Last seen: ${p.last_seen}`;
      });
    } else if (topPatterns.length > 0) {
      text += `\n\nTop patterns:`;
      topPatterns.forEach((p: any) => {
        text += `\n- [x${p.frequency}] ${p.description}`;
      });
    }

    // Retrieval telemetry: how much each channel returns (chars/tokens)
    text += `\n\n${formatTelemetrySummary(summarizeTelemetry(db))}`;

    return {
      content: [{ type: "text" as const, text }],
    };
  }
);

// ════════════════════════════════════════════════════════
// TOOL 9: get_memory (v3: batch detail, replaces
// get_experience and get_timeline)
// ════════════════════════════════════════════════════════

server.registerTool(
  "get_memory",
  {
    description:
      "Fetch full details for one or more memories by id (batch). Set timeline=true to also list events within +-1 hour of each experience.",
    inputSchema: {
      ids: z.array(z.number()).min(1).describe(`Experience ids from query_memory (max ${GET_MEMORY_MAX_IDS})`),
      timeline: z.boolean().optional().describe("Include the +-1 hour timeline around each experience"),
    },
  },
  async ({ ids, timeline }) => {
    const requested = ids.slice(0, GET_MEMORY_MAX_IDS);
    const blocks: string[] = [];
    const missingIds: number[] = [];

    for (const id of requested) {
      const exp = getExperienceById.get({ id }) as any;
      if (!exp) {
        missingIds.push(id);
        continue;
      }
      let block = formatExperienceDetail(exp);
      if (timeline) {
        const rows = getExperienceTimeline.all({ id }) as any[];
        const tl = formatTimeline(rows, id);
        if (tl) block += `\n\n${tl}`;
      }
      blocks.push(block);
    }

    let text = formatMemoryBatch({ blocks, missingIds });
    if (ids.length > GET_MEMORY_MAX_IDS) {
      text += `\n\n(${ids.length - GET_MEMORY_MAX_IDS} ids beyond the ${GET_MEMORY_MAX_IDS}-id cap were ignored)`;
    }

    return {
      content: [{ type: "text" as const, text }],
    };
  }
);

// ── Start the server ────────────────────────────────────

async function main() {
  // Lazy loading: the embedding model loads on the first query, not at startup
  // (preloadModel() removed for instant startup)

  // Start Unix socket server for hooks
  startSocketServer();

  // Start MCP server
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Agent Memory MCP Server v3.0.0 running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
