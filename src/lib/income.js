/**
 * Where the household's money comes from.
 *
 * The form used to open with "are you employed?". That question assumes the
 * answer is a job and turns everything else into an exception to it — which is
 * backwards for this register, where most applicants are not employed. They
 * hold a child grant, an old-age pension, a room let out, piece work. Asking
 * about employment first collects a "no" and then has to retrieve the real
 * answer through follow-ups.
 *
 * So the question is where income comes from, and the answer is a list.
 *
 * ## Why the definitions live here
 *
 * Three clients render this questionnaire: the resident's portal, the mobile
 * app, and the councillor's capture screen. If each one carried its own copy of
 * the types and the follow-up questions they would drift, and the form used by
 * the person least able to check the result would be the one that drifted
 * furthest. The shape is served from `GET /api/applications/income-types` and
 * the clients render whatever they are given.
 *
 * That is the same failure the staff role dropdown had: a hardcoded list of
 * three where the enum held seven, and nothing on screen to say so.
 */

/**
 * Every source type, in the order the form asks about them.
 *
 * `asks` names the follow-up fields for that type. `required` is the subset
 * without which the row means nothing — a business with no name cannot be
 * checked against anything.
 */
const TYPES = [
  {
    value: 'SALARY',
    label: 'A salary or wages',
    hint: 'Employed by somebody else, paid weekly or monthly.',
    asks: ['employerName', 'jobDescription'],
    required: ['jobDescription'],
  },
  {
    value: 'SELF_EMPLOYMENT',
    label: 'Working for myself',
    hint: 'Piece jobs, domestic work, street trading — without a registered business.',
    asks: ['jobDescription'],
    required: ['jobDescription'],
  },
  {
    value: 'BUSINESS',
    label: 'A business',
    hint: 'Formal or informal. Both count, and neither disqualifies you.',
    asks: ['businessName', 'businessType', 'isRegistered'],
    required: ['businessName'],
  },
  { value: 'CHILD_GRANT', label: 'Child support grant', hint: 'Per child, from SASSA.', asks: [], required: [] },
  { value: 'OLD_AGE_PENSION', label: 'Old age grant', hint: 'The state pension from SASSA.', asks: [], required: [] },
  { value: 'DISABILITY_GRANT', label: 'Disability grant', hint: 'From SASSA.', asks: [], required: [] },
  { value: 'FOSTER_CARE_GRANT', label: 'Foster care grant', hint: 'From SASSA.', asks: [], required: [] },
  { value: 'CARE_DEPENDENCY_GRANT', label: 'Care dependency grant', hint: 'From SASSA.', asks: [], required: [] },
  {
    value: 'RETIREMENT_FUND',
    label: 'A pension or provident fund',
    hint: 'From a former employer or a private fund — not the SASSA old age grant.',
    asks: [],
    required: [],
  },
  { value: 'UIF', label: 'UIF payments', hint: 'Unemployment insurance, while it lasts.', asks: [], required: [] },
  { value: 'RENTAL', label: 'Rent from a room or property', hint: 'A back room, a lodger, or a second property.', asks: [], required: [] },
  { value: 'MAINTENANCE', label: 'Maintenance payments', hint: 'Paid by a parent for a child.', asks: [], required: [] },
  { value: 'REMITTANCE', label: 'Money from family', hint: 'Sent regularly by relatives working elsewhere.', asks: [], required: [] },
  {
    value: 'OTHER',
    label: 'Something else',
    hint: 'Anything not listed above.',
    asks: ['otherDetail'],
    required: ['otherDetail'],
  },
];

const VALUES = TYPES.map((t) => t.value);
const byType = (type) => TYPES.find((t) => t.value === type) || null;
const labelFor = (type) => byType(type)?.label || type;

/** Every field any type may carry, so a caller can strip anything else. */
const DETAIL_FIELDS = ['jobDescription', 'employerName', 'businessName', 'businessType', 'isRegistered', 'otherDetail'];

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Check one source before it reaches the database.
 *
 * Returns `{ valid, reason?, data? }` with the detail fields not belonging to
 * this type dropped — a grant carrying a business name is a client bug, and
 * storing it would put a name on a record that has no business.
 */
