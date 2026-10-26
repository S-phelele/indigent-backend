/**
 * A ceiling on what the verification provider can bill in a day.
 *
 * Every automated check costs credits, and the route is reachable by anybody
 * with a verification login. A loop, a runaway script or a compromised account
 * could otherwise empty the balance in minutes. The cap is the cheapest control
 * that bounds the damage.
 *
 * Counted from `VerificationCheck.creditsUsed` over a rolling 24 hours, so it
 * needs no counter to keep in step and survives a restart. 0 (the default)
 * means no cap.
 *
 * It is checked *before* a call and compares what has been spent so far, so the
 * last check allowed can overshoot by its own cost. That is accepted: refusing
 * on a prediction would need a price list this code does not own.
 */

const DAILY_LIMIT = parseInt(process.env.VERIFY_DAILY_CREDIT_LIMIT || '0', 10) || 0;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Whether `used` credits leaves room under `limit`. A limit of 0 never refuses. */
function withinLimit(used, limit = DAILY_LIMIT) {
  if (!limit || limit <= 0) return true;
  return used < limit;
}

/** Credits billed to automated checks in the last 24 hours. */
async function usedToday(prisma, now = new Date()) {
  const { _sum } = await prisma.verificationCheck.aggregate({
    where: { automated: true, checkedAt: { gte: new Date(now.getTime() - DAY_MS) } },
    _sum: { creditsUsed: true },
  });
  return _sum.creditsUsed || 0;
}

module.exports = { DAILY_LIMIT, withinLimit, usedToday };
