#!/usr/bin/env node
// `vite-plugin-cesium` writes Cesium static assets into `dist/${base}/cesium/`
// when Vite's `base` is set (e.g. `/istanbul-3d/` for GitHub Pages project sites).
// But the deployed `dist/` is mounted AT that base path on the host, so the
// plugin's nesting becomes a duplicate prefix at request time
// (`/istanbul-3d/istanbul-3d/cesium/Cesium.js`, 404).
//
// Fix: lift everything Vite emitted under `dist/<base-segments>/` back up to
// `dist/`. Idempotent — no-op when `base` is `/`.
import fs from 'node:fs';
import path from 'node:path';

const distDir = path.resolve('dist');
const base = process.env.VITE_BASE || '/';
if (base === '/' || base === '') {
  process.exit(0);
}

// Strip leading/trailing slashes; only the first segment matters because
// the plugin always nests under `${base}cesium/`.
const segments = base.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
if (segments.length === 0) process.exit(0);
const topSegment = segments[0];

const nestedRoot = path.join(distDir, ...segments);
if (!fs.existsSync(nestedRoot)) {
  console.log(`[fix-cesium-path] nothing to lift at ${nestedRoot}`);
  process.exit(0);
}

function moveAll(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      moveAll(src, dest);
      fs.rmdirSync(src);
    } else {
      fs.renameSync(src, dest);
    }
  }
}

moveAll(nestedRoot, distDir);
fs.rmdirSync(nestedRoot);

// Clean up any now-empty parent directories above the top segment.
const topPath = path.join(distDir, topSegment);
if (fs.existsSync(topPath)) {
  try {
    fs.rmdirSync(topPath);
  } catch {
    /* not empty — leave it */
  }
}

console.log(`[fix-cesium-path] lifted ${nestedRoot} -> ${distDir}`);
