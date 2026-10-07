import type { Badge, Preferences, RankedRestaurant, RecommendationResponse, Restaurant } from "@hangry/shared";
import { config } from "./config.ts";
import { geocode, reverseGeocode } from "./places/nominatim.ts";
import { findFoodPlaces } from "./places/index.ts";
import { PROFILE_ATTRS, prefetchProfiles, profileRestaurant, type Profile, type ProfileAttr } from "./profile.ts";
import type { SystemOneEngine } from "./systemOne/engine.ts";
import { score } from "./systemOne/types.ts";
import { HttpError } from "./util/http.ts";

const FIT_SCALE = [
  "would hate it, clearly wrong for today",
  "poor fit, several wishes ignored",
  "okay, could work",
  "good fit, matches most wishes",
  "perfect, exactly what they want today",
] as const;

/** Weight of the holistic fit score (asked with the wishes in the state) relative to the criteria. */
const FIT_WEIGHT = 1.5;

/** Turn slider/enum preferences into sentences a small model can reason about. */
export function describeWishes(p: Preferences): Record<string, string> {
  const wishes: Record<string, string> = {};
  wishes["diet"] = {
    any: "eats everything, meat or vegetarian is fine",
    meat: "wants meat or fish on the plate",
    vegetarian: "vegetarian, no meat or fish",
    vegan: "vegan, no animal products at all",
  }[p.diet];
  wishes["taste"] = { salty: "craves something savoury and salty", sweet: "craves something sweet, dessert-like", either: "sweet or savoury, no preference" }[p.taste];
  wishes["budget"] =
    p.budget < 25 ? "as cheap as possible, student budget" : p.budget < 50 ? "cheap-ish, nothing fancy" : p.budget < 75 ? "fine with normal restaurant prices" : "money is no object, happy to pay for a treat";
  wishes["health"] =
    p.healthiness < 25 ? "wants greasy comfort or fast food, health does not matter" : p.healthiness < 50 ? "leaning towards hearty, filling food" : p.healthiness < 75 ? "prefers something reasonably healthy and fresh" : "wants very healthy, light, fresh food";
  wishes["adventure"] =
    p.adventurousness < 34 ? "wants a familiar classic, nothing experimental" : p.adventurousness < 67 ? "open to the usual favourites or something new" : "wants to try something new, unusual or exotic";
  wishes["setting"] = {
    "quick-bite": "needs a quick bite, no long waiting",
    "sit-down": "wants to sit down and relax for a proper meal",
    takeaway: "wants takeaway to eat elsewhere",
    cafe: "wants a café vibe: coffee, cake, snacks, lingering",
  }[p.vibe];
  wishes["hunger"] = { snack: "only a little hungry, a snack is enough", normal: "normally hungry, a regular meal", starving: "starving, needs a big filling portion" }[p.hunger];
  if (p.craving) wishes["specific craving"] = p.craving;
  return wishes;
}

export interface Criterion {
  key: string;
  /** Badge text shown when the criterion is satisfied. */
  label: string;
  /** Relative weight in the composite match. Hard constraints (diet, craving) count double. */
  weight: number;
  /** 0..1 satisfaction given the (calibrated) profile. */
  satisfy: (profile: Profile) => number;
  /** Mid-range sliders still rank but don't earn a badge ("fair prices" is not a selling point). */
  badge: boolean;
}

const want = (attr: ProfileAttr) => (p: Profile) => p[attr];
const avoid = (attr: ProfileAttr) => (p: Profile) => 1 - p[attr];
const near = (attr: ProfileAttr, target: number) => (p: Profile) => 1 - Math.abs(p[attr] - target);

