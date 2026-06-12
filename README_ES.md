# Agent Memory Protocol

**Dale a tus agentes de IA memoria persistente entre sesiones — con búsqueda semántica y disciplina de presupuesto de contexto.**

Un servidor MCP (Model Context Protocol) que permite a los agentes de IA recordar experiencias, aprender de correcciones y adaptarse a tus preferencias. v3.0.0 se centra en la **calidad del retrieval y la economía de contexto**: cada salida automática tiene un presupuesto máximo de caracteres, el contexto de sesión es un índice en lugar de un volcado, la inyección por prompt solo ocurre por encima de un umbral de relevancia, y la telemetría integrada mide exactamente cuántos caracteres (y tokens) consume cada canal. Funciona con Claude Code, Codex CLI, Gemini CLI y cualquier cliente compatible con MCP.

## Qué hace

- **Búsqueda semántica** — Encuentra memorias por significado, no solo por palabras. "¿Cómo arreglé lo de los pagos?" encuentra experiencias sobre facturación, cobros y transacciones
- **Búsqueda híbrida** — Combina FTS5 (keywords) + similitud vectorial en una puntuación absoluta comparable contra un umbral
- **Embeddings locales** — Modelo all-MiniLM-L6-v2 (23 MB) corre localmente vía ONNX. Se auto-descarga en el primer uso, funciona 100% offline después
- **Salidas con presupuesto** — El contexto de sesión y `get_preferences` respetan presupuestos duros de caracteres; nada vuelca texto sin límite en la ventana de contexto
- **Contexto de sesión tipo índice** — Al iniciar sesión se inyecta un índice compacto (una línea por elemento) y el agente pide el detalle bajo demanda con `get_memory(ids)`
- **Inyección por prompt con umbral** — El hook `UserPromptSubmit` solo inyecta memorias que superan un umbral de relevancia; los prompts irrelevantes no reciben nada
- **Socket Unix para hooks** — El servidor MCP expone un socket local para que los hooks de Claude Code hagan búsqueda semántica en ~25ms por consulta
- **Recuerda experiencias** — Qué funcionó, qué falló, en qué contexto
- **Aprende de correcciones** — Cada vez que corriges al agente, registra la lección
- **Memoria con alcance** — Preferencias globales + overrides por proyecto
- **Detección de patrones** — Identifica errores recurrentes y workflows exitosos
- **Dedupe semántico al escribir** — Una preferencia nueva cuyo significado coincide con una existente se fusiona con ella en lugar de crear una clave casi duplicada
- **Deduplicación automática** — Hash SHA-256 con ventana de 15 minutos evita entradas duplicadas
- **Topic upserts** — Los temas recurrentes se actualizan en lugar de crear duplicados
- **Decay de confianza sin suelo** — Las preferencias obsoletas siguen perdiendo peso hasta caer de las salidas automáticas (por debajo de 0.3 de confianza efectiva); siguen accesibles por consulta explícita
- **Invalidación reversible** — Las preferencias olvidadas se invalidan (`invalidated_at` / `superseded_by`), nunca se destruyen; reaprenderlas las restaura
- **Consolidación offline** — El comando CLI `consolidate` deduplica preferencias, purga filas soft-deleted antiguas, limpia vectores huérfanos y hace VACUUM (dry-run por defecto, `--apply` para ejecutar)
- **Telemetría de salida** — `memory_stats` informa de la media y p95 de caracteres (y tokens estimados) por canal de retrieval en los últimos 30 días
- **Gestión de memoria** — Olvida memorias específicas o limpia datos obsoletos automáticamente

## Novedades en v3.0.0

| Característica | v2.x | v3.0.0 |
|---|---|---|
| Contexto de sesión | Volcado completo de preferencias + experiencias | **Índice compacto** bajo un presupuesto duro de 4.000 caracteres |
| Inyección por prompt | Siempre inyectaba algo | **Umbral de relevancia** (score ≥ 0.4); silencio cuando nada lo supera |
| `get_preferences` | Lista sin límite | **Acotada por defecto** (límite 15, confianza mínima 0.4, presupuesto de 6.000 caracteres); escapes `key=` / `all=true` |
| Decay de preferencias | Suelo en 0.5 | **Sin suelo** — caen de las salidas automáticas por debajo de 0.3 de confianza efectiva |
| Olvidar preferencias | Borrado definitivo | **Invalidación reversible** (`invalidated_at`, `superseded_by`) |
| Preferencias duplicadas | Se acumulaban | **Dedupe semántico al escribir** + comando offline `consolidate` |
| Superficie de tools | 11 tools | **9 tools** (ver breaking changes) |
| Medición | Ninguna | **Telemetría**: caracteres/tokens por canal en `memory_stats` |

