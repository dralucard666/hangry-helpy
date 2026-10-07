import { config } from "../config.ts";
import type { BBox } from "./nominatim.ts";

export interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

const AMENITIES = "restaurant|fast_food|cafe|ice_cream|food_court|biergarten";
const SHOPS = "bakery|pastry|ice_cream|confectionery|deli";
/** Overpass' own hard limit; healthy mirrors answer a city-sized bbox in 1–3 s and sick ones never. */
const QUERY_TIMEOUT_S = 15;
const FETCH_TIMEOUT_MS = 20_000;
/** Start the next mirror if the previous one hasn't answered after this long (hedged requests). */
const HEDGE_DELAY_MS = 2500;
/** A mirror that just failed goes to the back of the line for a while. */
const PENALTY_MS = 5 * 60_000;
const MAX_ELEMENTS = 800;

const lastFailure = new Map<string, number>();

/** Bounding boxes are far cheaper for Overpass than `around:` circles; the caller filters by distance. */
export function buildQuery(box: BBox): string {
  const bbox = `(${box.south.toFixed(5)},${box.west.toFixed(5)},${box.north.toFixed(5)},${box.east.toFixed(5)})`;
  return [
    `[out:json][timeout:${QUERY_TIMEOUT_S}];`,
    "(",
    `  nw["amenity"~"^(${AMENITIES})$"]["name"]${bbox};`,
    `  nw["shop"~"^(${SHOPS})$"]["name"]${bbox};`,
    ");",
    `out center tags qt ${MAX_ELEMENTS};`,
  ].join("\n");
}

function orderedEndpoints(): string[] {
  const now = Date.now();
  const penalised = (e: string) => now - (lastFailure.get(e) ?? 0) < PENALTY_MS;
  return [...config.overpassEndpoints].sort((a, b) => Number(penalised(a)) - Number(penalised(b)));
}

/**
 * Public Overpass mirrors are individually unreliable but rarely all slow at once. Hedge: start with
 * the best mirror, add the next one every few seconds while nothing has answered, take the first
 * good response and abort the rest. Worst case is one timeout, not four in a row.
 */
export function queryOverpass(query: string, signal?: AbortSignal): Promise<OverpassElement[]> {
  const endpoints = orderedEndpoints();
  const errors: string[] = [];
  const controllers: AbortController[] = [];
  let settled = false;
  let pending = 0;
  let started = 0;

  return new Promise<OverpassElement[]>((resolve, reject) => {
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      for (const c of controllers) c.abort();
      fn();
    };
    signal?.addEventListener("abort", () => finish(() => reject(new Error("aborted"))), { once: true });

    const launch = () => {
      if (settled || started >= endpoints.length) return;
      const endpoint = endpoints[started++]!;
      const controller = new AbortController();
      controllers.push(controller);
      pending++;
      fetchOverpass(endpoint, query, controller.signal)
        .then((elements) => finish(() => resolve(elements)))
        .catch((err: unknown) => {
          pending--;
          if (settled) return;
          lastFailure.set(endpoint, Date.now());
          errors.push(`${endpoint}: ${describeError(err)}`);
          if (started < endpoints.length) launch();
          else if (pending === 0) finish(() => reject(new OverpassUnavailable(errors)));
        });
      if (started < endpoints.length) setTimeout(launch, HEDGE_DELAY_MS).unref();
    };
    launch();
  });
}

export class OverpassUnavailable extends Error {
  constructor(public readonly attempts: string[]) {
    super("All Overpass mirrors failed");
    this.name = "OverpassUnavailable";
  }
}

async function fetchOverpass(endpoint: string, query: string, signal: AbortSignal): Promise<OverpassElement[]> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": config.userAgent },
    body: new URLSearchParams({ data: query }).toString(),
    signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
  });
  const text = await res.text();
  if (!res.ok || !text.trimStart().startsWith("{")) throw new Error(`HTTP ${res.status}${text.includes("too busy") ? " (busy)" : ""}`);
  const json = JSON.parse(text) as { elements?: OverpassElement[]; remark?: string };
  if (json.remark && !json.elements?.length) throw new Error(json.remark);
  return json.elements ?? [];
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "AbortError" || err.name === "TimeoutError") return "timed out";
    return err.message;
  }
  return String(err);
}
