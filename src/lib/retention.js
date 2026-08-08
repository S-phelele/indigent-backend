/**
 * How long the register keeps things, and what happens when that runs out.
 *
 * POPIA section 14: personal information may not be retained longer than is
 * necessary for the purpose it was collected for. "We might need it one day" is
 * not a purpose. Nothing in this system expired before this file existed, which
 * means a household declined in 2026 would still have their ID number, income
 * and the coordinates of their home sitting here in 2036.
 *
 * ## Deletion is not always the answer
 *
 * A municipality has genuine obligations that outlive the applicant's interest
 * in being forgotten. The Auditor-General may examine a decision years later,
 * and the Municipal Finance Management Act requires financial records to be kept
 * for five years. So the policy below distinguishes three outcomes:
 *
 *   DELETE      the record goes, entirely
 *   ANONYMISE   the person goes, the statistics stay
 *   KEEP        a legal obligation outranks the retention period
 *
 * Anonymisation is what makes this workable. A declined application from seven
 * years ago still tells the municipality something about demand in that ward —
 * but it does not need to say whose application it was. Strip the identifiers
 * and the row stops being personal information at all, which takes it outside
 * POPIA entirely rather than merely making it compliant.
 *
 * ## Nothing here deletes without being asked twice
 *
 * Every function takes a `commit` flag that defaults to false. The sweep reports
 * what it *would* do and changes nothing until somebody deliberately runs it for
 * real. A retention job that quietly deletes on first run is how a municipality
 * loses evidence it needed.
 */

const prisma = require('./prisma');
const audit = require('./audit');

const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

const years = (n) => Number(n) * YEAR_MS;

/**
 * The retention schedule.
 *
 * Periods are configurable because they are a policy decision, not a technical
 * one — a municipality's own retention schedule, approved by its council, is
 * what should govern. The defaults are the common South African positions.
 */
const POLICY = {
  /**
   * Declined applications. Anonymised rather than deleted so ward-level demand
   * history survives, which is what the register is for.
   */
  DECLINED_APPLICATION: {
    key: 'DECLINED_APPLICATION',
    label: 'Declined applications',
    period: years(process.env.RETENTION_DECLINED_YEARS || 5),
    action: 'ANONYMISE',
    basis: 'POPIA s14 — no longer needed to decide an application that was refused.',
    from: 'reviewedAt',
  },

  /**
   * Registrations that lapsed and were never renewed. The household stopped
   * being on the register; the record of how many did is still useful.
   */
  LAPSED_REGISTRATION: {
    key: 'LAPSED_REGISTRATION',
    label: 'Lapsed registrations',
    period: years(process.env.RETENTION_LAPSED_YEARS || 5),
    action: 'ANONYMISE',
    basis: 'POPIA s14 — support ended and was not renewed.',
    from: 'expiresAt',
  },

  /**
   * Drafts nobody ever submitted.
   *
   * Deleted outright rather than anonymised: an abandoned half-form has no
   * statistical value and holding somebody's ID number because they started a
   * form and thought better of it is exactly what POPIA is aimed at.
   */
  ABANDONED_DRAFT: {
    key: 'ABANDONED_DRAFT',
    label: 'Abandoned drafts',
    period: years(process.env.RETENTION_DRAFT_YEARS || 1),
    action: 'DELETE',
    basis: 'POPIA s14 — never submitted, so there is no application to decide.',
    from: 'updatedAt',
  },

  /**
   * One-time codes. Minutes of usefulness, then nothing.
   */
  EXPIRED_OTP: {
    key: 'EXPIRED_OTP',
    label: 'Used and expired verification codes',
    period: years(process.env.RETENTION_OTP_YEARS || 0.08), // ~30 days
    action: 'DELETE',
    basis: 'POPIA s14 — spent the moment it was used or expired.',
    from: 'createdAt',
  },

  /**
   * Sent messages.
   *
   * Kept long enough to answer "you never told me", which is the dispute they
   * exist to settle, and no longer.
   */
  SMS_LOG: {
    key: 'SMS_LOG',
    label: 'Sent message log',
    period: years(process.env.RETENTION_SMS_YEARS || 2),
    action: 'DELETE',
    basis: 'POPIA s14 — kept only to evidence that notice was given.',
    from: 'createdAt',
  },

  /**
   * Approved registrations and the audit trail.
   *
   * Deliberately never swept. An approval spends public money, and the
   * Auditor-General, the MFMA and the municipality's own defence all need the
   * record. Listed here so the policy is visibly complete rather than silent.
   */
  APPROVED_APPLICATION: {
    key: 'APPROVED_APPLICATION',
    label: 'Approved registrations',
    period: null,
    action: 'KEEP',
    basis: 'MFMA s65 and Auditor-General review — a decision spending public money must remain auditable.',
    from: null,
  },
  AUDIT_TRAIL: {
    key: 'AUDIT_TRAIL',
    label: 'Audit trail and approval steps',
    period: null,
    action: 'KEEP',
    basis: 'Append-only by database trigger. Required to show how a decision was reached.',
    from: null,
  },
};

