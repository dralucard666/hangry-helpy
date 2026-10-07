import { z } from "zod";
import { DIETS, HUNGER_LEVELS, TASTES, VIBES, type Preferences } from "@hangry/shared";
import { config } from "./config.ts";

const percent = z.number().min(0).max(100);

export const preferencesSchema = z.object({
  location: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("query"), query: z.string().trim().min(1).max(200) }),
    z.object({ kind: z.literal("coords"), lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }),
  ]),
  radiusMeters: z.number().int().min(300).max(25_000).default(config.defaultRadiusMeters),
  diet: z.enum(DIETS).default("any"),
  taste: z.enum(TASTES).default("either"),
  budget: percent.default(50),
  healthiness: percent.default(50),
  adventurousness: percent.default(50),
  vibe: z.enum(VIBES).default("sit-down"),
  hunger: z.enum(HUNGER_LEVELS).default("normal"),
  craving: z.string().trim().max(200).default(""),
}) satisfies z.ZodType<Preferences, unknown>;

export type ParsedPreferences = z.infer<typeof preferencesSchema>;
