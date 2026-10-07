# Hangry Helpy

Decide what to eat today. You set a few dials (where you are, meat or veggie, sweet or salty, cheap or fancy,
greasy or healthy, quick bite or sit-down, a craving), press **Feed me**, and get the top three places near you.

Everything runs locally except two free, key-less OpenStreetMap requests:

| Step | How |
| --- | --- |
| "Where is Darmstadt?" | [Nominatim](https://nominatim.org/release-docs/latest/api/Search/) geocoding (free, no account, 1 req/s, cached) |
| "What food places are within 3 km?" | [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API) over OSM data (free, no account), with Nominatim's category search as fallback; cached 12 h per ~1 km cell |
| "Which of these 30 fits my mood?" | A local **System One** readout (the Jev / OpenJev technique) over a small Qwen3 GGUF via `node-llama-cpp` |

## About the decision model

[Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev) by TypeSafe AI is a hosted "System One" model:
state in, typed probabilistic decision out, no text generation. [OpenJev](https://github.com/TheoLeeCJ/openjev) reproduces
that interface on open Qwen3 weights, but it is a Python/PyTorch project. This repo re-implements the same mechanism in
TypeScript so the whole stack is Node:

* `packages/server/src/systemOne/` exposes `engine.systemOne({ state, questions })` with the Jev primitives
  `noul` (yes/no probability), `choice` (option probabilities) and `score` (expected value over ordered anchors).
* Nothing is sampled. For every question the prompt is prefilled once and the **next-token logits of the option
  labels** (`yes`/`no`, `A`…`Z`, `0`…`9`) are read in a single forward pass and softmaxed. A malformed answer is impossible.
* The model (default `Qwen/Qwen3-1.7B-GGUF` Q8_0, ~1.8 GB) is downloaded to `./models` and loaded with GPU offload
  on server start, then warmed up. The first start downloads; later starts take about a second (mmap).
* Candidates are judged in parallel across a pool of llama context sequences, and all questions for the same
  state share the KV-cache prefix.

### How a recommendation is made

1. **Profile** every candidate once, *without* the user's wishes in the state (a small model otherwise agrees with
   whatever the user wants): ten three-anchor `score` questions (price, speed, vegetarian, vegan, meat, sweet,
   healthy, café, sit-down, exotic) plus one for the free-text craving. Profiles are cached on disk in `.cache/`
   per place and model for a week; the rest of the area is profiled in the background after each request.
2. **Calibrate** each attribute across the 30 candidates (blend of raw value and standardised value), so the model's
   "everything is a 1 on a 0–2 scale" bias cancels out and attributes it genuinely can't judge stop mattering.
3. **Fit**: one holistic `score` question per candidate *with* the wishes ("how well does this fit today, 0–4").
4. **Combine**: the dials become weighted criteria over the profile (diet and craving count double), blended with
   the fit score. Criteria the place satisfies become the badges on the card. Top 3, distinct names.

### Keeping it fast

* **Overpass is hedged.** Public mirrors are individually flaky, so the request starts on the healthiest mirror,
  adds the next one every 2.5 s while nothing has answered, takes the first good reply and aborts the rest.
  Mirrors that failed recently go to the back of the line for five minutes. Queries use bounding boxes
  (much cheaper for Overpass than `around:` circles). If nothing has answered after 6 s, Nominatim's
  category search joins the race; a late Overpass answer still upgrades the cache.
* **One fetch per ~1 km cell**, with a slightly larger radius than asked, serves later requests from nearby points
  and smaller radii without touching the network. Distances are recomputed from the actual origin.
* **The model is compute-bound** (prefill, not generation), so the prompt is kept short: the system prompt
  carries the answer format once, each profile question costs ~45 tokens on top of a shared prefix, and
  profiles are cached on disk. Background profiling of the rest of the area yields to live requests.

Timings on an M-series laptop: first request for a new area ≈ 7–9 s (1–3 s OpenStreetMap, the rest is 30 new
profiles), repeat requests in the same area ≈ 1.5–4 s. `MODEL_URI=hf:Qwen/Qwen3-0.6B-GGUF:Q8_0` is roughly
2.5× faster at some cost in judgement quality.

## Run it

```bash
pnpm install          # builds node-llama-cpp's prebuilt Metal/CUDA binary
pnpm dev              # shared d.ts watch + server (tsx watch) + web (tsc watch)
# open http://127.0.0.1:3000
```

Production-style:

```bash
pnpm build && pnpm start
```

### Configuration (environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` / `HOST` | `3000` / `127.0.0.1` | HTTP listen address |
| `MODEL_URI` | `hf:Qwen/Qwen3-1.7B-GGUF:Q8_0` | Any `node-llama-cpp` model URI; `hf:Qwen/Qwen3-0.6B-GGUF:Q8_0` is the 640 MB "test lane" |
| `MODELS_DIR` | `./models` | Where GGUF files are stored |
| `MODEL_SEQUENCES` | `8` | Parallel sequences (= restaurants judged at once) |
| `MODEL_CONTEXT_SIZE` | `1024` | Tokens per sequence |
| `MODEL_GPU` | `auto` | `metal`, `cuda`, `vulkan` or `false` |
| `MODEL_READOUT_TEMPERATURE` | `2` | Softmax temperature over the label logits (spreads collapsed distributions) |
| `CACHE_DIR` | `./.cache` | JSON caches for places and profiles; safe to delete |
| `PLACES_CACHE_TTL_MS` / `PROFILE_CACHE_TTL_MS` | 12 h / 7 d | Cache lifetimes |
| `MAX_CANDIDATES` | `30` | Places handed to the model |
| `DEFAULT_RADIUS_METERS` | `3000` | Fallback search radius |
| `OSM_USER_AGENT` | `hangry-help/0.1 (...)` | Identify yourself to OSM services (their usage policy asks for it) |
| `OVERPASS_ENDPOINTS` | 4 public mirrors | Comma-separated, tried in order |

## Layout

```
packages/shared   types shared by client and server (Preferences, Restaurant, RecommendationResponse, …)
packages/server   Express 5 API + static hosting, OSM clients, System One engine
packages/web      vanilla TypeScript + HTML + CSS, no framework, no bundler
```

### API

* `GET /api/health` → model phase (`downloading` with progress, `loading`, `ready`, `error`)
* `POST /api/recommend` with a `Preferences` JSON body → `RecommendationResponse` (top 3, timings, questions asked);
  add `?debug=1` to also get every judged candidate in `all`

## Tests

```bash
pnpm test      # node:test unit tests for prompt rendering, OSM tag normalisation and candidate selection
pnpm typecheck
```
