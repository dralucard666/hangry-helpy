import type { ApiError, Diet, HealthResponse, HungerLevel, LocationInput, Preferences, RankedRestaurant, RecommendationResponse, Taste, Vibe } from "@hangry/shared";

const $ = <T extends Element>(sel: string, root: ParentNode = document): T => {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`missing element ${sel}`);
  return el;
};

const form = $<HTMLFormElement>("#prefs-form");
const locationInput = $<HTMLInputElement>("#location");
const locationHint = $<HTMLParagraphElement>("#location-hint");
const geolocateBtn = $<HTMLButtonElement>("#geolocate");
const submitBtn = $<HTMLButtonElement>("#submit");
const surpriseBtn = $<HTMLButtonElement>("#surprise");
const results = $<HTMLElement>("#results");
const statusEl = $<HTMLElement>("#model-status");
const statusText = $<HTMLElement>(".status__text", statusEl);
const modelName = $<HTMLElement>("#model-name");
const cardTemplate = $<HTMLTemplateElement>("#card-template");

/** Set when the user pressed "Locate me"; cleared as soon as they type a place. */
let coords: { lat: number; lon: number } | undefined;
let modelReady = false;

// ---------- Model status (polls /api/health until the model is ready) ----------

async function pollHealth(): Promise<void> {
  try {
    const res = await fetch("/api/health");
    const h = (await res.json()) as HealthResponse;
    const { phase, progress, name, error } = h.model;
    statusEl.dataset["phase"] = phase;
    modelReady = phase === "ready";
    switch (phase) {
      case "downloading":
        statusText.textContent = `Downloading model ${progress !== undefined ? `${Math.round(progress * 100)}%` : ""}`;
        break;
      case "loading":
        statusText.textContent = "Loading model";
        break;
      case "ready":
        statusText.textContent = "Model ready";
        modelName.textContent = name;
        break;
      case "error":
        statusText.textContent = "Model failed";
        statusText.title = error ?? "";
        break;
      default:
        statusText.textContent = "Starting";
    }
    if (phase !== "ready" && phase !== "error") setTimeout(pollHealth, 1500);
  } catch {
    statusEl.dataset["phase"] = "error";
    statusText.textContent = "Server unreachable";
    setTimeout(pollHealth, 3000);
  }
}

// ---------- Form helpers ----------

function radio<T extends string>(name: string): T {
  const el = form.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`);
  if (!el) throw new Error(`no ${name} selected`);
  return el.value as T;
}

function setRadio(name: string, value: string): void {
  const el = form.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`);
  if (el) el.checked = true;
}

function readPreferences(): Preferences {
  const query = locationInput.value.trim();
  const location: LocationInput = coords && !query ? { kind: "coords", ...coords } : { kind: "query", query };
  return {
    location,
    radiusMeters: Number(radio("radiusMeters")),
    diet: radio<Diet>("diet"),
    taste: radio<Taste>("taste"),
    budget: Number($<HTMLInputElement>("#budget").value),
    healthiness: Number($<HTMLInputElement>("#healthiness").value),
    adventurousness: Number($<HTMLInputElement>("#adventurousness").value),
    vibe: radio<Vibe>("vibe"),
    hunger: radio<HungerLevel>("hunger"),
    craving: $<HTMLInputElement>("#craving").value.trim(),
  };
}

const STORAGE_KEY = "hangry-helpy:prefs";
function persist(p: Preferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    /* private mode etc. */
  }
}
function restore(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const p = JSON.parse(raw) as Partial<Preferences>;
    if (p.location?.kind === "query") locationInput.value = p.location.query;
    if (p.radiusMeters) setRadio("radiusMeters", String(p.radiusMeters));
    if (p.diet) setRadio("diet", p.diet);
    if (p.taste) setRadio("taste", p.taste);
    if (p.vibe) setRadio("vibe", p.vibe);
    if (p.hunger) setRadio("hunger", p.hunger);
    if (typeof p.budget === "number") $<HTMLInputElement>("#budget").value = String(p.budget);
    if (typeof p.healthiness === "number") $<HTMLInputElement>("#healthiness").value = String(p.healthiness);
    if (typeof p.adventurousness === "number") $<HTMLInputElement>("#adventurousness").value = String(p.adventurousness);
    if (typeof p.craving === "string") $<HTMLInputElement>("#craving").value = p.craving;
  } catch {
    /* ignore corrupt storage */
  }
}

