const test = require('node:test');
const assert = require('node:assert/strict');

const verification = require('../src/lib/verification');

const visits = (...outcomes) => outcomes.map((outcome, i) => ({ attempt: i + 1, outcome }));

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

test('verification cannot begin without all three consents', () => {
  const gate = verification.consentGate({
    consentSiteVisit: false, consentDataMatching: false, declarationTruthful: false,
  });
  assert.equal(gate.ok, false);
  assert.equal(gate.blockers.length, 3);
});

test('all three consents opens the gate', () => {
  const gate = verification.consentGate({
    consentSiteVisit: true, consentDataMatching: true, declarationTruthful: true,
  });
  assert.equal(gate.ok, true);
  assert.deepEqual(gate.blockers, []);
});

test('a missing consent names which one', () => {
  const gate = verification.consentGate({
    consentSiteVisit: true, consentDataMatching: false, declarationTruthful: true,
  });
  assert.equal(gate.ok, false);
  assert.match(gate.blockers[0], /external data checks/i);
});

// ---------------------------------------------------------------------------
// Separation of duties
// ---------------------------------------------------------------------------

test('an officer may not verify an application they captured', () => {
  // The single most important separation in the process. Without it, one person
  // can walk a fabricated household from the door to an approval unchallenged.
  const result = verification.separationOfDuties(
    { capturedById: 'officer-1' },
    { id: 'officer-1', role: 'VERIFICATION_OFFICER' }
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /cannot also verify/i);
});

test('an officer may verify work somebody else captured', () => {
  const result = verification.separationOfDuties(
    { capturedById: 'officer-2' },
    { id: 'officer-1', role: 'VERIFICATION_OFFICER' }
  );
  assert.equal(result.ok, true);
});

test('a self-service application has no capturer to conflict with', () => {
  const result = verification.separationOfDuties(
    { capturedById: null },
    { id: 'officer-1', role: 'VERIFICATION_OFFICER' }
  );
  assert.equal(result.ok, true);
});

