const test = require('node:test');
const assert = require('node:assert/strict');

const chain = require('../src/lib/approvalChain');

const app = (over = {}) => ({
  id: 'a1', status: 'PENDING', approvalStage: 'VERIFICATION', capturedById: null, ...over,
});
const user = (role, id = 'u1') => ({ id, role, firstName: 'Test', lastName: 'User', email: 't@x.gov.za' });

// ---------------------------------------------------------------------------
// The chain itself
// ---------------------------------------------------------------------------

test('the chain runs verification, then assessment, then sign-off', () => {
  assert.equal(chain.config('VERIFICATION').next, 'ASSESSMENT');
  assert.equal(chain.config('ASSESSMENT').next, 'SUPERVISOR_SIGNOFF');
  assert.equal(chain.config('SUPERVISOR_SIGNOFF').next, 'COMPLETE');
});

test('only the sign-off stage decides', () => {
  assert.equal(chain.config('VERIFICATION').decides, false);
  assert.equal(chain.config('ASSESSMENT').decides, false);
  assert.equal(chain.config('SUPERVISOR_SIGNOFF').decides, true);
});

test('only the sign-off stage requires a signature', () => {
  assert.ok(!chain.config('VERIFICATION').requiresSignature);
  assert.ok(!chain.config('ASSESSMENT').requiresSignature);
  assert.equal(chain.config('SUPERVISOR_SIGNOFF').requiresSignature, true);
});

test('each role works exactly one stage', () => {
  assert.equal(chain.stageForRole('VERIFICATION_OFFICER'), 'VERIFICATION');
  assert.equal(chain.stageForRole('ASSESSMENT_OFFICER'), 'ASSESSMENT');
  assert.equal(chain.stageForRole('SUPERVISOR'), 'SUPERVISOR_SIGNOFF');
  assert.equal(chain.stageForRole('COUNCILLOR'), null);
  assert.equal(chain.stageForRole('APPLICANT'), null);
});

// ---------------------------------------------------------------------------
// Who may act
// ---------------------------------------------------------------------------

test('the right officer may act at their own stage', () => {
  assert.equal(chain.canAct(app({ approvalStage: 'VERIFICATION' }), user('VERIFICATION_OFFICER')).ok, true);
  assert.equal(chain.canAct(app({ approvalStage: 'ASSESSMENT' }), user('ASSESSMENT_OFFICER')).ok, true);
  assert.equal(chain.canAct(app({ approvalStage: 'SUPERVISOR_SIGNOFF' }), user('SUPERVISOR')).ok, true);
});

test('an officer may not act at somebody else’s stage', () => {
  // A supervisor cannot sign off something still being verified — the stages
  // exist precisely so that they are worked in order.
  const result = chain.canAct(app({ approvalStage: 'VERIFICATION' }), user('SUPERVISOR'));
  assert.equal(result.ok, false);
  assert.match(result.reason, /not your stage/i);
});

test('an assessment officer cannot sign off', () => {
  assert.equal(chain.canAct(app({ approvalStage: 'SUPERVISOR_SIGNOFF' }), user('ASSESSMENT_OFFICER')).ok, false);
});

test('an administrator may act at every stage', () => {
  for (const stage of ['VERIFICATION', 'ASSESSMENT', 'SUPERVISOR_SIGNOFF']) {
    assert.equal(chain.canAct(app({ approvalStage: stage }), user('ADMIN')).ok, true, stage);
  }
});

test('a councillor may not act at any stage', () => {
  for (const stage of ['VERIFICATION', 'ASSESSMENT', 'SUPERVISOR_SIGNOFF']) {
    assert.equal(chain.canAct(app({ approvalStage: stage }), user('COUNCILLOR')).ok, false, stage);
  }
});

test('a draft is not waiting at any stage', () => {
  const result = chain.canAct(app({ status: 'DRAFT', approvalStage: 'NOT_SUBMITTED' }), user('VERIFICATION_OFFICER'));
  assert.equal(result.ok, false);
  assert.match(result.reason, /not been submitted/i);
});

