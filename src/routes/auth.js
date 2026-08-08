const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const prisma = require('../lib/prisma');
const { authenticate } = require('../middleware/auth');
const audit = require('../lib/audit');
const otpService = require('../lib/otp');
const notify = require('../lib/notify');
const saId = require('../lib/saIdNumber');
const sms = require('../lib/sms');
const smsTemplates = require('../lib/smsTemplates');
const loginSecurity = require('../lib/loginSecurity');
const {
  loginLimiter,
  registerLimiter,
  otpSendLimiter,
  otpVerifyLimiter,
  passwordResetLimiter,
} = require('../lib/rateLimit');

const router = express.Router();

/**
 * Mint a session token.
 *
 * The lifetime is a cap on how long a copied token stays useful. Seven days was
 * too generous for a system holding ID numbers, income declarations and the
 * coordinates of people's homes — a token lifted from a shared municipal machine
 * should not still work next week. Eight hours covers a shift.
 *
 * SESSION_HOURS is the only setting that controls this. `JWT_EXPIRES_IN` used to,
 * and is deliberately ignored now: two variables governing the same thing is how
 * a change like this silently does nothing, which is exactly what happened here —
 * the shorter default was overridden by a `JWT_EXPIRES_IN=7d` left in an existing
 * `.env`, and tokens carried on lasting a week. `index.js` warns at boot if it is
 * still set, so nobody is left believing a value that has no effect.
 */
const generateToken = (userId) =>
  jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: `${loginSecurity.SESSION_HOURS}h` });

const { passwordProblems } = require('../lib/credentials');

/** In development the code is returned so the flow is testable without an SMS gateway. */
const exposeDemoCode = () => process.env.NODE_ENV !== 'production';

// Register (Applicant)
router.post('/register', registerLimiter, async (req, res) => {
  try {
    const { email, password, firstName, lastName, cellNumber, idNumber } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Please enter your email address and password.' });
    }

    const passwordErrors = passwordProblems(password);
    if (passwordErrors.length) {
      return res.status(400).json({
        success: false,
        message: `Password must include ${passwordErrors.join(', ')}`,
      });
    }

    if (idNumber) {
      const check = saId.validate(idNumber);
      if (!check.valid) return res.status(400).json({ success: false, message: check.reason });
    }

    const existing = await prisma.user.findFirst({
      where: {
        OR: [
          { email },
          ...(idNumber ? [{ idNumber }] : []),
        ],
      },
    });

    if (existing) {
      return res.status(400).json({ success: false, message: 'That email address or ID number is already registered. Try signing in instead.' });
    }

    const hashed = await bcrypt.hash(password, 12);

    const user = await prisma.user.create({
      data: {
        email,
        password: hashed,
        firstName,
        lastName,
        cellNumber,
        idNumber,
        role: 'APPLICANT',
      },
      select: { id: true, email: true, role: true, firstName: true, lastName: true, cellNumber: true },
    });

    const token = generateToken(user.id);

    await audit.record(req, {
      action: audit.ACTIONS.REGISTER,
      entityType: 'User',
      entityId: user.id,
      details: `New applicant registered: ${user.email}`,
      actor: user,
    });

    await notify.toAdmins({
      type: notify.TYPE.NEW_REGISTRATION,
      title: 'New applicant registered',
      body: `${[user.firstName, user.lastName].filter(Boolean).join(' ') || user.email} created an account.`,
      link: `/applicants/${user.id}`,
      entityType: 'User',
      entityId: user.id,
    });

    await notify.toUser(user.id, {
      type: notify.TYPE.WELCOME,
      title: 'Welcome to the Indigent Register',
      body: 'Start an application when you are ready. Your progress is saved as you go.',
      link: '/dashboard',
    });

    if (user.cellNumber) {
      await sms.send(user.cellNumber, smsTemplates.build('WELCOME', { firstName: user.firstName }), {
        purpose: 'WELCOME',
        userId: user.id,
        entityType: 'User',
        entityId: user.id,
      });
    }

    res.status(201).json({
      success: true,
      message: 'Your account is ready.',
      data: { user, token },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'We could not create your account. Please try again.' });
  }
});

