/**
 * Address lookup.
 *
 * Two providers behind one interface:
 *
 *  - **nominatim** (default) — OpenStreetMap's free service. No API key, so the
 *    system works out of the box. Its usage policy caps you at one request per
 *    second and requires an identifying User-Agent, both enforced below.
 *  - **google** — used automatically when GOOGLE_MAPS_API_KEY is set. Better
 *    coverage of South African informal settlements, but needs billing enabled.
 *
 * Switching is a config change, not a code change. Results are cached in memory
 * because applicants search the same townships repeatedly and Nominatim's policy
 * expects callers to cache.
 */

const PROVIDER = process.env.GEOCODE_PROVIDER
  || (process.env.GOOGLE_MAPS_API_KEY ? 'google' : 'nominatim');

/**
 * Nominatim's usage policy requires an identifying User-Agent, and it enforces
 * this: a placeholder contact address of the form `someone@example.*` is
 * answered with 403, while the same string without the `@` is accepted. Verified
 * directly against the service — a fake email is worse than no email.
 *
 * So the default carries no address at all, and operators are told once at
 * startup to set a real one.
 */
const CONTACT = process.env.GEOCODE_CONTACT;
const USER_AGENT = CONTACT
  ? `IndigentRegister/1.0 (${CONTACT})`
  : 'IndigentRegister/1.0 (municipal indigent register)';

if (!CONTACT && (process.env.GEOCODE_PROVIDER || 'nominatim') === 'nominatim') {
  console.warn(
    '[geocode] GEOCODE_CONTACT is not set. Address lookup will work, but '
    + "OpenStreetMap's usage policy asks for a real contact address so they can "
    + 'reach you before blocking. Set it to a monitored municipal mailbox.'
  );
}
const TIMEOUT_MS = parseInt(process.env.GEOCODE_TIMEOUT_MS || '8000', 10);

/**
 * Generous bounding box for South Africa, including Lesotho and Eswatini so a
 * border community is not rejected. Anything outside is certainly not a
 * municipal property and is more likely a mistyped coordinate.
 */
const SA_BOUNDS = { minLat: -35.5, maxLat: -21.5, minLon: 15.5, maxLon: 33.5 };

const CACHE_TTL_MS = parseInt(process.env.GEOCODE_CACHE_TTL_MS || String(24 * 60 * 60 * 1000), 10);
const CACHE_MAX = 500;
const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) { cache.delete(key); return null; }
  // Refresh recency for a crude LRU.
  cache.delete(key);
  cache.set(key, hit);
  return hit.value;
}

function cacheSet(key, value) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
}

/**
 * Nominatim allows one request per second, globally. This serialises outbound
 * calls so a burst of applicants cannot get the municipality blocked.
 */
let lastCall = 0;
let queue = Promise.resolve();
function throttled(fn) {
  // The caller gets the real result — including a real rejection. The queue is
  // advanced by a separate, deliberately-swallowed branch so one failed lookup
  // does not poison every request behind it.
  //
  // An earlier version returned the swallowed branch instead, which turned every
  // outage into an empty result set. The applicant was then told "no matching
  // address found" when the truth was that the geocoder had refused us — the
  // difference between "check your spelling" and "type it in manually".
  const result = queue.then(async () => {
    const wait = Math.max(0, 1100 - (Date.now() - lastCall));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    return fn();
  });
  queue = result.then(() => {}, () => {});
  return result;
}

