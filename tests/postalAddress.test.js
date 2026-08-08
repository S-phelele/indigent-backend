const test = require('node:test');
const assert = require('node:assert/strict');

const postal = require('../src/lib/postalAddress');
const slots = require('../src/lib/documentSlots');
const spreadsheet = require('../src/lib/spreadsheet');

// ---------------------------------------------------------------------------
// Postal address: validation
// ---------------------------------------------------------------------------

test('an empty address is not an error', () => {
  // The postal address is optional. Complaining while somebody is still typing,
  // or has deliberately left it blank, would be wrong.
  assert.deepEqual(postal.problems({}), []);
  assert.deepEqual(postal.problems({ postalLine1: '', postalCity: '' }), []);
});

test('a complete address passes', () => {
  assert.deepEqual(postal.problems({
    postalLine1: '4512 Extension 3',
    postalSuburb: 'Sebokeng',
    postalCity: 'Vanderbijlpark',
    postalCode: '1900',
  }), []);
});

test('a partly filled address names what is missing', () => {
  const found = postal.problems({ postalLine1: '4512 Extension 3' });
  assert.ok(found.some((p) => /suburb/i.test(p)));
  assert.ok(found.some((p) => /town or city/i.test(p)));
  assert.ok(found.some((p) => /postal code/i.test(p)));
});

test('problems are ordered the way the form is read', () => {
  // The first message somebody sees should be about the first field they got
  // wrong, not an arbitrary one.
  const found = postal.problems({ postalCode: '19' });
  assert.match(found[0], /street address/i);
});

test('a postal code must be exactly four digits', () => {
  const tooShort = postal.problems({
    postalLine1: '1 Main', postalSuburb: 'CBD', postalCity: 'Vereeniging', postalCode: '190',
  });
  assert.ok(tooShort.some((p) => /exactly four digits/.test(p)));

  const tooLong = postal.problems({
    postalLine1: '1 Main', postalSuburb: 'CBD', postalCity: 'Vereeniging', postalCode: '19000',
  });
  assert.ok(tooLong.some((p) => /exactly four digits/.test(p)));
});

test('a leading zero is a valid postal code', () => {
  // 0001 is Pretoria. Treating the code as a number would make it 1.
  assert.ok(postal.CODE_PATTERN.test('0001'));
  assert.deepEqual(postal.problems({
    postalLine1: 'Private Bag X1', postalCity: 'Pretoria', postalCode: '0001',
  }), []);
});

test('a PO Box is not asked for a suburb', () => {
  // A box at a post office has no suburb, and demanding one would leave people
  // inventing an answer to get past the form.
  assert.deepEqual(postal.problems({
    postalLine1: 'PO Box 1183', postalCity: 'Vanderbijlpark', postalCode: '1900',
  }), []);
});

test('box formats are recognised in the forms people actually write', () => {
  ['PO Box 12', 'P.O. Box 12', 'p o box 12', 'Private Bag X9', 'PostNet Suite 41'].forEach((line) => {
    assert.equal(postal.isBox(line), true, `${line} should be recognised as a box`);
  });
  assert.equal(postal.isBox('4512 Extension 3'), false);
});

// ---------------------------------------------------------------------------
// Postal address: composition
// ---------------------------------------------------------------------------

test('the parts compose into the Post Office layout', () => {
  const block = postal.compose({
    postalLine1: '4512 Extension 3',
    postalLine2: 'Unit 14',
    postalSuburb: 'Sebokeng',
    postalCity: 'Vanderbijlpark',
    postalCode: '1900',
  });
  // Address lines, then suburb, then town, then the code alone on the last line.
  assert.equal(block, '4512 Extension 3\nUnit 14\nSebokeng\nVanderbijlpark\n1900');
});

test('blank parts are left out rather than leaving empty lines', () => {
  const block = postal.compose({
    postalLine1: 'PO Box 1183',
    postalLine2: '',
    postalCity: 'Vanderbijlpark',
    postalCode: '1900',
  });
  assert.equal(block, 'PO Box 1183\nVanderbijlpark\n1900');
  assert.doesNotMatch(block, /\n\n/);
});

test('nothing at all composes to null, not an empty string', () => {
  // An empty string would print as a blank postal address block on the form,
  // which reads as a question nobody answered rather than one left out.
  assert.equal(postal.compose({}), null);
});

test('the inline form is one line, for a table cell', () => {
  const line = postal.composeInline({
    postalLine1: '4512 Extension 3', postalSuburb: 'Sebokeng', postalCity: 'Vanderbijlpark', postalCode: '1900',
  });
  assert.equal(line, '4512 Extension 3, Sebokeng, Vanderbijlpark, 1900');
  assert.doesNotMatch(line, /\n/);
});

test('whitespace is tidied rather than stored as typed', () => {
  const block = postal.compose({ postalLine1: '  4512   Extension   3  ', postalCity: 'Vereeniging' });
  assert.equal(block, '4512 Extension 3\nVereeniging');
});

// ---------------------------------------------------------------------------
// Postal address: same as residential
// ---------------------------------------------------------------------------

