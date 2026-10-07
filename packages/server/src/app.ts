import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { ApiError, HealthResponse } from "@hangry/shared";
import { config } from "./config.ts";
import { recommend } from "./recommend.ts";
import { preferencesSchema } from "./schema.ts";
import type { SystemOneEngine } from "./systemOne/engine.ts";
import { HttpError } from "./util/http.ts";

export function createApp(engine: SystemOneEngine, log: (msg: string) => void) {
  const app = express();
  const startedAt = Date.now();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));

  app.get("/api/health", (_req, res) => {
    const s = engine.getStatus();
    const body: HealthResponse = { ok: s.phase === "ready", model: s, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) };
    res.status(s.phase === "error" ? 500 : 200).json(body);
  });

  app.post("/api/recommend", async (req, res, next) => {
    try {
      const parsed = preferencesSchema.safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, "Invalid preferences", z.treeifyError(parsed.error));
      const result = await recommend(engine, parsed.data, { log, includeAll: req.query["debug"] === "1" });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found" } satisfies ApiError);
  });

  app.use(express.static(config.webDir, { extensions: ["html"], maxAge: 0 }));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      if (err.status >= 500) log(`error ${err.status}: ${err.message} ${JSON.stringify(err.details ?? "")}`);
      const body: ApiError = { error: err.message };
      if (err.details !== undefined) body.details = err.details;
      res.status(err.status).json(body);
      return;
    }
    if (err && typeof err === "object" && "type" in err && (err as { type?: string }).type === "entity.parse.failed") {
      res.status(400).json({ error: "Body must be valid JSON" } satisfies ApiError);
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    log(`unhandled error: ${err instanceof Error ? err.stack ?? message : message}`);
    res.status(500).json({ error: "Internal error", details: message } satisfies ApiError);
  });

  return app;
}
