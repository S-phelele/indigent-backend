const saId = require('./saIdNumber');
const functioning = require('./functioning');

/**
 * Statistics for the administrator's analytics page.
 *
 * Everything here is a pure function over rows already fetched. That keeps the
 * arithmetic testable without a database, and keeps the route file about
 * fetching rather than about what a median is.
 *
 * The bias throughout is towards figures a municipal manager can act on. "How
 * many applications this month" is a number; "half of your pending queue is
 * older than the service standard, and it is concentrated in two wards" is a
 * decision. Where a choice existed, this file computes the second kind.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Distribution helpers
// ---------------------------------------------------------------------------

/**
 * Percentile by nearest rank on a sorted copy.
 *
 * The median matters more than the mean for turnaround: one application that sat
 * for eight months while somebody chased a death certificate drags an average
 * into meaninglessness, but leaves the median where the typical case actually is.
 */
function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

const mean = (values) => {
  const usable = values.filter(Number.isFinite);
  return usable.length ? usable.reduce((a, b) => a + b, 0) / usable.length : null;
};

const round1 = (n) => (n === null || n === undefined ? null : Math.round(n * 10) / 10);

/** Whole days between two instants, never negative. */
const daysBetween = (from, to) => Math.max(0, (new Date(to) - new Date(from)) / DAY_MS);

// ---------------------------------------------------------------------------
// Turnaround
// ---------------------------------------------------------------------------

/**
 * How long decided applications actually took, against the service standard.
 *
 * `withinSla` is the headline: the proportion of decisions made inside the
 * promised window. It is the number that belongs in a council report.
 */
function turnaround(decided, slaDays) {
  const durations = decided
    .filter((a) => a.submittedAt && a.reviewedAt)
    .map((a) => daysBetween(a.submittedAt, a.reviewedAt));

  const within = durations.filter((d) => d <= slaDays).length;

  return {
    decided: durations.length,
    medianDays: round1(percentile(durations, 50)),
    averageDays: round1(mean(durations)),
    // The slow tail. A good median with a terrible p90 means most people are
    // fine and a specific group is being badly failed.
    p90Days: round1(percentile(durations, 90)),
    fastestDays: round1(durations.length ? Math.min(...durations) : null),
    slowestDays: round1(durations.length ? Math.max(...durations) : null),
    withinSla: within,
    withinSlaPercent: durations.length ? Math.round((within / durations.length) * 100) : null,
    breached: durations.length - within,
  };
}

/**
 * How long the applications still waiting have been waiting.
 *
 * Bucketed rather than averaged, because the action differs per bucket: the last
 * two are the queue that is already failing people.
 */
function pendingAgeing(pending, slaDays, now = new Date()) {
  const buckets = [
    { key: '0-7', label: '0–7 days', min: 0, max: 7, count: 0 },
    { key: '8-14', label: '8–14 days', min: 8, max: 14, count: 0 },
    { key: '15-30', label: '15–30 days', min: 15, max: 30, count: 0 },
    { key: '30+', label: 'Over 30 days', min: 31, max: Infinity, count: 0 },
  ];

  let overdue = 0;
  let oldestDays = 0;

  for (const app of pending) {
    if (!app.submittedAt) continue;
    const age = Math.floor(daysBetween(app.submittedAt, now));
    oldestDays = Math.max(oldestDays, age);
    if (age > slaDays) overdue += 1;
    const bucket = buckets.find((b) => age >= b.min && age <= b.max);
    if (bucket) bucket.count += 1;
  }

  return {
    total: pending.length,
    buckets,
    overdue,
    overduePercent: pending.length ? Math.round((overdue / pending.length) * 100) : 0,
    oldestDays,
  };
}

// ---------------------------------------------------------------------------
// Who is applying
// ---------------------------------------------------------------------------

const AGE_BANDS = [
  { key: '18-29', label: '18–29', min: 18, max: 29 },
  { key: '30-44', label: '30–44', min: 30, max: 44 },
  { key: '45-59', label: '45–59', min: 45, max: 59 },
  { key: '60-74', label: '60–74', min: 60, max: 74 },
  { key: '75+', label: '75 and over', min: 75, max: 200 },
];

/**
 * Age and gender, derived from the ID number rather than asked for separately.
 *
 * Both are already encoded in the first ten digits, so asking again would only
 * add a field to contradict. Anything that fails validation is counted as
 * unknown, never guessed.
 */
function demographics(applications, now = new Date()) {
  const ages = AGE_BANDS.map((b) => ({ ...b, count: 0 }));
  const gender = { FEMALE: 0, MALE: 0, UNKNOWN: 0 };
  let unknownAge = 0;
  const ageValues = [];

  for (const app of applications) {
    const check = app.idNumber ? saId.validate(app.idNumber) : { valid: false };
    if (!check.valid) {
      unknownAge += 1;
      gender.UNKNOWN += 1;
      continue;
    }

    gender[check.gender] = (gender[check.gender] || 0) + 1;

    const years = Math.floor((now - check.birthDate) / (365.25 * DAY_MS));
    ageValues.push(years);
    const band = ages.find((b) => years >= b.min && years <= b.max);
    if (band) band.count += 1;
    else unknownAge += 1;
  }

  return {
    ageBands: ages,
    unknownAge,
    medianAge: percentile(ageValues, 50),
    gender: [
      { key: 'FEMALE', label: 'Female', count: gender.FEMALE },
      { key: 'MALE', label: 'Male', count: gender.MALE },
      { key: 'UNKNOWN', label: 'Not determined', count: gender.UNKNOWN },
    ],
  };
}

