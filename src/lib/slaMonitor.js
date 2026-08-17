const prisma = require('./prisma');
const notify = require('./notify');
const names = require('./names');

/**
 * Scheduled service-level check.
 *
 * Every other notification in the system is triggered by a request — someone
 * registers, submits, or decides. A breach is different: it is caused by the
 * *absence* of action, so nothing would ever fire it. This is the one thing that
 * has to be checked on a timer.
 *
 * Two properties matter:
 *
 *  1. **Idempotence.** The check runs repeatedly, but an application must be
 *     reported once per escalation level. `Application.slaNotifiedLevel` records
 *     the highest level already announced.
 *  2. **Single execution.** With more than one instance every process would run
 *     the same sweep and notify several times. A Postgres advisory lock means
 *     only one wins; the others return immediately.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const SLA_DAYS = parseInt(process.env.SLA_DAYS || '14', 10);
const AT_RISK_WITHIN_DAYS = parseInt(process.env.SLA_AT_RISK_DAYS || '3', 10);

/** Arbitrary but stable key; any instance running this job uses the same one. */
const LOCK_KEY = 528071;

const LEVEL = { AT_RISK: 'AT_RISK', BREACHED: 'BREACHED' };

/** Rank so an escalation can move up but never back down. */
const RANK = { [LEVEL.AT_RISK]: 1, [LEVEL.BREACHED]: 2 };

/**
 * Which level an application is at, or null when it is comfortably on track.
 * Pure — this is the part worth unit testing.
 */
function levelFor(submittedAt, { now = new Date(), slaDays = SLA_DAYS, atRiskWithin = AT_RISK_WITHIN_DAYS } = {}) {
  if (!submittedAt) return null;
  const ageDays = Math.floor((now.getTime() - new Date(submittedAt).getTime()) / DAY_MS);
  const remaining = slaDays - ageDays;
  if (remaining < 0) return LEVEL.BREACHED;
  if (remaining <= atRiskWithin) return LEVEL.AT_RISK;
  return null;
}

/** True when `next` is a genuine escalation beyond what was already announced. */
function shouldAnnounce(alreadyAnnounced, next) {
  if (!next) return false;
  if (!alreadyAnnounced) return true;
  return (RANK[next] || 0) > (RANK[alreadyAnnounced] || 0);
}

function message(level, application, ageDays) {
  const ref = application.reference || application.id.slice(0, 8);
  const name = names.display(application) === 'Unnamed' ? 'An applicant' : names.display(application);

  if (level === LEVEL.BREACHED) {
    return {
      type: notify.TYPE.APPLICATION_BREACHED,
      title: 'Review target missed',
      body: `${ref} (${name}) has been waiting ${ageDays} days — past the ${SLA_DAYS}-day target.`,
    };
  }
  return {
    type: notify.TYPE.APPLICATION_AT_RISK,
    title: 'Application approaching the review target',
    body: `${ref} (${name}) has been waiting ${ageDays} days. ${Math.max(0, SLA_DAYS - ageDays)} day(s) remain.`,
  };
}

/**
 * Sweep pending applications and notify administrators about new escalations.
 *
 * `now` is injectable so the behaviour can be tested without waiting two weeks.
 */
async function sweep(client, now) {
  const pending = await client.application.findMany({
    where: { status: 'PENDING', submittedAt: { not: null } },
    select: {
      id: true, reference: true, names: true, surname: true,
      submittedAt: true, slaNotifiedLevel: true,
    },
  });

  const announced = [];

  for (const application of pending) {
    const level = levelFor(application.submittedAt, { now });
    if (!shouldAnnounce(application.slaNotifiedLevel, level)) continue;

    const ageDays = Math.floor((now.getTime() - new Date(application.submittedAt).getTime()) / DAY_MS);
    const { type, title, body } = message(level, application, ageDays);

    await notify.toAdmins({
      type,
      title,
      body,
      link: `/applications/${application.id}`,
      entityType: 'Application',
      entityId: application.id,
    });

    await client.application.update({
      where: { id: application.id },
      data: { slaNotifiedLevel: level },
    });

    announced.push({ id: application.id, reference: application.reference, level, ageDays });
  }

  return { skipped: false, checked: pending.length, announced };
}

async function run({ now = new Date(), useLock = true } = {}) {
  if (!useLock) return sweep(prisma, now);

  // The lock MUST be transaction-scoped.
  //
  // pg_try_advisory_lock is session-scoped, and Prisma hands out a different
  // pooled connection per query — so the lock and its unlock can land on
  // different sessions. The unlock then does nothing, the lock is stranded on an
  // idle connection, and every later sweep skips forever. Silent, and fatal to a
  // scheduled job.
  //
  // pg_try_advisory_xact_lock inside an interactive transaction pins one
  // connection and Postgres releases the lock when the transaction ends —
  // including on error, timeout or a crashed process.
  return prisma.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(${LOCK_KEY}::bigint) AS locked`;
      if (!rows?.[0]?.locked) {
        return { skipped: true, reason: 'another instance is already running the check', checked: 0, announced: [] };
      }
      return sweep(tx, now);
    },
    { timeout: 60000, maxWait: 10000 }
  );
}

/**
 * Start the timer. Returns a stop function so shutdown can clear it.
 * Set SLA_CHECK_INTERVAL_MINUTES to 0 to disable — useful in tests and when a
 * external scheduler drives the check instead.
 */
function schedule() {
  const minutes = parseInt(process.env.SLA_CHECK_INTERVAL_MINUTES ?? '60', 10);
  if (!minutes || minutes <= 0) {
    console.log('[sla] scheduled check disabled');
    return () => {};
  }

  const tick = async () => {
    try {
      const result = await run();
      if (!result.skipped && result.announced.length > 0) {
        console.log(`[sla] escalated ${result.announced.length} application(s):`,
          result.announced.map((a) => `${a.reference || a.id.slice(0, 8)}=${a.level}`).join(', '));
      }
    } catch (error) {
      // A failing sweep must not take the process down.
      console.error('[sla] check failed:', error.message);
    }
  };

  // Give the server a moment to finish starting before the first sweep.
  const initial = setTimeout(tick, 15000);
  const timer = setInterval(tick, minutes * 60 * 1000);
  timer.unref?.();
  console.log(`[sla] checking every ${minutes} minute(s) against a ${SLA_DAYS}-day target`);

  return () => { clearTimeout(initial); clearInterval(timer); };
}

module.exports = { run, schedule, levelFor, shouldAnnounce, LEVEL, SLA_DAYS, AT_RISK_WITHIN_DAYS };
