#!/usr/bin/env node
/**
 * Resolve a place name to a WGS84 bbox + center via OSM Nominatim and append
 * it to data/districts.json.
 *
 * Used by the data-fetch skill when we need to add a new Istanbul neighborhood
 * before running fetch-osm-buildings.mjs.
 *
 * Usage:
 *   node scripts/resolve-bbox.mjs --slug cihangir --query "Cihangir, Beyoğlu, Istanbul, Turkey"
 *
 * Notes:
 *   - Single Nominatim call, polite User-Agent, no parallelism.
 *   - bbox is written in Overpass order: [south, west, north, east].
 *   - Refuses to overwrite an existing slug unless --force is passed.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DISTRICTS_PATH = path.join(ROOT, "data/districts.json");

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const USER_AGENT =
  "istanbul-3d/0.0.0 (paperclip pre-product; founding engineer; contact via project README)";

function parseArgs(argv) {
  const args = { force: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--slug") args.slug = argv[++i];
    else if (a === "--query") args.query = argv[++i];
    else if (a === "--name") args.name = argv[++i];
    else if (a === "--force") args.force = true;
  }
  if (!args.slug || !args.query) {
    throw new Error("usage: resolve-bbox.mjs --slug <slug> --query <text> [--name <display>] [--force]");
  }
  return args;
}

async function loadDistricts() {
  try {
    return JSON.parse(await fs.readFile(DISTRICTS_PATH, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
}

async function fetchNominatim(query) {
  const url = new URL(NOMINATIM_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "1");
  url.searchParams.set("addressdetails", "1");
  process.stderr.write(`[nominatim] GET ${url}\n`);
  const res = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "User-Agent": USER_AGENT,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const arr = await res.json();
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new Error(`no Nominatim result for "${query}"`);
  }
  return arr[0];
}

function toOverpassBbox(nominatimBoundingBox) {
  // Nominatim returns [south, north, west, east] as strings.
  const [s, n, w, e] = nominatimBoundingBox.map(Number);
  if (![s, n, w, e].every(Number.isFinite)) {
    throw new Error(`invalid boundingbox: ${JSON.stringify(nominatimBoundingBox)}`);
  }
  return [s, w, n, e];
}

async function main() {
  const args = parseArgs(process.argv);
  const districts = await loadDistricts();
  if (districts[args.slug] && !args.force) {
    throw new Error(`slug "${args.slug}" already exists; pass --force to overwrite`);
  }

  // Polite single call, no parallelism.
  const hit = await fetchNominatim(args.query);
  const bbox = toOverpassBbox(hit.boundingbox);
  const center = [Number(hit.lat), Number(hit.lon)];
  const entry = {
    name: args.name ?? hit.display_name?.split(",")[0] ?? args.slug,
    city: "Istanbul",
    country: "TR",
    _comment: "Resolved via Nominatim. bbox = [south, west, north, east] (Overpass order).",
    bbox,
    center,
    osmType: hit.osm_type ?? null,
    osmId: hit.osm_id ?? null,
    sourceQuery: args.query,
    resolvedAt: new Date().toISOString(),
  };

  districts[args.slug] = entry;
  await fs.writeFile(DISTRICTS_PATH, JSON.stringify(districts, null, 2) + "\n");
  process.stderr.write(`[done] ${args.slug} → bbox ${JSON.stringify(bbox)}, center ${JSON.stringify(center)}\n`);
  console.log(JSON.stringify(entry, null, 2));
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
