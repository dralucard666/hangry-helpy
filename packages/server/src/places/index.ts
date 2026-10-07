import path from "node:path";
import type { Restaurant } from "@hangry/shared";
import { config } from "../config.ts";
import { DiskCache } from "../util/diskCache.ts";
import { haversineMeters } from "../util/geo.ts";
import { HttpError } from "../util/http.ts";
import { buildRestaurant } from "./describe.ts";
import { searchCategory, type BBox } from "./nominatim.ts";
import { OverpassUnavailable, buildQuery, queryOverpass, type OverpassElement } from "./overpass.ts";

interface AreaEntry {
  lat: number;
  lon: number;
  radius: number;
  source: "overpass" | "nominatim";
  fetchedAt: number;
  places: Restaurant[];
}

/** Keyed by a ~1 km grid cell; each entry remembers the circle it was fetched for. */
const cache = new DiskCache<AreaEntry>(path.join(config.cacheDir, "places-v2.json"), config.placesCacheTtlMs, 300);

/** If Overpass hasn't answered after this long, also ask Nominatim and take whichever comes first. */
const FALLBACK_AFTER_MS = 6000;
/** Nominatim results are thinner (≤50 per category), so retry Overpass for that cell sooner. */
const NOMINATIM_TTL_MS = 30 * 60_000;
const NOMINATIM_CATEGORIES = ["restaurant", "fast_food", "cafe", "bakery", "ice_cream"];

export function flushPlacesCache(): void {
  cache.flush();
}

export interface FoodPlacesResult {
  places: Restaurant[];
  source: AreaEntry["source"];
  cached: boolean;
}

/**
 * All named food places within `radius` metres of a point, nearest first.
 * One fetch serves every later request from the same ~1 km cell with the same or a smaller radius;
 * distances are recomputed from the actual origin.
 */
export async function findFoodPlaces(lat: number, lon: number, radius: number, log: (m: string) => void = () => {}): Promise<FoodPlacesResult> {
  const cell = cellKey(lat, lon);
  const covers = (e: AreaEntry) => haversineMeters(e.lat, e.lon, lat, lon) + radius <= e.radius;
  const fresh = (e: AreaEntry) => e.source === "overpass" || Date.now() - e.fetchedAt < NOMINATIM_TTL_MS;
  // A fetch made for a neighbouring cell may well cover this point too (cells are ~1 km, radii are bigger).
  let entry: AreaEntry | undefined;
  for (const key of neighbourCells(lat, lon)) {
    const e = cache.peek(key);
    if (e && covers(e) && fresh(e)) {
      entry = e;
      break;
    }
  }
  const wasCached = entry !== undefined;
  if (!entry) {
    // Fetch a bit more than asked so neighbouring points in the same cell and small radius bumps hit too.
    const fetchRadius = Math.max(radius * 1.25, radius + 1000);
    entry = await cache.getOrLoad(`${cell}|${Math.round(fetchRadius)}`, () => fetchArea(lat, lon, fetchRadius, cell, log));
    cache.set(cell, entry);
  }
  return {
    places: entry.places
      .map((r) => ({ ...r, distanceMeters: haversineMeters(lat, lon, r.lat, r.lon) }))
      .filter((r) => r.distanceMeters <= radius)
      .sort((a, b) => a.distanceMeters - b.distanceMeters),
    source: entry.source,
    cached: wasCached,
  };
}

/**
 * Overpass first (rich tags, everything in the area). If it is slow, Nominatim's category search joins
 * the race; whichever answers first is used. A late Overpass answer still upgrades the cache.
 */
async function fetchArea(lat: number, lon: number, radius: number, cell: string, log: (m: string) => void): Promise<AreaEntry> {
  const box = bboxAround(lat, lon, radius);
  const t0 = performance.now();
  const abortNominatim = new AbortController();

  const viaOverpass = queryOverpass(buildQuery(box)).then((elements): AreaEntry => {
    abortNominatim.abort();
    const places = dedupe(elements.map(fromOverpass).filter((r): r is Restaurant => !!r));
    log(`overpass: ${places.length} places in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    return { lat, lon, radius, source: "overpass", fetchedAt: Date.now(), places };
  });

  const viaNominatim = sleep(FALLBACK_AFTER_MS, abortNominatim.signal).then(async (): Promise<AreaEntry> => {
    const places: Restaurant[] = [];
    for (const category of NOMINATIM_CATEGORIES) {
      if (abortNominatim.signal.aborted) throw new Error("overpass won");
      const hits = await searchCategory(category, box);
      for (const h of hits) {
        const r = buildRestaurant(h.id, h.tags, h.lat, h.lon);
        if (r) places.push(r);
      }
    }
    log(`nominatim fallback: ${places.length} places in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    return { lat, lon, radius, source: "nominatim", fetchedAt: Date.now(), places: dedupe(places) };
  });

  try {
    const winner = await Promise.any([viaOverpass, viaNominatim]);
    if (winner.source === "nominatim") {
      // Keep the Overpass request running; replace the thin fallback entry when it finally lands.
      viaOverpass.then((full) => cache.set(cell, full)).catch(() => {});
    }
    return winner;
  } catch (err) {
    const attempts = err instanceof AggregateError ? err.errors.flatMap((e) => (e instanceof OverpassUnavailable ? e.attempts : [String(e instanceof Error ? e.message : e)])) : [];
    throw new HttpError(503, "OpenStreetMap servers are not answering right now, please retry in a moment.", attempts);
  }
}

function cellKey(lat: number, lon: number): string {
  return `${(Math.round(lat * 100) / 100).toFixed(2)},${(Math.round(lon * 100) / 100).toFixed(2)}`;
}

function neighbourCells(lat: number, lon: number): string[] {
  const keys = [cellKey(lat, lon)];
  for (const dLat of [-0.01, 0, 0.01]) for (const dLon of [-0.01, 0, 0.01]) if (dLat || dLon) keys.push(cellKey(lat + dLat, lon + dLon));
  return keys;
}

function bboxAround(lat: number, lon: number, radius: number): BBox {
  const dLat = radius / 111_320;
  const dLon = radius / (111_320 * Math.cos((lat * Math.PI) / 180));
  return { south: lat - dLat, west: lon - dLon, north: lat + dLat, east: lon + dLon };
}

function fromOverpass(el: OverpassElement): Restaurant | undefined {
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (!el.tags || lat === undefined || lon === undefined) return undefined;
  return buildRestaurant(`${el.type}/${el.id}`, el.tags, lat, lon);
}

function dedupe(places: Restaurant[]): Restaurant[] {
  const seen = new Set<string>();
  return places.filter((r) => {
    const key = `${r.name.toLowerCase()}|${Math.round(r.lat * 500)}|${Math.round(r.lon * 500)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("overpass won"));
    }, { once: true });
  });
}
