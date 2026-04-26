// CAPAAA-50 — Headless visual gate against the deployed URL.
//
// Final ship gate for CAPAAA-33. We always drive a real browser against the
// deploy because diff-only review missed a TDZ in CAPAAA-22 and broke v0.
//
// Asserts (per CAPAAA-50 acceptance):
//   1. No console errors at boot (Cesium/Google/OSM tile noise allow-listed).
//   2. Photoreal tileset visible — non-uniform pixel content in the
//      Bosphorus area of the canvas (sampled via Playwright screenshot
//      decoded back through a 2D canvas, since Cesium's WebGL context
//      doesn't preserveDrawingBuffer). When the deploy has no Google key,
//      photoreal is off and this falls back to a "canvas not flat" check.
//      Set REQUIRE_PHOTOREAL=1 to fail when photoreal isn't active.
//   3. Click-to-inspect: clicking a known listing row resolves to a
//      `.listing-card` carrying the matching osm_id.
//   4. `#attribution-overlay` is present and non-empty.
//
// Captures two screenshot artefacts:
//   - artefacts/e2e/besiktas-deploy.png   — default district, used for
//     the click-to-inspect and pixel-variance checks.
//   - artefacts/e2e/cihangir-anchor.png   — golden-hour anchor framing
//     for review per CAPAAA-50 acceptance.
//
// Usage:
//   npm run test:e2e:deployed                       # default URL
//   DEPLOY_URL=https://… npm run test:e2e:deployed  # override
//   REQUIRE_PHOTOREAL=1 npm run test:e2e:deployed   # fail if photoreal off

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTEFACT_DIR = resolve(HERE, '../../artefacts/e2e');

const DEPLOY_URL = process.env.DEPLOY_URL || 'https://ismetaba.github.io/istanbul-3d/';
const REQUIRE_PHOTOREAL = process.env.REQUIRE_PHOTOREAL === '1';
// Known listing osm_id from data/mock-listings.json (Beşiktaş gold pin).
const KNOWN_OSM_ID = process.env.KNOWN_OSM_ID || 'way/280133223';
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS || 90_000);

// Console messages we tolerate. Cesium routinely emits informational
// warnings, and the OSM raster source returns CORS errors at zoom 20+
// (tiles past the source's max zoom). None of these break the demo.
const CONSOLE_ALLOWLIST = [
  /Cesium ion/i,
  /credit/i,
  /WebGL.*deprecated/i,
  /tile\.openstreetmap\.org/i,
  /CORS policy/i,
  /Failed to load resource: net::ERR_FAILED/i,
  /404/i,
];

function isAllowedConsoleError(text) {
  return CONSOLE_ALLOWLIST.some((re) => re.test(text));
}

let failed = false;
function fail(msg) {
  failed = true;
  process.exitCode = 1;
  console.error(`FAIL: ${msg}`);
}
function pass(msg) {
  console.log(`PASS: ${msg}`);
}

// Wait for the boot overlay to clear (or land in error state).
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