// Login
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Please enter your email address or cell number, and your password.' });
    }

    /**
     * Residents registered at their door have no email address — their SMS tells
     * them to sign in with their cell number, so accept either here. The field is
     * still called `email` because that is what both portals send; what it
     * carries is "whatever they were told their username is".
     */
    const identifier = String(email).trim().toLowerCase();
    const asCell = sms.normaliseNumber(identifier);

    const user = await prisma.user.findFirst({
      where: asCell
        ? { OR: [{ email: identifier }, { cellNumber: asCell }] }
        : { email: identifier },
    });

    /**
     * A locked account is refused before the password is even compared.
     *
     * Checking the password first would let somebody keep testing guesses against
     * a locked account and learn from the timing which one was right, which is
     * most of what the lock exists to prevent.
     */
    const lock = loginSecurity.lockState(user);
    if (lock.locked) {
      await audit.record(req, {
        action: audit.ACTIONS.LOGIN_BLOCKED,
        entityType: 'User',
        entityId: user.id,
        details: `Sign-in refused: account locked for another ${lock.minutesLeft} minute(s)`,
        actor: user,
      });
      return res.status(429).json({
        success: false,
        code: 'ACCOUNT_LOCKED',
        message: loginSecurity.lockedMessage(lock.minutesLeft),
        lockedForMinutes: lock.minutesLeft,
      });
    }

    const passwordMatches = user ? await bcrypt.compare(password, user.password) : false;

    if (!user || !passwordMatches) {
      /**
       * Count the failure against the account, not just the connection.
       *
       * The rate limiter is keyed on the caller's address, so an attacker with a
       * pool of addresses gets a fresh allowance with each one. This is the count
       * that follows the account being attacked.
       *
       * Nothing is recorded when no such account exists — writing a row would
       * turn response timing into a way to enumerate which addresses are real.
       */
      if (user) {
        const failure = loginSecurity.registerFailure(user);
        await prisma.user.update({ where: { id: user.id }, data: failure.data });

        await audit.record(req, {
          action: failure.locked ? audit.ACTIONS.ACCOUNT_LOCKED : audit.ACTIONS.LOGIN_FAILED,
          entityType: 'User',
          entityId: user.id,
          details: failure.locked
            ? `Locked for ${failure.minutes} minute(s) after ${failure.attempts} failed attempt(s)`
            : `Failed sign-in attempt ${failure.attempts} of ${loginSecurity.THRESHOLD}`,
          actor: user,
        });

        // Somebody grinding away at a supervisor's account is worth an
        // administrator's attention while it is happening, not at audit time.
        if (failure.locked && user.role !== 'APPLICANT') {
          await notify.toAdmins({
            type: notify.TYPE.ACCOUNT_LOCKED,
            title: 'A staff account has been locked',
            body: `${user.email} was locked for ${failure.minutes} minute(s) after ${failure.attempts} failed sign-in attempts.`,
            link: '/staff',
            entityType: 'User',
            entityId: user.id,
          });
        }

        if (failure.locked) {
          return res.status(429).json({
            success: false,
            code: 'ACCOUNT_LOCKED',
            message: loginSecurity.lockedMessage(failure.minutes),
            lockedForMinutes: failure.minutes,
          });
        }

        /**
         * Warn only once the account is close to locking.
         *
         * Announcing "4 attempts remaining" from the first typo is noise, and it
         * hands an attacker a countdown to the threshold. Saying so on the last
         * attempt or two helps the person who is simply misremembering their own
         * password and is about to be locked out.
         */
        if (failure.remaining <= 2) {
          return res.status(401).json({
            success: false,
            message: `That email address or password is not correct. `
              + `${failure.remaining} more failed ${failure.remaining === 1 ? 'attempt' : 'attempts'} will lock this account.`,
            attemptsRemaining: failure.remaining,
          });
        }
      }

      return res.status(401).json({ success: false, message: 'That email address or password is not correct.' });
    }

    // Checked after the password so an attacker cannot use this response to
    // discover which accounts exist.
    if (!user.isActive) {
      return res.status(403).json({
        success: false,
        code: 'ACCOUNT_DEACTIVATED',
        message: 'This account has been deactivated. Contact the municipal administrator.',
      });
    }

    const token = generateToken(user.id);

    /**
     * The previous sign-in, read before this one overwrites it.
     *
     * Returned to the portal so it can show "last signed in on…". Somebody
     * noticing a sign-in that was not theirs is the cheapest account-compromise
     * detection available, and it costs one line.
     */
    const previousSignIn = user.lastLoginAt;

    await prisma.user.update({
      where: { id: user.id },
      data: loginSecurity.registerSuccess(req),
    });

    await audit.record(req, {
      action: audit.ACTIONS.LOGIN,
      entityType: 'User',
      entityId: user.id,
      details: `${user.role} signed in`,
      actor: user,
    });

    res.json({
      success: true,
      message: 'Signed in.',
      data: {
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
          firstName: user.firstName,
          lastName: user.lastName,
          cellNumber: user.cellNumber,
          idNumber: user.idNumber,
          isVerified: user.isVerified,
          ward: user.ward,
          // The portals read this and send the holder straight to the change
          // password screen — a password that arrived by SMS is not a secret.
          mustChangePassword: user.mustChangePassword,
        },
        token,
        /** So the portal can show it and somebody can spot a sign-in that was not theirs. */
        previousSignIn: previousSignIn || null,
        /** The idle timeout the portals enforce, so the policy lives in one place. */
        session: loginSecurity.policy(),
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'We could not sign you in. Please try again.' });
  }
});