// ---------- Geolocation ----------

geolocateBtn.addEventListener("click", () => {
  if (!("geolocation" in navigator)) {
    setHint("Your browser has no geolocation.", "bad");
    return;
  }
  geolocateBtn.disabled = true;
  setHint("Asking the browser for your position…");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      coords = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      locationInput.value = "";
      locationInput.placeholder = `Current position (${coords.lat.toFixed(3)}, ${coords.lon.toFixed(3)})`;
      setHint("Using your current position. Type a place to override.", "good");
      geolocateBtn.disabled = false;
    },
    (err) => {
      setHint(`Could not get position: ${err.message}`, "bad");
      geolocateBtn.disabled = false;
    },
    { enableHighAccuracy: false, timeout: 10_000, maximumAge: 5 * 60_000 },
  );
});

locationInput.addEventListener("input", () => {
  if (locationInput.value.trim()) {
    coords = undefined;
    locationInput.placeholder = "City, district or address";
    setHint("Free OpenStreetMap search, nothing leaves your machine except the place name.");
  }
});

function setHint(text: string, tone?: "good" | "bad"): void {
  locationHint.textContent = text;
  if (tone) locationHint.dataset["tone"] = tone;
  else delete locationHint.dataset["tone"];
}

// ---------- Surprise me ----------

surpriseBtn.addEventListener("click", () => {
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)]!;
  setRadio("diet", pick(["any", "any", "meat", "vegetarian", "vegan"]));
  setRadio("taste", pick(["salty", "either", "sweet"]));
  setRadio("vibe", pick(["quick-bite", "sit-down", "takeaway", "cafe"]));
  setRadio("hunger", pick(["snack", "normal", "starving"]));
  for (const id of ["#budget", "#healthiness", "#adventurousness"]) $<HTMLInputElement>(id).value = String(Math.round(Math.random() * 100));
  $<HTMLInputElement>("#craving").value = "";
  form.animate([{ transform: "rotate(-0.6deg)" }, { transform: "rotate(0.6deg)" }, { transform: "none" }], { duration: 220 });
});

// ---------- Submit ----------

form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const prefs = readPreferences();
  if (prefs.location.kind === "query" && !prefs.location.query) {
    locationInput.focus();
    setHint("Tell me where you are first.", "bad");
    return;
  }
  if (!modelReady) {
    renderError("The decision model is still loading. Give it a second and try again.");
    return;
  }
  persist(prefs);
  setBusy(true);
  renderLoading();
  try {
    const res = await fetch("/api/recommend", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(prefs) });
    const body = (await res.json()) as RecommendationResponse | ApiError;
    if (!res.ok || "error" in body) {
      const e = body as ApiError;
      renderError(e.error ?? `Request failed (${res.status})`, e.details);
      return;
    }
    renderResults(body);
  } catch (err) {
    renderError(err instanceof Error ? err.message : String(err));
  } finally {
    setBusy(false);
  }
});

function setBusy(busy: boolean): void {
  submitBtn.disabled = busy;
  submitBtn.classList.toggle("is-busy", busy);
  $<HTMLElement>(".btn__label", submitBtn).textContent = busy ? "Thinking…" : "Feed me";
}

// ---------- Rendering ----------

function renderLoading(): void {
  results.replaceChildren();
  for (let i = 0; i < 3; i++) {
    const sk = document.createElement("div");
    sk.className = "skeleton";
    sk.innerHTML = `<span class="rank"></span><div><span class="lg"></span><span class="md"></span><span class="md"></span><span class="sm"></span></div>`;
    results.append(sk);
  }
  const note = document.createElement("p");
  note.className = "results__loading-note";
  note.textContent = "Fetching nearby places from OpenStreetMap (a new area can take 5–20 s) and asking the model about each one…";
  results.append(note);
}

function renderError(message: string, details?: unknown): void {
  results.replaceChildren();
  const box = document.createElement("div");
  box.className = "results__error";
  const strong = document.createElement("strong");
  strong.textContent = "Hmm. ";
  box.append(strong, document.createTextNode(message));
  if (details !== undefined) {
    const pre = document.createElement("pre");
    pre.textContent = typeof details === "string" ? details : JSON.stringify(details, null, 2);
    box.append(pre);
  }
  results.append(box);
}

