/**
 * Application stage history.
 *
 * Applicants could previously see only a status badge — "Pending" tells someone
 * waiting on a municipal decision almost nothing. This builds the journey from
 * facts already on the record (timestamps, document states) plus the audit trail,
 * so the applicant can see where their application is and what happens next.
 *
 * Stages are derived rather than stored: there is no separate state table to
 * drift out of sync with the application itself.
 */

const STAGE = {
  STARTED: 'STARTED',
  DETAILS: 'DETAILS',
  DOCUMENTS: 'DOCUMENTS',
  SUBMITTED: 'SUBMITTED',
  REVIEW: 'REVIEW',
  DECISION: 'DECISION',
};

/** Audit actions an applicant is allowed to see on their own application. */
const APPLICANT_VISIBLE_ACTIONS = new Set([
  'APPROVE_APPLICATION',
  'DECLINE_APPLICATION',
  'REJECT_DOCUMENT',
  'ACCEPT_DOCUMENT',
]);

const EVENT_COPY = {
  APPROVE_APPLICATION: 'Application approved',
  DECLINE_APPLICATION: 'Application not approved',
  REJECT_DOCUMENT: 'A document was rejected and needs replacing',
  ACCEPT_DOCUMENT: 'A previously rejected document was accepted',
  VIEW_APPLICATION: 'Opened by a municipal official',
};

function documentProgress(documents = []) {
  const required = documents.filter((d) => d.importance === 'REQUIRED');
  const uploaded = required.filter((d) => d.status === 'Uploaded');
  const rejected = documents.filter((d) => d.status === 'Rejected');
  return { required: required.length, uploaded: uploaded.length, rejected: rejected.length };
}

/**
 * Build the stage list.
 *
 * `state` is one of done | current | upcoming | blocked. A stage is `blocked`
 * when something is actively waiting on the applicant — that is the signal the
 * dashboard uses to tell them what to do next.
 */
function stages(application) {
  const docs = documentProgress(application.documents);
  const status = application.status;
  const step = application.currentStep || 1;

  const detailsComplete = Boolean(application.surname && application.idNumber && application.cellNumber);
  const documentsComplete = docs.required > 0 && docs.uploaded === docs.required;
  const submitted = Boolean(application.submittedAt);
  const decided = status === 'APPROVED' || status === 'DECLINED';

  const list = [
    {
      key: STAGE.STARTED,
      label: 'Application started',
      description: 'You began an application.',
      at: application.createdAt,
      state: 'done',
    },
    {
      key: STAGE.DETAILS,
      label: 'Your details',
      description: detailsComplete
        ? 'Personal, property, income and general information captured.'
        : `Step ${Math.min(step, 4)} of 4 — surname, ID number and cell number are required.`,
      at: detailsComplete ? application.updatedAt : null,
      state: detailsComplete ? 'done' : submitted ? 'done' : 'current',
    },
    {
      key: STAGE.DOCUMENTS,
      label: 'Supporting documents',
      description: docs.rejected > 0
        ? `${docs.rejected} document${docs.rejected === 1 ? '' : 's'} rejected and must be replaced.`
        : documentsComplete
          ? `All ${docs.required} required documents uploaded.`
          : `${docs.uploaded} of ${docs.required} required documents uploaded.`,
      at: documentsComplete ? application.updatedAt : null,
      state: docs.rejected > 0
        ? 'blocked'
        : documentsComplete
          ? 'done'
          : detailsComplete && !submitted
            ? 'current'
            : submitted ? 'done' : 'upcoming',
    },
    {
      key: STAGE.SUBMITTED,
      label: 'Submitted',
      description: submitted
        ? 'Your application was sent to the municipality.'
        : 'Send your application once every required document is uploaded.',
      at: application.submittedAt,
      state: submitted ? 'done' : documentsComplete && detailsComplete ? 'current' : 'upcoming',
    },
    /**
     * The approval chain, one row per stage.
     *
     * This used to be a single "Municipal review" step, which told an applicant
     * only that their application was somewhere inside the municipality. Three
     * rows means somebody waiting can see it has moved — verification finished,
     * now with an assessment officer — which is the difference between a system
     * that feels stalled and one that is visibly working.
     *
     * Officers are never named. The applicant is told the stage and nothing about
     * who holds it; `events()` applies the same rule to the audit trail.
     */
    ...approvalStages(application, { submitted, decided }),
    {
      key: STAGE.DECISION,
      label: 'Outcome',
      description: status === 'APPROVED'
        ? 'Approved — the discount will be applied to your municipal account.'
        : status === 'DECLINED'
          ? 'Not approved. See the reviewer notes below.'
          : 'You will be told the outcome once a decision is made.',
      at: application.reviewedAt,
      state: decided ? 'done' : 'upcoming',
      outcome: decided ? status : null,
    },
  ];

  return list;
}

