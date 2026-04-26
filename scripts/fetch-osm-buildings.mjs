#!/usr/bin/env node
/**
 * Fetch OSM building footprints for an Istanbul district via Overpass API
 * and write them as a GeoJSON FeatureCollection.
 *
 * Each feature carries:
 *   - geometry: Polygon (lon/lat, WGS84)
 *   - properties.osm_id        : "way/123456789"
 *   - properties.height_m      : numeric height in meters (parsed or estimated)
 *   - properties.height_source : "tag:height" | "tag:levels" | "estimate"
 *   - properties.levels        : number of floors if known
 *   - properties.building      : OSM building tag value (yes, residential, ...)
 *   - properties.name          : OSM name tag, if present
 *   - properties.addr          : compact address object built from addr:* tags
 *
 * Usage:
 *   node scripts/fetch-osm-buildings.mjs --district besiktas
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.fr/api/interpreter",
];

const DEFAULT_LEVEL_HEIGHT_M = 3.0;
const ESTIMATE_DEFAULT_LEVELS = 3;
const DEFAULT_MAX_FEATURES_PER_RUN = 20_000;

function parseArgs(argv) {
  const args = { district: "besiktas" };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--district") args.district = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--endpoint") args.endpoint = argv[++i];
    else if (a === "--max-features") args.maxFeatures = Number(argv[++i]);
  }
  return args;
}

async function loadDistricts() {
  const raw = await fs.readFile(path.join(ROOT, "data/districts.json"), "utf8");
  return JSON.parse(raw);
}

function parseHeightTag(tag) {
  if (!tag) return null;
  // OSM allows values like "12", "12 m", "12.5", "12'6\"" — stick to simple numeric + m
  const m = String(tag).trim().match(/^([\d.]+)\s*m?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function deriveHeight(tags) {
  const heightTag = parseHeightTag(tags.height);
  if (heightTag) return { height_m: heightTag, height_source: "tag:height", levels: tags["building:levels"] ? Number(tags["building:levels"]) : null };
  const levels = Number(tags["building:levels"]);
  if (Number.isFinite(levels) && levels > 0) {
    return { height_m: +(levels * DEFAULT_LEVEL_HEIGHT_M).toFixed(1), height_source: "tag:levels", levels };
  }
  return {
    height_m: ESTIMATE_DEFAULT_LEVELS * DEFAULT_LEVEL_HEIGHT_M,
    height_source: "estimate",
    levels: ESTIMATE_DEFAULT_LEVELS,
  };
}

function extractAddr(tags) {
  const addr = {};
  for (const [k, v] of Object.entries(tags)) {
    if (k.startsWith("addr:")) addr[k.slice(5)] = v;
  }
  return Object.keys(addr).length ? addr : null;
}

function buildOverpassQuery(bbox) {
  const [s, w, n, e] = bbox;
  // Only ways for v0 — multipolygon relations are rare; capture them later if needed.
  return `[out:json][timeout:120];
(
  way["building"](${s},${w},${n},${e});
);
out geom tags;`;
}

async function fetchOverpass(query, endpointOverride) {
  const endpoints = endpointOverride ? [endpointOverride] : OVERPASS_ENDPOINTS;
  let lastErr;
  for (const url of endpoints) {
    try {
      process.stderr.write(`[overpass] POST ${url}\n`);
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Accept": "application/json",
          // Overpass operators require a descriptive UA; default node fetch UA gets 406'd.
          "User-Agent": "istanbul-3d/0.0.0 (paperclip pre-product; founding engineer; contact via project README)",
        },
        body: new URLSearchParams({ data: query }).toString(),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      const json = await res.json();
      return json;
    } catch (err) {
      process.stderr.write(`[overpass] ${url} failed: ${err.message}\n`);
      lastErr = err;
    }
  }
  throw lastErr ?? new Error("All Overpass endpoints failed");
}

function ringIsClosed(coords) {
  if (coords.length < 4) return false;
  const [a, b] = [coords[0], coords[coords.length - 1]];
  return a[0] === b[0] && a[1] === b[1];
}

function elementToFeature(el) {
  if (el.type !== "way" || !Array.isArray(el.geometry) || el.geometry.length < 3) return null;
  const ring = el.geometry.map((p) => [p.lon, p.lat]);
  if (!ringIsClosed(ring)) ring.push(ring[0]);
  if (ring.length < 4) return null;
  const tags = el.tags ?? {};
  const heightInfo = deriveHeight(tags);
  const props = {
    osm_id: `way/${el.id}`,
    building: tags.building ?? "yes",
    name: tags.name ?? null,
    height_m: heightInfo.height_m,
    height_source: heightInfo.height_source,
    levels: heightInfo.levels,
    addr: extractAddr(tags),
  };
  return {
    type: "Feature",
    id: props.osm_id,
    geometry: { type: "Polygon", coordinates: [ring] },
    properties: props,
  };
}

function summarize(features) {
  const heights = features.map((f) => f.properties.height_m).sort((a, b) => a - b);
  const sum = heights.reduce((a, b) => a + b, 0);
  const sources = features.reduce((acc, f) => {
    acc[f.properties.height_source] = (acc[f.properties.height_source] ?? 0) + 1;
    return acc;
  }, {});
  return {
    count: features.length,
    height_min_m: heights[0] ?? null,
    height_max_m: heights[heights.length - 1] ?? null,
    height_mean_m: heights.length ? +(sum / heights.length).toFixed(2) : null,
    height_source_breakdown: sources,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const districts = await loadDistricts();
  const district = districts[args.district];
  if (!district) {
    throw new Error(`Unknown district "${args.district}". Known: ${Object.keys(districts).join(", ")}`);
  }
  const query = buildOverpassQuery(district.bbox);
  const t0 = Date.now();
  const json = await fetchOverpass(query, args.endpoint);
  const elements = json.elements ?? [];
  process.stderr.write(`[overpass] received ${elements.length} elements in ${Date.now() - t0}ms\n`);

  const features = elements.map(elementToFeature).filter(Boolean);
  const maxFeatures = Number.isFinite(args.maxFeatures) && args.maxFeatures > 0
    ? args.maxFeatures
    : DEFAULT_MAX_FEATURES_PER_RUN;
  if (features.length > maxFeatures) {
    throw new Error(
      `feature count ${features.length} exceeds per-run cap ${maxFeatures}; tighten the bbox, split the district, or pass --max-features`,
    );
  }
  const summary = summarize(features);

  const fc = {
    type: "FeatureCollection",
    metadata: {
      district: args.district,
      district_name: district.name,
      bbox: district.bbox,
      generated_at: new Date().toISOString(),
      source: "OpenStreetMap via Overpass API",
      license: "ODbL",
      ...summary,
    },
    features,
  };

  const outPath = args.out
    ? path.resolve(args.out)
    : path.join(ROOT, "data", `${args.district}-buildings.geojson`);
  await fs.writeFile(outPath, JSON.stringify(fc) + "\n");

  process.stderr.write(`[done] wrote ${features.length} buildings → ${path.relative(ROOT, outPath)}\n`);
  process.stderr.write(`[summary] ${JSON.stringify(summary)}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
