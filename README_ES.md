# Agent Memory Protocol

**Dale a tus agentes de IA memoria persistente entre sesiones.**

Un servidor MCP (Model Context Protocol) que permite a los agentes de IA recordar experiencias, aprender de correcciones y adaptarse a tus preferencias. Funciona con Claude Code, Codex CLI, Gemini CLI, Pi y cualquier cliente compatible con MCP.

## Que hace

- **Recuerda experiencias** — Que funciono, que fallo, en que contexto
- **Aprende de correcciones** — Cada vez que corriges al agente, registra la leccion
- **Se adapta a preferencias** — Detecta patrones en como trabajas y los recuerda
- **Memoria con alcance** — Preferencias globales + overrides por proyecto
- **Busqueda de texto completo** — Encuentra experiencias pasadas relevantes al instante (progressive disclosure: compacto → timeline → detalle completo)
- **Deteccion de patrones** — Identifica errores recurrentes y workflows exitosos
- **Deduplicacion automatica** — Hash SHA-256 con ventana de 15 minutos evita entradas duplicadas
- **Topic upserts** — Los temas recurrentes se actualizan en lugar de crear duplicados
- **Decay de confianza** — Las preferencias pierden confianza con el tiempo si no se re-confirman
- **Soft delete** — Las memorias eliminadas pueden recuperarse (marcadas, no destruidas)
- **Hooks de Claude Code** — Inyecta contexto automaticamente al inicio, captura acciones, resume sesiones
- **Gestion de memoria** — Olvida memorias especificas o limpia datos obsoletos automaticamente

## Inicio rapido

```bash
# Clonar el repositorio
git clone https://github.com/cubel89/agent-memory-protocol.git
cd agent-memory-protocol

# Instalar dependencias
npm install

# Compilar
npm run build
```

Luego añade el servidor a tu CLI preferido (ver configuracion abajo).

## Configuracion

### Claude Code

**Via CLI:**

```bash
claude mcp add agent-memory -- node /ruta/absoluta/a/agent-memory-protocol/build/index.js
```

Para que este disponible en todos los proyectos:

```bash
claude mcp add --scope user agent-memory -- node /ruta/absoluta/a/agent-memory-protocol/build/index.js
```

**Configuracion manual** (`~/.claude.json`):

```json
{
  "mcpServers": {
    "agent-memory": {
      "command": "node",
      "args": ["/ruta/absoluta/a/agent-memory-protocol/build/index.js"]
    }
  }
}
```

Reinicia Claude Code y ejecuta `/mcp` — deberas ver `agent-memory` con una marca verde.

### Codex CLI

**Via CLI:**

```bash
codex mcp add agent-memory -- node /ruta/absoluta/a/agent-memory-protocol/build/index.js
```

**Configuracion manual** (`~/.codex/config.toml`):

```toml
[mcp_servers.agent-memory]
command = "node"
args = ["/ruta/absoluta/a/agent-memory-protocol/build/index.js"]
```

### Gemini CLI

**Via CLI:**

```bash
gemini mcp add agent-memory -- node /ruta/absoluta/a/agent-memory-protocol/build/index.js
```

**Configuracion manual** (`~/.gemini/settings.json`):

```json
{
  "mcpServers": {
    "agent-memory": {
      "command": "node",
      "args": ["/ruta/absoluta/a/agent-memory-protocol/build/index.js"]
    }
  }
}
```

### Pi (coding agent)

