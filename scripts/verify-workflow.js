#!/usr/bin/env node
/**
 * Walk one application through the whole register, the way a household and five
 * officials actually would.
 *
 *     node scripts/verify-workflow.js                 # against http://localhost:5000
 *     API=http://localhost:5099/api node scripts/verify-workflow.js
 *
 * Run `node scripts/seed-demo-staff.js` first — this signs in as those accounts.
 *
 * ## Why this exists
 *
 * Every stage of the chain works in isolation and has unit tests. That is not
 * the same as the chain working: the failures that matter here are the ones
 * between stages — an application that submits into a stage no queue reads, a
 * separation-of-duties rule that fires on the wrong person, a decision that
 * advances the stage but forgets the expiry date. Only walking the whole thing
 * finds those.
 *
 * ## What it leaves behind
 *
 * One application, belonging to the demo applicant, fully approved. That is the
 * point — it is the record to open in the admin portal to see what a completed
 * case looks like. Nothing belonging to a real household is read or changed.
 */

const BASE = process.env.API || 'http://localhost:5000/api';
const PASSWORD = 'Demo@2026';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`   ok   ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const step = (title) => console.log(`\n${title}`);

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body is fine */ }
  return { status: res.status, data, message: data?.message };
}

/**
 * A real one-page PDF.
 *
 * The upload route sniffs the leading bytes rather than trusting the declared
 * content type, so a file of random bytes named ".pdf" is correctly rejected.
 * This is the smallest thing that genuinely is a PDF.
 */
function pdfBytes(label) {
  const body = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 60>>stream
BT /F1 12 Tf 20 50 Td (${label}) Tj ET
endstream endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
%%EOF`;
  return Buffer.from(body, 'latin1');
}

/**
 * Fill one slot on the checklist.
 *
 * `documentId` matters: it targets the seeded required slot. Uploading with only
 * a `type` is a different operation — it attaches an extra optional document and
 * deliberately leaves the required slot open, so that an applicant adding a
 * second payslip does not overwrite the first. The portal sends the slot id, so
 * this does too.
 */
