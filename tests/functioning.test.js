const test = require('node:test');
const assert = require('node:assert/strict');

const functioning = require('../src/lib/functioning');

const answers = (over = {}) => ({
  difficultySeeing: 'NO_DIFFICULTY',
  difficultyHearing: 'NO_DIFFICULTY',
  difficultyWalking: 'NO_DIFFICULTY',
  difficultyRemembering: 'NO_DIFFICULTY',
  difficultySelfCare: 'NO_DIFFICULTY',
  difficultyCommunicating: 'NO_DIFFICULTY',
  ...over,
});

// ---------------------------------------------------------------------------
// The instrument itself
// ---------------------------------------------------------------------------

test('it is the Washington Group Short Set: six domains, four points', () => {
  assert.equal(functioning.DOMAINS.length, 6);
  assert.equal(functioning.SCALE.length, 4);

  const keys = functioning.DOMAINS.map((d) => d.key).sort();
  assert.deepEqual(keys, ['communicating', 'hearing', 'remembering', 'seeing', 'selfCare', 'walking']);
});

test('the scale is ordered by severity', () => {
  const severities = functioning.SCALE.map((s) => s.severity);
  assert.deepEqual(severities, [0, 1, 2, 3]);
});

test('every domain carries the question wording, not just a label', () => {
  for (const domain of functioning.DOMAINS) {
    assert.ok(domain.question.length > 25, `${domain.key} needs the full question`);
    assert.match(domain.question, /difficulty/i, `${domain.key} must ask about difficulty`);
  }
});

test('the seeing and hearing questions keep their assistive-device qualifiers', () => {
  // Part of the instrument: the question is about functioning as somebody
  // actually lives, with whatever help they normally use.
  const seeing = functioning.DOMAINS.find((d) => d.key === 'seeing');
  const hearing = functioning.DOMAINS.find((d) => d.key === 'hearing');
  assert.match(seeing.question, /glasses/i);
  assert.match(hearing.question, /hearing aid/i);
});

// ---------------------------------------------------------------------------
// The disability identifier
// ---------------------------------------------------------------------------

test('no difficulty anywhere is not a disability', () => {
  const f = functioning.assess(answers());
  assert.equal(f.hasDisability, false);
  assert.equal(f.complete, true);
  assert.deepEqual(f.limitingDomains, []);
});

test('"a lot of difficulty" in one domain meets the threshold', () => {
  const f = functioning.assess(answers({ difficultyWalking: 'A_LOT_OF_DIFFICULTY' }));
  assert.equal(f.hasDisability, true);
  assert.deepEqual(f.limitingDomains, ['Walking or climbing steps']);
});

test('"cannot do at all" meets it too', () => {
  const f = functioning.assess(answers({ difficultySeeing: 'CANNOT_DO_AT_ALL' }));
  assert.equal(f.hasDisability, true);
});

test('"some difficulty" alone does NOT meet the threshold', () => {
  // Counting "some" would inflate prevalence far past the comparable national
  // figure and make the number useless beside the census.
  const f = functioning.assess(answers({
    difficultySeeing: 'SOME_DIFFICULTY',
    difficultyHearing: 'SOME_DIFFICULTY',
    difficultyWalking: 'SOME_DIFFICULTY',
  }));
  assert.equal(f.hasDisability, false);
  assert.equal(f.anyDifficultyDomains.length, 3, 'but it is still recorded');
});

test('several limiting domains are all reported', () => {
  const f = functioning.assess(answers({
    difficultyWalking: 'A_LOT_OF_DIFFICULTY',
    difficultySelfCare: 'CANNOT_DO_AT_ALL',
  }));
  assert.equal(f.hasDisability, true);
  assert.equal(f.limitingDomains.length, 2);
  assert.equal(f.highestSeverity, 3);
});

test('unanswered questions are null, never false', () => {
  // "No disability recorded" and "not asked" are different facts, and reporting
  // the second as the first understates prevalence.
  const f = functioning.assess({});
  assert.equal(f.hasDisability, null);
  assert.equal(f.answeredCount, 0);
  assert.equal(f.complete, false);
});

test('a partly answered set still yields an identifier when one domain is limiting', () => {
  // Somebody who abandons the questionnaire after saying they cannot walk has
  // told us enough.
  const f = functioning.assess({ difficultyWalking: 'CANNOT_DO_AT_ALL' });
  assert.equal(f.hasDisability, true);
  assert.equal(f.complete, false);
  assert.equal(f.answeredCount, 1);
});

test('a partly answered set with no difficulty so far is not yet a disability', () => {
  const f = functioning.assess({ difficultySeeing: 'NO_DIFFICULTY' });
  assert.equal(f.hasDisability, false);
  assert.equal(f.complete, false);
});

