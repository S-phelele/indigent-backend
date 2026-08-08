const prisma = require('./prisma');
const notify = require('./notify');
const sms = require('./sms');
const smsTemplates = require('./smsTemplates');

/**
 * Annual re-verification.
 *
 * Indigent status is granted for a period, not for life. Almost every municipal
 * policy requires yearly re-verification, and a register that never expires
 * drifts steadily away from who actually qualifies — in both directions. Some
 * households keep a subsidy after their circumstances improve; others, whose
 * circumstances got worse, are not looked at again.
 *
 * The point of doing it here rather than in a spreadsheet is that nobody has to
 * remember. Approving sets an expiry date; a scheduled sweep moves registrations
 * through DUE_SOON, OVERDUE and finally LAPSED, telling the household each time
 * while there is still something they can do about it.
 *
 * ## Lapsing is not declining
 *
 * A lapsed registration means "we have not re-checked", not "you no longer
 * qualify". The application's status is left alone and only `renewalStatus`
 * changes, so a household that lapsed because nobody got to them is visibly
 * different from one that was assessed and refused.
 */

/** How long an approval is valid. Twelve months is the common policy period. */
const VALID_MONTHS = Number(process.env.RENEWAL_VALID_MONTHS || 12);

/** How long before expiry the household is first told. */
const DUE_SOON_DAYS = Number(process.env.RENEWAL_DUE_SOON_DAYS || 60);

/** How long after expiry a registration is allowed to run before lapsing. */
const GRACE_DAYS = Number(process.env.RENEWAL_GRACE_DAYS || 30);

const CHECK_INTERVAL_MINUTES = Number(process.env.RENEWAL_CHECK_INTERVAL_MINUTES || 720);

const DAY_MS = 24 * 60 * 60 * 1000;

/** The expiry date for an approval made now. */
function expiryFrom(approvedAt = new Date()) {
  const expires = new Date(approvedAt);
  expires.setMonth(expires.getMonth() + VALID_MONTHS);
  return expires;
}

/**
 * Which bucket a registration falls in.
 *
 * Pure, so the same rule drives the sweep, the admin list and the applicant's
 * own dashboard without three implementations disagreeing.
 */
function statusFor(application, now = new Date()) {
  if (application.status !== 'APPROVED' || !application.expiresAt) return 'NOT_APPLICABLE';

  const expires = new Date(application.expiresAt);
  const daysToExpiry = Math.ceil((expires - now) / DAY_MS);

  if (daysToExpiry > DUE_SOON_DAYS) return 'ACTIVE';
  if (daysToExpiry > 0) return 'DUE_SOON';
  if (daysToExpiry > -GRACE_DAYS) return 'OVERDUE';
  return 'LAPSED';
}

/** Days until expiry — negative once it has passed. */
const daysRemaining = (application, now = new Date()) =>
  application.expiresAt ? Math.ceil((new Date(application.expiresAt) - now) / DAY_MS) : null;

/**
 * Whether this level has already been announced.
 *
 * Escalation only ever moves forward, so a household is told once per level
 * rather than every time the sweep runs.
 */
const RANK = { NOT_APPLICABLE: 0, ACTIVE: 1, DUE_SOON: 2, OVERDUE: 3, LAPSED: 4 };
const shouldAnnounce = (current, alreadyNotified) => RANK[current] > RANK[alreadyNotified || 'ACTIVE'];

const MESSAGES = {
  DUE_SOON: {
    type: 'RENEWAL_DUE',
    title: 'Your indigent registration is due for renewal',
    body: (days, ref) => `Registration ${ref} expires in ${days} days. `
      + 'Please contact your municipal office to be re-verified so your support continues.',
    smsTemplate: 'RENEWAL_DUE',
  },
  OVERDUE: {
    type: 'RENEWAL_OVERDUE',
    title: 'Your indigent registration has expired',
    body: (days, ref) => `Registration ${ref} expired ${Math.abs(days)} days ago. `
      + 'Contact your municipal office urgently to be re-verified.',
    smsTemplate: 'RENEWAL_OVERDUE',
  },
  LAPSED: {
    type: 'REGISTRATION_LAPSED',
    title: 'Your indigent registration has lapsed',
    body: (days, ref) => `Registration ${ref} has lapsed because it was not re-verified. `
      + 'You will need to apply again to continue receiving support.',
    smsTemplate: 'REGISTRATION_LAPSED',
  },
};

