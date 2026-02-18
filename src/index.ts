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
} from "./database.js";

// ── Servidor MCP ────────────────────────────────────────

const server = new McpServer({
  name: "agent-memory",
  version: "0.2.0",
});

// ════════════════════════════════════════════════════════
// TOOL 1: record_experience
// ════════════════════════════════════════════════════════

server.registerTool(
  "record_experience",
  {
    description:
      "Guarda una experiencia en la memoria del agente. Usa esto para recordar qué funcionó, qué falló, y en qué contexto. Cada experiencia enriquece la memoria colectiva.",
    inputSchema: {
      context: z.string().describe("Qué estaba pasando (el problema o situación)"),
      action: z.string().describe("Qué se hizo para resolverlo"),
      result: z.string().describe("Qué pasó después de la acción"),
      success: z.boolean().describe("¿Funcionó? true/false"),
      tags: z.string().optional().describe("Tags separados por coma (ej: 'typescript,bug,api')"),
      project: z.string().optional().describe("Nombre o ruta del proyecto. Si se omite, se guarda como experiencia global."),
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

    const stats = getStats();
    return {
      content: [
        {
          type: "text" as const,
          text: `Experiencia guardada. Memoria: ${stats.experiences} experiencias, ${stats.patterns} patrones, ${stats.globalPrefs} prefs globales, ${stats.projectPrefs} prefs de proyecto.`,
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
      "Registra cuando el usuario te corrige o rechaza una acción. Esto es CRÍTICO para aprender sus preferencias. Úsalo cada vez que el usuario diga 'no', 'así no', 'mejor de otra forma', o rechace un tool call.",
    inputSchema: {
      what_i_did: z.string().describe("Lo que hiciste que fue incorrecto o rechazado"),
      what_user_wanted: z.string().describe("Lo que el usuario realmente quería"),
      lesson: z.string().describe("Lección aprendida: qué hacer diferente la próxima vez"),
      tags: z.string().optional().describe("Tags para categorizar (ej: 'estilo,código,comunicación')"),
      project: z.string().optional().describe("Proyecto donde ocurrió la corrección"),
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
      `Hice: ${what_i_did} → Quería: ${what_user_wanted}`
    );

    return {
      content: [
        {
          type: "text" as const,
          text: `Corrección registrada y patrón actualizado. Lección: "${lesson}"`,
        },
      ],
    };
  }
);

// ════════════════════════════════════════════════════════
// TOOL 3: learn_preference
// Ahora con scope: 'global' o nombre de proyecto
// ════════════════════════════════════════════════════════

server.registerTool(
  "learn_preference",
  {
    description:
      "Guarda o actualiza una preferencia del usuario. Soporta DOS niveles:\n" +
      "- scope='global' (default): aplica a TODOS los proyectos\n" +
      "- scope='nombre-proyecto': aplica SOLO a ese proyecto y sobreescribe la global\n\n" +
      "Ejemplo: el usuario prefiere TypeScript globalmente, pero en un proyecto legacy usa JavaScript.\n" +
      "Cada vez que se confirma la misma preferencia, su confianza sube.",
    inputSchema: {
      key: z.string().describe("Nombre de la preferencia (ej: 'idioma', 'estilo_codigo', 'framework')"),
      value: z.string().describe("Valor de la preferencia (ej: 'español', 'funcional', 'react')"),
      scope: z.string().optional().describe("'global' (default) o nombre/ruta del proyecto para preferencia específica"),
      source: z.string().optional().describe("De dónde se aprendió (ej: 'el usuario lo dijo', 'inferido de corrección')"),
    },
  },
  async ({ key, value, scope, source }) => {
    const effectiveScope = scope || "global";

    upsertPreference.run({
      key,
      value,
      confidence: 0.5,
      source: source || "observado",
      scope: effectiveScope,
    });

    const pref = getPreference.get({ key, scope: effectiveScope }) as any;
    const scopeLabel = effectiveScope === "global" ? "GLOBAL" : `proyecto: ${effectiveScope}`;

    return {
      content: [
        {
          type: "text" as const,
          text: `Preferencia "${key}" = "${value}" guardada [${scopeLabel}] (confianza: ${pref?.confidence || 0.5}).`,
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
      "Busca en la memoria experiencias relevantes. ÚSALO ANTES de tomar decisiones importantes para ver si hay experiencias pasadas que apliquen. La búsqueda es por texto completo.",
    inputSchema: {
      query: z.string().describe("Qué buscar (texto libre, ej: 'error typescript imports')"),
      project: z.string().optional().describe("Si se pasa, busca experiencias de ese proyecto + globales"),
      limit: z.number().optional().describe("Máximo de resultados (default: 5)"),
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
              text: "No encontré experiencias relevantes en la memoria. Esto es territorio nuevo.",
            },
          ],
        };
      }

      const formatted = results
        .map(
          (r: any, i: number) =>
            `${i + 1}. [${r.type}] ${r.success ? "OK" : "FALLO"}${r.project ? ` (${r.project})` : ""} | ${r.context}\n   Acción: ${r.action}\n   Resultado: ${r.result}\n   Tags: ${r.tags} | ${r.created_at}`
        )
        .join("\n\n");

      return {
        content: [
          {
            type: "text" as const,
            text: `Encontré ${results.length} experiencias relevantes:\n\n${formatted}`,
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
            text: `Búsqueda directa no disponible. Últimas ${recent.length} experiencias:\n\n${formatted}`,
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
      "Devuelve los patrones más frecuentes detectados. Útil para ver errores recurrentes, workflows que funcionan, y lecciones aprendidas repetidamente.",
    inputSchema: {
      limit: z.number().optional().describe("Máximo de patrones (default: 10)"),
    },
  },
  async ({ limit }) => {
    const results = getPatterns.all({ limit: limit || 10 }) as any[];

    if (results.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "Aún no hay patrones detectados. Se irán formando con el uso.",
          },
        ],
      };
    }

    const formatted = results
      .map(
        (p: any, i: number) =>
          `${i + 1}. [×${p.frequency}] ${p.description}\n   Categoría: ${p.category} | Último: ${p.last_seen}`
      )
      .join("\n\n");

    return {
      content: [
        {
          type: "text" as const,
          text: `${results.length} patrones detectados:\n\n${formatted}`,
        },
      ],
    };
  }
);

// ════════════════════════════════════════════════════════
// TOOL 6: get_preferences
// Ahora con soporte de proyecto (merge global + proyecto)
// ════════════════════════════════════════════════════════

server.registerTool(
  "get_preferences",
  {
    description:
      "Devuelve las preferencias del usuario. Si pasas un proyecto, devuelve las globales + las de ese proyecto combinadas (las de proyecto tienen prioridad sobre las globales). Consulta esto al inicio de cada sesión.",
    inputSchema: {
      project: z.string().optional().describe("Nombre/ruta del proyecto. Si se omite, solo devuelve las globales."),
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
            text: "Aún no hay preferencias guardadas. Se aprenderán con el uso.",
          },
        ],
      };
    }

    const formatted = results
      .map(
        (p: any) => {
          const origin = p._origin ? ` [${p._origin}]` : ` [${p.scope || "global"}]`;
          return `- ${p.key}: "${p.value}" (confianza: ${p.confidence})${origin}`;
        }
      )
      .join("\n");

    const label = project ? `Preferencias para ${project} (global + proyecto)` : "Preferencias globales";

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
// TOOL 7: memory_stats
// ════════════════════════════════════════════════════════

server.registerTool(
  "memory_stats",
  {
    description: "Muestra estadísticas de la memoria: experiencias, correcciones, preferencias globales/proyecto y patrones.",
    inputSchema: {},
  },
  async () => {
    const stats = getStats();
    const corrections = getExperiencesByType.all({ type: "correction", limit: 3 }) as any[];
    const topPatterns = getPatterns.all({ limit: 3 }) as any[];

    let text = `=== Estado de la Memoria ===
Experiencias:       ${stats.experiences}
Correcciones:       ${stats.corrections}
Prefs globales:     ${stats.globalPrefs}
Prefs de proyecto:  ${stats.projectPrefs}
Patrones:           ${stats.patterns}`;

    if (corrections.length > 0) {
      text += `\n\nÚltimas correcciones:`;
      corrections.forEach((c: any) => {
        text += `\n- ${c.result}`;
      });
    }

    if (topPatterns.length > 0) {
      text += `\n\nPatrones top:`;
      topPatterns.forEach((p: any) => {
        text += `\n- [×${p.frequency}] ${p.description}`;
      });
    }

    return {
      content: [{ type: "text" as const, text }],
    };
  }
);

// ── Arrancar el servidor ────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Agent Memory MCP Server v0.2.0 running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
