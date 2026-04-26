# Istanbul 3D — neighborhood property browser

Pre-product. Goal: interactive 3D visualizations of Istanbul neighborhoods so property buyers can explore real estate in spatial context.

**Rendering stack:** CesiumJS (decided in CAPAAA-2). Cesium streams OSM Buildings + World Terrain natively, so the v0 data work below is just about producing a local store of building footprints + heights + OSM IDs we can join mock listings against.

## Run the demo

```bash
npm install
npm run dev
```

Opens the Beşiktaş prototype on `http://localhost:5173/` (or 5174 if 5173 is busy):

- Camera: orbit, pan, zoom (Cesium defaults — left-drag, right-drag, scroll).
- **Gold buildings** carry a curated mock listing — click one to see price, beds/baths, floor, photos, description, and the listing agent (CAPAAA-5).
- Click any other building to see its raw OSM metadata (height, levels, address, tags).
- "Day / Night view" button in the top bar toggles world lighting (day/night).

Listing data is in `data/mock-listings.json`; each entry is keyed to a real `osm_id` from the building store. Replace with real listings in v1.

No Cesium ion token required: imagery is OSM raster tiles, buildings are extruded from the local GeoJSON we generate below. World Terrain + Cesium OSM Buildings will plug in later when we add an ion token.

### Photoreal pipeline (CAPAAA-39 spike, CAPAAA-48 rollout)

The viewer has a photoreal pipeline that activates when both keys are present. With no keys set, dev runs exactly as before.

```bash
# .env.local (Vite reads this automatically; do not commit)
VITE_CESIUM_ION_TOKEN=eyJ...     # Cesium ion access token (required for CWT)
VITE_GOOGLE_MAPS_KEY=AIza...     # Google Maps Platform key with Map Tiles API + photoreal SKU
# VITE_PHOTOREAL=0               # opt-out hatch even with keys present
```

`?photoreal=0` / `?photoreal=1` URL params also force off / on per session.

When active, the pipeline:

- Replaces the ellipsoid terrain with Cesium World Terrain.
- Loads `Cesium.createGooglePhotorealistic3DTileset` with `showCreditsOnScreen: true` (Google attribution is mandatory per Map Tiles API policies — see the attribution overlay below).
- Clips a coarse Bosphorus polygon out of the photoreal mesh (`ClippingPolygonCollection({ inverse: true })`).
- Layers a placeholder water primitive (Cesium built-in `Water` material) inside the clip — final shader lands in v1.
- Hides the local OSM extrusions (still alive for `drillPick` listing-join).
- Adds a warm LUT `PostProcessStage` and tunes `scene.fog` / `scene.atmosphere` / `scene.skyAtmosphere`.

Click handling routes through `drillPick` whenever the top hit isn't a building entity, so clicks on the photoreal mesh still resolve to the underlying invisible footprint and look up the listing by `osm_id`.

#### Attribution overlay (CAPAAA-48)

Cesium's `creditContainer` is wired to `#attribution-overlay` (bottom-right). The OSM raster credit and the dynamic Google Photoreal 3D Tiles credits both render there, and the Google per-tile attribution updates as the camera pans (per Map Tiles API ToS). The overlay is restyled to match the dark UI but is always visible whenever the photoreal mesh is on screen.

## Data pipeline (v0)

One district at a time. Default: **Beşiktaş**.

```bash
# Fetch building footprints from OpenStreetMap via Overpass and write GeoJSON.
npm run data:besiktas

# Smoke-test the resulting store.
node scripts/query-buildings.mjs --district besiktas summary
node scripts/query-buildings.mjs --district besiktas tallest 5
node scripts/query-buildings.mjs --district besiktas nearest 29.0093 41.0428
node scripts/query-buildings.mjs --district besiktas by-id way/1467663783
```

### Output

- `data/besiktas-buildings.geojson` — `FeatureCollection` of building footprint Polygons (WGS84 lon/lat).
- `data/districts.json` — district bbox + center + OSM relation id.

Each feature carries:

| property        | meaning                                                                |
| --------------- | ---------------------------------------------------------------------- |
| `osm_id`        | stable OSM identifier, e.g. `way/1467663783` — the listing join key    |
| `height_m`      | numeric height in meters (parsed or estimated)                         |
| `height_source` | `tag:height` (explicit) / `tag:levels` (×3 m/floor) / `estimate` (9 m) |
| `levels`        | floor count when known                                                 |
| `building`      | OSM building tag value (`yes`, `residential`, `commercial`, …)         |
| `name`          | OSM name tag, if any                                                   |
| `addr`          | compact `{ street, housenumber, postcode, … }` from `addr:*` tags      |

### Current coverage

- District: **Beşiktaş** (bbox `[41.035, 29.000, 41.085, 29.060]`)
- Buildings: **14,617**
- Height sources: **57** explicit `height` tags, **210** from `building:levels`, the rest estimated (3 floors × 3 m).
- File size: **~5.5 MB** raw GeoJSON (single line; gzips to <1 MB).

The estimate-heavy distribution is fine for a demo; we get correct heights for the visually dominant towers (Levent skyscrapers, ÖzdilekPark, Torun Center, Çiftçi Towers) and reasonable boxes for everything else. Cesium's own OSM Buildings tileset (LOD2) is what we will actually render — this local store exists to drive listing-to-building joins, click-to-inspect metadata, and any custom highlight overlays.

### Terrain

No local pipeline. We use Cesium World Terrain via Cesium ion (covered by the rendering stack decision). When we self-host, we can swap to a free terrain provider behind the same API; that's a two-way door.

### Refreshing data

Re-run `npm run data:besiktas`. The Overpass query is keyed off `data/districts.json`. To add a district, append an entry there with `bbox` + `center` and pass `--district <key>`.

### Source / license

OpenStreetMap contributors, via Overpass API. **Output data inherits the [ODbL](https://opendatacommons.org/licenses/odbl/) license** — attribute "© OpenStreetMap contributors" anywhere we display it.