/**
 * The three approval stages as an applicant may see them.
 *
 * Described by what is happening to their application rather than by the
 * municipality's internal vocabulary: "somebody is checking what you told us" is
 * the same event as VERIFICATION, and only one of those means anything to a
 * household.
 *
 * A stage the application has already passed is `done`, the one holding it is
 * `current`, the rest are `upcoming`. Dates come from the approval steps where
 * they exist, so "verification finished on Tuesday" is real rather than implied.
 */
function approvalStages(application, { submitted, decided }) {
  const ORDER = ['VERIFICATION', 'ASSESSMENT', 'SUPERVISOR_SIGNOFF'];

  const COPY = {
    VERIFICATION: {
      label: 'Checking your details',
      waiting: 'An officer is confirming what you told us, and may visit the property.',
      done: 'Your details were checked and confirmed.',
      upcoming: 'An officer will confirm what you told us.',
    },
    ASSESSMENT: {
      label: 'Working out if you qualify',
      waiting: 'Your household income is being measured against the municipal threshold.',
      done: 'Your household income was assessed.',
      upcoming: 'Your household income will be measured against the municipal threshold.',
    },
    SUPERVISOR_SIGNOFF: {
      label: 'Final sign-off',
      waiting: 'A supervisor is making the final decision.',
      done: 'A supervisor signed the decision.',
      upcoming: 'A supervisor makes the final decision.',
    },
  };

  const steps = Array.isArray(application.approvalSteps) ? application.approvalSteps : [];
  const stage = application.approvalStage;
  const reached = ORDER.indexOf(stage);

  return ORDER.map((key, i) => {
    // The most recent decided step for this stage, so a case that looped shows
    // the outcome that stuck rather than the first attempt.
    const step = [...steps]
      .filter((s) => s.stage === key && s.decidedAt)
      .sort((a, b) => new Date(b.decidedAt) - new Date(a.decidedAt))[0];

    // Once decided, everything is behind us; otherwise position in the chain.
    const passed = decided || (reached >= 0 && i < reached) || Boolean(step);
    const current = !decided && reached === i;

    /**
     * Being here now beats having been here before.
     *
     * An application sent back to an earlier stage has a decided step for it
     * already, so testing `passed` first would show the stage holding the case
     * as finished — telling a household their details were checked while an
     * officer is in the middle of checking them again.
     */
    const state = !submitted ? 'upcoming' : current ? 'current' : passed ? 'done' : 'upcoming';

    return {
      key: `APPROVAL_${key}`,
      label: COPY[key].label,
      description: state === 'done' ? COPY[key].done
        : state === 'current' ? COPY[key].waiting
          : COPY[key].upcoming,
      at: step?.decidedAt ?? null,
      state,
    };
  });
}

/** What the applicant should do next, or null when nothing is waiting on them. */
function nextAction(application) {
  const docs = documentProgress(application.documents);

  if (application.status === 'APPROVED' || application.status === 'DECLINED') return null;

  if (application.status === 'PENDING') {
    return docs.rejected > 0
      ? { label: 'A document was rejected', detail: 'Contact your municipal office to have it replaced.', to: null }
      : null;
  }

  if (!application.surname || !application.idNumber || !application.cellNumber) {
    return { label: 'Complete your details', detail: 'Surname, ID number and cell number are required.', to: '/apply' };
  }
  if (docs.uploaded < docs.required) {
    const outstanding = docs.required - docs.uploaded;
    return {
      label: `Upload ${outstanding} more document${outstanding === 1 ? '' : 's'}`,
      detail: 'Every required document must be uploaded before you can submit.',
      to: '/documents',
    };
  }
  return { label: 'Submit your application', detail: 'Everything is ready to send.', to: '/apply' };
}

/** Audit events, filtered to what the viewer is allowed to see. */
function events(auditRows = [], { forApplicant = false } = {}) {
  return auditRows
    .filter((row) => (forApplicant ? APPLICANT_VISIBLE_ACTIONS.has(row.action) : true))
    .map((row) => ({
      at: row.createdAt,
      action: row.action,
      label: EVENT_COPY[row.action] || row.action.toLowerCase().replace(/_/g, ' '),
      // Who acted is deliberately withheld from applicants.
      by: forApplicant ? 'Municipal official' : row.userEmail,
      detail: row.details,
    }));
}

module.exports = { stages, nextAction, events, documentProgress, STAGE };
