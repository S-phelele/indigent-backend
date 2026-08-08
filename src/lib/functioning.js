const saId = require('./saIdNumber');

/**
 * Functioning and disability — the Washington Group Short Set.
 *
 * Six questions, each answered on the same four-point scale. This is not a
 * form we invented: it is the international standard instrument, and it is what
 * Statistics South Africa uses in the Census and the General Household Survey.
 *
 * Using it verbatim matters for two reasons. A municipality's disability
 * figures become directly comparable with national and provincial statistics,
 * which is what makes them usable in a council report or a grant application.
 * And the wording has been tested across languages and literacy levels in a way
 * anything we wrote ourselves would not have been.
 *
 * ## Why it asks about difficulty rather than disability
 *
 * "Are you disabled?" is answered inconsistently — many people with substantial
 * functional limitations do not describe themselves that way, and the question
 * carries stigma that suppresses honest answers. Asking whether somebody has
 * difficulty walking gets a truthful answer from the same person.
 *
 * ## The cut-off
 *
 * The Washington Group's standard identifier: a person is counted as having a
 * disability if they report **a lot of difficulty** or **cannot do at all** on
 * at least one domain. "Some difficulty" is recorded but does not meet it —
 * counting it would inflate prevalence far beyond the comparable figure and
 * make the number useless next to the census.
 */

/** The four-point scale, in order of severity. Do not reorder. */
const SCALE = [
  { value: 'NO_DIFFICULTY', label: 'No difficulty', severity: 0 },
  { value: 'SOME_DIFFICULTY', label: 'Some difficulty', severity: 1 },
  { value: 'A_LOT_OF_DIFFICULTY', label: 'A lot of difficulty', severity: 2 },
  { value: 'CANNOT_DO_AT_ALL', label: 'Cannot do it at all', severity: 3 },
];

const SCALE_VALUES = SCALE.map((s) => s.value);
const SEVERITY = Object.fromEntries(SCALE.map((s) => [s.value, s.severity]));

/**
 * The six domains, with the Washington Group's own question wording.
 *
 * The "with glasses" and "with a hearing aid" qualifiers are part of the
 * instrument, not decoration: the question is about functioning as the person
 * actually lives, with whatever assistance they normally use.
 */
const DOMAINS = [
  {
    key: 'seeing',
    field: 'difficultySeeing',
    label: 'Seeing',
    question: 'Do you have difficulty seeing, even if wearing glasses?',
  },
  {
    key: 'hearing',
    field: 'difficultyHearing',
    label: 'Hearing',
    question: 'Do you have difficulty hearing, even if using a hearing aid?',
  },
  {
    key: 'walking',
    field: 'difficultyWalking',
    label: 'Walking or climbing steps',
    question: 'Do you have difficulty walking or climbing steps?',
  },
  {
    key: 'remembering',
    field: 'difficultyRemembering',
    label: 'Remembering or concentrating',
    question: 'Do you have difficulty remembering or concentrating?',
  },
  {
    key: 'selfCare',
    field: 'difficultySelfCare',
    label: 'Self-care',
    question: 'Do you have difficulty with self-care, such as washing all over or dressing?',
  },
  {
    key: 'communicating',
    field: 'difficultyCommunicating',
    label: 'Communicating',
    question: 'Using your usual language, do you have difficulty communicating — for example understanding or being understood?',
  },
];

const FIELDS = DOMAINS.map((d) => d.field);

/** The Washington Group threshold: a lot of difficulty, or cannot do at all. */
const DISABILITY_THRESHOLD = 2;

/**
 * Assess one set of answers.
 *
 * Returns the standard identifier plus the detail behind it, so a reviewer sees
 * which domains drove the result rather than a bare yes or no.
 */
