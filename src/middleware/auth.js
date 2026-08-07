const jwt = require('jsonwebtoken');
const prisma = require('../lib/prisma');

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
      },
    });

    if (!user) {
      return res.status(401).json({ success: false, message: 'Your session is no longer valid. Please sign in again.' });
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
    return res.status(401).json({ success: false, message: 'Your session has ended. Please sign in again.' });
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
  if (!roles.includes(req.user?.role)) {
    return res.status(403).json({ success: false, message: 'You do not have access to this area' });
  }
  next();
};

const requireAdmin = requireRole('ADMIN');
const requireApplicant = requireRole('APPLICANT');

/** Anyone who works for the municipality rather than applying to it. */
const STAFF_ROLES = ['ADMIN', 'COUNCILLOR', 'CAPTURE_OFFICER', 'VERIFICATION_OFFICER'];
const requireStaff = requireRole(...STAFF_ROLES);

/** Roles that may capture an application on somebody's behalf. */
const requireCapture = requireRole('ADMIN', 'COUNCILLOR', 'CAPTURE_OFFICER');

/** Roles that may verify. Deliberately excludes anyone who captures. */
const requireVerifier = requireRole('ADMIN', 'VERIFICATION_OFFICER');

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
  requirePasswordChanged,
  STAFF_ROLES,
};
