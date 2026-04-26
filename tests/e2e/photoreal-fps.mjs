// CAPAAA-49 — Headless FPS sampler against the deployed photoreal pipeline.
//
// Sibling to deployed-visual-gate.mjs (CAPAAA-50). That gate proves the page
// painted; this one asserts the perf/fidelity envelope picked for
// `tileset.maximumScreenSpaceError`. Run on a 2021-class MacBook Pro with the
// full visual stack (LUT + water + haze) enabled to confirm the chosen SSE
// holds the ≥45 fps acceptance bar from CAPAAA-49.
//
// What it does, per district (besiktas + cihangir):
//   1. Loads the deploy with `?district=<key>`.
//   2. Waits for boot + ~4 s settle so first-frame tile loading is past us.
//   3. Verifies photoreal is actually active (Google attribution present in
//      the overlay). Without that, fps without the full stack tells us
//      nothing about the acceptance bar — the run is skipped (or fails when
//      REQUIRE_PHOTOREAL=1 is set, matching the CAPAAA-50 convention).
//   4. Installs an in-page rAF frame counter, then drives a continuous
//      left-button drag in a 200 px × 100 px ellipse over 8 s. The drag
//      forces sustained camera motion → continuous tile streaming under
//      the warm-LUT post-process + Bosphorus water material + atmosphere.
//   5. Computes sustained fps (frames / elapsed s) over the drag window.
//   6. PASSes if fps ≥ FPS_FLOOR (default 45), FAILs otherwise.
//
// Tile request volume isn't asserted directly — sustained fps under continuous
// camera motion is the clean operational signal. If we ever need finer
// telemetry (Cesium3DTileset.statistics), main.js would need to expose
// `viewer` on `window`; we deliberately don't tap that here so the test
// works against the unmodified production deploy.
//
// Artefacts:
//   - artefacts/e2e/fps-besiktas.png
//   - artefacts/e2e/fps-cihangir.png
//   - exit code: 0 PASS, 1 FAIL
//
// Usage:
//   npm run test:e2e:fps                              # default URL, default floor
//   DEPLOY_URL=https://… npm run test:e2e:fps         # override URL
//   FPS_FLOOR=50 npm run test:e2e:fps                 # tighten floor
//   REQUIRE_PHOTOREAL=1 npm run test:e2e:fps          # fail when photoreal off
//   FPS_DURATION_MS=12000 npm run test:e2e:fps        # longer measurement

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTEFACT_DIR = resolve(HERE, '../../artefacts/e2e');

const DEPLOY_URL = process.env.DEPLOY_URL || 'https://ismetaba.github.io/istanbul-3d/';
const REQUIRE_PHOTOREAL = process.env.REQUIRE_PHOTOREAL === '1';
const FPS_FLOOR = Number(process.env.FPS_FLOOR || 45);
const FPS_DURATION_MS = Number(process.env.FPS_DURATION_MS || 8000);
const FPS_WARMUP_MS = Number(process.env.FPS_WARMUP_MS || 4000);
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS || 90_000);
const DISTRICTS = ['besiktas', 'cihangir'];

let failed = false;
function fail(msg) {
  failed = true;
  process.exitCode = 1;
  console.error(`FAIL: ${msg}`);
}
function pass(msg) {
  console.log(`PASS: ${msg}`);
}

async function waitForBoot(page) {
  await page.waitForFunction(
    () => {
      const el = document.getElementById('boot-overlay');
      return !el || el.classList.contains('boot-overlay--error');
    },
    null,
    { timeout: TIMEOUT_MS },
  );
}

async function isPhotorealActive(page) {
  return page.evaluate(() => {
    const overlay = document.getElementById('attribution-overlay');
    return /Google|Maps Platform/i.test(overlay?.innerText || '');
  });
}

async function canvasCenter(page) {
  return page.evaluate(() => {
    const c = document.querySelector('#cesium canvas');
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return {
      x: r.x + r.width / 2,
      y: r.y + r.height / 2,
      w: r.width,
      h: r.height,
    };
  });
}

