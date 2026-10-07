/** Minimal in-memory TTL cache that also de-duplicates concurrent loads of the same key. */
export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();
  private readonly inflight = new Map<string, Promise<V>>();

  constructor(private readonly ttlMs: number, private readonly maxEntries = 500) {}

  peek(key: string): V | undefined {
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    return undefined;
  }

  set(key: string, value: V): void {
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  async getOrLoad(key: string, load: () => Promise<V>): Promise<V> {
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
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
}
