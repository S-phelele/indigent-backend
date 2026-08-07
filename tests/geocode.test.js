const test = require('node:test');
const assert = require('node:assert/strict');

const geocode = require('../src/lib/geocode');

/**
 * Only the pure parts are tested here — the bounding box and rounding. The
 * provider calls hit a live third-party service and belong in the integration
 * run, not a unit suite that must pass offline.
 */

test('accepts coordinates inside South Africa', () => {
  const places = [
    [-26.2041, 28.0473, 'Johannesburg'],
    [-33.9249, 18.4241, 'Cape Town'],
    [-29.8587, 31.0218, 'Durban'],
    [-25.7479, 28.2293, 'Pretoria'],
    [-33.0292, 27.8546, 'East London'],
    [-28.7282, 24.7499, 'Kimberley'],
  ];
  for (const [lat, lon, name] of places) {
    assert.equal(geocode.withinSouthAfrica(lat, lon), true, `${name} should be inside`);
  }
});

test('accepts neighbouring enclaves so border communities are not rejected', () => {
  assert.equal(geocode.withinSouthAfrica(-29.3151, 27.4869), true, 'Maseru, Lesotho');
  assert.equal(geocode.withinSouthAfrica(-26.3054, 31.1367), true, 'Mbabane, Eswatini');
});

test('rejects coordinates clearly elsewhere', () => {
  const elsewhere = [
    [51.5074, -0.1278, 'London'],
    [-1.2921, 36.8219, 'Nairobi'],
    [40.7128, -74.006, 'New York'],
    [-33.8688, 151.2093, 'Sydney'],
    [0, 0, 'Null Island'],
  ];
  for (const [lat, lon, name] of elsewhere) {
    assert.equal(geocode.withinSouthAfrica(lat, lon), false, `${name} should be rejected`);
  }
});

test('rejects a swapped latitude and longitude', () => {
  // Johannesburg reversed lands in the Indian Ocean off Somalia — a common
  // mistake, and one the bounding box should catch.
  assert.equal(geocode.withinSouthAfrica(28.0473, -26.2041), false);
});

test('rejects values that are not finite numbers', () => {
  for (const [lat, lon] of [[null, null], [undefined, undefined], ['abc', 'def'], [NaN, NaN], [Infinity, 20]]) {
    assert.equal(geocode.withinSouthAfrica(lat, lon), false, `${lat},${lon} should be rejected`);
  }
});

test('accepts numeric strings, since query parameters arrive as text', () => {
  assert.equal(geocode.withinSouthAfrica('-26.2041', '28.0473'), true);
});

test('rounds to seven decimal places', () => {
  assert.equal(geocode.round7(-26.20410123456789), -26.2041012);
  assert.equal(geocode.round7('28.0473'), 28.0473);
  assert.equal(typeof geocode.round7('28.0473'), 'number');
});

test('reports which provider is in use, with attribution', () => {
  assert.ok(['nominatim', 'google'].includes(geocode.PROVIDER), geocode.PROVIDER);
  assert.match(geocode.attribution(), /OpenStreetMap|Google/);
});

test('a search too short to be meaningful returns nothing without calling out', async () => {
  // Guards the early return; a three-character query must not reach the network.
  assert.deepEqual(await geocode.search('abc'), []);
  assert.deepEqual(await geocode.search('   '), []);
  assert.deepEqual(await geocode.search(null), []);
});

test('reverse lookup refuses coordinates outside the region without calling out', async () => {
  assert.equal(await geocode.reverse(51.5074, -0.1278), null, 'London must not be looked up');
});
