const test = require('node:test');
const assert = require('node:assert/strict');

const slots = require('../src/lib/documentSlots');

/**
 * The rule these tests exist to protect: a household must be able to satisfy the
 * financial-evidence requirement with EITHER a payslip OR a grant letter, and
 * must never be blocked for lacking a bank statement.
 */

/** Build the slot set a new application starts with, as plain rows. */
const seed = () => slots.seedRows('app-1').map((r) => ({ ...r }));
const supply = (docs, type) => docs.map((d) => (d.type === type ? { ...d, status: 'Uploaded' } : d));
const supplyAll = (docs, ...types) => types.reduce((acc, t) => supply(acc, t), docs);

test('bank statements are never required on their own', () => {
  // The rule that matters: nobody is turned away for lacking a bank account.
  // Statements are one of three acceptable routes, not a demand.
  const bank = slots.SLOTS.find((s) => s.type === 'BANK_STATEMENTS');
  assert.ok(bank, 'the slot still exists for anyone who has statements');
  assert.equal(bank.importance, 'OPTIONAL');
  assert.equal(bank.group, slots.GROUPS.FINANCIAL_EVIDENCE);
});

test('all three evidence routes sit in the financial evidence group', () => {
  for (const type of ['PROOF_OF_INCOME', 'PROOF_OF_GRANT', 'BANK_STATEMENTS']) {
    assert.equal(slots.SLOTS.find((s) => s.type === type).group, slots.GROUPS.FINANCIAL_EVIDENCE, type);
  }
});

test('a payslip alone satisfies the financial evidence requirement', () => {
  const docs = supplyAll(seed(), 'ID_COPY', 'AFFIDAVIT', 'PROOF_OF_INCOME');
  assert.equal(slots.outstanding(docs).complete, true);
});

test('a grant letter alone satisfies it too — no bank account needed', () => {
  const docs = supplyAll(seed(), 'ID_COPY', 'AFFIDAVIT', 'PROOF_OF_GRANT');
  const result = slots.outstanding(docs);
  assert.equal(result.complete, true, slots.outstandingMessage(docs) || '');
});

test('bank statements alone satisfy it, for anyone who does have an account', () => {
  const docs = supplyAll(seed(), 'ID_COPY', 'AFFIDAVIT', 'BANK_STATEMENTS');
  assert.equal(slots.outstanding(docs).complete, true, slots.outstandingMessage(docs) || '');
});

test('neither payslip nor grant letter leaves the group outstanding', () => {
  const docs = supplyAll(seed(), 'ID_COPY', 'AFFIDAVIT');
  const result = slots.outstanding(docs);
  assert.equal(result.complete, false);
  assert.equal(result.missingRequired.length, 0, 'the individual required slots are all filled');
  assert.equal(result.missingGroups[0].key, slots.GROUPS.FINANCIAL_EVIDENCE);
});

test('the outstanding message names the choice, not one document', () => {
  const docs = supplyAll(seed(), 'ID_COPY', 'AFFIDAVIT');
  const message = slots.outstandingMessage(docs);
  // Telling somebody "Proof of Income is missing" when a grant letter would do
  // is how the municipality gets an unnecessary phone call.
  assert.match(message, /Proof of Income or Proof of Grant or Bank Statements/i);
});

test('a missing ID is reported alongside the group', () => {
  const docs = supply(seed(), 'AFFIDAVIT');
  const message = slots.outstandingMessage(docs);
  assert.match(message, /ID Copy/);
  assert.match(message, /Proof of Income/i);
});

test('nothing outstanding returns no message', () => {
  const docs = supplyAll(seed(), 'ID_COPY', 'AFFIDAVIT', 'PROOF_OF_GRANT');
  assert.equal(slots.outstandingMessage(docs), null);
});

test('a rejected document counts as outstanding again', () => {
  const docs = supplyAll(seed(), 'ID_COPY', 'AFFIDAVIT', 'PROOF_OF_INCOME')
    .map((d) => (d.type === 'ID_COPY' ? { ...d, status: 'Rejected' } : d));
  assert.equal(slots.outstanding(docs).complete, false);
});

test('progress counts a satisfied group once, not per member', () => {
  // Otherwise supplying a grant letter shows 33% forever, because the two slots
  // beside it will never be filled.
  const docs = supplyAll(seed(), 'ID_COPY', 'AFFIDAVIT', 'PROOF_OF_GRANT');
  const progress = slots.progress(docs);
  assert.equal(progress.total, 3, 'ID + affidavit + one financial-evidence group');
  assert.equal(progress.done, 3);
  assert.equal(progress.percent, 100);
});

test('progress is partial before anything is supplied', () => {
  const progress = slots.progress(seed());
  assert.equal(progress.done, 0);
  assert.equal(progress.total, 3);
  assert.equal(progress.percent, 0);
});

test('supplying both members of a group does not exceed 100%', () => {
  const docs = supplyAll(seed(), 'ID_COPY', 'AFFIDAVIT', 'PROOF_OF_INCOME', 'PROOF_OF_GRANT');
  assert.equal(slots.progress(docs).percent, 100);
});

test('an application with no group slots is not blocked by the group', () => {
  // Applications submitted before the group existed keep their old obligations.
  // Without this guard the backfill would make every historic record incomplete.
  const legacy = [
    { name: 'ID Copy', type: 'ID_COPY', importance: 'REQUIRED', requirementGroup: null, status: 'Uploaded' },
    { name: 'Bank Statements', type: 'BANK_STATEMENTS', importance: 'REQUIRED', requirementGroup: null, status: 'Uploaded' },
    { name: 'Affidavit', type: 'AFFIDAVIT', importance: 'REQUIRED', requirementGroup: null, status: 'Uploaded' },
  ];
  assert.equal(slots.outstanding(legacy).complete, true);
  assert.equal(slots.progress(legacy).percent, 100);
});

test('seedRows produces one row per slot, carrying the group', () => {
  const rows = slots.seedRows('app-42');
  assert.equal(rows.length, slots.SLOTS.length);
  assert.ok(rows.every((r) => r.applicationId === 'app-42'));
  assert.ok(rows.every((r) => r.status === 'Pending'));

  const grouped = rows.filter((r) => r.requirementGroup === slots.GROUPS.FINANCIAL_EVIDENCE);
  assert.equal(grouped.length, 3, 'payslip, grant letter, bank statements');
});

test('proof of income is offered before bank statements', () => {
  // Ordering is the request: lead with what a household can actually produce.
  const order = slots.SLOTS.map((s) => s.type);
  assert.ok(
    order.indexOf('PROOF_OF_INCOME') < order.indexOf('BANK_STATEMENTS'),
    `slot order was ${order.join(', ')}`
  );
  assert.ok(order.indexOf('PROOF_OF_GRANT') < order.indexOf('BANK_STATEMENTS'));
});

test('every slot has guidance text', () => {
  for (const slot of slots.SLOTS) {
    assert.ok(slot.hint && slot.hint.length > 10, `${slot.type} needs a hint`);
  }
});
