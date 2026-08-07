/**
 * A very small in-process cache.
 *
 * Aimed at exactly one problem: the analytics and dashboard endpoints scan the
 * whole application table to compute figures that do not change from second to
 * second. Recomputing that on every page view made the admin portal feel slow
 * for no benefit — nobody needs a median turnaround that is fresh to the
 * millisecond.
 *
 * Deliberately not Redis. A single Node process serves this register; adding a
 * network hop and an operational dependency to save a 200 ms query would be a
 * worse system. If this ever runs multiple instances, swap the Map for a client
 * here and nothing else changes.
 *
 * Anything that writes must call `invalidate` with the affected tag, or a
 * reviewer will approve an application and watch the dashboard disagree with
 * them for the next minute.
 */

const DEFAULT_TTL_MS = parseInt(process.env.CACHE_TTL_MS || '60000', 10);
const ENABLED = process.env.DISABLE_CACHE !== 'true';

const store = new Map();
/** In-flight promises, keyed the same way. */
const pending = new Map();

const stats = { hits: 0, misses: 0, coalesced: 0 };

function get(key) {
  const hit = store.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expires) { store.delete(key); return undefined; }
  return hit.value;
}

function set(key, value, { ttl = DEFAULT_TTL_MS, tags = [] } = {}) {
  store.set(key, { value, expires: Date.now() + ttl, tags });
  return value;
}

/**
 * Run `fn` unless a fresh answer is already cached.
 *
 * Concurrent callers for the same key share one execution. Without that, ten
 * administrators opening the dashboard at nine o'clock run ten identical full
 * table scans — the exact moment the database can least afford it.
 */
async function remember(key, fn, { ttl = DEFAULT_TTL_MS, tags = [] } = {}) {
  if (!ENABLED) return fn();

  const cached = get(key);
  if (cached !== undefined) { stats.hits += 1; return cached; }

  const inFlight = pending.get(key);
  if (inFlight) { stats.coalesced += 1; return inFlight; }

  stats.misses += 1;
  const promise = (async () => {
    try {
      const value = await fn();
      set(key, value, { ttl, tags });
      return value;
    } finally {
      pending.delete(key);
    }
  })();

  pending.set(key, promise);
  return promise;
}

/** Drop everything carrying any of these tags. */
function invalidate(...tags) {
  if (tags.length === 0) { store.clear(); return; }
  const wanted = new Set(tags.flat());
  for (const [key, entry] of store) {
    if (entry.tags.some((t) => wanted.has(t))) store.delete(key);
  }
}

/**
 * Express helper: invalidate after a successful mutating response.
 *
 * Hooks the response rather than the handler, so a request that failed
 * validation does not needlessly throw away a warm cache.
 */
const invalidateOn = (...tags) => (req, res, next) => {
  res.on('finish', () => {
    if (res.statusCode >= 200 && res.statusCode < 400) invalidate(tags);
  });
  next();
};

const TAGS = {
  APPLICATIONS: 'applications',
  USERS: 'users',
  ANALYTICS: 'analytics',
  DOCUMENTS: 'documents',
  STAFF: 'staff',
};

module.exports = {
  remember, get, set, invalidate, invalidateOn, TAGS,
  stats: () => ({ ...stats, size: store.size, enabled: ENABLED }),
};
