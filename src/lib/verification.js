const prisma = require('./prisma');

/**
 * The verification stage, between submission and a decision.
 *
 * The register's whole credibility rests on this step. An indigent subsidy is
 * public money given away on the strength of a declaration, so somebody has to
 * check the declaration — against external records where possible, and against
 * the property itself where not.
 *
 * Three rules shape this module:
 *
 *  1. **Capture, verify and decide are different hands.** A verification officer
 *     recommends; only an administrator approves. Somebody who captured an
 *     application cannot be the one who verifies it.
 *  2. **A failed visit must be earned.** Non-access disqualifies only after
 *     three genuine attempts, each recorded with a date and an officer. That is
 *     a decision the municipality may have to defend.
 *  3. **Consent precedes verification.** A site visit without consent to enter,
 *     or a data match without consent to match, is not a shortcut — it is
 *     unlawful. The gate is in code, not in training.
 */

const MAX_VISIT_ATTEMPTS = parseInt(process.env.MAX_SITE_VISIT_ATTEMPTS || '3', 10);

/** Outcomes that mean the officer could not confirm the household. */
const FAILED_OUTCOMES = ['NO_ACCESS', 'OCCUPANT_ABSENT', 'ADDRESS_NOT_FOUND'];

const isFailure = (outcome) => FAILED_OUTCOMES.includes(outcome);

/**
 * Whether verification may lawfully begin.
 *
 * Returns the reasons it may not, phrased for the officer looking at the screen.
 */
function consentGate(application) {
  const blockers = [];
  if (!application.consentSiteVisit) {
    blockers.push('The applicant has not consented to a site visit.');
  }
  if (!application.consentDataMatching) {
    blockers.push('The applicant has not consented to external data checks.');
  }
  if (!application.declarationTruthful) {
    blockers.push('The sworn declaration has not been made.');
  }
  return { ok: blockers.length === 0, blockers };
}

/**
 * Whether this officer may verify this application.
 *
 * Somebody who captured an application may not verify their own work. This is
 * the single most important separation in the process — without it, one person
 * with a councillor login and a verification login can walk a fabricated
 * household from the door to an approval unchallenged.
 */
function separationOfDuties(application, officer) {
  if (officer.role === 'ADMIN') return { ok: true };
  if (application.capturedById && application.capturedById === officer.id) {
    return {
      ok: false,
      reason: 'You captured this application, so you cannot also verify it. Ask a colleague to take it.',
    };
  }
  return { ok: true };
}

/**
 * Recompute how many visits failed, and whether that is now disqualifying.
 *
 * Derived from the rows every time rather than incremented, so correcting a
 * mis-recorded visit corrects the count instead of leaving it permanently wrong.
 */
function visitState(siteVisits = []) {
  const completed = siteVisits.filter((v) => v.outcome !== 'SCHEDULED');
  const failed = completed.filter((v) => isFailure(v.outcome));
  const verified = completed.some((v) => v.outcome === 'VERIFIED');

  return {
    attempts: completed.length,
    failed: failed.length,
    verified,
    remaining: Math.max(0, MAX_VISIT_ATTEMPTS - failed.length),
    // A verified visit ends the matter regardless of earlier failures — somebody
    // who was out twice and home the third time has not failed anything.
    exhausted: !verified && failed.length >= MAX_VISIT_ATTEMPTS,
    nextAttempt: siteVisits.length + 1,
  };
}

/**
 * Everything an officer needs to see before recommending.
 *
 * Deliberately assembles the *contradictions* rather than a tidy summary: the
 * useful output of verification is the list of places where the declaration and
 * the evidence disagree.
 */
