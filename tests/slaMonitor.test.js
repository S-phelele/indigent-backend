const test = require('node:test');
const assert = require('node:assert/strict');

const sla = require('../src/lib/slaMonitor');

/**
 * Escalation boundaries. Getting these wrong either floods administrators with
 * duplicate warnings or silently lets an application sit past its target.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-08-07T12:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * DAY);

// Defaults are read from env at import; pass them explicitly so the test does
// not depend on whatever .env happens to hold.
const opts = { now: NOW, slaDays: 14, atRiskWithin: 3 };

test('an application well inside the target is not escalated', () => {
  assert.equal(sla.levelFor(daysAgo(0), opts), null);
  assert.equal(sla.levelFor(daysAgo(5), opts), null);
  assert.equal(sla.levelFor(daysAgo(10), opts), null, '4 days remaining is still comfortable');
});

test('at risk begins exactly three days out', () => {
  assert.equal(sla.levelFor(daysAgo(10), opts), null, '4 days remaining');
  assert.equal(sla.levelFor(daysAgo(11), opts), sla.LEVEL.AT_RISK, '3 days remaining');
  assert.equal(sla.levelFor(daysAgo(13), opts), sla.LEVEL.AT_RISK, '1 day remaining');
  assert.equal(sla.levelFor(daysAgo(14), opts), sla.LEVEL.AT_RISK, 'the target day itself is not yet a breach');
});

test('breach begins the day after the target', () => {
  assert.equal(sla.levelFor(daysAgo(15), opts), sla.LEVEL.BREACHED);
  assert.equal(sla.levelFor(daysAgo(40), opts), sla.LEVEL.BREACHED);
});

test('an unsubmitted application is never escalated', () => {
  assert.equal(sla.levelFor(null, opts), null);
  assert.equal(sla.levelFor(undefined, opts), null);
});

test('the target is configurable', () => {
  const shortTarget = { now: NOW, slaDays: 5, atRiskWithin: 1 };
  assert.equal(sla.levelFor(daysAgo(3), shortTarget), null);
  assert.equal(sla.levelFor(daysAgo(4), shortTarget), sla.LEVEL.AT_RISK);
  assert.equal(sla.levelFor(daysAgo(6), shortTarget), sla.LEVEL.BREACHED);
});

test('each level is announced only once', () => {
  assert.equal(sla.shouldAnnounce(null, sla.LEVEL.AT_RISK), true, 'first warning');
  assert.equal(sla.shouldAnnounce(sla.LEVEL.AT_RISK, sla.LEVEL.AT_RISK), false, 'already warned');
  assert.equal(sla.shouldAnnounce(sla.LEVEL.BREACHED, sla.LEVEL.BREACHED), false, 'already breached');
});

test('at risk escalates to breached, but never the other way', () => {
  assert.equal(sla.shouldAnnounce(sla.LEVEL.AT_RISK, sla.LEVEL.BREACHED), true, 'escalation is worth saying');
  assert.equal(sla.shouldAnnounce(sla.LEVEL.BREACHED, sla.LEVEL.AT_RISK), false, 'must not de-escalate');
});

test('nothing is announced when there is no level', () => {
  assert.equal(sla.shouldAnnounce(null, null), false);
  assert.equal(sla.shouldAnnounce(sla.LEVEL.AT_RISK, null), false, 'a recovered application is silent');
});

test('an application crossing both thresholds is announced twice, in order', () => {
  // Simulate the sweep running each day against one application.
  let announced = null;
  const events = [];
  for (let age = 9; age <= 16; age++) {
    const level = sla.levelFor(daysAgo(age), { ...opts, now: NOW });
    if (sla.shouldAnnounce(announced, level)) {
      events.push({ age, level });
      announced = level;
    }
  }
  assert.deepEqual(events, [
    { age: 11, level: sla.LEVEL.AT_RISK },
    { age: 15, level: sla.LEVEL.BREACHED },
  ]);
});
