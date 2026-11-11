# Research: one embedding per activity, for "like this one" and text search

Date: 2026-11-09
Status: research note for the owner. No code was changed.
Scope: issue #35 §3 (text and semantic search), with the place tags of
[2026-11-08-place-tags-design.md](2026-11-08-place-tags-design.md) assumed
to exist. Vendor pages, prices and model lists were read on 2026-11-09.

## Short answer

**Yes, but one vector can't do both jobs well, and it shouldn't have to.**
Each activity can be written out as a short text "card" (type, time of day,
season, length and climbing in words, places reached, route shape) and
embedded with a text model. That single vector accepts a natural-language
query, and it can also be compared with other activities. Two things are
lost, though: route geometry and exact numbers. On numbers, current text
embedding models score barely above chance: 0.54 against a 0.5 baseline
across 13 models, and 4-digit integers like "1,234 m" sit at chance
([Deng et al. 2025](https://arxiv.org/abs/2509.05691)). For "find activities
like this one", plain numbers and the track itself work better and cost
less. At 448 GPS activities, an exact route distance (discrete Fréchet) over
every candidate pair takes seconds, even in pure Python (measured below).

So the recommendation is: **two small vectors per activity** (a text-card
embedding and a numeric feature vector), **exact track distance to re-rank**
route matches, and **structured filters before any vector ranking** for text
queries. The MCP client is already an LLM, so it can turn the query into
filters. v1 runs locally in Python with an open model (EmbeddingGemma-300m)
and is served through the MCP server. The site gets precomputed "similar
activities" lists, not a model.

## What the data looks like (measured 2026-11-09)

Read-only queries against `data/activities.sqlite`:

- **531 visible activities, 448 with GPS.** The 83 without GPS are mostly
  WeightTraining (38), Workout (24 of 32), StairStepper, WaterSport and
  similar. For these, similarity can only come from stats and time.
- **Names carry little.** 358 of 531 (67%) are default
  "‹time of day› ‹type›" names ("Afternoon Run"), often with a leading
  weather emoji. A card has to be built from the data, not from the name.
- **Descriptions are mostly automated.** 393 of 490 Strava source rows have
  one, averaging 42 characters. Typical lines are "Weather: 12°C, Cold,
  clear" (signed "Automated with strautomator.com") and Wandrer.earth "new
  kilometers" counts. The MCP server treats `summary_json` as private ("can
  hold private notes"), so using it needs the owner's decision (see
  [Open questions](#open-questions-for-the-owner)).
- **Repeated routes are few, which matters for evaluation.** I resampled
  each polyline (median 839 points) to 64 points along its length. I then
  compared pairs of the same type whose distances were within 10%, using
  discrete Fréchet distance:
  - Strict (under 250 m, same direction): 84 pairs forming **19 route
    groups covering 62 activities** (Run 25, Hike 23, Walk 10, Workout 4).
  - Loose (within 15%, under 400 m, either direction): 276 pairs, **24
    groups covering 121 activities** (Run 56, Hike 32, Walk 27, Workout 6).
  - No rides repeat under either rule.
  - Time: 1,028 and 1,738 candidate pairs (after cheap prefilters) took 4.4 s
    and 12.9 s in a naive pure-Python implementation.
- **Start points don't identify routes.** The place-tags design found that
  97 of 153 runs start within about a kilometre of each other. Yet only 25
  to 56 runs repeat a route. A vector that leans on the start point would
  call most runs "similar".
- **Already public on the site:** every route polyline (`routes.json`,
  212 KB), route profiles every 100 m (`profiles.json`, 200 KB) and the
  activity list (`activities.json`, 240 KB).

## The approaches compared

| Approach | Captures well | Captures poorly | Text query? | Verdict here |
|---|---|---|---|---|
| **a. Text card + text embedding** | Type, time of day, season, place names, "hilly/long/easy" words, weather words | Exact numbers, route geometry, "same route" | **Yes** | **Yes**, for ranking after filters |
| **b. Numeric feature vector** | Distance, climbing, pace, HR, time of day, season, start/end area, elevation profile shape | Place meaning, anything not in a column | No | **Yes**, for "similar" |
| **c. Trajectory distance or learned trajectory embedding** | Route identity and shape | Everything that isn't the track | No | **Exact distance: yes** (re-rank). Learned models: no |
| **d. Rendered route image + image or multimodal embedding** | Overall shape, basemap context (water, forest) | Scale, exact identity, numbers | Yes (shared space) | Not now. Hosted models break the local-only rule |
| **e. Time-series encoder on streams** | Shape of HR, pace and altitude curves (intervals vs steady) | Absolute levels (normalized away), meaning | No | Not now |
| **f. Fusion** | Covered in [Single vector or several](#single-vector-or-several) | | | |

### a. Text card + text embedding model

**How it works.** For each activity, write a few deterministic sentences
from the columns and tags, then embed them. Numbers go in as words and
buckets, with the raw number at most alongside. The example is illustrative,
not a real activity:

```
Trail run on a Sunday evening in late October (autumn), 1 h 05 min.
Long for a run (14 km) and hilly: 620 m of climbing, highest point 1,020 m.
Loop. Started in Ljubljana. Reached Šmarna gora (peak) and Grmada (peak).
Steady effort, mostly heart-rate zone 2. Weather: 8 °C, cloudy.
```

The query "hilly evening trail run near the lake" then lands near cards that
say "hilly", "evening", "run" and name a lake. That works because the place
tags put the lake's name into the text: reverse-geocoded names are what make
a text vector useful for location.

**Known weaknesses with numbers:**

- *Revealing the Numeracy Gap* (2025): 13 widely used models, including
  Qwen3-Embedding-8B, NV-Embed-v2 and OpenAI text-embedding-3-small, average
  **0.54 accuracy against 0.5 for random guessing**. Results vary up to 12
  points with number format (8% vs 0.08), and 4-digit integers are "at a
  random guessing level"
  ([arXiv 2509.05691](https://arxiv.org/abs/2509.05691),
  [HTML](https://arxiv.org/html/2509.05691v1)). Elevation figures are
  exactly that kind of number.
- Older word embeddings capture rough magnitude (GloVe and word2vec up to
  1,000), but subword models like BERT are "less exact"
  ([Wallace et al. 2019](https://arxiv.org/abs/1909.07940)).
- Retrieval work on queries with numeric conditions ("less than $10k") says
  standard rankers ignore magnitude and units, and builds separate
  quantity-aware scoring ([Almasian et al. 2024](https://arxiv.org/abs/2407.10283);
  [NumColBERT 2026](https://arxiv.org/abs/2605.10109)).
- Separately, the number of distinct top-k result sets a single-vector
  embedding can return is bounded by its dimension. State-of-the-art models
  fail the authors' simple LIMIT dataset
  ([Weller et al. 2025](https://arxiv.org/abs/2508.21038)). This argues for
  handling "hilly AND evening AND near the lake" with filters, not one dot
  product.

Consequence: words like "long" and "hilly" in the card help fuzzy matching.
Any number in a *query* ("over 15 km", "more than 1,000 m") should become a
filter.

**Hosted models** (official pages, read 2026-11-09):

| Model | Price per 1M input tokens | Dimensions | Notes |
|---|---|---|---|
| OpenAI `text-embedding-3-small` / `-large` | $0.02 / $0.13 | 1536 / 3072, shortenable via `dimensions` | 8,192-token input ([pricing](https://platform.openai.com/docs/pricing), [guide](https://platform.openai.com/docs/guides/embeddings)) |
| Google `gemini-embedding-2` | text $0.20 (batch $0.10); image $0.45 ($0.00012 per image) | 128–3072, recommended 768/1536/3072 | Text, image, video, audio and PDF in one space; stable, updated April 2026; 8,192-token input. Free tier: content "used to improve our products" ([model](https://ai.google.dev/gemini-api/docs/models/gemini-embedding-2), [pricing](https://ai.google.dev/gemini-api/docs/pricing), [paper](https://arxiv.org/abs/2605.27295)) |
| Google `gemini-embedding-001` | $0.15 | | Text only ([pricing](https://ai.google.dev/gemini-api/docs/pricing)) |
| Voyage `voyage-4-large` / `voyage-4` / `voyage-4-lite` | $0.12 / $0.06 / $0.02; first 200M tokens free | 256/512/1024/2048 | 32k context; all Voyage 4 models share one space ([pricing](https://docs.voyageai.com/docs/pricing), [models](https://docs.voyageai.com/docs/embeddings)) |
| Voyage `voyage-multimodal-3.5` | $0.12 + $0.60 per billion pixels | 256–2048 | Interleaved text + images (+ video) ([docs](https://docs.voyageai.com/docs/multimodal-embeddings)) |
| Cohere `embed-v5.0-pro` / `-fast` (and `embed-v4.0`) | not verified (pricing page didn't render for me) | 256–2048 (v4: 256–1536) | Text, images, mixed input; 128k context ([models](https://docs.cohere.com/docs/cohere-embed)) |
| Mistral `mistral-embed` | $0.10 | | Released 2023-12; 8k context; Mistral rates its own performance 2/5 ([model](https://docs.mistral.ai/models/mistral-embed-23-12)) |

Cost is not the issue. 531 cards at roughly 150 tokens each (my estimate) is
about 80k tokens: under 2 cents at any price above. The issue is the owner's
rule in #35: "embeddings … with a local model, so no data leaves the
machine". It also matters that text embeddings can be inverted: one method
recovers 92% of 32-token inputs exactly from the vector
([Morris et al. 2023](https://arxiv.org/abs/2310.06816)). A card vector
built from private fields is effectively that text.

**Local / open models** (model cards, read 2026-11-09):

| Model | Size | Dimensions | Context | Licence | In-browser ONNX download |
|---|---|---|---|---|---|
| **EmbeddingGemma-300m** | 308M | 768, truncatable (MRL) to 512/256/128 | 2K | Gemma terms, gated on HF | q4 ≈ 197 MB, q8 ≈ 309 MB, fp32 ≈ 1.23 GB |
| Qwen3-Embedding-0.6B | 0.6B | 32–1024 | 32k | Apache-2.0 | q4f16 ≈ 568 MB |
| voyage-4-nano | 180M non-embedding + 160M embedding params | 256–2048 | 32k | Apache-2.0 | not checked |
| BGE-M3 | | 1024 (dense + sparse + multi-vector) | 8192 | MIT | not checked |
| nomic-embed-text-v1.5 | | MRL, resizable | | Apache-2.0 | not checked |
| all-MiniLM-L6-v2 | | 384 | truncates past 256 word pieces | Apache-2.0 | int8 ≈ 23 MB |

Sources: EmbeddingGemma is "308M parameters and a 2K context window", over
100 languages, "under 200 MB of RAM when quantized", and needs its query and
document prompts ("task: search result | query: ", "title: none | text: ")
or performance is "suboptimal"
([HF blog](https://huggingface.co/blog/embeddinggemma),
[ONNX card](https://huggingface.co/onnx-community/embeddinggemma-300m-ONNX),
which also notes no fp16 support). Qwen3-Embedding says instructions improve
results by 1–5% ([card](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B)).
voyage-4-nano embeddings are compatible with Voyage's hosted Voyage 4 models
([card](https://huggingface.co/voyageai/voyage-4-nano),
[docs](https://docs.voyageai.com/docs/embeddings)). Other cards:
[BGE-M3](https://huggingface.co/BAAI/bge-m3),
[nomic](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5),
[MiniLM](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2).
Download sizes come from the Hugging Face file listings
([EmbeddingGemma](https://huggingface.co/onnx-community/embeddinggemma-300m-ONNX/tree/main/onnx),
[MiniLM](https://huggingface.co/Xenova/all-MiniLM-L6-v2/tree/main/onnx),
[Qwen3](https://huggingface.co/onnx-community/Qwen3-Embedding-0.6B-ONNX/tree/main/onnx)).

Multilingual support matters here because place names are Slovenian
(Šmarna gora, Vršič). Exact names are still better served by the place
filter or [FTS5](https://www.sqlite.org/fts5.html) than by vectors. #35 already says "Near X must be answered by
geo, not by vectors."

### b. Hand-engineered numeric feature vector

**How it works.** Roughly 30–60 numbers per activity, each standardized
(z-score) within activity type, grouped into blocks that get a weight:

- **Effort:** log distance, log moving time, climbing per km, highest point,
  pace or speed, average HR, HR zone fractions (`hr_zone_seconds`), aerobic
  TE.
- **When:** time of day and day of year as sin/cos pairs, so 23:00 is next
  to 01:00 and December next to January. Weekend flag.
- **Where:** start and end position in local metres, or H3 cells. An H3
  resolution-7 cell has an average edge of 1.41 km, resolution 8 of 0.53 km
  ([H3 tables](https://h3geo.org/docs/core-library/restable/)).
- **Shape:** route shape (loop / out-and-back / point-to-point, from the
  place-tags design), and the route profile from `profiles.json` resampled
  to 16–32 points, as a fraction of distance.

Compare with cosine or Euclidean distance. This is what "like this one"
usually means: about as long, about as hilly, same time of day, same area. It
can't take a text query, and the block weights are a judgment call to tune
in the evaluation. Because most runs start at the same point, the "where"
block needs a low weight or it will dominate.

### c. Trajectory distances and learned trajectory embeddings

**Classic measures.** DTW, discrete Fréchet, Hausdorff, LCSS, EDR, ERP and
SSPD are all in `traj-dist` (MIT; Euclidean or haversine), which gives the
original references
([README](https://github.com/bguillouet/traj-dist); LCSS:
[Vlachos et al. 2002](https://doi.org/10.1109/ICDE.2002.994784); EDR:
[Chen et al. 2005](https://doi.org/10.1145/1066157.1066213)).
Fréchet and DTW follow the order of points, so a loop run backwards counts
as different. Hausdorff does not.

**Learned embeddings.**

- t2vec (ICDE 2018): Julia and PyTorch code, with a README that walks
  through the Porto taxi dataset
  ([repo](https://github.com/boathit/t2vec)). A follow-up study concludes
  that "using t2vec in combination with classical models may be the best
  way" ([Taghizadeh et al.](https://doi.org/10.1016/j.is.2019.101452)).
- TrajCL (ICDE 2023): self-supervised, can be fine-tuned to approximate
  Hausdorff and similar measures. Its README trains per dataset (Porto) and
  needs a custom preprocessing script for your own data
  ([paper](https://arxiv.org/abs/2210.05155),
  [repo](https://github.com/changyanchuan/TrajCL)).
- START needs a road network
  ([arXiv 2211.09510](https://arxiv.org/abs/2211.09510)).
- UniTraj (NeurIPS 2025) is trained on WorldTrace, 2.45 million
  trajectories across 70 countries. Its README ships training code and the
  dataset, but I found no pretrained checkpoint listed
  ([paper](https://arxiv.org/abs/2411.03859),
  [repo](https://github.com/Yasoz/UniTraj)).
- TrajTok (2026) reports results on Porto
  ([arXiv 2605.20134](https://arxiv.org/abs/2605.20134)).

An efficiency study finds that learned embeddings only pay off when they can
be precomputed over large collections. Heuristic measures are more efficient
for one-off computations
([Chang et al. 2023](https://arxiv.org/abs/2311.00960)).

**Verdict.** At 448 routes, exact distances are cheap (seconds, measured
above), deterministic, and need no model. Transfer from city taxi traces to
one person's hikes is untested in any source I found. Use discrete Fréchet,
or Hausdorff if direction shouldn't matter, to re-rank the top candidates
from (b), and to build the evaluation's ground truth.

### d. Rendered route image + image or multimodal embedding

**How it works.** Draw each route as a PNG, either the bare line or over a
basemap, and embed it. Options:

- Gemini Embedding 2 can combine text and an image into **one aggregated
  embedding**: up to 6 PNG/JPEG images per request, and it advises against
  task prefixes on multimodal input
  ([embeddings docs](https://ai.google.dev/gemini-api/docs/embeddings)).
- Voyage multimodal 3.5 takes interleaved text and images
  ([docs](https://docs.voyageai.com/docs/multimodal-embeddings)).
- Cohere Embed 5 takes text, images and mixed input
  ([docs](https://docs.cohere.com/docs/cohere-embed)).
- Locally: jina-embeddings-v4 (3.8B parameters,
  [paper](https://arxiv.org/abs/2506.18902); licence not checked) or SigLIP 2
  (Apache-2.0, [paper](https://arxiv.org/abs/2502.14786),
  [card](https://huggingface.co/google/siglip2-base-patch16-224)).

**Trade-offs.**

- An image captures overall shape and, on a basemap, water and forest. It
  loses scale: a 5 km and a 50 km loop of the same shape look alike.
- Two-encoder models like CLIP place images and texts "at arm's length"
  ([modality gap](https://arxiv.org/abs/2203.02053)), so text→image and
  image→image scores aren't on the same scale. Voyage says its single
  backbone avoids that bias (vendor claim).
- Cost is tiny (Gemini $0.00012 per image, so about $0.05 for 448 routes),
  but a route image is location data leaving the machine.
- I did not check basemap tile licensing for offline rendering.
- The place tags already give "near the lake" deterministically.

Not now.

### e. Time-series encoders on the streams

- **MOMENT** (MIT) has an `embedding` task. Input is univariate with a fixed
  length of 512, and reversible instance normalization is applied first
  ([repo](https://github.com/moment-timeseries-foundation-model/moment),
  [paper](https://arxiv.org/abs/2402.03885)).
- **Chronos-2** (120M, Apache-2.0) has `embed()`. It returns per-patch
  encoder embeddings of shape `(n_variates, num_patches + 2, d_model)`, with
  each series' mean and standard deviation returned separately
  ([source](https://github.com/amazon-science/chronos-forecasting/blob/main/src/chronos/chronos2/pipeline.py),
  [paper](https://arxiv.org/abs/2510.15821)).

Both normalize away absolute level, so a recovery jog and a tempo run with
the same shape look alike unless the level is added back. You would also
have to choose how to pool patches into one vector, and neither model takes
text. `hr_zone_seconds`, lap structure and pace variability as features in
(b) capture most of "intervals vs steady" at no cost. Not now.

### Single vector or several

| Design | Similarity | Text search | What's lost |
|---|---|---|---|
| **One text-card vector** | Text-card vs text-card cosine | Yes | Route identity, exact numbers, weights fixed when the card is written |
| **One concatenated vector** `[α·text ; β·numeric]`, each part unit-length | α²·text + β²·numeric | Query `[text_q ; 0]` scores only the text part | Same as two vectors with weights fixed at write time; re-embed to change α, β |
| **Named vectors** (text, numeric) + fused score | Weighted or reciprocal-rank fusion, tunable per question | Yes, text part | Nothing extra; one more column |
| **Filters first, then vector ranking** | Not needed | Yes: structured parts are exact, vector ranks the fuzzy remainder | Needs a query parser (here, the MCP client LLM) |

On the question of a **single vector**: it can serve both uses only if it is
a text-model vector, because only a text-aligned space accepts a query. The
concatenation trick shows that "one vector" is mostly a storage choice. A
zero-padded query sees only the text part, while activity-to-activity
comparison sees both parts. But that is just two vectors with weights you
can't change without re-embedding. Named vectors per point and fused queries
are a standard pattern
([Qdrant named vectors](https://qdrant.tech/documentation/concepts/vectors/),
[hybrid queries with RRF](https://qdrant.tech/documentation/concepts/hybrid-queries/);
RRF: [Cormack et al. 2009](https://doi.org/10.1145/1571941.1572114)).
At 531 rows you don't need a vector database for this: two arrays and a
weighted sum do it.

## Storage and search at this scale

Vector sizes for 531 activities:

| Dimensions | float32 | int8 | binary |
|---|---|---|---|
| 32 (numeric features) | 68 KB | 17 KB | – |
| 256 | 544 KB | 136 KB | 17 KB |
| 384 (MiniLM) | 816 KB | 204 KB | 25 KB |
| 768 (EmbeddingGemma) | 1.63 MB | 408 KB | 51 KB |
| 1024 | 2.17 MB | 544 KB | 68 KB |

- **Brute force is enough.** One query against 531 × 768 floats is about
  0.4M multiply-adds, in numpy or JavaScript. No index needed.
- **sqlite-vec** (Apache-2.0) is pre-v1 ("expect breaking changes"). Latest
  stable is v0.1.9 (2026-03-31), with v0.1.10 alphas since. It stores
  float, int8 and binary vectors in `vec0` tables with metadata columns and
  a cosine metric, and can be compiled into SQLite's WASM build
  ([README](https://github.com/asg017/sqlite-vec),
  [releases](https://github.com/asg017/sqlite-vec/releases),
  [KNN docs](https://alexgarcia.xyz/sqlite-vec/features/knn.html),
  [WASM](https://alexgarcia.xyz/sqlite-vec/wasm.html)). Its search is
  brute force too ("Only brute-force search for now",
  [release post](https://alexgarcia.xyz/blog/2024/sqlite-vec-stable-release/index.html)).
  At this size it adds a native dependency for no speed gain. A plain
  `BLOB` column plus numpy is enough. Revisit if SQL-side KNN with filters
  becomes useful.
- **Static site:**
  - A **"similar activities" list** precomputed at build time (10 ids per
    activity) is about 70 KB of JSON before compression. It needs no model
    and ships no vectors.
  - **Free-text search in the browser** needs the document vectors (above)
    *and* the same model to embed the query. Transformers.js runs ONNX
    models in the browser on CPU (WASM) or WebGPU
    ([docs](https://huggingface.co/docs/transformers.js/index)). The download
    is about 23 MB for MiniLM int8 and about 197 MB for EmbeddingGemma q4,
    against a 240 KB `activities.json` today.
  - Shipping text vectors also publishes whatever the card contains (see
    inversion above).

## Prior art

- **Strava Matched Activities** (subscribers, private to the owner): "the
  algorithm identifies the starting and ending points of the route, the
  direction of the route, and the distance completed". An activity that
  differs "just enough" starts a new cluster
  ([Strava Help](https://support.strava.com/en-us/articles/15401955-how-do-i-view-my-matched-activities),
  article dated 2026-09-18). This is route matching, not embedding.
- **intervals.icu activity routes** (developer post, 2025-01-13): "The
  distance needs to be within 2%, then the route is checked to see how
  closely it matches". A route done in reverse is a different route
  ([forum](https://forum.intervals.icu/t/activity-routes-beta-testing-needed/86792)).
- **Komoot's** help page says route recommendations come from other users'
  activities in the area, with no algorithm details
  ([help](https://www.komoot.com/help/tour-recommendations)). I found no
  first-party Garmin description of activity-to-activity similarity.
- **Research.** FitRec (WWW 2019) models workout records with HR and GPS
  from Endomondo (over 250k workouts) to predict HR profiles and recommend
  activities, not to search them
  ([paper](https://cseweb.ucsd.edu/~jmcauley/pdfs/www19.pdf)). The
  trajectory papers in (c) are about geometry only. **I found no paper that
  embeds whole workouts (metadata + track + streams) into one vector for
  natural-language search.** Treat this design as untested ground, and
  evaluate it.

## How to tell whether it works (no labels)

1. **Route identity.** Use the repeated-route groups above as positives: 19
   strict groups (62 activities) or 24 loose groups (121). For each member,
   check recall@5 and MRR of its group mates under each representation: text
   card, numeric features, features + Fréchet re-rank. Fréchet itself is the
   upper bound.
2. **Agreement with track distance.** Over same-type GPS pairs, measure the
   Spearman correlation between vector similarity and discrete Fréchet
   distance, and the overlap of each activity's top 10.
3. **A small query set** in a CSV, about 30 queries in three tiers:
   - *Structured*, with truth from SQL: "evening runs in autumn 2025", "rides
     over 50 km".
   - *Place and shape*, with truth from place tags: "loop hikes to a peak".
   - *Fuzzy*, judged by the owner: "easy recovery jog", "cold rainy walk",
     "big mountain day".

   Score precision@10 and nDCG@10 for vector-only, filters-only and
   filters + vector.
4. **Numeracy probe.** "Runs longer than 15 km" and "hikes with more than
   1,000 m of climbing", vector-only: count the wrong results in the top 10.
   This should show that numbers need filters.
5. **Determinism.** Re-running produces identical vectors (CPU, fp32, fixed
   card version and model id), in keeping with "tags that change on their
   own" being an anti-goal.

## Recommendation for this repo

**v1, in two independent parts:**

1. **"Similar activities": no ML model.**
   - Compute the numeric feature vector (b) per activity, take the top 30
     neighbours by weighted cosine within the same type, and re-rank GPS
     activities by discrete Fréchet (c), or Hausdorff if a reversed route
     should count as the same.
   - Deterministic and cheap, so it can run in the existing build/CI path.
   - Ship only the top 10 ids per activity to the site (about 70 KB). No
     start/end cells or vectors leave the database, which keeps clear of the
     "home place" anti-goal.
   - Expose it as an MCP tool, `similar_activities(activity_id, k)`, with the
     usual `counted`.
2. **Text search: MCP only, local model.**
   - Build the card text (a) from columns, place tags and route shape, with
     a card version number. Embed it with **EmbeddingGemma-300m** through
     sentence-transformers, using its document prompt for cards and its
     query prompt for queries. Keep 768 dimensions, or truncate to 256 if
     the experiment shows no loss.
   - Cache vectors keyed by `sha256(card text) + model id`. Start with a
     side file next to the MCP cache (`data/mcp/`). That needs no schema
     bump and no model in CI, and the database stays the source of truth.
     Move it into the ingest write job only if the site ever needs it.
   - New tool: `search_activities(text, …filters)`. The filters reuse
     `list_activities`' parameters plus `place` and `route_shape` from the
     place-tags design. The calling LLM parses the request into filters; the
     vector only ranks inside the filtered set, and `counted` says so.
   - Fallback model if the Gemma licence or the gated download is a
     problem: Qwen3-Embedding-0.6B (Apache-2.0).

**Cost and size:** $0 in API fees, and nothing leaves the machine. About
1.6 MB of float32 vectors for 531 cards. The model weights are the large
part: 1.23 GB fp32 per the ONNX listing; I didn't check the PyTorch download
size. Embedding time on this machine's CPU is not measured.

**Defer:** free-text search on the site (if wanted, MiniLM at about 23 MB is
the cheapest client-side path), image embeddings, time-series encoders,
learned trajectory models and sqlite-vec.

### An afternoon experiment

Scratch scripts only, reading the database read-only:

1. Build cards for all 531 activities. Before place tags exist, use type,
   local time, season, distance/climb/HR buckets, route shape computed
   inline, and the weather line only if the owner agrees.
2. Embed the cards with all-MiniLM-L6-v2 and EmbeddingGemma-300m (needs an
   HF login for the gated weights). Optionally add Qwen3-Embedding-0.6B.
3. Compute the numeric features and the discrete Fréchet matrix. The
   repeated-route script used for this note already does the Fréchet part
   in about 13 s.
4. Run evaluation steps 1, 3 and 4 above. Write about 25 queries: 10
   structured with SQL truth, 15 fuzzy judged by the owner.
5. **Decide:**
   - Keep text vectors only if filters + vector beat filters-only on the
     fuzzy tier.
   - Ship "similar" if features + Fréchet re-rank gets close to Fréchet's own
     recall on route groups.
   - If the text card's route-group recall is far below the features, that
     confirms one vector shouldn't do both jobs.

## Open questions for the owner

- **Does a reversed loop count as the same route?** Strava and intervals.icu
  both say no. Discrete Fréchet or Hausdorff follows from the answer.
- **May the automated description lines go into cards and search?** The
  weather lines (strautomator) and Wandrer counts would help queries like
  "cold rainy walk", but the MCP server treats `summary_json` as private. An
  alternative is to parse the weather into structured columns.
- **Is local-only still the rule?** Hosted models cost cents here, but #35
  rules them out, and Gemini's free tier uses content to improve Google's
  products.
- **Should the site get text search at all,** or only "similar activities"?
- **Is the Gemma licence and gated download acceptable,** or start with
  Qwen3-Embedding-0.6B?
- **How should the 83 activities without GPS be compared?** By stats and
  time only, and only within their type?

## Sources

All read 2026-11-09.

Models and APIs
- OpenAI pricing: https://platform.openai.com/docs/pricing
- OpenAI embeddings guide: https://platform.openai.com/docs/guides/embeddings
- Gemini Embedding 2 model page: https://ai.google.dev/gemini-api/docs/models/gemini-embedding-2
- Gemini embeddings guide: https://ai.google.dev/gemini-api/docs/embeddings
- Gemini pricing: https://ai.google.dev/gemini-api/docs/pricing
- Gemini Embedding 2 technical report: https://arxiv.org/abs/2605.27295
- Voyage pricing: https://docs.voyageai.com/docs/pricing
- Voyage text embeddings: https://docs.voyageai.com/docs/embeddings
- Voyage multimodal embeddings: https://docs.voyageai.com/docs/multimodal-embeddings
- voyage-4-nano: https://huggingface.co/voyageai/voyage-4-nano
- Cohere embed models: https://docs.cohere.com/docs/cohere-embed
- Cohere Embed v4 changelog: https://docs.cohere.com/changelog/embed-multimodal-v4
- Mistral Embed: https://docs.mistral.ai/models/mistral-embed-23-12
- EmbeddingGemma (HF blog): https://huggingface.co/blog/embeddinggemma
- EmbeddingGemma ONNX card and files: https://huggingface.co/onnx-community/embeddinggemma-300m-ONNX
- Qwen3-Embedding-0.6B: https://huggingface.co/Qwen/Qwen3-Embedding-0.6B
- Qwen3-Embedding-0.6B ONNX files: https://huggingface.co/onnx-community/Qwen3-Embedding-0.6B-ONNX/tree/main/onnx
- BGE-M3: https://huggingface.co/BAAI/bge-m3
- nomic-embed-text-v1.5: https://huggingface.co/nomic-ai/nomic-embed-text-v1.5
- all-MiniLM-L6-v2: https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2 and ONNX files https://huggingface.co/Xenova/all-MiniLM-L6-v2/tree/main/onnx
- jina-embeddings-v4: https://arxiv.org/abs/2506.18902
- SigLIP 2: https://arxiv.org/abs/2502.14786 and https://huggingface.co/google/siglip2-base-patch16-224
- CLIP: https://arxiv.org/abs/2103.00020
- Modality gap: https://arxiv.org/abs/2203.02053
- Matryoshka Representation Learning: https://arxiv.org/abs/2205.13147
- Transformers.js: https://huggingface.co/docs/transformers.js/index

Embeddings and numbers, limits, privacy
- Revealing the Numeracy Gap (Deng et al.): https://arxiv.org/abs/2509.05691
- Do NLP Models Know Numbers? (Wallace et al.): https://arxiv.org/abs/1909.07940
- Numbers Matter! (Almasian et al.): https://arxiv.org/abs/2407.10283
- NumColBERT: https://arxiv.org/abs/2605.10109
- On the Theoretical Limitations of Embedding-Based Retrieval (LIMIT): https://arxiv.org/abs/2508.21038
- Text Embeddings Reveal (Almost) As Much As Text: https://arxiv.org/abs/2310.06816

Trajectories
- traj-dist: https://github.com/bguillouet/traj-dist
- LCSS (Vlachos et al. 2002): https://doi.org/10.1109/ICDE.2002.994784
- EDR (Chen et al. 2005): https://doi.org/10.1145/1066157.1066213
- t2vec code: https://github.com/boathit/t2vec
- How meaningful are similarities in deep trajectory representations?: https://doi.org/10.1016/j.is.2019.101452
- TrajCL: https://arxiv.org/abs/2210.05155 and https://github.com/changyanchuan/TrajCL
- START: https://arxiv.org/abs/2211.09510
- UniTraj: https://arxiv.org/abs/2411.03859 and https://github.com/Yasoz/UniTraj
- TrajTok: https://arxiv.org/abs/2605.20134
- Trajectory Similarity Measurement: An Efficiency Perspective: https://arxiv.org/abs/2311.00960
- H3 cell statistics: https://h3geo.org/docs/core-library/restable/

Time series
- MOMENT: https://github.com/moment-timeseries-foundation-model/moment and https://arxiv.org/abs/2402.03885
- Chronos / Chronos-2: https://github.com/amazon-science/chronos-forecasting (`embed()` in `src/chronos/chronos2/pipeline.py`) and https://arxiv.org/abs/2510.15821

Search and storage
- sqlite-vec: https://github.com/asg017/sqlite-vec, https://github.com/asg017/sqlite-vec/releases, https://alexgarcia.xyz/sqlite-vec/features/knn.html, https://alexgarcia.xyz/sqlite-vec/wasm.html, https://alexgarcia.xyz/blog/2024/sqlite-vec-stable-release/index.html
- SQLite FTS5: https://www.sqlite.org/fts5.html
- Qdrant named vectors: https://qdrant.tech/documentation/concepts/vectors/
- Qdrant hybrid queries: https://qdrant.tech/documentation/concepts/hybrid-queries/
- Reciprocal Rank Fusion (Cormack et al. 2009): https://doi.org/10.1145/1571941.1572114

Prior art
- Strava Matched Activities: https://support.strava.com/en-us/articles/15401955-how-do-i-view-my-matched-activities
- intervals.icu activity routes: https://forum.intervals.icu/t/activity-routes-beta-testing-needed/86792
- Komoot route recommendations: https://www.komoot.com/help/tour-recommendations
- FitRec (Ni, Muhlstein, McAuley, WWW 2019): https://cseweb.ucsd.edu/~jmcauley/pdfs/www19.pdf

Repo
- Issue #35 (scope, local-model rule, "near X by geo")
- `docs/2026-11-08-place-tags-design.md` (place tags, route shape, home-place anti-goal)
- `ingest/db.py`, `ingest/codec.py`, `ingest/mcp_server/geo.py`
