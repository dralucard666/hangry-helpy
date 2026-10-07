/**
 * The whole frontend. Flow: read the form → POST /api/recommend → render three cards.
 * While the model is still loading, /api/health is polled to show the status pill.
 */
import type { ApiErrorBody, HealthResponse, Preferences, RankedRestaurant, RecommendationResponse } from "./types.ts";

const $ = <T extends Element>(selector: string, root: ParentNode = document) => root.querySelector<T>(selector)!;
const form = $<HTMLFormElement>("#prefs-form");
const locationInput = $<HTMLInputElement>("#location");
const hint = $<HTMLElement>("#location-hint");
const results = $<HTMLElement>("#results");
const statusEl = $<HTMLElement>("#model-status");
const submitBtn = $<HTMLButtonElement>("#submit");

let coords: { lat: number; lon: number } | undefined; // set by "Locate me"
let modelReady = false;

// ---------- Model status ----------

async function pollHealth(): Promise<void> {
  try {
    const health = (await (await fetch("/api/health")).json()) as HealthResponse;
    const { phase, progress, name, error } = health.model;
    statusEl.dataset["phase"] = phase;
    modelReady = phase === "ready";
    const text = { idle: "Starting", downloading: `Downloading model ${Math.round((progress ?? 0) * 100)}%`, loading: "Loading model", ready: "Model ready", error: `Model failed: ${error}` }[phase];
    $(".status__text", statusEl).textContent = text;
    if (phase === "ready") $("#model-name").textContent = name;
    if (!modelReady && phase !== "error") setTimeout(pollHealth, 1500);
  } catch {
    $(".status__text", statusEl).textContent = "Server unreachable";
    setTimeout(pollHealth, 3000);
  }
}

// ---------- Form ----------

const radio = (name: string) => form.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)!.value;
const slider = (id: string) => Number($<HTMLInputElement>(id).value);

function readPreferences(): Preferences {
  const query = locationInput.value.trim();
  return {
    location: coords && !query ? { kind: "coords", ...coords } : { kind: "query", query },
    radiusMeters: Number(radio("radiusMeters")),
    diet: radio("diet") as Preferences["diet"],
    taste: radio("taste") as Preferences["taste"],
    vibe: radio("vibe") as Preferences["vibe"],
    hunger: radio("hunger") as Preferences["hunger"],
    budget: slider("#budget"),
    healthiness: slider("#healthiness"),
    adventurousness: slider("#adventurousness"),
    craving: $<HTMLInputElement>("#craving").value.trim(),
  };
}

$("#geolocate").addEventListener("click", () => {
  hint.textContent = "Asking the browser for your position…";
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      coords = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      locationInput.value = "";
      locationInput.placeholder = `Current position (${coords.lat.toFixed(3)}, ${coords.lon.toFixed(3)})`;
      hint.textContent = "Using your current position. Type a place to override.";
    },
    (err) => (hint.textContent = `Could not get position: ${err.message}`),
  );
});
locationInput.addEventListener("input", () => (coords = undefined));

$("#surprise").addEventListener("click", () => {
  const pick = (name: string) => {
    const inputs = form.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`);
    inputs[Math.floor(Math.random() * inputs.length)]!.checked = true;
  };
  ["diet", "taste", "vibe", "hunger"].forEach(pick);
  for (const id of ["#budget", "#healthiness", "#adventurousness"]) $<HTMLInputElement>(id).value = String(Math.round(Math.random() * 100));
});

form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const prefs = readPreferences();
  if (prefs.location.kind === "query" && !prefs.location.query) {
    hint.textContent = "Tell me where you are first.";
    return;
  }
  if (!modelReady) return renderError("The decision model is still loading. Give it a second and try again.");

  submitBtn.disabled = true;
  renderLoading();
  try {
    const res = await fetch("/api/recommend", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(prefs) });
    const body = (await res.json()) as RecommendationResponse | ApiErrorBody;
    if ("error" in body) renderError(body.error);
    else renderResults(body);
  } catch (err) {
    renderError(String(err));
  } finally {
    submitBtn.disabled = false;
  }
});

// ---------- Rendering ----------

function renderLoading(): void {
  results.innerHTML = `<div class="skeleton"><span class="rank"></span><div><span class="lg"></span><span class="md"></span><span class="sm"></span></div></div>`.repeat(3);
  results.insertAdjacentHTML("beforeend", `<p class="results__loading-note">Fetching nearby places from OpenStreetMap and asking the model about each one…</p>`);
}

function renderError(message: string): void {
  results.innerHTML = `<div class="results__error"><strong>Hmm. </strong></div>`;
  $(".results__error", results).append(message);
}

function renderResults(r: RecommendationResponse): void {
  results.innerHTML = `<div class="results__summary"><span>Near <strong>${escape(r.resolvedLocation.label)}</strong></span><span><strong>${r.candidatesConsidered}</strong> places judged</span><span>model <strong>${(r.timings.modelMs / 1000).toFixed(1)}s</strong></span><span>total <strong>${(r.timings.totalMs / 1000).toFixed(1)}s</strong></span></div>`;
  r.top.forEach((item, i) => results.append(renderCard(item, i + 1)));
}

function renderCard({ restaurant: p, match, badges }: RankedRestaurant, rank: number): HTMLElement {
  const card = ($<HTMLTemplateElement>("#card-template").content.firstElementChild as HTMLElement).cloneNode(true) as HTMLElement;
  if (rank === 1) card.classList.add("card--winner");
  $(".card__rank", card).textContent = String(rank);
  $(".card__title", card).textContent = p.name;

  const pct = Math.round(match * 100);
  $<HTMLElement>(".match", card).dataset["tone"] = pct >= 70 ? "high" : pct >= 45 ? "mid" : "low";
  $(".match__text", card).textContent = `${pct}%`;
  const ring = $<SVGCircleElement>(".match__value", card);
  setTimeout(() => (ring.style.strokeDashoffset = String(97.4 * (1 - match))), 50);

  const distance = p.distanceMeters < 950 ? `${Math.round(p.distanceMeters / 10) * 10} m` : `${(p.distanceMeters / 1000).toFixed(1)} km`;
  $(".card__meta", card).textContent = [p.kind.replace("_", " "), p.cuisines.join(", "), distance, p.address].filter(Boolean).join(" · ");
  const facts = [p.vegan ? "vegan options" : p.vegetarian ? "vegetarian options" : "", p.takeaway ? "takeaway" : "", p.outdoorSeating ? "outdoor seating" : ""].filter(Boolean).join(", ");
  $(".card__desc", card).textContent = `${facts ? facts[0]!.toUpperCase() + facts.slice(1) + ". " : ""}${p.openingHours ? `Hours: ${p.openingHours}.` : ""}`;

  $(".badges", card).innerHTML = badges.map((b) => `<li class="badge">${escape(b.label)}<small>${Math.round(b.probability * 100)}%</small></li>`).join("");

  const links: Array<[string, string]> = [
    ["Open in maps", `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lon}`],
    ["OpenStreetMap", `https://www.openstreetmap.org/${p.id}`],
  ];
  if (p.website) links.push(["Website", p.website.startsWith("http") ? p.website : `https://${p.website}`]);
  $(".card__links", card).innerHTML = links.map(([text, href]) => `<a href="${escape(href)}" target="_blank" rel="noopener">${text}</a>`).join("");
  return card;
}

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

void pollHealth();
