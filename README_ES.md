# Agent Memory Protocol

**Dale a tus agentes de IA memoria persistente entre sesiones.**

Un servidor MCP (Model Context Protocol) que permite a los agentes de IA recordar experiencias, aprender de correcciones y adaptarse a tus preferencias. Funciona con Claude Code, Codex CLI, Gemini CLI y cualquier cliente compatible con MCP.

## Que hace

- **Recuerda experiencias** — Que funciono, que fallo, en que contexto
- **Aprende de correcciones** — Cada vez que corriges al agente, registra la leccion
- **Se adapta a preferencias** — Detecta patrones en como trabajas y los recuerda
- **Memoria con alcance** — Preferencias globales + overrides por proyecto
- **Busqueda de texto completo** — Encuentra experiencias pasadas relevantes al instante
- **Deteccion de patrones** — Identifica errores recurrentes y workflows exitosos
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

## Compatibilidad entre CLIs

| Caracteristica | Claude Code | Codex CLI | Gemini CLI |
|---|---|---|---|
| Comando MCP add | `claude mcp add` | `codex mcp add` | `gemini mcp add` |
| Formato de config | JSON (`~/.claude.json`) | TOML (`~/.codex/config.toml`) | JSON (`~/.gemini/settings.json`) |
| Instrucciones globales | `~/.claude/CLAUDE.md` | `~/.codex/AGENTS.md` | `~/.gemini/GEMINI.md` |
| Flag de alcance global | `--scope user` | — | — |

## Carga automatica al inicio

Para que el agente consulte su memoria automaticamente al inicio de cada sesion, añade el siguiente snippet al archivo de instrucciones globales de tu CLI.

- **Claude Code** — `~/.claude/CLAUDE.md`
- **Codex CLI** — `~/.codex/AGENTS.md`
- **Gemini CLI** — `~/.gemini/GEMINI.md`

```markdown
## Memoria persistente (MCP: agent-memory)

Al inicio de cada sesion, SIEMPRE:
1. Llamar a `get_preferences` con el nombre del proyecto actual
2. Aplicar esas preferencias durante toda la sesion

Cuando el usuario te corrija:
- Usar `record_correction` para registrar la leccion
- Usar `learn_preference` si detectas una nueva preferencia

Cuando resuelvas algo complejo:
- Usar `record_experience` para que futuras sesiones se beneficien
```

## Tools disponibles

Una vez conectado, el agente obtiene estas herramientas:

| Tool | Que hace |
|---|---|
| `record_experience` | Guardar lo que se hizo, el resultado y el contexto |
| `record_correction` | Aprender de correcciones del usuario (compilador de intenciones) |
| `learn_preference` | Almacenar preferencias con alcance global o de proyecto |
| `query_memory` | Buscar experiencias pasadas por texto completo |
| `get_patterns` | Ver patrones recurrentes (errores, exitos) |
| `get_preferences` | Listar preferencias aprendidas (merge global + proyecto) |
| `memory_stats` | Dashboard con estadisticas de la memoria |
| `forget_memory` | Eliminar memorias especificas por id, tag o proyecto |
| `prune_memory` | Limpiar datos antiguos, fallidos o de baja confianza |

### forget_memory

Elimina memorias especificas de la base de datos. Requiere al menos un parametro.

| Parametro | Tipo | Descripcion |
|---|---|---|
| `id` | number (opcional) | Eliminar una experiencia por su ID |
| `tag` | string (opcional) | Eliminar todas las experiencias que coincidan con un tag |
| `project` | string (opcional) | Eliminar todas las experiencias de un proyecto |

Devuelve el numero de registros eliminados.

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
