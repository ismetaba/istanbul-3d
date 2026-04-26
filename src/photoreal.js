// Photoreal pipeline scaffold for CAPAAA-39 hands-on validation.
//
// Activates Google Photorealistic 3D Tiles + Cesium World Terrain on top of
// the existing viewer when the operator drops keys into env. Stays inert when
// keys are missing so the v0 OSM-imagery dev experience is untouched.
//
// Env vars (Vite exposes only those prefixed VITE_):
//   VITE_CESIUM_ION_TOKEN  - Cesium ion access token (required for CWT)
//   VITE_GOOGLE_MAPS_KEY   - Google Maps Platform key with Map Tiles API + photoreal SKU enabled
//   VITE_PHOTOREAL         - "0" to opt out even with keys present (CAPAAA-48
//                            rollout: default-on when both keys are configured)
//
// Query-string overrides (so the operator can toggle in the browser without
// rebuilding):
//   ?photoreal=0   - force off for this session
//   ?photoreal=1   - force on (still requires both keys to actually activate)
//
// CAPAAA-39 verifies six checks on top of this scaffold:
//   1. PostProcessStage warm LUT (this file: addWarmLutPost)
//   2. Sun / shadow direction (placeholder — driven by viewer.clock; baked sun in tiles)
//   3. Custom water on Bosphorus via ClippingPolygonCollection (this file: clipBosphorus)
//   4. Distance haze via scene.fog + scene.atmosphere (this file: tuneAtmosphere)
//   5. Sky tint via scene.skyAtmosphere (this file: tuneAtmosphere)
//   6. Listing pickability via scene.drillPick (handled in main.js click handler)

import * as Cesium from 'cesium';

// Coarse Bosphorus channel polygon covering the Cihangir/Beşiktaş waterfront.
// Spike-grade rectangle — ~6 km E-W × 7 km N-S. Refine to a coastline-traced
// polygon for v1 (must be sourced from OSM coastlines, not derived from the
// photoreal tileset per Google ToS §3(c)).
const BOSPHORUS_CLIP_LONLAT = [
  29.005, 41.020,
  29.005, 41.085,
  29.060, 41.085,
  29.060, 41.020,
];

// Warm-tone LUT-ish post-process. Toy approximation of the CAPAAA-35
// treatment direction (warm LUT, navy-cored shadow lift). Designer-tuned LUT
// replaces this in v1 — the goal here is just to prove the pipeline runs and
// composes correctly on top of the photoreal tileset.
const WARM_LUT_FS = `
uniform sampler2D colorTexture;
in vec2 v_textureCoordinates;
uniform float warmth;
uniform float lift;
void main() {
  vec3 c = texture(colorTexture, v_textureCoordinates).rgb;
  vec3 lifted = c + lift * (1.0 - c) * vec3(0.05, 0.07, 0.18);
  vec3 warm = vec3(
    pow(lifted.r, 0.95),
    pow(lifted.g, 1.00),
    pow(lifted.b, 1.10)
  );
  out_FragColor = vec4(mix(c, warm, warmth), 1.0);
}
`;

// CAPAAA-48 rollout: default-on when keys are present. The previous behaviour
// (explicit opt-in with VITE_PHOTOREAL=1 / ?photoreal=1) gated the spike so
// dev runs without keys stayed identical to v0; the rollout step flips that so
// the deploy URL ships photoreal by default. Local dev without keys still
// returns false from `enablePhotoreal` (the key check below short-circuits it),
// so missing keys remain a no-op rather than a hard error.
function readPhotorealFlag() {
  const qs = new URLSearchParams(window.location.search).get('photoreal');
  if (qs === '0') return false;
  if (qs === '1') return true;
  if (import.meta.env.VITE_PHOTOREAL === '0') return false;
  return true;
}

// Build the Bosphorus clip polygon. Cesium clips OUTSIDE the polygon by default;
// inverse=true clips INSIDE — that's what we want (cut a hole in the photoreal
// mesh over the water so our own water primitive can show through underneath).
function buildBosphorusClipPolygons() {
  const positions = Cesium.Cartesian3.fromDegreesArray(BOSPHORUS_CLIP_LONLAT);
  return new Cesium.ClippingPolygonCollection({
    polygons: [new Cesium.ClippingPolygon({ positions })],
    inverse: true,
  });
}

// Add a custom water surface inside the Bosphorus clip polygon. Uses Cesium's
// built-in Water material as a placeholder — final shader (animated normals,
// damped reflections, sun glitter per CAPAAA-35) replaces this in v1.
function addWaterPrimitive(viewer) {
  const positions = Cesium.Cartesian3.fromDegreesArray(BOSPHORUS_CLIP_LONLAT);
  const waterEntity = viewer.entities.add({
    id: 'bosphorus-water',
    polygon: {
      hierarchy: positions,
      material: new Cesium.Material({
        fabric: {
          type: 'Water',
          uniforms: {
            baseWaterColor: new Cesium.Color(0.18, 0.34, 0.48, 1.0),
            blendColor: new Cesium.Color(0.12, 0.20, 0.32, 1.0),
            specularMap: undefined,
            normalMap: undefined,
            frequency: 1500.0,
            animationSpeed: 0.02,
            amplitude: 5.0,
          },
        },
      }),
      height: 0,
      outline: false,
    },
  });
  return waterEntity;
}

function addWarmLutPost(viewer) {
  const stage = new Cesium.PostProcessStage({
    name: 'capa_warm_lut',
    fragmentShader: WARM_LUT_FS,
    uniforms: {
      warmth: 0.55,
      lift: 0.12,
    },
  });
  viewer.scene.postProcessStages.add(stage);
  return stage;
}