test('same as residential stores no copy of the parts', () => {
  // One answer on file. A copy would drift the first time one was corrected —
  // which is exactly when it matters, because somebody has moved.
  const stored = postal.resolve({
    sameAsResidential: true,
    residentialAddress: '4512 Extension 3, Sebokeng',
    postalLine1: 'should be discarded',
    postalCity: 'also discarded',
  });

  assert.equal(stored.postalSameAsResidential, true);
  assert.equal(stored.postalLine1, null);
  assert.equal(stored.postalCity, null);
  assert.equal(stored.postalSuburb, null);
  assert.equal(stored.postalCode, null);
  // Composed for print, where a blank would look like an unanswered question.
  assert.equal(stored.postalAddress, '4512 Extension 3, Sebokeng');
});

test('turning the checkbox off restores a real address', () => {
  const stored = postal.resolve({
    sameAsResidential: false,
    postalLine1: 'PO Box 1183',
    postalCity: 'Vanderbijlpark',
    postalCode: '1900',
  });
  assert.equal(stored.postalSameAsResidential, false);
  assert.equal(stored.postalLine1, 'PO Box 1183');
  assert.equal(stored.postalAddress, 'PO Box 1183\nVanderbijlpark\n1900');
});

test('clearing a part clears it, rather than being treated as unchanged', () => {
  const stored = postal.resolve({ sameAsResidential: false, postalLine1: 'PO Box 1', postalSuburb: '' });
  assert.equal(stored.postalSuburb, null);
});

test('display falls back sensibly whichever way it was answered', () => {
  assert.equal(
    postal.forDisplay({ postalSameAsResidential: true, residentialAddress: '12 Main Road' }),
    '12 Main Road'
  );
  assert.equal(
    postal.forDisplay({ postalLine1: 'PO Box 9', postalCity: 'Sasolburg', postalCode: '1947' }),
    'PO Box 9\nSasolburg\n1947'
  );
  // An application from before the parts existed still has the single field.
  assert.equal(postal.forDisplay({ postalAddress: 'Old single line' }), 'Old single line');
});

// ---------------------------------------------------------------------------
// Document checklist order
// ---------------------------------------------------------------------------

test('required documents come before optional ones', () => {
  const list = slots.slotsFor({ tenure: 'OWNER' });
  const lastRequired = list.map((s) => s.importance).lastIndexOf('REQUIRED');
  const firstOptional = list.map((s) => s.importance).indexOf('OPTIONAL');
  assert.ok(lastRequired < firstOptional, 'a required slot must never sit below an optional one');
});

test('the blocking documents are the top of the list', () => {
  // What an applicant must supply, in the first four rows: the three hard
  // requirements plus the financial evidence group, any one of which satisfies it.
  const top = slots.slotsFor({ tenure: 'OWNER' }).slice(0, 4).map((s) => s.type);
  assert.deepEqual(top, ['PROOF_OF_OWNERSHIP', 'ID_COPY', 'AFFIDAVIT', 'PROOF_OF_INCOME']);
});

test('the financial evidence group sits together, above the truly optional', () => {
  const list = slots.slotsFor({ tenure: 'OWNER' });
  const grouped = list.map((s, i) => (s.group === 'financial_evidence' ? i : -1)).filter((i) => i >= 0);
  const ungrouped = list
    .map((s, i) => (s.importance === 'OPTIONAL' && !s.group ? i : -1))
    .filter((i) => i >= 0);

  // Contiguous, and all before anything genuinely optional.
  assert.deepEqual(grouped, [grouped[0], grouped[0] + 1, grouped[0] + 2]);
  assert.ok(Math.max(...grouped) < Math.min(...ungrouped));
});

test('a tenure requirement leads the required band', () => {
  assert.equal(slots.slotsFor({ tenure: 'TENANT' })[0].type, 'LEASE_AGREEMENT');
  assert.equal(slots.slotsFor({ tenure: 'OWNER' })[0].type, 'PROOF_OF_OWNERSHIP');
});

test('stored rows are ordered the same way as the checklist', () => {
  // findMany returns rows in whatever order Postgres finds them, so the order has
  // to be reapplied. Shuffled input, checklist output.
  const rows = [
    { type: 'COPY_OF_DEATH_CERT', importance: 'OPTIONAL', requirementGroup: null },
    { type: 'AFFIDAVIT', importance: 'REQUIRED', requirementGroup: null },
    { type: 'BANK_STATEMENTS', importance: 'OPTIONAL', requirementGroup: 'financial_evidence' },
    { type: 'ID_COPY', importance: 'REQUIRED', requirementGroup: null },
  ];
  const ordered = slots.orderRows(rows).map((r) => r.type);

  assert.deepEqual(ordered, ['ID_COPY', 'AFFIDAVIT', 'BANK_STATEMENTS', 'COPY_OF_DEATH_CERT']);
});

test('documents the applicant added themselves sort last, newest first', () => {
  const rows = [
    { type: 'OTHER', importance: 'OPTIONAL', requirementGroup: null, uploadedAt: '2026-01-01' },
    { type: 'ID_COPY', importance: 'REQUIRED', requirementGroup: null },
    { type: 'OTHER', importance: 'OPTIONAL', requirementGroup: null, uploadedAt: '2026-06-01' },
  ];
  const ordered = slots.orderRows(rows);
  assert.equal(ordered[0].type, 'ID_COPY');
  assert.equal(ordered[1].uploadedAt, '2026-06-01');
});