function assess(application, { checks = [], siteVisits = [], household = [] } = {}) {
  const concerns = [];

  const declared = Number(application.totalHouseholdIncome || 0);

  // Income found externally against income declared. The most valuable signal
  // the whole process produces.
  for (const check of checks) {
    if (check.amountFound === null || check.amountFound === undefined) continue;
    const found = Number(check.amountFound);
    if (found > declared * 1.2 && found - declared > 500) {
      concerns.push({
        severity: 'high',
        code: 'INCOME_MISMATCH',
        message: `${check.source} shows R${found.toLocaleString('en-ZA')} against a declared R${declared.toLocaleString('en-ZA')}.`,
      });
    }
  }

  for (const check of checks.filter((c) => c.outcome === 'FAIL')) {
    concerns.push({
      severity: 'high',
      code: 'CHECK_FAILED',
      message: `The ${check.source} check failed${check.findings ? `: ${check.findings}` : '.'}`,
    });
  }

  // Household members' own income, added up against what was declared for the
  // household as a whole.
  const memberIncome = household.reduce((sum, m) => sum + Number(m.monthlyIncome || 0), 0);
  if (memberIncome > declared && memberIncome - declared > 500) {
    concerns.push({
      severity: 'medium',
      code: 'HOUSEHOLD_INCOME_EXCEEDS_DECLARED',
      message: `Household members' own income totals R${memberIncome.toLocaleString('en-ZA')}, more than the R${declared.toLocaleString('en-ZA')} declared for the household.`,
    });
  }

  if (application.peopleOnProperty && household.length && household.length + 1 < application.peopleOnProperty) {
    concerns.push({
      severity: 'low',
      code: 'HOUSEHOLD_INCOMPLETE',
      message: `${application.peopleOnProperty} people were declared but only ${household.length + 1} are listed.`,
    });
  }

  if (application.ownsOtherProperty) {
    concerns.push({
      severity: 'medium',
      code: 'OTHER_PROPERTY',
      message: `Another property was declared${application.otherPropertyDetails ? `: ${application.otherPropertyDetails}` : '.'} Confirm it does not disqualify.`,
    });
  }

  if (application.tenure === 'TENANT') {
    concerns.push({
      severity: 'low',
      code: 'TENANT',
      message: 'Tenant — only the service charges billed to them may be relieved, not rates.',
    });
  }

  const visits = visitState(siteVisits);
  if (visits.exhausted) {
    concerns.push({
      severity: 'high',
      code: 'VISITS_EXHAUSTED',
      message: `${visits.failed} site visits failed. Policy allows ${MAX_VISIT_ATTEMPTS}.`,
    });
  }

  const sourcesChecked = new Set(checks.map((c) => c.source));

  return {
    concerns,
    highest: concerns.some((c) => c.severity === 'high')
      ? 'high'
      : concerns.some((c) => c.severity === 'medium') ? 'medium' : concerns.length ? 'low' : 'none',
    visits,
    checksRun: checks.length,
    sourcesChecked: [...sourcesChecked],
    siteVerified: visits.verified,
    // What a thorough verification would still cover. Not enforced — an officer
    // may have good reason to skip one — but shown so skipping is deliberate.
    outstanding: [
      ...(visits.verified || visits.exhausted ? [] : ['A site visit has not confirmed the household.']),
      ...(sourcesChecked.has('SASSA') ? [] : ['No SASSA check has been recorded.']),
      ...(sourcesChecked.has('SARS') || sourcesChecked.has('UIF') ? [] : ['No SARS or UIF check has been recorded.']),
    ],
  };
}

/**
 * Recalculate and persist the derived verification fields.
 *
 * Called after any visit or check changes, so `failedVisitCount` and
 * `verificationStage` never drift from the rows they describe.
 */
async function refresh(applicationId, tx = prisma) {
  const application = await tx.application.findUnique({
    where: { id: applicationId },
    select: {
      id: true, status: true, verificationStage: true, recommendation: true,
      siteVisits: { select: { outcome: true } },
      checks: { select: { id: true } },
    },
  });
  if (!application) return null;

  const visits = visitState(application.siteVisits);

  let stage = application.verificationStage;
  if (application.recommendation) stage = 'RECOMMENDED';
  else if (visits.attempts > 0 || application.checks.length > 0) stage = 'IN_VERIFICATION';

  return tx.application.update({
    where: { id: applicationId },
    data: { failedVisitCount: visits.failed, verificationStage: stage },
  });
}

module.exports = {
  MAX_VISIT_ATTEMPTS,
  FAILED_OUTCOMES,
  isFailure,
  consentGate,
  separationOfDuties,
  visitState,
  assess,
  refresh,
};
