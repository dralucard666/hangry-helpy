/**
 * The pipeline behind POST /api/recommend:
 *
 *   preferences ─► geocode ─► findPlaces ─► pick 30 candidates
 *              ─► model: profile each place (cached) + one "fit" question with the wishes
 *              ─► combine into a match score, badges, top 3
 */
import type { Badge, Preferences, RankedRestaurant, RecommendationResponse, Restaurant } from "@hangry/shared";
import { jsonCache } from "./cache.ts";
import type { Model, Question } from "./model.ts";
import { findPlaces, geocode, reverseGeocode } from "./places.ts";

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

const MAX_CANDIDATES = 30;
const TOP_N = 3;

// ---------- 1. Objective questions about a place (asked once per place, cached for a week) ----------

const q = (text: string, ...anchors: string[]): Question => ({ text, anchors });

/** Each attribute ends up as a number 0..1 (0 = first anchor, 1 = last). The user's wishes are NOT in this prompt on purpose: a small model otherwise just agrees with them. */
const PROFILE = {
  price: q("Price level, judging from the type of place?", "cheap: snack bar, kebab, fast food, bakery", "mid-range restaurant", "upscale, expensive"),
  speed: q("How fast is the food?", "minutes: counter, takeaway, fast food", "normal restaurant pace", "slow multi-course meal"),
  vegetarian: q("Vegetarian options?", "bad: meat or fish centred", "a few vegetarian dishes", "vegetarian is a core strength"),
  vegan: q("Vegan options?", "bad: meat, fish or dairy centred", "a few vegan dishes", "vegan is a core strength"),
  meat: q("How much is it about meat and fish?", "hardly any", "some meat or fish dishes", "the main thing: steak, kebab, seafood, grill"),
  sweet: q("What do people mainly eat here?", "savoury meals only", "savoury meals plus some desserts", "cake, pastries, ice cream, sweets"),
  healthy: q("How healthy is the typical food?", "greasy fast food, heavy comfort food", "normal mixed fare", "light, fresh, healthy"),
  cafe: q("Is it a café?", "no: restaurant, fast food, kebab", "restaurant or bar with coffee and dessert", "real café, bakery, coffee house"),
  sitdown: q("How do you eat here?", "standing, counter, takeaway", "casual: sit or take away", "table service, proper sit-down"),
  exotic: q("How unusual is the cuisine for a German town?", "everyday: German, Italian, pizza, burger, kebab, bakery", "common international: Asian, Indian, Greek, Mexican", "rare or exotic"),
};
type Profile = Record<keyof typeof PROFILE, number> & { craving?: number };

const profileCache = jsonCache<Record<string, number>>("profiles", 7 * 24 * 60 * 60 * 1000);

async function profile(model: Model, place: Restaurant, craving: string, background = false): Promise<Profile> {
  const key = `${place.id}|${place.description.length}`;
  let attrs = profileCache.get(key);
  if (!attrs) {
    attrs = await model.ask(`place: ${place.description}`, PROFILE, background);
    profileCache.set(key, attrs);
  }
  const result = { ...attrs } as Profile;
  if (craving) {
    const cravingKey = `${key}|${craving.toLowerCase()}`;
    let c = profileCache.get(cravingKey)?.["craving"];
    if (c === undefined) {
      const text = `Does this place serve "${craving}"?`;
      c = (await model.ask(`place: ${place.description}`, { craving: q(text, "no, does not fit this food", "maybe a dish or two", "yes, typical thing to order here") }, background))["craving"]!;
      profileCache.set(cravingKey, { craving: c });
    }
    result.craving = c;
  }
  return result;
}

// ---------- 2. The user's wishes, as sentences for the "fit" question and as criteria over the profile ----------

const FIT = q(
  "How well does this place fit what the user wants today? Be strict: 4 only if every wish is met, 0 or 1 if the diet or the specific craving is violated.",
  "would hate it, clearly wrong for today",
  "poor fit, several wishes ignored",
  "okay, could work",
  "good fit, matches most wishes",
  "perfect, exactly what they want today",
);