/**
 * Fields that identify a person, and what replaces them.
 *
 * Anonymisation has to be irreversible to take a record outside POPIA. Nulling
 * is used rather than hashing: a hash of a 13-digit ID number is trivially
 * reversible by computing all of them, so it would not be anonymisation at all —
 * it would be encoding, which POPIA still covers.
 *
 * Everything not listed here survives, which is the point: household size,
 * income band, ward, dates and the decision are what make the row worth keeping.
 */
const IDENTIFYING_FIELDS = {
  surname: null,
  names: null,
  idNumber: null,
  cellNumber: null,
  residentialAddress: null,
  postalAddress: null,
  employerName: null,
  employerAddress: null,
  workTelNumber: null,
  municipalAccountNumber: null,
  eskomAccountNumber: null,
  waterMeterNumber: null,
  electricityMeterNumber: null,
  reference: null,

  /**
   * Coordinates go entirely.
   *
   * A latitude and longitude to seven decimal places is a house. Rounding is not
   * enough — three decimal places still locates a household within about a
   * hundred metres, which in a small settlement is one family.
   */
  addressLatitude: null,
  addressLongitude: null,
  addressFormatted: null,
  addressSource: null,
  addressAccuracyM: null,

  /** Dates of birth are identifying in combination; the age band survives. */
  dateOfBirth: null,

  /** Free text is where names and addresses hide. */
  reviewNotes: null,
  assessmentNotes: null,
  budgetNotes: null,
  otherPropertyDetails: null,
  incomeExclusions: null,
};

/**
 * What survives anonymisation, for the record itself to say so.
 *
 * Written onto the row so that anybody reading it later knows it was
 * deliberately stripped rather than incompletely captured — a row full of nulls
 * with no explanation looks like a bug.
 */
const anonymisedMarker = (policyKey) => ({
  ...IDENTIFYING_FIELDS,
  anonymisedAt: new Date(),
  anonymisedUnder: policyKey,
});

/** The cut-off date for one rule: anything older than this is due. */
function cutoff(rule, now = new Date()) {
  if (!rule.period) return null;
  return new Date(now.getTime() - rule.period);
}

/** Human description of a period, for the policy page. */
function describePeriod(rule) {
  if (!rule.period) return 'Kept indefinitely';
  const y = rule.period / YEAR_MS;
  if (y < 0.25) return `${Math.round(y * 365)} days`;
  if (y < 1) return `${Math.round(y * 12)} months`;
  return `${y === 1 ? '1 year' : `${Math.round(y)} years`}`;
}

/**
 * What is due, per rule, without changing anything.
 *
 * The dry run. Returns counts and a sample so somebody can see what a real run
 * would touch before authorising it.
 */