test('the finding explains itself in a sentence', () => {
  assert.match(functioning.explain(functioning.assess({})), /not answered/i);
  assert.match(functioning.explain(functioning.assess(answers())), /No difficulty/i);
  assert.match(
    functioning.explain(functioning.assess(answers({ difficultySeeing: 'SOME_DIFFICULTY' }))),
    /below the standard disability threshold/i
  );
  const limited = functioning.explain(functioning.assess(answers({ difficultyWalking: 'A_LOT_OF_DIFFICULTY' })));
  assert.match(limited, /Washington Group/);
  assert.match(limited, /walking/i);
});

// ---------------------------------------------------------------------------
// Derived from the ID number
// ---------------------------------------------------------------------------

test('date of birth, age and sex all come from the ID number', () => {
  // 920220 -> 20 February 1992; sequence 4720 is below 5000, so female.
  const d = functioning.fromIdNumber('9202204720082', new Date('2026-08-08T00:00:00Z'));
  assert.equal(d.dateOfBirth.toISOString().slice(0, 10), '1992-02-20');
  assert.equal(d.age, 34);
  assert.equal(d.sex, 'FEMALE');
});

test('a sequence of 5000 or more is male', () => {
  const d = functioning.fromIdNumber('8801015800085', new Date('2026-08-08T00:00:00Z'));
  assert.equal(d.sex, 'MALE');
  assert.equal(d.dateOfBirth.toISOString().slice(0, 10), '1988-01-01');
});

test('age accounts for a birthday that has not happened yet this year', () => {
  const before = functioning.fromIdNumber('9202204720082', new Date('2026-02-19T00:00:00Z'));
  const onTheDay = functioning.fromIdNumber('9202204720082', new Date('2026-02-20T00:00:00Z'));
  assert.equal(before.age, 33, 'the day before their birthday they are still 33');
  assert.equal(onTheDay.age, 34);
});

test('a two-digit year that would be in the future belongs to the last century', () => {
  // 54 in 2026 must be 1954, not 2054.
  const d = functioning.fromIdNumber('5407292765431', new Date('2026-08-08T00:00:00Z'));
  assert.equal(d.dateOfBirth.getUTCFullYear(), 1954);
  assert.equal(d.age, 72);
});

test('an unusable ID number derives nothing rather than guessing', () => {
  // A wrong date of birth on an indigent record is worse than a missing one.
  for (const bad of [null, '', 'not-an-id', '123', '9999999999999']) {
    const d = functioning.fromIdNumber(bad);
    assert.equal(d.dateOfBirth, null, `${bad} should derive nothing`);
    assert.equal(d.age, null);
    assert.equal(d.sex, null);
  }
});

test('age bands cover every age without a gap', () => {
  assert.equal(functioning.ageBand(9), 'Under 18');
  assert.equal(functioning.ageBand(17), 'Under 18');
  assert.equal(functioning.ageBand(18), '18–29');
  assert.equal(functioning.ageBand(29), '18–29');
  assert.equal(functioning.ageBand(30), '30–44');
  assert.equal(functioning.ageBand(59), '45–59');
  assert.equal(functioning.ageBand(60), '60–74');
  assert.equal(functioning.ageBand(75), '75 and over');
  assert.equal(functioning.ageBand(null), null);
});

// ---------------------------------------------------------------------------
// Prevalence, for reporting
// ---------------------------------------------------------------------------

test('prevalence is measured against those who answered, not everybody', () => {
  // A denominator that includes people who were never asked is not a rate.
  const applications = [
    answers({ difficultyWalking: 'A_LOT_OF_DIFFICULTY' }),
    answers(),
    answers(),
    {},
    {},
  ];
  const p = functioning.prevalence(applications);

  assert.equal(p.answered, 3);
  assert.equal(p.notAnswered, 2);
  assert.equal(p.withDisability, 1);
  assert.equal(p.percent, 33);
});

test('prevalence is broken down by domain, most common first', () => {
  const applications = [
    answers({ difficultySeeing: 'A_LOT_OF_DIFFICULTY' }),
    answers({ difficultySeeing: 'CANNOT_DO_AT_ALL' }),
    answers({ difficultyWalking: 'A_LOT_OF_DIFFICULTY' }),
  ];
  const p = functioning.prevalence(applications);

  assert.equal(p.byDomain[0].key, 'seeing');
  assert.equal(p.byDomain[0].count, 2);
  assert.equal(p.byDomain.find((d) => d.key === 'walking').count, 1);
});

test('a domain only counts towards prevalence at or above the threshold', () => {
  const p = functioning.prevalence([answers({ difficultyHearing: 'SOME_DIFFICULTY' })]);
  assert.equal(p.withDisability, 0);
  assert.equal(p.byDomain.find((d) => d.key === 'hearing').count, 0);
});

test('prevalence of nothing reports null rather than a misleading zero per cent', () => {
  const p = functioning.prevalence([{}, {}]);
  assert.equal(p.answered, 0);
  assert.equal(p.percent, null);
});
