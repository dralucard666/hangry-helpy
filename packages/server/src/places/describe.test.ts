import { test } from "node:test";
import assert from "node:assert/strict";
import { describeRestaurant, normaliseTags } from "./describe.ts";
import type { Restaurant } from "@hangry/shared";

test("normaliseTags maps OSM tags to readable facts", () => {
  const n = normaliseTags(
    { cuisine: "italian;pizza", "diet:vegan": "yes", takeaway: "yes", outdoor_seating: "no", "addr:street": "Hauptstr.", "addr:housenumber": "1", opening_hours: "Mo-Fr 11:00-22:00", brand: "Chain" },
    "restaurant",
  );
  assert.deepEqual(n.cuisines, ["Italian", "pizza"]);
  assert.equal(n.vegan, true);
  assert.equal(n.vegetarian, true);
  assert.equal(n.takeaway, true);
  assert.equal(n.outdoorSeating, false);
  assert.equal(n.address, "Hauptstr. 1");
  assert.ok(n.extras.includes("part of the Chain chain"));
});

test("describeRestaurant writes one factual paragraph", () => {
  const r: Restaurant = {
    id: "node/1", name: "Luigi", kind: "restaurant", cuisines: ["Italian", "pizza"], lat: 0, lon: 0, distanceMeters: 1234,
    vegetarian: true, takeaway: true, openingHours: "Mo-Su 12:00-23:00", description: "", osmUrl: "",
  };
  assert.equal(
    describeRestaurant(r),
    "Luigi is a restaurant serving Italian, pizza. Offers vegetarian options. Has takeaway. Opening hours: Mo-Su 12:00-23:00.",
  );
});