/** Household size and the presence of dependants, which drive the relief tier. */
function households(applications) {
  const sizes = applications.map((a) => a.peopleOnProperty).filter((n) => Number.isFinite(n) && n > 0);
  const bands = [
    { key: '1', label: '1 person', min: 1, max: 1, count: 0 },
    { key: '2-3', label: '2–3 people', min: 2, max: 3, count: 0 },
    { key: '4-5', label: '4–5 people', min: 4, max: 5, count: 0 },
    { key: '6-8', label: '6–8 people', min: 6, max: 8, count: 0 },
    { key: '9+', label: '9 or more', min: 9, max: Infinity, count: 0 },
  ];
  for (const size of sizes) {
    const band = bands.find((b) => size >= b.min && size <= b.max);
    if (band) band.count += 1;
  }

  return {
    bands,
    recorded: sizes.length,
    medianSize: percentile(sizes, 50),
    averageSize: round1(mean(sizes)),
    withChildren: applications.filter((a) => (a.childrenUnder18 || 0) > 0).length,
    withPensioners: applications.filter((a) => (a.pensionersOver60 || 0) > 0).length,
    totalPeople: sizes.reduce((a, b) => a + b, 0),
  };
}

/**
 * Declared household income against the qualifying threshold.
 *
 * Prisma returns Decimal columns as strings, so everything is coerced before it
 * is compared — a string comparison here would silently sort "9000" below "10000".
 */
function income(applications, threshold) {
  const values = applications
    .map((a) => (a.totalHouseholdIncome === null || a.totalHouseholdIncome === undefined
      ? null
      : Number(a.totalHouseholdIncome)))
    .filter((n) => Number.isFinite(n));

  const step = Math.max(1000, Math.round(threshold / 4 / 500) * 500);
  const bands = [
    { key: 'none', label: 'No income declared', min: 0, max: 0, count: 0 },
    { key: 'b1', label: `R1 – R${step}`, min: 1, max: step, count: 0 },
    { key: 'b2', label: `R${step + 1} – R${step * 2}`, min: step + 1, max: step * 2, count: 0 },
    { key: 'b3', label: `R${step * 2 + 1} – R${threshold}`, min: step * 2 + 1, max: threshold, count: 0 },
    { key: 'over', label: `Over R${threshold}`, min: threshold + 1, max: Infinity, count: 0 },
  ];

  for (const value of values) {
    const band = bands.find((b) => value >= b.min && value <= b.max);
    if (band) band.count += 1;
  }

  const above = values.filter((v) => v > threshold).length;

  return {
    bands,
    recorded: values.length,
    threshold,
    medianIncome: percentile(values, 50),
    averageIncome: round1(mean(values)),
    // Applications declaring more than the qualifying figure. Not necessarily
    // wrong — a large household is assessed per person — but it is the set a
    // reviewer should be looking at, so it is surfaced rather than buried.
    aboveThreshold: above,
    aboveThresholdPercent: values.length ? Math.round((above / values.length) * 100) : 0,
  };
}

// ---------------------------------------------------------------------------
// Where the work comes from, and how it lands
// ---------------------------------------------------------------------------

const CHANNEL_LABELS = {
  SELF: 'Applied themselves',
  COUNCILLOR: 'Captured by a councillor',
  ADMIN: 'Captured at the municipal office',
};

/**
 * Self-service against assisted capture, with the outcome of each.
 *
 * The comparison is the point. If councillor-captured applications are approved
 * far more or far less often than self-service ones, that is either a training
 * problem or a targeting success, and either way somebody should know.
 */
function channels(applications) {
  const groups = new Map();

  for (const app of applications) {
    const key = app.captureChannel || 'SELF';
    if (!groups.has(key)) {
      groups.set(key, { key, label: CHANNEL_LABELS[key] || key, total: 0, approved: 0, declined: 0, pending: 0, draft: 0 });
    }
    const group = groups.get(key);
    group.total += 1;
    if (app.status === 'APPROVED') group.approved += 1;
    else if (app.status === 'DECLINED') group.declined += 1;
    else if (app.status === 'PENDING') group.pending += 1;
    else group.draft += 1;
  }

  return [...groups.values()]
    .map((g) => ({
      ...g,
      decided: g.approved + g.declined,
      approvalRate: g.approved + g.declined > 0 ? Math.round((g.approved / (g.approved + g.declined)) * 100) : null,
    }))
    .sort((a, b) => b.total - a.total);
}

/**
 * Geographic spread.
 *
 * Ward comes from the capturing councillor. For self-service applications there
 * is no ward, so the suburb is taken from the geocoder's formatted address where
 * one was resolved — which is exactly what the address feature was for.
 */
