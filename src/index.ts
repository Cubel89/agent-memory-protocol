#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  insertExperience,
  searchExperiences,
  searchExperiencesByProject,
  getRecentExperiences,
  getExperiencesByType,
  upsertPreference,
  getGlobalPreferences,
  getMergedPreferences,
  getPreference,
  recordPattern,
  getPatterns,
  getStats,
  deleteExperienceById,
  deleteExperiencesByTag,
  deleteExperiencesByProject,
  pruneOldExperiences,
  pruneLowConfidencePreferences,
  checkpoint,
} from "./database.js";

// ── MCP Server ──────────────────────────────────────────

const server = new McpServer({
  name: "agent-memory",
  version: "0.3.0",
});

// ════════════════════════════════════════════════════════
// TOOL 1: record_experience
// ════════════════════════════════════════════════════════

server.registerTool(
  "record_experience",
  {
    description:
      "Save an experience to the agent's memory. Use this to remember what worked, what failed, and in what context. Each experience enriches the collective memory.",
    inputSchema: {
      context: z.string().describe("What was happening (the problem or situation)"),
      action: z.string().describe("What was done to resolve it"),
      result: z.string().describe("What happened after the action"),
      success: z.boolean().describe("Did it work? true/false"),
      tags: z.string().optional().describe("Comma-separated tags (e.g. 'typescript,bug,api')"),
      project: z.string().optional().describe("Project name or path. If omitted, saved as a global experience."),
    },
  },
  async ({ context, action, result, success, tags, project }) => {
    insertExperience.run({
      type: "experience",
      context,
      action,
      result,
      success: success ? 1 : 0,
      tags: tags || "",
      project: project || "",
    });
    checkpoint();

    const stats = getStats();
    return {
      content: [
        {
          type: "text" as const,
          text: `Experience saved. Memory: ${stats.experiences} experiences, ${stats.patterns} patterns, ${stats.globalPrefs} global prefs, ${stats.projectPrefs} project prefs.`,
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
      "Record when the user corrects or rejects an action. This is CRITICAL for learning their preferences. Use it whenever the user says 'no', 'not like that', 'do it differently', or rejects a tool call.",
    inputSchema: {
      what_i_did: z.string().describe("What you did that was incorrect or rejected"),
      what_user_wanted: z.string().describe("What the user actually wanted"),
      lesson: z.string().describe("Lesson learned: what to do differently next time"),
      tags: z.string().optional().describe("Tags to categorize (e.g. 'style,code,communication')"),
      project: z.string().optional().describe("Project where the correction happened"),
    },
  },
  async ({ what_i_did, what_user_wanted, lesson, tags, project }) => {
    insertExperience.run({
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

    return {
      content: [
        {
          type: "text" as const,
          text: `Correction recorded and pattern updated. Lesson: "${lesson}"`,
        },
      ],
    };
  }
);

// ════════════════════════════════════════════════════════
// TOOL 3: learn_preference
// Supports scope: 'global' or project name
// ════════════════════════════════════════════════════════

server.registerTool(
  "learn_preference",
  {
    description:
      "Save or update a user preference. Supports TWO levels:\n" +
      "- scope='global' (default): applies to ALL projects\n" +
      "- scope='project-name': applies ONLY to that project and overrides the global\n\n" +
      "Example: user prefers TypeScript globally, but uses JavaScript in a legacy project.\n" +
      "Each time the same preference is confirmed, its confidence increases.",
    inputSchema: {
      key: z.string().describe("Preference name (e.g. 'language', 'code_style', 'framework')"),
      value: z.string().describe("Preference value (e.g. 'english', 'functional', 'react')"),
      scope: z.string().optional().describe("'global' (default) or project name/path for project-specific preference"),
      source: z.string().optional().describe("Where it was learned from (e.g. 'user said so', 'inferred from correction')"),
    },
  },
  async ({ key, value, scope, source }) => {
    const effectiveScope = scope || "global";

    upsertPreference.run({
      key,
      value,
      confidence: 0.5,
      source: source || "observed",
      scope: effectiveScope,
    });
    checkpoint();

    const pref = getPreference.get({ key, scope: effectiveScope }) as any;
    const scopeLabel = effectiveScope === "global" ? "GLOBAL" : `project: ${effectiveScope}`;

    return {
      content: [
        {
          type: "text" as const,
          text: `Preference "${key}" = "${value}" saved [${scopeLabel}] (confidence: ${pref?.confidence || 0.5}).`,
        },
      ],
    };
  }
);

// ════════════════════════════════════════════════════════
// TOOL 4: query_memory
// ════════════════════════════════════════════════════════

server.registerTool(
  "query_memory",
  {
    description:
      "Search the memory for relevant experiences. USE THIS BEFORE making important decisions to check if past experiences apply. Full-text search.",
    inputSchema: {
      query: z.string().describe("What to search for (free text, e.g. 'error typescript imports')"),
      project: z.string().optional().describe("If provided, searches experiences from this project + global ones"),
      limit: z.number().optional().describe("Maximum results (default: 5)"),
    },
  },
  async ({ query, project, limit }) => {
    const maxResults = limit || 5;

    try {
      const results = project
        ? searchExperiencesByProject.all({ query, project, limit: maxResults }) as any[]
        : searchExperiences.all({ query, limit: maxResults }) as any[];

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No relevant experiences found in memory. This is uncharted territory.",
            },
          ],
        };
      }

      const formatted = results
        .map(
          (r: any, i: number) =>
            `${i + 1}. [${r.type}] ${r.success ? "OK" : "FAIL"}${r.project ? ` (${r.project})` : ""} | ${r.context}\n   Action: ${r.action}\n   Result: ${r.result}\n   Tags: ${r.tags} | ${r.created_at}`
        )
        .join("\n\n");

      return {
        content: [
          {
            type: "text" as const,
            text: `Found ${results.length} relevant experiences:\n\n${formatted}`,
          },
        ],
      };
    } catch {
      const recent = getRecentExperiences.all({ limit: maxResults }) as any[];
      const formatted = recent
        .map(
          (r: any, i: number) =>
            `${i + 1}. [${r.type}] ${r.context} → ${r.result}`
        )
        .join("\n");

      return {
        content: [
          {
            type: "text" as const,
            text: `Direct search unavailable. Last ${recent.length} experiences:\n\n${formatted}`,
          },
        ],
      };
    }
  }
);

// ════════════════════════════════════════════════════════
// TOOL 5: get_patterns
// ════════════════════════════════════════════════════════

server.registerTool(
  "get_patterns",
  {
    description:
      "Returns the most frequent patterns detected. Useful for seeing recurring errors, successful workflows, and repeatedly learned lessons.",
    inputSchema: {
      limit: z.number().optional().describe("Maximum patterns (default: 10)"),
    },
  },
  async ({ limit }) => {
    const results = getPatterns.all({ limit: limit || 10 }) as any[];

    if (results.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No patterns detected yet. They will form with usage.",
          },
        ],
      };
    }

    const formatted = results
      .map(
        (p: any, i: number) =>
          `${i + 1}. [×${p.frequency}] ${p.description}\n   Category: ${p.category} | Last seen: ${p.last_seen}`
      )
      .join("\n\n");

    return {
      content: [
        {
          type: "text" as const,
          text: `${results.length} patterns detected:\n\n${formatted}`,
        },
      ],
    };
  }
);