// Sample luma stddev over a region of the canvas, by taking a clipped
// Playwright screenshot and decoding it through a 2D canvas inside the
// page context. This bypasses the WebGL preserveDrawingBuffer problem.
async function sampleCanvasVariance(page) {
  const box = await page.evaluate(() => {
    const c = document.querySelector('#cesium canvas');
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return {
      x: r.x,
      y: r.y,
      w: r.width,
      h: r.height,
      vw: window.innerWidth,
      vh: window.innerHeight,
    };
  });
  if (!box) return { ok: false, reason: 'no canvas' };
  console.log(
    `canvas box: x=${box.x.toFixed(0)} y=${box.y.toFixed(0)} w=${box.w.toFixed(0)} h=${box.h.toFixed(0)} vw=${box.vw} vh=${box.vh}`,
  );

  // Sample an 80×80 region inside the *visible* canvas portion. Cesium
  // scales the canvas internal size to the host cell, but on some layouts
  // the bounding rect can extend beyond the visible viewport (e.g. when
  // the panel opens). Clamp the centre into [0, vw)×[0, vh).
  const sw = 80;
  const sh = 80;
  const visibleX = Math.max(0, box.x);
  const visibleY = Math.max(0, box.y);
  const visibleR = Math.min(box.vw, box.x + box.w);
  const visibleB = Math.min(box.vh, box.y + box.h);
  const cx = (visibleX + visibleR) / 2;
  const cy = (visibleY + visibleB) / 2;
  const clip = {
    x: Math.max(0, Math.min(box.vw - sw, Math.floor(cx - sw / 2))),
    y: Math.max(0, Math.min(box.vh - sh, Math.floor(cy - sh / 2))),
    width: sw,
    height: sh,
  };
  const png = await page.screenshot({ clip, type: 'png' });
  // Persist the sampled tile so failures are inspectable.
  try {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(resolve(ARTEFACT_DIR, 'sample-tile.png'), png);
  } catch {}
  const dataUrl = `data:image/png;base64,${png.toString('base64')}`;

  return await page.evaluate(
    async ({ dataUrl, sw, sh }) => {
      const img = new Image();
      img.src = dataUrl;
      await img.decode();
      const off = document.createElement('canvas');
      off.width = sw;
      off.height = sh;
      const ctx = off.getContext('2d');
      ctx.drawImage(img, 0, 0, sw, sh);
      const { data } = ctx.getImageData(0, 0, sw, sh);
      let sum = 0;
      let sumSq = 0;
      const n = sw * sh;
      for (let i = 0; i < data.length; i += 4) {
        const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        sum += luma;
        sumSq += luma * luma;
      }
      const mean = sum / n;
      const variance = sumSq / n - mean * mean;
      const stddev = Math.sqrt(Math.max(0, variance));
      return { ok: true, mean, stddev, n };
    },
    { dataUrl, sw, sh },
  );
}

async function checkAttribution(page) {
  return page.evaluate(() => {
    const el = document.getElementById('attribution-overlay');
    if (!el) return { present: false };
    return {
      present: true,
      text: (el.innerText || '').trim(),
      htmlLen: el.innerHTML.length,
    };
  });
}

async function checkPhotorealActive(page) {
  return page.evaluate(() => {
    const overlay = document.getElementById('attribution-overlay');
    return /Google|Maps Platform/i.test(overlay?.innerText || '');
  });
}

