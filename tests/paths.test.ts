// Tests para la normalización de paths del sandbox.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  normalizeForStorage,
  resolveFromStorage,
  normalizeTextPaths,
  resolveTextPaths,
  detectSandboxRoot,
  SANDBOX_TOKEN,
  _resetSandboxRootCache,
} from "../src/paths.js";

const ORIGINAL_ENV = process.env.SANDBOX_ROOT;

beforeEach(() => {
  _resetSandboxRootCache();
  // Forzar detección desde env var en cada test.
  process.env.SANDBOX_ROOT = "/Users/cubel/.sandbox";
});

afterEach(() => {
  _resetSandboxRootCache();
  if (ORIGINAL_ENV === undefined) {
    delete process.env.SANDBOX_ROOT;
  } else {
    process.env.SANDBOX_ROOT = ORIGINAL_ENV;
  }
});

describe("normalizeForStorage (path único)", () => {
  it("sustituye el prefijo del sandbox por el token", () => {
    expect(
      normalizeForStorage("/Users/cubel/.sandbox/.proyectos/foo")
    ).toBe(`${SANDBOX_TOKEN}/.proyectos/foo`);
  });

  it("sustituye exactamente el sandbox root", () => {
    expect(normalizeForStorage("/Users/cubel/.sandbox")).toBe(SANDBOX_TOKEN);
  });

  it("deja paths fuera del sandbox sin cambios", () => {
    expect(normalizeForStorage("/tmp/otro")).toBe("/tmp/otro");
  });
});

describe("resolveFromStorage (path único)", () => {
  it("expande el token al sandbox actual", () => {
    expect(
      resolveFromStorage(`${SANDBOX_TOKEN}/.proyectos/foo`)
    ).toBe("/Users/cubel/.sandbox/.proyectos/foo");
  });

  it("resuelve el token solo", () => {
    expect(resolveFromStorage(SANDBOX_TOKEN)).toBe("/Users/cubel/.sandbox");
  });
});

describe("normalizeTextPaths (texto libre)", () => {
  it("reemplaza ocurrencias del sandbox actual en texto", () => {
    const input =
      "Bash: find /Users/cubel/.sandbox/.proyectos -maxdepth 1 -type d";
    expect(normalizeTextPaths(input)).toBe(
      `Bash: find ${SANDBOX_TOKEN}/.proyectos -maxdepth 1 -type d`
    );
  });

  it("reemplaza también el sandbox histórico sin punto en otra máquina", () => {
    const input =
      "Bash: cp /Users/cubel/sandbox/backups/memoria/x.db /tmp/";
    expect(normalizeTextPaths(input)).toBe(
      `Bash: cp ${SANDBOX_TOKEN}/backups/memoria/x.db /tmp/`
    );
  });

  it("reemplaza el sandbox de PhpstormProjects (histórico)", () => {
    const input =
      "Edit /Users/cubel/PhpstormProjects/sandbox/.proyectos/x";
    expect(normalizeTextPaths(input)).toBe(
      `Edit ${SANDBOX_TOKEN}/.proyectos/x`
    );
  });

  it("evita falsos positivos con `sandbox-backup`", () => {
    const input = "Carpeta /Users/cubel/sandbox-backup/x está fuera del sandbox";
    // No debe normalizar porque tras `sandbox` hay un `-`, no `/`.
    expect(normalizeTextPaths(input)).toBe(input);
  });

  it("reemplaza múltiples paths en un mismo texto", () => {
    const input =
      "from /Users/cubel/.sandbox/.proyectos/a to /Users/cubel/sandbox/.proyectos/b";
    expect(normalizeTextPaths(input)).toBe(
      `from ${SANDBOX_TOKEN}/.proyectos/a to ${SANDBOX_TOKEN}/.proyectos/b`
    );
  });

  it("texto vacío o sin paths no se modifica", () => {
    expect(normalizeTextPaths("")).toBe("");
    expect(normalizeTextPaths("solo texto plano")).toBe("solo texto plano");
  });
});

describe("resolveTextPaths (texto libre)", () => {
  it("expande todos los tokens al sandbox actual", () => {
    const input = `Lee ${SANDBOX_TOKEN}/.proyectos/foo y ${SANDBOX_TOKEN}/.proyectos/bar`;
    expect(resolveTextPaths(input)).toBe(
      "Lee /Users/cubel/.sandbox/.proyectos/foo y /Users/cubel/.sandbox/.proyectos/bar"
    );
  });

  it("deja texto sin token sin cambios", () => {
    expect(resolveTextPaths("texto sin token")).toBe("texto sin token");
  });
});

describe("portabilidad: guardar en una máquina, leer en otra", () => {
  it("texto normalizado en máquina con `.sandbox` resuelve en máquina con `sandbox`", () => {
    // Guardado en máquina A
    const stored = normalizeTextPaths(
      "Edit /Users/cubel/.sandbox/.proyectos/atellum_web/x.php"
    );
    expect(stored).toBe(
      `Edit ${SANDBOX_TOKEN}/.proyectos/atellum_web/x.php`
    );

    // Leído en máquina B (sin punto)
    _resetSandboxRootCache();
    process.env.SANDBOX_ROOT = "/Users/cubel/sandbox";
    expect(resolveTextPaths(stored)).toBe(
      "Edit /Users/cubel/sandbox/.proyectos/atellum_web/x.php"
    );
  });
});

describe("detectSandboxRoot", () => {
  it("respeta SANDBOX_ROOT env var", () => {
    expect(detectSandboxRoot()).toBe("/Users/cubel/.sandbox");
  });
});