function geography(applications, { limit = 8 } = {}) {
  const wards = new Map();
  const suburbs = new Map();

  for (const app of applications) {
    if (app.capturedWard) {
      wards.set(app.capturedWard, (wards.get(app.capturedWard) || 0) + 1);
    }

    const suburb = suburbFrom(app);
    if (suburb) suburbs.set(suburb, (suburbs.get(suburb) || 0) + 1);
  }

  const top = (map) => [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);

  return {
    wards: top(wards),
    suburbs: top(suburbs),
    withCoordinates: applications.filter((a) => a.addressLatitude !== null && a.addressLatitude !== undefined).length,
    withoutAddress: applications.filter((a) => !a.residentialAddress && !a.addressFormatted).length,
  };
}

/**
 * Best guess at a suburb.
 *
 * A geocoded address is comma-separated and reliable, so the second component is
 * taken. A hand-typed address is not, so it is left alone rather than chopped
 * into a misleading label.
 */
function suburbFrom(app) {
  if (app.addressFormatted) {
    const parts = String(app.addressFormatted).split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 3) return parts[1];
  }
  return null;
}

/**
 * Which documents actually hold applications up.
 *
 * Counted only on applications still in draft, because that is where the delay
 * is happening. A rejection count is kept separately: a slot that is frequently
 * uploaded and then refused signals unclear guidance, not a missing document.
 */
function documentBottlenecks(documents) {
  const bySlot = new Map();

  for (const doc of documents) {
    if (!bySlot.has(doc.name)) {
      bySlot.set(doc.name, {
        name: doc.name,
        type: doc.type,
        importance: doc.importance,
        requirementGroup: doc.requirementGroup,
        outstanding: 0,
        uploaded: 0,
        rejected: 0,
      });
    }
    const slot = bySlot.get(doc.name);
    if (doc.status === 'Uploaded') slot.uploaded += 1;
    else if (doc.status === 'Rejected') slot.rejected += 1;
    else slot.outstanding += 1;
  }

  return [...bySlot.values()]
    .map((s) => {
      const attempted = s.uploaded + s.rejected;
      return { ...s, rejectionRate: attempted ? Math.round((s.rejected / attempted) * 100) : null };
    })
    .sort((a, b) => b.outstanding - a.outstanding);
}

/**
 * Registration through to decision.
 *
 * Each step is a count of people who got that far. The drop between "registered"
 * and "started an application" is the one worth watching — it is people who
 * arrived, met the form, and left.
 */
function funnel({ registered, started, submitted, decided, approved }) {
  const steps = [
    { key: 'registered', label: 'Registered', count: registered },
    { key: 'started', label: 'Started an application', count: started },
    { key: 'submitted', label: 'Submitted', count: submitted },
    { key: 'decided', label: 'Decided', count: decided },
    { key: 'approved', label: 'Approved', count: approved },
  ];

  return steps.map((step, i) => ({
    ...step,
    percentOfStart: registered ? Math.round((step.count / registered) * 100) : 0,
    // How many were lost at this step specifically, as opposed to overall.
    dropFromPrevious: i === 0 ? null : steps[i - 1].count - step.count,
  }));
}

/** Per-councillor capture volume and how their captures fared. */
function councillorPerformance(applications, councillors) {
  const byId = new Map(councillors.map((c) => [
    c.id,
    {
      id: c.id,
      name: [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email,
      ward: c.ward,
      isActive: c.isActive,
      captured: 0,
      submitted: 0,
      approved: 0,
      declined: 0,
      draft: 0,
    },
  ]));

  for (const app of applications) {
    const row = byId.get(app.capturedById);
    if (!row) continue;
    row.captured += 1;
    if (app.status === 'DRAFT') row.draft += 1;
    else row.submitted += 1;
    if (app.status === 'APPROVED') row.approved += 1;
    if (app.status === 'DECLINED') row.declined += 1;
  }

  return [...byId.values()]
    .map((r) => ({
      ...r,
      approvalRate: r.approved + r.declined > 0 ? Math.round((r.approved / (r.approved + r.declined)) * 100) : null,
      // Captures started and never submitted. A high figure usually means being
      // turned away at the door, not laziness — but it needs asking about.
      unfinishedPercent: r.captured ? Math.round((r.draft / r.captured) * 100) : 0,
    }))
    .sort((a, b) => b.captured - a.captured);
}

/**
 * Disability prevalence, using the Washington Group identifier.
 *
 * Reported against those who answered the six questions rather than against
 * everybody, so the figure is a rate and not an artefact of how many people
 * have been asked so far.
 */
function disability(applications = []) {
  return functioning.prevalence(applications);
}

module.exports = {
  disability,
  percentile,
  mean,
  daysBetween,
  turnaround,
  pendingAgeing,
  demographics,
  households,
  income,
  channels,
  geography,
  suburbFrom,
  documentBottlenecks,
  funnel,
  councillorPerformance,
  AGE_BANDS,
  CHANNEL_LABELS,
};
