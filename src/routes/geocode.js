const express = require('express');
const { protect } = require('../middleware/auth');
const geocode = require('../lib/geocode');
const { geocodeLimiter } = require('../lib/rateLimit');

const router = express.Router();

/**
 * Address lookup, proxied through the API rather than called from the browser.
 *
 * Three reasons it lives here: a Google key must never reach the client;
 * Nominatim's one-request-per-second policy can only be honoured from a single
 * place; and the cache is worth far more shared than per-browser.
 *
 * Authenticated, because an open geocoding proxy is something other people will
 * find and use.
 */
router.use(...protect, geocodeLimiter);

/** Where the lookup comes from, so the UI can attribute it correctly. */
router.get('/provider', (req, res) => {
  res.json({
    success: true,
    data: { provider: geocode.PROVIDER, attribution: geocode.attribution(), bounds: geocode.SA_BOUNDS },
  });
});

/** Address text → candidates. */
router.get('/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 4) {
      return res.status(400).json({ success: false, message: 'Enter at least four characters of the address' });
    }

    const results = await geocode.search(q);
    res.json({
      success: true,
      data: results,
      attribution: geocode.attribution(),
      message: results.length === 0 ? 'No matching address found. You can still enter it manually.' : undefined,
    });
  } catch (error) {
    console.error('geocode search error:', error.message);
    // A geocoder being down must not stop someone applying — and the applicant
    // must never be told their address does not exist when the truth is that
    // the lookup service refused us.
    res.status(503).json({
      success: false,
      message: error.throttled
        ? 'Address lookup is busy right now. Wait a moment and try again, or type your address manually.'
        : 'The address lookup service is unavailable. You can still type your address manually.',
    });
  }
});

/** Device coordinates → a readable address. */
router.get('/reverse', async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ success: false, message: 'We could not read that location. Please try again.' });
    }
    if (!geocode.withinSouthAfrica(lat, lon)) {
      return res.status(400).json({
        success: false,
        message: 'That location is outside South Africa. The property must be in the municipal area.',
      });
    }

    const result = await geocode.reverse(lat, lon);
    if (!result) {
      // Coordinates are still usable even when no street address is known —
      // informal settlements often have no mapped address at all.
      return res.json({
        success: true,
        data: { formatted: null, latitude: geocode.round7(lat), longitude: geocode.round7(lon) },
        message: 'We found your position but no street address. Please describe the address yourself.',
      });
    }

    res.json({ success: true, data: result, attribution: geocode.attribution() });
  } catch (error) {
    console.error('geocode reverse error:', error.message);
    res.status(503).json({
      success: false,
      message: 'The address lookup service is unavailable. Your position was captured; please type the address.',
    });
  }
});

module.exports = router;