function describeWishes(p: Preferences): string {
  const pick = <T extends string>(value: T, options: Record<T, string>) => options[value];
  const level = (v: number, low: string, mid: string, high: string) => (v < 34 ? low : v < 67 ? mid : high);
  return [
    `diet: ${pick(p.diet, { any: "eats everything", meat: "wants meat or fish", vegetarian: "vegetarian, no meat or fish", vegan: "vegan, no animal products" })}`,
    `taste: ${pick(p.taste, { salty: "craves something savoury", sweet: "craves something sweet", either: "sweet or savoury, no preference" })}`,
    `budget: ${level(p.budget, "as cheap as possible", "normal restaurant prices are fine", "money is no object, wants a treat")}`,
    `health: ${level(p.healthiness, "greasy comfort or fast food is fine", "something reasonably balanced", "very healthy, light, fresh food")}`,
    `adventure: ${level(p.adventurousness, "a familiar classic", "open to anything", "something new, unusual or exotic")}`,
    `setting: ${pick(p.vibe, { "quick-bite": "a quick bite, no long waiting", "sit-down": "sit down and relax for a proper meal", takeaway: "takeaway to eat elsewhere", cafe: "café vibe: coffee, cake, lingering" })}`,
    `hunger: ${pick(p.hunger, { snack: "only a little hungry", normal: "normally hungry", starving: "starving, needs a big portion" })}`,
    p.craving && `specific craving: ${p.craving}`,
  ]
    .filter(Boolean)
    .join("\n");
}

interface Criterion {
  label: string; // badge text
  weight: number; // diet and craving count double
  satisfied: (pr: Profile) => number; // 0..1
  badge: boolean; // mid-range sliders rank but don't earn a badge
}

/** Which profile attributes matter today, derived from the dials. */
function criteria(p: Preferences): Criterion[] {
  const want = (k: keyof Profile) => (pr: Profile) => pr[k] ?? 0.5;
  const avoid = (k: keyof Profile) => (pr: Profile) => 1 - (pr[k] ?? 0.5);
  const near = (k: keyof Profile, target: number) => (pr: Profile) => 1 - Math.abs((pr[k] ?? 0.5) - target);
  const mid = (v: number) => v >= 35 && v <= 65;
  const c: Criterion[] = [];
  if (p.diet === "vegetarian") c.push({ label: "Veggie-friendly", weight: 2, satisfied: want("vegetarian"), badge: true });
  if (p.diet === "vegan") c.push({ label: "Vegan-friendly", weight: 2, satisfied: want("vegan"), badge: true });
  if (p.diet === "meat") c.push({ label: "Meaty", weight: 1.5, satisfied: want("meat"), badge: true });
  if (p.taste === "sweet") c.push({ label: "Sweet tooth", weight: 1.5, satisfied: want("sweet"), badge: true });
  if (p.taste === "salty") c.push({ label: "Savoury", weight: 1, satisfied: avoid("sweet"), badge: true });
  c.push({ label: p.budget < 40 ? "Easy on the wallet" : "Worth the splurge", weight: 1, satisfied: near("price", p.budget / 100), badge: !mid(p.budget) });
  c.push({ label: p.healthiness > 60 ? "Fresh & healthy" : "Comfort food", weight: 1, satisfied: near("healthy", p.healthiness / 100), badge: !mid(p.healthiness) });
  c.push({ label: p.adventurousness > 66 ? "Something different" : "Safe classic", weight: 0.75, satisfied: near("exotic", p.adventurousness / 100), badge: !mid(p.adventurousness) });
  if (p.vibe === "quick-bite") c.push({ label: "Quick", weight: 1, satisfied: avoid("speed"), badge: true });
  if (p.vibe === "takeaway") c.push({ label: "Takeaway-friendly", weight: 1, satisfied: (pr) => (avoid("sitdown")(pr) + avoid("speed")(pr)) / 2, badge: true });
  if (p.vibe === "sit-down") c.push({ label: "Sit-down meal", weight: 1, satisfied: want("sitdown"), badge: true });
  if (p.vibe === "cafe") c.push({ label: "Café vibe", weight: 1.5, satisfied: want("cafe"), badge: true });
  if (p.hunger === "starving") c.push({ label: "Fills you up", weight: 0.75, satisfied: (pr) => (want("sitdown")(pr) + avoid("cafe")(pr)) / 2, badge: true });
  if (p.hunger === "snack") c.push({ label: "Snack-sized", weight: 0.75, satisfied: (pr) => (want("cafe")(pr) + avoid("speed")(pr)) / 2, badge: true });
  if (p.craving) c.push({ label: `Has "${p.craving}"`, weight: 2, satisfied: want("craving"), badge: true });
  return c;
}

