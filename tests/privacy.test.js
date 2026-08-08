const test = require('node:test');
const assert = require('node:assert/strict');

const subjectAccess = require('../src/lib/subjectAccess');

/**
 * Load privacyNotice with a specific environment.
 *
 * The module reads the Information Officer out of the environment once, at
 * require time, so the cache has to be cleared to test both the configured and
 * the unconfigured case.
 */
function loadNotice(env = {}) {
  const keys = [
    'MUNICIPALITY_NAME', 'INFORMATION_OFFICER_NAME', 'INFORMATION_OFFICER_EMAIL',
    'MUNICIPALITY_POSTAL_ADDRESS', 'SUBJECT_REQUEST_RESPONSE_DAYS',
  ];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  keys.forEach((k) => delete process.env[k]);
  Object.assign(process.env, env);

  delete require.cache[require.resolve('../src/lib/privacyNotice')];
  const mod = require('../src/lib/privacyNotice');

  keys.forEach((k) => {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  });
  return mod;
}

const APPLICANT = {
  id: 'u1',
  email: 'thandi@example.com',
  firstName: 'Thandi',
  lastName: 'Mokoena',
  cellNumber: '+27821234567',
  idNumber: '9202204720082',
  role: 'APPLICANT',
  isVerified: true,
  ward: '7',
  createdAt: new Date('2026-01-05'),
  updatedAt: new Date('2026-02-01'),
  registeredById: null,
};

const APPLICATION = {
  id: 'a1',
  reference: 'IND-2026-0001',
  status: 'APPROVED',
  submittedAt: new Date('2026-01-10'),
  reviewedAt: new Date('2026-02-01'),
  expiresAt: new Date('2027-02-01'),
  residentialAddress: '12 Mandela Street, Soweto',
  postalAddress: null,
  wardNumber: '7',
  tenure: 'OWNER',
  municipalAccountNumber: '5001234',
  peopleOnProperty: 4,
  totalHouseholdIncome: 4200,
  employmentStatus: 'UNEMPLOYED',
  ownsOtherProperty: false,
  dateOfBirth: new Date('1992-02-20'),
  age: 34,
  sex: 'FEMALE',
  totalIncomePerPerson: 1050,
  hasDisability: true,
  difficultySeeing: 'A_LOT_OF_DIFFICULTY',
  difficultyHearing: 'NO_DIFFICULTY',
  addressLatitude: -26.2678901,
  addressLongitude: 27.8654321,
  addressSource: 'DEVICE',
  addressVerifiedAt: new Date('2026-01-10'),
  anonymisedAt: null,
  anonymisedUnder: null,
  household: [
    { fullName: 'Sipho Mokoena', relationship: 'Son', age: 12, idNumber: '1401015800083', income: 0 },
  ],
  documents: [
    { name: 'ID copy', type: 'ID_COPY', status: 'Uploaded', uploadedAt: new Date('2026-01-10'), fileName: 'id.pdf' },
    { name: 'Bank statement', type: 'BANK_STATEMENTS', status: 'Required', uploadedAt: null, fileName: null },
  ],
  siteVisits: [
    { attempt: 1, outcome: 'NOT_HOME', visitedAt: new Date('2026-01-15'), officerName: 'M. Dlamini' },
  ],
  checks: [
    { source: 'SASSA', outcome: 'CONFIRMED', checkedAt: new Date('2026-01-20') },
  ],
  approvalSteps: [
    { stage: 'VERIFICATION', sequence: 1, actorName: 'M. Dlamini', actorRole: 'VERIFICATION_OFFICER', startedAt: new Date('2026-01-15'), decidedAt: new Date('2026-01-21') },
    { stage: 'SUPERVISOR_SIGNOFF', sequence: 3, actorName: 'P. Nkosi', actorRole: 'SUPERVISOR', startedAt: new Date('2026-01-30'), decidedAt: new Date('2026-02-01') },
  ],
  changes: [
    { field: 'residentialAddress', oldValue: '12 Mandela St', newValue: '12 Mandela Street, Soweto', actorName: 'M. Dlamini', createdAt: new Date('2026-01-16') },
  ],
};

const fakeClient = ({ user = APPLICANT, applications = [APPLICATION] } = {}) => ({
  user: { findUnique: async () => user },
  application: { findMany: async () => applications },
  notification: { findMany: async () => [{ type: 'APPLICATION_APPROVED', title: 'Approved', body: 'Good news', createdAt: new Date('2026-02-01'), readAt: null }] },
  smsMessage: { findMany: async () => [{ toNumber: '+27821234567', purpose: 'APPROVED', body: 'Your application was approved', status: 'SENT', createdAt: new Date('2026-02-01') }] },
  auditLog: { findMany: async () => [{ action: 'APPROVE_APPLICATION', details: 'Approved', createdAt: new Date('2026-02-01'), userRole: 'SUPERVISOR' }] },
});