/** Which profile attributes matter today, derived from the preferences. */
export function criteriaFor(p: Preferences): Criterion[] {
  const c: Criterion[] = [];
  const mid = (v: number) => v >= 35 && v <= 65;
  if (p.diet === "vegetarian") c.push({ key: "diet", label: "Veggie-friendly", weight: 2, satisfy: want("vegetarian"), badge: true });
  if (p.diet === "vegan") c.push({ key: "diet", label: "Vegan-friendly", weight: 2, satisfy: want("vegan"), badge: true });
  if (p.diet === "meat") c.push({ key: "diet", label: "Meaty", weight: 1.5, satisfy: want("meat"), badge: true });
  if (p.taste === "sweet") c.push({ key: "taste", label: "Sweet tooth", weight: 1.5, satisfy: want("sweet"), badge: true });
  if (p.taste === "salty") c.push({ key: "taste", label: "Savoury", weight: 1, satisfy: avoid("sweet"), badge: true });
  c.push({ key: "budget", label: p.budget < 40 ? "Easy on the wallet" : "Worth the splurge", weight: 1, satisfy: near("price", p.budget / 100), badge: !mid(p.budget) });
  c.push({ key: "health", label: p.healthiness > 60 ? "Fresh & healthy" : "Comfort food", weight: 1, satisfy: near("healthy", p.healthiness / 100), badge: !mid(p.healthiness) });
  c.push({ key: "adventure", label: p.adventurousness > 66 ? "Something different" : "Safe classic", weight: 0.75, satisfy: near("exotic", p.adventurousness / 100), badge: !mid(p.adventurousness) });
  switch (p.vibe) {
    case "quick-bite":
      c.push({ key: "vibe", label: "Quick", weight: 1, satisfy: avoid("speed"), badge: true });
      break;
    case "takeaway":
      c.push({ key: "vibe", label: "Takeaway-friendly", weight: 1, satisfy: (pr) => (avoid("sitdown")(pr) + avoid("speed")(pr)) / 2, badge: true });
      break;
    case "sit-down":
      c.push({ key: "vibe", label: "Sit-down meal", weight: 1, satisfy: want("sitdown"), badge: true });
      break;
    case "cafe":
      c.push({ key: "vibe", label: "Café vibe", weight: 1.5, satisfy: want("cafe"), badge: true });
      break;
  }
  if (p.hunger === "starving") c.push({ key: "hunger", label: "Fills you up", weight: 0.75, satisfy: (pr) => (want("sitdown")(pr) + avoid("cafe")(pr)) / 2, badge: true });
  if (p.hunger === "snack") c.push({ key: "hunger", label: "Snack-sized", weight: 0.75, satisfy: (pr) => (want("cafe")(pr) + avoid("speed")(pr)) / 2, badge: true });
  if (p.craving) c.push({ key: "craving", label: `Has "${p.craving}"`, weight: 2, satisfy: (pr) => pr.craving ?? 0.5, badge: true });
  return c;
}

/**
 * Small models answer most scales near the middle anchor and lean "yes". Within one candidate set only the
 * differences matter, so each attribute is blended with its standardised value across the set: attributes
 * with real spread get amplified, attributes the model could not judge stay ~flat and stop influencing rank.
 */
export function calibrate(profiles: Profile[]): Profile[] {
  if (profiles.length < 3) return profiles;
  const keys: (keyof Profile)[] = [...PROFILE_ATTRS];
  if (profiles.every((p) => p.craving !== undefined)) keys.push("craving");
  const out = profiles.map((p) => ({ ...p }));
  for (const k of keys) {
    const xs = profiles.map((p) => p[k] as number);
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const std = Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / xs.length);
    const scale = 2 * Math.max(std, 0.15);
    out.forEach((p, i) => {
      const z = 0.5 + (xs[i]! - mean) / scale;
      p[k] = clamp01(0.5 * xs[i]! + 0.5 * clamp01(z));
    });
  }
  return out;
}

export interface RecommendOptions {
  topN?: number;
  /** Include every judged candidate in the response (for tuning / curiosity). */
  includeAll?: boolean;
  maxCandidates?: number;
  log?: (msg: string) => void;
}

