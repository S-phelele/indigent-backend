/**
 * What an applicant must supply, and what counts as supplied.
 *
 * This list used to be copy-pasted into both applications.js and admin.js. Two
 * copies of a rule is one copy too many: an application created by an
 * administrator could end up with a different set of obligations than one the
 * resident started themselves, and nothing would have caught it.
 *
 * ## The checklist is conditional
 *
 * Asking every applicant for every document is how a register turns people away.
 * A pensioner does not need a guardianship order; a tenant cannot produce a
 * title deed; somebody with no bank account cannot produce statements. So the
 * checklist is computed from three things the applicant tells us:
 *
 *   - `applicantCategory` — standard, pensioner, deceased estate, child-headed,
 *     disabled. Adds the documents that case actually needs.
 *   - `tenure` — owner, tenant or occupier. Decides between a title deed and a
 *     lease.
 *   - `incomeEvidence` — which of the three income routes they can satisfy.
 *
 * Until those are answered the checklist is the common core, so somebody can
 * start uploading an ID copy before deciding anything else.
 *
 * ## Why bank statements are not required
 *
 * The original list demanded ID, bank statements and an affidavit. Bank
 * statements exclude precisely the households the register exists for — an
 * unbanked pensioner, a domestic worker paid in cash, a household living on a
 * child support grant. Roughly a fifth of South African adults have no bank
 * account at all, and asking them for three months of statements is asking them
 * to fail.
 *
 * What matters is evidence of what the household lives on, by whichever route
 * they can produce. That is the `financial_evidence` group below.
 */

const GROUPS = {
  FINANCIAL_EVIDENCE: 'financial_evidence',
};

const REQUIRED = 'REQUIRED';
const OPTIONAL = 'OPTIONAL';

/**
 * The core every application starts with, in the order they are presented.
 *
 * Ordering is deliberate: the documents most households can actually produce
 * come first, so the list does not open with a barrier.
 */
const CORE = [
  {
    name: 'ID Copy',
    type: 'ID_COPY',
    importance: REQUIRED,
    group: null,
    hint: 'A copy of your green ID book, smart ID card, or valid permanent residence permit.',
  },
  {
    name: 'Proof of Income',
    type: 'PROOF_OF_INCOME',
    importance: OPTIONAL,
    group: GROUPS.FINANCIAL_EVIDENCE,
    hint: 'A payslip, a letter from your employer, or a pension or SASSA letter.',
  },
  {
    name: 'Proof of Grant',
    type: 'PROOF_OF_GRANT',
    importance: OPTIONAL,
    group: GROUPS.FINANCIAL_EVIDENCE,
    hint: 'Your SASSA letter or grant confirmation slip — old age, disability, child support or foster care.',
  },
  {
    name: 'Affidavit',
    type: 'AFFIDAVIT',
    importance: REQUIRED,
    group: null,
    hint: 'A sworn statement of your household circumstances, commissioned free of charge at any police station.',
  },
  {
    name: 'Bank Statements',
    type: 'BANK_STATEMENTS',
    importance: OPTIONAL,
    group: GROUPS.FINANCIAL_EVIDENCE,
    hint: 'Three months of statements if you have a bank account. Not required — leave this out if you do not.',
  },
  {
    name: 'Municipal Statement',
    type: 'MUNICIPAL_STATEMENT',
    importance: OPTIONAL,
    group: null,
    hint: 'Your latest municipal account, or your prepaid electricity purchase history.',
  },
  {
    name: 'Copy of Death Certificate',
    type: 'COPY_OF_DEATH_CERT',
    importance: OPTIONAL,
    group: null,
    hint: 'Only if the property was registered to someone who has since died.',
  },
  {
    name: 'Letter of Authority',
    type: 'LETTER_OF_AUTHORITY',
    importance: OPTIONAL,
    group: null,
    hint: 'Only if you are applying on behalf of the registered owner, or administering a deceased estate.',
  },
];