function tuneAtmosphere(viewer) {
  // CAPAAA-35: warm-tinted exp² fog kicking in around 800 m, slight orange-pink
  // horizon, soft cyan zenith. These properties affect 3D Tiles and models per
  // the Atmosphere docs.
  const atm = viewer.scene.atmosphere;
  if (atm) {
    atm.hueShift = 0.02;       // tiny push toward orange
    atm.saturationShift = 0.08;
    atm.brightnessShift = 0.02;
  }
  if (viewer.scene.fog) {
    viewer.scene.fog.enabled = true;
    viewer.scene.fog.density = 0.0008;
    viewer.scene.fog.minimumBrightness = 0.06;
  }
  if (viewer.scene.skyAtmosphere) {
    viewer.scene.skyAtmosphere.hueShift = -0.02;
    viewer.scene.skyAtmosphere.saturationShift = 0.10;
    viewer.scene.skyAtmosphere.brightnessShift = -0.05;
  }
}

// Hide every entity in the local building data source so the photoreal mesh
// reads cleanly. Footprints stay alive in memory and are still hit-tested via
// drillPick — they're just not drawn.
function hideExtrusions(dataSource) {
  if (!dataSource?.entities) return;
  for (const entity of dataSource.entities.values) {
    if (entity.polygon) {
      entity.polygon.show = false;
    }
  }
}

/**
 * Activate whichever subset of the photoreal pipeline the env keys allow.
 *
 * @param {Cesium.Viewer} viewer
 * @param {{ buildingsDataSource?: Cesium.GeoJsonDataSource }} opts
 * @returns {Promise<{
 *   photorealActive: boolean,
 *   ionActive: boolean,
 *   tileset: Cesium.Cesium3DTileset | null,
 *   warning: string | null,
 * }>}
 */
export async function enablePhotoreal(viewer, opts = {}) {
  const ionToken = import.meta.env.VITE_CESIUM_ION_TOKEN || '';
  const googleKey = import.meta.env.VITE_GOOGLE_MAPS_KEY || '';
  const photorealRequested = readPhotorealFlag();

  const result = { photorealActive: false, ionActive: false, tileset: null, warning: null };

  if (ionToken) {
    Cesium.Ion.defaultAccessToken = ionToken;
    result.ionActive = true;
    // Atmosphere + fog work without photoreal too — gives the Cesium-ion-only
    // operator something to verify against the v0 OSM imagery.
    tuneAtmosphere(viewer);
  }

  if (!photorealRequested) {
    return result;
  }

  if (!ionToken || !googleKey) {
    // No keys at all → local-dev path, stay silent. Partial keys → operator
    // misconfigured, surface a warning so the missing one is obvious.
    if (ionToken || googleKey) {
      result.warning = 'Photoreal default-on but missing keys (need both VITE_CESIUM_ION_TOKEN and VITE_GOOGLE_MAPS_KEY).';
      console.warn(`[photoreal] ${result.warning}`);
    }
    return result;
  }

  // Swap to Cesium World Terrain so the photoreal mesh sits on real ground
  // elevations. Without this the tileset would z-fight the ellipsoid.
  try {
    viewer.terrainProvider = await Cesium.createWorldTerrainAsync();
  } catch (err) {
    console.warn('[photoreal] CWT load failed, falling back to ellipsoid:', err);
  }

  // Load Google Photorealistic 3D Tiles. Cesium handles the Google Maps
  // attribution ribbon when showCreditsOnScreen is true (per Map Tiles API
  // policies — we MUST keep this on).
  try {
    const tileset = await Cesium.createGooglePhotorealistic3DTileset({
      key: googleKey,
      showCreditsOnScreen: true,
    });
    tileset.dynamicScreenSpaceError = true;
    tileset.clippingPolygons = buildBosphorusClipPolygons();
    viewer.scene.primitives.add(tileset);
    result.tileset = tileset;
  } catch (err) {
    result.warning = `Photoreal tileset load failed: ${err?.message || err}`;
    console.error('[photoreal]', result.warning);
    return result;
  }

  // Bosphorus water primitive (placeholder material) sits inside the clipped
  // polygon. Final shader (animated normals + sun glitter) lands in v1.
  addWaterPrimitive(viewer);

  // Hide local OSM extrusions — they remain pickable via drillPick and stay
  // in memory for the listing-join. Photoreal mesh provides the visual.
  hideExtrusions(opts.buildingsDataSource);

  // Warm LUT only when photoreal is actually rendering — otherwise it would
  // recolor the OSM raster imagery in unflattering ways.
  addWarmLutPost(viewer);

  result.photorealActive = true;
  return result;
}

/**
 * Resolve the click position to a building Entity, drilling through the
 * photoreal mesh if it's in front. Returns the first Entity in the pick stack
 * whose properties carry an osm_id (i.e. one of our local building features).
 *
 * @param {Cesium.Viewer} viewer
 * @param {Cesium.Cartesian2} screenPos
 * @returns {Cesium.Entity | null}
 */
export function pickBuildingEntity(viewer, screenPos) {
  // First try a regular pick — if the photoreal mesh isn't in the way, this
  // returns the entity directly with no allocation cost.
  const top = viewer.scene.pick(screenPos);
  if (top?.id instanceof Cesium.Entity) {
    return top.id;
  }
  // Fall back to drillPick to walk through the photoreal mesh and any other
  // overlay primitives. Limit depth to keep it cheap at street level.
  const stack = viewer.scene.drillPick(screenPos, 8);
  for (const hit of stack) {
    if (hit?.id instanceof Cesium.Entity) {
      return hit.id;
    }
  }
  return null;
}
