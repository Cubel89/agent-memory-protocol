import { pipeline, env } from "@huggingface/transformers";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Configuration ────────────────────────────────────────
const MODEL = "Xenova/all-MiniLM-L6-v2";
const DTYPE = "q8" as const;
export const EMBEDDING_DIMS = 384;

// Cache models in data/models/ (auto-downloaded on first use)
env.cacheDir = path.join(__dirname, "..", "data", "models");

// ── Singleton pipeline ───────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let extractorPromise: Promise<any> | null = null;

function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = pipeline("feature-extraction", MODEL, { dtype: DTYPE } as any);
  }
  return extractorPromise;
}

// ── Public API ───────────────────────────────────────────

/** Genera embedding de un texto. Retorna Float32Array(384) o null si falla. */
export async function getEmbedding(text: string): Promise<Float32Array | null> {
  try {
    const extractor = await getExtractor();
    const result = await extractor(text, { pooling: "mean", normalize: true });
    return new Float32Array(result.data);
  } catch (err) {
    console.error("Error generando embedding:", err);
    return null;
  }
}

/** Genera embeddings de múltiples textos (batch). Retorna array o null si falla. */
export async function getEmbeddings(texts: string[]): Promise<Float32Array[] | null> {
  if (texts.length === 0) return [];
  try {
    const extractor = await getExtractor();
    const result = await extractor(texts, { pooling: "mean", normalize: true });
    const data = result.data as Float32Array;
    const embeddings: Float32Array[] = [];
    for (let i = 0; i < texts.length; i++) {
      embeddings.push(
        new Float32Array(data.slice(i * EMBEDDING_DIMS, (i + 1) * EMBEDDING_DIMS))
      );
    }
    return embeddings;
  } catch (err) {
    console.error("Error generando embeddings batch:", err);
    return null;
  }
}

/** Pre-load the model in background (non-blocking). */
export function preloadModel(): void {
  getExtractor().catch((err) =>
    console.error("Model preload failed:", err)
  );
}