async function getJson(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) {
      // Nominatim answers 403 — not 429 — when you exceed its usage policy, and
      // the block clears on its own. Label it so the log says "we were throttled"
      // rather than "the address does not exist".
      const err = new Error(
        res.status === 403 || res.status === 429
          ? `geocoder refused the request (${res.status}) — most likely its rate limit`
          : `geocoder returned ${res.status}`
      );
      err.status = res.status;
      err.throttled = res.status === 403 || res.status === 429;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** True when a coordinate pair is a real number inside the southern-African box. */
function withinSouthAfrica(lat, lon) {
  const la = Number(lat);
  const lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return false;
  return la >= SA_BOUNDS.minLat && la <= SA_BOUNDS.maxLat
      && lo >= SA_BOUNDS.minLon && lo <= SA_BOUNDS.maxLon;
}

const round7 = (n) => Number(Number(n).toFixed(7));

// ---------------------------------------------------------------------------
// Nominatim
// ---------------------------------------------------------------------------
async function nominatimSearch(query) {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('countrycodes', 'za');
  url.searchParams.set('limit', '5');

  const rows = await throttled(() => getJson(url.toString(), { 'User-Agent': USER_AGENT }));
  return (rows || []).map((r) => ({
    formatted: r.display_name,
    latitude: round7(r.lat),
    longitude: round7(r.lon),
    suburb: r.address?.suburb || r.address?.neighbourhood || null,
    city: r.address?.city || r.address?.town || r.address?.village || null,
    postcode: r.address?.postcode || null,
  }));
}

async function nominatimReverse(lat, lon) {
  const url = new URL('https://nominatim.openstreetmap.org/reverse');
  url.searchParams.set('lat', String(lat));
  url.searchParams.set('lon', String(lon));
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('addressdetails', '1');

  const r = await throttled(() => getJson(url.toString(), { 'User-Agent': USER_AGENT }));
  if (!r || r.error) return null;
  return {
    formatted: r.display_name,
    latitude: round7(lat),
    longitude: round7(lon),
    suburb: r.address?.suburb || r.address?.neighbourhood || null,
    city: r.address?.city || r.address?.town || r.address?.village || null,
    postcode: r.address?.postcode || null,
  };
}

// ---------------------------------------------------------------------------
// Google
// ---------------------------------------------------------------------------
async function googleSearch(query) {
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('address', query);
  url.searchParams.set('components', 'country:ZA');
  url.searchParams.set('key', process.env.GOOGLE_MAPS_API_KEY);

  const data = await getJson(url.toString());
  if (data.status === 'ZERO_RESULTS') return [];
  if (data.status !== 'OK') throw new Error(`Google geocoder: ${data.status}`);

  const part = (r, type) => r.address_components?.find((c) => c.types.includes(type))?.long_name || null;
  return (data.results || []).slice(0, 5).map((r) => ({
    formatted: r.formatted_address,
    latitude: round7(r.geometry.location.lat),
    longitude: round7(r.geometry.location.lng),
    suburb: part(r, 'sublocality') || part(r, 'neighborhood'),
    city: part(r, 'locality'),
    postcode: part(r, 'postal_code'),
  }));
}

async function googleReverse(lat, lon) {
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('latlng', `${lat},${lon}`);
  url.searchParams.set('key', process.env.GOOGLE_MAPS_API_KEY);

  const data = await getJson(url.toString());
  if (data.status !== 'OK' || !data.results?.length) return null;
  const r = data.results[0];
  const part = (type) => r.address_components?.find((c) => c.types.includes(type))?.long_name || null;
  return {
    formatted: r.formatted_address,
    latitude: round7(lat),
    longitude: round7(lon),
    suburb: part('sublocality') || part('neighborhood'),
    city: part('locality'),
    postcode: part('postal_code'),
  };
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/** Address text → candidate coordinates. Returns [] when nothing matches. */
async function search(query) {
  const q = String(query || '').trim();
  if (q.length < 4) return [];

  const key = `s:${PROVIDER}:${q.toLowerCase()}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const results = PROVIDER === 'google' ? await googleSearch(q) : await nominatimSearch(q);
  const usable = results.filter((r) => withinSouthAfrica(r.latitude, r.longitude));
  cacheSet(key, usable);
  return usable;
}

/** Coordinates → a readable address. Returns null when nothing is found. */
async function reverse(lat, lon) {
  if (!withinSouthAfrica(lat, lon)) return null;

  // Cache on ~11 m precision; a device fix jitters more than that anyway.
  const key = `r:${PROVIDER}:${Number(lat).toFixed(4)},${Number(lon).toFixed(4)}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const result = PROVIDER === 'google' ? await googleReverse(lat, lon) : await nominatimReverse(lat, lon);
  if (result) cacheSet(key, result);
  return result;
}

const attribution = () =>
  PROVIDER === 'google' ? 'Powered by Google' : 'Address data © OpenStreetMap contributors';

module.exports = { search, reverse, withinSouthAfrica, round7, PROVIDER, SA_BOUNDS, attribution };
