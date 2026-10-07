import type { Restaurant } from "@hangry/shared";
import { config } from "./config.ts";
import type { SystemOneEngine } from "./systemOne/engine.ts";
import { score, type Question, type ScoreAnswer, type ScoreQuestion } from "./systemOne/types.ts";
import path from "node:path";
import { DiskCache } from "./util/diskCache.ts";

/**
 * Objective attributes of a place, each judged by the decision model on a three-anchor scale and
 * normalised to 0..1. They are asked WITHOUT the user's wishes in the state (a small model otherwise
 * just agrees with whatever the user wants) and cached per OSM id, so repeat requests in the same
 * area only need the per-request questions.
 */
export const PROFILE_QUESTIONS = {
  price: score("Price level, judging from the type of place?", ["cheap: snack bar, kebab, fast food, bakery", "mid-range restaurant", "upscale, expensive"]),
  speed: score("How fast is the food?", ["minutes: counter, takeaway, fast food", "normal restaurant pace", "slow multi-course meal"]),
  vegetarian: score("Vegetarian options?", ["bad: meat or fish centred", "a few vegetarian dishes", "vegetarian is a core strength"]),
  vegan: score("Vegan options?", ["bad: meat, fish or dairy centred", "a few vegan dishes", "vegan is a core strength"]),
  meat: score("How much is it about meat and fish?", ["hardly any", "some meat or fish dishes", "the main thing: steak, kebab, seafood, grill"]),
  sweet: score("What do people mainly eat here?", ["savoury meals only", "savoury meals plus some desserts", "cake, pastries, ice cream, sweets"]),
  healthy: score("How healthy is the typical food?", ["greasy fast food, heavy comfort food", "normal mixed fare", "light, fresh, healthy"]),
  cafe: score("Is it a café?", ["no: restaurant, fast food, kebab", "restaurant or bar with coffee and dessert", "real café, bakery, coffee house"]),
  sitdown: score("How do you eat here?", ["standing, counter, takeaway", "casual: sit or take away", "table service, proper sit-down"]),
  exotic: score("How unusual is the cuisine for a German town?", ["everyday: German, Italian, pizza, burger, kebab, bakery", "common international: Asian, Indian, Greek, Mexican", "rare or exotic"]),
} satisfies Record<string, ScoreQuestion>;

export type ProfileAttr = keyof typeof PROFILE_QUESTIONS;
export const PROFILE_ATTRS = Object.keys(PROFILE_QUESTIONS) as ProfileAttr[];

/** Attribute values 0..1 plus, when a craving was given, how likely the place serves it (0..1). */
export type Profile = Record<ProfileAttr, number> & { craving?: number };

const profileCache = new DiskCache<Record<ProfileAttr, number>>(path.join(config.cacheDir, "profiles.json"), config.profileCacheTtlMs, 20_000);
const cravingCache = new DiskCache<number>(path.join(config.cacheDir, "cravings.json"), config.profileCacheTtlMs, 20_000);

/** Profiles are only comparable within one model, so the key carries the model name and the question set. */
const PROFILE_VERSION = "v2";

export function cravingQuestion(craving: string): ScoreQuestion {
  return score(`Does this place serve "${craving}"?`, [`no, does not fit this food`, `maybe a dish or two`, `yes, typical thing to order here`]);
}

const normalise = (a: ScoreAnswer, q: ScoreQuestion) => a.score / (q.criteria.length - 1);

/**
 * Profile one place. Cached attributes are not re-asked; whatever is missing (the attributes on first
 * contact, the craving question per craving text) is asked in one call sharing the same state prefix.
 */
export async function profileRestaurant(
  engine: SystemOneEngine,
  r: Restaurant,
  craving: string,
  priority: "foreground" | "background" = "foreground",
): Promise<{ profile: Profile; questionsAsked: number }> {
  const attrKey = `${PROFILE_VERSION}|${engine.describeModel()}|${r.id}|${r.description.length}`;
  const cravingKey = `${attrKey}|${craving.toLowerCase()}`;
  let attrs = profileCache.peek(attrKey);
  let cravingValue = craving ? cravingCache.peek(cravingKey) : undefined;

  const questions: Record<string, Question> = {};
  if (!attrs) for (const k of PROFILE_ATTRS) questions[k] = PROFILE_QUESTIONS[k];
  if (craving && cravingValue === undefined) questions["craving"] = cravingQuestion(craving);

  let questionsAsked = 0;
  if (Object.keys(questions).length > 0) {
    const { answers, usage } = await engine.systemOne({ state: { place: r.description }, questions }, priority);
    questionsAsked = usage.questions;
    if (!attrs) {
      attrs = {} as Record<ProfileAttr, number>;
      for (const k of PROFILE_ATTRS) attrs[k] = normalise(answers[k] as ScoreAnswer, PROFILE_QUESTIONS[k]);
      profileCache.set(attrKey, attrs);
    }
    if (questions["craving"]) {
      cravingValue = normalise(answers["craving"] as ScoreAnswer, questions["craving"] as ScoreQuestion);
      cravingCache.set(cravingKey, cravingValue);
    }
  }

  const profile: Profile = { ...attrs! };
  if (cravingValue !== undefined) profile.craving = cravingValue;
  return { profile, questionsAsked };
}

export function flushProfileCaches(): void {
  profileCache.flush();
  cravingCache.flush();
}

export function isProfiled(engine: SystemOneEngine, r: Restaurant): boolean {
  return profileCache.peek(`${PROFILE_VERSION}|${engine.describeModel()}|${r.id}|${r.description.length}`) !== undefined;
}

let prefetchGeneration = 0;

/**
 * After answering a request, quietly profile the other places in the area with low concurrency so the
 * next request with different dials (and therefore a different candidate set) is fast. A newer prefetch
 * supersedes an older one.
 */
export function prefetchProfiles(engine: SystemOneEngine, places: Restaurant[], concurrency = 2, log: (m: string) => void = () => {}): void {
  const generation = ++prefetchGeneration;
  const queue = places.filter((r) => !isProfiled(engine, r));
  if (queue.length === 0) return;
  const t0 = performance.now();
  let done = 0;
  const worker = async () => {
    while (queue.length > 0 && generation === prefetchGeneration && engine.isReady) {
      const r = queue.shift()!;
      try {
        await profileRestaurant(engine, r, "", "background");
        done++;
      } catch {
        /* best effort */
      }
    }
  };
  void Promise.all(Array.from({ length: concurrency }, worker)).then(() => {
    if (done > 0) log(`prefetched ${done} place profiles in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  });
}
