const prisma = require('./prisma');
const eligibility = require('./eligibility');
const reference = require('./reference');
const notify = require('./notify');
const slots = require('./documentSlots');
const sms = require('./sms');
const smsTemplates = require('./smsTemplates');
const slaMonitor = require('./slaMonitor');
const income = require('./income');
const names = require('./names');

/**
 * Submitting an application.
 *
 * There are two doors into this: a resident submitting their own form, and a
 * ward councillor submitting one they captured at a household. Both must produce
 * exactly the same record — same reference, same frozen threshold, same
 * notifications — so the logic lives here rather than being written twice and
 * drifting.
 */

/**
 * How this application's cell verification reads.
 *
 * A draft reports the account's live state; a submitted application reports the
 * copy frozen onto it. One shape, built once, so the administrator's screen, the
 * approver's, the applicant's and the mobile app cannot describe the same fact
 * four different ways — the same reason `describeTrail` was unified.
 */
function verificationOf(application, owner = null) {
  const submitted = Boolean(application.submittedAt);

  if (submitted) {
    return {
      verified: Boolean(application.cellVerified),
      verifiedAt: application.cellVerifiedAt ?? null,
      number: application.cellVerifiedNumber ?? null,
      source: 'submitted',
    };
  }

  return {
    verified: Boolean(owner?.isVerified),
    verifiedAt: owner?.cellVerifiedAt ?? null,
    number: owner?.isVerified ? owner.cellNumber ?? null : null,
    source: 'account',
  };
}

/** Everything that must be true before an application can enter the queue. */
function readiness(application, { owner = null } = {}) {
  const problems = [];

  /**
   * The number has to have been proved.
   *
   * Every decision reaches the household by SMS, so an unproved number produces
   * an approval nobody is told about. Listed with the missing documents rather
   * than on a separate error path, because from the applicant's side it is the
   * same kind of thing: something still outstanding, named plainly.
   */
  const owning = owner ?? application.user ?? null;
  if (!owning?.isVerified) {
    problems.push('Your cell number has not been verified. Verify it from your profile before submitting.');
  }

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

  /**
   * The income question has to have been answered one way or the other.
   *
   * An empty list is not an answer — it is the state of a section nobody has
   * reached. Declaring no income at all is an answer, and a common one here, so
   * it counts. Without this distinction an application with no income
   * information reaches an assessor who cannot tell whether the household said
   * "nothing" or was never asked, and the means test returns INSUFFICIENT_DATA
   * on a form that looked complete to the person who sent it.
   */
  if (!income.answered(application.incomeSources || [], { declaredNoIncome: application.declaredNoIncome })) {
    problems.push('The income section has not been answered. Add where your income comes from, or state that the household has none.');
  }

  /**
   * Everybody counted must be listed.
   *
   * `peopleOnProperty` is typed; the household roll is built. Nothing
   * reconciled them, so an application could declare five occupants and name
   * two — and income per person, which is half the means test, is computed
   * from the number that was typed.
   *
   * The applicant is one of the people but is not a row, hence the +1.
   */
  const declared = application.peopleOnProperty;
  const listed = (application.household || []).length + 1;
  if (declared && listed !== declared) {
    problems.push(
      listed < declared
        ? `You said ${declared} people live on the property but only ${listed} ${listed === 1 ? 'is' : 'are'} listed. Add the rest.`
        : `You said ${declared} people live on the property but ${listed} are listed. Correct whichever is wrong.`
    );
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
  /**
   * The account's verification, read here rather than trusted from the request.
   *
   * Both doors into this function — a resident submitting their own form and a
   * councillor submitting one they captured — produce the same record, which is
   * the whole reason this lives in one place.
   */
  const owner = await prisma.user.findUnique({
    where: { id: application.userId },
    select: { isVerified: true, cellVerifiedAt: true, cellNumber: true },
  });

  const updated = await prisma.application.update({
    where: { id: application.id },
    data: {
      status: 'PENDING',
      submittedAt: new Date(),
      currentStep: 5,
      /**
       * Frozen from the account, alongside the income threshold below and for
       * the same reason. Changing the number afterwards must not rewrite what
       * an already-decided application says about the moment it was decided.
       */
      cellVerified: Boolean(owner?.isVerified),
      cellVerifiedAt: owner?.cellVerifiedAt ?? null,
      cellVerifiedNumber: owner?.isVerified ? owner.cellNumber : null,
      /**
       * Submitting puts the application at the front of the approval chain.
       *
       * Without this the record is PENDING but sits at NOT_SUBMITTED, so it
       * appears in no queue at all — the worst possible failure, because
       * nothing looks broken while every submitted application quietly becomes
       * invisible to the officers meant to work it.
       */
      approvalStage: 'VERIFICATION',
      verificationStage: 'NOT_STARTED',
      // Assigned at submission, not at draft creation — nobody quotes a
      // reference for a form they have not sent yet.
      reference: application.reference || (await reference.allocate()),
      // Freeze the rule that applied, so changing the municipal figure later
      // does not silently rewrite how this decision reads.
      incomeThresholdApplied: eligibility.INCOME_THRESHOLD,
      // A resubmission starts its service-level clock again.
      slaNotifiedLevel: null,
    },
    include: { documents: { orderBy: [{ importance: 'asc' }, { requirementGroup: 'asc' }, { createdAt: 'asc' }] }, user: { select: { id: true, cellNumber: true, firstName: true } } },
  });

  const ref = updated.reference || updated.id.slice(0, 8);
  const applicantName = names.display(updated) === 'Unnamed' ? 'An applicant' : names.display(updated);

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

  /**
   * Tell the officers who actually have to do something about it.
   *
   * This was the gap. Submission announced itself to administrators and to the
   * applicant, and to nobody at the stage the application had just entered — so
   * a verification officer only discovered new work by going and looking at
   * their queue. Every later stage was told when a file reached it; the first
   * one never was, which is why verification notifications appeared not to work.
   */
  await notify.toStage('VERIFICATION', {
    type: notify.TYPE.APPLICATION_AWAITING_REVIEW,
    title: 'An application is ready for verification',
    body: capturedBy
      ? `${applicantName} was captured by ${capturedBy.name}${capturedBy.ward ? ` (${capturedBy.ward})` : ''} — ${ref}.`
      : `${applicantName} submitted ${ref}.`,
    link: `/verification/${updated.id}`,
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

module.exports = { readiness, submit, verificationOf };