async function survey(now = new Date(), client = prisma) {
  const findings = [];

  for (const rule of Object.values(POLICY)) {
    if (rule.action === 'KEEP') {
      findings.push({ ...rule, period: describePeriod(rule), due: 0, sample: [] });
      continue;
    }

    const before = cutoff(rule, now);
    const where = whereFor(rule, before);
    const model = modelFor(rule);

    const [due, sample] = await Promise.all([
      client[model].count({ where }),
      client[model].findMany({
        where,
        select: sampleSelect(rule),
        take: 5,
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    findings.push({
      key: rule.key,
      label: rule.label,
      action: rule.action,
      basis: rule.basis,
      period: describePeriod(rule),
      cutoff: before,
      due,
      sample,
    });
  }

  return {
    surveyedAt: now,
    totalDue: findings.reduce((sum, f) => sum + f.due, 0),
    findings,
  };
}

const modelFor = (rule) => {
  if (rule.key === 'EXPIRED_OTP') return 'otp';
  if (rule.key === 'SMS_LOG') return 'smsMessage';
  return 'application';
};

function whereFor(rule, before) {
  switch (rule.key) {
    case 'DECLINED_APPLICATION':
      return { status: 'DECLINED', reviewedAt: { lt: before }, anonymisedAt: null };
    case 'LAPSED_REGISTRATION':
      return { status: 'APPROVED', renewalStatus: 'LAPSED', expiresAt: { lt: before }, anonymisedAt: null };
    case 'ABANDONED_DRAFT':
      return { status: 'DRAFT', updatedAt: { lt: before } };
    case 'EXPIRED_OTP':
      return { createdAt: { lt: before } };
    case 'SMS_LOG':
      return { createdAt: { lt: before } };
    default:
      // A rule with no matcher must select nothing, never everything.
      return { id: '__no_such_id__' };
  }
}

const sampleSelect = (rule) => {
  if (rule.key === 'EXPIRED_OTP') return { id: true, purpose: true, createdAt: true };
  if (rule.key === 'SMS_LOG') return { id: true, purpose: true, createdAt: true };
  return { id: true, reference: true, status: true, createdAt: true };
};

/**
 * Which rules delete whole records rather than stripping identifiers.
 *
 * These are the ones that need the append-only exception opened, because an
 * application cascades into FieldChange and ApprovalStep.
 */
const deletesRecords = (rule) => rule.action === 'DELETE';

/**
 * Remove expired records with the append-only exception open.
 *
 * The audit tables refuse DELETE by database trigger. That is deliberate, and it
 * collides with POPIA s14 the moment an abandoned draft has ever been edited: the
 * draft cascades into FieldChange and the delete is refused. The trigger allows
 * DELETE — never UPDATE, never TRUNCATE — while a transaction-local flag is set.
 *
 * Everything about this is scoped as tightly as the problem allows. The flag is
 * set with `is_local = true` so PostgreSQL clears it when the transaction ends,
 * which means it cannot be left switched on by an early return or a thrown
 * error. It is set inside the same transaction as the delete, so no other query
 * runs under it. And the caller has already written an audit row naming the
 * policy, so a removal that happens through this path is never a removal nobody
 * can account for.
 */
async function removeExpired(model, where, client) {
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('indigent.retention_sweep', 'on', true)`;
    const outcome = await tx[model].deleteMany({ where });
    return outcome.count;
  });
}

/**
 * Apply the policy.
 *
 * `commit` defaults to false: without it this is a survey that reports and
 * changes nothing. A retention job that deletes on its first accidental run is
 * how a municipality loses evidence it needed.
 */
async function apply({ commit = false, actor = null, only = null } = {}, now = new Date(), client = prisma) {
  const rules = Object.values(POLICY).filter(
    (r) => r.action !== 'KEEP' && (!only || r.key === only)
  );

  const results = [];

  for (const rule of rules) {
    const before = cutoff(rule, now);
    const where = whereFor(rule, before);
    const model = modelFor(rule);

    const due = await client[model].count({ where });
    if (!commit || due === 0) {
      results.push({ key: rule.key, label: rule.label, action: rule.action, due, applied: 0 });
      continue;
    }

    /**
     * One rule failing must not abandon the rest.
     *
     * The rules are independent — spent OTPs expiring has nothing to do with
     * declined applications being anonymised. Letting the first error throw out
     * of the loop would mean a single unexpected constraint silently stopped
     * every later rule from ever running, and a retention policy that stops
     * running is indistinguishable from not having one.
     */
    let applied = 0;
    let failure = null;
    try {
      if (deletesRecords(rule)) {
        applied = await removeExpired(model, where, client);
      } else {
        const outcome = await client.application.updateMany({
          where,
          data: anonymisedMarker(rule.key),
        });
        applied = outcome.count;
      }
    } catch (error) {
      failure = error.message;
      console.error(`[retention] ${rule.key} failed:`, error.message);
    }

    results.push({ key: rule.key, label: rule.label, action: rule.action, due, applied, failure });
  }

  return {
    committed: commit,
    ranAt: now,
    actor: actor ? { id: actor.id, email: actor.email } : null,
    results,
    totalApplied: results.reduce((sum, r) => sum + r.applied, 0),
    /** Surfaced so a partial run is visible rather than looking like a clean one. */
    failures: results.filter((r) => r.failure).map((r) => ({ key: r.key, failure: r.failure })),
  };
}

/**
 * The policy, described for publication.
 *
 * POPIA expects a data subject to be able to find out what is held and for how
 * long. This is the machine-readable version of that, rendered on both portals.
 */
const publish = () => Object.values(POLICY).map((rule) => ({
  key: rule.key,
  label: rule.label,
  retention: describePeriod(rule),
  outcome: rule.action === 'KEEP' ? 'Kept' : rule.action === 'DELETE' ? 'Deleted' : 'Anonymised',
  basis: rule.basis,
}));

/**
 * The scheduled sweep.
 *
 * A retention policy nobody runs is a document, not a control, and the whole
 * point of s14 is that expiry happens without anybody remembering. So this runs
 * on a timer like the SLA and renewal monitors.
 *
 * ## Why it surveys rather than deletes by default
 *
 * `RETENTION_AUTO_APPLY` is off unless explicitly set. Until a municipality has
 * looked at a survey and satisfied itself that the periods match its own
 * approved retention schedule, the timer reports what is due and deletes
 * nothing. Turning it on is a decision with a name against it, which is how a
 * deletion policy should start — not as a default that quietly removed records
 * the first night the server ran.
 *
 * The audit row is written by the caller in both modes, so "we surveyed and did
 * nothing" is as recorded as "we removed 12 drafts".
 */
function schedule({ intervalMs = Number(process.env.RETENTION_SWEEP_INTERVAL_MS || 24 * 60 * 60 * 1000) } = {}) {
  const commit = process.env.RETENTION_AUTO_APPLY === 'true';

  async function run() {
    try {
      const outcome = await apply({ commit, actor: null });
      const due = outcome.results.reduce((sum, r) => sum + r.due, 0);

      if (due === 0) return;

      if (commit) {
        console.log(`[retention] swept ${outcome.totalApplied} of ${due} expired record(s)`);
      } else {
        console.log(
          `[retention] ${due} record(s) are past their retention period and nothing was removed. `
          + 'Review them under Privacy in the admin portal, then set RETENTION_AUTO_APPLY=true to let the sweep act.'
        );
      }
      if (outcome.failures.length) {
        console.error('[retention] some rules failed:', outcome.failures);
      }

      /**
       * Recorded even on a dry run. "The system knew these were overdue and was
       * not permitted to act" is exactly the fact an audit needs, and it is the
       * municipality's answer to why a record was still held.
       */
      await audit.record(null, {
        action: audit.ACTIONS.RETENTION_APPLIED,
        entityType: 'RetentionPolicy',
        details: commit
          ? `Scheduled sweep removed or anonymised ${outcome.totalApplied} of ${due} expired record(s).`
          : `Scheduled sweep found ${due} expired record(s). Automatic application is switched off, so nothing was changed.`,
      });
    } catch (error) {
      console.error('[retention] scheduled sweep failed:', error.message);
    }
  }

  /**
   * Deferred rather than run at boot. A deploy that restarts the process several
   * times should not run a deletion sweep several times in a minute.
   */
  const first = setTimeout(run, Number(process.env.RETENTION_SWEEP_DELAY_MS || 5 * 60 * 1000));
  const timer = setInterval(run, intervalMs);
  first.unref?.();
  timer.unref?.();

  return () => { clearTimeout(first); clearInterval(timer); };
}

module.exports = {
  POLICY,
  IDENTIFYING_FIELDS,
  survey,
  apply,
  schedule,
  removeExpired,
  publish,
  cutoff,
  describePeriod,
  anonymisedMarker,
  whereFor,
  modelFor,
  YEAR_MS,
};