### Breaking changes (v2 → v3)

Se consolidaron tres tools. Si tienes instrucciones o scripts que las referencien, actualízalos:

| Tool eliminada | Sustituta |
|---|---|
| `get_experience(id)` | `get_memory({ ids: [id, ...] })` — batch, devuelve el detalle completo de varias memorias de una vez |
| `get_timeline(id)` | `get_memory({ ids: [id], timeline: true })` |
| `get_patterns()` | `memory_stats({ include: ["patterns"] })` |

Los cinco nombres de tools del núcleo no cambian: `get_preferences`, `query_memory`, `learn_preference`, `record_experience`, `record_correction`.

Nota adicional: el hook `UserPromptSubmit` ya no inyecta contexto en cada mensaje — solo cuando una memoria supera el umbral de relevancia. Sin el canal vectorial (sqlite-vec no disponible), el hook on-prompt no inyecta nada.

### Arquitectura

```
El usuario envía un mensaje
       |
  [Hook UserPromptSubmit]  <- dispara automáticamente
       |
       | envía prompt vía socket Unix
       v
  [Servidor MCP]  <- ya corriendo, modelo en RAM
       |
       | 1. Genera embedding (~20ms)
       | 2. Búsqueda híbrida: FTS5 + vector KNN, fusionadas en un score absoluto
       | 3. Conserva solo resultados por encima del umbral de relevancia (0.4, máx. 3)
       v
  ¿Memorias relevantes?  ── no ──> no se inyecta nada
       |
      sí
       |
  [El hook devuelve el contexto]
       |
  El agente recibe el mensaje + solo las memorias que importan
```

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

En el primer uso, el modelo de embeddings (~23 MB) se descarga automaticamente desde Hugging Face Hub. Despues funciona completamente offline.

### Migrar desde v2.x

