import fs from "node:fs";
import path from "node:path";

/**
 * TTL cache that mirrors itself to a JSON file so dev restarts (tsx watch) and production restarts
 * don't re-query OpenStreetMap or re-profile every place. Loads lazily, writes debounced.
 */
export class DiskCache<V> {
  private entries = new Map<string, { value: V; expiresAt: number }>();
  private loaded = false;
  private dirty = false;
  private flushTimer: NodeJS.Timeout | undefined;
  private readonly inflight = new Map<string, Promise<V>>();

  constructor(private readonly file: string, private readonly ttlMs: number, private readonly maxEntries = 5000) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<string, { value: V; expiresAt: number }>;
      const now = Date.now();
      for (const [k, e] of Object.entries(raw)) if (e.expiresAt > now) this.entries.set(k, e);
    } catch {
      /* no cache yet or unreadable: start empty */
    }
  }

  peek(key: string): V | undefined {
    this.load();
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    return undefined;
  }

  set(key: string, value: V): void {
    this.load();
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.scheduleFlush();
  }

  async getOrLoad(key: string, load: () => Promise<V>): Promise<V> {
    const hit = this.peek(key);
    if (hit !== undefined) return hit;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const p = load()
      .then((value) => {
        this.set(key, value);
        return value;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  get size(): number {
    this.load();
    return this.entries.size;
  }

  private scheduleFlush(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, 1000);
    this.flushTimer.unref();
  }

  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.entries)));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.warn(`cache: could not write ${this.file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