Pi no soporta MCP nativamente — usa [extensiones](https://github.com/badlogic/pi-mono) en su lugar. Agent Memory se conecta a Pi mediante una extension TypeScript que actua como cliente MCP, lanzando el proceso del servidor por stdio y exponiendo todas las tools de forma nativa.

**1. Crear el directorio de la extension:**

```bash
mkdir -p ~/.pi/agent/extensions/agent-memory
```

**2. Crear `~/.pi/agent/extensions/agent-memory/package.json`:**

```json
{
  "name": "pi-agent-memory",
  "private": true,
  "version": "0.3.0",
  "type": "module",
  "pi": { "extensions": ["./index.ts"] },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.26.0"
  }
}
```

**3. Crear `~/.pi/agent/extensions/agent-memory/index.ts`:**

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import path from "node:path";
import os from "node:os";

const MCP_SERVER_PATH = path.join(
  os.homedir(), ".agent-memory-protocol", "build", "index.js"
);

export default function agentMemory(pi: ExtensionAPI) {
  let client: InstanceType<typeof Client> | null = null;
  let transport: InstanceType<typeof StdioClientTransport> | null = null;
  let connected = false;

  async function connectToServer(): Promise<boolean> {
    if (connected && client) return true;
    try {
      client = new Client({ name: "pi-agent-memory", version: "0.3.0" });
      transport = new StdioClientTransport({
        command: "node", args: [MCP_SERVER_PATH],
      });
      await client.connect(transport);
      connected = true;
      return true;
    } catch (err: any) {
      client = null; transport = null; connected = false;
      return false;
    }
  }

  async function disconnectFromServer() {
    try { await transport?.close(); } catch {}
    client = null; transport = null; connected = false;
  }

  async function callMcpTool(name: string, args: Record<string, any>): Promise<string> {
    if (!connected || !client) {
      if (!(await connectToServer())) return "Error: no se pudo conectar al servidor MCP.";
    }
    try {
      const result = await client!.request(
        { method: "tools/call", params: { name, arguments: args } },
        CallToolResultSchema,
      );
      return result.content.map((c: any) => c.type === "text" ? c.text : JSON.stringify(c)).join("\n");
    } catch (err: any) {
      return `Error llamando a ${name}: ${err?.message ?? err}`;
    }
  }

  function mcpTool(name: string, label: string, description: string, parameters: any) {
    pi.registerTool({
      name, label, description, parameters,
      async execute(_id, params) {
        const text = await callMcpTool(name, params as Record<string, any>);
        return { content: [{ type: "text", text }], details: {} };
      },
    });
  }

  // Registrar las 11 tools
  mcpTool("record_experience", "Record Experience",
    "Guardar una experiencia en memoria.",
    Type.Object({
      context: Type.String(), action: Type.String(), result: Type.String(),
      success: Type.Boolean(),
      tags: Type.Optional(Type.String()), project: Type.Optional(Type.String()),
      topic_key: Type.Optional(Type.String()),
    }));

  mcpTool("record_correction", "Record Correction",
    "Registrar cuando el usuario corrige o rechaza una accion.",
    Type.Object({
      what_i_did: Type.String(), what_user_wanted: Type.String(), lesson: Type.String(),
      tags: Type.Optional(Type.String()), project: Type.Optional(Type.String()),
    }));

  mcpTool("learn_preference", "Learn Preference",
    "Guardar o actualizar una preferencia del usuario.",
    Type.Object({
      key: Type.String(), value: Type.String(),
      scope: Type.Optional(Type.String()), source: Type.Optional(Type.String()),
    }));

  mcpTool("query_memory", "Query Memory",
    "Buscar experiencias relevantes en memoria.",
    Type.Object({
      query: Type.String(),
      project: Type.Optional(Type.String()), limit: Type.Optional(Type.Number()),
    }));

  mcpTool("get_preferences", "Get Preferences",
    "Devuelve preferencias del usuario (global + proyecto).",
    Type.Object({ project: Type.Optional(Type.String()) }));

  mcpTool("get_experience", "Get Experience",
    "Obtener detalle completo de una experiencia por ID.",
    Type.Object({ id: Type.Number() }));

  mcpTool("get_timeline", "Get Timeline",
    "Obtener contexto cronologico alrededor de una experiencia.",
    Type.Object({ id: Type.Number() }));

  mcpTool("get_patterns", "Get Patterns",
    "Devuelve los patrones mas frecuentes detectados.",
    Type.Object({ limit: Type.Optional(Type.Number()) }));

  mcpTool("forget_memory", "Forget Memory",
    "Soft-delete de memorias por id, tag o proyecto.",
    Type.Object({
      id: Type.Optional(Type.Number()), tag: Type.Optional(Type.String()),
      project: Type.Optional(Type.String()),
    }));

  mcpTool("prune_memory", "Prune Memory",
    "Eliminar experiencias antiguas o preferencias de baja confianza.",
    Type.Object({
      older_than_days: Type.Optional(Type.Number()),
      only_failures: Type.Optional(Type.Boolean()),
      min_confidence: Type.Optional(Type.Number()),
    }));

  mcpTool("memory_stats", "Memory Stats",
    "Muestra estadisticas de la memoria.",
    Type.Object({}));

  pi.on("session_start", async (_event, ctx) => {
    const ok = await connectToServer();
    ctx.ui.notify(ok ? "🧠 Agent Memory conectado" : "⚠️ Agent Memory: conexion fallida", ok ? "info" : "error");
  });

  pi.on("session_shutdown", async () => { await disconnectFromServer(); });
}
```

**4. Instalar dependencias y recargar:**

```bash
cd ~/.pi/agent/extensions/agent-memory && npm install
```

Reinicia Pi o ejecuta `/reload`. Deberas ver "🧠 Agent Memory conectado" al arrancar.

> **Nota:** Pi no usa MCP. Esta extension lanza el servidor MCP como proceso hijo y se comunica por stdio, reutilizando el mismo `build/index.js` sin modificaciones.

## Compatibilidad entre CLIs

| Caracteristica | Claude Code | Codex CLI | Gemini CLI | Pi |
|---|---|---|---|---|
| Comando MCP add | `claude mcp add` | `codex mcp add` | `gemini mcp add` | — (extension) |
| Formato de config | JSON (`~/.claude.json`) | TOML (`~/.codex/config.toml`) | JSON (`~/.gemini/settings.json`) | Extension TypeScript |
| Instrucciones globales | `~/.claude/CLAUDE.md` | `~/.codex/AGENTS.md` | `~/.gemini/GEMINI.md` | `~/.pi/agent/AGENTS.md` |
| Flag de alcance global | `--scope user` | — | — | — |

## Carga automatica al inicio

Para que el agente consulte su memoria automaticamente al inicio de cada sesion, añade el siguiente snippet al archivo de instrucciones globales de tu CLI.

- **Claude Code** — `~/.claude/CLAUDE.md`
- **Codex CLI** — `~/.codex/AGENTS.md`
- **Gemini CLI** — `~/.gemini/GEMINI.md`
- **Pi** — `~/.pi/agent/AGENTS.md`

```markdown
## Memoria persistente (MCP: agent-memory) — USO AGRESIVO

Nombre del proyecto = nombre de la carpeta de trabajo
(ej: /Users/me/projects/mi-app -> "mi-app")

### Inicio de sesion — SIEMPRE:
1. Llamar a `get_preferences` con el nombre del proyecto actual
2. Aplicar preferencias durante toda la sesion

### CONSULTAR memoria (query_memory) — SER PROACTIVO:
Consulta la memoria en TODAS estas situaciones:
- Al inicio de sesion: query rapido del proyecto para recuperar contexto
- Antes de implementar cualquier feature o cambio significativo
- Antes de investigar cualquier error o bug
- Cuando cambies de proyecto o de modulo dentro de un proyecto
- Cuando el usuario pregunte algo que podrias haber resuelto antes
- Cuando vayas a tomar una decision de arquitectura o diseño
- **Regla simple: ante la duda, consulta. Es barato y evita repetir errores.**

### ESCRIBIR en memoria — SER GENEROSO:

**Correcciones (`record_correction`) — SIEMPRE, sin excepcion:**
- Cada vez que el usuario rechace, corrija o diga "no" a algo → registrar inmediatamente
- Cada vez que el usuario repita una instruccion que ya dio antes → registrar como correccion
- Un rechazo = una correccion registrada, sin acumular

**Preferencias (`learn_preference`) — SIEMPRE que detectes una:**
- Cualquier patron que el usuario repita o pida explicitamente
- Si el usuario dice "siempre haz X" o "nunca hagas Y" → guardar como preferencia
- Si se detecta un patron en sus correcciones → guardar como preferencia
- No esperar a que lo diga dos veces: si lo dice una vez con claridad, guardarlo

**Experiencias (`record_experience`) — DESPUES DE CADA TAREA NO TRIVIAL:**
- Resolucion de bugs o errores (obvios o no)
- Investigaciones de 1-2+ pasos
- Implementaciones de funcionalidades nuevas o modificaciones
- Descubrimientos sobre arquitectura del proyecto
- Configuracion o cambios de infraestructura (git, deploy, servidores, etc.)
- Refactors o migraciones
- **Regla simple: si tardo mas de 2 minutos en hacerlo, probablemente vale la pena guardarlo**
- Solo omitir en tareas realmente triviales (un typo, un saludo, una pregunta directa)

### Recuperacion de memoria tras compactacion

Tras compactacion (`/compact`, `/compress`, o automatica):
1. Llamar a `get_preferences` con el nombre del proyecto para recargar
2. Llamar a `query_memory` si habia trabajo en curso
3. Re-aplicar preferencias antes de continuar
```

## Sobrevivir a la compactacion de contexto

Todos los CLIs de codificacion con IA tienen una funcion de compactacion o compresion que resume la conversacion para ahorrar tokens. Cuando esto ocurre, **las preferencias cargadas al inicio de la sesion pueden perderse** del contexto de trabajo del agente.

Como el archivo de instrucciones globales (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`) siempre se recarga con cada peticion — incluso despues de compactar — la solucion es incluir las instrucciones de recuperacion en el snippet de arriba.

