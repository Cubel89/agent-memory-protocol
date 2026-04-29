# Agent Memory Protocol

**Dale a tus agentes de IA memoria persistente entre sesiones — ahora con busqueda semantica.**

Un servidor MCP (Model Context Protocol) que permite a los agentes de IA recordar experiencias, aprender de correcciones y adaptarse a tus preferencias. v2.0.0 anade **busqueda vectorial semantica** con un modelo de embeddings local que se auto-descarga en el primer uso. Funciona con Claude Code, Codex CLI, Gemini CLI y cualquier cliente compatible con MCP.

## Que hace

- **Busqueda semantica** — Encuentra memorias por significado, no solo por palabras. "Como arregle lo de los pagos?" encuentra experiencias sobre facturacion, cobros y transacciones
- **Busqueda hibrida** — Combina FTS5 (keywords) + similitud vectorial con Reciprocal Rank Fusion para lo mejor de ambos mundos
- **Embeddings locales** — Modelo all-MiniLM-L6-v2 (23 MB) corre localmente via ONNX. Se auto-descarga en el primer uso, funciona 100% offline despues
- **Socket Unix para hooks** — El servidor MCP expone un socket local para que los hooks de Claude Code hagan busqueda semantica en ~25ms por consulta
- **Recuerda experiencias** — Que funciono, que fallo, en que contexto
- **Aprende de correcciones** — Cada vez que corriges al agente, registra la leccion
- **Se adapta a preferencias** — Detecta patrones en como trabajas y los recuerda
- **Memoria con alcance** — Preferencias globales + overrides por proyecto
- **Deteccion de patrones** — Identifica errores recurrentes y workflows exitosos
- **Deduplicacion automatica** — Hash SHA-256 con ventana de 15 minutos evita entradas duplicadas
- **Topic upserts** — Los temas recurrentes se actualizan en lugar de crear duplicados
- **Decay de confianza** — Las preferencias pierden confianza con el tiempo si no se re-confirman
- **Soft delete** — Las memorias eliminadas pueden recuperarse (marcadas, no destruidas)
- **Hooks de Claude Code** — Inyecta contexto automaticamente antes de cada respuesta via hook `UserPromptSubmit`
- **Gestion de memoria** — Olvida memorias especificas o limpia datos obsoletos automaticamente

## Novedades en v2.0.0

| Caracteristica | v1.x | v2.0.0 |
|---|---|---|
| Busqueda | Solo FTS5 (keywords) | **Hibrida: FTS5 + vectorial semantica** |
| Hook | Solo SessionStart | **UserPromptSubmit** (cada mensaje) |
| Inyeccion de contexto | Manual (el agente decide) | **Automatica** (hook inyecta antes de cada respuesta) |
| Modelo de embeddings | Ninguno | **all-MiniLM-L6-v2** (23 MB, 384 dims, ONNX local) |
| Almacen vectorial | Ninguno | **sqlite-vec** (distancia coseno, ~2ms KNN) |

### Arquitectura

```
El usuario envia un mensaje
       |
  [Hook UserPromptSubmit]  <- dispara automaticamente
       |
       | envia prompt via socket Unix
       v
  [Servidor MCP]  <- ya corriendo, modelo en RAM
       |
       | 1. Genera embedding (~20ms)
       | 2. Busqueda hibrida: FTS5 + vector KNN + RRF merge
       | 3. Carga preferencias + correcciones
       v
  Devuelve contexto relevante
       |
  [Hook devuelve additionalContext]
       |
  El agente recibe el mensaje + contexto de memoria INYECTADO
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
| Soporte de hooks | Si (v2.0.0) | No | No |

## Hooks de Claude Code (v2.0.0)

v2.0.0 introduce un **servidor de socket Unix** que permite a los hooks de Claude Code hacer busqueda semantica con latencia casi nula. El servidor MCP carga el modelo de embeddings una vez y lo mantiene en RAM, asi los hooks no necesitan cargarlo en cada peticion.

El hook clave es `UserPromptSubmit`, que dispara **antes de cada mensaje del usuario**. Esto significa que Claude siempre tiene contexto de memoria relevante inyectado automaticamente — sin depender de que el LLM recuerde llamar a las tools.

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
| `session-start.sh` | Inicio de sesión (startup, resume, compact, clear) | Intenta socket Unix para contexto con búsqueda híbrida (vector + FTS5 + patrones + correcciones), cae a `cli.js get_context` (solo FTS5 + recientes) si el socket no está disponible |
| `on-prompt.sh` | Cada mensaje del usuario | Envía el prompt al socket Unix, obtiene resultados de búsqueda semántica + datos del usuario + preferencias + correcciones, inyecta como texto plano |

**Requisitos:** `jq` y `nc` (netcat) — ambos incluidos en macOS y la mayoria de distribuciones Linux.

> **Importante:** El hook devuelve **texto plano** (no JSON `additionalContext`). Esto asegura que Claude Code lo inyecta como un `system-reminder` visible que el LLM no puede ignorar. Usar JSON `additionalContext` resultaba en que el LLM descartaba el contexto silenciosamente.

### Como funciona

1. Cuando el servidor MCP arranca, abre un socket Unix en `/tmp/agent-memory.sock` y pre-carga el modelo de embeddings
2. En cada mensaje del usuario, `on-prompt.sh` envia el prompt al socket
3. El servidor genera un embedding, ejecuta busqueda hibrida (FTS5 + vector KNN en experiencias Y preferencias), y construye un texto de contexto
4. El hook devuelve el contexto como texto plano — Claude Code lo inyecta como `system-reminder`
5. Latencia total: **~25ms** (20ms embedding + 2ms busqueda vectorial + 3ms FTS5)
6. Las preferencias personales (`user_*`) se incluyen **siempre**, independientemente de la relevancia de busqueda

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

| Tool | Que hace |
|---|---|
| `record_experience` | Guardar lo que se hizo, el resultado y el contexto. Soporta `topic_key` para upserts y `type` opcional (experience, decision, gotcha, discovery). **v2: auto-genera embedding vectorial** |
| `record_correction` | Aprender de correcciones del usuario. **v2: auto-genera embedding vectorial** |
| `learn_preference` | Almacenar preferencias con alcance global o de proyecto (confianza inicia en 0.3, decae con el tiempo) |
| `query_memory` | **v2: Búsqueda híbrida** — FTS5 keywords + vectorial semántica + RRF merge. Resultados compactos (80 chars, límite 8 por defecto). Usa `get_experience(id)` para detalle. Fallback a FTS5 si embeddings no disponibles |
| `get_experience` | Obtener detalle completo de una experiencia por ID |
| `get_timeline` | Obtener contexto cronologico alrededor de una experiencia |
| `get_patterns` | Ver patrones recurrentes (errores, exitos) |
| `get_preferences` | Listar preferencias con confianza efectiva (merge global + proyecto) |
| `memory_stats` | Dashboard con estadisticas de la memoria |
| `forget_memory` | Soft-delete de memorias especificas por id, tag o proyecto |
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

- **experiences** — Que paso, que se hizo, el resultado
- **preferences** — Pares clave-valor con puntuaciones de confianza y alcances
- **patterns** — Observaciones recurrentes con seguimiento de frecuencia
- **vec_experiences** — Embeddings vectoriales para busqueda semantica (tabla virtual sqlite-vec)

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