El esquema de la base de datos migra automáticamente en el primer arranque (las columnas nuevas y la tabla de telemetría se añaden sobre la marcha). El único cambio manual es la consolidación de tools — ver [Breaking changes](#breaking-changes-v2--v3).

### Migrar desde v1.x

Si tienes datos existentes de v1.x, ejecuta la migracion para generar embeddings:

```bash
npm run migrate
```

Esto:
- Genera embeddings vectoriales para todas las experiencias y correcciones existentes
- Elimina (soft-delete) los registros `auto_capture` (ruido del antiguo hook `PostToolUse`)
- Tarda ~20 segundos para 400 registros

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

## Compatibilidad entre CLIs

| Caracteristica | Claude Code | Codex CLI | Gemini CLI |
|---|---|---|---|
| Comando MCP add | `claude mcp add` | `codex mcp add` | `gemini mcp add` |
| Formato de config | JSON (`~/.claude.json`) | TOML (`~/.codex/config.toml`) | JSON (`~/.gemini/settings.json`) |
| Instrucciones globales | `~/.claude/CLAUDE.md` | `~/.codex/AGENTS.md` | `~/.gemini/GEMINI.md` |
| Flag de alcance global | `--scope user` | — | — |
| Soporte de hooks | Si | No | No |

## Hooks de Claude Code

El servidor MCP ejecuta un **servidor de socket Unix** que permite a los hooks de Claude Code hacer búsqueda semántica con latencia casi nula. El servidor carga el modelo de embeddings una vez y lo mantiene en RAM, así los hooks no necesitan cargarlo en cada petición.

Dos hooks trabajan juntos:

- `SessionStart` inyecta un **índice de memoria compacto** (preferencias top, experiencias relevantes, patrones, correcciones — una línea cada una, presupuesto duro de 4.000 caracteres). Tras `/compact` o `/clear` envía solo un recordatorio mínimo, porque el resumen de la conversación ya conserva el contexto de trabajo.
- `UserPromptSubmit` dispara antes de cada mensaje del usuario, pero desde v3.0.0 está **filtrado por relevancia**: inyecta como máximo 3 memorias cuyo score fusionado supere el umbral de 0.4, y **nada** en caso contrario. Como el canal FTS por sí solo nunca alcanza ese score, el hook queda en silencio cuando el canal vectorial (sqlite-vec + embeddings) no está disponible.

### Configuracion

Copia `hooks/on-prompt.sh` a tu directorio de instalacion y configura `~/.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/ruta/a/agent-memory-protocol/hooks/on-prompt.sh",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

| Hook | Cuándo | Qué hace |
|---|---|---|
| `session-start.sh` | Inicio de sesión (startup, resume, compact, clear) | Intenta socket Unix para el índice de memoria acotado (vector + FTS5 + patrones + correcciones), cae a `cli.js get_context` (mismo formato de índice, solo FTS5 + recientes) si el socket no está disponible |
| `on-prompt.sh` | Cada mensaje del usuario | Envía el prompt al socket Unix; inyecta hasta 3 memorias que superen el umbral de relevancia, o nada en absoluto. Las preferencias y correcciones llegan vía session start, no por aquí |

**Requisitos:** `jq` y `nc` (netcat) — ambos incluidos en macOS y la mayoria de distribuciones Linux.

> **Importante:** El hook devuelve **texto plano** (no JSON `additionalContext`). Esto asegura que Claude Code lo inyecta como un `system-reminder` visible que el LLM no puede ignorar. Usar JSON `additionalContext` resultaba en que el LLM descartaba el contexto silenciosamente.

### Como funciona

1. Cuando el servidor MCP arranca, abre un socket Unix en `/tmp/agent-memory.sock` (el modelo de embeddings se carga de forma perezosa en la primera consulta)
2. En cada mensaje del usuario, `on-prompt.sh` envía el prompt al socket
3. El servidor genera un embedding y ejecuta búsqueda híbrida (FTS5 + vector KNN en experiencias Y preferencias), fusionando ambos canales en un score absoluto
4. Solo se conservan los resultados con score fusionado ≥ 0.4 (máximo 3); si ninguno lo supera, el hook no inyecta nada
5. El hook devuelve el contexto como texto plano — Claude Code lo inyecta como `system-reminder`
6. Latencia total: **~25ms** (20ms embedding + 2ms búsqueda vectorial + 3ms FTS5)

## Carga automatica al inicio

Para que el agente consulte su memoria automaticamente, anade el siguiente snippet al archivo de instrucciones globales de tu CLI.

- **Claude Code** — `~/.claude/CLAUDE.md`
- **Codex CLI** — `~/.codex/AGENTS.md`
- **Gemini CLI** — `~/.gemini/GEMINI.md`

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
- Cuando vayas a tomar una decision de arquitectura o diseno
- **Regla simple: ante la duda, consulta. Es barato y evita repetir errores.**

### ESCRIBIR en memoria — SER GENEROSO:

**Correcciones (`record_correction`) — SIEMPRE, sin excepcion:**
- Cada vez que el usuario rechace, corrija o diga "no" a algo -> registrar inmediatamente

**Preferencias (`learn_preference`) — SIEMPRE que detectes una:**
- Cualquier patron que el usuario repita o pida explicitamente
- Si lo dice una vez con claridad, guardarlo

**Experiencias (`record_experience`) — DESPUES DE CADA TAREA NO TRIVIAL:**
- Resolucion de bugs, investigaciones, implementaciones, descubrimientos de arquitectura
- **Regla simple: si tardo mas de 2 minutos en hacerlo, probablemente vale la pena guardarlo**

### Recuperacion de memoria tras compactacion
Tras compactacion (`/compact`, `/compress`, o automatica):
1. Llamar a `get_preferences` con el nombre del proyecto para recargar
2. Llamar a `query_memory` si habia trabajo en curso
```

## Tools disponibles

Una vez conectado, el agente obtiene estas herramientas:

| Tool | Qué hace |
|---|---|
| `record_experience` | Guardar lo que se hizo, el resultado y el contexto. Soporta `topic_key` para upserts y `type` opcional (experience, decision, gotcha, discovery). Auto-genera embedding vectorial |
| `record_correction` | Aprender de correcciones del usuario. Auto-genera embedding vectorial |
| `learn_preference` | Almacenar preferencias con alcance global o de proyecto (confianza inicia en 0.3, decae con el tiempo). Dedupe semántico: los valores casi idénticos se fusionan con la preferencia existente |
| `query_memory` | Búsqueda híbrida — FTS5 keywords + vectorial semántica, fusionadas en un score absoluto. Devuelve un índice compacto (límite 8 por defecto); pide el detalle con `get_memory(ids)`. Fallback a FTS5 si embeddings no disponibles |
| `get_memory` | **v3:** Detalle completo de una o varias memorias por id (batch, máximo 20). `timeline: true` añade la línea temporal de ±1 hora alrededor de cada experiencia |
| `get_preferences` | Listar preferencias (merge global + proyecto), acotada por defecto (límite 15, confianza efectiva mínima 0.4, presupuesto de 6.000 caracteres). `key="nombre"` devuelve una preferencia completa; `all: true` lo devuelve todo |
| `memory_stats` | Estadísticas + telemetría de retrieval (media/p95 de caracteres y ~tokens por canal, últimos 30 días). `include: ["patterns"]` añade la lista completa de patrones detectados |
| `forget_memory` | Soft-delete de experiencias por id, tag o proyecto; invalida preferencias de forma reversible (`preference_key`) |
| `prune_memory` | Limpiar datos antiguos, fallidos o de baja confianza |

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
      |-- SQLite + FTS5 (busqueda por keywords)
      |-- sqlite-vec (busqueda vectorial KNN)
      |-- ONNX Runtime (embeddings locales)
      +-- Socket Unix (/tmp/agent-memory.sock)
      |
      v
data/memory.db (tu memoria local)
data/models/ (modelo de embeddings en cache)
```

- **SQLite** — Cero servicios externos, todo en un archivo
- **sqlite-vec** — Extension de busqueda vectorial para SQLite (distancia coseno, KNN brute-force)
- **FTS5** — Busqueda de texto completo integrada en SQLite
- **ONNX Runtime** — Ejecuta el modelo de embeddings localmente (bindings nativos C++, no WASM)
- **all-MiniLM-L6-v2** — Modelo quantizado de 23 MB, 384 dimensiones, ~20ms por embedding
- **Transporte stdio** — Comunicacion MCP directa, sin overhead HTTP
- **Migraciones automaticas** — Las actualizaciones del esquema ocurren de forma transparente

## Almacenamiento de datos

Todos los datos se almacenan localmente. Nada sale de tu maquina (excepto la descarga unica del modelo desde Hugging Face Hub).

- `data/memory.db` — Base de datos SQLite con experiencias, preferencias, patrones y embeddings vectoriales
- `data/models/` — Modelo ONNX de embeddings en cache (auto-descargado en el primer uso)

### Tablas

- **experiences** — Qué pasó, qué se hizo, el resultado
- **preferences** — Pares clave-valor con puntuaciones de confianza, alcances e invalidación reversible (`invalidated_at`, `superseded_by`)
- **patterns** — Observaciones recurrentes con seguimiento de frecuencia
- **vec_experiences / vec_preferences** — Embeddings vectoriales para búsqueda semántica (tablas virtuales sqlite-vec)
- **telemetry** — Tamaño de la salida por canal de retrieval (`ts`, `channel`, `project`, `chars`, `items`), resumida por `memory_stats`

## Mantenimiento: el comando `consolidate`

Ejecútalo a mano o desde cron para mantener la base de datos limpia. Dry-run por defecto — no se modifica nada hasta que pasas `--apply`:

```bash
node build/cli.js consolidate            # solo informe
node build/cli.js consolidate --apply    # ejecutar
```

Detecta pares de preferencias casi duplicadas (similitud coseno por encima del umbral de dedupe) e invalida la más débil de forma reversible, purga experiencias con soft-delete de hace más de 90 días, elimina filas vectoriales huérfanas, reconstruye el índice FTS y hace VACUUM de la base de datos.

## Compatibilidad de plataformas

| Componente | macOS | Linux | Windows |
|---|---|---|---|
| Servidor MCP (Node.js + SQLite) | Si | Si | Si |
| sqlite-vec (binarios npm) | Si (arm64 + x64) | Si (x64) | Aun no (sin binarios precompilados) |
| Embeddings (ONNX Runtime) | Si | Si | Si |
| Socket Unix (hooks) | Si | Si | No (no hay Unix sockets) |
| Script hook (bash + nc) | Si | Si | No (necesita equivalente PowerShell) |

**Soporte completo:** macOS y Linux. El servidor MCP con busqueda hibrida funciona en ambos.

**Soporte parcial:** Windows puede ejecutar el servidor MCP y usar `query_memory` con busqueda hibrida via tools MCP, pero el hook `UserPromptSubmit` (inyeccion automatica de contexto) requiere sockets Unix y bash, que no estan disponibles nativamente. WSL2 deberia funcionar.

## Compatibilidad de agentes

| Caracteristica | Claude Code | Codex CLI | Gemini CLI |
|---|---|---|---|
| Tools MCP (query, record, etc.) | Si | Si | Si |
| Busqueda hibrida (FTS5 + vectorial) | Si | Si | Si |
| Hook UserPromptSubmit (automatico) | **Si** | No | No |
| Contexto auto-inyectado por mensaje | **Si** | No | No |

Todos los agentes compatibles con MCP se benefician de la busqueda hibrida mejorada en `query_memory`. Sin embargo, la inyeccion automatica de contexto via hooks es **exclusiva de Claude Code**. Para Codex CLI y Gemini CLI, anade las instrucciones de carga automatica (ver arriba) a su archivo de instrucciones globales para que el agente llame a `query_memory` proactivamente.

## Requisitos

- Node.js 18+
- Un CLI compatible con MCP (Claude Code, Codex CLI, Gemini CLI o similar)
- Para hooks: `jq` y `nc` (netcat) — incluidos en macOS y la mayoria de distribuciones Linux

## Licencia

MIT