### Como lo maneja cada CLI

| CLI | Comando de compactacion | Archivo de instrucciones | Sobrevive a la compactacion |
|---|---|---|---|
| Claude Code | `/compact` | `CLAUDE.md` / `MEMORY.md` | Si — siempre en el system prompt |
| Codex CLI | `/compact` | `AGENTS.md` | Si — se envia con cada peticion |
| Gemini CLI | `/compress` | `GEMINI.md` | Si — se carga como system instruction |
| Pi | `/compact` | `AGENTS.md` | Si — se recarga con cada peticion |

> **Nota:** Claude Code soporta hooks (ver seccion "Hooks de Claude Code" arriba) que automatizan la recuperacion de contexto tras compactacion. Para Codex y Gemini, el enfoque basado en instrucciones es el unico metodo fiable. Las extensiones de Pi tambien pueden enganchar eventos `session_before_compact` para logica de recuperacion personalizada.

## Hooks de Claude Code

v1.0.0 incluye hooks que automatizan el uso de la memoria en Claude Code. Instalalos copiando el directorio `hooks/` y configurando `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [{ "matcher": "startup|resume|compact|clear", "hooks": [{ "type": "command", "command": "~/.agent-memory-protocol/hooks/session-start.sh", "timeout": 10 }] }],
    "PostToolUse": [{ "matcher": "Write|Edit|Bash", "hooks": [{ "type": "command", "command": "~/.agent-memory-protocol/hooks/post-tool-use.sh", "async": true, "timeout": 5 }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "~/.agent-memory-protocol/hooks/session-end.sh", "timeout": 5 }] }]
  }
}
```

