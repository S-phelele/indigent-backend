const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const notify = require('../src/lib/notify');

/**
 * The notification type list lives in two places: the Prisma enum (which the
 * database enforces) and the TYPE map (which callers use). They must agree.
 *
 * This exists because they once did not: APPLICATION_AT_RISK was added to the
 * schema but not to TYPE, so `notify.TYPE.APPLICATION_AT_RISK` was undefined,
 * every SLA send passed `type: undefined`, and the guard swallowed it. Nothing
 * threw and nothing was delivered.
 */

function schemaEnumValues(name) {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'prisma', 'schema.prisma'), 'utf8');
  const block = new RegExp(`enum\\s+${name}\\s*\\{([^}]*)\\}`).exec(schema);
  assert.ok(block, `enum ${name} not found in schema.prisma`);
  return block[1]
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .filter((line) => line && /^[A-Z_]+$/.test(line));
}

test('every TYPE key maps to its own name', () => {
  // A typo like `WELCOME: 'WELCOM'` would otherwise pass silently.
  for (const [key, value] of Object.entries(notify.TYPE)) {
    assert.equal(value, key, `TYPE.${key} should equal "${key}"`);
  }
});

test('every notification type in TYPE exists in the database enum', () => {
  const schemaValues = schemaEnumValues('NotificationType');
  const missing = Object.keys(notify.TYPE).filter((t) => !schemaValues.includes(t));
  assert.deepEqual(missing, [], `these would fail at insert time: ${missing.join(', ')}`);
});

test('every database enum value is exposed through TYPE', () => {
  const schemaValues = schemaEnumValues('NotificationType');
  const missing = schemaValues.filter((v) => !notify.TYPE[v]);
  assert.deepEqual(missing, [],
    `callers referencing notify.TYPE.${missing[0] || 'X'} would get undefined and send nothing`);
});

test('the SLA escalation types are wired up', () => {
  // The specific pair that broke.
  assert.equal(notify.TYPE.APPLICATION_AT_RISK, 'APPLICATION_AT_RISK');
  assert.equal(notify.TYPE.APPLICATION_BREACHED, 'APPLICATION_BREACHED');
});

test('the SLA monitor only emits types that exist', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'slaMonitor.js'), 'utf8');
  const referenced = [...source.matchAll(/notify\.TYPE\.([A-Z_]+)/g)].map((m) => m[1]);
  assert.ok(referenced.length > 0, 'expected the monitor to reference notification types');
  for (const t of referenced) {
    assert.ok(notify.TYPE[t], `slaMonitor references notify.TYPE.${t}, which is undefined`);
  }
});

test('routes only emit notification types that exist', () => {
  const dir = path.join(__dirname, '..', 'src', 'routes');
  for (const file of fs.readdirSync(dir)) {
    const source = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const [, t] of source.matchAll(/notify\.TYPE\.([A-Z_]+)/g)) {
      assert.ok(notify.TYPE[t], `${file} references notify.TYPE.${t}, which is undefined`);
    }
  }
});
