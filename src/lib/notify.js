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
 * Send to every administrator.
 *
 * `exceptUserId` skips the person who caused the event — an admin who creates an
 * applicant does not need telling that an applicant was created.
 */
async function toAdmins({ type, title, body, link, entityType, entityId, exceptUserId } = {}) {
  if (invalid('toAdmins', { type, title })) return 0;
  try {
    const admins = await prisma.user.findMany({
      where: { role: 'ADMIN', ...(exceptUserId ? { NOT: { id: exceptUserId } } : {}) },
      select: { id: true },
    });
    if (admins.length === 0) return 0;

    await prisma.notification.createMany({
      data: admins.map((a) => ({
        userId: a.id,
        type,
        title,
        body: body ?? null,
        link: link ?? null,
        entityType: entityType ?? null,
        entityId: entityId ?? null,
      })),
    });

    await deliver({ type, title, userId: `${admins.length} admin(s)` });
    return admins.length;
  } catch (error) {
    console.error(`[notify] failed to notify admins of ${type}:`, error.message);
    return 0;
  }
}

module.exports = { toUser, toAdmins, TYPE };
