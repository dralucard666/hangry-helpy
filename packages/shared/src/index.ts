/**
 * Types shared between the web client and the server.
 * The server validates incoming JSON against these shapes with zod (see server/src/schema.ts);
 * the client uses them for type-safe fetch calls.
 */

export const DIETS = ["any", "meat", "vegetarian", "vegan"] as const;
export type Diet = (typeof DIETS)[number];

export const TASTES = ["salty", "either", "sweet"] as const;
export type Taste = (typeof TASTES)[number];

export const VIBES = ["quick-bite", "sit-down", "takeaway", "cafe"] as const;
export type Vibe = (typeof VIBES)[number];

export const HUNGER_LEVELS = ["snack", "normal", "starving"] as const;
export type HungerLevel = (typeof HUNGER_LEVELS)[number];

/** Either a city/address string or precise coordinates (from browser geolocation). */
export type LocationInput =
  | { kind: "query"; query: string }
  | { kind: "coords"; lat: number; lon: number };

export interface Preferences {
  location: LocationInput;
  /** Search radius in meters around the resolved location. */
  radiusMeters: number;
  diet: Diet;
  taste: Taste;
  /** 0 = as cheap as possible … 100 = money is no object. */
  budget: number;
  /** 0 = greasy fast food … 100 = squeaky-clean healthy. */
  healthiness: number;
  /** 0 = comfort classics … 100 = something I've never tried. */
  adventurousness: number;
  vibe: Vibe;
  hunger: HungerLevel;
  /** Free-text craving, e.g. "noodles", "something with cheese". */
  craving: string;
}

export const AMENITY_KINDS = ["restaurant", "fast_food", "cafe", "ice_cream", "food_court", "bar", "pub", "biergarten"] as const;
export type AmenityKind = (typeof AMENITY_KINDS)[number];

/** A normalised OpenStreetMap food place. */
export interface Restaurant {
  /** OSM id, e.g. "node/64723623". */
  id: string;
  name: string;
  kind: AmenityKind;
  cuisines: string[];
  lat: number;
  lon: number;
  distanceMeters: number;
  address?: string;
  openingHours?: string;
  website?: string;
  phone?: string;
  vegetarian?: boolean;
  vegan?: boolean;
  takeaway?: boolean;
  delivery?: boolean;
  outdoorSeating?: boolean;
  wheelchair?: boolean;
  /** Free-form sentence describing the place for the decision model. */
  description: string;
  osmUrl: string;
}

export interface Badge {
  label: string;
  /** 0..1 probability from the decision model. */
  probability: number;
}

export interface RankedRestaurant {
  restaurant: Restaurant;
  /** 0..1, higher is a better fit. */
  match: number;
  /** Decision model confidence for this verdict, 0..1. */
  confidence: number;
  badges: Badge[];
}

export interface RecommendationResponse {
  resolvedLocation: { label: string; lat: number; lon: number };
  candidatesConsidered: number;
  top: RankedRestaurant[];
  timings: { geocodeMs: number; placesMs: number; modelMs: number; totalMs: number };
  model: { name: string; questionsAsked: number };
  /** Every judged candidate, best first. Only present when requested with ?debug=1. */
  all?: RankedRestaurant[];
}

export type ModelPhase = "idle" | "downloading" | "loading" | "ready" | "error";

export interface HealthResponse {
  ok: boolean;
  model: {
    phase: ModelPhase;
    name: string;
    /** 0..1 during download. */
    progress?: number;
    error?: string;
  };
  uptimeSeconds: number;
}

export interface ApiError {
  error: string;
  details?: unknown;
}