test('a decided application cannot be acted on again', () => {
  const result = chain.canAct(app({ status: 'APPROVED', approvalStage: 'COMPLETE' }), user('SUPERVISOR'));
  assert.equal(result.ok, false);
  assert.match(result.reason, /already been approved/i);
});

// ---------------------------------------------------------------------------
// Separation of duties — the rule the whole chain exists for
// ---------------------------------------------------------------------------

test('one person cannot work two stages of the same file', () => {
  const steps = [
    { stage: 'VERIFICATION', actorId: 'officer-1', outcome: 'RECOMMEND_APPROVE' },
  ];
  const result = chain.priorInvolvement(
    app({ approvalStage: 'ASSESSMENT' }),
    user('ASSESSMENT_OFFICER', 'officer-1'),
    steps
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /already acted/i);
  assert.match(result.reason, /colleague/i);
});

test('a different person at the next stage is fine', () => {
  const steps = [{ stage: 'VERIFICATION', actorId: 'officer-1', outcome: 'RECOMMEND_APPROVE' }];
  const result = chain.priorInvolvement(
    app({ approvalStage: 'ASSESSMENT' }),
    user('ASSESSMENT_OFFICER', 'officer-2'),
    steps
  );
  assert.equal(result.ok, true);
});

test('whoever captured the application cannot approve it', () => {
  const result = chain.priorInvolvement(
    app({ capturedById: 'officer-1' }),
    user('VERIFICATION_OFFICER', 'officer-1'),
    []
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /captured/i);
});

test('an open step at the current stage does not block the same person', () => {
  // Opening a file and coming back to it must not lock somebody out of their
  // own work.
  const steps = [{ stage: 'ASSESSMENT', actorId: 'officer-1', outcome: 'PENDING' }];
  const result = chain.priorInvolvement(
    app({ approvalStage: 'ASSESSMENT' }),
    user('ASSESSMENT_OFFICER', 'officer-1'),
    steps
  );
  assert.equal(result.ok, true);
});

test('having returned a file earlier does not bar somebody from it later', () => {
  // Sending something back is not deciding it, so the person who asked for a
  // correction may still handle it when it comes back.
  const steps = [{ stage: 'ASSESSMENT', actorId: 'officer-1', outcome: 'RETURNED' }];
  const result = chain.priorInvolvement(
    app({ approvalStage: 'ASSESSMENT' }),
    user('ASSESSMENT_OFFICER', 'officer-1'),
    steps
  );
  assert.equal(result.ok, true);
});

test('an administrator is exempt from the prior-involvement rule', () => {
  const steps = [{ stage: 'VERIFICATION', actorId: 'admin-1', outcome: 'RECOMMEND_APPROVE' }];
  assert.equal(
    chain.priorInvolvement(app({ approvalStage: 'ASSESSMENT', capturedById: 'admin-1' }), user('ADMIN', 'admin-1'), steps).ok,
    true
  );
});

// ---------------------------------------------------------------------------
// Advancing and returning
// ---------------------------------------------------------------------------

test('completing verification moves the file to assessment, not to a decision', () => {
  const change = chain.advance(app(), { outcome: 'RECOMMEND_APPROVE', stage: 'VERIFICATION' });
  assert.equal(change.approvalStage, 'ASSESSMENT');
  assert.equal(change.status, undefined, 'a recommendation must not decide the application');
});

test('completing assessment moves the file to sign-off', () => {
  const change = chain.advance(app(), { outcome: 'RECOMMEND_APPROVE', stage: 'ASSESSMENT' });
  assert.equal(change.approvalStage, 'SUPERVISOR_SIGNOFF');
  assert.equal(change.status, undefined);
});

test('signing off approves the application', () => {
  const change = chain.advance(app(), { outcome: 'APPROVED', stage: 'SUPERVISOR_SIGNOFF' });
  assert.equal(change.status, 'APPROVED');
  assert.equal(change.approvalStage, 'COMPLETE');
  assert.ok(change.reviewedAt instanceof Date);
});

test('signing off against approval declines it', () => {
  const change = chain.advance(app(), { outcome: 'REJECTED', stage: 'SUPERVISOR_SIGNOFF' });
  assert.equal(change.status, 'DECLINED');
  assert.equal(change.approvalStage, 'COMPLETE');
});