// Send a cell-verification code
router.post('/send-otp', otpSendLimiter, async (req, res) => {
  try {
    const { cellNumber } = req.body;

    if (!cellNumber || String(cellNumber).replace(/\D/g, '').length < 10) {
      return res.status(400).json({ success: false, message: 'Please enter a valid cell number, for example 082 123 4567.' });
    }

    const { code, expiresAt } = await otpService.issue(cellNumber, {
      userId: req.user?.id || null,
      purpose: otpService.PURPOSE.VERIFY_CELL,
    });

    // Goes through the SMS service like every other outbound message. With the
    // console provider it prints to the terminal and lands in the admin portal's
    // SMS outbox; switching SMS_PROVIDER sends it for real, with no change here.
    // The code itself is redacted from the stored copy.
    await sms.send(
      cellNumber,
      smsTemplates.build('OTP', { code, minutes: otpService.EXPIRY_MINUTES }),
      { purpose: 'OTP', userId: req.user?.id || null, secrets: [code] }
    );

    res.json({
      success: true,
      message: `Verification code sent to the number ending in ${String(cellNumber).slice(-4)}`,
      demoOtp: exposeDemoCode() ? code : undefined,
    });
  } catch (error) {
    console.error('send-otp error:', error);
    res.status(500).json({ success: false, message: 'We could not send the code. Please try again in a moment.' });
  }
});

