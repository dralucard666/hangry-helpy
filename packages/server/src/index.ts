/**
 * Entry point. Three jobs:
 *   1. start the HTTP server (API + static frontend),
 *   2. load the decision model in the background,
 *   3. route /api/recommend → recommend() and /api/health → model status.
 */
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { DIETS, HUNGER_LEVELS, TASTES, VIBES } from "@hangry/shared";
import { Model } from "./model.ts";
import { HttpError, recommend } from "./recommend.ts";

const PORT = Number(process.env["PORT"] ?? 3000);
const WEB_DIR = path.resolve(import.meta.dirname, "../../web/public");

// What the frontend may send. Every field except city has a default.
const preferencesSchema = z.object({
  city: z.string().trim().min(1).max(200),
  radiusMeters: z.number().int().min(300).max(25_000).default(3000),
  diet: z.enum(DIETS).default("any"),
  taste: z.enum(TASTES).default("either"),
  budget: z.number().min(0).max(100).default(50),
  healthiness: z.number().min(0).max(100).default(50),
  adventurousness: z.number().min(0).max(100).default(50),
  vibe: z.enum(VIBES).default("sit-down"),
  hunger: z.enum(HUNGER_LEVELS).default("normal"),
  craving: z.string().trim().max(200).default(""),
});

const model = new Model(process.env["MODEL_URI"] ?? "hf:Qwen/Qwen3-1.7B-GGUF:Q8_0");
const app = express();
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({ ok: model.status.phase === "ready", model: model.status });
});

app.post("/api/recommend", async (req, res, next) => {
  try {
    const parsed = preferencesSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, `Invalid preferences: ${z.prettifyError(parsed.error)}`);
    res.json(await recommend(model, parsed.data));
  } catch (err) {
    next(err);
  }
});

app.use(express.static(WEB_DIR));

// Any error thrown above ends up here and becomes a JSON response.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error(err);
  res.status(500).json({ error: "Internal error" });
});

app.listen(PORT, "127.0.0.1", () => console.log(`Hangry Helpy on http://127.0.0.1:${PORT}`));
model.start().catch((err) => {
  model.status = { phase: "error", name: String(model.status.name), error: String(err) };
});