/**
 * The model answers most scales near the middle. Only differences between candidates matter for a
 * ranking, so each attribute is blended with its standardised value across the candidate set:
 * attributes with real spread get amplified, attributes the model can't judge stay flat.
 */
function calibrate(profiles: Profile[]): Profile[] {
  const out = profiles.map((p) => ({ ...p }));
  for (const key of Object.keys(profiles[0] ?? {}) as (keyof Profile)[]) {
    const xs = profiles.map((p) => p[key] ?? 0.5);
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const std = Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / xs.length);
    out.forEach((p, i) => {
      const z = clamp(0.5 + (xs[i]! - mean) / (2 * Math.max(std, 0.15)));
      p[key] = clamp(0.5 * xs[i]! + 0.5 * z);
    });
  }
  return out;
}
const clamp = (n: number) => Math.min(1, Math.max(0, n));

// ---------- 3. The pipeline ----------

export async function recommend(model: Model, prefs: Preferences): Promise<RecommendationResponse> {
  if (model.status.phase !== "ready") throw new HttpError(503, `Decision model is ${model.status.phase}, try again in a moment.`);
  const t0 = performance.now();

  // Where?
  const origin = prefs.location.kind === "query" ? await geocode(prefs.location.query).catch(notFound) : await reverseGeocode(prefs.location.lat, prefs.location.lon);

  // What's around? Prefer places with real tags (cuisine, diet, hours) and at most two branches per chain.
  const all = await findPlaces(origin.lat, origin.lon, prefs.radiusMeters).catch((e: Error) => {
    throw new HttpError(503, e.message);
  });
  const seenNames = new Map<string, number>();
  const candidates = [...all]
    .sort((a, b) => richness(b) - richness(a))
    .filter((r) => {
      const n = seenNames.get(r.name) ?? 0;
      seenNames.set(r.name, n + 1);
      return n < 2;
    })
    .slice(0, MAX_CANDIDATES);
  if (candidates.length === 0) throw new HttpError(404, `No restaurants found within ${prefs.radiusMeters / 1000} km of ${origin.label}.`);
  const placesMs = performance.now() - t0;

  // Ask the model: profile (cached) + fit, for all candidates in parallel.
  const wishes = describeWishes(prefs);
  const judged = await Promise.all(
    candidates.map(async (place) => ({
      place,
      profile: await profile(model, place, prefs.craving),
      fit: (await model.ask(`what the user wants today:\n${wishes}\n\ncandidate place: ${place.description}`, { fit: FIT }))["fit"]!,
    })),
  );

  // Combine: weighted criteria over the calibrated profile + the holistic fit score.
  const crit = criteria(prefs);
  const profiles = calibrate(judged.map((j) => j.profile));
  const ranked: RankedRestaurant[] = judged.map((j, i) => {
    let score = 1.5 * j.fit;
    let weights = 1.5;
    const badges: Badge[] = [];
    for (const c of crit) {
      const s = clamp(c.satisfied(profiles[i]!));
      score += c.weight * s;
      weights += c.weight;
      if (c.badge && s >= 0.62) badges.push({ label: c.label, probability: s });
    }
    return { restaurant: j.place, match: score / weights, badges: badges.sort((a, b) => b.probability - a.probability) };
  });
  ranked.sort((a, b) => b.match - a.match);
  const top = ranked.filter((r, i) => ranked.findIndex((o) => o.restaurant.name === r.restaurant.name) === i).slice(0, TOP_N);

  // Quietly profile the rest of the area so the next request with other dials is fast.
  void (async () => {
    for (const place of all.filter((r) => !candidates.includes(r)).slice(0, 150)) await profile(model, place, "", true).catch(() => {});
  })();

  return {
    resolvedLocation: origin,
    candidatesConsidered: candidates.length,
    top,
    timings: { placesMs: Math.round(placesMs), modelMs: Math.round(performance.now() - t0 - placesMs), totalMs: Math.round(performance.now() - t0) },
    model: model.status.name,
  };
}

const richness = (r: Restaurant) => (r.cuisines.length ? 2 : 0) + (r.openingHours ? 1 : 0) + (r.vegetarian ? 1 : 0) + (r.address ? 0.5 : 0);
const notFound = (e: Error) => {
  throw new HttpError(404, e.message);
};
