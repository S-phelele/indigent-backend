const test = require('node:test');
const assert = require('node:assert/strict');

const names = require('../src/lib/names');

/**
 * Names and initials.
 *
 * One `names` field was filled in inconsistently — a first name, all of them,
 * sometimes the whole name including the surname. Somebody with three given
 * names has a right to have all three recorded, and initials on a municipal
 * letter have to be right.
 */

test('each given name contributes an initial', () => {
  assert.equal(names.initials('Nomsa Thandiwe'), 'N.T.');
  assert.equal(names.initials('Nomsa Thandiwe Sibongile'), 'N.T.S.');
});

test('one name gives one initial', () => {
  assert.equal(names.initials('Thabo'), 'T.');
});

test('a hyphenated name gives an initial for each part', () => {
  // That is how it is written on an identity document.
  assert.equal(names.initials('Sipho-Lwazi'), 'S.L.');
  assert.equal(names.initials('Anna-Marie Botha'), 'A.M.B.');
});

test('an apostrophe sits inside one name, not between two', () => {
  assert.equal(names.initials("N'wamitwa"), 'N.');
  assert.equal(names.initials("O'Brien Sipho"), 'O.S.');
});

test('initials are upper-cased regardless of how the name was typed', () => {
  assert.equal(names.initials('thabo mokoena'), 'T.M.');
});

test('extra spaces do not produce empty initials', () => {
  assert.equal(names.initials('  Ayanda   Zola  '), 'A.Z.');
});

test('nothing in gives nothing out, rather than a stray full stop', () => {
  assert.equal(names.initials(''), '');
  assert.equal(names.initials(null), '');
  assert.equal(names.initials(undefined), '');
});

test('a part that starts with no letter contributes no initial', () => {
  // A stray bracket or digit should not become a meaningless "(." on a letter.
  assert.equal(names.initials('Nomsa (Thandiwe)'), 'N.T.');
  assert.equal(names.initials('2 Thabo'), 'T.');
});

test('a name with a non-Latin letter still gets an initial', () => {
  assert.equal(names.initials('Ólafur Þór'), 'Ó.Þ.');
});

// ---------------------------------------------------------------------------
// How a name is presented
// ---------------------------------------------------------------------------

test('a letter is addressed with title, given names and surname', () => {
  assert.equal(
    names.display({ title: 'Ms', fullName: 'Nomsa Thandiwe', surname: 'Mthembu' }),
    'Ms Nomsa Thandiwe Mthembu'
  );
});

test('a missing title or surname does not leave a gap in the address', () => {
  assert.equal(names.display({ fullName: 'Nomsa', surname: 'Mthembu' }), 'Nomsa Mthembu');
  assert.equal(names.display({ fullName: 'Nomsa' }), 'Nomsa');
});

test('a record with no name at all reads as Unnamed, never "undefined"', () => {
  // A councillor capturing in a hurry used to produce letters addressed to
  // "undefined undefined".
  assert.equal(names.display({}), 'Unnamed');
  assert.equal(names.listed({}), 'Unnamed');
});

test('a queue lists surname first with initials, for scanning', () => {
  assert.equal(names.listed({ fullName: 'Nomsa Thandiwe', surname: 'Mthembu' }), 'Mthembu, N.T.');
});

test('the old names field is still honoured until it is dropped', () => {
  // The column is backfilled but not yet removed, so a record written before
  // the migration must not lose its name on screen.
  assert.equal(names.initials(''), '');
  const described = names.describe({ names: 'Nomsa Thandiwe', surname: 'Mthembu' });
  assert.equal(described.initials, 'N.T.');
  assert.equal(described.display, 'Nomsa Thandiwe Mthembu');
});

test('fullName wins over the old field when both are present', () => {
  const described = names.describe({ fullName: 'Nomsa Thandiwe', names: 'Nomsa', surname: 'Mthembu' });
  assert.equal(described.fullName, 'Nomsa Thandiwe');
  assert.equal(described.initials, 'N.T.');
});

test('describe returns one shape so clients do not each re-derive it', () => {
  const described = names.describe({ fullName: 'Ayanda', surname: 'Zulu', title: 'Mr' });
  assert.deepEqual(Object.keys(described).sort(), ['display', 'fullName', 'initials', 'listed', 'surname']);
});