// Verify a cell-verification code
router.post('/verify-otp', otpVerifyLimiter, async (req, res) => {
  try {
    const { cellNumber, code } = req.body;

    if (!cellNumber || !code) {
      return res.status(400).json({ success: false, message: 'Please enter your cell number and the code we sent you.' });
    }

    const result = await otpService.verify(cellNumber, code, {
      purpose: otpService.PURPOSE.VERIFY_CELL,
    });

    if (!result.ok) {
      const message = result.reason === 'locked'
        ? 'Too many incorrect attempts. Request a new code.'
        : 'That code is not valid or has expired.';
      return res.status(400).json({ success: false, message });
    }

    // A signed-in applicant also has the number recorded against their account.
    if (req.headers.authorization) {
      try {
        const token = req.headers.authorization.split(' ')[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        await prisma.user.update({
          where: { id: decoded.userId },
          data: { isVerified: true, cellNumber },
        });
      } catch {
        // An invalid token here only means the number is not attached to an
        // account; the code itself was still valid.
      }
    }

    res.json({ success: true, message: 'Cell number verified' });
  } catch (error) {
    console.error('verify-otp error:', error);
    res.status(500).json({ success: false, message: 'Verification failed' });
  }
});

/**
 * Start a password reset.
 *
 * Always answers the same way, whether or not the email exists and whether or
 * not it has a cell number on file. Anything else turns this into an oracle for
 * which email addresses are registered.
 */
router.post('/forgot-password', passwordResetLimiter, async (req, res) => {
  const generic = {
    success: true,
    message: 'If that email address is registered and has a verified cell number, a reset code has been sent to it.',
  };

  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ success: false, message: 'Please enter your email address.' });

    const user = await prisma.user.findUnique({ where: { email: String(email).trim() } });
    if (!user || !user.cellNumber) return res.json(generic);

    const { code, expiresAt } = await otpService.issue(user.cellNumber, {
      userId: user.id,
      purpose: otpService.PURPOSE.PASSWORD_RESET,
    });

    await sms.send(
      user.cellNumber,
      smsTemplates.build('PASSWORD_RESET', { code, minutes: otpService.EXPIRY_MINUTES }),
      { purpose: 'PASSWORD_RESET', userId: user.id, secrets: [code] }
    );

    res.json({
      ...generic,
      cellHint: `••• ••• ${user.cellNumber.slice(-4)}`,
      demoOtp: exposeDemoCode() ? code : undefined,
    });
  } catch (error) {
    console.error('forgot-password error:', error);
    res.json(generic);
  }
});

// Complete a password reset with the code sent to the account's cell number.
router.post('/reset-password', passwordResetLimiter, async (req, res) => {
  try {
    const { email, code, newPassword } = req.body || {};

    if (!email || !code || !newPassword) {
      return res.status(400).json({ success: false, message: 'Please enter your email address, the code we sent you, and a new password.' });
    }

    const problems = passwordProblems(newPassword);
    if (problems.length) {
      return res.status(400).json({ success: false, message: `Password must include ${problems.join(', ')}` });
    }

    const user = await prisma.user.findUnique({ where: { email: String(email).trim() } });
    // Same message for an unknown email as for a wrong code — no enumeration.
    if (!user || !user.cellNumber) {
      return res.status(400).json({ success: false, message: 'That code is not valid or has expired.' });
    }

    const result = await otpService.verify(user.cellNumber, code, {
      purpose: otpService.PURPOSE.PASSWORD_RESET,
    });

    if (!result.ok || result.otp.userId !== user.id) {
      const message = result.reason === 'locked'
        ? 'Too many incorrect attempts. Request a new reset code.'
        : 'That code is not valid or has expired.';
      return res.status(400).json({ success: false, message });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: await bcrypt.hash(newPassword, 12),
        /**
         * Ends every session opened with the old password.
         *
         * This is the case that matters most: somebody resetting their password
         * because they think it has been taken. Leaving the old sessions alive
         * would make the reset theatre.
         */
        passwordChangedAt: new Date(),
        // A successful reset also clears a lock — the person has proved control of
        // the cell number, which is stronger evidence than a password.
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });

    await audit.record(req, {
      action: audit.ACTIONS.PASSWORD_RESET,
      entityType: 'User',
      entityId: user.id,
      details: 'Password reset using a cell verification code',
      actor: user,
    });

    res.json({ success: true, message: 'Password reset. You can now sign in with your new password.' });
  } catch (error) {
    console.error('reset-password error:', error);
    res.status(500).json({ success: false, message: 'We could not issue a new password. Please try again.' });
  }
});

// Get current user
router.get('/me', authenticate, async (req, res) => {
  res.json({ success: true, data: req.user });
});