| Hook | Cuando | Que hace |
|---|---|---|
| `session-start.sh` | La sesion arranca o se compacta | Inyecta preferencias, experiencias recientes, patrones y correcciones como contexto |
| `post-tool-use.sh` | Despues de Write/Edit/Bash | Captura acciones automaticamente sin llamadas manuales |
| `session-end.sh` | La sesion termina | Guarda un resumen de la sesion |

**Requisitos:** `jq` y `sqlite3` CLI (ambos incluidos en macOS).

## Tools disponibles

Una vez conectado, el agente obtiene estas herramientas:

| Tool | Que hace |
|---|---|
| `record_experience` | Guardar lo que se hizo, el resultado y el contexto. Soporta `topic_key` para upserts |
| `record_correction` | Aprender de correcciones del usuario (compilador de intenciones) |
| `learn_preference` | Almacenar preferencias con alcance global o de proyecto (confianza inicia en 0.3, decae con el tiempo) |
| `query_memory` | Buscar experiencias pasadas — devuelve resultados compactos (usar `get_experience` para detalle completo) |
| `get_experience` | Obtener detalle completo de una experiencia por ID |
| `get_timeline` | Obtener contexto cronologico alrededor de una experiencia |
| `get_patterns` | Ver patrones recurrentes (errores, exitos) |
| `get_preferences` | Listar preferencias con confianza efectiva (merge global + proyecto) |
| `memory_stats` | Dashboard con estadisticas de la memoria |
| `forget_memory` | Soft-delete de memorias especificas por id, tag o proyecto |
| `prune_memory` | Limpiar datos antiguos, fallidos o de baja confianza |

