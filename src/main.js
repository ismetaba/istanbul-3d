import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import {
  loadListings,
  getListing,
  formatTry,
  statusLabel,
  photoUrl,
} from './listings.js';

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
// Building palette.
//   BASE     — the default extruded building.
//   LISTING  — buildings that have a curated mock listing wired to their osm_id.
//   SELECTED — the currently picked building (overrides either of the above).
const SELECTED_COLOR = Cesium.Color.fromCssColorString('#4ea1ff');
const LISTING_COLOR = Cesium.Color.fromCssColorString('#ffb547').withAlpha(0.97);
const BASE_COLOR = Cesium.Color.fromCssColorString('#c9d3e5').withAlpha(0.95);
const OUTLINE_COLOR = Cesium.Color.fromCssColorString('#1a2030').withAlpha(0.45);

// Load listings + buildings in parallel — both are static fetches.
const [listingsCache, dataSource] = await Promise.all([
  loadListings(),
  Cesium.GeoJsonDataSource.load('/besiktas-buildings.geojson', {
    clampToGround: false,
    fill: BASE_COLOR,
    stroke: OUTLINE_COLOR,
    strokeWidth: 1,
  }),
]);
viewer.dataSources.add(dataSource);

// Track the natural (non-selected) color per entity so click/clear can
// restore the right base — listing buildings should fall back to gold,
// not the default grey.
const baseMaterialByEntityId = new Map();

// Override per-entity extrusion using the height_m we computed in the pipeline.
// Without this, GeoJsonDataSource renders flat polygons.
const entities = dataSource.entities.values;
let listingMatchCount = 0;
for (let i = 0; i < entities.length; i++) {
  const e = entities[i];
  if (!e.polygon || !e.properties) continue;
  const heightM = e.properties.height_m?.getValue() ?? 9;
  e.polygon.extrudedHeight = heightM;

  const osmId = e.properties.osm_id?.getValue();
  const listing = osmId ? getListing(listingsCache, osmId) : null;
  const material = listing ? LISTING_COLOR : BASE_COLOR;

  e.polygon.material = material;
  e.polygon.outline = false; // outlines are a perf trap at 14k features

  baseMaterialByEntityId.set(e.id, material);
  if (listing) listingMatchCount += 1;
}

console.log(
  `Loaded ${entities.length} buildings; wired ${listingMatchCount} mock listings.`,
);

// Surface the count in the panel header so the demo is self-evident.
const panelSub = document.querySelector('.panel__sub');
if (panelSub) {
  const total = listingsCache.listings.length;
  panelSub.textContent =
    listingMatchCount === total
      ? `${total} listings live · click a gold building`
      : `${listingMatchCount} of ${total} listings on map · click a gold building`;
}

// ---------------------------------------------------------------------------
// Click-to-inspect.
const panelBody = document.getElementById('panel-body');
const panel = document.getElementById('panel');
let selectedEntity = null;

function clearSelection() {
  if (selectedEntity?.polygon) {
    const base = baseMaterialByEntityId.get(selectedEntity.id) || BASE_COLOR;
    selectedEntity.polygon.material = base;
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
  const listing = p.osm_id ? getListing(listingsCache, p.osm_id) : null;

  panel.classList.remove('panel--empty');

  if (listing) {
    panelBody.innerHTML = renderListing(listing, p);
  } else {
    panelBody.innerHTML = renderBareBuilding(p);
  }
}

function renderListing(listing, p) {
  const addr = p.addr || {};
  const addrLine = [addr.street, addr.housenumber].filter(Boolean).join(' ');
  const postcode = addr.postcode || '';
  const neighbourhood = addr.neighbourhood || addr.district || '';

  const photos = (listing.photos || []).map(
    (seed, idx) => `
    <a class="photo" href="${photoUrl(seed, 1280, 840)}" target="_blank" rel="noopener">
      <img loading="lazy" src="${photoUrl(seed, 640, 420)}" alt="${escapeHtml(listing.title)} photo ${idx + 1}">
    </a>`,
  ).join('');

  const status = listing.status;
  const statusClass = `pill pill--${status}`;
  const isRent = status === 'for_rent';
  const priceLine = isRent
    ? `${formatTry(listing.priceTry)} <span class="listing__per">/ month</span>`
    : formatTry(listing.priceTry);
  const pricePerSqm = Math.round(listing.priceTry / listing.sqm);

  return `
    <div class="listing-card">
      <div class="listing-card__head">
        <span class="${statusClass}">${escapeHtml(statusLabel(status))}</span>
        <span class="listing-card__listed">Listed ${escapeHtml(formatDate(listing.listedAt))}</span>
      </div>

      <h2 class="listing-card__title">${escapeHtml(listing.title)}</h2>
      <p class="listing-card__addr">
        ${escapeHtml([addrLine, neighbourhood].filter(Boolean).join(' · ') || '—')}
      </p>

      <p class="listing-card__price">${priceLine}</p>
      <p class="listing-card__per-sqm">
        ${escapeHtml(formatTry(pricePerSqm))}/m²${isRent ? ' rent' : ''}
      </p>

      <ul class="listing-card__stats">
        <li><strong>${listing.bedrooms}</strong><span>bed</span></li>
        <li><strong>${listing.bathrooms}</strong><span>bath</span></li>
        <li><strong>${listing.sqm}</strong><span>m²</span></li>
        <li><strong>${escapeHtml(listing.floor)}</strong><span>floor</span></li>
      </ul>

      <div class="photos">${photos}</div>

      <p class="listing-card__desc">${escapeHtml(listing.description)}</p>

      <div class="listing-card__agent">
        <div class="agent-avatar">${escapeHtml(initials(listing.agent.name))}</div>
        <div>
          <p class="agent-name">${escapeHtml(listing.agent.name)}</p>
          <p class="agent-agency">${escapeHtml(listing.agent.agency)}</p>
        </div>
        <button class="contact-btn" type="button" data-listing="${escapeHtml(listing.osm_id)}">
          Contact
        </button>
      </div>

      <p class="osm-id">${escapeHtml(listing.osm_id)} · ${escapeHtml(postcode || '—')}</p>
    </div>
  `;
}

function renderBareBuilding(p) {
  const addr = p.addr || {};
  const addrLine = [addr.street, addr.housenumber].filter(Boolean).join(' ');

  return `
    <div class="bare">
      <h2 class="bare__title">
        ${escapeHtml(p.name || p.building || 'Building')}
      </h2>
      <p class="bare__hint">No listing on this building yet.</p>

      <dl class="kv">
        <dt>OSM id</dt><dd>${escapeHtml(p.osm_id || '—')}</dd>
        <dt>Building</dt><dd>${escapeHtml(p.building || '—')}</dd>
        <dt>Height</dt><dd>${num(p.height_m)} m (${escapeHtml(p.height_source || '—')})</dd>
        <dt>Levels</dt><dd>${p.levels ?? '—'}</dd>
        <dt>Address</dt><dd>${escapeHtml(addrLine || '—')}</dd>
        <dt>Postcode</dt><dd>${escapeHtml(addr.postcode || '—')}</dd>
      </dl>
    </div>
  `;
}

function num(v) {
  if (v == null) return '—';
  return Number(v).toFixed(0);
}

function initials(name) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() || '')
    .join('');
}

function formatDate(isoDate) {
  if (!isoDate) return '—';
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) return isoDate;
  return d.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
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

// Lightweight contact-button feedback. Real lead capture lands later.
panelBody.addEventListener('click', (ev) => {
  const btn = ev.target.closest('.contact-btn');
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = 'Request sent ✓';
});

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
