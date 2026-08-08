const express = require('express');
const prisma = require('../lib/prisma');
const { protect, requireRole } = require('../middleware/auth');
const { staffLimiter } = require('../lib/rateLimit');
const cache = require('../lib/cache');
const audit = require('../lib/audit');
const chain = require('../lib/approvalChain');
const meansTest = require('../lib/meansTest');
const signature = require('../lib/signature');
const renewal = require('../lib/renewal');
const changeLog = require('../lib/changeLog');
const sanitize = require('../lib/sanitize');
const notify = require('../lib/notify');
const sms = require('../lib/sms');
const smsTemplates = require('../lib/smsTemplates');
const respond = require('../lib/respond');

/**
 * The approval chain.
 *
 * Three stages worked by three different people. This router is deliberately
 * one file rather than one per stage: the rules about who may act, what happens
 * next and what gets recorded are the same at every stage, and splitting them
 * would mean three places to forget the separation-of-duties check.
 *
 * Stage-specific work lives in its own library — the means test in
 * meansTest.js, the signature in signature.js — so what remains here is the
 * chain itself.
 */
const router = express.Router();
router.use(...protect, requireRole('VERIFICATION_OFFICER', 'ASSESSMENT_OFFICER', 'SUPERVISOR', 'ADMIN'), staffLimiter);
router.use(cache.invalidateOn(cache.TAGS.APPLICATIONS, cache.TAGS.ANALYTICS));