function assess(source = {}) {
  const answers = DOMAINS.map((domain) => {
    const value = source[domain.field] || null;
    return {
      ...domain,
      value,
      // Two different labels, and conflating them produces nonsense: `label` is
      // the domain ("Walking or climbing steps"), `answerLabel` is the point on
      // the scale ("A lot of difficulty"). Spreading the domain and then
      // assigning `label` from the scale overwrote the first with the second,
      // and made explain() read "Significant difficulty with a lot of
      // difficulty."
      answerLabel: SCALE.find((s) => s.value === value)?.label || null,
      severity: value ? SEVERITY[value] : null,
    };
  });

  const answered = answers.filter((a) => a.value);
  const meeting = answered.filter((a) => a.severity >= DISABILITY_THRESHOLD);
  const anyDifficulty = answered.filter((a) => a.severity >= 1);

  return {
    answers,
    answeredCount: answered.length,
    totalDomains: DOMAINS.length,
    complete: answered.length === DOMAINS.length,
    /**
     * The standard identifier. Null rather than false when nothing has been
     * answered — "no disability recorded" and "not asked" are different facts,
     * and reporting the second as the first understates prevalence.
     */
    hasDisability: answered.length === 0 ? null : meeting.length > 0,
    /** Domains at or above the threshold — what makes the answer true. */
    limitingDomains: meeting.map((a) => a.label),
    /** Any reported difficulty, including "some". Recorded, never counted. */
    anyDifficultyDomains: anyDifficulty.map((a) => a.label),
    /** Highest severity reported, for sorting a caseload by need. */
    highestSeverity: answered.length ? Math.max(...answered.map((a) => a.severity)) : null,
  };
}

/** A sentence for a case file or a printed form. */
function explain(finding) {
  if (finding.answeredCount === 0) return 'Functioning questions were not answered.';
  if (!finding.hasDisability) {
    return finding.anyDifficultyDomains.length
      ? `Some difficulty reported with ${finding.anyDifficultyDomains.join(', ').toLowerCase()}, `
        + 'below the standard disability threshold.'
      : 'No difficulty reported in any of the six domains.';
  }
  return `Significant difficulty with ${finding.limitingDomains.join(', ').toLowerCase()}. `
    + 'Meets the Washington Group disability identifier.';
}

/**
 * Everything the ID number already tells us.
 *
 * Date of birth, age and sex are all encoded in the first ten digits, so asking
 * for them separately only creates a second answer to contradict the first —
 * and one more thing for somebody to get wrong on a form they are struggling
 * with. Derived, stored for reporting, and shown back so they can see we read
 * their ID correctly.
 */
function fromIdNumber(idNumber, now = new Date()) {
  if (!idNumber) return { dateOfBirth: null, age: null, sex: null };

  const check = saId.validate(idNumber);
  if (!check.valid) return { dateOfBirth: null, age: null, sex: null };

  const birth = check.birthDate;
  let age = now.getUTCFullYear() - birth.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - birth.getUTCMonth();
  // Not yet had this year's birthday.
  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < birth.getUTCDate())) age -= 1;

  return {
    dateOfBirth: birth,
    age: age >= 0 && age < 130 ? age : null,
    sex: check.gender === 'FEMALE' ? 'FEMALE' : 'MALE',
  };
}

/** Age bands used for reporting, matching the analytics elsewhere. */
function ageBand(age) {
  if (age == null) return null;
  if (age < 18) return 'Under 18';
  if (age < 30) return '18–29';
  if (age < 45) return '30–44';
  if (age < 60) return '45–59';
  if (age < 75) return '60–74';
  return '75 and over';
}

/**
 * Prevalence across a set of applications, for the analytics page.
 *
 * Reported against those who answered rather than against everybody, because a
 * denominator that includes people who were never asked is not a prevalence
 * rate.
 */
function prevalence(applications = []) {
  const assessed = applications.map((a) => assess(a)).filter((f) => f.answeredCount > 0);
  const withDisability = assessed.filter((f) => f.hasDisability);

  const byDomain = DOMAINS.map((domain) => ({
    key: domain.key,
    label: domain.label,
    count: assessed.filter((f) => {
      const answer = f.answers.find((x) => x.key === domain.key);
      return answer?.severity >= DISABILITY_THRESHOLD;
    }).length,
  })).sort((a, b) => b.count - a.count);

  return {
    answered: assessed.length,
    notAnswered: applications.length - assessed.length,
    withDisability: withDisability.length,
    percent: assessed.length ? Math.round((withDisability.length / assessed.length) * 100) : null,
    byDomain,
  };
}

module.exports = {
  SCALE,
  SCALE_VALUES,
  SEVERITY,
  DOMAINS,
  FIELDS,
  DISABILITY_THRESHOLD,
  assess,
  explain,
  fromIdNumber,
  ageBand,
  prevalence,
};
