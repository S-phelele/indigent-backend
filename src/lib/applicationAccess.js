/**
 * Who may see and change an application.
 *
 * There are several ways to hold a legitimate claim on one record, so the rule
 * is written down once instead of being restated at each route:
 *
 *  - the resident it belongs to;
 *  - an administrator, who sees everything;
 *  - the staff member who captured it, for as long as it is still a draft.
 *
 * That last one is deliberately narrow. A councillor knocks on a door, captures a
 * household and submits it — after which their access ends. They are not a
 * caseworker with a standing list of residents, and one councillor must never be
 * able to read another ward's households. The moment the application is
 * submitted, it belongs to the review process.
 *
 * Every route in the system goes through this file. If a rule is not here, it
 * does not exist — restating access logic inline is how one endpoint ends up
 * more permissive than the rest.
 */

/** Roles that capture applications on somebody's behalf. */
const CAPTURE_ROLES = ['COUNCILLOR', 'CAPTURE_OFFICER'];

const isOwner = (user, application) => application.userId === user.id;
const isAdmin = (user) => user.role === 'ADMIN';

/**
 * The staff member who captured this application, while it remains a draft.
 *
 * Covers every capturing role, not just councillors. This originally named
 * COUNCILLOR alone, which silently locked capture officers out of editing their
 * own captures the moment that role was introduced — the sort of gap that
 * appears whenever an access rule enumerates roles instead of asking what
 * somebody actually did.
 */
const isCapturer = (user, application) =>
  CAPTURE_ROLES.includes(user.role)
  && application.capturedById === user.id
  && application.status === 'DRAFT';

/**
 * Staff keep read access to what they captured after submission, so "My
 * captures" can show an outcome. They see the status, not the review.
 */
const capturedByThem = (user, application) =>
  CAPTURE_ROLES.includes(user.role) && application.capturedById === user.id;

/**
 * Verification officers may read any submitted application.
 *
 * Not drafts: an unsubmitted form is the applicant's private working copy, and
 * there is nothing to verify until they send it.
 */
const isVerifierOfSubmitted = (user, application) =>
  user.role === 'VERIFICATION_OFFICER' && application.status !== 'DRAFT';

function canView(user, application) {
  return isAdmin(user)
    || isOwner(user, application)
    || capturedByThem(user, application)
    || isVerifierOfSubmitted(user, application);
}

function canEdit(user, application) {
  if (application.status !== 'DRAFT') return false;
  return isOwner(user, application) || isCapturer(user, application);
}

function canSubmit(user, application) {
  return canEdit(user, application);
}

/**
 * Express guard. Loads the application, checks access, and hands both on via
 * `req.application` so the handler does not fetch it a second time.
 *
 * `include` is passed through to Prisma because different routes need different
 * relations loaded.
 */
function loadFor(mode, { include } = {}) {
  const check = { view: canView, edit: canEdit, submit: canSubmit }[mode];
  if (!check) throw new Error(`[applicationAccess] unknown mode "${mode}"`);

  return async (req, res, next) => {
    try {
      const prisma = require('./prisma');
      const application = await prisma.application.findUnique({
        where: { id: req.params.id },
        include,
      });

      if (!application) {
        return res.status(404).json({ success: false, message: 'We could not find that application.' });
      }

      if (!canView(req.user, application)) {
        // Deliberately the same response as a missing record. Confirming that an
        // application exists but belongs to someone else leaks that a given
        // person is on the indigent register.
        console.warn(
          `[access] ${req.user.role} ${req.user.id} was refused ${mode} on application ${application.id}`
        );
        return res.status(404).json({ success: false, message: 'We could not find that application.' });
      }

      if (check !== canView && !check(req.user, application)) {
        return res.status(400).json({
          success: false,
          message: application.status === 'DRAFT'
            ? 'You do not have permission to change this application.'
            : 'This application has already been submitted, so it can no longer be changed.',
        });
      }

      req.application = application;
      next();
    } catch (error) {
      console.error(`[applicationAccess] lookup failed for ${req.params.id}:`, error);
      res.status(500).json({ success: false, message: 'Something went wrong on our side. Please try again.' });
    }
  };
}

module.exports = {
  canView,
  canEdit,
  canSubmit,
  isOwner,
  isAdmin,
  isCapturer,
  // Kept under the old name so nothing that still imports it breaks silently.
  isCapturingCouncillor: isCapturer,
  loadFor,
  CAPTURE_ROLES,
};
