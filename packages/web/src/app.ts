/**
 * The whole frontend. Flow: read the form → POST /api/recommend → render three cards.
 * While the model is still loading, /api/health is polled to show the status pill.
 */
import type { ApiErrorBody, HealthResponse, Preferences, RankedRestaurant, RecommendationResponse } from "./types.ts";

const form = document.querySelector<HTMLFormElement>("#prefs-form")!;
const results = document.querySelector<HTMLElement>("#results")!;
const status = document.querySelector<HTMLElement>("#model-status")!;
const submitButton = document.querySelector<HTMLButtonElement>("#submit")!;
let modelReady = false;

// ---------- Model status ----------

async function pollHealth(): Promise<void> {
  const health = (await (await fetch("/api/health")).json()) as HealthResponse;
  modelReady = health.ok;
  status.textContent = health.ok ? `Model ready: ${health.model.name}` : `Model ${health.model.phase}…`;
  if (!health.ok) setTimeout(pollHealth, 1500);
}

// ---------- Form ----------

function readPreferences(): Preferences {
  const data = new FormData(form);
  const text = (name: string) => String(data.get(name) ?? "");
  return {
    city: text("city").trim(),
    radiusMeters: Number(text("radiusMeters")),
    diet: text("diet") as Preferences["diet"],
    taste: text("taste") as Preferences["taste"],
    vibe: text("vibe") as Preferences["vibe"],
    hunger: text("hunger") as Preferences["hunger"],
    budget: Number(text("budget")),
    healthiness: Number(text("healthiness")),
    adventurousness: Number(text("adventurousness")),
    craving: text("craving").trim(),
  };
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const prefs = readPreferences();
  if (!prefs.city) return renderError("Tell me which city you are in first.");
  if (!modelReady) return renderError("The decision model is still loading. Give it a second and try again.");

  submitButton.disabled = true;
  results.innerHTML = `<p class="note">Fetching nearby places from OpenStreetMap and asking the model about each one…</p>`;
  try {
    const res = await fetch("/api/recommend", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(prefs) });
    const body = (await res.json()) as RecommendationResponse | ApiErrorBody;
    if ("error" in body) renderError(body.error);
    else renderResults(body);
  } catch (err) {
    renderError(String(err));
  } finally {
    submitButton.disabled = false;
  }
});

// ---------- Rendering ----------

function renderError(message: string): void {
  results.innerHTML = `<div class="error"><strong>Hmm.</strong> ${escape(message)}</div>`;
}

function renderResults(r: RecommendationResponse): void {
  results.innerHTML =
    `<div class="summary">Near <strong>${escape(r.resolvedLocation.label)}</strong> · ${r.candidatesConsidered} places judged · ${(r.timings.totalMs / 1000).toFixed(1)}s</div>` +
    r.top.map(renderCard).join("");
}

/** One result card as an HTML string. Everything from the server goes through escape(). */
function renderCard({ restaurant: p, match, badges }: RankedRestaurant, index: number): string {
  const percent = Math.round(match * 100);
  const distance = p.distanceMeters < 950 ? `${Math.round(p.distanceMeters / 10) * 10} m` : `${(p.distanceMeters / 1000).toFixed(1)} km`;
  const meta = [p.kind.replace("_", " "), p.cuisines.join(", "), distance, p.address].filter(Boolean).join(" · ");
  const facts = [p.vegan ? "vegan options" : p.vegetarian ? "vegetarian options" : "", p.takeaway ? "takeaway" : "", p.outdoorSeating ? "outdoor seating" : ""].filter(Boolean).join(", ");
  const description = `${facts ? facts + ". " : ""}${p.openingHours ? `Hours: ${p.openingHours}.` : ""}`;
  const tone = percent >= 70 ? "high" : percent >= 45 ? "mid" : "low";
  const website = p.website ? `<a href="${escape(p.website)}" target="_blank" rel="noopener">Website</a>` : "";

  return `
    <article class="card ${index === 0 ? "winner" : ""}">
      <div class="rank">${index + 1}</div>
      <div class="content">
        <header class="head">
          <h2>${escape(p.name)}</h2>
          <div class="match ${tone}" title="Fit according to the decision model">
            <svg class="ring" viewBox="0 0 36 36" aria-hidden="true">
              <circle class="track" cx="18" cy="18" r="15.5"></circle>
              <circle class="value" cx="18" cy="18" r="15.5" style="stroke-dashoffset: ${97.4 * (1 - match)}"></circle>
            </svg>
            <span>${percent}%</span>
          </div>
        </header>
        <p class="meta">${escape(meta)}</p>
        <p class="desc">${escape(description)}</p>
        <ul class="badges">${badges.map((b) => `<li class="badge">${escape(b.label)}<small>${Math.round(b.probability * 100)}%</small></li>`).join("")}</ul>
        <footer class="links">
          <a href="https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lon}" target="_blank" rel="noopener">Open in maps</a>
          <a href="https://www.openstreetmap.org/${p.id}" target="_blank" rel="noopener">OpenStreetMap</a>
          ${website}
        </footer>
      </div>
    </article>`;
}

/** Never put raw server text into innerHTML. */
function escape(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

void pollHealth();
