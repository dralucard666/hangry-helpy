/**
 * A Map that survives restarts: written to a JSON file in ./.cache a second after each change.
 * Used for OpenStreetMap results and model profiles so a dev restart doesn't redo slow work.
 */
import fs from "node:fs";
import path from "node:path";

export function jsonCache<T>(name: string, ttlMs: number) {
  const file = path.resolve(import.meta.dirname, "../../../.cache", `${name}.json`);
  let entries: Record<string, { value: T; expires: number }> = {};
  try {
    entries = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    /* first run */
  }
  let timer: NodeJS.Timeout | undefined;
  return {
    get(key: string): T | undefined {
      const e = entries[key];
      return e && e.expires > Date.now() ? e.value : undefined;
    },
    set(key: string, value: T): void {
      entries[key] = { value, expires: Date.now() + ttlMs };
      clearTimeout(timer);
      timer = setTimeout(() => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(entries));
      }, 1000);
      timer.unref();
    },
  };
}
