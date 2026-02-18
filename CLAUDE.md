# agent-memory-protocol

## Reglas del proyecto

### Sin documentación en este repositorio
Este repositorio es SOLO código fuente del MCP. **NUNCA** crear carpetas ni archivos de documentación aquí:
- No crear `docs/`, `investigaciones/`, `planes/`, `planificaciones/`
- No crear archivos `.md` que no sean README.md o README_ES.md
- Toda documentación, investigaciones y planes van en el proyecto **sandbox**:
  - Investigaciones: `sandbox/docs/investigaciones/`
  - Planes: `sandbox/planificaciones/agent-memory-protocol/`

### Flujo de desarrollo
1. Los cambios se hacen aquí (`.proyectos/agent-memory-protocol/`)
2. Se copian a `~/.agent-memory-protocol/` (versión en funcionamiento)
3. Se hace build: `cd ~/.agent-memory-protocol && npm run build`
