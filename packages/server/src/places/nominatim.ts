import { config } from "../config.ts";
import { TtlCache } from "../util/cache.ts";
import { HttpError, fetchWithTimeout } from "../util/http.ts";

export interface GeoPoint {
  lat: number;
  lon: number;
  label: string;
}

const cache = new TtlCache<GeoPoint>(24 * 60 * 60 * 1000);
let lastRequestAt = 0;

/** Nominatim asks for at most one request per second; serialise and space out calls. */
async function politeFetch(url: string): Promise<Response> {
  const wait = lastRequestAt + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
  return fetchWithTimeout(url, { headers: { "User-Agent": config.userAgent, Accept: "application/json" } }, 15_000);
}

interface NominatimHit {
  lat: string;
  lon: string;
  display_name: string;
  name?: string;
  address?: Record<string, string>;
}

/** City / address → coordinates (free, no key, OpenStreetMap data). */
export async function geocode(query: string): Promise<GeoPoint> {
  const q = query.trim();
  if (!q) throw new HttpError(400, "location must not be empty");
  return cache.getOrLoad(`fwd:${q.toLowerCase()}`, async () => {
    const url = `${config.nominatimEndpoint}/search?${new URLSearchParams({ q, format: "jsonv2", limit: "1", addressdetails: "1" })}`;
    const res = await politeFetch(url);
    if (!res.ok) throw new HttpError(502, `geocoder responded with ${res.status}`);
    const hits = (await res.json()) as NominatimHit[];
    const hit = hits[0];
    if (!hit) throw new HttpError(404, `Could not find "${q}" on the map. Try a city name.`);
    return { lat: Number(hit.lat), lon: Number(hit.lon), label: shortLabel(hit) };
  });
}

/** Coordinates → a human label like "Darmstadt, Hessen". */
export async function reverseGeocode(lat: number, lon: number): Promise<GeoPoint> {
  const key = `rev:${lat.toFixed(3)},${lon.toFixed(3)}`;
  return cache.getOrLoad(key, async () => {
    const url = `${config.nominatimEndpoint}/reverse?${new URLSearchParams({ lat: String(lat), lon: String(lon), format: "jsonv2", zoom: "14" })}`;
    try {
      const res = await politeFetch(url);
      if (!res.ok) return { lat, lon, label: `${lat.toFixed(4)}, ${lon.toFixed(4)}` };
      const hit = (await res.json()) as NominatimHit;
      return { lat, lon, label: shortLabel(hit) };
    } catch {
      return { lat, lon, label: `${lat.toFixed(4)}, ${lon.toFixed(4)}` };
    }
  });
}

export interface BBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

interface NominatimPlaceHit extends NominatimHit {
  osm_type?: "node" | "way" | "relation";
  osm_id?: number;
  extratags?: Record<string, string> | null;
  category?: string;
  type?: string;
}

/**
 * Fallback POI source: Nominatim's special-phrase search ("[restaurant]") inside a bounding box, with
 * extratags so cuisine / diet / opening hours come along. Max 50 hits per category, one request per
 * second, so this is slower and thinner than Overpass but it is a different server that is usually up.
 */
export async function searchCategory(category: string, box: BBox): Promise<Array<{ id: string; tags: Record<string, string>; lat: number; lon: number }>> {
  const params = new URLSearchParams({
    q: `[${category}]`,
    format: "jsonv2",
    limit: "50",
    extratags: "1",
    addressdetails: "1",
    bounded: "1",
    viewbox: `${box.west},${box.north},${box.east},${box.south}`,
  });
  const res = await politeFetch(`${config.nominatimEndpoint}/search?${params}`);
  if (!res.ok) throw new HttpError(502, `Nominatim responded with ${res.status}`);
  const hits = (await res.json()) as NominatimPlaceHit[];
  return hits
    .filter((h) => h.osm_type && h.osm_id && h.name)
    .map((h) => {
      const a = h.address ?? {};
      const tags: Record<string, string> = { ...(h.extratags ?? {}), name: h.name! };
      if (h.category === "amenity" && h.type) tags["amenity"] = h.type;
      if (h.category === "shop" && h.type) tags["shop"] = h.type;
      if (a["road"]) tags["addr:street"] = a["road"];
      if (a["house_number"]) tags["addr:housenumber"] = a["house_number"];
      const city = a["city"] ?? a["town"] ?? a["village"];
      if (city) tags["addr:city"] = city;
      return { id: `${h.osm_type}/${h.osm_id}`, tags, lat: Number(h.lat), lon: Number(h.lon) };
    });
}

function shortLabel(hit: NominatimHit): string {
  const a = hit.address ?? {};
  const place = a["city"] ?? a["town"] ?? a["village"] ?? a["municipality"] ?? a["suburb"] ?? hit.name;
  const region = a["state"] ?? a["county"] ?? a["country"];
  const parts = [place, region].filter((p): p is string => !!p && p !== place || p === place);
  const unique = [...new Set(parts)];
  return unique.length ? unique.join(", ") : hit.display_name.split(",").slice(0, 2).join(",").trim();
}
