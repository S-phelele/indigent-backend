/**
 * The approval chain.
 *
 * An indigent subsidy is public money given away on the strength of a
 * declaration, so three different people look at it and each answers a
 * different question:
 *
 *   VERIFICATION       Is what they told us true?
 *                      Site visits, SASSA/SARS checks, documents.
 *                      → Verification Officer
 *
 *   ASSESSMENT         Do they qualify, and can we afford it?
 *                      The means test against the municipal income threshold,
 *                      and whether the indigent budget can carry the relief.
 *                      → Assessment Officer
 *
 *   SUPERVISOR_SIGNOFF Is the whole file sound, and will I put my name on it?
 *                      → Supervisor, with a drawn signature
 *
 * None of them can answer the next one's question, which is why the stages
 * exist. A verification officer knows whether the household is real; only the
 * assessment officer holds the threshold and the budget; only the supervisor
 * carries the accountability for the decision.
 *
 * ## Two rules that are not negotiable
 *
 * **Nobody acts twice on the same file.** Somebody who verified an application
 * cannot also assess it or sign it off. That is the entire point of a chain —
 * three signatures from one pair of hands is one signature wearing three hats.
 *
 * **Steps are appended, never rewritten.** Sending a case back creates a new
 * step; it does not erase the old one. A file that went round twice must read
 * as having gone round twice, because that is what an Auditor-General review
 * looks for and what a municipality otherwise cannot show.
 */

const STAGES = ['VERIFICATION', 'ASSESSMENT', 'SUPERVISOR_SIGNOFF', 'COMPLETE'];

/**
 * Who works each stage, and what the stage is for.
 *
 * ADMIN appears everywhere on purpose — an administrator must be able to move a
 * file that is stuck because somebody left, went on leave, or was never
 * appointed. Every such action is recorded with their name against it, so an
 * override is visible rather than invisible.
 */
const STAGE_CONFIG = {
  VERIFICATION: {
    key: 'VERIFICATION',
    label: 'Verification',
    question: 'Is what the household declared true?',
    roles: ['VERIFICATION_OFFICER', 'ADMIN'],
    /** What this stage produces: a recommendation, not a decision. */
    decides: false,
    next: 'ASSESSMENT',
    /** Where work at this stage lives in the portal. */
    route: '/verification',
  },
  ASSESSMENT: {
    key: 'ASSESSMENT',
    label: 'Assessment',
    question: 'Does the household qualify, and can the budget carry it?',
    roles: ['ASSESSMENT_OFFICER', 'ADMIN'],
    decides: false,
    next: 'SUPERVISOR_SIGNOFF',
    route: '/assessment',
  },
  SUPERVISOR_SIGNOFF: {
    key: 'SUPERVISOR_SIGNOFF',
    label: 'Supervisor sign-off',
    question: 'Is the file sound, and will I sign for it?',
    roles: ['SUPERVISOR', 'ADMIN'],
    /** The only stage that turns a recommendation into a decision. */
    decides: true,
    requiresSignature: true,
    next: 'COMPLETE',
    route: '/signoff',
  },
  COMPLETE: {
    key: 'COMPLETE',
    label: 'Complete',
    question: null,
    roles: [],
    decides: false,
    next: null,
    route: null,
  },
};

const ROLE_STAGE = {
  VERIFICATION_OFFICER: 'VERIFICATION',
  ASSESSMENT_OFFICER: 'ASSESSMENT',
  SUPERVISOR: 'SUPERVISOR_SIGNOFF',
};

/** The stage this role works, or null for roles that do not work the chain. */
const stageForRole = (role) => ROLE_STAGE[role] || null;

const config = (stage) => STAGE_CONFIG[stage] || null;

/** Stages a file can be sent back to from here. Never forward. */
function returnableStages(fromStage) {
  const index = STAGES.indexOf(fromStage);
  if (index <= 0) return [];
  return STAGES.slice(0, index);
}

/**
 * May this person act on this application right now?
 *
 * Returns a reason when they may not, phrased for the officer reading it.
 */