// Drive a continuous left-button drag in a closed elliptical path for
// `durationMs`, sampling at `steps` intermediate positions. The drag
// emits Cesium camera motion (default left-drag panning), which forces
// tile streaming under the photoreal pipeline.
async function dragOrbit(page, center, durationMs, steps = 80) {
  await page.mouse.move(center.x, center.y);
  await page.mouse.down({ button: 'left' });
  const stepMs = durationMs / steps;
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const dx = Math.sin(t) * Math.min(200, center.w * 0.18);
    const dy = Math.cos(t) * Math.min(100, center.h * 0.12);
    await page.mouse.move(center.x + dx, center.y + dy);
    await page.waitForTimeout(stepMs);
  }
  await page.mouse.up({ button: 'left' });
}

async function startFpsCounter(page) {
  await page.evaluate(() => {
    window.__capa_fps = { frames: 0, started: performance.now(), stopped: false };
    const tick = () => {
      if (window.__capa_fps.stopped) return;
      window.__capa_fps.frames++;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function readFpsCounter(page) {
  return page.evaluate(() => {
    window.__capa_fps.stopped = true;
    const elapsedMs = performance.now() - window.__capa_fps.started;
    const frames = window.__capa_fps.frames;
    return { frames, elapsedMs, fps: frames / (elapsedMs / 1000) };
  });
}

async function runDistrict(page, district) {
  const url = new URL(DEPLOY_URL);
  url.searchParams.set('district', district);
  console.log(`\n== ${district}: loading ${url}`);
  await page.goto(url.toString(), { waitUntil: 'networkidle', timeout: TIMEOUT_MS });
  await waitForBoot(page);

  const bootErrored = await page.evaluate(
    () => !!document.querySelector('.boot-overlay--error'),
  );
  if (bootErrored) {
    fail(`${district}: boot overlay landed in error state`);
    return;
  }

  // Settle: let CWT + photoreal stream initial tiles before sampling.
  await page.waitForTimeout(FPS_WARMUP_MS);

  const photoreal = await isPhotorealActive(page);
  if (!photoreal) {
    if (REQUIRE_PHOTOREAL) {
      fail(`${district}: REQUIRE_PHOTOREAL=1 but photoreal not active on deploy`);
    } else {
      console.log(
        `SKIP: ${district}: photoreal not active on this deploy — fps result wouldn't reflect the CAPAAA-49 acceptance envelope.`,
      );
    }
    return;
  }

  const center = await canvasCenter(page);
  if (!center) {
    fail(`${district}: no Cesium canvas in DOM`);
    return;
  }

  await startFpsCounter(page);
  await dragOrbit(page, center, FPS_DURATION_MS);
  const sample = await readFpsCounter(page);

  const shot = resolve(ARTEFACT_DIR, `fps-${district}.png`);
  await page.screenshot({ path: shot, fullPage: false });

  const fpsRounded = sample.fps.toFixed(1);
  console.log(
    `${district}: ${sample.frames} frames in ${sample.elapsedMs.toFixed(0)} ms → ${fpsRounded} fps (floor ${FPS_FLOOR})`,
  );
  console.log(`screenshot: ${shot}`);

  if (sample.fps >= FPS_FLOOR) {
    pass(`${district}: sustained ${fpsRounded} fps ≥ ${FPS_FLOOR}`);
  } else {
    fail(
      `${district}: sustained ${fpsRounded} fps < ${FPS_FLOOR} — bump tileset.maximumScreenSpaceError (currently 16; 18–20 is the documented next lever)`,
    );
  }
}

async function main() {
  await mkdir(ARTEFACT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();

  // We don't fail on console errors here (CAPAAA-50 already asserts that).
  // Just log so the operator sees Cesium/tile noise alongside fps numbers.
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => console.log(`pageerror: ${err.message}`));

  try {
    for (const district of DISTRICTS) {
      await runDistrict(page, district);
    }
  } catch (err) {
    fail(`spec threw: ${err.message}`);
    try {
      await page.screenshot({
        path: resolve(ARTEFACT_DIR, 'fps-failure.png'),
        fullPage: false,
      });
    } catch {}
  } finally {
    await context.close();
    await browser.close();
  }

  if (failed) {
    console.error('\nFPS GATE: FAIL');
  } else {
    console.log('\nFPS GATE: PASS');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
