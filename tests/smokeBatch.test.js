const test = require('node:test');
const assert = require('node:assert/strict');
const sb = require('../src/lib/smokeBatch');

const HEAD = 'id,first,surname,bank,account,type,property\n';

test('a valid list is read, and costed before anything is spent', () => {
  const r = sb.parse(HEAD
    + '8503124800081,Grace,Mthembu,FNB,62000009999,SAVINGS,yes\n'
    + '7905010000082,Sipho,Dlamini,,,,\n'
    + '9111060000083,Naledi,Khumalo,NEDBANK,1234567890,,\n');
  assert.equal(r.problems.length, 0);
  assert.equal(r.rows.length, 3);
  assert.deepEqual(r.total.counts, { id: 3, bank: 2, property: 1 });
  // 3 ID checks at 3 + 2 bank at 6 + 1 deeds at 10
  assert.equal(r.total.credits, 3 * 3 + 2 * 6 + 10);
  assert.equal(r.rows[0].bankName, 'FNB');
  assert.equal(r.rows[0].branch, '250655');
});

test('the ID product price is a parameter', () => {
  const one = '8503124800081,Grace,Mthembu,,,,\n';
  assert.equal(sb.parse(HEAD + one, { idCredits: 1 }).total.credits, 1);
  assert.equal(sb.parse(HEAD + one, { idCredits: 10 }).total.credits, 10);
});

test('a bad ID number is refused up front, with the reason, and nothing is planned for it', () => {
  const r = sb.parse(HEAD + '123,Grace,Mthembu,,,,\n8513994800081,Grace,Mthembu,,,,\n');
  assert.equal(r.rows.length, 0);
  assert.equal(r.problems.length, 2);
  assert.match(r.problems[0].message, /13 digits/);
  assert.match(r.problems[1].message, /date of birth/);
  assert.equal(r.total.credits, 0);
});

test('the same ID number twice is refused: it would be charged twice for one answer', () => {
  const r = sb.parse(HEAD + '8503124800081,Grace,Mthembu,,,,\n8503124800081,Grace,Mthembu,,,,\n');
  assert.equal(r.rows.length, 1);
  assert.match(r.problems[0].message, /already on line 2/);
});

test('a surname is required', () => {
  const r = sb.parse(HEAD + '8503124800081,Grace,,,,,\n');
  assert.equal(r.rows.length, 0);
  assert.match(r.problems[0].message, /surname/);
});

test('a bank check needs the bank and the account together, with a plausible account number', () => {
  assert.match(sb.parse(HEAD + '8503124800081,G,M,FNB,,,\n').problems[0].message, /both/);
  assert.match(sb.parse(HEAD + '8503124800081,G,M,,62000009999,,\n').problems[0].message, /both/);
  assert.match(sb.parse(HEAD + '8503124800081,G,M,FNB,123456,,\n').problems[0].message, /7 to 13/);
  assert.match(sb.parse(HEAD + '8503124800081,G,M,FNB,12345678901234,,\n').problems[0].message, /7 to 13/);
});

test('account numbers keep leading zeros, and spaces and dashes are ignored', () => {
  const r = sb.parse(HEAD + '8503124800081,G,M,FNB,0012 3456-789,,\n');
  assert.equal(r.rows[0].account, '00123456789');
});

test('an unsupported bank (Postbank) is refused unless a branch code is given', () => {
  assert.match(sb.parse(HEAD + '8503124800081,G,M,Postbank,12345678,,\n').problems[0].message, /not a bank VerifyNow supports/);
  const ok = sb.parse('id,first,surname,bank,branch,account\n8503124800081,G,M,Postbank,460005,12345678\n');
  assert.equal(ok.problems.length, 0);
  assert.equal(ok.rows[0].branch, '460005');
});

test('account type is checked', () => {
  assert.match(sb.parse(HEAD + '8503124800081,G,M,FNB,62000009999,GOLD,\n').problems[0].message, /Account type/);
  assert.equal(sb.parse(HEAD + '8503124800081,G,M,FNB,62000009999,savings,\n').rows[0].type, 'SAVINGS');
});