// ---------------------------------------------------------------------------
// Subject access — what is disclosed
// ---------------------------------------------------------------------------

test('an unknown person gets null, not an empty report', async () => {
  // An empty report reads as "we hold nothing about you", which is a different
  // and possibly untrue statement.
  const record = await subjectAccess.compile('nobody', fakeClient({ user: null }));
  assert.equal(record, null);
});

test('the response names the person and how their account was made', async () => {
  const record = await subjectAccess.compile('u1', fakeClient());
  assert.equal(record.about.name, 'Thandi Mokoena');
  assert.equal(record.about.idNumber, '9202204720082');
  assert.match(record.about.accountCreatedBy, /registered this account yourself/);
});

test('an account created at the door says so', async () => {
  const record = await subjectAccess.compile('u1', fakeClient({
    user: { ...APPLICANT, registeredById: 'councillor-1' },
  }));
  assert.match(record.about.accountCreatedBy, /official created this account on your behalf/);
});

test('a placeholder email is not reported back as an email address', async () => {
  // Councillor-captured applicants get a synthetic address so the account can
  // exist. Telling somebody their email is thandi@cell.indigent.local would be
  // reporting our own plumbing back to them as their data.
  const record = await subjectAccess.compile('u1', fakeClient({
    user: { ...APPLICANT, email: '27821234567@cell.indigent.local' },
  }));
  assert.equal(record.about.emailAddress, null);
});

test('every derived value explains where it came from', async () => {
  // s23 covers information held. A figure the person cannot account for is the
  // kind that goes wrong quietly.
  const [app] = (await subjectAccess.compile('u1', fakeClient())).applications;

  assert.equal(app.whatWeWorkedOut.dateOfBirth.value, '1992-02-20');
  assert.match(app.whatWeWorkedOut.dateOfBirth.derivedFrom, /ID number/);
  assert.match(app.whatWeWorkedOut.sex.derivedFrom, /ID number/);
  assert.match(app.whatWeWorkedOut.age.derivedFrom, /date of birth/i);
  assert.match(app.whatWeWorkedOut.incomePerPerson.derivedFrom, /divided by/);
  assert.match(app.whatWeWorkedOut.disabilityIdentifier.derivedFrom, /Washington Group/);
});

test('the disability identifier is omitted when it was never worked out', async () => {
  const [app] = (await subjectAccess.compile('u1', fakeClient({
    applications: [{ ...APPLICATION, hasDisability: null }],
  }))).applications;
  assert.equal('disabilityIdentifier' in app.whatWeWorkedOut, false);
});

test('coordinates are disclosed plainly, with how they were obtained', async () => {
  const [app] = (await subjectAccess.compile('u1', fakeClient())).applications;
  assert.match(app.locationHeld.coordinates, /-26\.267/);
  assert.match(app.locationHeld.howItWasObtained, /device at the property/);
});

test('no location section appears when none is held', async () => {
  const [app] = (await subjectAccess.compile('u1', fakeClient({
    applications: [{ ...APPLICATION, addressLatitude: null, addressLongitude: null }],
  }))).applications;
  assert.equal('locationHeld' in app, false);
});

test('external checks are listed as disclosures', async () => {
  // s23(1)(b): the person is entitled to know who their information went to.
  const [app] = (await subjectAccess.compile('u1', fakeClient())).applications;
  assert.equal(app.externalChecksRunOnYou.length, 1);
  assert.equal(app.externalChecksRunOnYou[0].organisation, 'SASSA');
  assert.match(app.externalChecksRunOnYou[0].basis, /consented/);
});

test('the officials who handled the case are named', async () => {
  const [app] = (await subjectAccess.compile('u1', fakeClient())).applications;
  assert.equal(app.whoHasHandledIt.length, 2);
  assert.equal(app.whoHasHandledIt[0].official, 'M. Dlamini');
  assert.equal(app.whoHasHandledIt[0].stage, 'verification');
});

test('an unattributed step still reads as a sentence', async () => {
  const [app] = (await subjectAccess.compile('u1', fakeClient({
    applications: [{ ...APPLICATION, approvalSteps: [{ stage: 'ASSESSMENT', sequence: 2, actorName: null, actorRole: null, startedAt: new Date('2026-01-25'), decidedAt: null }] }],
  }))).applications;
  assert.equal(app.whoHasHandledIt[0].official, 'A municipal official');
});

