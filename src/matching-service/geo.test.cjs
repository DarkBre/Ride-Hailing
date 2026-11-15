const assert = require('node:assert/strict');
const test = require('node:test');
const { haversineKm, rankCandidates } = require('./dist/geo.js');

const origin = { latitude: 0, longitude: 0 };

test('Haversine handles zero, long distance, antipodes and the antimeridian in km', () => {
  assert.equal(haversineKm(origin, origin), 0);
  assert.ok(Math.abs(haversineKm(origin, { latitude: 0, longitude: 90 }) - 6371 * Math.PI / 2) < 1e-8);
  assert.ok(Math.abs(haversineKm(origin, { latitude: 0, longitude: 180 }) - 6371 * Math.PI) < 1e-8);
  assert.ok(haversineKm({ latitude: 0, longitude: 179.99 }, { latitude: 0, longitude: -179.99 }) < 3);
  assert.ok(haversineKm({ latitude: 90, longitude: -180 }, { latitude: 90, longitude: 180 }) < 1e-8);
});

test('Haversine rejects missing, nonnumeric and out-of-range coordinates', () => {
  for (const invalid of [null, {}, { latitude: 91, longitude: 0 }, { latitude: 0, longitude: -181 },
    { latitude: NaN, longitude: 0 }, { latitude: '0', longitude: 0 }]) {
    assert.throws(() => haversineKm(origin, invalid), RangeError);
  }
});

test('ranking filters stale, offline, busy, invalid and out-of-radius drivers', () => {
  const candidate = { ...origin, status: 'AVAILABLE', locationUpdatedAtMs: 1000 };
  const drivers = [
    { ...candidate, id: 'far', longitude: 1 },
    { ...candidate, id: 'near', longitude: 0.01 },
    { ...candidate, id: 'stale', locationUpdatedAtMs: 999 },
    { ...candidate, id: 'offline', status: 'OFFLINE' },
    { ...candidate, id: 'busy', status: 'BUSY' },
    { ...candidate, id: 'invalid', latitude: 91 },
    { ...candidate, id: 'tie-b' },
    { ...candidate, id: 'tie-a' },
  ];
  assert.deepEqual(rankCandidates(origin, drivers, 5, 1000).map(driver => driver.id), ['tie-a', 'tie-b', 'near']);
  assert.deepEqual(rankCandidates(origin, drivers.slice(0, 1), 5, 1000), []);
  const boundary = haversineKm(origin, drivers[1]);
  assert.deepEqual(rankCandidates(origin, drivers.slice(1, 2), boundary, 1000).map(driver => driver.id), ['near']);
});