test('property accepts yes / y / true / 1 and nothing else', () => {
  for (const v of ['yes', 'Y', 'TRUE', '1']) assert.equal(sb.parse(`${HEAD}8503124800081,G,M,,,,${v}\n`).total.counts.property, 1, v);
  for (const v of ['no', '', 'maybe', '0']) assert.equal(sb.parse(`${HEAD}8503124800081,G,M,,,,${v}\n`).total.counts.property, 0, v);
});

test('the list is capped, and raising the cap is deliberate', () => {
  const rows = Array.from({ length: 12 }, (_, i) => `85031248${String(i).padStart(5, '0')},G,M,,,,\n`).join('');
  const capped = sb.parse(HEAD + rows);
  assert.ok(capped.problems.some((p) => p.tooMany));
  assert.ok(!sb.parse(HEAD + rows, { maxRows: 12 }).problems.some((p) => p.tooMany));
});

test('comments, blank lines, a byte-order mark, CRLF line endings and quoted commas are all fine', () => {
  const text = '﻿# a note\r\n\r\nid,first,surname,bank,account\r\n8503124800081,"Anna, Maria","van der Merwe",,\r\n';
  const r = sb.parse(text);
  assert.equal(r.problems.length, 0);
  assert.equal(r.rows[0].first, 'Anna, Maria');
  assert.equal(r.rows[0].surname, 'van der Merwe');
});

test('a missing header and an empty file are reported', () => {
  assert.match(sb.parse('8503124800081,G,M\n').problems[0].message, /name the columns/);
  assert.match(sb.parse('').problems[0].message, /empty/);
});

test('an unknown column is flagged as a warning, not an error', () => {
  const r = sb.parse('id,first,surname,favourite\n8503124800081,G,M,red\n');
  assert.equal(r.rows.length, 1);
  assert.equal(r.problems[0].warning, true);
});

test('ID numbers are masked to the last four digits', () => {
  assert.equal(sb.mask('8503124800081'), '•••••••••0081');
  assert.doesNotMatch(sb.mask('8503124800081'), /850312/);
});

test('notes say why without a name, an address or an account number', () => {
  assert.equal(sb.noteFor('id', { found: false }), 'no record');
  assert.equal(sb.noteFor('id', { found: true, deceased: true }), 'recorded as deceased');
  assert.equal(sb.noteFor('id', { found: true, idMismatch: true }), 'ID number not confirmed');
  assert.equal(sb.noteFor('id', { found: true, deceased: false }, { outcome: 'INCONCLUSIVE' }), 'name differs');
  assert.equal(sb.noteFor('id', { found: true, deceased: null }, { outcome: 'PASS' }), 'deceased flag not returned');
  assert.equal(sb.noteFor('bank', { accountFound: true, accountOpen: true, idMatch: false }), 'held by someone else');
  assert.equal(sb.noteFor('property', { properties: [{ description: '12 SECRET STREET' }, { description: 'x' }] }), '2 properties registered');
  assert.doesNotMatch(sb.noteFor('property', { properties: [{ description: '12 SECRET STREET' }] }), /SECRET/);
});

test('the report on disk has masked IDs and no names, addresses or account numbers', () => {
  const csv = sb.reportCsv([
    { row: 1, id: '8503124800081', kind: 'id', outcome: 'PASS', credits: 3, note: '' },
    { row: 1, id: '8503124800081', kind: 'bank', outcome: 'INCONCLUSIVE', credits: 6, note: 'held by someone else' },
  ]);
  assert.match(csv, /^row,id,check,outcome,credits_charged,note\n/);
  assert.match(csv, /•••••••••0081/);
  assert.doesNotMatch(csv, /850312|Grace|Mthembu|62000009999/);
});

test('a note containing a comma is quoted in the report', () => {
  const csv = sb.reportCsv([{ row: 2, id: '8503124800081', kind: 'id', outcome: 'FAIL', credits: 3, note: 'a, b' }]);
  assert.match(csv, /"a, b"/);
});