// ---------------------------------------------------------------------------
// Subject access — what is withheld
// ---------------------------------------------------------------------------

test("a household member's ID number and income are withheld", async () => {
  // s63(2): access may be refused where it would reveal another person's
  // information. A child's ID number is the child's, not the applicant's.
  const [app] = (await subjectAccess.compile('u1', fakeClient())).applications;
  const member = app.householdMembersYouListed[0];

  assert.equal(member.name, 'Sipho Mokoena');
  assert.equal('idNumber' in member, false);
  assert.equal('income' in member, false);
  assert.match(member.note, /withheld/);
});

test('the whole response contains no household ID number anywhere', async () => {
  // Belt and braces: a future edit that widens an include could reintroduce it
  // somewhere other than the household list.
  const record = await subjectAccess.compile('u1', fakeClient());
  assert.doesNotMatch(JSON.stringify(record), /1401015800083/);
});

test('only documents actually supplied are listed', async () => {
  // Listing a required-but-missing slot as a document "you gave us" would be wrong.
  const [app] = (await subjectAccess.compile('u1', fakeClient())).applications;
  assert.equal(app.documentsYouGaveUs.length, 1);
  assert.equal(app.documentsYouGaveUs[0].document, 'ID copy');
});

test('the response tells the person what they can do about it', async () => {
  const record = await subjectAccess.compile('u1', fakeClient());
  assert.ok(record.yourRights.some((r) => /correct/i.test(r)));
  assert.ok(record.yourRights.some((r) => /Information Regulator/.test(r)));
  assert.ok(record.ourRetentionPolicy.length > 0);
});

test('an anonymised application explains why it is mostly empty', async () => {
  // A row full of nulls with no explanation looks like a bug, not a policy.
  const [app] = (await subjectAccess.compile('u1', fakeClient({
    applications: [{ ...APPLICATION, anonymisedAt: new Date('2031-02-01'), anonymisedUnder: 'LAPSED_REGISTRATION' }],
  }))).applications;
  assert.match(app.retentionNote, /2031-02-01/);
  assert.match(app.retentionNote, /LAPSED_REGISTRATION/);
});

// ---------------------------------------------------------------------------
// Deletion assessment
// ---------------------------------------------------------------------------

const withApps = (applications) => ({ application: { findMany: async () => applications } });

test('a person with nothing on file can be deleted', async () => {
  const result = await subjectAccess.deletionAssessment('u1', withApps([]));
  assert.equal(result.canDeleteNow, true);
  assert.equal(result.blockers.length, 0);
  assert.equal(result.alternative, null);
});

test('a live application blocks deletion and says how to unblock it', async () => {
  const result = await subjectAccess.deletionAssessment('u1', withApps([
    { id: 'a', reference: 'IND-1', status: 'PENDING', renewalStatus: null },
  ]));
  assert.equal(result.canDeleteNow, false);
  const blocker = result.blockers.find((b) => b.code === 'APPLICATION_IN_PROGRESS');
  assert.match(blocker.message, /Withdraw them first/);
});

test('active support blocks deletion, because deleting would end it', async () => {
  const result = await subjectAccess.deletionAssessment('u1', withApps([
    { id: 'a', reference: 'IND-1', status: 'APPROVED', renewalStatus: 'CURRENT' },
  ]));
  assert.ok(result.blockers.some((b) => b.code === 'ACTIVE_SUPPORT'));
});

test('a lapsed registration no longer counts as active support', async () => {
  const result = await subjectAccess.deletionAssessment('u1', withApps([
    { id: 'a', reference: 'IND-1', status: 'APPROVED', renewalStatus: 'LAPSED' },
  ]));
  assert.equal(result.blockers.some((b) => b.code === 'ACTIVE_SUPPORT'), false);
  // But the MFMA record still stands.
  assert.ok(result.blockers.some((b) => b.code === 'FINANCIAL_RECORD'));
});

test('a refusal always offers anonymisation instead of a flat no', async () => {
  const result = await subjectAccess.deletionAssessment('u1', withApps([
    { id: 'a', reference: 'IND-1', status: 'APPROVED', renewalStatus: 'CURRENT' },
  ]));
  assert.match(result.alternative, /anonymise/i);
  assert.match(result.alternative, /name, ID number, address/);
});

