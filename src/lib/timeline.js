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
    {
      key: STAGE.REVIEW,
      label: 'Municipal review',
      description: decided
        ? 'A municipal official reviewed your application.'
        : submitted
          ? 'An official will review your application. This usually takes up to 14 days.'
          : 'Review begins once you submit.',
      at: null,
      state: decided ? 'done' : submitted ? 'current' : 'upcoming',
    },
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
