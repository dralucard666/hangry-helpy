import type { AmenityKind, Restaurant } from "@hangry/shared";

export interface NormalisedTags {
  cuisines: string[];
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
  /** Extra facts worth telling the model (brand, organic, drive-through, OSM description…). */
  extras: string[];
}

const KIND_LABEL: Record<AmenityKind, string> = {
  restaurant: "restaurant",
  fast_food: "fast food place",
  cafe: "café",
  ice_cream: "ice cream parlour",
  food_court: "food court",
  bar: "bar",
  pub: "pub",
  biergarten: "beer garden",
};

const CUISINE_LABEL: Record<string, string> = {
  german: "German", regional: "regional", italian: "Italian", pizza: "pizza", pasta: "pasta",
  chinese: "Chinese", japanese: "Japanese", sushi: "sushi", ramen: "ramen", thai: "Thai",
  vietnamese: "Vietnamese", korean: "Korean", indian: "Indian", nepalese: "Nepalese", turkish: "Turkish",
  kebab: "kebab / döner", greek: "Greek", mexican: "Mexican", spanish: "Spanish", tapas: "tapas",
  french: "French", american: "American", burger: "burgers", steak_house: "steakhouse", bbq: "BBQ",
  chicken: "chicken", fish: "fish", seafood: "seafood", sandwich: "sandwiches", bagel: "bagels",
  coffee_shop: "coffee", cake: "cake", dessert: "desserts", ice_cream: "ice cream", donut: "donuts",
  bubble_tea: "bubble tea", juice: "juices", breakfast: "breakfast", brunch: "brunch", bakery: "baked goods",
  asian: "pan-Asian", oriental: "oriental", lebanese: "Lebanese", syrian: "Syrian", persian: "Persian",
  arab: "Arabic", falafel: "falafel", mediterranean: "Mediterranean", international: "international",
  vegetarian: "vegetarian", vegan: "vegan", noodle: "noodles", soup: "soups", salad: "salads", bowl: "bowls",
  poke: "poké bowls", wings: "chicken wings", hot_dog: "hot dogs", friture: "fries", fries: "fries",
  curry: "curry", pakistani: "Pakistani", afghan: "Afghan", ethiopian: "Ethiopian", african: "African",
  portuguese: "Portuguese", polish: "Polish", russian: "Russian", balkan: "Balkan", croatian: "Croatian",
  argentinian: "Argentinian", brazilian: "Brazilian", peruvian: "Peruvian", filipino: "Filipino",
  indonesian: "Indonesian", malaysian: "Malaysian", tex_mex: "Tex-Mex", crepe: "crêpes", waffle: "waffles",
  pancake: "pancakes", tea: "tea", wine: "wine", beer: "beer", tapas_bar: "tapas",
};

function yesNo(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  if (v === "yes" || v === "only" || v === "limited") return true;
  if (v === "no") return false;
  return undefined;
}

export function normaliseTags(tags: Record<string, string>, kind: AmenityKind): NormalisedTags {
  const cuisines = (tags["cuisine"] ?? "")
    .split(";")
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean)
    .map((c) => CUISINE_LABEL[c] ?? c.replace(/_/g, " "));
  if (kind === "ice_cream" && !cuisines.includes("ice cream")) cuisines.push("ice cream");
  if (tags["shop"] === "bakery" && !cuisines.includes("baked goods")) cuisines.push("baked goods");

  const street = tags["addr:street"];
  const number = tags["addr:housenumber"];
  const city = tags["addr:city"];
  const address = street ? `${street}${number ? ` ${number}` : ""}${city ? `, ${city}` : ""}` : undefined;

  const extras: string[] = [];
  if (tags["description"]) extras.push(tags["description"]);
  if (tags["brand"] && tags["brand"] !== tags["name"]) extras.push(`part of the ${tags["brand"]} chain`);
  if (tags["drive_through"] === "yes") extras.push("has a drive-through");
  if (tags["organic"] === "yes" || tags["organic"] === "only") extras.push("organic food");
  if (tags["diet:halal"] === "yes") extras.push("halal");
  if (tags["diet:kosher"] === "yes") extras.push("kosher");
  if (tags["diet:gluten_free"] === "yes") extras.push("gluten-free options");
  if (tags["microbrewery"] === "yes") extras.push("brews its own beer");
  if (tags["reservation"] === "required") extras.push("reservation required");
  if (tags["self_service"] === "yes") extras.push("self-service");
  if (tags["stars"]) extras.push(`${tags["stars"]} stars`);
  if (tags["michelin"] || tags["award:michelin"]) extras.push("Michelin listed");
  if (tags["smoking"] === "yes") extras.push("smoking allowed");
  if (tags["internet_access"] === "wlan") extras.push("free Wi-Fi");

  const n: NormalisedTags = { cuisines, extras };
  if (address) n.address = address;
  if (tags["opening_hours"]) n.openingHours = tags["opening_hours"];
  const website = tags["website"] ?? tags["contact:website"];
  if (website) n.website = website;
  const phone = tags["phone"] ?? tags["contact:phone"];
  if (phone) n.phone = phone;
  const veg = yesNo(tags["diet:vegetarian"]);
  const vegan = yesNo(tags["diet:vegan"]);
  if (veg !== undefined) n.vegetarian = veg;
  if (vegan !== undefined) n.vegan = vegan;
  if (vegan === true && veg === undefined) n.vegetarian = true;
  const takeaway = yesNo(tags["takeaway"]);
  if (takeaway !== undefined) n.takeaway = takeaway;
  const delivery = yesNo(tags["delivery"]);
  if (delivery !== undefined) n.delivery = delivery;
  const outdoor = yesNo(tags["outdoor_seating"]);
  if (outdoor !== undefined) n.outdoorSeating = outdoor;
  const wheelchair = yesNo(tags["wheelchair"]);
  if (wheelchair !== undefined) n.wheelchair = wheelchair;
  return n;
}