test('a declined application on its own does not block deletion', async () => {
  const result = await subjectAccess.deletionAssessment('u1', withApps([
    { id: 'a', reference: 'IND-1', status: 'DECLINED', renewalStatus: null },
  ]));
  assert.equal(result.canDeleteNow, true);
});

// ---------------------------------------------------------------------------
// The privacy notice
// ---------------------------------------------------------------------------

test('an unconfigured Information Officer is stated, not faked', () => {
  // A plausible-looking placeholder published as a statutory appointment is worse
  // than an obvious gap: nobody chases a gap they cannot see.
  const notice = loadNotice().notice();
  assert.equal(notice.informationOfficer, null);
  assert.match(notice.informationOfficerWarning, /section 55/);
});

test('a configured Information Officer is published', () => {
  const notice = loadNotice({
    MUNICIPALITY_NAME: 'Emfuleni Local Municipality',
    INFORMATION_OFFICER_NAME: 'N. Khumalo',
    INFORMATION_OFFICER_EMAIL: 'io@emfuleni.gov.za',
  }).notice();

  assert.equal(notice.municipality, 'Emfuleni Local Municipality');
  assert.equal(notice.informationOfficer.name, 'N. Khumalo');
  assert.equal(notice.informationOfficerWarning, null);
});

test('readiness names the missing settings by their variable', () => {
  // An administrator reading "something is missing" cannot act. A variable name
  // they can search for is actionable.
  const { ready, gaps } = loadNotice().readiness();
  assert.equal(ready, false);
  assert.ok(gaps.some((g) => /INFORMATION_OFFICER_NAME/.test(g)));
  assert.ok(gaps.some((g) => /MUNICIPALITY_POSTAL_ADDRESS/.test(g)));
});

test('readiness passes once everything is set', () => {
  const { ready, gaps } = loadNotice({
    MUNICIPALITY_NAME: 'Emfuleni Local Municipality',
    INFORMATION_OFFICER_NAME: 'N. Khumalo',
    INFORMATION_OFFICER_EMAIL: 'io@emfuleni.gov.za',
    MUNICIPALITY_POSTAL_ADDRESS: 'PO Box 3, Vanderbijlpark, 1900',
  }).readiness();
  assert.equal(ready, true);
  assert.deepEqual(gaps, []);
});

test('every processing entry states a lawful ground and who receives it', () => {
  for (const entry of loadNotice().PROCESSING_REGISTER) {
    assert.match(entry.basis, /POPIA s\d/, `${entry.category} must cite a section`);
    assert.ok(entry.purpose.length > 20, `${entry.category} must state a real purpose`);
    assert.ok(Array.isArray(entry.recipients) && entry.recipients.length, `${entry.category} must list recipients`);
  }
});

test('only genuinely refusable processing is marked voluntary', () => {
  // Marking statutory processing "voluntary" would be a lie; marking consent-based
  // processing compulsory would make the consent meaningless. Both matter.
  const notice = loadNotice().notice();
  const voluntary = notice.whatIsOptional.map((o) => o.category);

  assert.deepEqual(
    voluntary.sort(),
    ['Health and functioning', 'Location of your home', 'Verification checks'].sort()
  );
  for (const entry of notice.whatIsOptional) {
    assert.match(entry.note, /consent/i);
  }
});

test('health information is processed under the special-information section', () => {
  // s26 prohibits processing health information; s27 lists the exceptions. Citing
  // s11 alone would be the wrong ground.
  const health = loadNotice().PROCESSING_REGISTER.find((p) => p.category === 'Health and functioning');
  assert.match(health.basis, /s27\(1\)\(a\)/);
  assert.equal(health.special, true);
  assert.equal(health.voluntary, true);
});

test('the statutory processing does not pretend to rest on consent', () => {
  // A household cannot meaningfully consent to something the municipality is
  // obliged to do anyway.
  const identity = loadNotice().PROCESSING_REGISTER.find((p) => p.category === 'Identity');
  assert.match(identity.basis, /s11\(1\)\(c\)/);
  assert.equal(identity.voluntary, false);
});

test('the notice carries the retention policy and the Regulator', () => {
  const notice = loadNotice().notice();
  assert.ok(notice.retention.length > 0);
  assert.match(notice.regulator.email, /@/);
  assert.match(notice.responseStandard, /30 days/);
});

test('the response deadline is configurable', () => {
  const notice = loadNotice({ SUBJECT_REQUEST_RESPONSE_DAYS: '14' }).notice();
  assert.match(notice.responseStandard, /14 days/);
});