### forget_memory

Elimina memorias especificas de la base de datos. Requiere al menos un parametro.

| Parametro | Tipo | Descripcion |
|---|---|---|
| `id` | number (opcional) | Eliminar una experiencia por su ID |
| `tag` | string (opcional) | Eliminar todas las experiencias que coincidan con un tag |
| `project` | string (opcional) | Eliminar todas las experiencias de un proyecto |

Devuelve el numero de registros soft-deleted (pueden recuperarse).

### prune_memory

Limpieza automatica de datos obsoletos o de baja calidad. Requiere al menos un parametro.

| Parametro | Tipo | Descripcion |
|---|---|---|
| `older_than_days` | number (opcional) | Eliminar experiencias con mas de N dias |
| `only_failures` | boolean (opcional) | Si es `true`, solo elimina experiencias fallidas (default: `false`) |
| `min_confidence` | number (opcional) | Eliminar preferencias con confianza por debajo de este umbral |

Devuelve el numero de experiencias y/o preferencias eliminadas.

## Como funcionan los alcances

Las preferencias soportan dos niveles:

- **`global`** — Aplica a todos los proyectos (por defecto)
- **`nombre-proyecto`** — Aplica solo a ese proyecto, sobreescribe la global

```
Global:   code_style = "arrow functions"
Proyecto: code_style = "classic functions"   <-- gana en este proyecto

Resultado al consultar desde el proyecto:
  code_style = "classic functions"  (del proyecto)
  language = "spanish"              (de global, sin override)
```

## Como funciona

```
Cualquier CLI compatible con MCP
      |
      | stdio (JSON-RPC)
      v
Servidor MCP (Node.js)
      |
      v
SQLite + FTS5
      |
      v
data/memory.db (tu memoria local)
```

- **SQLite** — Cero dependencias, sin servicios externos
- **FTS5** — Busqueda de texto completo integrada en SQLite
- **Transporte stdio** — Comunicacion directa, sin overhead HTTP
- **Migraciones automaticas** — Las actualizaciones del esquema ocurren de forma transparente

## Almacenamiento de datos

Todos los datos se almacenan localmente en `data/memory.db` (SQLite). Nada sale de tu maquina.

### Tablas

- **experiences** — Que paso, que se hizo, el resultado
- **preferences** — Pares clave-valor con puntuaciones de confianza y alcances
- **patterns** — Observaciones recurrentes con seguimiento de frecuencia

## Requisitos

- Node.js 18+
- Un CLI compatible con MCP (Claude Code, Codex CLI, Gemini CLI o similar)

## Licencia

MIT