function canAct(application, user) {
  const stage = application.approvalStage;

  if (application.status !== 'PENDING') {
    return {
      ok: false,
      reason: application.status === 'DRAFT'
        ? 'This application has not been submitted yet.'
        : `This application has already been ${application.status.toLowerCase()}.`,
    };
  }

  const stageConfig = config(stage);
  if (!stageConfig || stage === 'COMPLETE') {
    return { ok: false, reason: 'This application is not waiting at any stage.' };
  }

  if (!stageConfig.roles.includes(user.role)) {
    return {
      ok: false,
      reason: `This application is waiting at ${stageConfig.label.toLowerCase()}, which is not your stage.`,
    };
  }

  return { ok: true, stage: stageConfig };
}

/**
 * Has this person already acted on this file at an earlier stage?
 *
 * The separation that matters most. Somebody who verified a household must not
 * then assess it or sign it off — three stages carried by one person is a
 * single decision with extra paperwork.
 *
 * Administrators are exempt, because an administrator overriding a stuck file
 * is a deliberate, recorded act rather than a way of quietly stacking roles.
 * Capture is checked separately, in applicationAccess.
 */
function priorInvolvement(application, user, steps = []) {
  if (user.role === 'ADMIN') return { ok: true };

  if (application.capturedById === user.id) {
    return {
      ok: false,
      reason: 'You captured this application, so you cannot also approve it.',
    };
  }

  const earlier = steps.find(
    (s) => s.actorId === user.id
      && s.stage !== application.approvalStage
      && s.outcome !== 'PENDING'
      && s.outcome !== 'RETURNED'
  );
  if (earlier) {
    return {
      ok: false,
      reason: `You already acted on this application at ${config(earlier.stage)?.label.toLowerCase() || earlier.stage}. `
        + 'A colleague must take this stage.',
    };
  }

  return { ok: true };
}

/**
 * Everything a caller needs to know about where a file stands.
 *
 * Deliberately returns the whole picture rather than a boolean, so an interface
 * can explain *why* somebody cannot act instead of just disabling a button.
 */
function position(application, { steps = [], user = null } = {}) {
  const stage = application.approvalStage;
  const stageConfig = config(stage);

  const completed = STAGES.slice(0, STAGES.indexOf(stage)).filter((s) => s !== 'COMPLETE');

  const out = {
    stage,
    label: stageConfig?.label || stage,
    question: stageConfig?.question || null,
    stepNumber: Math.max(1, STAGES.indexOf(stage) + 1),
    totalSteps: STAGES.length - 1,
    completedStages: completed,
    nextStage: stageConfig?.next || null,
    requiresSignature: Boolean(stageConfig?.requiresSignature),
    decides: Boolean(stageConfig?.decides),
    returnableTo: returnableStages(stage),
    /** The whole trail, oldest first, for display. */
    history: [...steps].sort((a, b) => a.sequence - b.sequence),
  };

  if (user) {
    const act = canAct(application, user);
    const prior = priorInvolvement(application, user, steps);
    out.canAct = act.ok && prior.ok;
    out.blockedReason = act.ok ? (prior.ok ? null : prior.reason) : act.reason;
    out.isMyStage = stageConfig?.roles.includes(user.role) || false;
  }

  return out;
}

/**
 * The application fields to write when a stage is completed.
 *
 * Returns only the change; the caller writes it together with the step row so
 * the position and its history can never disagree.
 */
function advance(application, { outcome, stage }) {
  const stageConfig = config(stage);

  if (outcome === 'RETURNED') {
    // Handled by returnTo — a return is not an advance.
    throw new Error('[approvalChain] use returnTo for a RETURNED outcome');
  }

  // Only the deciding stage changes the application's status.
  if (stageConfig.decides) {
    const approved = outcome === 'APPROVED';
    return {
      approvalStage: 'COMPLETE',
      status: approved ? 'APPROVED' : 'DECLINED',
      reviewedAt: new Date(),
      verificationStage: 'COMPLETE',
    };
  }

  return { approvalStage: stageConfig.next };
}

/** The change to write when a file is sent back. */
function returnTo(fromStage, toStage) {
  if (!returnableStages(fromStage).includes(toStage)) {
    throw new Error(`[approvalChain] cannot return from ${fromStage} to ${toStage}`);
  }
  return { approvalStage: toStage };
}