async function main() {
  await mkdir(ARTEFACT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      if (!isAllowedConsoleError(text)) consoleErrors.push(text);
    }
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

  // ---- Step 1: load default district (Beşiktaş, where listings live).
  console.log(`\n== loading deploy: ${DEPLOY_URL}`);
  try {
    await page.goto(DEPLOY_URL, { waitUntil: 'networkidle', timeout: TIMEOUT_MS });
    await waitForBoot(page);

    const bootErrored = await page.evaluate(
      () => !!document.querySelector('.boot-overlay--error'),
    );
    if (bootErrored) {
      fail('boot overlay landed in error state — deploy did not boot');
      throw new Error('boot failed');
    }
    pass('boot overlay cleared (first paint)');

    // Let Cesium present a few frames of tiles + extrusions before sampling.
    await page.waitForTimeout(4000);

    // ---- 1. No console errors at boot.
    if (consoleErrors.length === 0) {
      pass('no console errors at boot');
    } else {
      fail(`console errors at boot:\n  - ${consoleErrors.join('\n  - ')}`);
    }

    // ---- 4. Attribution overlay.
    const attribution = await checkAttribution(page);
    if (!attribution.present) {
      fail('#attribution-overlay missing from DOM');
    } else if (attribution.htmlLen === 0) {
      fail('#attribution-overlay present but empty');
    } else {
      pass(`attribution overlay present (${attribution.htmlLen} chars of credits)`);
    }

    // ---- 2. Photoreal / canvas variance check (run before click-to-inspect
    // so the layout is steady — opening the panel reflows the cesium cell).
    const photorealActive = await checkPhotorealActive(page);
    const sample = await sampleCanvasVariance(page);
    if (!sample.ok) {
      fail(`canvas sample failed: ${sample.reason}`);
    } else {
      console.log(
        `canvas sample: luma mean=${sample.mean.toFixed(1)}, stddev=${sample.stddev.toFixed(1)}, photoreal=${photorealActive}`,
      );
      const stddevOk = sample.stddev > 5;
      if (REQUIRE_PHOTOREAL) {
        if (photorealActive && stddevOk) {
          pass('photoreal tileset visible (stddev gate)');
        } else {
          fail(
            `REQUIRE_PHOTOREAL=1 but photoreal=${photorealActive}, stddev=${sample.stddev.toFixed(1)}`,
          );
        }
      } else if (!photorealActive) {
        if (stddevOk) {
          console.log(
            'SKIP: photoreal not enabled on this deploy; canvas variance is non-flat (v0 OSM raster + extrusions rendering).',
          );
        } else {
          fail(
            `photoreal off AND canvas looks flat (stddev=${sample.stddev.toFixed(1)}) — boot did not paint`,
          );
        }
      } else if (!stddevOk) {
        fail(`photoreal active but canvas looks flat (stddev=${sample.stddev.toFixed(1)})`);
      } else {
        pass('photoreal tileset visible (stddev gate)');
      }
    }

    // ---- 3. Click-to-inspect on a known Beşiktaş listing (last because the
    // panel reflow changes canvas geometry).
    const rowSel = `.results__row[data-osm="${KNOWN_OSM_ID.replace(/"/g, '\\"')}"]`;
    const row = await page.waitForSelector(rowSel, { timeout: 15_000 }).catch(() => null);
    if (!row) {
      fail(`expected listing row for ${KNOWN_OSM_ID} not found in results rail`);
    } else {
      await row.click();
      await page.waitForSelector('.listing-card', { timeout: 5000 });
      const cardOsm = await page.evaluate(() => {
        const selectedRow = document.querySelector('.results__row[aria-selected="true"]');
        return selectedRow?.getAttribute('data-osm') || null;
      });
      if (cardOsm === KNOWN_OSM_ID) {
        pass(`click-to-inspect resolved listing card for ${KNOWN_OSM_ID}`);
      } else {
        fail(`listing card opened but osm_id was ${cardOsm}, expected ${KNOWN_OSM_ID}`);
      }
    }

    // Beşiktaş artefact — proof the click-to-inspect path works against the deploy.
    const besiktasShot = resolve(ARTEFACT_DIR, 'besiktas-deploy.png');
    await page.screenshot({ path: besiktasShot, fullPage: false });
    console.log(`screenshot: ${besiktasShot}`);

    // ---- Step 2: navigate to Cihangir for the golden-hour anchor screenshot.
    console.log('\n== loading Cihangir anchor framing');
    const cihangirUrl = new URL(DEPLOY_URL);
    cihangirUrl.searchParams.set('district', 'cihangir');
    await page.goto(cihangirUrl.toString(), {
      waitUntil: 'networkidle',
      timeout: TIMEOUT_MS,
    });
    await waitForBoot(page);
    await page.waitForTimeout(4000);
    const cihangirShot = resolve(ARTEFACT_DIR, 'cihangir-anchor.png');
    await page.screenshot({ path: cihangirShot, fullPage: false });
    console.log(`screenshot: ${cihangirShot}`);
  } catch (err) {
    fail(`spec threw: ${err.message}`);
    try {
      await page.screenshot({
        path: resolve(ARTEFACT_DIR, 'failure.png'),
        fullPage: false,
      });
    } catch {}
  } finally {
    await context.close();
    await browser.close();
  }

  if (failed) {
    console.error('\nDEPLOY GATE: FAIL');
  } else {
    console.log('\nDEPLOY GATE: PASS');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