test('a file can only be sent backwards, never forwards', () => {
  assert.deepEqual(chain.returnableStages('VERIFICATION'), []);
  assert.deepEqual(chain.returnableStages('ASSESSMENT'), ['VERIFICATION']);
  assert.deepEqual(chain.returnableStages('SUPERVISOR_SIGNOFF'), ['VERIFICATION', 'ASSESSMENT']);
});

test('returning to a later stage is refused', () => {
  assert.throws(() => chain.returnTo('VERIFICATION', 'ASSESSMENT'), /cannot return/);
  assert.throws(() => chain.returnTo('ASSESSMENT', 'SUPERVISOR_SIGNOFF'), /cannot return/);
});

test('returning to an earlier stage moves the file there', () => {
  assert.deepEqual(chain.returnTo('SUPERVISOR_SIGNOFF', 'VERIFICATION'), { approvalStage: 'VERIFICATION' });
});

test('advance refuses to handle a return', () => {
  assert.throws(() => chain.advance(app(), { outcome: 'RETURNED', stage: 'ASSESSMENT' }), /use returnTo/);
});

// ---------------------------------------------------------------------------
// Position, as the interface sees it
// ---------------------------------------------------------------------------

test('position reports where a file is and what remains', () => {
  const p = chain.position(app({ approvalStage: 'ASSESSMENT' }), { user: user('ASSESSMENT_OFFICER') });
  assert.equal(p.stage, 'ASSESSMENT');
  assert.equal(p.label, 'Assessment');
  assert.equal(p.stepNumber, 2);
  assert.equal(p.totalSteps, 3);
  assert.deepEqual(p.completedStages, ['VERIFICATION']);
  assert.equal(p.canAct, true);
  assert.equal(p.isMyStage, true);
});

test('position explains why somebody cannot act rather than just refusing', () => {
  const p = chain.position(app({ approvalStage: 'VERIFICATION' }), { user: user('SUPERVISOR') });
  assert.equal(p.canAct, false);
  assert.ok(p.blockedReason, 'a blocked user must be told why');
  assert.equal(p.isMyStage, false);
});

test('position surfaces the prior-involvement block with its reason', () => {
  const steps = [{ stage: 'VERIFICATION', actorId: 'u1', outcome: 'RECOMMEND_APPROVE', sequence: 1 }];
  const p = chain.position(app({ approvalStage: 'ASSESSMENT' }), { steps, user: user('ASSESSMENT_OFFICER', 'u1') });
  assert.equal(p.canAct, false);
  assert.match(p.blockedReason, /already acted/i);
});

test('history is returned in the order it happened', () => {
  const steps = [
    { stage: 'ASSESSMENT', sequence: 2, outcome: 'RECOMMEND_APPROVE' },
    { stage: 'VERIFICATION', sequence: 1, outcome: 'RECOMMEND_APPROVE' },
  ];
  const p = chain.position(app(), { steps });
  assert.deepEqual(p.history.map((s) => s.sequence), [1, 2]);
});

test('every step describes itself in words a person can read', () => {
  const cases = [
    ['RECOMMEND_APPROVE', /recommended approval/],
    ['RECOMMEND_REJECT', /recommended refusal/],
    ['APPROVED', /signed the application off as approved/],
    ['REJECTED', /signed the application off as declined/],
  ];
  for (const [outcome, pattern] of cases) {
    const text = chain.describeStep({ stage: 'ASSESSMENT', outcome, actorName: 'T. Dlamini' });
    assert.match(text, pattern, outcome);
    assert.match(text, /T\. Dlamini/);
  }
});

test('a return names where it went back to', () => {
  const text = chain.describeStep({
    stage: 'SUPERVISOR_SIGNOFF', outcome: 'RETURNED', returnedTo: 'VERIFICATION', actorName: 'M. Nkosi',
  });
  assert.match(text, /returned the application to verification/i);
});

test('an unnamed actor still reads as somebody', () => {
  const text = chain.describeStep({ stage: 'ASSESSMENT', outcome: 'APPROVED', actorName: null });
  assert.match(text, /A municipal official/);
});
