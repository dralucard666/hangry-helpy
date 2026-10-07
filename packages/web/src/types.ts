// The browser can't import from the @hangry/shared package at runtime, but the types are free: this file
// only re-exports them so app.ts has one import. tsc erases it completely.
export type { HealthResponse, Preferences, RankedRestaurant, RecommendationResponse } from "@hangry/shared";
export interface ApiErrorBody {
  error: string;
}