/** Added once the applicant says whether they own, rent or occupy. */
const BY_TENURE = {
  OWNER: [{
    name: 'Proof of Ownership',
    type: 'PROOF_OF_OWNERSHIP',
    importance: REQUIRED,
    group: null,
    hint: 'Your title deed, deed of sale, or a rates account in your name.',
  }],
  TENANT: [{
    name: 'Lease Agreement',
    type: 'LEASE_AGREEMENT',
    importance: REQUIRED,
    group: null,
    hint: 'Your lease, or a letter from your landlord confirming you rent this property.',
  }],
  // An occupier has neither, by definition — somebody living on family land, or
  // in an informal dwelling. The affidavit in the core list carries this case.
  OCCUPIER: [],
};

/** Added by applicant category. */
const BY_CATEGORY = {
  STANDARD: [],
  PENSIONER: [],
  DECEASED_ESTATE: [
    { name: 'Death Certificate', type: 'COPY_OF_DEATH_CERT', importance: REQUIRED, group: null,
      hint: 'The death certificate of the registered owner.' },
    { name: 'Letter of Authority', type: 'LETTER_OF_AUTHORITY', importance: REQUIRED, group: null,
      hint: 'Letter of Authority or Executorship from the Master of the High Court.' },
    { name: 'Marriage Certificate', type: 'MARRIAGE_CERTIFICATE', importance: OPTIONAL, group: null,
      hint: 'Only if you are the surviving spouse.' },
  ],
  CHILD_HEADED: [
    { name: 'Birth Certificate', type: 'BIRTH_CERTIFICATE', importance: REQUIRED, group: null,
      hint: 'Birth certificate of the young person heading the household.' },
    { name: 'Guardianship Order', type: 'GUARDIANSHIP_ORDER', importance: OPTIONAL, group: null,
      hint: 'A court-appointed guardianship order, if one exists.' },
    { name: 'Social Worker Letter', type: 'SOCIAL_WORKER_LETTER', importance: REQUIRED, group: null,
      hint: 'A letter from the social worker handling the household.' },
  ],
  DISABLED: [
    { name: 'Disability Certificate', type: 'DISABILITY_CERTIFICATE', importance: REQUIRED, group: null,
      hint: 'A medical certificate or SASSA disability assessment.' },
  ],
};

/**
 * The full slot list for a given application.
 *
 * `application` may be a bare object with none of these fields set — a draft
 * that has only just been created — in which case only the core is returned.
 */
function slotsFor(application = {}) {
  const seen = new Set();
  const out = [];

  const add = (slot) => {
    // First definition of a type wins, so a category can promote a core slot to
    // REQUIRED by being applied first, and duplicates never reach the database.
    if (seen.has(slot.type)) return;
    seen.add(slot.type);
    out.push(slot);
  };

  (BY_CATEGORY[application.applicantCategory] || []).forEach(add);
  (BY_TENURE[application.tenure] || []).forEach(add);
  CORE.forEach(add);

  return out;
}

/** The list a brand-new application starts with, before anything is answered. */
const SLOTS = slotsFor({});

/**
 * Requirement groups, described for the interface.
 *
 * `label` names the obligation rather than any one document, because telling
 * someone "Proof of Income is missing" when a grant letter would do is how you
 * get an unnecessary phone call.
 */
const GROUP_RULES = {
  [GROUPS.FINANCIAL_EVIDENCE]: {
    key: GROUPS.FINANCIAL_EVIDENCE,
    label: 'Proof of income, proof of grant, or bank statements',
    description:
      'Supply whichever one you can. A payslip or employer\'s letter, a SASSA grant letter, or three months of bank '
      + 'statements — any single one of these is enough. If you have none of them, your sworn affidavit covers it.',
    minimum: 1,
  },
};

/** Rows to create for a new application. */
function seedRows(applicationId, application = {}) {
  return slotsFor(application).map((slot) => ({
    applicationId,
    name: slot.name,
    type: slot.type,
    importance: slot.importance,
    requirementGroup: slot.group,
    status: 'Pending',
  }));
}

