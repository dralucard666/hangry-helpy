import { test } from "node:test";
import assert from "node:assert/strict";
import type { Preferences, Restaurant } from "@hangry/shared";
import { calibrate, criteriaFor, describeWishes, distinctNames, pickCandidates } from "./recommend.ts";
import type { Profile } from "./profile.ts";

const prefs: Preferences = {
  location: { kind: "query", query: "Darmstadt" }, radiusMeters: 3000, diet: "vegetarian", taste: "either",
  budget: 20, healthiness: 70, adventurousness: 80, vibe: "quick-bite", hunger: "starving", craving: "noodles",
};

const place = (over: Partial<Restaurant>): Restaurant => ({
  id: "node/1", name: "X", kind: "restaurant", cuisines: [], lat: 0, lon: 0, distanceMeters: 100, description: "", osmUrl: "", ...over,
});

test("describeWishes turns sliders into sentences", () => {
  const w = describeWishes(prefs);
  assert.equal(w["diet"], "vegetarian, no meat or fish");
  assert.match(w["budget"]!, /cheap/);
  assert.equal(w["specific craving"], "noodles");
});

test("criteriaFor depends on the preferences and scores profiles", () => {
  const keys = criteriaFor(prefs).map((c) => c.key);
  assert.deepEqual(keys, ["diet", "budget", "health", "adventure", "vibe", "hunger", "craving"]);
  const craving = criteriaFor(prefs).find((c) => c.key === "craving")!;
  assert.equal(craving.weight, 2);
  const profile = { price: 0.2, speed: 0.1, vegetarian: 0.9, vegan: 0.5, meat: 0.5, sweet: 0.2, healthy: 0.7, cafe: 0.1, sitdown: 0.3, exotic: 0.8, craving: 1 } satisfies Profile;
  assert.equal(craving.satisfy(profile), 1);
  assert.equal(criteriaFor(prefs).find((c) => c.key === "diet")!.satisfy(profile), 0.9);
  assert.equal(criteriaFor(prefs).find((c) => c.key === "vibe")!.satisfy(profile), 0.9);
  assert.deepEqual(criteriaFor({ ...prefs, diet: "any", taste: "either", craving: "", hunger: "normal" }).map((c) => c.key), ["budget", "health", "adventure", "vibe"]);
});

test("calibrate amplifies attributes with spread and leaves flat ones alone", () => {
  const base = { price: 0.5, speed: 0.5, vegetarian: 0.5, vegan: 0.5, meat: 0.5, sweet: 0.5, healthy: 0.5, cafe: 0.5, sitdown: 0.5, exotic: 0.5 };
  const profiles: Profile[] = [{ ...base, cafe: 1 }, { ...base, cafe: 0.6 }, { ...base, cafe: 0.1 }];
  const out = calibrate(profiles);
  assert.ok(out[0]!.cafe > out[1]!.cafe && out[1]!.cafe > out[2]!.cafe, "order preserved");
  assert.ok(out[0]!.cafe - out[2]!.cafe >= 0.9, "spread kept or amplified");
  assert.equal(out[0]!.price, 0.5, "flat attribute untouched");
});

test("pickCandidates prefers informative places, caps chains and respects max", () => {
  const all = [
    place({ id: "a", name: "Bare", distanceMeters: 50 }),
    place({ id: "b", name: "Rich", cuisines: ["Thai"], vegetarian: true, openingHours: "x", distanceMeters: 900 }),
    place({ id: "c", name: "Meaty", cuisines: ["steak"], vegetarian: false, distanceMeters: 200 }),
    place({ id: "d", name: "Chain", cuisines: ["burgers"], distanceMeters: 300 }),
    place({ id: "e", name: "Chain", cuisines: ["burgers"], distanceMeters: 400 }),
    place({ id: "f", name: "Chain", cuisines: ["burgers"], distanceMeters: 500 }),
  ];
  const picked = pickCandidates(all, prefs, 4).map((r) => r.id);
  assert.equal(picked.length, 4);
  assert.ok(picked.includes("b"), "rich place kept");
  assert.ok(!picked.includes("c"), "non-vegetarian place dropped for a vegetarian");
  assert.equal(picked.filter((id) => ["d", "e", "f"].includes(id)).length, 2, "chain capped at two branches");
});

test("distinctNames skips repeated chain names", () => {
  const ranked = ["Bormuth", "Bormuth", "Biokaiser", "Grimminger"].map((name, i) => ({ restaurant: place({ id: String(i), name }), match: 1 - i / 10, confidence: 1, badges: [] }));
  assert.deepEqual(distinctNames(ranked, 3).map((r) => r.restaurant.name), ["Bormuth", "Biokaiser", "Grimminger"]);
});
