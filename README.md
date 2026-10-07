# Hangry Helpy (simple branch)

A small full-stack project to learn from: you set a few dials, press **Feed me**, and get the three places
near you that fit your mood. Everything runs on your machine except two free OpenStreetMap requests.

This branch is the **teaching version**: same behaviour as `main`, fewer files, fewer knobs, no edge-case
handling beyond what is needed. Read it top to bottom in about an hour.

## How one request flows

```
 browser (packages/web)                 server (packages/server)                     outside
 ───────────────────────                ────────────────────────                     ───────
 app.ts reads the form
   │  POST /api/recommend  ──────────►  index.ts  validates the JSON (zod)
   │                                       │
   │                                    recommend.ts
   │                                       ├─ geocode("Darmstadt")      ──────────►  Nominatim  (city → lat/lon)
   │                                       ├─ findPlaces(lat, lon, 3km)  ──────────►  Overpass   (all food places)
   │                                       ├─ pick 30 candidates
   │                                       ├─ model.ask(place, PROFILE)   (10 scales per place, cached)
   │                                       ├─ model.ask(wishes+place, FIT)
   │                                       └─ combine → match %, badges, top 3
   │  JSON  ◄──────────────────────────── index.ts
 app.ts renders three cards
```

## The files

| File | What it does |
| --- | --- |
| `packages/shared/src/index.ts` | The types both sides agree on: `Preferences` (what the form sends), `Restaurant`, `RecommendationResponse`. |
| `packages/web/public/index.html` + `styles.css` | The page. No framework. |
| `packages/web/src/app.ts` | Reads the form, calls the API, renders cards, polls `/api/health` while the model loads. |
| `packages/server/src/index.ts` | Express app: validates input, routes to `recommend()`, serves the frontend, turns errors into JSON. |
| `packages/server/src/places.ts` | OpenStreetMap: geocoding and the Overpass query, plus turning raw OSM tags into a `Restaurant` with a one-paragraph description. |
| `packages/server/src/model.ts` | The decision model (see below). |
| `packages/server/src/recommend.ts` | The pipeline: candidates → model questions → ranking. All the "product logic" lives here. |
| `packages/server/src/cache.ts` | A Map that survives restarts (JSON file in `.cache/`). |

## The decision model, in plain words

We use a small open model (Qwen3 1.7B, ~1.8 GB, downloaded on first start) **without letting it write text**.
This is the idea behind TypeSafe's Jev / OpenJev ("System One" models):

1. Build a prompt that ends exactly where the answer digit would go.
2. Run one forward pass and look only at the logits of the tokens `0`, `1`, `2`, …
3. Softmax over those few numbers → a probability per answer anchor → a value between 0 and 1.

No sampling, no JSON parsing, no malformed answers, and one question costs a few milliseconds.
`Model.ask(state, questions)` is the whole API. `readout()` in `model.ts` is the core, 15 lines.

Two tricks that matter for a small model:

* **Ask about the place without the user's wishes** (the `PROFILE` questions). If the wishes are in the prompt,
  the model just agrees with them. The profile is objective and cached per place for a week.
* **Calibrate across the candidates.** The model answers most scales near the middle. For a ranking only
  differences matter, so each attribute is standardised across the 30 candidates (`calibrate()`).

One extra question *with* the wishes (`FIT`) adds a holistic judgement. The final match is a weighted mix.

## Run it

```bash
pnpm install
pnpm dev          # http://127.0.0.1:3000 — the first start downloads the model
```

`PORT` and `MODEL_URI` are the only settings (see `.env.example`).

## Exercises

1. **Add a dial.** Add "spicy / mild" to `Preferences`, the form, the zod schema, `describeWishes()` and `criteria()`.
   You will touch every layer once.
2. **Add a profile attribute.** Add a "kid-friendly" scale to `PROFILE` and a badge for it. Bump the cache key.
3. **Show all 30.** Return `ranked` as well as `top` and render a collapsible list in `app.ts`.
4. **Swap the model.** Set `MODEL_URI=hf:Qwen/Qwen3-0.6B-GGUF:Q8_0`. It's 2× faster. What gets worse? Why?
5. **Break the cache on purpose.** Delete `.cache/`, time a request, time it again. Where did the seconds go?
