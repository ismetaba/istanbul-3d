import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { stubListing, formatTry } from './listings.js';

// ---------------------------------------------------------------------------
// No Cesium ion token: we render with OSM tiles + extruded local GeoJSON only.
// Setting an empty token suppresses the "default token" console warning.
Cesium.Ion.defaultAccessToken = '';

const viewer = new Cesium.Viewer('cesium', {
  // OSM raster tiles. Free, no token, attribution baked in.
  baseLayer: new Cesium.ImageryLayer(
    new Cesium.OpenStreetMapImageryProvider({
      url: 'https://tile.openstreetmap.org/',
      credit: '© OpenStreetMap contributors',
    }),
  ),
  // No global terrain — Beşiktaş is hilly but for v0 the ellipsoid keeps
  // us off the ion dependency. We still get correct extrusion above ground 0.
  terrainProvider: new Cesium.EllipsoidTerrainProvider(),

  // Strip the cluttered default UI. The product is a property browser, not
  // an earth-science viewer.
  baseLayerPicker: false,
  geocoder: false,
  homeButton: false,
  sceneModePicker: false,
  navigationHelpButton: false,
  fullscreenButton: false,
  infoBox: false,
  selectionIndicator: false,
  timeline: false,
  animation: false,
  vrButton: false,
});

// Cesium's default credit container floats over the canvas; clean it up.
viewer.cesiumWidget.creditContainer.style.display = 'none';

// Camera defaults — orbit/pan/zoom are on by default, just make sure
// nothing is locked.
viewer.scene.screenSpaceCameraController.enableTilt = true;
viewer.scene.screenSpaceCameraController.enableLook = false;

// ---------------------------------------------------------------------------
// District data + initial camera fly-to.
const districtsRes = await fetch('/districts.json');
const districts = await districtsRes.json();
const besiktas = districts.besiktas;
const [centerLat, centerLon] = besiktas.center;

viewer.camera.flyTo({
  destination: Cesium.Cartesian3.fromDegrees(centerLon, centerLat - 0.012, 1800),
  orientation: {
    heading: Cesium.Math.toRadians(0),
    pitch: Cesium.Math.toRadians(-35),
    roll: 0,
  },
  duration: 0,
});

// ---------------------------------------------------------------------------
// Load building footprints and extrude.
const SELECTED_COLOR = Cesium.Color.fromCssColorString('#4ea1ff');
const BASE_COLOR = Cesium.Color.fromCssColorString('#c9d3e5').withAlpha(0.95);
const OUTLINE_COLOR = Cesium.Color.fromCssColorString('#1a2030').withAlpha(0.45);

const dataSource = await Cesium.GeoJsonDataSource.load(
  '/besiktas-buildings.geojson',
  {
    clampToGround: false,
    fill: BASE_COLOR,
    stroke: OUTLINE_COLOR,
    strokeWidth: 1,
  },
);
viewer.dataSources.add(dataSource);

// Override per-entity extrusion using the height_m we computed in the pipeline.
// Without this, GeoJsonDataSource renders flat polygons.
const entities = dataSource.entities.values;
for (let i = 0; i < entities.length; i++) {
  const e = entities[i];
  if (!e.polygon || !e.properties) continue;
  const heightM = e.properties.height_m?.getValue() ?? 9;
  e.polygon.extrudedHeight = heightM;
  e.polygon.material = BASE_COLOR;
  e.polygon.outline = false; // outlines are a perf trap at 14k features
}

console.log(`Loaded ${entities.length} buildings.`);

// ---------------------------------------------------------------------------
// Click-to-inspect.
const panelBody = document.getElementById('panel-body');
const panel = document.getElementById('panel');
let selectedEntity = null;

function clearSelection() {
  if (selectedEntity?.polygon) {
    selectedEntity.polygon.material = BASE_COLOR;
  }
  selectedEntity = null;
}

function selectEntity(entity) {
  clearSelection();
  selectedEntity = entity;
  if (entity.polygon) {
    entity.polygon.material = SELECTED_COLOR;
  }
  renderPanel(entity);
}

function readProps(entity) {
  // PropertyBag values are wrapped in ConstantProperty; getValue() unwraps.
  const out = {};
  if (!entity.properties) return out;
  for (const key of entity.properties.propertyNames) {
    const v = entity.properties[key]?.getValue();
    out[key] = v;
  }
  return out;
}

function renderPanel(entity) {
  const p = readProps(entity);
  const listing = stubListing(p);

  const addr = p.addr || {};
  const addrLine = [addr.street, addr.housenumber].filter(Boolean).join(' ');
  const postcode = addr.postcode || '';

  panel.classList.remove('panel--empty');
  panelBody.innerHTML = `
    <h2 style="margin:0;font-size:15px;">
      ${escapeHtml(p.name || p.building || 'Building')}
    </h2>
    <p class="osm-id">${escapeHtml(p.osm_id || '')}</p>

    <div class="listing">
      <p class="listing__price">${escapeHtml(formatTry(listing.totalPriceTry))}</p>
      <p class="listing__meta">
        ${escapeHtml(listing.status)} · ${escapeHtml(listing.type)} ·
        ${listing.sqm} m² ·
        ${escapeHtml(formatTry(listing.pricePerSqm))}/m²
      </p>
      <p class="listing__meta">
        Est. rent: ${escapeHtml(formatTry(listing.monthlyRentTry))}/mo
      </p>
      <p class="listing__stub">Stub listing — replaced in CAPAAA-5.</p>
    </div>

    <dl class="kv">
      <dt>Building</dt><dd>${escapeHtml(p.building || '—')}</dd>
      <dt>Height</dt><dd>${num(p.height_m)} m (${escapeHtml(p.height_source || '—')})</dd>
      <dt>Levels</dt><dd>${p.levels ?? '—'}</dd>
      <dt>Address</dt><dd>${escapeHtml(addrLine || '—')}</dd>
      <dt>Postcode</dt><dd>${escapeHtml(postcode || '—')}</dd>
    </dl>
  `;
}

function num(v) {
  if (v == null) return '—';
  return Number(v).toFixed(0);
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
handler.setInputAction((click) => {
  const picked = viewer.scene.pick(click.position);
  if (Cesium.defined(picked) && picked.id instanceof Cesium.Entity) {
    selectEntity(picked.id);
  } else {
    clearSelection();
    panel.classList.add('panel--empty');
    panelBody.innerHTML = '<p class="panel__hint">No selection.</p>';
  }
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

// ---------------------------------------------------------------------------
// Day / night toggle.
// `enableLighting` shades the globe based on sun position. We pair it with
// a clock that ticks at 1× so the user sees the change. Off → noon-flat.
const toggle = document.getElementById('toggle-night');
let nightMode = false;

function setNight(on) {
  nightMode = on;
  viewer.scene.globe.enableLighting = on;
  if (on) {
    // Push the clock to ~22:00 Istanbul local (UTC+3) so we land at night.
    const d = new Date();
    d.setUTCHours(19, 0, 0, 0);
    viewer.clock.currentTime = Cesium.JulianDate.fromDate(d);
    viewer.clock.shouldAnimate = false;
    toggle.textContent = '☀️ Day';
  } else {
    viewer.clock.shouldAnimate = false;
    toggle.textContent = '🌙 Night';
  }
}
toggle.addEventListener('click', () => setNight(!nightMode));
setNight(false);