// ════════════════════════════════════════════════════════
// TOOL 6: get_preferences
// With project support (merge global + project)
// ════════════════════════════════════════════════════════

server.registerTool(
  "get_preferences",
  {
    description:
      "Returns user preferences. If a project is provided, returns global + project-specific preferences combined (project takes priority over global). Check this at the start of each session.",
    inputSchema: {
      project: z.string().optional().describe("Project name/path. If omitted, returns only global preferences."),
    },
  },
  async ({ project }) => {
    const results = project
      ? getMergedPreferences(project)
      : getGlobalPreferences.all() as any[];

    if (results.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No preferences saved yet. They will be learned with usage.",
          },
        ],
      };
    }

    const formatted = results
      .map(
        (p: any) => {
          const origin = p._origin ? ` [${p._origin}]` : ` [${p.scope || "global"}]`;
          return `- ${p.key}: "${p.value}" (confidence: ${p.confidence})${origin}`;
        }
      )
      .join("\n");

    const label = project ? `Preferences for ${project} (global + project)` : "Global preferences";

    return {
      content: [
        {
          type: "text" as const,
          text: `${label}:\n\n${formatted}`,
        },
      ],
    };
  }
);

// ════════════════════════════════════════════════════════
// TOOL 7: forget_memory
// ════════════════════════════════════════════════════════

