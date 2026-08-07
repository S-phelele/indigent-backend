const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const prisma = require('./prisma');

/**
 * One-time codes for cell verification and password reset.
 *
 * Three properties this module is responsible for:
 *
 *  1. Codes are generated with crypto.randomInt, not Math.random. Math.random is
 *     seeded predictably and is not safe for anything an attacker benefits from
 *     guessing.
 *  2. Only a bcrypt hash is persisted. A plaintext column would let anyone with
 *     read access to the database authenticate as any cell number.
 *  3. Wrong guesses are counted and the code is burned after ATTEMPT_LIMIT, so a
 *     six-digit space cannot be walked through inside the code's lifetime.
 */

const ATTEMPT_LIMIT = parseInt(process.env.OTP_ATTEMPT_LIMIT || '5', 10);
const EXPIRY_MINUTES = parseInt(process.env.OTP_EXPIRY_MINUTES || '10', 10);

const PURPOSE = {
  VERIFY_CELL: 'VERIFY_CELL',
  PASSWORD_RESET: 'PASSWORD_RESET',
};

/** Six digits, uniformly distributed, from a cryptographic source. */
function generateCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * Issue a code, invalidating any earlier unused code for the same number and
 * purpose. Returns the plaintext once — it is never recoverable afterwards.
 */
async function issue(cellNumber, { userId = null, purpose = PURPOSE.VERIFY_CELL } = {}) {
  const code = generateCode();
  const expiresAt = new Date(Date.now() + EXPIRY_MINUTES * 60 * 1000);

  await prisma.otp.updateMany({
    where: { cellNumber, purpose, used: false },
    data: { used: true },
  });

  await prisma.otp.create({
    data: {
      cellNumber,
      codeHash: await bcrypt.hash(code, 10),
      purpose,
      expiresAt,
      userId,
    },
  });

  return { code, expiresAt };
}

/**
 * Check a code. Resolves to a reason rather than throwing so callers can decide
 * how much to tell the client — the routes deliberately collapse `invalid` and
 * `expired` into one message so nothing is leaked about which numbers are in use.
 */
async function verify(cellNumber, code, { purpose = PURPOSE.VERIFY_CELL } = {}) {
  if (!cellNumber || !code) return { ok: false, reason: 'invalid' };

  const otp = await prisma.otp.findFirst({
    where: { cellNumber, purpose, used: false },
    orderBy: { createdAt: 'desc' },
  });

  if (!otp) return { ok: false, reason: 'invalid' };

  if (otp.expiresAt <= new Date()) {
    await prisma.otp.update({ where: { id: otp.id }, data: { used: true } });
    return { ok: false, reason: 'expired' };
  }

  if (otp.attempts >= ATTEMPT_LIMIT) {
    await prisma.otp.update({ where: { id: otp.id }, data: { used: true } });
    return { ok: false, reason: 'locked' };
  }

  if (!(await bcrypt.compare(String(code), otp.codeHash))) {
    const updated = await prisma.otp.update({
      where: { id: otp.id },
      data: { attempts: { increment: 1 } },
    });
    // Burn it on the final wrong guess rather than leaving one more chance.
    if (updated.attempts >= ATTEMPT_LIMIT) {
      await prisma.otp.update({ where: { id: otp.id }, data: { used: true } });
      return { ok: false, reason: 'locked' };
    }
    return { ok: false, reason: 'invalid', remaining: ATTEMPT_LIMIT - updated.attempts };
  }

  await prisma.otp.update({ where: { id: otp.id }, data: { used: true } });
  return { ok: true, otp };
}

module.exports = { issue, verify, PURPOSE, ATTEMPT_LIMIT, EXPIRY_MINUTES };