/**
 * Bring an existing application's slots into line after its category, tenure or
 * evidence route changed.
 *
 * Returns what to add and what to drop. Anything already uploaded is never
 * dropped: an applicant who supplied a lease and then corrected their tenure to
 * owner should not silently lose the file they sent.
 */
function reconcile(existing = [], application = {}) {
  const wanted = slotsFor(application);
  const wantedTypes = new Set(wanted.map((s) => s.type));
  const haveTypes = new Set(existing.map((d) => d.type));

  const toCreate = wanted
    .filter((s) => !haveTypes.has(s.type))
    .map((slot) => ({
      applicationId: application.id,
      name: slot.name,
      type: slot.type,
      importance: slot.importance,
      requirementGroup: slot.group,
      status: 'Pending',
    }));

  const toDelete = existing
    .filter((d) => !wantedTypes.has(d.type) && d.status === 'Pending' && !d.filePath)
    .map((d) => d.id);

  // A slot that is still wanted but whose obligation changed — a lease that was
  // required and is now merely optional, say.
  const toUpdate = wanted
    .map((slot) => {
      const current = existing.find((d) => d.type === slot.type);
      if (!current) return null;
      if (current.importance === slot.importance && current.requirementGroup === slot.group) return null;
      return { id: current.id, importance: slot.importance, requirementGroup: slot.group };
    })
    .filter(Boolean);

  return { toCreate, toDelete, toUpdate };
}

/** A document counts once it is uploaded and has not been rejected on review. */
const isSupplied = (doc) => doc.status === 'Uploaded';

/**
 * What is still outstanding before this application can be submitted.
 *
 * Returns the individual required slots that are empty, plus any group that has
 * no member supplied. `complete` is the single thing callers usually want.
 */
function outstanding(documents = []) {
  const missingRequired = documents.filter(
    (d) => d.importance === REQUIRED && !d.requirementGroup && !isSupplied(d)
  );

  const missingGroups = [];
  for (const rule of Object.values(GROUP_RULES)) {
    const members = documents.filter((d) => d.requirementGroup === rule.key);
    // A group nobody has a slot for cannot be outstanding — this keeps
    // applications created before the group existed from becoming unsubmittable.
    if (members.length === 0) continue;
    if (members.filter(isSupplied).length < rule.minimum) {
      missingGroups.push({ ...rule, options: members.map((m) => m.name) });
    }
  }

  return {
    missingRequired,
    missingGroups,
    complete: missingRequired.length === 0 && missingGroups.length === 0,
  };
}

/**
 * One sentence naming what is missing, for a toast or an error body.
 * Returns null when nothing is outstanding.
 */
function outstandingMessage(documents = []) {
  const { missingRequired, missingGroups, complete } = outstanding(documents);
  if (complete) return null;

  const parts = [
    ...missingRequired.map((d) => d.name),
    ...missingGroups.map((g) => g.options.join(' or ')),
  ];

  return parts.length === 1
    ? `${parts[0]} is still needed.`
    : `Still needed: ${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}.`;
}

/**
 * How far along the document collection is, counting a satisfied group as one
 * item rather than three — otherwise supplying a grant letter would show 33%
 * forever, because the two slots beside it will never be filled.
 */
function progress(documents = []) {
  const singles = documents.filter((d) => d.importance === REQUIRED && !d.requirementGroup);
  const groupKeys = [...new Set(documents.filter((d) => d.requirementGroup).map((d) => d.requirementGroup))]
    .filter((k) => GROUP_RULES[k]);

  const total = singles.length + groupKeys.length;
  const done = singles.filter(isSupplied).length
    + groupKeys.filter((k) => documents.some((d) => d.requirementGroup === k && isSupplied(d))).length;

  return { done, total, percent: total === 0 ? 100 : Math.round((done / total) * 100) };
}

module.exports = {
  SLOTS,
  CORE,
  BY_TENURE,
  BY_CATEGORY,
  GROUPS,
  GROUP_RULES,
  slotsFor,
  seedRows,
  reconcile,
  outstanding,
  outstandingMessage,
  progress,
  isSupplied,
};