export async function recommend(engine: SystemOneEngine, prefs: Preferences, opts: RecommendOptions = {}): Promise<RecommendationResponse> {
  const topN = opts.topN ?? 3;
  const maxCandidates = opts.maxCandidates ?? config.maxCandidates;
  const log = opts.log ?? (() => {});
  const tStart = performance.now();
  if (!engine.isReady) {
    const s = engine.getStatus();
    throw new HttpError(503, s.phase === "error" ? `Decision model failed to load: ${s.error}` : `Decision model is still ${s.phase}, try again in a moment.`);
  }

  // 1. Where are we?
  const t0 = performance.now();
  const origin = prefs.location.kind === "query" ? await geocode(prefs.location.query) : await reverseGeocode(prefs.location.lat, prefs.location.lon);
  const geocodeMs = performance.now() - t0;

  // 2. What is around? (cached per area)
  const t1 = performance.now();
  const { places: all, source, cached } = await findFoodPlaces(origin.lat, origin.lon, prefs.radiusMeters, log);
  const candidates = pickCandidates(all, prefs, maxCandidates);
  const placesMs = performance.now() - t1;
  if (candidates.length === 0) throw new HttpError(404, `No restaurants found within ${Math.round(prefs.radiusMeters / 100) / 10} km of ${origin.label}. Try a bigger radius.`);
  log(`${origin.label}: ${all.length} places (${cached ? "cached" : source}), ${candidates.length} candidates (geocode ${geocodeMs.toFixed(0)} ms, places ${placesMs.toFixed(0)} ms)`);

  // 3. Ask the System One model. Per candidate: objective profile (cached per place) + craving check,
  //    then one holistic fit score with the wishes in the state. Candidates run in parallel over the pool.
  const t2 = performance.now();
  const wishes = describeWishes(prefs);
  let questionsAsked = 0;
  const judged = await Promise.all(
    candidates.map(async (restaurant) => {
      const { profile, questionsAsked: n1 } = await profileRestaurant(engine, restaurant, prefs.craving);
      const { answers, usage } = await engine.systemOne({
        state: { "what the user wants today": wishes, "candidate place": restaurant.description },
        questions: {
          fit: score(
            "How well does this place fit what the user wants today? Be strict: 4 only if every wish is met, 0 or 1 if the diet or the specific craving is violated.",
            FIT_SCALE,
          ),
        },
      });
      questionsAsked += n1 + usage.questions;
      return { restaurant, profile, fit: answers.fit.score / (FIT_SCALE.length - 1), confidence: answers.fit.confidence };
    }),
  );
  const modelMs = performance.now() - t2;

  // 4. Combine: weighted criteria satisfaction (calibrated across this candidate set) + holistic fit.
  const criteria = criteriaFor(prefs);
  const profiles = calibrate(judged.map((j) => j.profile));
  const scored: RankedRestaurant[] = judged.map((j, i) => {
    const profile = profiles[i]!;
    let weighted = FIT_WEIGHT * j.fit;
    let weightSum = FIT_WEIGHT;
    const badges: Badge[] = [];
    for (const c of criteria) {
      const s = clamp01(c.satisfy(profile));
      weighted += c.weight * s;
      weightSum += c.weight;
      if (c.badge && s >= 0.62) badges.push({ label: c.label, probability: s });
    }
    badges.sort((a, b) => b.probability - a.probability);
    return { restaurant: j.restaurant, match: weighted / weightSum, confidence: j.confidence, badges };
  });
  scored.sort((a, b) => b.match - a.match || a.restaurant.distanceMeters - b.restaurant.distanceMeters);
  const top = distinctNames(scored, topN);
  log(`ranked ${candidates.length} places with ${questionsAsked} questions in ${modelMs.toFixed(0)} ms → ${top.map((t) => `${t.restaurant.name} ${(t.match * 100).toFixed(0)}%`).join(", ")}`);

  // 5. Warm the profile cache for the rest of the area in the background (other dials → other candidates).
  prefetchProfiles(engine, all.filter((r) => !candidates.includes(r)).slice(0, 150), 2, log);

  const response: RecommendationResponse = {
    resolvedLocation: { label: origin.label, lat: origin.lat, lon: origin.lon },
    candidatesConsidered: candidates.length,
    top,
    timings: { geocodeMs: round(geocodeMs), placesMs: round(placesMs), modelMs: round(modelMs), totalMs: round(performance.now() - tStart) },
    model: { name: engine.describeModel(), questionsAsked },
  };
  if (opts.includeAll) response.all = scored;
  return response;
}

/**
 * Pick the N places the model should look at. Everything nearby is eligible, but places with real
 * information (cuisine, diet tags, hours) are preferred over bare names, and we keep variety by
 * capping how many branches of one chain get in.
 */
export function pickCandidates(all: Restaurant[], prefs: Preferences, max: number): Restaurant[] {
  const chainCount = new Map<string, number>();
  const richness = (r: Restaurant) =>
    (r.cuisines.length ? 2 : 0) + (r.vegetarian !== undefined ? 1 : 0) + (r.openingHours ? 1 : 0) + (r.address ? 0.5 : 0) + (r.description.length > 120 ? 0.5 : 0);
  const relevance = (r: Restaurant) => {
    let s = richness(r);
    if (prefs.taste === "sweet" && (r.kind === "cafe" || r.kind === "ice_cream")) s += 1;
    if (prefs.taste === "salty" && (r.kind === "cafe" || r.kind === "ice_cream")) s -= 1;
    if ((prefs.diet === "vegetarian" || prefs.diet === "vegan") && r.vegetarian === false) s -= 3;
    if (prefs.vibe === "quick-bite" && r.kind === "fast_food") s += 0.5;
    // Closer is better, but only as a tie-breaker-ish nudge (0..1.5 over the radius).
    s += 1.5 * (1 - Math.min(1, r.distanceMeters / Math.max(prefs.radiusMeters, 1)));
    return s;
  };
  return [...all]
    .sort((a, b) => relevance(b) - relevance(a))
    .filter((r) => {
      const key = r.name.toLowerCase().replace(/[^a-z0-9]+/g, "");
      const n = chainCount.get(key) ?? 0;
      if (n >= 2) return false;
      chainCount.set(key, n + 1);
      return true;
    })
    .slice(0, max)
    .sort((a, b) => a.distanceMeters - b.distanceMeters);
}

/** Two branches of the same bakery chain are one recommendation, not two. */
export function distinctNames(ranked: RankedRestaurant[], n: number): RankedRestaurant[] {
  const seen = new Set<string>();
  const out: RankedRestaurant[] = [];
  for (const r of ranked) {
    const key = r.restaurant.name.toLowerCase().replace(/[^a-z0-9äöüß]+/g, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
    if (out.length >= n) break;
  }
  return out;
}

const round = (n: number) => Math.round(n);
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