/** Build a Restaurant from OSM tags (shared by the Overpass and Nominatim sources). */
export function buildRestaurant(id: string, tags: Record<string, string>, lat: number, lon: number): Restaurant | undefined {
  const name = tags["name"]?.trim();
  if (!name) return undefined;
  const kind = kindOf(tags);
  if (!kind) return undefined;
  const n = normaliseTags(tags, kind);
  const r: Restaurant = { id, name, kind, cuisines: n.cuisines, lat, lon, distanceMeters: 0, description: "", osmUrl: `https://www.openstreetmap.org/${id}` };
  if (n.address) r.address = n.address;
  if (n.openingHours) r.openingHours = n.openingHours;
  if (n.website) r.website = n.website;
  if (n.phone) r.phone = n.phone;
  if (n.vegetarian !== undefined) r.vegetarian = n.vegetarian;
  if (n.vegan !== undefined) r.vegan = n.vegan;
  if (n.takeaway !== undefined) r.takeaway = n.takeaway;
  if (n.delivery !== undefined) r.delivery = n.delivery;
  if (n.outdoorSeating !== undefined) r.outdoorSeating = n.outdoorSeating;
  if (n.wheelchair !== undefined) r.wheelchair = n.wheelchair;
  r.description = describeRestaurant(r, n.extras);
  return r;
}

export function kindOf(tags: Record<string, string>): AmenityKind | undefined {
  const amenity = tags["amenity"];
  switch (amenity) {
    case "restaurant":
    case "fast_food":
    case "cafe":
    case "ice_cream":
    case "food_court":
    case "biergarten":
      return amenity;
  }
  switch (tags["shop"]) {
    case "bakery":
    case "pastry":
    case "confectionery":
    case "deli":
      return "cafe";
    case "ice_cream":
      return "ice_cream";
  }
  return undefined;
}

/** One dense paragraph the decision model reads. Kept factual – no marketing adjectives. */
export function describeRestaurant(r: Restaurant, extras: string[] = []): string {
  const parts: string[] = [];
  const kind = KIND_LABEL[r.kind];
  parts.push(r.cuisines.length ? `${r.name} is a ${kind} serving ${r.cuisines.join(", ")}.` : `${r.name} is a ${kind} (cuisine not listed).`);
  const diet: string[] = [];
  if (r.vegan) diet.push("vegan options");
  else if (r.vegetarian) diet.push("vegetarian options");
  if (r.vegetarian === false) diet.push("no vegetarian options");
  if (diet.length) parts.push(`Offers ${diet.join(" and ")}.`);
  const service: string[] = [];
  if (r.takeaway) service.push("takeaway");
  if (r.delivery) service.push("delivery");
  if (r.outdoorSeating) service.push("outdoor seating");
  if (r.wheelchair) service.push("wheelchair access");
  if (service.length) parts.push(`Has ${service.join(", ")}.`);
  if (extras.length) parts.push(`${extras.join("; ")}.`);
  if (r.openingHours) parts.push(`Opening hours: ${r.openingHours}.`);
  // Distance is deliberately left out: the description (and the cached profile built from it) must not
  // depend on where the user happened to stand.
  return parts.join(" ");
}