server.registerTool(
  "forget_memory",
  {
    description:
      "Delete specific memories by id, tag, or project. Useful for cleaning up obsolete or incorrect experiences. Requires at least one parameter.",
    inputSchema: {
      id: z.number().optional().describe("ID of the experience to delete"),
      tag: z.string().optional().describe("Delete all experiences containing this tag"),
      project: z.string().optional().describe("Delete all experiences from this project"),
    },
  },
  async ({ id, tag, project }) => {
    if (!id && !tag && !project) {
      return {
        content: [
          {
            type: "text" as const,
            text: "Error: you must provide at least one of: id, tag, or project.",
          },
        ],
      };
    }

    let totalDeleted = 0;

    if (id) {
      const result = deleteExperienceById.run({ id });
      totalDeleted += result.changes;
    }

    if (tag) {
      const result = deleteExperiencesByTag.run({ tag });
      totalDeleted += result.changes;
    }

    if (project) {
      const result = deleteExperiencesByProject.run({ project });
      totalDeleted += result.changes;
    }

    if (totalDeleted > 0) checkpoint();

    const stats = getStats();
    return {
      content: [
        {
          type: "text" as const,
          text: `Deleted ${totalDeleted} experience(s). Remaining memory: ${stats.experiences} experiences, ${stats.patterns} patterns.`,
        },
      ],
    };
  }
);

// ════════════════════════════════════════════════════════
// TOOL 8: prune_memory
// ════════════════════════════════════════════════════════

server.registerTool(
  "prune_memory",
  {
    description:
      "Automatic memory cleanup. Deletes old experiences (by days), failures only, or low-confidence preferences. Requires at least one parameter.",
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
      ? `Deleted ${parts.join(" and ")}.`
      : "No records matched the criteria.";

    return {
      content: [
        {
          type: "text" as const,
          text: `${summary} Remaining memory: ${stats.experiences} experiences, ${stats.globalPrefs} global prefs, ${stats.projectPrefs} project prefs.`,
        },
      ],
    };
  }
);

// ════════════════════════════════════════════════════════
// TOOL 9: memory_stats
// ════════════════════════════════════════════════════════

server.registerTool(
  "memory_stats",
  {
    description: "Shows memory statistics: experiences, corrections, global/project preferences, and patterns.",
    inputSchema: {},
  },
  async () => {
    const stats = getStats();
    const corrections = getExperiencesByType.all({ type: "correction", limit: 3 }) as any[];
    const topPatterns = getPatterns.all({ limit: 3 }) as any[];

    let text = `=== Memory Status ===
Experiences:        ${stats.experiences}
Corrections:        ${stats.corrections}
Global prefs:       ${stats.globalPrefs}
Project prefs:      ${stats.projectPrefs}
Patterns:           ${stats.patterns}`;

    if (corrections.length > 0) {
      text += `\n\nLatest corrections:`;
      corrections.forEach((c: any) => {
        text += `\n- ${c.result}`;
      });
    }

    if (topPatterns.length > 0) {
      text += `\n\nTop patterns:`;
      topPatterns.forEach((p: any) => {
        text += `\n- [×${p.frequency}] ${p.description}`;
      });
    }

    return {
      content: [{ type: "text" as const, text }],
    };
  }
);

// ── Start the server ────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Agent Memory MCP Server v0.3.0 running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
