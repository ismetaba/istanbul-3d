import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import '@fontsource-variable/inter';
import {
  loadListings,
  getListing,
  formatTry,
  statusLabel,
  photoUrl,
} from './listings.js';

// ---------------------------------------------------------------------------
// No Cesium ion token — render with OSM tiles + extruded local GeoJSON only.
Cesium.Ion.defaultAccessToken = '';

const viewer = new Cesium.Viewer('cesium', {
  baseLayer: new Cesium.ImageryLayer(
    new Cesium.OpenStreetMapImageryProvider({
      url: 'https://tile.openstreetmap.org/',
      credit: '© OpenStreetMap contributors',
    }),
  ),
  terrainProvider: new Cesium.EllipsoidTerrainProvider(),
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
viewer.cesiumWidget.creditContainer.style.display = 'none';
viewer.scene.screenSpaceCameraController.enableTilt = true;
viewer.scene.screenSpaceCameraController.enableLook = false;

// ---------------------------------------------------------------------------
// Tokens (kept in JS so Cesium materials can use exact CSS colors).
const TOKENS = {
  bldgBase: '#c9d3e5',
  accent: '#4ea1ff',
  good: '#4cd17a',
  warn: '#f3b14a',
  muted: '#8a93a7',
};

const SELECTED_COLOR = Cesium.Color.fromCssColorString(TOKENS.accent);
const BASE_COLOR = Cesium.Color.fromCssColorString(TOKENS.bldgBase).withAlpha(0.95);
const OUTLINE_COLOR = Cesium.Color.fromCssColorString('#1a2030').withAlpha(0.45);

const STATUS_COLOR = {
  for_sale: TOKENS.good,
  for_rent: TOKENS.warn,
  off_market: TOKENS.muted,
};

// 5% tint of status color over the base building color.
function tintForStatus(status) {
  const base = Cesium.Color.fromCssColorString(TOKENS.bldgBase);
  const overlay = Cesium.Color.fromCssColorString(STATUS_COLOR[status] || TOKENS.muted);
  const lerped = Cesium.Color.lerp(base, overlay, 0.05, new Cesium.Color());
  lerped.alpha = 0.95;
  return lerped;
}

// ---------------------------------------------------------------------------
// Districts + initial fly-to.
const districtsRes = await fetch(`${import.meta.env.BASE_URL}districts.json`);
const districts = await districtsRes.json();

// District selection via ?district=<key>. Falls back to besiktas if missing
// or unknown. Listings only ship for besiktas in v0 (CAPAAA-13 scope).
const requestedDistrictKey = new URLSearchParams(window.location.search).get('district');
const districtKey = requestedDistrictKey && districts[requestedDistrictKey]
  ? requestedDistrictKey
  : 'besiktas';
const district = districts[districtKey];
const hasListings = districtKey === 'besiktas';
const [centerLat, centerLon] = district.center;

// Reflect the active district in the topbar + tab title.
const districtTrigger = document.getElementById('district-trigger');
if (districtTrigger) {
  districtTrigger.innerHTML = `${district.name} <span aria-hidden="true" class="topbar__caret">▾</span>`;
}
document.title = `Istanbul · ${district.name} — Capa`;

// Districts without listings hide the filter sidebar + results list.
// The selection panel (also inside #results) still works for bare buildings.
if (!hasListings) {
  const filtersEl = document.getElementById('filters');
  if (filtersEl) filtersEl.hidden = true;
  const resultsListEl = document.getElementById('results-list');
  if (resultsListEl) resultsListEl.hidden = true;
}

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
// Data load: listings + buildings in parallel. Listings are only loaded for
// districts that actually have mock data; others get an empty cache so the
// click-to-inspect path still works (renderBareBuilding).
const listingsPromise = hasListings
  ? loadListings()
  : Promise.resolve({ currency: 'TRY', listings: [], byOsmId: new Map() });

const [listingsCache, dataSource] = await Promise.all([
  listingsPromise,
  Cesium.GeoJsonDataSource.load(`${import.meta.env.BASE_URL}${districtKey}-buildings.geojson`, {
    clampToGround: false,
    fill: BASE_COLOR,
    stroke: OUTLINE_COLOR,
    strokeWidth: 1,
  }),
]);
viewer.dataSources.add(dataSource);

// Per-entity natural color (so click/clear restores the right base).
const baseMaterialByEntityId = new Map();
// osm_id -> { entity, centroid: {lon, lat, heightM} }
const indexByOsmId = new Map();

const entities = dataSource.entities.values;
for (let i = 0; i < entities.length; i++) {
  const e = entities[i];
  if (!e.polygon || !e.properties) continue;
  const heightM = e.properties.height_m?.getValue() ?? 9;
  e.polygon.extrudedHeight = heightM;

  const osmId = e.properties.osm_id?.getValue();
  const listing = osmId ? getListing(listingsCache, osmId) : null;

  let material;
  if (listing) {
    material = tintForStatus(listing.status);
  } else {
    material = BASE_COLOR;
  }
  e.polygon.material = material;
  e.polygon.outline = false;
  baseMaterialByEntityId.set(e.id, material);

  if (listing) {
    const centroid = polygonCentroid(e);
    if (centroid) {
      indexByOsmId.set(osmId, { entity: e, centroid: { ...centroid, heightM } });
    }
  }
}

console.log(
  `Loaded ${entities.length} buildings; ${listingsCache.listings.length} listings on map.`,
);

// Compute lon/lat centroid of an entity's polygon hierarchy positions.
function polygonCentroid(entity) {
  const hierarchy = entity.polygon?.hierarchy?.getValue();
  const positions = hierarchy?.positions;
  if (!positions || !positions.length) return null;
  let sx = 0,
    sy = 0,
    sz = 0;
  for (const p of positions) {
    sx += p.x;
    sy += p.y;
    sz += p.z;
  }
  const c = new Cesium.Cartesian3(sx / positions.length, sy / positions.length, sz / positions.length);
  const carto = Cesium.Cartographic.fromCartesian(c);
  return {
    lon: Cesium.Math.toDegrees(carto.longitude),
    lat: Cesium.Math.toDegrees(carto.latitude),
  };
}

// ---------------------------------------------------------------------------
// Pin layer (billboards) — separate data source so we get clustering.
const pinSource = new Cesium.CustomDataSource('listings-pins');
viewer.dataSources.add(pinSource);

const pinImageCache = new Map();
function pinImage(status, alpha = 1) {
  const key = `${status}|${alpha.toFixed(2)}`;
  if (pinImageCache.has(key)) return pinImageCache.get(key);
  const c = document.createElement('canvas');
  c.width = 28;
  c.height = 28;
  const ctx = c.getContext('2d');
  ctx.globalAlpha = alpha;
  // shadow halo
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.arc(14, 15, 10, 0, Math.PI * 2);
  ctx.fill();
  // outer ring
  ctx.fillStyle = '#0b0f17';
  ctx.beginPath();
  ctx.arc(14, 14, 9, 0, Math.PI * 2);
  ctx.fill();
  // status fill
  ctx.fillStyle = STATUS_COLOR[status] || TOKENS.muted;
  ctx.beginPath();
  ctx.arc(14, 14, 6, 0, Math.PI * 2);
  ctx.fill();
  const url = c.toDataURL();
  pinImageCache.set(key, url);
  return url;
}

const clusterImageCache = new Map();
function clusterImage(count) {
  if (clusterImageCache.has(count)) return clusterImageCache.get(count);
  const c = document.createElement('canvas');
  c.width = 36;
  c.height = 36;
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.arc(18, 19, 14, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = TOKENS.accent;
  ctx.beginPath();
  ctx.arc(18, 18, 13, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#0b0f17';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = '#07101e';
  ctx.font = 'bold 13px Inter Variable, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(count), 18, 18);
  const url = c.toDataURL();
  clusterImageCache.set(count, url);
  return url;
}

// pinEntities[osmId] -> Cesium.Entity
const pinEntityByOsmId = new Map();

for (const listing of listingsCache.listings) {
  const idx = indexByOsmId.get(listing.osm_id);
  if (!idx) continue;
  const { centroid } = idx;
  // Place at building's roof altitude. Ellipsoid terrain provider means
  // height is measured from WGS84, same frame as the extruded polygon top.
  const position = Cesium.Cartesian3.fromDegrees(
    centroid.lon,
    centroid.lat,
    centroid.heightM + 4,
  );
  const pin = pinSource.entities.add({
    id: `pin-${listing.osm_id}`,
    position,
    billboard: {
      image: pinImage(listing.status, 1),
      width: 22,
      height: 22,
      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      heightReference: Cesium.HeightReference.NONE,
      disableDepthTestDistance: Number.POSITIVE_INFINITY, // pins always on top
    },
    properties: { osm_id: listing.osm_id, status: listing.status },
  });
  pinEntityByOsmId.set(listing.osm_id, pin);
}

// Clustering on the pin source.
pinSource.clustering.enabled = true;
pinSource.clustering.pixelRange = 80;
pinSource.clustering.minimumClusterSize = 6;
pinSource.clustering.clusterEvent.addEventListener((entities, cluster) => {
  cluster.label.show = false;
  cluster.billboard.show = true;
  cluster.billboard.id = cluster.label.id;
  cluster.billboard.image = clusterImage(entities.length);
  cluster.billboard.width = 32;
  cluster.billboard.height = 32;
  cluster.billboard.verticalOrigin = Cesium.VerticalOrigin.CENTER;
  cluster.billboard.disableDepthTestDistance = Number.POSITIVE_INFINITY;
});

// ---------------------------------------------------------------------------
// Filter state.
const TYPE_CHIPS = ['Studio', '1+1', '2+1', '3+1', '4+1', 'Penthouse'];

const filterState = {
  status: new Set(['for_sale', 'for_rent', 'off_market']),
  types: new Set(),
  priceMin: 5_000_000,
  priceMax: 100_000_000,
  sizeMin: 60,
  sizeMax: 300,
  addr: '',
};

const PRICE_BOUNDS = { min: 5_000_000, max: 100_000_000 };
const SIZE_BOUNDS = { min: 60, max: 300 };

function listingTypes(listing) {
  // bedrooms is the X+1 layout count; 0 → Studio.
  // Penthouse is a marker layer, applied on top.
  const types = new Set();
  if (listing.bedrooms === 0) types.add('Studio');
  else types.add(`${listing.bedrooms}+1`);
  if (/penthouse/i.test(listing.title)) types.add('Penthouse');
  return types;
}

function passesFilter(listing) {
  if (!filterState.status.has(listing.status)) return false;

  if (filterState.types.size > 0) {
    const t = listingTypes(listing);
    let any = false;
    for (const sel of filterState.types) if (t.has(sel)) { any = true; break; }
    if (!any) return false;
  }

  // Price: skip rentals (their priceTry is monthly, different unit).
  // Sale/off-market listings filter on priceMin..priceMax.
  if (listing.status !== 'for_rent') {
    if (listing.priceTry < filterState.priceMin || listing.priceTry > filterState.priceMax)
      return false;
  }

  if (listing.sqm < filterState.sizeMin || listing.sqm > filterState.sizeMax) return false;

  if (filterState.addr) {
    const q = filterState.addr.toLowerCase().trim();
    const idx = indexByOsmId.get(listing.osm_id);
    const street = (idx?.entity?.properties?.addr?.getValue()?.street || '').toLowerCase();
    const id = listing.osm_id.toLowerCase();
    const matches = street.includes(q) || id === q;
    if (!matches) return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Filter UI wiring.

// Status checkboxes
document.querySelectorAll('input[name="status"]').forEach((cb) => {
  cb.addEventListener('change', () => {
    if (cb.checked) filterState.status.add(cb.value);
    else filterState.status.delete(cb.value);
    onFiltersChanged();
  });
});

// Type chips
const chipsHost = document.getElementById('type-chips');
for (const t of TYPE_CHIPS) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'chip';
  btn.textContent = t;
  btn.setAttribute('aria-pressed', 'false');
  btn.dataset.type = t;
  btn.addEventListener('click', () => {
    if (filterState.types.has(t)) {
      filterState.types.delete(t);
      btn.setAttribute('aria-pressed', 'false');
    } else {
      filterState.types.add(t);
      btn.setAttribute('aria-pressed', 'true');
    }
    onFiltersChanged();
  });
  chipsHost.appendChild(btn);
}

// Dual-range price + size
function bindDualRange({ minId, maxId, fillId, readoutId, format, onChange }) {
  const minEl = document.getElementById(minId);
  const maxEl = document.getElementById(maxId);
  const fill = document.getElementById(fillId);
  const readout = document.getElementById(readoutId);
  const lo = Number(minEl.min);
  const hi = Number(minEl.max);

  function sync() {
    let a = Number(minEl.value);
    let b = Number(maxEl.value);
    if (a > b - Number(minEl.step)) {
      // Clamp the one that just moved past the other.
      if (document.activeElement === minEl) {
        a = Math.max(lo, b - Number(minEl.step));
        minEl.value = String(a);
      } else {
        b = Math.min(hi, a + Number(maxEl.step));
        maxEl.value = String(b);
      }
    }
    const left = ((a - lo) / (hi - lo)) * 100;
    const right = 100 - ((b - lo) / (hi - lo)) * 100;
    fill.style.left = `${left}%`;
    fill.style.right = `${right}%`;
    readout.textContent = `${format(a)} · ${format(b)}`;
    onChange(a, b);
  }
  minEl.addEventListener('input', sync);
  maxEl.addEventListener('input', sync);
  sync();
}

function fmtTryShort(n) {
  if (n >= 1_000_000) return `₺${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `₺${Math.round(n / 1000)}k`;
  return `₺${n}`;
}

// DOM refs that onFiltersChanged() / renderResultsList() touch must be
// declared *before* bindDualRange() runs — its init sync() fires onChange
// once, which reaches into these refs. Keeping them above the bindings
// avoids a TDZ on `const` lookup during boot.
const resultsBar = document.getElementById('results-bar');
const resultsBarCount = document.getElementById('results-bar-count');
const resultsListEl = document.getElementById('results-list');
document.getElementById('results-reset').addEventListener('click', resetFilters);

bindDualRange({
  minId: 'price-min',
  maxId: 'price-max',
  fillId: 'price-fill',
  readoutId: 'price-readout',
  format: fmtTryShort,
  onChange: (a, b) => {
    filterState.priceMin = a;
    filterState.priceMax = b;
    onFiltersChanged();
  },
});

bindDualRange({
  minId: 'size-min',
  maxId: 'size-max',
  fillId: 'size-fill',
  readoutId: 'size-readout',
  format: (n) => `${n} m²`,
  onChange: (a, b) => {
    filterState.sizeMin = a;
    filterState.sizeMax = b;
    onFiltersChanged();
  },
});

// Address input
const addrInput = document.getElementById('addr-input');
addrInput.addEventListener('input', () => {
  filterState.addr = addrInput.value;
  onFiltersChanged();
});

function resetFilters() {
  filterState.status = new Set(['for_sale', 'for_rent', 'off_market']);
  filterState.types.clear();
  filterState.priceMin = PRICE_BOUNDS.min;
  filterState.priceMax = PRICE_BOUNDS.max;
  filterState.sizeMin = SIZE_BOUNDS.min;
  filterState.sizeMax = SIZE_BOUNDS.max;
  filterState.addr = '';
  document.querySelectorAll('input[name="status"]').forEach((cb) => (cb.checked = true));
  document.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', 'false'));
  addrInput.value = '';
  document.getElementById('price-min').value = String(PRICE_BOUNDS.min);
  document.getElementById('price-max').value = String(PRICE_BOUNDS.max);
  document.getElementById('size-min').value = String(SIZE_BOUNDS.min);
  document.getElementById('size-max').value = String(SIZE_BOUNDS.max);
  document.getElementById('price-min').dispatchEvent(new Event('input'));
  document.getElementById('size-min').dispatchEvent(new Event('input'));
  onFiltersChanged();
}

// ---------------------------------------------------------------------------
// Filter side-effects: results list, pin alpha, building tint.
// (resultsListEl / resultsBar / resultsBarCount are hoisted above bindDualRange
// to avoid a TDZ during init — see the note up there.)

function onFiltersChanged() {
  // No listings on this district → nothing to filter / list.
  if (!hasListings) return;

  const sorted = listingsCache.listings
    .slice()
    .sort((a, b) => b.priceTry - a.priceTry);
  const passing = sorted.filter(passesFilter);
  const passingIds = new Set(passing.map((l) => l.osm_id));

  // Results list
  renderResultsList(passing);

  // Results bar copy (always visible — count is honest)
  const total = listingsCache.listings.length;
  resultsBar.hidden = false;
  resultsBarCount.textContent = `Showing ${passing.length} of ${total}`;

  // Pin alpha 0.2 for filtered-out
  for (const [osmId, pin] of pinEntityByOsmId) {
    const status = pin.properties.status.getValue();
    const inSet = passingIds.has(osmId);
    pin.billboard.image = pinImage(status, inSet ? 1 : 0.2);
  }
}

function renderResultsList(passing) {
  if (!passing.length) {
    resultsListEl.innerHTML = `<li class="results__empty">No listings match these filters.</li>`;
    return;
  }
  const html = passing
    .map((l) => {
      const isRent = l.status === 'for_rent';
      const priceTxt = isRent ? `${fmtTryShort(l.priceTry)}/mo` : fmtTryShort(l.priceTry);
      const types = listingTypes(l);
      const layout = types.has('Studio') ? 'Studio' : `${l.bedrooms}+1`;
      const flag = l.status === 'off_market'
        ? '<span class="results__row-flag">OFF</span>'
        : '';
      return `
        <li class="results__row" data-osm="${escapeHtml(l.osm_id)}" tabindex="0">
          <span class="results__row-pin results__row-pin--${l.status}"></span>
          <span class="results__row-text">
            <span class="results__row-title">${escapeHtml(l.title)}</span>
            <span class="results__row-meta">${escapeHtml(layout)} · ${l.sqm} m² ${flag}</span>
          </span>
          <span class="results__row-price">${escapeHtml(priceTxt)}</span>
        </li>`;
    })
    .join('');
  resultsListEl.innerHTML = html;
}

// Row click + hover.
resultsListEl.addEventListener('click', (ev) => {
  const row = ev.target.closest('.results__row');
  if (!row) return;
  const osm = row.dataset.osm;
  const idx = indexByOsmId.get(osm);
  if (idx) selectEntity(idx.entity);
});

resultsListEl.addEventListener('mouseover', (ev) => {
  const row = ev.target.closest('.results__row');
  if (!row) return;
  pulsePin(row.dataset.osm);
});

// ---------------------------------------------------------------------------
// Pin pulse animation. Scales billboard 1.0 → 1.2 → 1.0 over 1s.
const pulses = new Map();
function pulsePin(osmId) {
  const pin = pinEntityByOsmId.get(osmId);
  if (!pin || !pin.billboard) return;
  if (pulses.has(osmId)) return; // already pulsing
  const start = performance.now();
  const baseW = 22;
  const baseH = 22;
  function frame(now) {
    const t = (now - start) / 1000;
    if (t >= 1) {
      pin.billboard.width = baseW;
      pin.billboard.height = baseH;
      pulses.delete(osmId);
      return;
    }
    // Ease in/out 1 -> 1.2 -> 1
    const k = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const triangle = t < 0.5 ? k : 1 - k;
    const scale = 1 + 0.2 * triangle;
    pin.billboard.width = baseW * scale;
    pin.billboard.height = baseH * scale;
    requestAnimationFrame(frame);
  }
  pulses.set(osmId, true);
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// Selection + panel.

const panel = document.getElementById('panel');
const panelBody = document.getElementById('panel-body');
const panelClose = document.getElementById('panel-close');

let selectedEntity = null;

function clearSelection() {
  if (selectedEntity?.polygon) {
    const base = baseMaterialByEntityId.get(selectedEntity.id) || BASE_COLOR;
    selectedEntity.polygon.material = base;
  }
  // Clear row aria-selected
  resultsListEl
    .querySelectorAll('.results__row[aria-selected="true"]')
    .forEach((r) => r.removeAttribute('aria-selected'));
  selectedEntity = null;
}

function selectEntity(entity) {
  clearSelection();
  selectedEntity = entity;
  if (entity.polygon) entity.polygon.material = SELECTED_COLOR;
  const osm = entity.properties?.osm_id?.getValue();
  if (osm) {
    const row = resultsListEl.querySelector(`.results__row[data-osm="${cssEscape(osm)}"]`);
    if (row) {
      row.setAttribute('aria-selected', 'true');
      row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }
  openPanel(entity);
}

function openPanel(entity) {
  panel.hidden = false;
  panel.classList.remove('panel--hidden');
  renderPanel(entity);
}

function closePanel() {
  panel.hidden = true;
  panel.classList.add('panel--hidden');
  clearSelection();
}

panelClose.addEventListener('click', closePanel);
window.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !panel.hidden) closePanel();
});

// ---------------------------------------------------------------------------
// Panel content.

function readProps(entity) {
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
  if (listing) {
    panelBody.innerHTML = renderListing(listing, p);
  } else {
    panelBody.innerHTML = renderBareBuilding(p);
  }
}

function renderListing(listing, p) {
  const addr = p.addr || {};
  const addrLine = [addr.street, addr.housenumber].filter(Boolean).join(' ');
  const types = listingTypes(listing);
  const layout = types.has('Studio') ? 'Studio' : `${listing.bedrooms}+1`;
  const isRent = listing.status === 'for_rent';
  const priceMain = isRent
    ? `${formatTry(listing.priceTry)} <span class="price__per">/ month</span>`
    : formatTry(listing.priceTry);
  const pricePerSqm = Math.round(listing.priceTry / listing.sqm);

  // Estimated rent (if sale): rough 0.4% of sale price / month, just for the v0 stub.
  const estRent = !isRent ? Math.round(listing.priceTry * 0.004) : null;

  const photos = (listing.photos || [])
    .map(
      (seed, idx) => `
    <a class="photo" href="${photoUrl(seed, 1280, 840)}" target="_blank" rel="noopener">
      <img loading="lazy" src="${photoUrl(seed, 640, 420)}" alt="${escapeHtml(listing.title)} photo ${idx + 1}">
    </a>`,
    )
    .join('');

  const heightSrc = p.height_source === 'tag:height' ? '(tag:height)' : '(estimate)';

  return `
    <div class="listing-card">
      <span class="pill pill--${listing.status}">${escapeHtml(statusLabel(listing.status))}</span>

      <h2 class="listing__title">${escapeHtml(listing.title)}</h2>
      <p class="listing__osmid">${escapeHtml(listing.osm_id)}</p>

      <div class="price">
        <span class="price__primary">${priceMain}</span>
      </div>
      <p class="price__sub">
        <span><strong>${formatTry(pricePerSqm)}</strong>/m²${isRent ? ' rent' : ''}</span>
        ${estRent ? `<span>est. rent <strong>${formatTry(estRent)}</strong>/mo</span>` : ''}
      </p>

      <p class="typeline"><strong>${escapeHtml(layout)}</strong> · <strong>${listing.sqm} m²</strong> · floor ${escapeHtml(listing.floor)}</p>

      <section class="section">
        <h3 class="section__label">Building</h3>
        <dl class="kv">
          <dt>Height</dt><dd>${num(p.height_m)} m <span class="provenance">${escapeHtml(heightSrc)}</span></dd>
          <dt>Levels</dt><dd>${p.levels ?? '—'}</dd>
          <dt>Building</dt><dd>${escapeHtml(p.building || '—')}</dd>
          <dt>Address</dt><dd>${escapeHtml(addrLine || '—')}</dd>
          <dt>Postcode</dt><dd>${escapeHtml(addr.postcode || '—')}</dd>
        </dl>
      </section>

      <section class="section">
        <h3 class="section__label">Comparables in 200 m</h3>
        <div class="comps">
          <p class="comps__copy"><strong>12 listings</strong> <span>· median ₺78k/m²</span></p>
          <button type="button" class="comps__open" disabled title="Coming in v1">open ▸</button>
        </div>
      </section>

      <details class="photos-disclosure">
        <summary>Photos (${(listing.photos || []).length})</summary>
        <div class="photos">${photos}</div>
        <p class="listing__desc">${escapeHtml(listing.description)}</p>
      </details>

      <section class="section">
        <h3 class="section__label">Listing source</h3>
        <div class="source">
          <div>
            <p class="source__agency">${escapeHtml(listing.agent.agency)}</p>
            <p class="source__broker">${escapeHtml(listing.agent.name)}</p>
          </div>
          <button class="btn contact-btn" type="button" data-listing="${escapeHtml(listing.osm_id)}">
            Contact ▸
          </button>
        </div>
      </section>

      <div class="actions">
        <button class="btn" type="button" id="action-center">↗ Center camera</button>
        <button class="btn btn--primary" type="button" id="action-save">⤓ Save to list</button>
      </div>
    </div>
  `;
}

function renderBareBuilding(p) {
  const addr = p.addr || {};
  const addrLine = [addr.street, addr.housenumber].filter(Boolean).join(' ');
  return `
    <div class="bare">
      <h2 class="bare__title">${escapeHtml(p.name || p.building || 'Building')}</h2>
      <p class="bare__hint">No listing on this building yet.</p>
      <dl class="kv">
        <dt>OSM id</dt><dd>${escapeHtml(p.osm_id || '—')}</dd>
        <dt>Building</dt><dd>${escapeHtml(p.building || '—')}</dd>
        <dt>Height</dt><dd>${num(p.height_m)} m <span class="provenance">${escapeHtml(p.height_source === 'tag:height' ? '(tag:height)' : '(estimate)')}</span></dd>
        <dt>Levels</dt><dd>${p.levels ?? '—'}</dd>
        <dt>Address</dt><dd>${escapeHtml(addrLine || '—')}</dd>
        <dt>Postcode</dt><dd>${escapeHtml(addr.postcode || '—')}</dd>
      </dl>
    </div>
  `;
}

// Panel button delegation
panelBody.addEventListener('click', (ev) => {
  const contact = ev.target.closest('.contact-btn');
  if (contact) {
    contact.disabled = true;
    contact.textContent = 'Request sent ✓';
    return;
  }
  if (ev.target.id === 'action-center') {
    if (selectedEntity) flyToEntity(selectedEntity);
    return;
  }
  if (ev.target.id === 'action-save') {
    const btn = ev.target;
    btn.disabled = true;
    btn.textContent = 'Saved ✓';
    return;
  }
});

function flyToEntity(entity) {
  const osm = entity.properties?.osm_id?.getValue();
  const idx = osm ? indexByOsmId.get(osm) : null;
  if (!idx) {
    // Fallback: use Cesium's tracker for non-listing entities.
    viewer.flyTo(entity, { duration: 1 });
    return;
  }
  const { centroid } = idx;
  const dest = Cesium.Cartesian3.fromDegrees(
    centroid.lon,
    centroid.lat - 0.0015,
    Math.max(centroid.heightM + 250, 350),
  );
  viewer.camera.flyTo({
    destination: dest,
    orientation: {
      heading: Cesium.Math.toRadians(0),
      pitch: Cesium.Math.toRadians(-30),
      roll: 0,
    },
    duration: 1,
  });
}

// ---------------------------------------------------------------------------
// Click handling on the map. No auto-fly on selection.
const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
handler.setInputAction((click) => {
  const picked = viewer.scene.pick(click.position);
  if (Cesium.defined(picked)) {
    // Pin click → resolve to underlying building entity.
    if (picked.id instanceof Cesium.Entity) {
      const e = picked.id;
      const osm = e.properties?.osm_id?.getValue();
      const idx = osm ? indexByOsmId.get(osm) : null;
      if (idx) {
        selectEntity(idx.entity);
      } else {
        selectEntity(e);
      }
      return;
    }
  }
  // Click empty terrain → close.
  if (!panel.hidden) closePanel();
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

// ---------------------------------------------------------------------------
// Top-bar search.
const searchInput = document.getElementById('search-input');
document.getElementById('topbar-search').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const q = searchInput.value.trim();
  if (!q) return;

  // Exact osm_id match wins.
  const idx = indexByOsmId.get(q);
  if (idx) {
    selectEntity(idx.entity);
    return;
  }

  // Substring on addr.street across all building entities (limited to listings).
  const ql = q.toLowerCase();
  const matches = [];
  for (const [osmId, info] of indexByOsmId) {
    const street = (info.entity.properties?.addr?.getValue()?.street || '').toLowerCase();
    if (street.includes(ql)) matches.push({ osmId, info });
  }

  if (matches.length === 1) {
    selectEntity(matches[0].info.entity);
    return;
  }
  if (matches.length > 1) {
    const first = matches[0].osmId;
    const row = resultsListEl.querySelector(`.results__row[data-osm="${cssEscape(first)}"]`);
    if (row) row.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
});

// ---------------------------------------------------------------------------
// Day / night toggle (relocated to top bar).
const toggle = document.getElementById('toggle-night');
let nightMode = false;
function setNight(on) {
  nightMode = on;
  viewer.scene.globe.enableLighting = on;
  if (on) {
    const d = new Date();
    d.setUTCHours(19, 0, 0, 0);
    viewer.clock.currentTime = Cesium.JulianDate.fromDate(d);
    viewer.clock.shouldAnimate = false;
    toggle.textContent = '☀️ Day';
    toggle.setAttribute('aria-pressed', 'true');
  } else {
    viewer.clock.shouldAnimate = false;
    toggle.textContent = '🌙 Night';
    toggle.setAttribute('aria-pressed', 'false');
  }
}
toggle.addEventListener('click', () => setNight(!nightMode));
setNight(false);

// ---------------------------------------------------------------------------
// Helpers.

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

function cssEscape(s) {
  if (window.CSS && CSS.escape) return CSS.escape(s);
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// First paint.
onFiltersChanged();
