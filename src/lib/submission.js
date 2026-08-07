const prisma = require('./prisma');
const eligibility = require('./eligibility');
const reference = require('./reference');
const notify = require('./notify');
const slots = require('./documentSlots');
const sms = require('./sms');
const smsTemplates = require('./smsTemplates');
const slaMonitor = require('./slaMonitor');

/**
 * Submitting an application.
 *
 * There are two doors into this: a resident submitting their own form, and a
 * ward councillor submitting one they captured at a household. Both must produce
 * exactly the same record — same reference, same frozen threshold, same
 * notifications — so the logic lives here rather than being written twice and
 * drifting.
 */

/** Everything that must be true before an application can enter the queue. */
function readiness(application) {
  const problems = [];

  const documents = slots.outstanding(application.documents || []);
  if (!documents.complete) {
    problems.push(slots.outstandingMessage(application.documents || []));
  }

  const missingFields = [];
  if (!application.surname) missingFields.push('surname');
  if (!application.idNumber) missingFields.push('ID number');
  if (!application.cellNumber) missingFields.push('cell number');
  if (missingFields.length) {
    problems.push(`Applicant particulars are incomplete: ${missingFields.join(', ')}.`);
  }

  return {
    ready: problems.length === 0,
    problems,
    missingDocuments: [
      ...documents.missingRequired.map((d) => d.name),
      ...documents.missingGroups.map((g) => g.options.join(' or ')),
    ],
  };
}

/**
 * Move a draft into the review queue.
 *
 * `capturedBy` is set when a councillor is submitting on a resident's behalf; it
 * changes who is told what, not what is recorded. The resident is always the one
 * notified about their own application.
 *
 * Assumes the caller has already checked permission and readiness.
 */
async function submit(application, { actor, capturedBy = null } = {}) {
  const updated = await prisma.application.update({
    where: { id: application.id },
    data: {
      status: 'PENDING',
      submittedAt: new Date(),
      currentStep: 5,
      // Assigned at submission, not at draft creation — nobody quotes a
      // reference for a form they have not sent yet.
      reference: application.reference || (await reference.allocate()),
      // Freeze the rule that applied, so changing the municipal figure later
      // does not silently rewrite how this decision reads.
      incomeThresholdApplied: eligibility.INCOME_THRESHOLD,
      // A resubmission starts its service-level clock again.
      slaNotifiedLevel: null,
    },
    include: { documents: true, user: { select: { id: true, cellNumber: true, firstName: true } } },
  });

  const ref = updated.reference || updated.id.slice(0, 8);
  const applicantName = [updated.names, updated.surname].filter(Boolean).join(' ') || 'An applicant';

  await notify.toAdmins({
    type: capturedBy ? notify.TYPE.COUNCILLOR_CAPTURE : notify.TYPE.NEW_APPLICATION,
    title: capturedBy ? 'Application captured in the field' : 'New application awaiting review',
    body: capturedBy
      ? `${applicantName} was registered by ${capturedBy.name}${capturedBy.ward ? ` (${capturedBy.ward})` : ''} — ${ref}.`
      : `${applicantName} submitted ${ref}.`,
    link: `/applications/${updated.id}`,
    entityType: 'Application',
    entityId: updated.id,
    exceptUserId: actor?.id,
  });

  await notify.toUser(updated.userId, {
    type: notify.TYPE.APPLICATION_SUBMITTED,
    title: 'Application submitted',
    body: `Reference ${ref}. A municipal official will review it within ${slaMonitor.SLA_DAYS} days.`,
    link: `/applications/${updated.id}`,
    entityType: 'Application',
    entityId: updated.id,
  });

  // The resident may never have seen a screen — for a door-to-door capture the
  // SMS is the only thing they walk away with, so it names who captured it.
  const cell = updated.user?.cellNumber || updated.cellNumber;
  await sms.send(
    cell,
    capturedBy
      ? smsTemplates.build('CAPTURED_BY_COUNCILLOR', { reference: ref, councillor: capturedBy.name, ward: capturedBy.ward })
      : smsTemplates.build('APPLICATION_SUBMITTED', { reference: ref, days: slaMonitor.SLA_DAYS }),
    {
      purpose: capturedBy ? 'CAPTURED_BY_COUNCILLOR' : 'APPLICATION_SUBMITTED',
      userId: updated.userId,
      entityType: 'Application',
      entityId: updated.id,
    }
  );

  return updated;
}

module.exports = { readiness, submit };
