#!/usr/bin/env node
/**
 * Tiny query helper over the district GeoJSON store. Smoke-tests that the
 * pipeline output is queryable for the things the renderer will actually need:
 *   - look up a building by OSM id
 *   - find the nearest building to a (lon, lat) point (mock-listing snapping)
 *   - filter by height range
 *
 * Usage:
 *   node scripts/query-buildings.mjs --district besiktas summary
 *   node scripts/query-buildings.mjs --district besiktas by-id way/12345
 *   node scripts/query-buildings.mjs --district besiktas nearest 29.0093 41.0428
 *   node scripts/query-buildings.mjs --district besiktas tallest 5
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const args = { district: "besiktas", _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--district") args.district = argv[++i];
    else args._.push(a);
  }
  return args;
}

function polygonCentroid(coords) {
  // coords: [[lon, lat], ...] (closed ring). Approximate planar centroid — fine
  // at city scale, where we only use it for nearest-neighbor ranking.
  let sx = 0, sy = 0, n = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    sx += coords[i][0];
    sy += coords[i][1];
    n++;
  }
  return [sx / n, sy / n];
}

function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function loadFC(district) {
  const p = path.join(ROOT, "data", `${district}-buildings.geojson`);
  return JSON.parse(await fs.readFile(p, "utf8"));
}

function describe(f) {
  return {
    osm_id: f.properties.osm_id,
    name: f.properties.name,
    building: f.properties.building,
    height_m: f.properties.height_m,
    height_source: f.properties.height_source,
    levels: f.properties.levels,
    addr: f.properties.addr,
    centroid: polygonCentroid(f.geometry.coordinates[0]),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const cmd = args._[0] ?? "summary";
  const fc = await loadFC(args.district);

  if (cmd === "summary") {
    console.log(JSON.stringify(fc.metadata, null, 2));
    return;
  }
  if (cmd === "by-id") {
    const id = args._[1];
    const f = fc.features.find((x) => x.properties.osm_id === id);
    if (!f) {
      console.error(`not found: ${id}`);
      process.exit(2);
    }
    console.log(JSON.stringify(describe(f), null, 2));
    return;
  }
  if (cmd === "nearest") {
    const lon = Number(args._[1]);
    const lat = Number(args._[2]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      console.error("usage: nearest <lon> <lat>");
      process.exit(2);
    }
    let best = null;
    let bestD = Infinity;
    for (const f of fc.features) {
      const c = polygonCentroid(f.geometry.coordinates[0]);
      const d = haversineMeters([lon, lat], c);
      if (d < bestD) {
        bestD = d;
        best = f;
      }
    }
    console.log(JSON.stringify({ distance_m: +bestD.toFixed(2), ...describe(best) }, null, 2));
    return;
  }
  if (cmd === "tallest") {
    const k = Number(args._[1] ?? 10);
    const sorted = [...fc.features].sort((a, b) => b.properties.height_m - a.properties.height_m).slice(0, k);
    console.log(JSON.stringify(sorted.map(describe), null, 2));
    return;
  }
  console.error(`unknown command: ${cmd}`);
  process.exit(2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