async function upload(applicationId, token, slot) {
  const form = new FormData();
  form.append('file', new Blob([pdfBytes(`${slot.type} for the walkthrough`)], { type: 'application/pdf' }), `${slot.type.toLowerCase()}.pdf`);
  form.append('documentId', slot.id);
  form.append('type', slot.type);

  const res = await fetch(`${BASE}/documents/${applicationId}/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  return { ok: res.status === 200 || res.status === 201, detail: data?.message || `status ${res.status}` };
}

async function signIn(email) {
  const res = await call('POST', '/auth/login', { body: { email, password: PASSWORD } });
  if (!res.data?.data?.token) {
    throw new Error(`Could not sign in as ${email}: ${res.message || res.status}. Run scripts/seed-demo-staff.js first.`);
  }
  return { token: res.data.data.token, user: res.data.data.user };
}

/**
 * A household that should qualify.
 *
 * Deliberately well under the threshold and large enough that the per-person
 * test also passes, so a failure here means the chain is broken rather than the
 * means test correctly refusing.
 */
const HOUSEHOLD = {
  surname: 'Mthembu',
  names: 'Grace Nomsa',
  // Sequence digits below 5000, so the derived sex must come back FEMALE.
  idNumber: '8503124800081',
  cellNumber: '+27821110001',
  residentialAddress: '4512 Extension 3, Sebokeng',
  wardNumber: 'Ward 7',
  tenure: 'OWNER',
  municipalAccountNumber: '900123456',
  peopleOnProperty: 5,
  employmentStatus: 'UNEMPLOYED',
  totalHouseholdIncome: 3200,
  ownsOtherProperty: false,
  difficultySeeing: 'NO_DIFFICULTY',
  difficultyHearing: 'SOME_DIFFICULTY',
  difficultyWalking: 'NO_DIFFICULTY',
  difficultyRemembering: 'NO_DIFFICULTY',
  difficultySelfCare: 'NO_DIFFICULTY',
  difficultyCommunicating: 'NO_DIFFICULTY',
  // Legal preconditions for verification, not preferences. Without all three the
  // officer is correctly blocked from visiting or running an external check.
  consentSiteVisit: true,
  consentDataMatching: true,
  declarationTruthful: true,
};

async function main() {
  console.log(`\nWalking the whole workflow against ${BASE}`);

  // -------------------------------------------------------------------------
  step('1. Everybody signs in');
  const admin = await signIn('admin@demo.local');
  const councillor = await signIn('councillor@demo.local');
  const verifier = await signIn('verifier@demo.local');
  const assessor = await signIn('assessor@demo.local');
  const supervisor = await signIn('supervisor@demo.local');
  const applicant = await signIn('applicant@demo.local');
  check('all six roles can sign in', true, 'admin, councillor, verifier, assessor, supervisor, applicant');
  check('the token carries the role', admin.user.role === 'ADMIN', `admin token says ${admin.user.role}`);

  // -------------------------------------------------------------------------
  step('2. The applicant starts an application');
  /**
   * POST creates an empty draft seeded from the profile; the wizard fills it in
   * with PATCH. Reusing an existing draft rather than failing keeps the script
   * re-runnable, since only one draft per person is allowed.
   */
  const created = await call('POST', '/applications', { token: applicant.token, body: {} });
  const appId = created.data?.data?.id;
  check('a draft is created (or the open one is reused)', Boolean(appId),
    created.status === 201 ? 'new draft' : created.message);
  if (!appId) throw new Error(`No application id came back: ${JSON.stringify(created.data).slice(0, 300)}`);

  check('the checklist is seeded with it', (created.data.data.documents || []).length > 0,
    `${(created.data.data.documents || []).length} document slot(s)`);

  step('3. They fill it in');
  const filled = await call('PATCH', `/applications/${appId}`, { token: applicant.token, body: HOUSEHOLD });
  check('the form saves', filled.status === 200, filled.message || `status ${filled.status}`);

  const derived = filled.data?.data || {};
  check('date of birth was derived from the ID number', Boolean(derived.dateOfBirth),
    derived.dateOfBirth ? String(derived.dateOfBirth).slice(0, 10) : 'missing');
  check('sex was derived from the ID number', derived.sex === 'FEMALE', `got ${derived.sex}`);
  check('age was derived', typeof derived.age === 'number', `age ${derived.age}`);
  // Stored with the moment it was given: "did they agree" and "when" are
  // different questions, and only the second survives a dispute.
  check('consent is timestamped, not just ticked', Boolean(derived.consentGivenAt),
    derived.consentGivenAt ? String(derived.consentGivenAt).slice(0, 10) : 'no timestamp');

  await call('POST', `/applications/${appId}/household`, {
    token: applicant.token,
    body: { fullName: 'Sipho Mthembu', relationship: 'Son', age: 14, income: 0 },
  });
  const roll = await call('GET', `/applications/${appId}/household`, { token: applicant.token });
  check('a household member can be added', (roll.data?.data?.length || 0) >= 1,
    `${roll.data?.data?.length || 0} member(s) on the roll`);

  // -------------------------------------------------------------------------
  step('4. Supporting documents');
  // Submission is gated on the checklist, so this is part of the workflow rather
  // than setup. Any one of the three financial routes satisfies that group —
  // proof of grant is used here, which is the point of the group existing.
  const before = await call('POST', `/applications/${appId}/submit`, { token: applicant.token });
  check('it will not submit without documents', before.status === 400,
    before.message ? before.message.slice(0, 90) : `status ${before.status}`);

  const slots = (await call('GET', `/documents/${appId}`, { token: applicant.token })).data?.data || [];
  // Proof of ownership appears because the household said OWNER — the checklist
  // is conditional, so this is also a check that the condition fired.
  check('owning the property adds a proof of ownership slot',
    slots.some((d) => d.type === 'PROOF_OF_OWNERSHIP'),
    slots.filter((d) => d.importance === 'REQUIRED').map((d) => d.type).join(', ') || 'none marked required');

  for (const type of ['ID_COPY', 'AFFIDAVIT', 'PROOF_OF_OWNERSHIP', 'PROOF_OF_GRANT']) {
    const slot = slots.find((d) => d.type === type);
    if (!slot) { check(`${type} slot exists`, false, 'no such slot on the checklist'); continue; }
    const up = await upload(appId, applicant.token, slot);
    check(`${type.replace(/_/g, ' ').toLowerCase()} uploads`, up.ok, up.detail);
  }

  const after = (await call('GET', `/documents/${appId}`, { token: applicant.token })).data?.data || [];
  const supplied = after.filter((d) => d.status === 'Uploaded');
  check('the checklist records them as supplied', supplied.length >= 4, `${supplied.length} supplied`);
  // The whole point of the financial-evidence group: a proof of grant alone
  // satisfies it, without bank statements a household may not have.
  check('proof of grant alone satisfies the financial evidence',
    !after.some((d) => d.type === 'BANK_STATEMENTS' && d.status === 'Uploaded'),
    'no bank statement was supplied');

  // -------------------------------------------------------------------------
  step('5. The applicant submits it');
  const submitted = await call('POST', `/applications/${appId}/submit`, { token: applicant.token });
  check('it submits', submitted.status === 200, submitted.message || `status ${submitted.status}`);

  const afterSubmit = await call('GET', `/applications/${appId}`, { token: applicant.token });
  const state = afterSubmit.data?.data;
  check('status becomes PENDING', state?.status === 'PENDING', `status ${state?.status}`);
  // The bug this catches: submitting while leaving the stage at NOT_SUBMITTED,
  // which makes the application invisible to every approval queue.
  check('it enters the VERIFICATION stage', state?.approvalStage === 'VERIFICATION',
    `stage ${state?.approvalStage}`);
  check('a reference was issued', Boolean(state?.reference), state?.reference || 'none');

  // -------------------------------------------------------------------------
  step('6. It reaches the verification queue');
  const vQueue = await call('GET', '/verification/queue', { token: verifier.token });
  check('the verifier can see it', (vQueue.data?.data || []).some((a) => a.id === appId),
    `${(vQueue.data?.data || []).length} case(s) in the queue`);

  /**
   * The bad value goes first, deliberately.
   *
   * Recording a successful visit ends the visit sequence, so afterwards *every*
   * further attempt is refused with "already verified" — including an invalid
   * one, which would make this assertion pass without ever reaching the check it
   * is meant to be testing.
   */
  const badOutcome = await call('POST', `/verification/applications/${appId}/visits`, {
    token: verifier.token,
    body: { outcome: 'CONFIRMED' },
  });
  check('an unrecognised outcome is explained, not a server error',
    badOutcome.status === 400 && /not a visit outcome/.test(badOutcome.message || ''),
    badOutcome.message ? badOutcome.message.slice(0, 90) : `status ${badOutcome.status}`);

  const visit = await call('POST', `/verification/applications/${appId}/visits`, {
    token: verifier.token,
    body: { outcome: 'VERIFIED', visitedAt: new Date().toISOString(), findings: 'Household found at home, five people confirmed.' },
  });
  check('a site visit can be recorded', visit.status === 200 || visit.status === 201,
    visit.message || `status ${visit.status}`);

  const externalCheck = await call('POST', `/verification/applications/${appId}/checks`, {
    token: verifier.token,
    body: { source: 'SASSA', outcome: 'PASS', findings: 'Child support grant only.' },
  });
  check('an external check can be recorded', externalCheck.status === 200 || externalCheck.status === 201,
    externalCheck.message || `status ${externalCheck.status}`);

  const recommended = await call('POST', `/verification/applications/${appId}/recommend`, {
    token: verifier.token,
    body: { recommendation: 'APPROVE', notes: 'Declaration matches what was found on site.' },
  });
  check('the verifier can recommend', recommended.status === 200, recommended.message || `status ${recommended.status}`);

  const vDecide = await call('POST', `/approvals/applications/${appId}/decide`, {
    token: verifier.token,
    body: { decision: 'APPROVE', notes: 'Verified.' },
  });
  check('completing verification moves it on', vDecide.status === 200, vDecide.message || `status ${vDecide.status}`);
  check('the stage is now ASSESSMENT', vDecide.data?.data?.approvalStage === 'ASSESSMENT',
    `stage ${vDecide.data?.data?.approvalStage}`);

  // -------------------------------------------------------------------------
  step('7. Separation of duties holds');
  // The rule that matters: the person who verified must not also assess.
  const sameHands = await call('POST', `/approvals/applications/${appId}/decide`, {
    token: verifier.token,
    body: { decision: 'APPROVE', notes: 'Trying to do the next stage too.' },
  });
  check('the verifier cannot also assess', sameHands.status === 400 || sameHands.status === 403,
    `refused with ${sameHands.status}: ${sameHands.message}`);

  const applicantPeeking = await call('GET', '/approvals/queue', { token: applicant.token });
  check('an applicant cannot read the approval queue', applicantPeeking.status === 403,
    `status ${applicantPeeking.status}`);

  const councillorDeciding = await call('POST', `/approvals/applications/${appId}/decide`, {
    token: councillor.token,
    body: { decision: 'APPROVE' },
  });
  check('a councillor cannot decide', [400, 403].includes(councillorDeciding.status),
    `refused with ${councillorDeciding.status}`);

  // -------------------------------------------------------------------------
  step('8. The assessment officer applies the means test');
  const aQueue = await call('GET', '/approvals/queue', { token: assessor.token });
  check('it is in the assessor queue', (aQueue.data?.data || []).some((a) => a.id === appId),
    `${(aQueue.data?.data || []).length} case(s) waiting`);

  const assessment = await call('POST', `/approvals/applications/${appId}/assessment`, {
    token: assessor.token,
    body: { assessmentNotes: 'R3 200 across five people. Well under the threshold.', budgetConfirmed: true, budgetNotes: 'Within the ward allocation.' },
  });
  check('the means test runs', assessment.status === 200, assessment.message || `status ${assessment.status}`);
  check('it returns a result', Boolean(assessment.data?.meansTest?.result),
    `${assessment.data?.meansTest?.result} — per person R${assessment.data?.meansTest?.perPerson}`);
  check('the household qualifies', assessment.data?.meansTest?.result === 'QUALIFIES',
    `result ${assessment.data?.meansTest?.result}`);

  const aDecide = await call('POST', `/approvals/applications/${appId}/decide`, {
    token: assessor.token,
    body: { decision: 'APPROVE', notes: 'Means test passed.' },
  });
  check('completing assessment moves it on', aDecide.status === 200, aDecide.message || `status ${aDecide.status}`);
  check('the stage is now SUPERVISOR_SIGNOFF', aDecide.data?.data?.approvalStage === 'SUPERVISOR_SIGNOFF',
    `stage ${aDecide.data?.data?.approvalStage}`);

  // -------------------------------------------------------------------------
  step('9. The supervisor signs it off');
  const unsigned = await call('POST', `/approvals/applications/${appId}/decide`, {
    token: supervisor.token,
    body: { decision: 'APPROVE', notes: 'Approving without signing.' },
  });
  check('an unsigned sign-off is refused', unsigned.status === 400,
    `refused: ${unsigned.message}`);

  // A minimal but genuine PNG data URI, the shape signature_pad produces.
  const drawing = `data:image/png;base64,${'iVBORw0KGgoAAAANSUhEUgAAASwAAACWCAYAAABkW7XSAAA'.repeat(20)}`;
  const signed = await call('POST', `/approvals/applications/${appId}/decide`, {
    token: supervisor.token,
    body: { decision: 'APPROVE', notes: 'Approved and signed.', signature: drawing },
  });
  check('a signed sign-off is accepted', signed.status === 200, signed.message || `status ${signed.status}`);
  check('the application is APPROVED', signed.data?.data?.status === 'APPROVED',
    `status ${signed.data?.data?.status}`);
  check('the chain is COMPLETE', signed.data?.data?.approvalStage === 'COMPLETE',
    `stage ${signed.data?.data?.approvalStage}`);
  // An approval that never expires would quietly become a permanent entitlement.
  check('an expiry date was set', Boolean(signed.data?.data?.expiresAt),
    signed.data?.data?.expiresAt ? String(signed.data.data.expiresAt).slice(0, 10) : 'MISSING');
  check('it is marked for annual renewal', signed.data?.data?.renewalStatus === 'ACTIVE',
    `renewal ${signed.data?.data?.renewalStatus}`);

  // -------------------------------------------------------------------------
  step('10. The applicant can see the outcome');
  const mine = await call('GET', '/applications/mine', { token: applicant.token });
  const seen = (mine.data?.data || []).find((a) => a.id === appId);
  check('it appears in their list', Boolean(seen), seen ? `status ${seen.status}` : 'not found');

  const notes = await call('GET', '/notifications', { token: applicant.token });
  check('they were told it was approved',
    (notes.data?.data || []).some((n) => n.type === 'APPLICATION_APPROVED'),
    `${(notes.data?.data || []).length} notification(s)`);

  // -------------------------------------------------------------------------
  step('11. The case file reads as a full history');
  const history = await call('GET', `/approvals/applications/${appId}/history`, { token: admin.token });
  const steps = history.data?.data?.steps || history.data?.steps || [];
  check('every stage is recorded', steps.length >= 3, `${steps.length} step(s)`);
  check('each step names who did it',
    steps.length > 0 && steps.every((s) => s.actorName || s.actorRole),
    steps.map((s) => `${s.stage}:${s.actorRole || '?'}`).join(' → '));

  const signatureHeld = steps.find((s) => s.signature);
  check('the signature is stored against the sign-off', Boolean(signatureHeld),
    signatureHeld ? `signed by ${signatureHeld.actorName}` : 'no signature found');

  // -------------------------------------------------------------------------
  step('12. The councillor can register somebody else');
  const cell = `+2782${String(Date.now()).slice(-7)}`;
  const registered = await call('POST', '/fieldwork/households', {
    token: councillor.token,
    body: {
      firstName: 'Thabo', lastName: 'Radebe', cellNumber: cell,
      idNumber: `85031258000${String(Date.now()).slice(-2)}`,
    },
  });
  check('a councillor can register a resident', [200, 201].includes(registered.status),
    registered.message || `status ${registered.status}`);

  const residentId = registered.data?.data?.user?.id || registered.data?.data?.id;
  let captureId = null;
  if (residentId) {
    const capture = await call('POST', `/fieldwork/residents/${residentId}/applications`, {
      token: councillor.token,
      body: { ...HOUSEHOLD, surname: 'Radebe', names: 'Thabo', idNumber: `85031258000${String(Date.now()).slice(-2)}`, cellNumber: cell },
    });
    check('and capture an application for them', [200, 201].includes(capture.status),
      capture.message || `status ${capture.status}`);
    captureId = capture.data?.data?.id;
  }

  const captures = await call('GET', '/fieldwork/captures', { token: councillor.token });
  check('their own captures are listed', (captures.data?.data || []).length >= 1,
    `${(captures.data?.data || []).length} capture(s)`);

  const otherPeoplesWork = await call('GET', '/admin/applications', { token: councillor.token });
  check('a councillor cannot browse every application', otherPeoplesWork.status === 403,
    `status ${otherPeoplesWork.status}`);

  // -------------------------------------------------------------------------
  step('13. Admin oversight');
  const dash = await call('GET', '/admin/stats', { token: admin.token });
  check('the dashboard loads', dash.status === 200, dash.message || `status ${dash.status}`);

  const analytics = await call('GET', '/admin/analytics/full', { token: admin.token });
  check('analytics load', analytics.status === 200, analytics.message || `status ${analytics.status}`);

  const audit = await call('GET', '/admin/audit-logs', { token: admin.token });
  check('the audit log records the walkthrough', (audit.data?.data || []).length > 0,
    `${(audit.data?.data || []).length} entries visible`);

  const renewals = await call('GET', '/renewals', { token: admin.token });
  check('the renewal queue loads', renewals.status === 200, renewals.message || `status ${renewals.status}`);

  // The formatted export, not /admin/export/applications — that one returns JSON
  // rows for the on-screen table and has none of the CSV handling below.
  const csv = await fetch(`${BASE}/export/applications.csv`, { headers: { Authorization: `Bearer ${admin.token}` } });
  /**
   * Read the bytes, not the decoded text.
   *
   * `res.text()` strips the byte order mark while decoding, so checking the
   * string would report a missing BOM on a file that has one. Without it Excel
   * reads the file as the system codepage and mangles every non-ASCII name.
   */
  const csvBytes = Buffer.from(await csv.arrayBuffer());
  const csvText = csvBytes.toString('utf8').replace(/^﻿/, '');
  const rows = csvText.trim().split('\n').length - 1;
  check('the CSV export downloads', csv.status === 200 && rows > 0, `${rows} row(s)`);
  check('it opens as UTF-8 in Excel',
    csvBytes[0] === 0xef && csvBytes[1] === 0xbb && csvBytes[2] === 0xbf,
    'byte order mark present');
  check('the headers are readable', /Reference,Surname,First names/.test(csvText),
    'human column names, not field names');
  // Excel renders a bare 13-digit number as 9.20220E+12, which silently corrupts
  // every ID number in a file somebody is about to work from.
  check('ID numbers survive Excel', !csvText.includes(',8503124800081,'),
    'written as a forced-text formula');

  // -------------------------------------------------------------------------
  console.log(`\n${'-'.repeat(60)}`);
  console.log(`${pass} passed, ${fail} failed`);
  if (fail) {
    console.log('\nWhat broke:');
    failures.forEach((f) => console.log(`  - ${f}`));
  }
  console.log(`\nThe approved application is ${appId}`);
  if (captureId) console.log(`The councillor's capture is ${captureId}`);
  console.log('Open either in the admin portal to see the finished case file.\n');

  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`\nThe walkthrough stopped: ${error.message}\n`);
  process.exit(1);
});
