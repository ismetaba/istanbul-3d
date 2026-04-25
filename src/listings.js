// Curated mock listings for the Beşiktaş prototype.
// Loaded once from /mock-listings.json (served from data/ via Vite publicDir),
// indexed by osm_id, and looked up at click time.

let cache = null;

export async function loadListings() {
  if (cache) return cache;
  const res = await fetch('/mock-listings.json');
  if (!res.ok) {
    throw new Error(`Failed to load mock-listings.json: ${res.status}`);
  }
  const json = await res.json();
  const byOsmId = new Map();
  for (const l of json.listings) {
    byOsmId.set(l.osm_id, l);
  }
  cache = {
    currency: json.currency,
    listings: json.listings,
    byOsmId,
  };
  return cache;
}

export function getListing(cache, osmId) {
  return cache.byOsmId.get(osmId) || null;
}

export function formatTry(amount) {
  return new Intl.NumberFormat('tr-TR', {
    style: 'currency',
    currency: 'TRY',
    maximumFractionDigits: 0,
  }).format(amount);
}

const STATUS_LABEL = {
  for_sale: 'For sale',
  for_rent: 'For rent',
  off_market: 'Off-market',
};

export function statusLabel(status) {
  return STATUS_LABEL[status] || status;
}

// Photo URLs are derived from a stable seed token in each listing's `photos`
// array. We use picsum.photos because it is reliable, requires no API key,
// and the seed parameter pins the image so the demo looks the same on
// every reload. Real listing photos replace this in v1.
export function photoUrl(seed, w = 640, h = 420) {
  const safe = encodeURIComponent(seed);
  return `https://picsum.photos/seed/capa-${safe}/${w}/${h}`;
}
