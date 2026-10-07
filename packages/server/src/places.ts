/**
 * Where are we, and what food places are nearby? Both answers come from OpenStreetMap, free and
 * without an account: Nominatim for geocoding, the Overpass API for places.
 */
import type { Restaurant } from "@hangry/shared";
import { jsonCache } from "./cache.ts";

const USER_AGENT = "hangry-helpy/0.1 (local dev)"; // OSM asks every client to identify itself
const OVERPASS_MIRRORS = [
  "https://overpass.openstreetmap.fr/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://lz4.overpass-api.de/api/interpreter",
];
const placesCache = jsonCache<Restaurant[]>("places", 12 * 60 * 60 * 1000);

export interface Point {
  lat: number;
  lon: number;
  label: string;
}

/** "Darmstadt" → coordinates + a label. */
export async function geocode(query: string): Promise<Point> {
  const url = `https://nominatim.openstreetmap.org/search?${new URLSearchParams({ q: query, format: "jsonv2", limit: "1" })}`;
  const hits = (await fetchJson(url)) as Array<{ lat: string; lon: string; display_name: string }>;
  const hit = hits[0];
  if (!hit) throw new Error(`Could not find "${query}" on the map. Try a city name.`);
  return { lat: Number(hit.lat), lon: Number(hit.lon), label: hit.display_name.split(",").slice(0, 2).join(",") };
}

/** Coordinates → a label like "Darmstadt, Hessen" (for the result header). */
export async function reverseGeocode(lat: number, lon: number): Promise<Point> {
  const url = `https://nominatim.openstreetmap.org/reverse?${new URLSearchParams({ lat: String(lat), lon: String(lon), format: "jsonv2", zoom: "14" })}`;
  const hit = (await fetchJson(url)) as { display_name?: string };
  return { lat, lon, label: hit.display_name?.split(",").slice(0, 2).join(",") ?? `${lat.toFixed(3)}, ${lon.toFixed(3)}` };
}

/** All named food places within `radius` metres, nearest first. One Overpass fetch per ~1 km cell + radius. */
export async function findPlaces(lat: number, lon: number, radius: number): Promise<Restaurant[]> {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)},${radius}`;
  let places = placesCache.get(key);
  if (!places) {
    const elements = await queryOverpass(lat, lon, radius);
    places = elements.map(toRestaurant).filter((r): r is Restaurant => r !== undefined);
    placesCache.set(key, places);
  }
  return places
    .map((r) => ({ ...r, distanceMeters: distance(lat, lon, r.lat, r.lon) }))
    .filter((r) => r.distanceMeters <= radius)
    .sort((a, b) => a.distanceMeters - b.distanceMeters);
}

interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

/**
 * Public Overpass mirrors are individually flaky, so we ask all of them at once and take the first
 * good answer. A bounding box is much cheaper for Overpass than an `around:` circle; we filter by
 * real distance afterwards.
 */
async function queryOverpass(lat: number, lon: number, radius: number): Promise<OverpassElement[]> {
  const dLat = radius / 111_320;
  const dLon = radius / (111_320 * Math.cos((lat * Math.PI) / 180));
  const bbox = `(${lat - dLat},${lon - dLon},${lat + dLat},${lon + dLon})`;
  const query = `[out:json][timeout:15];
(
  nw["amenity"~"^(restaurant|fast_food|cafe|ice_cream|food_court|biergarten)$"]["name"]${bbox};
  nw["shop"~"^(bakery|pastry|ice_cream|confectionery)$"]["name"]${bbox};
);
out center tags qt 800;`;
  try {
    const json = await Promise.any(
      OVERPASS_MIRRORS.map(async (mirror) => {
        const res = (await fetchJson(mirror, { method: "POST", body: new URLSearchParams({ data: query }) })) as { elements?: OverpassElement[] };
        if (!res.elements?.length) throw new Error("empty");
        return res;
      }),
    );
    return json.elements ?? [];
  } catch {
    throw new Error("OpenStreetMap servers are not answering right now, please retry in a moment.");
  }
}

const KIND_LABEL: Record<string, string> = { restaurant: "restaurant", fast_food: "fast food place", cafe: "café", ice_cream: "ice cream parlour", food_court: "food court", biergarten: "beer garden" };

/** Turn raw OSM tags into our Restaurant, including the one-paragraph description the model reads. */
function toRestaurant(el: OverpassElement): Restaurant | undefined {
  const tags = el.tags ?? {};
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  const name = tags["name"];
  const kind = (tags["amenity"] ?? (tags["shop"] === "ice_cream" ? "ice_cream" : "cafe")) as Restaurant["kind"];
  if (!name || lat === undefined || lon === undefined || !KIND_LABEL[kind]) return undefined;

  const cuisines = (tags["cuisine"] ?? "").split(";").map((c) => c.trim().replace(/_/g, " ")).filter(Boolean);
  if (tags["shop"] === "bakery") cuisines.push("baked goods");
  const yes = (k: string) => tags[k] === "yes" || tags[k] === "only";
  const r: Restaurant = {
    id: `${el.type}/${el.id}`,
    name,
    kind,
    cuisines,
    lat,
    lon,
    distanceMeters: 0,
    vegetarian: yes("diet:vegetarian") || yes("diet:vegan"),
    vegan: yes("diet:vegan"),
    takeaway: yes("takeaway"),
    outdoorSeating: yes("outdoor_seating"),
    address: tags["addr:street"] ? `${tags["addr:street"]} ${tags["addr:housenumber"] ?? ""}`.trim() : undefined,
    openingHours: tags["opening_hours"],
    website: tags["website"] ?? tags["contact:website"],
    description: "",
  };

  const facts = [cuisines.length ? `${name} is a ${KIND_LABEL[kind]} serving ${cuisines.join(", ")}.` : `${name} is a ${KIND_LABEL[kind]} (cuisine not listed).`];
  if (r.vegan) facts.push("Offers vegan options.");
  else if (r.vegetarian) facts.push("Offers vegetarian options.");
  if (tags["diet:vegetarian"] === "no") facts.push("No vegetarian options.");
  const service = [r.takeaway && "takeaway", yes("delivery") && "delivery", r.outdoorSeating && "outdoor seating"].filter(Boolean);
  if (service.length) facts.push(`Has ${service.join(", ")}.`);
  if (tags["description"]) facts.push(tags["description"]);
  if (r.openingHours) facts.push(`Opening hours: ${r.openingHours}.`);
  r.description = facts.join(" ");
  return r;
}

async function fetchJson(url: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(url, { ...init, headers: { "User-Agent": USER_AGENT, ...init.headers }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

/** Metres between two coordinates (haversine). */
export function distance(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(rad(bLat - aLat) / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(rad(bLon - aLon) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}
