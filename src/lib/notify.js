const prisma = require('./prisma');

/**
 * In-app notifications.
 *
 * Two audiences with different needs:
 *
 *  - Applicants need to know when *their* application moves. They are not
 *    watching the portal, so every status change gets a notification.
 *  - Administrators need to know when work arrives. Those events are fanned out
 *    to every administrator so each one can dismiss their own copy.
 *
 * Like the audit trail, a failure here must never break the request that
 * triggered it: nobody should fail to register because an inbox write failed.
 *
 * This is in-app only. Email and SMS delivery is §3.6 of the improvement plan
 * and needs a provider; `deliver()` below is the seam where that would hook in.
 */

const TYPE = {
  APPLICATION_SUBMITTED: 'APPLICATION_SUBMITTED',
  APPLICATION_APPROVED: 'APPLICATION_APPROVED',
  APPLICATION_DECLINED: 'APPLICATION_DECLINED',
  APPLICATION_REOPENED: 'APPLICATION_REOPENED',
  DOCUMENT_REJECTED: 'DOCUMENT_REJECTED',
  DOCUMENT_ACCEPTED: 'DOCUMENT_ACCEPTED',
  APPLICATION_UPDATED: 'APPLICATION_UPDATED',
  WELCOME: 'WELCOME',
  ACCOUNT_CREATED_FOR_YOU: 'ACCOUNT_CREATED_FOR_YOU',
  SITE_VISIT_SCHEDULED: 'SITE_VISIT_SCHEDULED',
  SITE_VISIT_FAILED: 'SITE_VISIT_FAILED',
  INFORMATION_REQUESTED: 'INFORMATION_REQUESTED',
  RECOMMENDATION_READY: 'RECOMMENDATION_READY',
  SUBJECT_REQUEST: 'SUBJECT_REQUEST',
  SUBJECT_REQUEST_ANSWERED: 'SUBJECT_REQUEST_ANSWERED',
  AWAITING_ASSESSMENT: 'AWAITING_ASSESSMENT',
  AWAITING_SIGNOFF: 'AWAITING_SIGNOFF',
  RETURNED_FOR_REWORK: 'RETURNED_FOR_REWORK',
  RENEWAL_DUE: 'RENEWAL_DUE',
  RENEWAL_OVERDUE: 'RENEWAL_OVERDUE',
  REGISTRATION_LAPSED: 'REGISTRATION_LAPSED',
  NEW_REGISTRATION: 'NEW_REGISTRATION',
  NEW_APPLICATION: 'NEW_APPLICATION',
  APPLICATION_AWAITING_REVIEW: 'APPLICATION_AWAITING_REVIEW',
  APPLICATION_AT_RISK: 'APPLICATION_AT_RISK',
  APPLICATION_BREACHED: 'APPLICATION_BREACHED',
  COUNCILLOR_CAPTURE: 'COUNCILLOR_CAPTURE',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  APPROVAL_ACTIVITY: 'APPROVAL_ACTIVITY',
};

/**
 * Seam for out-of-app delivery. Today it only logs; wiring an SMS or email
 * gateway means implementing this one function rather than touching callers.
 */
async function deliver(notification) {
  if (process.env.NOTIFY_LOG === 'true') {
    console.log(`[notify] ${notification.type} -> ${notification.userId}: ${notification.title}`);
  }
}

/**
 * Guard against a miswired caller.
 *
 * Returning quietly on a missing type hid a real bug once: a new notification
 * type was added to the Prisma enum but not to TYPE above, so callers passed
 * `undefined` and every send silently did nothing. Complain loudly instead.
 */
function invalid(where, { type, title }) {
  if (!type || !TYPE[type]) {
    console.error(`[notify] ${where}: unknown notification type ${JSON.stringify(type)} — is it missing from TYPE?`);
    return true;
  }
  if (!title) {
    console.error(`[notify] ${where}: a title is required for ${type}`);
    return true;
  }
  return false;
}

/** Send to one specific person. */
async function toUser(userId, { type, title, body, link, entityType, entityId } = {}) {
  if (!userId) {
    console.error('[notify] toUser: no recipient given');
    return null;
  }
  if (invalid('toUser', { type, title })) return null;
  try {
    const notification = await prisma.notification.create({
      data: {
        userId,
        type,
        title,
        body: body ?? null,
        link: link ?? null,
        entityType: entityType ?? null,
        entityId: entityId ?? null,
      },
    });
    await deliver(notification);
    return notification;
  } catch (error) {
    console.error(`[notify] failed to notify ${userId} of ${type}:`, error.message);
    return null;
  }
}

/**
 * Send to everybody holding one of the given roles.
 *
 * This is what was missing. Only `toUser` and `toAdmins` existed, so an
 * application entering the verification queue told the administrators and no
 * verification officer at all — an officer found out by going and looking. The
 * notifications were not failing to arrive; nothing was sending them.
 *
 * Deactivated accounts are skipped. A councillor who has left office keeps their
 * history, but filling their inbox with work they cannot act on is noise that
 * makes the real notifications easier to ignore.
 *
 * `exceptUserId` skips the person who caused the event — nobody needs telling
 * about something they just did themselves.
 */
async function toRole(roles, { type, title, body, link, entityType, entityId, exceptUserId } = {}) {
  const wanted = (Array.isArray(roles) ? roles : [roles]).filter(Boolean);
  if (wanted.length === 0) {
    console.error('[notify] toRole: no role given');
    return 0;
  }
  if (invalid('toRole', { type, title })) return 0;

  try {
    const recipients = await prisma.user.findMany({
      where: {
        role: { in: wanted },
        isActive: true,
        ...(exceptUserId ? { NOT: { id: exceptUserId } } : {}),
      },
      select: { id: true },
    });
    if (recipients.length === 0) return 0;

    await prisma.notification.createMany({
      data: recipients.map((r) => ({
        userId: r.id,
        type,
        title,
        body: body ?? null,
        link: link ?? null,
        entityType: entityType ?? null,
        entityId: entityId ?? null,
      })),
    });

    await deliver({ type, title, userId: `${recipients.length} × ${wanted.join('/')}` });
    return recipients.length;
  } catch (error) {
    console.error(`[notify] failed to notify ${wanted.join('/')} of ${type}:`, error.message);
    return 0;
  }
}

/**
 * Send to every administrator.
 *
 * Superusers are included: the role exists to do everything, which includes
 * being accountable for the register alongside the administrators.
 */
async function toAdmins(options = {}) {
  return toRole(['ADMIN', 'SUPERUSER'], options);
}

/**
 * The role that owns each stage of the approval chain, so a caller advancing an
 * application does not have to know the org chart. Superusers are added to every
 * stage because they can work any of them.
 */
const STAGE_ROLES = {
  VERIFICATION: ['VERIFICATION_OFFICER', 'SUPERUSER'],
  ASSESSMENT: ['ASSESSMENT_OFFICER', 'SUPERUSER'],
  SUPERVISOR_SIGNOFF: ['SUPERVISOR', 'SUPERUSER'],
};

/** Tell whoever works `stage` that something has arrived for them. */
async function toStage(stage, options = {}) {
  const roles = STAGE_ROLES[stage];
  if (!roles) {
    console.error(`[notify] toStage: unknown stage ${JSON.stringify(stage)}`);
    return 0;
  }
  return toRole(roles, options);
}

module.exports = { toUser, toRole, toStage, toAdmins, TYPE, STAGE_ROLES };