test('ordering does not mutate the array it was given', () => {
  const rows = [
    { type: 'COPY_OF_DEATH_CERT', importance: 'OPTIONAL', requirementGroup: null },
    { type: 'ID_COPY', importance: 'REQUIRED', requirementGroup: null },
  ];
  const before = rows.map((r) => r.type);
  slots.orderRows(rows);
  assert.deepEqual(rows.map((r) => r.type), before);
});

// ---------------------------------------------------------------------------
// The Excel workbook
// ---------------------------------------------------------------------------

const parseable = (xml) => {
  // No XML parser in core, so check the invariants that actually break Excel:
  // a declaration, a single root, and balanced worksheet tags.
  assert.ok(xml.startsWith('<?xml'), 'needs an XML declaration');
  assert.ok(xml.trim().endsWith('</Workbook>'), 'needs a closed root');
  assert.equal((xml.match(/<Worksheet /g) || []).length, (xml.match(/<\/Worksheet>/g) || []).length);
};

test('a workbook is produced with one sheet per table', () => {
  const book = spreadsheet.workbook([
    { name: 'One', columns: [{ key: 'a', label: 'A' }], rows: [{ a: 'x' }] },
    { name: 'Two', columns: [{ key: 'b', label: 'B' }], rows: [] },
  ]);
  parseable(book);
  assert.equal((book.match(/<Worksheet /g) || []).length, 2);
});

test('numbers are written as numbers, not text', () => {
  // A count written as a string cannot be summed, sorted or charted without the
  // recipient retyping the column — which is the whole reason for this format.
  const book = spreadsheet.workbook([{
    name: 'S', columns: [{ key: 'n', label: 'N', kind: 'number' }], rows: [{ n: 42 }],
  }]);
  assert.match(book, /ss:Type="Number">42</);
});

test('a number that is not one falls back to text rather than breaking the file', () => {
  const book = spreadsheet.workbook([{
    name: 'S', columns: [{ key: 'n', label: 'N', kind: 'number' }], rows: [{ n: 'not a number' }],
  }]);
  parseable(book);
  assert.match(book, /ss:Type="String">not a number</);
});

test('blank cells are empty rather than the string "null"', () => {
  const book = spreadsheet.workbook([{
    name: 'S',
    columns: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B', kind: 'number' }],
    rows: [{ a: null, b: undefined }],
  }]);
  assert.doesNotMatch(book, />null</);
  assert.doesNotMatch(book, />undefined</);
});

test('XML special characters in real data are escaped', () => {
  const book = spreadsheet.workbook([{
    name: 'S', columns: [{ key: 'a', label: 'A' }], rows: [{ a: 'Smith & Sons <Pty> "Ltd"' }],
  }]);
  parseable(book);
  assert.match(book, /Smith &amp; Sons &lt;Pty&gt;/);
});

test('control characters are stripped, because Excel calls the file corrupt', () => {
  // A name pasted from a PDF or read by a scanner can easily carry one, and Excel
  // refuses the whole workbook rather than skipping the cell.
  const book = spreadsheet.workbook([{
    name: 'S', columns: [{ key: 'a', label: 'A' }], rows: [{ a: 'Nkosi Dlamini' }],
  }]);
  parseable(book);
  assert.match(book, />NkosiDlamini</);
});

test('a sheet name too long for Excel is trimmed rather than breaking the file', () => {
  // Over 31 characters makes the whole workbook fail to open, naming neither the
  // sheet nor the reason.
  const name = spreadsheet.sheetName('A very long sheet name that certainly exceeds the limit');
  assert.ok(name.length <= 31);
});

test('characters Excel forbids in a sheet name are removed', () => {
  const name = spreadsheet.sheetName('Ward 7 / 8 [draft] : final?');
  assert.doesNotMatch(name, /[\\/?*[\]:]/);
});

test('duplicate sheet names are suffixed, since a clash is fatal', () => {
  const taken = new Set();
  const first = spreadsheet.sheetName('Summary', taken);
  const second = spreadsheet.sheetName('Summary', taken);
  assert.equal(first, 'Summary');
  assert.notEqual(second, 'Summary');
  assert.ok(second.length <= 31);
});

test('the content type is the 2003 XML one, not xlsx', () => {
  // Declaring this as xlsx makes Excel try to unzip a text file.
  assert.match(spreadsheet.CONTENT_TYPE, /vnd\.ms-excel/);
  assert.doesNotMatch(spreadsheet.CONTENT_TYPE, /openxmlformats/);
});

test('a timestamp carries no timezone suffix', () => {
  // Excel reads an ISO string with a Z as text, and the column stops sorting.
  const stamp = spreadsheet.excelDate(new Date('2026-08-08T12:34:56Z'));
  assert.match(stamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000$/);
  assert.doesNotMatch(stamp, /Z$/);
});