function validate(input = {}) {
  const type = String(input.type || '').toUpperCase();
  const definition = byType(type);
  if (!definition) {
    return { valid: false, reason: `"${input.type}" is not an income type. Choose one of: ${VALUES.join(', ')}.` };
  }

  const amount = num(input.monthlyAmount);
  if (amount === null) {
    return { valid: false, reason: `Please enter how much you get from ${definition.label.toLowerCase()} each month.` };
  }
  if (amount < 0) {
    return { valid: false, reason: 'An amount cannot be less than zero.' };
  }

  const data = { type, monthlyAmount: amount };

  // Only the fields this type actually asks for survive.
  for (const field of definition.asks) {
    const value = input[field];
    if (field === 'isRegistered') {
      data[field] = value === true || value === 'true' ? true : value === false || value === 'false' ? false : null;
    } else {
      data[field] = value === undefined || value === null || String(value).trim() === '' ? null : String(value).trim();
    }
  }
  for (const field of DETAIL_FIELDS) {
    if (!(field in data)) data[field] = null;
  }

  for (const field of definition.required) {
    if (data[field] === null) {
      return { valid: false, reason: missingMessage(definition, field) };
    }
  }

  if (input.memberId) data.memberId = String(input.memberId);

  return { valid: true, data };
}

/** Said in the applicant's own terms, not the column's. */
function missingMessage(definition, field) {
  switch (field) {
    case 'jobDescription': return 'Please say what the work is — for example "street vendor" or "domestic worker".';
    case 'businessName': return 'Please give the name of the business.';
    case 'otherDetail': return 'Please say what this income is.';
    default: return `${field} is required for ${definition.label.toLowerCase()}.`;
  }
}

/**
 * The household's monthly total, and what that is per person.
 *
 * Household members' own income is counted here too. It is declared separately,
 * on the household roll, and leaving it out understated the total for exactly
 * the households where it mattered most — several earners, none of them the
 * applicant.
 */
function totals(sources = [], { people = 1, household = [] } = {}) {
  const fromSources = sources.reduce((sum, s) => sum + (num(s.monthlyAmount) ?? 0), 0);
  const fromMembers = household.reduce((sum, m) => sum + (num(m.monthlyIncome) ?? 0), 0);

  const total = Math.round((fromSources + fromMembers) * 100) / 100;
  const headcount = Math.max(1, Number(people) || 1);

  return {
    total,
    perPerson: Math.round((total / headcount) * 100) / 100,
    fromSources: Math.round(fromSources * 100) / 100,
    fromMembers: Math.round(fromMembers * 100) / 100,
  };
}

/**
 * The employment status these answers imply.
 *
 * `EmploymentStatus` still drives the conditional document checklist and the
 * applicant category, so it cannot simply be deleted — but it must stop being a
 * separate question, or the form has two places to disagree about the same
 * fact. Derived here, in priority order: what somebody *does* outranks what
 * they receive.
 */
function employmentStatusFor(sources = [], { declaredNoIncome = false } = {}) {
  const has = (type) => sources.some((s) => s.type === type);

  if (has('SALARY')) return 'EMPLOYED';
  if (has('SELF_EMPLOYMENT') || has('BUSINESS')) return 'SELF_EMPLOYED';
  if (has('OLD_AGE_PENSION') || has('RETIREMENT_FUND')) return 'PENSIONER';
  if (sources.length > 0) return 'OTHER';
  // No sources and an explicit "nothing at all" is a real answer. No sources
  // and no such statement means the question has not been reached yet.
  return declaredNoIncome ? 'UNEMPLOYED' : null;
}

/**
 * Whether the income section has been answered at all.
 *
 * An empty list on its own is not an answer — it is the state of a form nobody
 * has filled in. Submission needs to tell those apart.
 */
const answered = (sources = [], { declaredNoIncome = false } = {}) =>
  sources.length > 0 || declaredNoIncome === true;

/** One line per source, for the reviewer's screen and the printable file. */
function describe(source) {
  const definition = byType(source.type);
  const label = definition?.label || source.type;

  switch (source.type) {
    case 'SALARY':
      return source.employerName
        ? `${label} — ${source.jobDescription} at ${source.employerName}`
        : `${label} — ${source.jobDescription}`;
    case 'SELF_EMPLOYMENT':
      return `${label} — ${source.jobDescription}`;
    case 'BUSINESS':
      return `${label} — ${source.businessName}`
        + `${source.businessType ? ` (${source.businessType})` : ''}`
        + `${source.isRegistered === null || source.isRegistered === undefined ? '' : source.isRegistered ? ', registered' : ', informal'}`;
    case 'OTHER':
      return `${label} — ${source.otherDetail}`;
    default:
      return label;
  }
}

module.exports = {
  TYPES,
  VALUES,
  DETAIL_FIELDS,
  byType,
  labelFor,
  validate,
  totals,
  employmentStatusFor,
  answered,
  describe,
};