function renderResults(r: RecommendationResponse): void {
  results.replaceChildren();
  const summary = document.createElement("div");
  summary.className = "results__summary";
  summary.innerHTML = `<span>Near <strong></strong></span><span><strong>${r.candidatesConsidered}</strong> places judged</span><span><strong>${r.model.questionsAsked}</strong> questions</span><span>model <strong>${(r.timings.modelMs / 1000).toFixed(1)}s</strong></span><span>total <strong>${(r.timings.totalMs / 1000).toFixed(1)}s</strong></span>`;
  $<HTMLElement>("strong", summary).textContent = r.resolvedLocation.label;
  results.append(summary);
  r.top.forEach((item, i) => results.append(renderCard(item, i + 1)));
  if (r.top.length === 0) renderError("The model could not rank anything. Try a wider radius.");
}

function renderCard(item: RankedRestaurant, rank: number): HTMLElement {
  const node = cardTemplate.content.firstElementChild!.cloneNode(true) as HTMLElement;
  const { restaurant: p, match, badges } = item;
  if (rank === 1) node.classList.add("card--winner");
  $<HTMLElement>(".card__rank", node).textContent = String(rank);
  $<HTMLElement>(".card__title", node).textContent = p.name;

  const pct = Math.round(match * 100);
  const matchEl = $<HTMLElement>(".match", node);
  matchEl.dataset["tone"] = pct >= 70 ? "high" : pct >= 45 ? "mid" : "low";
  $<HTMLElement>(".match__text", node).textContent = `${pct}%`;
  const ring = $<SVGCircleElement>(".match__value", node);
  requestAnimationFrame(() => requestAnimationFrame(() => (ring.style.strokeDashoffset = String(97.4 * (1 - match)))));

  const meta: string[] = [kindLabel(p.kind)];
  if (p.cuisines.length) meta.push(p.cuisines.join(", "));
  meta.push(formatDistance(p.distanceMeters));
  if (p.address) meta.push(p.address);
  $<HTMLElement>(".card__meta", node).textContent = meta.join(" · ");

  $<HTMLElement>(".card__desc", node).textContent = describeForHumans(p);

  const list = $<HTMLUListElement>(".badges", node);
  for (const b of badges) {
    const li = document.createElement("li");
    li.className = "badge";
    li.textContent = b.label;
    const small = document.createElement("small");
    small.textContent = `${Math.round(b.probability * 100)}%`;
    li.append(small);
    list.append(li);
  }

  const links = $<HTMLElement>(".card__links", node);
  const add = (text: string, href: string) => {
    const a = document.createElement("a");
    a.textContent = text;
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener";
    links.append(a);
  };
  add("Open in maps", `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lon}`);
  add("OpenStreetMap", p.osmUrl);
  if (p.website) add("Website", /^https?:\/\//.test(p.website) ? p.website : `https://${p.website}`);
  if (p.phone) add("Call", `tel:${p.phone.replace(/\s+/g, "")}`);
  return node;
}

function describeForHumans(p: RankedRestaurant["restaurant"]): string {
  const bits: string[] = [];
  if (p.vegan) bits.push("vegan options");
  else if (p.vegetarian) bits.push("vegetarian options");
  if (p.takeaway) bits.push("takeaway");
  if (p.delivery) bits.push("delivery");
  if (p.outdoorSeating) bits.push("outdoor seating");
  if (p.wheelchair) bits.push("wheelchair accessible");
  const extras = bits.length ? `${capitalise(bits.join(", "))}.` : "";
  const hours = p.openingHours ? ` Hours: ${p.openingHours}.` : "";
  return `${extras}${hours}`.trim() || "No further details on OpenStreetMap yet.";
}

function kindLabel(kind: RankedRestaurant["restaurant"]["kind"]): string {
  return { restaurant: "Restaurant", fast_food: "Fast food", cafe: "Café", ice_cream: "Ice cream", food_court: "Food court", bar: "Bar", pub: "Pub", biergarten: "Beer garden" }[kind];
}

function formatDistance(m: number): string {
  return m < 950 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------- Boot ----------
restore();
void pollHealth();