/** A one-line summary of a step, for a timeline. */
function describeStep(step) {
  const stage = config(step.stage)?.label || step.stage;
  const who = step.actorName || 'A municipal official';

  switch (step.outcome) {
    case 'RECOMMEND_APPROVE': return `${who} completed ${stage.toLowerCase()} and recommended approval`;
    case 'RECOMMEND_REJECT': return `${who} completed ${stage.toLowerCase()} and recommended refusal`;
    case 'APPROVED': return `${who} signed the application off as approved`;
    case 'REJECTED': return `${who} signed the application off as declined`;
    case 'RETURNED': return `${who} returned the application to ${config(step.returnedTo)?.label.toLowerCase() || step.returnedTo}`;
    default: return `${who} opened ${stage.toLowerCase()}`;
  }
}

/**
 * The whole history of a case, ready to render.
 *
 * Every screen that shows an application needs the same three answers about each
 * step — who acted, what they decided, and why — and until this existed each one
 * assembled them differently, or not at all. The administrator's view showed no
 * approvals whatsoever, so the half of the record the municipality is actually
 * accountable for was invisible on the screen an audit would open first.
 *
 * `why` is the part that matters and the part most easily lost. An outcome with
 * no reason is not a decision anybody can defend, so the officer's notes are
 * carried through verbatim rather than summarised, and a return carries the
 * reason it was sent back.
 *
 * Steps that are open but undecided are included deliberately: "this has been
 * sitting with an assessment officer since Tuesday" is exactly what somebody
 * asking about a delay needs to see.
 */
function describeTrail(steps = []) {
  return [...steps]
    .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
    .map((step) => {
      const stageConfig = config(step.stage);
      const decided = Boolean(step.decidedAt);

      return {
        id: step.id,
        sequence: step.sequence,
        stage: step.stage,
        stageLabel: stageConfig?.label || step.stage,

        outcome: step.outcome,
        outcomeLabel: OUTCOME_LABEL[step.outcome] || step.outcome,
        /** Green, amber or red, so the shape carries the outcome as well as the word. */
        tone: OUTCOME_TONE[step.outcome] || 'neutral',

        // Denormalised on the step, so the trail survives the account being
        // deleted — which is the point at which a name is most needed.
        who: step.actorName || 'A municipal official',
        role: step.actorRole ? humanRole(step.actorRole) : null,

        why: step.notes || step.returnReason || null,
        returnedTo: step.returnedTo ? (config(step.returnedTo)?.label || step.returnedTo) : null,

        startedAt: step.startedAt,
        decidedAt: step.decidedAt,
        decided,
        /** How long this stage held the case; null while it still has it. */
        daysTaken: decided && step.startedAt
          ? Math.max(0, Math.round((new Date(step.decidedAt) - new Date(step.startedAt)) / 86400000))
          : null,

        signed: Boolean(step.signature),
        signatureName: step.signatureName || null,
        signedAt: step.signedAt || null,

        sentence: describeStep(step),
      };
    });
}

const OUTCOME_LABEL = {
  PENDING: 'In progress',
  RECOMMEND_APPROVE: 'Recommended approval',
  RECOMMEND_REJECT: 'Recommended refusal',
  APPROVED: 'Approved',
  REJECTED: 'Refused',
  RETURNED: 'Sent back',
};

const OUTCOME_TONE = {
  PENDING: 'pending',
  RECOMMEND_APPROVE: 'approved',
  RECOMMEND_REJECT: 'declined',
  APPROVED: 'approved',
  REJECTED: 'declined',
  RETURNED: 'draft',
};

const humanRole = (role) => String(role).replace(/_/g, ' ').toLowerCase()
  .replace(/^./, (c) => c.toUpperCase());

module.exports = {
  STAGES,
  STAGE_CONFIG,
  ROLE_STAGE,
  OUTCOME_LABEL,
  OUTCOME_TONE,
  stageForRole,
  config,
  canAct,
  priorInvolvement,
  position,
  advance,
  returnTo,
  returnableStages,
  describeStep,
  describeTrail,
};
