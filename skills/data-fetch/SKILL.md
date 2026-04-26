---
name: data-fetch
description: Use when a `needs_data` issue asks for public, ToS-clean geospatial data (OSM building footprints, place geometry, bbox lookups) for the Istanbul 3D-visual project. Wraps WebSearch + WebFetch + Nominatim + Overpass behind an allow-list and a one-heartbeat budget.
---

# data-fetch

The minimum viable pattern for "we are missing data; go get it" issues on the Istanbul 3D-visual project.

Approved by the board on [CAPAAA-9](/CAPAAA/issues/CAPAAA-9) — defer hiring a dedicated `DataResearcher` agent until this skill is proven insufficient (≥ 2 concurrent data hunts, or a multi-source crawl that needs its own context).

## When to use this skill

Trigger when ALL of the following are true:

- The active issue has the label `needs_data` (or its title starts with `data:`).
- The artifact wanted is public, license-clean, and named in the issue description (file format, schema, bounds/time range, acceptance check).
- The data fits within one heartbeat: at most a few sources, no multi-page crawl, no login-walled site.

If any of those fail, **stop and escalate to the CEO** instead of running the skill. Specifically, escalate when:

- The source is a commercial listings site (Sahibinden, Hürriyet Emlak, Zingat, Endeksa, etc.).
- The source requires login, paid API access, captcha-solving, or scraping behind robots.txt.
- The hunt clearly needs more than one heartbeat — graduate to a `DataResearcher` agent instead.

## Allow-list (v0)

Only fetch from these domains. Anything else requires explicit board approval before use.

| Domain | Use | Notes |
|---|---|---|
| `nominatim.openstreetmap.org` | Place name → bbox/centroid | Max 1 req/s, descriptive UA required |
| `overpass-api.de` | OSM tag queries by bbox | Plus mirrors `overpass.kumi.systems`, `overpass.openstreetmap.fr` |
| `*.tile.openstreetmap.org` | Raster tiles (read-only) | ODbL attribution required if displayed |
| `data.ibb.gov.tr` | İBB open data portal | Public, but check per-dataset licence before redistribution |
| `www.openstreetmap.org` | Source provenance / human verification | HTML only, no scraping at scale |

For sources outside this list, append a row in this table via PR + CEO sign-off before fetching.

## Required behaviours

- Identify with `User-Agent: istanbul-3d/0.0.0 (paperclip pre-product; founding engineer; contact via project README)` on every request.
- Sleep ≥ 1s between Nominatim calls. Single Overpass call per `needs_data` issue when possible.
- Hard cap of 20 000 features per run (override with `--max-features` only after escalating). If a bbox blows the cap, tighten the bbox or split the district.
- Cache: every fetched artifact is attached to the originating `needs_data` issue and committed under `data/` so we never re-hit a third party for the same bbox.
- Budget: cap a single `needs_data` issue at one heartbeat. If you cannot finish in one heartbeat, set the issue to `blocked` with a clear blocker comment and escalate.

## End-to-end recipe (the Cihangir worked example)

Goal: ship an Istanbul neighborhood as a sibling of Beşiktaş in the renderer.

1. **Read the issue.** Confirm the label/title, the wanted artifact, and the acceptance check. If any field is missing, ask in the issue thread before fetching.
2. **Resolve the bbox.** Add the neighborhood to `data/districts.json` via the Nominatim helper:

   ```sh
   node scripts/resolve-bbox.mjs --slug cihangir \
     --query "Cihangir, Beyoğlu, Istanbul, Turkey" \
     --name "Cihangir"
   ```

3. **Fetch buildings.** Reuse the existing Overpass client — same shape as Beşiktaş in [CAPAAA-3](/CAPAAA/issues/CAPAAA-3):

   ```sh
   node scripts/fetch-osm-buildings.mjs --district cihangir
   ```

   Output goes to `data/<slug>-buildings.geojson` with metadata (count, bbox, height-source breakdown).

4. **Sanity check.** Reject the result and escalate if any of these fail:
   - feature count < 50 (probably a bad bbox)
   - feature count > 50 000 (probably the bbox swallowed a neighbour)
   - `building` tag missing on > 5% of features
   - any feature outside the resolved bbox

5. **Wire into the renderer.** Vite is configured with `publicDir: 'data'` (see `vite.config.js`), so anything in `data/` is served at the site root automatically — no copy step. Add the slug to the renderer's district registry in `src/main.js` only if the parent issue asks for it. Otherwise, just attach + commit.

6. **Close the loop.** On the `needs_data` issue:
   - upload the GeoJSON as an attachment (`POST /api/companies/{companyId}/issues/{issueId}/attachments`),
   - post a comment with: artifact path, source URLs, feature count, height-source breakdown, license,
   - PATCH the issue to `done`.

   The parent issue wakes via `issue_blockers_resolved` and finishes the renderer-side wiring.

## Issue contract

A `needs_data` child issue MUST include:

- **What** — concrete artifact (file format, schema, bounds/time range).
- **Where** — destination path inside the repo, e.g. `data/cihangir-buildings.geojson`.
- **Sources tried** — what the parent already attempted, so we don't loop.
- **Acceptance check** — a mechanical check the skill can run (e.g. "feature count > 100 and `building` tag present").
- **License** — expected source licence (ODbL for OSM). Skill refuses to attach if the license slot is empty.

## Failure modes & escalation

| Symptom | Action |
|---|---|
| Nominatim returns no result | Try a more specific query (add district + city + country); if still empty, comment + `blocked`. |
| All Overpass mirrors 5xx for > 2 minutes | Comment with the timestamps + `blocked`; do not retry in a tight loop. |
| Source not on allow-list | Stop. Comment with the source + the reason it is needed; assign back to CEO for board approval. |
| Two `needs_data` issues open at once on this agent | Stop. Comment on both, escalate to CEO with a recommendation to graduate to `DataResearcher`. |

## Out of scope (do not do under this skill)

- Any kind of headless browser / JS-rendered scraping.
- Anything touching commercial property listings sites.
- Spawning sub-agents — that's the `DataResearcher` graduation path, not this skill.
- Modifying the renderer beyond adding a new district to `data/` and (optionally) the registry in `src/main.js`.

## Files this skill owns

- `scripts/resolve-bbox.mjs` — Nominatim resolver, single-call, polite UA, writes `data/districts.json`.
- `scripts/fetch-osm-buildings.mjs` — Overpass client (already in repo from CAPAAA-3).
- `data/districts.json` — registry of resolved neighborhoods. Append-only via the resolver.
