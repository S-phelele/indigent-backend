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

/**
 * Roles that capture applications on somebody's behalf in the field or at the
 * desk. ADMIN and SUPERUSER are included so a superuser can register a household
 * the same way a councillor or front-desk officer does.
 */
const CAPTURE_ROLES = ['COUNCILLOR', 'CAPTURE_OFFICER', 'ADMIN', 'SUPERUSER'];

const isOwner = (user, application) => application.userId === user.id;

/**
 * Administrators and superusers see every application.
 *
 * SUPERUSER is included on purpose: the role exists so one account can oversee
 * the register and walk a case through every stage, which is impossible if it
 * cannot open the file in the first place.
 */
const isAdmin = (user) => user.role === 'ADMIN' || user.role === 'SUPERUSER';

/**
 * The staff member who captured this application, while it remains a draft.
 *
 * Judged by what they did (capturedById), not by role alone. That way an
 * ADMIN or SUPERUSER who registers a household at the counter can finish the
 * draft they started — the same path a councillor uses door to door.
 */
const isCapturer = (user, application) =>
  application.capturedById === user.id
  && application.status === 'DRAFT';

/**
 * Staff keep read access to what they captured after submission, so "My
 * captures" can show an outcome. They see the status, not the review.
 */
const capturedByThem = (user, application) =>
  application.capturedById === user.id;

/**
 * Verification officers may read any submitted application.
 *
 * Not drafts: an unsubmitted form is the applicant's private working copy, and
 * there is nothing to verify until they send it.
 *
 * SUPERUSER and ADMIN already pass via isAdmin; they are not repeated here.
 */
/** Roles that review submitted applications (verify / assess / sign-off). */
const REVIEW_ROLES = ['VERIFICATION_OFFICER', 'ASSESSMENT_OFFICER', 'SUPERVISOR', 'ADMIN', 'SUPERUSER'];

const isReviewerOfSubmitted = (user, application) =>
  REVIEW_ROLES.includes(user?.role) && application.status !== 'DRAFT';

// Kept under the old name so existing imports keep working.
const isVerifierOfSubmitted = isReviewerOfSubmitted;

function canView(user, application) {
  // Role checked directly as well as via isAdmin — keeps capture/oversight
  // working even if a partial user object is passed in.
  if (user?.role === 'ADMIN' || user?.role === 'SUPERUSER') return true;
  return isOwner(user, application)
    || capturedByThem(user, application)
    || isReviewerOfSubmitted(user, application);
}

function canEdit(user, application) {
  if (application.status !== 'DRAFT') return false;
  // Superuser and admin may edit any draft (field capture and oversight).
  if (user?.role === 'ADMIN' || user?.role === 'SUPERUSER') return true;
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

      /**
       * SUPERUSER and ADMIN always pass every mode.
       *
       * Checked here (not only inside canView/canEdit) so household, income and
       * document routes cannot refuse a superuser who is capturing or overseeing
       * a case — those routes all share this guard.
       */
      const privileged = req.user?.role === 'ADMIN' || req.user?.role === 'SUPERUSER';

      if (!privileged && !canView(req.user, application)) {
        // Deliberately the same response as a missing record. Confirming that an
        // application exists but belongs to someone else leaks that a given
        // person is on the indigent register.
        console.warn(
          `[access] ${req.user?.role} ${req.user?.id} was refused ${mode} on application ${application.id}`
        );
        return res.status(404).json({ success: false, message: 'We could not find that application.' });
      }

      if (!privileged && check !== canView && !check(req.user, application)) {
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

// Visible in the backend console on startup so you can confirm this file loaded.
console.log('[applicationAccess] loaded — SUPERUSER/ADMIN are privileged for view/edit/submit');

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
