// Normalización de paths para portabilidad entre máquinas.
//
// El usuario trabaja en varios equipos con la carpeta sandbox en distintos
// sitios (`~/.sandbox` en uno, `~/sandbox` en otro, etc.). Si guardamos los
// paths absolutos tal cual, las experiencias almacenadas en una máquina
// quedan obsoletas en otra. Sustituimos el prefijo del sandbox por el token
// `$SANDBOX_ROOT` al guardar, y lo expandimos al path real al leer.
//
// Funciones:
//   - detectSandboxRoot(): localiza el sandbox de la máquina actual.
//   - normalizeForStorage(path): para un path único (campo path-only).
//   - resolveFromStorage(stored): inverso de normalizeForStorage.
//   - normalizeTextPaths(text): para texto libre con paths embebidos.
//   - resolveTextPaths(text): inverso de normalizeTextPaths.

import * as fs from "node:fs";
import * as os from "node:os";

export const SANDBOX_TOKEN = "$SANDBOX_ROOT";

let cached: string | null | undefined = undefined;

export function detectSandboxRoot(): string | null {
  if (cached !== undefined) return cached;

  if (process.env.SANDBOX_ROOT) {
    cached = process.env.SANDBOX_ROOT;
    return cached;
  }

  const home = os.homedir();
  const candidates = [`${home}/.sandbox`, `${home}/sandbox`];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory()) {
        cached = candidate;
        return cached;
      }
    } catch {
      // Continuar al siguiente candidato.
    }
  }

  cached = null;
  return null;
}

// ── Path único (un solo path en el string) ─────────────────────────

export function normalizeForStorage(absolutePath: string): string {
  const root = detectSandboxRoot();
  if (!root) return absolutePath;
  if (absolutePath === root) return SANDBOX_TOKEN;
  if (absolutePath.startsWith(root + "/")) {
    return SANDBOX_TOKEN + absolutePath.slice(root.length);
  }
  return absolutePath;
}

export function resolveFromStorage(storedPath: string): string {
  if (!storedPath.startsWith(SANDBOX_TOKEN)) return storedPath;
  const root = detectSandboxRoot();
  if (!root) return storedPath;
  return root + storedPath.slice(SANDBOX_TOKEN.length);
}

// ── Texto libre con paths embebidos ────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Reemplaza dentro de `text` todas las ocurrencias del sandbox actual
 * (y de sandboxes conocidos en otras máquinas) por el token `$SANDBOX_ROOT`.
 *
 * Reemplaza tanto la ruta del sandbox detectada en esta máquina como las
 * variantes históricas habituales (`~/.sandbox`, `~/sandbox`,
 * `~/PhpstormProjects/sandbox`), para que un texto recién guardado quede
 * portable aunque el modelo lo escribiera con un path absoluto literal.
 *
 * El lookahead `(?=/|$|[^\w.-])` evita reemplazos parciales en nombres que
 * empiezan parecido pero no son el sandbox (p.ej. `sandbox-backup`).
 */
export function normalizeTextPaths(text: string): string {
  if (!text) return text;
  const home = os.homedir();
  const variants = new Set<string>();
  const detected = detectSandboxRoot();
  if (detected) variants.add(detected);
  variants.add(`${home}/.sandbox`);
  variants.add(`${home}/sandbox`);
  variants.add(`${home}/PhpstormProjects/sandbox`);

  let out = text;
  // Ordenar por longitud descendente: primero los más específicos para que
  // `.sandbox` no se coma `sandbox` (aunque por las variantes esto ya está
  // controlado, ser conservadores).
  const sorted = [...variants].sort((a, b) => b.length - a.length);
  for (const v of sorted) {
    const regex = new RegExp(escapeRegex(v) + "(?=/|$|[^\\w.-])", "g");
    out = out.replace(regex, SANDBOX_TOKEN);
  }
  return out;
}

/**
 * Reemplaza todas las apariciones del token por el path absoluto del
 * sandbox detectado en esta máquina. Si no se detecta sandbox, devuelve el
 * texto tal cual.
 */
export function resolveTextPaths(text: string): string {
  if (!text) return text;
  const root = detectSandboxRoot();
  if (!root) return text;
  return text.split(SANDBOX_TOKEN).join(root);
}

// Solo para tests.
export function _resetSandboxRootCache(): void {
  cached = undefined;
}
