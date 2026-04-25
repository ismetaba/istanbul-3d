// Deterministic stub listings keyed off osm_id.
// Real listings will replace this in CAPAAA-5; for v0 we just want
// believable numbers that don't change between reloads.

const LISTING_TYPES = ['1+1', '2+1', '3+1', '4+1', 'Penthouse', 'Studio'];
const STATUSES = ['For sale', 'For rent', 'Off-market'];

function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pick(list, n) {
  return list[n % list.length];
}

export function stubListing(properties) {
  const id = properties.osm_id || 'unknown';
  const h = hashStr(id);

  const status = pick(STATUSES, h);
  const type = pick(LISTING_TYPES, h >>> 3);

  // Beşiktaş is one of Istanbul's premium districts — base rate ~80k TRY/m².
  const heightM = Number(properties.height_m) || 9;
  const levels = Number(properties.levels) || Math.max(1, Math.round(heightM / 3));
  const sqm = 60 + ((h >>> 5) % 180); // 60–240 m²
  const pricePerSqm = 60_000 + ((h >>> 11) % 80_000); // 60k–140k TRY/m²
  const totalPriceTry = sqm * pricePerSqm;

  const monthlyRentTry = Math.round(totalPriceTry / 360); // ~30y back-of-envelope

  return {
    status,
    type,
    sqm,
    levels,
    pricePerSqm,
    totalPriceTry,
    monthlyRentTry,
  };
}

export function formatTry(amount) {
  return new Intl.NumberFormat('tr-TR', {
    style: 'currency',
    currency: 'TRY',
    maximumFractionDigits: 0,
  }).format(amount);
}
