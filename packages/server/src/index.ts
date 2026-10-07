import { createApp } from "./app.ts";
import { config } from "./config.ts";
import { flushPlacesCache } from "./places/index.ts";
import { flushProfileCaches } from "./profile.ts";
import { SystemOneEngine } from "./systemOne/engine.ts";

const log = (msg: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

const engine = new SystemOneEngine({
  modelUri: config.modelUri,
  modelsDir: config.modelsDir,
  sequences: config.modelSequences,
  contextSize: config.modelContextSize,
  gpu: config.gpu,
  readoutTemperature: config.readoutTemperature,
  log: (m) => log(`model: ${m}`),
});

const app = createApp(engine, log);
const server = app.listen(config.port, config.host, () => {
  log(`hangry-helpy listening on http://${config.host}:${config.port} (serving ${config.webDir})`);
});

// The model loads while the HTTP server is already up; /api/health reports progress to the UI.
engine.start().catch(() => {
  /* status is exposed via /api/health; keep the server up so the UI can show the error */
});


const shutdown = async () => {
  log("shutting down");
  server.close();
  flushPlacesCache();
  flushProfileCaches();
  await engine.stop().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