/**
 * Move every approved registration into its correct bucket, and tell the
 * households whose bucket changed.
 */
async function sweep(client = prisma, now = new Date()) {
  const approved = await client.application.findMany({
    where: { status: 'APPROVED', expiresAt: { not: null } },
    select: {
      id: true, reference: true, userId: true, expiresAt: true,
      renewalStatus: true, renewalNotifiedLevel: true,
      user: { select: { cellNumber: true } },
    },
  });

  const changed = [];
  const announced = [];

  for (const application of approved) {
    const status = statusFor({ ...application, status: 'APPROVED' }, now);
    if (status === application.renewalStatus) continue;

    const days = daysRemaining(application, now);
    const announce = shouldAnnounce(status, application.renewalNotifiedLevel) && MESSAGES[status];

    await client.application.update({
      where: { id: application.id },
      data: {
        renewalStatus: status,
        ...(announce ? { renewalNotifiedLevel: status } : {}),
      },
    });
    changed.push({ id: application.id, reference: application.reference, from: application.renewalStatus, to: status });

    if (!announce) continue;

    const message = MESSAGES[status];
    const ref = application.reference || application.id.slice(0, 8);

    await notify.toUser(application.userId, {
      type: notify.TYPE[message.type],
      title: message.title,
      body: message.body(days, ref),
      link: `/applications/${application.id}`,
      entityType: 'Application',
      entityId: application.id,
    });

    await sms.send(
      application.user?.cellNumber,
      smsTemplates.build(message.smsTemplate, { reference: ref, days: Math.abs(days) }),
      { purpose: message.smsTemplate, userId: application.userId, entityType: 'Application', entityId: application.id }
    );

    announced.push({ id: application.id, reference: ref, level: status });
  }

  // Administrators need to know how much re-verification work is waiting, but
  // one message about the batch — not one per household.
  if (announced.length) {
    await notify.toAdmins({
      type: notify.TYPE.RENEWAL_DUE,
      title: `${announced.length} registration${announced.length === 1 ? '' : 's'} need re-verification`,
      body: announced.slice(0, 5).map((a) => `${a.reference} (${a.level.toLowerCase().replace('_', ' ')})`).join(', ')
        + (announced.length > 5 ? ` and ${announced.length - 5} more.` : '.'),
      link: '/renewals',
    });
  }

  return { checked: approved.length, changed, announced };
}

/**
 * Re-verify and extend a registration.
 *
 * Deliberately does not create a new application: the household is the same
 * household, and splitting their history across records is how a register loses
 * the ability to answer "how long has this family been supported?".
 */
async function renew(applicationId, { actor, notes } = {}, client = prisma) {
  const now = new Date();
  const expiresAt = expiryFrom(now);

  return client.application.update({
    where: { id: applicationId },
    data: {
      expiresAt,
      renewalStatus: 'ACTIVE',
      renewalNotifiedLevel: null,
      renewalCount: { increment: 1 },
      lastRenewedAt: now,
      reviewNotes: notes || undefined,
      reviewedBy: actor?.id,
      reviewedAt: now,
    },
  });
}

/** Run the sweep on a timer. Returns a stop function. */
function schedule() {
  if (!CHECK_INTERVAL_MINUTES) {
    console.log('[renewal] scheduled re-verification checks are disabled');
    return () => {};
  }

  console.log(
    `[renewal] checking every ${CHECK_INTERVAL_MINUTES} minute(s); `
    + `registrations valid ${VALID_MONTHS} months, warned ${DUE_SOON_DAYS} days ahead`
  );

  const run = async () => {
    try {
      const result = await sweep();
      if (result.changed.length) {
        console.log(`[renewal] ${result.changed.length} registration(s) changed state, ${result.announced.length} announced`);
      }
    } catch (error) {
      console.error('[renewal] sweep failed:', error.message);
    }
  };

  const timer = setInterval(run, CHECK_INTERVAL_MINUTES * 60 * 1000);
  timer.unref?.();
  setTimeout(run, 15000).unref?.();

  return () => clearInterval(timer);
}

module.exports = {
  VALID_MONTHS,
  DUE_SOON_DAYS,
  GRACE_DAYS,
  expiryFrom,
  statusFor,
  daysRemaining,
  shouldAnnounce,
  sweep,
  renew,
  schedule,
  RANK,
};
