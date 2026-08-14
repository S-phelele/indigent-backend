const jwt = require('jsonwebtoken');
const prisma = require('../lib/prisma');
const loginSecurity = require('../lib/loginSecurity');

const authenticate = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Please sign in to continue.' });
    }

    const token = header.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: {
        id: true,
        email: true,
        role: true,
        firstName: true,
        lastName: true,
        cellNumber: true,
        idNumber: true,
        isVerified: true,
        ward: true,
        isActive: true,
        mustChangePassword: true,
        passwordChangedAt: true,
        lockedUntil: true,
      },
    });

    if (!user) {
      return res.status(401).json({ success: false, message: 'Your session is no longer valid. Please sign in again.' });
    }

    /**
     * A token minted before the password changed is dead.
     *
     * This is what makes changing a password an act of defence rather than a
     * formality. Without it, somebody who has stolen a token keeps using it for
     * the token's full lifetime, and the victim changing their password does
     * nothing at all to stop them. Checked here so it applies to every route.
     */
    if (loginSecurity.issuedBeforePasswordChange(decoded, user)) {
      return res.status(401).json({
        success: false,
        code: 'SESSION_REVOKED',
        message: 'Your password was changed, so this session has ended. Please sign in again.',
      });
    }

    /**
     * A lock takes effect immediately, on sessions that are already open.
     *
     * An administrator locking a compromised account expects it to stop working
     * now, not whenever the holder's token happens to expire.
     */
    const lock = loginSecurity.lockState(user);
    if (lock.locked) {
      return res.status(423).json({
        success: false,
        code: 'ACCOUNT_LOCKED',
        message: loginSecurity.lockedMessage(lock.minutesLeft),
      });
    }

    // A councillor who has left office keeps their history but loses access.
    // Checked on every request rather than only at sign-in, so revoking somebody
    // takes effect immediately instead of whenever their token happens to expire.
    if (!user.isActive) {
      return res.status(403).json({
        success: false,
        message: 'This account has been deactivated. Contact the municipal administrator.',
        code: 'ACCOUNT_DEACTIVATED',
      });
    }

    req.user = user;
    next();
  } catch (error) {
    /**
     * An expired session and a malformed token are different events.
     *
     * Both end in signing out, but only one deserves an explanation. "Your
     * session timed out" tells somebody who left a tab open for a day what
     * happened and that nothing is wrong; the same words for a corrupted token
     * would be a guess. The portals use the code to decide what to say on the
     * sign-in screen.
     */
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        code: 'SESSION_EXPIRED',
        message: 'Your session has timed out. Please sign in again.',
      });
    }

    // A bad signature is worth a line in the log: it is either a bug in a client
    // or somebody editing tokens by hand.
    console.warn(`[auth] rejected token: ${error.name} — ${error.message}`);
    return res.status(401).json({
      success: false,
      code: 'SESSION_INVALID',
      message: 'Your session is no longer valid. Please sign in again.',
    });
  }
};

/**
 * Allow only the given roles.
 *
 *   router.use(authenticate, requireRole('ADMIN', 'COUNCILLOR'))
 *
 * The message names what is needed rather than what the caller is, so it does
 * not confirm anything about the account to somebody probing endpoints.
 */
const requireRole = (...roles) => (req, res, next) => {
  const role = req.user?.role;

  /**
   * SUPERUSER satisfies every staff role check.
   *
   * The role exists to do everything, and spelling that out at each of the
   * several dozen call sites would guarantee one gets missed — which fails in
   * the confusing direction, where a role documented as omnipotent is refused a
   * single screen for no visible reason.
   *
   * APPLICANT is deliberately excluded. It is not a privilege to be inherited
   * but a different kind of account: the applicant routes act on whoever is
   * signed in as the owner of the record, and a staff account owning
   * applications of its own is a category error, not extra power.
   */
  if (role === 'SUPERUSER' && !roles.includes('APPLICANT')) return next();

  if (!roles.includes(role)) {
    return res.status(403).json({ success: false, message: 'You do not have access to this area' });
  }
  next();
};

const requireAdmin = requireRole('ADMIN');
const requireApplicant = requireRole('APPLICANT');

/** Anyone who works for the municipality rather than applying to it. */
const STAFF_ROLES = ['SUPERUSER', 'ADMIN', 'COUNCILLOR', 'CAPTURE_OFFICER', 'VERIFICATION_OFFICER', 'ASSESSMENT_OFFICER', 'SUPERVISOR'];
const requireStaff = requireRole(...STAFF_ROLES);

/** Roles that may capture an application on somebody's behalf. */
const requireCapture = requireRole('ADMIN', 'COUNCILLOR', 'CAPTURE_OFFICER');

/** Roles that may verify. Deliberately excludes anyone who captures. */
const requireVerifier = requireRole('ADMIN', 'VERIFICATION_OFFICER');

/** Roles that work a stage of the approval chain. */
const APPROVER_ROLES = ['SUPERUSER', 'ADMIN', 'VERIFICATION_OFFICER', 'ASSESSMENT_OFFICER', 'SUPERVISOR'];
const requireApprover = requireRole(...APPROVER_ROLES);

/**
 * Block everything until a handed-out password has been replaced.
 *
 * Accounts created by staff have their first password sent over SMS, which means
 * it has been seen by at least one other person and is sitting in a message
 * store on the handset. Until the holder replaces it, the session can do exactly
 * two things: read its own profile, and set a new password. Everything else is
 * refused with a code the portals use to redirect.
 *
 * Applied globally in index.js rather than per route, because the whole point is
 * that no route is missed.
 */
const ALLOWED_WHILE_LOCKED = [
  { method: 'POST', path: '/api/auth/change-password' },
  { method: 'GET', path: '/api/auth/me' },
  { method: 'POST', path: '/api/auth/logout' },
];

const requirePasswordChanged = (req, res, next) => {
  if (!req.user?.mustChangePassword) return next();

  const allowed = ALLOWED_WHILE_LOCKED.some(
    (r) => r.method === req.method && req.originalUrl.split('?')[0] === r.path
  );
  if (allowed) return next();

  return res.status(403).json({
    success: false,
    message: 'Please choose a new password before continuing.',
    code: 'PASSWORD_CHANGE_REQUIRED',
  });
};

/**
 * The standard guard for any authenticated router:
 *
 *   router.use(...protect);
 *
 * One import instead of two, so a new router cannot pick up authentication and
 * silently miss the password-change gate. Everything except /api/auth uses it.
 */
const protect = [authenticate, requirePasswordChanged];

module.exports = {
  authenticate,
  protect,
  requireRole,
  requireAdmin,
  requireApplicant,
  requireStaff,
  requireCapture,
  requireVerifier,
  requireApprover,
  requirePasswordChanged,
  STAFF_ROLES,
  APPROVER_ROLES,
};
