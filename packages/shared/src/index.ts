/** Types shared between the web client and the server. */

export const DIETS = ["any", "meat", "vegetarian", "vegan"] as const;
export const TASTES = ["salty", "either", "sweet"] as const;
export const VIBES = ["quick-bite", "sit-down", "takeaway", "cafe"] as const;
export const HUNGER_LEVELS = ["snack", "normal", "starving"] as const;

export type Diet = (typeof DIETS)[number];
export type Taste = (typeof TASTES)[number];
export type Vibe = (typeof VIBES)[number];
export type HungerLevel = (typeof HUNGER_LEVELS)[number];

/** What the frontend sends to POST /api/recommend. Sliders are 0..100. */
export interface Preferences {
  city: string;
  radiusMeters: number;
  diet: Diet;
  taste: Taste;
  budget: number; // 0 = cheap … 100 = fancy
  healthiness: number; // 0 = greasy … 100 = healthy
  adventurousness: number; // 0 = classic … 100 = something new
  vibe: Vibe;
  hunger: HungerLevel;
  craving: string;
}

/** A food place from OpenStreetMap. */
export interface Restaurant {
  id: string;
  name: string;
  kind: "restaurant" | "fast_food" | "cafe" | "ice_cream" | "food_court" | "biergarten";
  cuisines: string[];
  lat: number;
  lon: number;
  distanceMeters: number;
  vegetarian: boolean;
  vegan: boolean;
  takeaway: boolean;
  outdoorSeating: boolean;
  address?: string | undefined;
  openingHours?: string | undefined;
  website?: string | undefined;
  /** One factual paragraph the decision model reads. */
  description: string;
}

export interface Badge {
  label: string;
  probability: number; // 0..1
}

export interface RankedRestaurant {
  restaurant: Restaurant;
  match: number; // 0..1
  badges: Badge[];
}

/** What POST /api/recommend returns. */
export interface RecommendationResponse {
  resolvedLocation: { label: string; lat: number; lon: number };
  candidatesConsidered: number;
  top: RankedRestaurant[];
  timings: { placesMs: number; modelMs: number; totalMs: number };
  model: string;
}

/** What GET /api/health returns. */
export interface HealthResponse {
  ok: boolean;
  model: { phase: "idle" | "downloading" | "loading" | "ready" | "error"; name: string; progress?: number; error?: string };
}