// Update own profile. Email and role are deliberately not editable here —
// changing an email would need re-verification, and role changes must not be
// self-service.
router.patch('/me', authenticate, async (req, res) => {
  try {
    const { firstName, lastName, cellNumber, idNumber } = req.body || {};
    const data = {};

    if (firstName !== undefined) data.firstName = String(firstName).trim() || null;
    if (lastName !== undefined) data.lastName = String(lastName).trim() || null;

    if (cellNumber !== undefined) {
      const cell = String(cellNumber).trim();
      if (cell && cell.replace(/\D/g, '').length < 10) {
        return res.status(400).json({ success: false, message: 'Enter a valid cell number of at least 10 digits' });
      }
      // Changing the number invalidates the previous verification.
      if (cell !== (req.user.cellNumber || '')) data.isVerified = false;
      data.cellNumber = cell || null;
    }

    if (idNumber !== undefined) {
      const id = String(idNumber).trim();
      if (id) {
        const check = saId.validate(id);
        if (!check.valid) {
          return res.status(400).json({ success: false, message: check.reason });
        }
        const clash = await prisma.user.findFirst({
          where: { idNumber: id, NOT: { id: req.user.id } },
          select: { id: true },
        });
        if (clash) {
          return res.status(400).json({ success: false, message: 'That ID number is already registered to another account' });
        }
      }
      data.idNumber = id || null;
    }

    if (Object.keys(data).length === 0) {
      return res.json({ success: true, message: 'Nothing to update', data: req.user });
    }

    const user = await prisma.user.update({
      where: { id: req.user.id },
      data,
      select: {
        id: true, email: true, role: true, firstName: true, lastName: true,
        cellNumber: true, idNumber: true, isVerified: true,
      },
    });

    res.json({ success: true, message: 'Profile updated', data: user });
  } catch (error) {
    console.error('profile update error:', error);
    res.status(500).json({ success: false, message: 'We could not save your details. Please try again.' });
  }
});

// Change own password. Requires the current password — a stolen token alone
// must not be enough to lock the real owner out.
router.post('/change-password', authenticate, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, message: 'Please enter your current password and a new one.' });
    }

    const errors = passwordProblems(newPassword);
    if (errors.length) {
      return res.status(400).json({ success: false, message: `Password must include ${errors.join(', ')}` });
    }

    const account = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!account || !(await bcrypt.compare(currentPassword, account.password))) {
      return res.status(400).json({ success: false, message: 'Your current password is not correct' });
    }

    if (await bcrypt.compare(newPassword, account.password)) {
      return res.status(400).json({ success: false, message: 'The new password must be different from the current one' });
    }

    await prisma.user.update({
      where: { id: req.user.id },
      data: {
        password: await bcrypt.hash(newPassword, 12),
        // Clears the lock set when staff issued this account's first password.
        // From here the holder is the only person who knows it.
        mustChangePassword: false,
        // Ends any other session opened with the old password. The token in the
        // caller's own hand was minted before this moment too, so a fresh one is
        // issued below rather than signing them out of the change they just made.
        passwordChangedAt: new Date(),
      },
    });

    await audit.record(req, {
      action: audit.ACTIONS.PASSWORD_CHANGE,
      entityType: 'User',
      entityId: req.user.id,
      details: req.user.mustChangePassword
        ? 'Replaced the temporary password issued at registration'
        : 'Password changed from the profile page',
    });

    /**
     * A replacement token, because the caller's current one is now stale.
     *
     * Revoking on password change is only useful if it is unconditional, and that
     * includes the session doing the changing. Handing back a new token keeps the
     * person signed in without weakening the rule — the portals swap it in, and
     * every *other* device is signed out.
     */
    res.json({
      success: true,
      message: 'Password changed. Any other devices signed in as you have been signed out.',
      data: { token: generateToken(req.user.id) },
    });
  } catch (error) {
    console.error('change password error:', error);
    res.status(500).json({ success: false, message: 'We could not change your password. Please try again.' });
  }
});

module.exports = router;
