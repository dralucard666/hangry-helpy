import path from "node:path";
import fs from "node:fs";

/** Walk up from this file until the workspace root (the dir with pnpm-workspace.yaml). */
function findWorkspaceRoot(): string {
  let dir = import.meta.dirname;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(import.meta.dirname, "../../..");
}

const root = findWorkspaceRoot();
const env = process.env;

function int(name: string, fallback: number): number {
  const v = env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Env ${name} must be a number, got "${v}"`);
  return n;
}

export const config = {
  port: int("PORT", 3000),
  host: env["HOST"] ?? "127.0.0.1",
  workspaceRoot: root,
  webDir: env["WEB_DIR"] ?? path.join(root, "packages/web/public"),
  modelsDir: env["MODELS_DIR"] ?? path.join(root, "models"),
  /** JSON caches for OSM results and place profiles live here (safe to delete). */
  cacheDir: env["CACHE_DIR"] ?? path.join(root, ".cache"),
  /**
   * node-llama-cpp model URI. Qwen3 ships official GGUFs; 0.6B (~640 MB) is the OpenJev "test lane",
   * 1.7B (~1.8 GB) is noticeably better at reading restaurant descriptions and still fast on a laptop.
   */
  modelUri: env["MODEL_URI"] ?? "hf:Qwen/Qwen3-1.7B-GGUF:Q8_0",
  /** Parallel sequences in the llama context; each handles one restaurant at a time. */
  modelSequences: int("MODEL_SEQUENCES", 8),
  modelContextSize: int("MODEL_CONTEXT_SIZE", 1024),
  readoutTemperature: Number(env["MODEL_READOUT_TEMPERATURE"] ?? "2"),
  gpu: (env["MODEL_GPU"] ?? "auto") as "auto" | "metal" | "cuda" | "vulkan" | false,
  /** How many OSM places to hand to the decision model. */
  maxCandidates: int("MAX_CANDIDATES", 30),
  defaultRadiusMeters: int("DEFAULT_RADIUS_METERS", 3000),
  placesCacheTtlMs: int("PLACES_CACHE_TTL_MS", 12 * 60 * 60 * 1000),
  profileCacheTtlMs: int("PROFILE_CACHE_TTL_MS", 7 * 24 * 60 * 60 * 1000),
  /** Required by the OSM usage policies: identify the application. */
  userAgent: env["OSM_USER_AGENT"] ?? "hangry-helpy/0.1 (local dev; https://github.com/jonasbrossmann/hangry-help)",
  overpassEndpoints: (env["OVERPASS_ENDPOINTS"] ??
    "https://overpass.openstreetmap.fr/api/interpreter,https://overpass-api.de/api/interpreter,https://lz4.overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter,https://overpass.private.coffee/api/interpreter"
  ).split(",").map((s) => s.trim()).filter(Boolean),
  nominatimEndpoint: env["NOMINATIM_ENDPOINT"] ?? "https://nominatim.openstreetmap.org",
} as const;