const actorName = (u) => [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email;

const FULL_INCLUDE = {
  household: { orderBy: { createdAt: 'asc' } },
  siteVisits: { orderBy: { attempt: 'asc' } },
  checks: { orderBy: { checkedAt: 'desc' } },
  approvalSteps: { orderBy: { sequence: 'asc' } },
  documents: { select: { id: true, name: true, type: true, status: true, importance: true, requirementGroup: true } },
  user: { select: { id: true, email: true, firstName: true, lastName: true, cellNumber: true } },
  capturedBy: { select: { id: true, firstName: true, lastName: true, ward: true } },
};

/**
 * Open a step when somebody starts working a stage.
 *
 * Recorded even if they walk away without deciding, because "this sat with
 * three different officers for a week" is exactly the kind of thing that is
 * invisible unless it is written down.
 */
async function openStep(application, user, client = prisma) {
  const existing = await client.approvalStep.findFirst({
    where: { applicationId: application.id, stage: application.approvalStage, outcome: 'PENDING' },
  });
  if (existing) return existing;

  const last = await client.approvalStep.findFirst({
    where: { applicationId: application.id },
    orderBy: { sequence: 'desc' },
    select: { sequence: true },
  });

  return client.approvalStep.create({
    data: {
      applicationId: application.id,
      stage: application.approvalStage,
      outcome: 'PENDING',
      sequence: (last?.sequence ?? 0) + 1,
      actorId: user.id,
      actorName: actorName(user),
      actorRole: user.role,
    },
  });
}

// ---------------------------------------------------------------------------
// Queues
// ---------------------------------------------------------------------------

/**
 * What is waiting at a stage.
 *
 * Defaults to the caller's own stage, so an assessment officer opening the page
 * sees assessment work without choosing anything. Oldest first, always — a
 * queue sorted newest-first is how applications rot at the bottom.
 */
router.get('/queue', respond.handler(async (req, res) => {
  const requested = sanitize.oneOf(req.query.stage, chain.STAGES);
  const stage = requested || chain.stageForRole(req.user.role) || 'VERIFICATION';
  const { page, take, skip } = sanitize.pagination(req.query, { defaultSize: 20 });
  const search = sanitize.searchTerm(req.query.search);

  const where = {
    status: 'PENDING',
    approvalStage: stage,
    ...(search
      ? {
          OR: [
            { reference: { contains: search, mode: 'insensitive' } },
            { surname: { contains: search, mode: 'insensitive' } },
            { names: { contains: search, mode: 'insensitive' } },
            { idNumber: { contains: search } },
          ],
        }
      : {}),
  };

  const [rows, total, byStage] = await Promise.all([
    prisma.application.findMany({
      where,
      select: {
        id: true, reference: true, names: true, surname: true, idNumber: true,
        submittedAt: true, approvalStage: true, wardNumber: true, applicantCategory: true,
        totalHouseholdIncome: true, peopleOnProperty: true, capturedById: true,
        meansTestResult: true, recommendation: true,
        approvalSteps: { select: { actorId: true, outcome: true, stage: true } },
      },
      orderBy: { submittedAt: 'asc' },
      skip,
      take,
    }),
    prisma.application.count({ where }),
    prisma.application.groupBy({
      by: ['approvalStage'],
      where: { status: 'PENDING' },
      _count: { _all: true },
    }),
  ]);

  const now = Date.now();
  res.json({
    success: true,
    data: rows.map(({ approvalSteps, ...a }) => {
      const prior = chain.priorInvolvement(a, req.user, approvalSteps);
      return {
        ...a,
        name: [a.names, a.surname].filter(Boolean).join(' ') || 'Unnamed',
        waitingDays: a.submittedAt ? Math.floor((now - new Date(a.submittedAt)) / 86400000) : null,
        // Said up front so somebody does not open a file only to be refused.
        canAct: prior.ok,
        blockedReason: prior.ok ? null : prior.reason,
      };
    }),
    pagination: { page, pageSize: take, total, totalPages: Math.ceil(total / take) || 1 },
    stage,
    stageLabel: chain.config(stage)?.label,
    stageQuestion: chain.config(stage)?.question,
    counts: Object.fromEntries(byStage.map((s) => [s.approvalStage, s._count._all])),
  });
}, 'approvals queue'));

/**
 * One application, with everything the current stage needs.
 *
 * The means test is computed live rather than read from the record, so an
 * officer always sees it against the household as it stands now — not as it was
 * when somebody last pressed save.
 */
router.get('/applications/:id', respond.handler(async (req, res) => {
  const application = await prisma.application.findUnique({
    where: { id: req.params.id },
    include: FULL_INCLUDE,
  });
  if (!application) return respond.notFound(res, 'We could not find that application.');

  await openStepIfMine(application, req.user);

  await audit.record(req, {
    action: audit.ACTIONS.VIEW_APPLICATION,
    entityType: 'Application',
    entityId: application.id,
    details: `Opened ${application.reference || application.id.slice(0, 8)} at ${application.approvalStage}`,
  });

  res.json({
    success: true,
    data: {
      ...application,
      position: chain.position(application, { steps: application.approvalSteps, user: req.user }),
      meansTest: meansTest.assess(application, {
        checks: application.checks,
        household: application.household,
      }),
      signatures: application.approvalSteps
        .filter((s) => s.signature)
        .map((s) => ({ ...signature.describe(s), image: s.signature, stage: s.stage })),
      renewal: {
        status: renewal.statusFor(application),
        expiresAt: application.expiresAt,
        daysRemaining: renewal.daysRemaining(application),
        validMonths: renewal.VALID_MONTHS,
      },
    },
  });
}, 'approvals detail'));

/** Only opens a step for the officer whose stage it is. */
async function openStepIfMine(application, user) {
  if (application.status !== 'PENDING') return;
  const stageConfig = chain.config(application.approvalStage);
  if (!stageConfig?.roles.includes(user.role)) return;
  if (!chain.priorInvolvement(application, user, application.approvalSteps).ok) return;
  await openStep(application, user);
}

// ---------------------------------------------------------------------------
// Acting on a stage
// ---------------------------------------------------------------------------

/**
 * Complete the current stage.
 *
 * One endpoint for all three stages, because the guards are identical and the
 * only difference is what the stage produces — a recommendation at verification
 * and assessment, a decision at sign-off.
 */
router.post('/applications/:id/decide', respond.handler(async (req, res) => {
  const application = await prisma.application.findUnique({
    where: { id: req.params.id },
    include: { approvalSteps: true, checks: true, household: true, user: { select: { cellNumber: true } } },
  });
  if (!application) return respond.notFound(res, 'We could not find that application.');

  const act = chain.canAct(application, req.user);
  if (!act.ok) return respond.badRequest(res, act.reason);

  const prior = chain.priorInvolvement(application, req.user, application.approvalSteps);
  if (!prior.ok) return respond.forbidden(res, prior.reason);

  const stageConfig = act.stage;
  const decision = sanitize.oneOf(req.body?.decision, ['APPROVE', 'REJECT']);
  const notes = sanitize.longText(req.body?.notes);

  if (!decision) return respond.badRequest(res, 'Please choose whether to approve or refuse.');
  if (decision === 'REJECT' && !notes) {
    return respond.badRequest(res, 'Please give your reasons for refusing.');
  }

  // The sign-off stage is the only one that needs a signature, and it needs one
  // every time — an unsigned approval is not an approval.
  let signatureFields = {};
  if (stageConfig.requiresSignature) {
    const check = signature.validate(req.body?.signature);
    if (!check.valid) return respond.badRequest(res, check.reason);
    signatureFields = {
      signature: req.body.signature,
      ...signature.context(req, req.user),
    };
  }

  const outcome = stageConfig.decides
    ? (decision === 'APPROVE' ? 'APPROVED' : 'REJECTED')
    : (decision === 'APPROVE' ? 'RECOMMEND_APPROVE' : 'RECOMMEND_REJECT');

  const applicationChange = chain.advance(application, { outcome, stage: application.approvalStage });

  // An approval starts the yearly clock. Doing it here rather than leaving it to
  // a later job means a registration can never exist without an expiry date.
  if (applicationChange.status === 'APPROVED') {
    const approvedAt = new Date();
    Object.assign(applicationChange, {
      approvedAt,
      expiresAt: renewal.expiryFrom(approvedAt),
      renewalStatus: 'ACTIVE',
      renewalNotifiedLevel: null,
      reviewedBy: req.user.id,
      reviewNotes: notes || undefined,
    });
  } else if (applicationChange.status === 'DECLINED') {
    Object.assign(applicationChange, { reviewedBy: req.user.id, reviewNotes: notes || undefined });
  }

  const { updated, step } = await prisma.$transaction(async (tx) => {
    const open = await openStep(application, req.user, tx);

    const completed = await tx.approvalStep.update({
      where: { id: open.id },
      data: {
        outcome,
        notes,
        decidedAt: new Date(),
        actorId: req.user.id,
        actorName: actorName(req.user),
        actorRole: req.user.role,
        ...signatureFields,
      },
    });

    const app = await tx.application.update({
      where: { id: application.id },
      data: applicationChange,
      include: { user: { select: { cellNumber: true } } },
    });

    return { updated: app, step: completed };
  });

  await changeLog.record(
    application.id,
    [{
      field: 'approvalStage',
      label: 'Approval stage',
      oldValue: application.approvalStage,
      newValue: updated.approvalStage,
    }],
    { req, stage: application.approvalStage }
  );

  await audit.record(req, {
    action: stageConfig.decides
      ? (decision === 'APPROVE' ? audit.ACTIONS.APPROVE_APPLICATION : audit.ACTIONS.DECLINE_APPLICATION)
      : audit.ACTIONS.RECOMMEND_APPLICATION,
    entityType: 'Application',
    entityId: application.id,
    details: `${stageConfig.label}: ${outcome}${notes ? ` — ${notes}` : ''}`,
  });

  await announce(updated, { stageConfig, outcome, notes, actor: req.user, step });

  res.json({
    success: true,
    message: stageConfig.decides
      ? `Signed off. The applicant has been told the outcome.`
      : `${stageConfig.label} complete. The application has moved to ${chain.config(stageConfig.next)?.label.toLowerCase()}.`,
    data: {
      ...updated,
      position: chain.position(updated, { steps: [...application.approvalSteps, step], user: req.user }),
    },
  });
}, 'approvals decide'));

/**
 * Send a file back.
 *
 * A return is a new step, not an erasure. A case that went round twice must
 * read as having gone round twice.
 */
router.post('/applications/:id/return', respond.handler(async (req, res) => {
  const application = await prisma.application.findUnique({
    where: { id: req.params.id },
    include: { approvalSteps: true, user: { select: { cellNumber: true } } },
  });
  if (!application) return respond.notFound(res, 'We could not find that application.');

  const act = chain.canAct(application, req.user);
  if (!act.ok) return respond.badRequest(res, act.reason);

  const toStage = sanitize.oneOf(req.body?.toStage, chain.returnableStages(application.approvalStage));
  const reason = sanitize.longText(req.body?.reason);

  if (!toStage) {
    return respond.badRequest(res, 'Choose which stage to send this back to.');
  }
  if (!reason) {
    return respond.badRequest(res, 'Please say what needs to be corrected before this can move forward.');
  }

  const { updated, step } = await prisma.$transaction(async (tx) => {
    const open = await openStep(application, req.user, tx);

    const completed = await tx.approvalStep.update({
      where: { id: open.id },
      data: {
        outcome: 'RETURNED',
        returnedTo: toStage,
        returnReason: reason,
        notes: reason,
        decidedAt: new Date(),
        actorId: req.user.id,
        actorName: actorName(req.user),
        actorRole: req.user.role,
      },
    });

    const app = await tx.application.update({
      where: { id: application.id },
      data: chain.returnTo(application.approvalStage, toStage),
    });

    return { updated: app, step: completed };
  });

  await audit.record(req, {
    action: audit.ACTIONS.RETURN_APPLICATION,
    entityType: 'Application',
    entityId: application.id,
    details: `Returned from ${application.approvalStage} to ${toStage}: ${reason}`,
  });

  // Sending a case backwards is the action most worth an administrator's
  // attention: it means something went wrong earlier in the chain.
  await tellAdmins(application, {
    actor: req.user,
    title: `Returned to ${chain.config(toStage)?.label.toLowerCase()}: ${application.reference || application.id.slice(0, 8)}`,
    body: `${actorName(req.user)} sent it back from ${chain.config(application.approvalStage)?.label.toLowerCase()} — ${reason}`,
  });

  // Whoever works the stage it went back to needs to know it has arrived.
  const targetRoles = chain.config(toStage)?.roles.filter((r) => r !== 'ADMIN') || [];
  const officers = await prisma.user.findMany({
    where: { role: { in: targetRoles }, isActive: true },
    select: { id: true },
  });
  for (const officer of officers) {
    await notify.toUser(officer.id, {
      type: notify.TYPE.RETURNED_FOR_REWORK,
      title: 'An application has been sent back to you',
      body: `${application.reference || application.id.slice(0, 8)} was returned by ${actorName(req.user)}: ${reason}`,
      link: `/approvals/${application.id}`,
      entityType: 'Application',
      entityId: application.id,
    });
  }

  res.json({
    success: true,
    message: `Returned to ${chain.config(toStage)?.label.toLowerCase()}. The officers there have been told.`,
    data: { ...updated, position: chain.position(updated, { steps: [...application.approvalSteps, step], user: req.user }) },
  });
}, 'approvals return'));

/**
 * Record the means test.
 *
 * Separate from the decision so an assessment officer can save their working
 * and come back to it. The figures are recomputed on save rather than trusted
 * from the client — a means test the browser could edit is not a means test.
 */
router.post('/applications/:id/assessment', requireRole('ASSESSMENT_OFFICER', 'ADMIN'), respond.handler(async (req, res) => {
  const application = await prisma.application.findUnique({
    where: { id: req.params.id },
    include: { checks: true, household: true, approvalSteps: true },
  });
  if (!application) return respond.notFound(res, 'We could not find that application.');

  if (application.approvalStage !== 'ASSESSMENT') {
    return respond.badRequest(res, 'This application is not at the assessment stage.');
  }

  const prior = chain.priorInvolvement(application, req.user, application.approvalSteps);
  if (!prior.ok) return respond.forbidden(res, prior.reason);

  const finding = meansTest.assess(application, {
    checks: application.checks,
    household: application.household,
  });

  const budgetConfirmed = sanitize.boolean(req.body?.budgetConfirmed);
  const before = { ...application };

  const data = {
    meansTestResult: finding.result,
    assessedIncome: finding.assessedIncome,
    assessedPerPerson: finding.perPerson,
    assessmentNotes: sanitize.longText(req.body?.assessmentNotes),
    assessedById: req.user.id,
    assessedAt: new Date(),
    incomeThresholdApplied: finding.threshold,
    ...(budgetConfirmed !== undefined ? { budgetConfirmed } : {}),
    budgetNotes: sanitize.longText(req.body?.budgetNotes),
  };

  const updated = await prisma.application.update({ where: { id: application.id }, data });
  await changeLog.track(application.id, before, data, { req, stage: 'ASSESSMENT' });

  await audit.record(req, {
    action: audit.ACTIONS.ASSESS_APPLICATION,
    entityType: 'Application',
    entityId: application.id,
    details: `Means test: ${finding.result} — ${meansTest.explain(finding)}`,
  });

  // The means test is where public money is committed or refused, so the result
  // goes to administrators whether or not the stage is completed afterwards.
  await tellAdmins(application, {
    actor: req.user,
    title: `Means test recorded: ${application.reference || application.id.slice(0, 8)}`,
    body: `${actorName(req.user)} assessed it as ${finding.result.toLowerCase().replace(/_/g, ' ')}. `
      + `${meansTest.explain(finding)}`,
  });

  res.json({
    success: true,
    message: 'Assessment saved. Complete the stage when you are ready to pass it on.',
    data: updated,
    meansTest: finding,
  });
}, 'approvals assessment'));

// ---------------------------------------------------------------------------
// Case history
// ---------------------------------------------------------------------------

/**
 * Everything that has happened to one application.
 *
 * The approval steps, every field anybody changed, and the audit entries, in one
 * timeline. This is the screen a municipality opens when the Auditor-General
 * asks how a decision was reached.
 */
router.get('/applications/:id/history', respond.handler(async (req, res) => {
  const application = await prisma.application.findUnique({
    where: { id: req.params.id },
    select: { id: true, reference: true, approvalStage: true, status: true },
  });
  if (!application) return respond.notFound(res, 'We could not find that application.');

  const [steps, changes, auditRows] = await Promise.all([
    prisma.approvalStep.findMany({
      where: { applicationId: application.id },
      orderBy: { sequence: 'asc' },
    }),
    changeLog.history(application.id),
    prisma.auditLog.findMany({
      where: { entityType: 'Application', entityId: application.id },
      orderBy: { createdAt: 'desc' },
      take: 200,
    }),
  ]);

  res.json({
    success: true,
    data: {
      application,
      steps: steps.map((s) => ({
        ...s,
        description: chain.describeStep(s),
        stageLabel: chain.config(s.stage)?.label || s.stage,
        signature: s.signature ? { ...signature.describe(s), image: s.signature } : null,
      })),
      changes,
      audit: auditRows,
      /** Everything merged, newest first, for a single readable column. */
      timeline: [
        ...steps.map((s) => ({
          at: s.decidedAt || s.startedAt,
          kind: 'step',
          who: s.actorName,
          role: s.actorRole,
          summary: chain.describeStep(s),
          detail: s.notes || s.returnReason || null,
        })),
        ...changes.map((c) => ({
          at: c.createdAt,
          kind: 'change',
          who: c.actorName,
          role: c.actorRole,
          summary: `${c.label} changed`,
          detail: `${c.oldValue ?? 'blank'} → ${c.newValue ?? 'blank'}`,
          sensitive: c.sensitive,
        })),
      ].sort((a, b) => new Date(b.at) - new Date(a.at)),
    },
  });
}, 'approvals history'));

// ---------------------------------------------------------------------------
// Notifications when a stage completes
// ---------------------------------------------------------------------------

/** Tell whoever needs to know that a stage finished. */
/**
 * Tell every administrator what just happened to an application.
 *
 * Administrators are accountable for the register as a whole but do not sit in
 * any one stage's queue, so without this the only way to learn that a supervisor
 * signed something off was to go looking. Every action in the chain — a
 * recommendation, an assessment, a sign-off, a refusal, a return — reaches them.
 *
 * `exceptUserId` skips the person who did it. An administrator acting in a stage
 * does not need telling about their own decision, and a notification that arrives
 * for your own click trains people to ignore the inbox.
 */
async function tellAdmins(application, { title, body, actor }) {
  await notify.toAdmins({
    type: notify.TYPE.APPROVAL_ACTIVITY,
    title,
    body,
    link: `/applications/${application.id}`,
    entityType: 'Application',
    entityId: application.id,
    exceptUserId: actor?.id,
  });
}

async function announce(application, { stageConfig, outcome, notes, actor, step }) {
  const ref = application.reference || application.id.slice(0, 8);

  /**
   * The oversight copy, sent on every action regardless of stage.
   *
   * Deliberately before the branch below: the decision path returns early, so
   * anything placed after it would only ever fire for the intermediate stages —
   * which are precisely the ones an administrator cares least about.
   */
  const outcomeWords = {
    APPROVED: 'approved it',
    REJECTED: 'refused it',
    RECOMMEND_APPROVE: 'recommended approval',
    RECOMMEND_REJECT: 'recommended refusal',
  };
  await tellAdmins(application, {
    actor,
    title: `${stageConfig.label}: ${ref}`,
    body: `${actorName(actor)} ${outcomeWords[outcome] || outcome.toLowerCase()}`
      + `${notes ? ` — ${notes}` : ''}.`,
  });

  // A decision reaches the applicant. A recommendation does not — telling
  // somebody they have been recommended for approval and then refusing them is
  // worse than telling them nothing.
  if (stageConfig.decides) {
    const approved = outcome === 'APPROVED';

    await notify.toUser(application.userId, {
      type: approved ? notify.TYPE.APPLICATION_APPROVED : notify.TYPE.APPLICATION_DECLINED,
      title: approved ? 'Your application was approved' : 'Your application was not approved',
      body: approved
        ? `Reference ${ref}. Your registration is valid until ${new Date(application.expiresAt).toLocaleDateString('en-ZA')}.`
        : `Reference ${ref}.${notes ? ` Reason: ${notes}` : ''}`,
      link: `/applications/${application.id}`,
      entityType: 'Application',
      entityId: application.id,
    });

    await sms.send(
      application.user?.cellNumber || application.cellNumber,
      smsTemplates.build(approved ? 'APPLICATION_APPROVED' : 'APPLICATION_DECLINED', { reference: ref, reason: notes }),
      {
        purpose: approved ? 'APPLICATION_APPROVED' : 'APPLICATION_DECLINED',
        userId: application.userId,
        entityType: 'Application',
        entityId: application.id,
      }
    );
    return;
  }

  // Otherwise the next stage's officers are the ones who need to know.
  const nextStage = chain.config(stageConfig.next);
  if (!nextStage) return;

  const officers = await prisma.user.findMany({
    where: { role: { in: nextStage.roles.filter((r) => r !== 'ADMIN') }, isActive: true },
    select: { id: true },
  });

  const type = stageConfig.next === 'ASSESSMENT'
    ? notify.TYPE.AWAITING_ASSESSMENT
    : notify.TYPE.AWAITING_SIGNOFF;

  for (const officer of officers) {
    await notify.toUser(officer.id, {
      type,
      title: `An application is ready for ${nextStage.label.toLowerCase()}`,
      body: `${ref} was passed on by ${actorName(actor)} with a recommendation to `
        + `${outcome === 'RECOMMEND_APPROVE' ? 'approve' : 'refuse'}.`,
      link: `/approvals/${application.id}`,
      entityType: 'Application',
      entityId: application.id,
    });
  }
}

module.exports = router;