test('an administrator is not blocked by their own capture', () => {
  // Administrators already hold every power; blocking them here would only push
  // the work into a second account, which is worse for the audit trail.
  const result = verification.separationOfDuties(
    { capturedById: 'admin-1' },
    { id: 'admin-1', role: 'ADMIN' }
  );
  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// The three-attempt rule
// ---------------------------------------------------------------------------

test('two failed visits do not disqualify', () => {
  const state = verification.visitState(visits('NO_ACCESS', 'OCCUPANT_ABSENT'));
  assert.equal(state.failed, 2);
  assert.equal(state.exhausted, false);
  assert.equal(state.remaining, 1);
});

test('three failed visits disqualify', () => {
  const state = verification.visitState(visits('NO_ACCESS', 'OCCUPANT_ABSENT', 'ADDRESS_NOT_FOUND'));
  assert.equal(state.failed, 3);
  assert.equal(state.exhausted, true);
  assert.equal(state.remaining, 0);
});

test('a successful visit ends the matter, however many failed before it', () => {
  // Somebody who was out twice and home the third time has not failed anything.
  const state = verification.visitState(visits('NO_ACCESS', 'OCCUPANT_ABSENT', 'VERIFIED'));
  assert.equal(state.verified, true);
  assert.equal(state.exhausted, false, 'a verified household is never disqualified for non-access');
});

test('a scheduled visit is not yet an attempt', () => {
  // Otherwise booking three visits would disqualify somebody before anyone
  // knocked on their door.
  const state = verification.visitState(visits('SCHEDULED', 'SCHEDULED', 'SCHEDULED'));
  assert.equal(state.attempts, 0);
  assert.equal(state.failed, 0);
  assert.equal(state.exhausted, false);
});

test('a disputed visit is a finding, not a failed attempt', () => {
  const state = verification.visitState(visits('DETAILS_DISPUTED'));
  assert.equal(state.failed, 0);
  assert.equal(state.attempts, 1);
});

test('the next attempt number follows every row, including scheduled ones', () => {
  assert.equal(verification.visitState([]).nextAttempt, 1);
  assert.equal(verification.visitState(visits('SCHEDULED')).nextAttempt, 2);
  assert.equal(verification.visitState(visits('NO_ACCESS', 'VERIFIED')).nextAttempt, 3);
});

// ---------------------------------------------------------------------------
// Assessment
// ---------------------------------------------------------------------------

test('income found externally above income declared is a high concern', () => {
  const result = verification.assess(
    { totalHouseholdIncome: 2000 },
    { checks: [{ source: 'SARS', amountFound: 9000, outcome: 'PASS' }] }
  );
  const concern = result.concerns.find((c) => c.code === 'INCOME_MISMATCH');
  assert.ok(concern, 'a mismatch this large must be raised');
  assert.equal(concern.severity, 'high');
  assert.equal(result.highest, 'high');
});

test('a small difference between found and declared income is not raised', () => {
  // Rounding, a shift allowance, one month's overtime. Flagging these would bury
  // the real mismatches in noise.
  const result = verification.assess(
    { totalHouseholdIncome: 4000 },
    { checks: [{ source: 'SARS', amountFound: 4300, outcome: 'PASS' }] }
  );
  assert.equal(result.concerns.filter((c) => c.code === 'INCOME_MISMATCH').length, 0);
});

test('a check with no amount found raises nothing on its own', () => {
  const result = verification.assess(
    { totalHouseholdIncome: 2000 },
    { checks: [{ source: 'SASSA', amountFound: null, outcome: 'PASS' }] }
  );
  assert.equal(result.concerns.length, 0);
  assert.equal(result.highest, 'none');
});

test('a failed external check is raised', () => {
  const result = verification.assess(
    { totalHouseholdIncome: 1000 },
    { checks: [{ source: 'CREDIT_BUREAU', outcome: 'FAIL', findings: 'Active vehicle finance' }] }
  );
  assert.match(result.concerns[0].message, /CREDIT_BUREAU/);
  assert.match(result.concerns[0].message, /vehicle finance/);
});

test("household members' own income exceeding the declared total is raised", () => {
  const result = verification.assess(
    { totalHouseholdIncome: 1000 },
    { household: [{ monthlyIncome: 3000 }, { monthlyIncome: 2500 }] }
  );
  assert.ok(result.concerns.some((c) => c.code === 'HOUSEHOLD_INCOME_EXCEEDS_DECLARED'));
});

test('a household list shorter than the declared headcount is raised', () => {
  const result = verification.assess(
    { peopleOnProperty: 6, totalHouseholdIncome: 0 },
    { household: [{ monthlyIncome: 0 }, { monthlyIncome: 0 }] }
  );
  assert.ok(result.concerns.some((c) => c.code === 'HOUSEHOLD_INCOMPLETE'));
});

test('the applicant counts towards their own household headcount', () => {
  // Three listed members plus the applicant is four people. Declaring four must
  // not be reported as incomplete.
  const result = verification.assess(
    { peopleOnProperty: 4, totalHouseholdIncome: 0 },
    { household: [{}, {}, {}] }
  );
  assert.equal(result.concerns.filter((c) => c.code === 'HOUSEHOLD_INCOMPLETE').length, 0);
});

test('a declared second property is raised for a human to judge', () => {
  const result = verification.assess(
    { ownsOtherProperty: true, otherPropertyDetails: 'Inherited plot in Lusikisiki', totalHouseholdIncome: 0 },
    {}
  );
  const concern = result.concerns.find((c) => c.code === 'OTHER_PROPERTY');
  assert.ok(concern);
  // Not automatically disqualifying — an inherited plot with no services is not
  // wealth, so this must be a prompt and not a rejection.
  assert.equal(concern.severity, 'medium');
  assert.match(concern.message, /Confirm it does not disqualify/);
});

test('a tenant is flagged so rates relief is not granted to them', () => {
  const result = verification.assess({ tenure: 'TENANT', totalHouseholdIncome: 0 }, {});
  assert.ok(result.concerns.some((c) => c.code === 'TENANT'));
});

test('exhausted site visits are raised as a high concern', () => {
  const result = verification.assess(
    { totalHouseholdIncome: 0 },
    { siteVisits: visits('NO_ACCESS', 'NO_ACCESS', 'NO_ACCESS') }
  );
  assert.equal(result.concerns.find((c) => c.code === 'VISITS_EXHAUSTED').severity, 'high');
});

test('a clean application raises nothing', () => {
  const result = verification.assess(
    { totalHouseholdIncome: 2000, tenure: 'OWNER', ownsOtherProperty: false, peopleOnProperty: 3 },
    {
      checks: [{ source: 'SASSA', outcome: 'PASS', amountFound: 2000 }],
      siteVisits: visits('VERIFIED'),
      household: [{ monthlyIncome: 0 }, { monthlyIncome: 0 }],
    }
  );
  assert.deepEqual(result.concerns, []);
  assert.equal(result.highest, 'none');
  assert.equal(result.siteVerified, true);
});

test('outstanding work names what a thorough verification still needs', () => {
  const result = verification.assess({ totalHouseholdIncome: 0 }, {});
  assert.equal(result.outstanding.length, 3, 'site visit, SASSA, and SARS/UIF');
  assert.ok(result.outstanding.some((o) => /site visit/i.test(o)));
});

test('a completed verification has nothing outstanding', () => {
  const result = verification.assess(
    { totalHouseholdIncome: 0 },
    {
      siteVisits: visits('VERIFIED'),
      checks: [{ source: 'SASSA', outcome: 'PASS' }, { source: 'SARS', outcome: 'PASS' }],
    }
  );
  assert.deepEqual(result.outstanding, []);
});

// ---------------------------------------------------------------------------
// The enum lists mirrored in the route must match the schema
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');

/** Pull the members of one enum straight out of schema.prisma. */
function schemaEnum(name) {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'prisma', 'schema.prisma'), 'utf8');
  const block = new RegExp(`enum ${name} \{([^}]*)\}`).exec(schema);
  if (!block) throw new Error(`enum ${name} is not in schema.prisma`);
  return block[1]
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .filter(Boolean);
}

/**
 * A tripwire, not a style check.
 *
 * The verification routes keep their own copy of these values so an unrecognised
 * outcome is answered with a sentence rather than reaching Prisma and coming back
 * as "we could not save that — please try again", which is advice that can never
 * work. A copy is only safe while something notices it drifting: add a value to
 * the schema and forget the route, and officers get a 400 refusing a value the
 * database would happily have accepted.
 */
test('the visit outcomes the route accepts match the schema', () => {
  const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'verification.js'), 'utf8');
  const listed = /const VISIT_OUTCOMES = \[([^\]]*)\]/.exec(route)[1]
    .split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean);

  assert.deepEqual(listed.sort(), schemaEnum('SiteVisitOutcome').sort());
});

test('the check outcomes the route accepts match the schema', () => {
  const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'verification.js'), 'utf8');
  const listed = /const CHECK_OUTCOMES = \[([^\]]*)\]/.exec(route)[1]
    .split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean);

  assert.deepEqual(listed.sort(), schemaEnum('CheckOutcome').sort());
});
