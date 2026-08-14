const express = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../lib/prisma');
const { protect, requireAdmin } = require('../middleware/auth');
const audit = require('../lib/audit');
const eligibility = require('../lib/eligibility');
const saId = require('../lib/saIdNumber');
const files = require('../lib/files');
const notify = require('../lib/notify');
const slaMonitor = require('../lib/slaMonitor');
const meter = require('../lib/meterNumber');
const sms = require('../lib/sms');
const smsTemplates = require('../lib/smsTemplates');
const slots = require('../lib/documentSlots');
const analytics = require('../lib/analytics');
const chain = require('../lib/approvalChain');
const signature = require('../lib/signature');
const meansTest = require('../lib/meansTest');
const { passwordProblems, temporaryPassword } = require('../lib/credentials');
const cache = require('../lib/cache');
const { staffLimiter, exportLimiter } = require('../lib/rateLimit');

const router = express.Router();

router.use(...protect, requireAdmin, staffLimiter);

// A reviewer who approves an application must not then watch the dashboard
// disagree with them for the next minute. Any successful write here drops the
// cached figures.
router.use(cache.invalidateOn(cache.TAGS.APPLICATIONS, cache.TAGS.USERS, cache.TAGS.ANALYTICS));

// Thresholds come from lib/slaMonitor so the page and the notifications can
// never disagree. Setting SLA_AT_RISK_DAYS used to move one and not the other.
const { SLA_DAYS, AT_RISK_WITHIN_DAYS } = slaMonitor;
const EXPORT_LIMIT = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;

const NON_DRAFT = ['PENDING', 'APPROVED', 'DECLINED'];

const MARITAL = ['SINGLE', 'MARRIED', 'DIVORCED', 'WIDOWED', 'SEPARATED'];
const EMPLOYMENT = ['EMPLOYED', 'UNEMPLOYED', 'SELF_EMPLOYED', 'PENSIONER', 'OTHER'];

// Document obligations and the password policy are both imported above. This
// file used to carry its own copy of each, which meant an application created at
// the municipal counter could be held to different requirements than one the
// resident started themselves — with nothing to catch the divergence.

/** YYYY-MM-DD in UTC. Series keys are UTC so buckets stay stable across DST/offsets. */
const dayKey = (d) => new Date(d).toISOString().slice(0, 10);

const zaDate = (d) => new Date(d).toLocaleDateString('en-ZA');

/** Midnight UTC, `daysAgo` days back. */
function startOfDayUtc(daysAgo = 0) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d;
}

/** Zero-filled day buckets so charts show flat lines rather than gaps. */
function emptySeries(days, keys) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const row = { date: dayKey(startOfDayUtc(i)) };
    keys.forEach((k) => { row[k] = 0; });
    out.push(row);
  }
  return out;
}

function bump(index, date, key) {
  const row = index[dayKey(date)];
  if (row) row[key] += 1;
}

const fullName = (a, b) => [a, b].filter(Boolean).join(' ') || 'N/A';

// ---------------------------------------------------------------------------
// Applications list (existing)
// ---------------------------------------------------------------------------
router.get('/applications', async (req, res) => {
  try {
    const {
      status,
      search,
      page = 1,
      limit = 10,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 10));
    const skip = (pageNum - 1) * limitNum;

    const where = {};

    if (status && status !== 'ALL' && status !== 'All Applications') {
      where.status = status.toUpperCase();
    } else {
      where.status = { in: NON_DRAFT };
    }

    if (search) {
      where.OR = [
        { surname: { contains: search, mode: 'insensitive' } },
        { names: { contains: search, mode: 'insensitive' } },
        { idNumber: { contains: search, mode: 'insensitive' } },
        { cellNumber: { contains: search, mode: 'insensitive' } },
        { user: { email: { contains: search, mode: 'insensitive' } } },
      ];
    }

    // Whitelist the sort column — this value goes straight into Prisma's orderBy,
    // and an unknown column name would otherwise throw a 500.
    const SORTABLE = ['createdAt', 'submittedAt', 'reviewedAt', 'status', 'surname', 'totalHouseholdIncome'];
    const orderField = SORTABLE.includes(sortBy) ? sortBy : 'createdAt';

    const [applications, total] = await Promise.all([
      prisma.application.findMany({
        where,
        include: {
          user: { select: { id: true, email: true, firstName: true, lastName: true } },
          documents: { select: { id: true, name: true, type: true, status: true, importance: true } },
        },
        orderBy: { [orderField]: sortOrder === 'asc' ? 'asc' : 'desc' },
        skip,
        take: limitNum,
      }),
      prisma.application.count({ where }),
    ]);

    const formatted = applications.map((app) => ({
      id: app.id,
      reference: app.reference,
      // Fall back to the uuid stub for applications submitted before references existed.
      displayId: app.reference || app.id.slice(0, 8),
      fullName: fullName(app.names, app.surname),
      // Lets the queue mark rows a reviewer should look at more carefully.
      eligibility: eligibility.assess(app),
      cellNumber: app.cellNumber || 'N/A',
      employmentStatus: app.employmentStatus || 'N/A',
      totalIncome: app.totalHouseholdIncome
        ? `R ${Number(app.totalHouseholdIncome).toLocaleString('en-ZA', { minimumFractionDigits: 2 })}`
        : 'R 0.00',
      totalIncomeRaw: app.totalHouseholdIncome,
      dateApplied: zaDate(app.submittedAt || app.createdAt),
      status: app.status,
      documents: app.documents,
      user: app.user,
      createdAt: app.createdAt,
      submittedAt: app.submittedAt,
    }));

    res.json({
      success: true,
      data: formatted,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    console.error('admin/applications error:', error);
    res.status(500).json({ success: false, message: 'We could not load the applications. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Dashboard counters (existing)
// ---------------------------------------------------------------------------
router.get('/stats', async (req, res) => {
  try {
    const data = await cache.remember('admin:stats', async () => {
    const [pending, approved, declined, total] = await Promise.all([
      prisma.application.count({ where: { status: 'PENDING' } }),
      prisma.application.count({ where: { status: 'APPROVED' } }),
      prisma.application.count({ where: { status: 'DECLINED' } }),
      prisma.application.count({ where: { status: { in: NON_DRAFT } } }),
    ]);

      return { pending, approved, declined, total };
    }, { ttl: 30000, tags: [cache.TAGS.APPLICATIONS] });

    res.json({ success: true, data });
  } catch (error) {
    console.error('admin/stats error:', error);
    res.status(500).json({ success: false, message: 'We could not load the figures. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Applicants page
// ---------------------------------------------------------------------------
router.get('/stats/applicants', async (req, res) => {
  try {
    const base = { role: 'APPLICANT' };
    const [total, verified, last7, prev7] = await Promise.all([
      prisma.user.count({ where: base }),
      prisma.user.count({ where: { ...base, isVerified: true } }),
      prisma.user.count({ where: { ...base, createdAt: { gte: startOfDayUtc(6) } } }),
      prisma.user.count({
        where: { ...base, createdAt: { gte: startOfDayUtc(13), lt: startOfDayUtc(6) } },
      }),
    ]);

    let growthLabel;
    if (prev7 === 0) {
      growthLabel = last7 > 0 ? '+100%' : '0%';
    } else {
      const pct = Math.round(((last7 - prev7) / prev7) * 100);
      growthLabel = `${pct >= 0 ? '+' : ''}${pct}%`;
    }

    res.json({ success: true, data: { total, verified, last7Days: last7, growthLabel } });
  } catch (error) {
    console.error('admin/stats/applicants error:', error);
    res.status(500).json({ success: false, message: 'We could not load the figures. Please try again.' });
  }
});

router.get('/applicants', async (req, res) => {
  try {
    const { search, page = 1, limit = 20 } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));

    const where = { role: 'APPLICANT' };
    if (search) {
      where.OR = [
        { email: { contains: search, mode: 'insensitive' } },
        { firstName: { contains: search, mode: 'insensitive' } },
        { lastName: { contains: search, mode: 'insensitive' } },
        { idNumber: { contains: search, mode: 'insensitive' } },
        { cellNumber: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: {
          id: true, email: true, firstName: true, lastName: true,
          cellNumber: true, idNumber: true, isVerified: true, createdAt: true,
          _count: { select: { applications: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (pageNum - 1) * limitNum,
        take: limitNum,
      }),
      prisma.user.count({ where }),
    ]);

    res.json({
      success: true,
      data: users.map((u) => ({
        id: u.id,
        fullName: fullName(u.firstName, u.lastName),
        email: u.email,
        cellNumber: u.cellNumber || '—',
        idNumber: u.idNumber || '—',
        applicationsCount: u._count.applications,
        registeredDate: zaDate(u.createdAt),
      })),
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    console.error('admin/applicants error:', error);
    res.status(500).json({ success: false, message: 'We could not load the applicants. Please try again.' });
  }
});

router.get('/export/applicants', exportLimiter, async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      where: { role: 'APPLICANT' },
      select: {
        email: true, firstName: true, lastName: true, cellNumber: true,
        idNumber: true, isVerified: true, createdAt: true,
        _count: { select: { applications: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: EXPORT_LIMIT,
    });

    await audit.record(req, {
      action: audit.ACTIONS.EXPORT_APPLICANTS,
      entityType: 'User',
      details: `Exported ${users.length} applicant record(s)`,
    });

    // Keys become the CSV/PDF column headers on the client — keep them readable.
    res.json({
      success: true,
      data: users.map((u) => ({
        'Full Name': fullName(u.firstName, u.lastName),
        Email: u.email,
        'Cell Number': u.cellNumber || '',
        'ID Number': u.idNumber || '',
        Verified: u.isVerified ? 'Yes' : 'No',
        Applications: u._count.applications,
        Registered: zaDate(u.createdAt),
      })),
    });
  } catch (error) {
    console.error('admin/export/applicants error:', error);
    res.status(500).json({ success: false, message: 'We could not build that export. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Application Stats page
// ---------------------------------------------------------------------------
router.get('/stats/applications', async (req, res) => {
  try {
    const [total, draft, pending, approved, declined, byEmploymentRaw] = await Promise.all([
      prisma.application.count(),
      prisma.application.count({ where: { status: 'DRAFT' } }),
      prisma.application.count({ where: { status: 'PENDING' } }),
      prisma.application.count({ where: { status: 'APPROVED' } }),
      prisma.application.count({ where: { status: 'DECLINED' } }),
      prisma.application.groupBy({ by: ['employmentStatus'], _count: { _all: true } }),
    ]);

    const decisions = approved + declined;
    const approvalRate = decisions > 0 ? Math.round((approved / decisions) * 100) : 0;

    const byEmployment = byEmploymentRaw
      .map((g) => ({ status: g.employmentStatus || 'NOT SPECIFIED', count: g._count._all }))
      .sort((a, b) => b.count - a.count);

    const since = startOfDayUtc(29);
    const [created, submitted] = await Promise.all([
      prisma.application.findMany({
        where: { createdAt: { gte: since } },
        select: { createdAt: true },
      }),
      prisma.application.findMany({
        where: { submittedAt: { gte: since } },
        select: { submittedAt: true },
      }),
    ]);

    const dailyActivity = emptySeries(30, ['created', 'submitted']);
    const index = Object.fromEntries(dailyActivity.map((r) => [r.date, r]));
    created.forEach((a) => bump(index, a.createdAt, 'created'));
    submitted.forEach((a) => bump(index, a.submittedAt, 'submitted'));

    res.json({
      success: true,
      data: { total, draft, pending, approved, declined, approvalRate, byEmployment, dailyActivity },
    });
  } catch (error) {
    console.error('admin/stats/applications error:', error);
    res.status(500).json({ success: false, message: 'We could not load the figures. Please try again.' });
  }
});

router.get('/export/applications', exportLimiter, async (req, res) => {
  try {
    const apps = await prisma.application.findMany({
      include: { user: { select: { email: true } } },
      orderBy: { createdAt: 'desc' },
      take: EXPORT_LIMIT,
    });

    await audit.record(req, {
      action: audit.ACTIONS.EXPORT_APPLICATIONS,
      entityType: 'Application',
      details: `Exported ${apps.length} application record(s)`,
    });

    res.json({
      success: true,
      data: apps.map((a) => ({
        Reference: a.id.slice(0, 8),
        'Full Name': fullName(a.names, a.surname),
        Email: a.user?.email || '',
        'ID Number': a.idNumber || '',
        'Cell Number': a.cellNumber || '',
        Status: a.status,
        'Employment Status': a.employmentStatus || '',
        'Marital Status': a.maritalStatus || '',
        'People on Property': a.peopleOnProperty ?? '',
        'Household Income': a.totalHouseholdIncome != null ? Number(a.totalHouseholdIncome).toFixed(2) : '',
        'Income per Person': a.totalIncomePerPerson != null ? Number(a.totalIncomePerPerson).toFixed(2) : '',
        Created: zaDate(a.createdAt),
        Submitted: a.submittedAt ? zaDate(a.submittedAt) : '',
        Reviewed: a.reviewedAt ? zaDate(a.reviewedAt) : '',
        'Review Notes': a.reviewNotes || '',
      })),
    });
  } catch (error) {
    console.error('admin/export/applications error:', error);
    res.status(500).json({ success: false, message: 'We could not build that export. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Analytics page
// ---------------------------------------------------------------------------
router.get('/stats/analytics', async (req, res) => {
  try {
    const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30));
    const since = startOfDayUtc(days - 1);

    const [users, apps, reviewed, draft, pending, approvedAll, declinedAll] = await Promise.all([
      prisma.user.findMany({ where: { createdAt: { gte: since } }, select: { createdAt: true } }),
      prisma.application.findMany({ where: { createdAt: { gte: since } }, select: { createdAt: true } }),
      // status reflects the CURRENT state, so an application approved then later
      // declined counts only once, on its latest decision date.
      prisma.application.findMany({
        where: { reviewedAt: { gte: since }, status: { in: ['APPROVED', 'DECLINED'] } },
        select: { reviewedAt: true, status: true },
      }),
      prisma.application.count({ where: { status: 'DRAFT' } }),
      prisma.application.count({ where: { status: 'PENDING' } }),
      prisma.application.count({ where: { status: 'APPROVED' } }),
      prisma.application.count({ where: { status: 'DECLINED' } }),
    ]);

    const series = emptySeries(days, ['registrations', 'applications', 'approved', 'declined']);
    const index = Object.fromEntries(series.map((r) => [r.date, r]));
    users.forEach((u) => bump(index, u.createdAt, 'registrations'));
    apps.forEach((a) => bump(index, a.createdAt, 'applications'));
    reviewed.forEach((a) => bump(index, a.reviewedAt, a.status === 'APPROVED' ? 'approved' : 'declined'));

    res.json({
      success: true,
      data: {
        totals: {
          registrations: users.length,
          applications: apps.length,
          approved: reviewed.filter((a) => a.status === 'APPROVED').length,
          declined: reviewed.filter((a) => a.status === 'DECLINED').length,
        },
        statusTotals: { draft, pending, approved: approvedAll, declined: declinedAll },
        series,
      },
    });
  } catch (error) {
    console.error('admin/stats/analytics error:', error);
    res.status(500).json({ success: false, message: 'We could not build the analytics. Please try again.' });
  }
});

/**
 * The full analytics picture.
 *
 * One endpoint rather than a dozen because the page shows them together and a
 * dozen round trips would render in pieces. The arithmetic all lives in
 * lib/analytics.js; this handler is about deciding what to fetch.
 *
 * `days` scopes the *trend* series and the period totals. The queue, turnaround
 * and demographic sections deliberately look at the whole register — a manager
 * asking "how old is my oldest pending application" does not mean "within the
 * last 30 days".
 */
router.get('/analytics/full', async (req, res) => {
  try {
    const days = Math.min(365, Math.max(7, parseInt(req.query.days, 10) || 30));

    // Cached for a minute. This endpoint reads every application in the register
    // to compute medians and distributions; recomputing that per page view made
    // the analytics page the slowest thing in the portal, and nobody needs a
    // median turnaround that is fresh to the second. Any write to an application
    // drops the entry — see cache.invalidateOn below.
    const payload = await cache.remember(`analytics:${days}`, async () => {
    const since = startOfDayUtc(days - 1);
    const now = new Date();

    const APPLICATION_FIELDS = {
      id: true, status: true, createdAt: true, submittedAt: true, reviewedAt: true,
      idNumber: true, peopleOnProperty: true, childrenUnder18: true, pensionersOver60: true,
      totalHouseholdIncome: true, employmentStatus: true, maritalStatus: true,
      captureChannel: true, capturedById: true, capturedWard: true,
      residentialAddress: true, addressFormatted: true, addressLatitude: true,
      age: true, sex: true, hasDisability: true,
      difficultySeeing: true, difficultyHearing: true, difficultyWalking: true,
      difficultyRemembering: true, difficultySelfCare: true, difficultyCommunicating: true,
    };

    const [
      allApplications,
      periodUsers,
      periodApplications,
      periodReviewed,
      allDocuments,
      councillors,
      totalUsers,
      usersWithApplication,
    ] = await Promise.all([
      prisma.application.findMany({ select: APPLICATION_FIELDS }),
      prisma.user.findMany({ where: { role: 'APPLICANT', createdAt: { gte: since } }, select: { createdAt: true } }),
      prisma.application.findMany({ where: { createdAt: { gte: since } }, select: { createdAt: true } }),
      prisma.application.findMany({
        where: { reviewedAt: { gte: since }, status: { in: ['APPROVED', 'DECLINED'] } },
        select: { reviewedAt: true, status: true },
      }),
      prisma.document.findMany({
        where: { application: { status: { in: ['DRAFT', 'PENDING'] } } },
        select: { name: true, type: true, importance: true, requirementGroup: true, status: true },
      }),
      prisma.user.findMany({
        where: { role: 'COUNCILLOR' },
        select: { id: true, firstName: true, lastName: true, email: true, ward: true, isActive: true },
      }),
      prisma.user.count({ where: { role: 'APPLICANT' } }),
      prisma.user.count({ where: { role: 'APPLICANT', applications: { some: {} } } }),
    ]);

    const byStatus = (s) => allApplications.filter((a) => a.status === s);
    const decided = allApplications.filter((a) => a.status === 'APPROVED' || a.status === 'DECLINED');
    const submittedEver = allApplications.filter((a) => a.submittedAt);

    // Trend series over the requested window.
    const series = emptySeries(days, ['registrations', 'applications', 'approved', 'declined']);
    const index = Object.fromEntries(series.map((r) => [r.date, r]));
    periodUsers.forEach((u) => bump(index, u.createdAt, 'registrations'));
    periodApplications.forEach((a) => bump(index, a.createdAt, 'applications'));
    periodReviewed.forEach((a) => bump(index, a.reviewedAt, a.status === 'APPROVED' ? 'approved' : 'declined'));

    const approvedCount = byStatus('APPROVED').length;
    const declinedCount = byStatus('DECLINED').length;

    return {
      data: {
        period: { days, from: since, to: now },

        headline: {
          totalApplications: allApplications.length,
          registeredApplicants: totalUsers,
          pending: byStatus('PENDING').length,
          draft: byStatus('DRAFT').length,
          approved: approvedCount,
          declined: declinedCount,
          approvalRate: decided.length ? Math.round((approvedCount / decided.length) * 100) : null,
          // Everyone currently receiving relief. The register's actual reach, and
          // the figure that belongs at the top of the page.
          householdsSupported: approvedCount,
          peopleSupported: byStatus('APPROVED')
            .reduce((sum, a) => sum + (a.peopleOnProperty || 0), 0),
        },

        periodTotals: {
          registrations: periodUsers.length,
          applications: periodApplications.length,
          approved: periodReviewed.filter((a) => a.status === 'APPROVED').length,
          declined: periodReviewed.filter((a) => a.status === 'DECLINED').length,
        },

        series,
        turnaround: analytics.turnaround(decided, SLA_DAYS),
        queue: analytics.pendingAgeing(byStatus('PENDING'), SLA_DAYS, now),
        demographics: analytics.demographics(allApplications, now),
        disability: analytics.disability(allApplications),
        households: analytics.households(allApplications),
        income: analytics.income(allApplications, Number(eligibility.INCOME_THRESHOLD)),
        channels: analytics.channels(allApplications),
        geography: analytics.geography(allApplications),
        documents: analytics.documentBottlenecks(allDocuments),
        councillors: analytics.councillorPerformance(allApplications, councillors),
        funnel: analytics.funnel({
          registered: totalUsers,
          started: usersWithApplication,
          submitted: submittedEver.length,
          decided: decided.length,
          approved: approvedCount,
        }),

        employment: countBy(allApplications, 'employmentStatus', EMPLOYMENT),
        marital: countBy(allApplications, 'maritalStatus', MARITAL),

        slaDays: SLA_DAYS,
      },
    };
    }, { ttl: 60000, tags: [cache.TAGS.ANALYTICS, cache.TAGS.APPLICATIONS] });

    res.json({ success: true, ...payload });
  } catch (error) {
    console.error('admin/analytics/full error:', error);
    res.status(500).json({ success: false, message: 'We could not build the analytics. Please try again.' });
  }
});

/** Tally an enum column, keeping the declared order and including zero counts. */
function countBy(rows, field, allowed) {
  const counts = new Map(allowed.map((v) => [v, 0]));
  let unknown = 0;
  for (const row of rows) {
    const value = row[field];
    if (value && counts.has(value)) counts.set(value, counts.get(value) + 1);
    else unknown += 1;
  }
  const label = (v) => v.charAt(0) + v.slice(1).toLowerCase().replace(/_/g, ' ');
  return [
    ...[...counts.entries()].map(([key, count]) => ({ key, label: label(key), count })),
    ...(unknown ? [{ key: 'UNKNOWN', label: 'Not stated', count: unknown }] : []),
  ];
}

// ---------------------------------------------------------------------------
// SMS outbox
// ---------------------------------------------------------------------------

/**
 * Every message the register has tried to send.
 *
 * Two jobs. In production it answers "was this person actually told?", which is
 * the usual question when somebody arrives at the counter saying they heard
 * nothing. In development, where the console provider sends nothing, it is where
 * the messages can actually be read — including the temporary passwords' *shape*,
 * though the passwords themselves are redacted before storage.
 */
router.get('/sms', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
    const { status, purpose, search } = req.query;

    const where = {
      ...(status && status !== 'all' ? { status: String(status).toUpperCase() } : {}),
      ...(purpose && purpose !== 'all' ? { purpose: String(purpose) } : {}),
      ...(search
        ? {
            OR: [
              { toNumber: { contains: String(search) } },
              { body: { contains: String(search), mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [total, messages, purposes, byStatus] = await Promise.all([
      prisma.smsMessage.count({ where }),
      prisma.smsMessage.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.smsMessage.groupBy({ by: ['purpose'], _count: { _all: true } }),
      prisma.smsMessage.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);

    res.json({
      success: true,
      data: messages,
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) || 1 },
      filters: {
        purposes: purposes.map((p) => ({ value: p.purpose, count: p._count._all })).sort((a, b) => b.count - a.count),
        statuses: Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])),
      },
      provider: sms.PROVIDER,
      // The console provider is not a delivery failure, but it is not delivery
      // either. Say so plainly rather than letting a green "SENT" imply a text
      // actually arrived on somebody's phone.
      notice: sms.PROVIDER === 'console'
        ? 'SMS_PROVIDER is "console": these messages were written to the server log and stored here, but nothing was sent to a real handset.'
        : null,
    });
  } catch (error) {
    console.error('sms outbox error:', error);
    res.status(500).json({ success: false, message: 'We could not load the message log. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// SLA Monitor page
// ---------------------------------------------------------------------------
router.get('/sla', async (req, res) => {
  try {
    const now = Date.now();

    const [pendingApps, resolved] = await Promise.all([
      prisma.application.findMany({
        where: { status: 'PENDING' },
        include: { user: { select: { email: true } } },
        orderBy: { submittedAt: 'asc' },
      }),
      prisma.application.findMany({
        where: { status: { in: ['APPROVED', 'DECLINED'] }, submittedAt: { not: null }, reviewedAt: { not: null } },
        select: { submittedAt: true, reviewedAt: true },
      }),
    ]);

    const items = pendingApps.map((a) => {
      const from = a.submittedAt || a.createdAt;
      const ageDays = Math.floor((now - new Date(from).getTime()) / DAY_MS);
      const remainingDays = SLA_DAYS - ageDays;
      const slaStatus =
        remainingDays < 0 ? 'BREACHED' : remainingDays <= AT_RISK_WITHIN_DAYS ? 'AT_RISK' : 'ON_TRACK';

      return {
        id: a.id,
        reference: a.reference,
        displayId: a.reference || a.id.slice(0, 8),
        fullName: fullName(a.names, a.surname),
        email: a.user?.email || '—',
        submittedDate: a.submittedAt ? zaDate(a.submittedAt) : '—',
        ageDays,
        remainingDays,
        slaStatus,
        // Whether the scheduled check has already told the administrators.
        notifiedLevel: a.slaNotifiedLevel,
      };
    });

    const avgResolutionDays = resolved.length
      ? Number(
          (
            resolved.reduce(
              (sum, a) => sum + (new Date(a.reviewedAt).getTime() - new Date(a.submittedAt).getTime()),
              0
            ) /
            resolved.length /
            DAY_MS
          ).toFixed(1)
        )
      : null;

    res.json({
      success: true,
      data: {
        summary: {
          slaDays: SLA_DAYS,
          atRiskWithinDays: AT_RISK_WITHIN_DAYS,
          totalPending: items.length,
          onTrack: items.filter((i) => i.slaStatus === 'ON_TRACK').length,
          atRisk: items.filter((i) => i.slaStatus === 'AT_RISK').length,
          breached: items.filter((i) => i.slaStatus === 'BREACHED').length,
          avgResolutionDays,
        },
        items,
      },
    });
  } catch (error) {
    console.error('admin/sla error:', error);
    res.status(500).json({ success: false, message: 'We could not load the service-level figures. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Audit Logs page
// ---------------------------------------------------------------------------
router.get('/audit-logs', async (req, res) => {
  try {
    const { action, search, page = 1, limit = 50 } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));

    const where = {};
    if (action && action !== 'ALL') where.action = action;
    if (search) {
      where.OR = [
        { userEmail: { contains: search, mode: 'insensitive' } },
        { action: { contains: search, mode: 'insensitive' } },
        { details: { contains: search, mode: 'insensitive' } },
        { entityId: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (pageNum - 1) * limitNum,
        take: limitNum,
      }),
      prisma.auditLog.count({ where }),
    ]);

    res.json({
      success: true,
      data: logs,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    console.error('admin/audit-logs error:', error);
    res.status(500).json({ success: false, message: 'We could not load the audit trail. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Single application detail + decision (existing)
// ---------------------------------------------------------------------------
router.get('/applications/:id', async (req, res) => {
  try {
    const application = await prisma.application.findUnique({
      where: { id: req.params.id },
      include: {
        documents: { orderBy: [{ importance: 'asc' }, { requirementGroup: 'asc' }, { createdAt: 'asc' }] },
        user: {
          select: { id: true, email: true, firstName: true, lastName: true, cellNumber: true, idNumber: true },
        },
        /**
         * The whole case file, not just the form.
         *
         * These were missing, so an administrator opening an application saw the
         * household's answers and nothing about how it had been decided — no
         * stages, no officers, no reasons, no signature. That is the half of the
         * record the municipality is actually accountable for: at audit the
         * question is never "what did they declare?" but "who approved this, on
         * what basis, and can you show me".
         */
        approvalSteps: { orderBy: { sequence: 'asc' } },
        household: { orderBy: { createdAt: 'asc' } },
        siteVisits: { orderBy: { attempt: 'asc' } },
        checks: { orderBy: { checkedAt: 'desc' } },
        capturedBy: { select: { id: true, firstName: true, lastName: true, ward: true } },
      },
    });

    if (!application) {
      return res.status(404).json({ success: false, message: 'We could not find that application.' });
    }

    await audit.record(req, {
      action: audit.ACTIONS.VIEW_APPLICATION,
      entityType: 'Application',
      entityId: application.id,
      details: `Viewed ${application.reference || application.id.slice(0, 8)} — ${fullName(application.names, application.surname)}`,
    });

    res.json({
      success: true,
      data: {
        ...application,
        eligibility: eligibility.assess(application),
        /**
         * The approval chain, described.
         *
         * Assembled here rather than in the browser so the administrator's view
         * and the approver's view read identically — the same stage labels, the
         * same wording for an outcome. Two screens describing one decision in two
         * vocabularies is how an audit finding starts.
         */
        trail: chain.describeTrail(application.approvalSteps),
        position: chain.position(application, { steps: application.approvalSteps, user: req.user }),
        meansTest: meansTest.assess(application, {
          checks: application.checks,
          household: application.household,
        }),
        /**
         * Signatures, with the evidence around them.
         *
         * An electronic signature under ECTA is only worth as much as what can be
         * shown about the circumstances it was made in, so the name, the moment
         * and the address travel with the image rather than the image alone.
         */
        signatures: application.approvalSteps
          .filter((s) => s.signature)
          .map((s) => ({ ...signature.describe(s), image: s.signature, stage: s.stage })),
      },
    });
  } catch (error) {
    console.error('admin/applications/:id error:', error);
    res.status(500).json({ success: false, message: 'We could not load that application. Please try again.' });
  }
});

router.patch('/applications/:id/status', async (req, res) => {
  try {
    const { status, reviewNotes } = req.body;

    if (!['APPROVED', 'DECLINED', 'PENDING'].includes(status)) {
      return res.status(400).json({ success: false, message: 'That is not a status we recognise.' });
    }

    const application = await prisma.application.findUnique({ where: { id: req.params.id } });

    if (!application) {
      return res.status(404).json({ success: false, message: 'We could not find that application.' });
    }

    // A DRAFT has not been submitted — the applicant is still filling it in, and
    // deciding it from here would approve a form they never sent.
    if (application.status === 'DRAFT') {
      return res.status(400).json({
        success: false,
        message: 'This application is still a draft and has not been submitted for review.',
      });
    }

    if (application.status === status) {
      return res.status(400).json({
        success: false,
        message: `This application is already ${status.toLowerCase()}.`,
      });
    }

    const updated = await prisma.application.update({
      where: { id: req.params.id },
      data: {
        status,
        reviewedAt: new Date(),
        reviewedBy: req.user.id,
        reviewNotes: reviewNotes || null,
        // A decision, or a return to the queue, restarts the service clock.
        slaNotifiedLevel: null,
      },
      include: { documents: { orderBy: [{ importance: 'asc' }, { requirementGroup: 'asc' }, { createdAt: 'asc' }] }, user: { select: { email: true, firstName: true, lastName: true, cellNumber: true } } },
    });

    if (status === 'APPROVED' || status === 'DECLINED') {
      await audit.record(req, {
        action: status === 'APPROVED' ? audit.ACTIONS.APPROVE_APPLICATION : audit.ACTIONS.DECLINE_APPLICATION,
        entityType: 'Application',
        entityId: updated.id,
        details: `${application.status} → ${status}${reviewNotes ? ` · ${reviewNotes}` : ''}`,
      });
    }

    // The applicant is told about every decision on their own application.
    const ref = updated.reference || updated.id.slice(0, 8);
    const NOTICE = {
      APPROVED: {
        type: notify.TYPE.APPLICATION_APPROVED,
        title: 'Your application was approved',
        body: `Reference ${ref}. The discount will be applied to your municipal account.`,
      },
      DECLINED: {
        type: notify.TYPE.APPLICATION_DECLINED,
        title: 'Your application was not approved',
        body: reviewNotes
          ? `Reference ${ref}. Reason: ${reviewNotes}`
          : `Reference ${ref}. Contact your municipal office if you would like to understand why.`,
      },
      PENDING: {
        type: notify.TYPE.APPLICATION_REOPENED,
        title: 'Your application is being reviewed again',
        body: `Reference ${ref} has been returned to the review queue.`,
      },
    }[status];

    await notify.toUser(application.userId, {
      ...NOTICE,
      link: `/applications/${updated.id}`,
      entityType: 'Application',
      entityId: updated.id,
    });

    /**
     * And by SMS.
     *
     * A decision is the one thing every applicant is waiting for, and most of
     * them will not open the portal again to find out. The in-app notification is
     * for the person who signs in; this is for everyone else.
     */
    const SMS_TEMPLATE = {
      APPROVED: 'APPLICATION_APPROVED',
      DECLINED: 'APPLICATION_DECLINED',
      PENDING: 'APPLICATION_REOPENED',
    }[status];

    await sms.send(
      updated.user?.cellNumber || updated.cellNumber,
      smsTemplates.build(SMS_TEMPLATE, { reference: ref, reason: reviewNotes }),
      {
        purpose: SMS_TEMPLATE,
        userId: application.userId,
        entityType: 'Application',
        entityId: updated.id,
      }
    );

    res.json({
      success: true,
      message: `Application ${status.toLowerCase()} successfully`,
      data: updated,
    });
  } catch (error) {
    console.error('admin status update error:', error);
    res.status(500).json({ success: false, message: 'We could not update the status. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Applicant management (CRUD)
// ---------------------------------------------------------------------------

/** Full record for one applicant, with their application history. */
router.get('/applicants/:id', async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: {
        id: true, email: true, role: true, firstName: true, lastName: true,
        cellNumber: true, idNumber: true, isVerified: true, createdAt: true, updatedAt: true,
        applications: {
          orderBy: { createdAt: 'desc' },
          include: { documents: { select: { id: true, name: true, importance: true, status: true } } },
        },
      },
    });

    if (!user) return res.status(404).json({ success: false, message: 'We could not find that person.' });

    res.json({
      success: true,
      data: {
        ...user,
        fullName: fullName(user.firstName, user.lastName),
        applications: user.applications.map((a) => ({
          ...a,
          displayId: a.reference || a.id.slice(0, 8),
          eligibility: eligibility.assess(a),
        })),
      },
    });
  } catch (error) {
    console.error('admin/applicants/:id error:', error);
    res.status(500).json({ success: false, message: 'We could not load that person. Please try again.' });
  }
});

/** Correct an applicant's details. Role is not editable here. */
router.patch('/applicants/:id', async (req, res) => {
  try {
    const { firstName, lastName, cellNumber, idNumber, email, isVerified } = req.body || {};

    const existing = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ success: false, message: 'We could not find that person.' });
    if (existing.role === 'ADMIN') {
      return res.status(400).json({ success: false, message: 'Administrator accounts cannot be edited here' });
    }

    const data = {};
    if (firstName !== undefined) data.firstName = String(firstName).trim() || null;
    if (lastName !== undefined) data.lastName = String(lastName).trim() || null;
    if (cellNumber !== undefined) data.cellNumber = String(cellNumber).trim() || null;
    if (isVerified !== undefined) data.isVerified = Boolean(isVerified);

    if (email !== undefined) {
      const next = String(email).trim();
      if (!next) return res.status(400).json({ success: false, message: 'Email address cannot be empty' });
      if (next !== existing.email) {
        const clash = await prisma.user.findUnique({ where: { email: next }, select: { id: true } });
        if (clash) return res.status(400).json({ success: false, message: 'That email address is already registered' });
        data.email = next;
      }
    }

    if (idNumber !== undefined) {
      const next = String(idNumber).trim();
      if (next) {
        const check = saId.validate(next);
        if (!check.valid) return res.status(400).json({ success: false, message: check.reason });
        const clash = await prisma.user.findFirst({
          where: { idNumber: next, NOT: { id: existing.id } },
          select: { id: true },
        });
        if (clash) return res.status(400).json({ success: false, message: 'That ID number belongs to another applicant' });
      }
      data.idNumber = next || null;
    }

    if (Object.keys(data).length === 0) {
      return res.json({ success: true, message: 'Nothing to update', data: existing });
    }

    const user = await prisma.user.update({
      where: { id: existing.id },
      data,
      select: { id: true, email: true, firstName: true, lastName: true, cellNumber: true, idNumber: true, isVerified: true },
    });

    await audit.record(req, {
      action: audit.ACTIONS.UPDATE_APPLICANT,
      entityType: 'User',
      entityId: user.id,
      details: `Updated ${Object.keys(data).join(', ')} on ${user.email}`,
    });

    res.json({ success: true, message: 'Applicant updated', data: user });
  } catch (error) {
    console.error('admin update applicant error:', error);
    res.status(500).json({ success: false, message: 'We could not save those changes. Please try again.' });
  }
});

/**
 * Delete an applicant and everything belonging to them.
 *
 * The database cascades to applications and documents, but the uploaded files
 * must be removed explicitly — otherwise ID copies and bank statements survive a
 * deletion that was meant to erase them.
 */
router.delete('/applicants/:id', async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      include: { applications: { include: { documents: { orderBy: [{ importance: 'asc' }, { requirementGroup: 'asc' }, { createdAt: 'asc' }] } } } },
    });

    if (!user) return res.status(404).json({ success: false, message: 'We could not find that person.' });
    if (user.role === 'ADMIN') {
      return res.status(400).json({ success: false, message: 'Administrator accounts cannot be deleted here' });
    }
    if (user.id === req.user.id) {
      return res.status(400).json({ success: false, message: 'You cannot delete your own account' });
    }

    let filesRemoved = 0;
    for (const application of user.applications) {
      filesRemoved += files.removeDocumentFiles(application.documents);
      files.removeApplicationDir(application.id);
    }

    await prisma.user.delete({ where: { id: user.id } });

    await audit.record(req, {
      action: audit.ACTIONS.DELETE_APPLICANT,
      entityType: 'User',
      entityId: user.id,
      details: `Deleted ${user.email} — ${user.applications.length} application(s), ${filesRemoved} file(s) removed`,
    });

    res.json({
      success: true,
      message: 'Applicant deleted',
      data: { applicationsDeleted: user.applications.length, filesRemoved },
    });
  } catch (error) {
    console.error('admin delete applicant error:', error);
    res.status(500).json({ success: false, message: 'We could not remove that account. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Application management (create / update / delete)
// ---------------------------------------------------------------------------

/** Start an application on an applicant's behalf, with the usual document slots. */
router.post('/applications', async (req, res) => {
  try {
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ success: false, message: 'An applicant must be chosen' });

    const owner = await prisma.user.findUnique({ where: { id: userId } });
    if (!owner || owner.role !== 'APPLICANT') {
      return res.status(400).json({ success: false, message: 'That applicant does not exist' });
    }

    const existingDraft = await prisma.application.findFirst({
      where: { userId, status: 'DRAFT' },
      select: { id: true },
    });
    if (existingDraft) {
      return res.status(400).json({
        success: false,
        message: 'That applicant already has a draft application.',
        data: existingDraft,
      });
    }

    const application = await prisma.application.create({
      data: {
        userId,
        status: 'DRAFT',
        currentStep: 1,
        surname: owner.lastName || null,
        names: owner.firstName || null,
        idNumber: owner.idNumber || null,
        cellNumber: owner.cellNumber || null,
      },
    });

    await prisma.document.createMany({ data: slots.seedRows(application.id) });

    await audit.record(req, {
      action: audit.ACTIONS.CREATE_APPLICATION,
      entityType: 'Application',
      entityId: application.id,
      details: `Created an application on behalf of ${owner.email}`,
    });

    await notify.toUser(owner.id, {
      type: notify.TYPE.APPLICATION_UPDATED,
      title: 'An application was started for you',
      body: 'A municipal official started an application on your behalf. Sign in to complete it.',
      link: '/dashboard',
      entityType: 'Application',
      entityId: application.id,
    });

    const full = await prisma.application.findUnique({
      where: { id: application.id },
      include: { documents: { orderBy: [{ importance: 'asc' }, { requirementGroup: 'asc' }, { createdAt: 'asc' }] } },
    });

    res.status(201).json({ success: true, message: 'Application created', data: full });
  } catch (error) {
    console.error('admin create application error:', error);
    res.status(500).json({ success: false, message: 'We could not start the application. Please try again.' });
  }
});

/**
 * Correct application data.
 *
 * Unlike the applicant route this is not restricted to drafts — an official may
 * need to fix a captured figure on a submitted application. Every change is
 * recorded field by field, because editing the record a decision rests on must
 * never be invisible.
 */
router.patch('/applications/:id', async (req, res) => {
  try {
    const application = await prisma.application.findUnique({ where: { id: req.params.id } });
    if (!application) return res.status(404).json({ success: false, message: 'We could not find that application.' });

    const body = req.body || {};
    const data = {};
    const changed = [];

    const STRINGS = ['surname', 'names', 'idNumber', 'cellNumber', 'residentialAddress', 'postalAddress',
      'employerName', 'employerAddress', 'workTelNumber', 'waterMeterNumber', 'electricityMeterNumber'];
    const ENUMS = { maritalStatus: MARITAL, employmentStatus: EMPLOYMENT };
    const INTS = ['peopleOnProperty', 'childrenUnder18', 'adults', 'pensionersOver60'];
    const MONEY = ['salary', 'oldAgePension', 'disabilityPension', 'businessIncome', 'rentingIncome'];
    const BOOLS = ['ownsImmovableProperty', 'isFullTimeOccupant', 'incomeBelowThreshold',
      'hasMunicipalArrears', 'hasArrearsArrangement', 'cellVerified'];

    if (body.idNumber !== undefined && String(body.idNumber).trim()) {
      const check = saId.validate(body.idNumber);
      if (!check.valid) return res.status(400).json({ success: false, message: check.reason });
    }

    for (const [key, kind] of [['waterMeterNumber', 'water'], ['electricityMeterNumber', 'electricity']]) {
      if (body[key] === undefined) continue;
      const check = meter.validate(body[key], { kind });
      if (!check.valid) return res.status(400).json({ success: false, message: check.reason });
      body[key] = check.value ?? '';
    }

    STRINGS.forEach((k) => {
      if (body[k] === undefined) return;
      const v = String(body[k]).trim() || null;
      if (v !== application[k]) { data[k] = v; changed.push(k); }
    });

    Object.entries(ENUMS).forEach(([k, allowed]) => {
      if (body[k] === undefined) return;
      const v = body[k] || null;
      if (v !== null && !allowed.includes(v)) return;
      if (v !== application[k]) { data[k] = v; changed.push(k); }
    });

    INTS.forEach((k) => {
      if (body[k] === undefined) return;
      const n = body[k] === '' || body[k] === null ? null : parseInt(body[k], 10);
      if (n !== null && !Number.isFinite(n)) return;
      if (n !== application[k]) { data[k] = n; changed.push(k); }
    });

    MONEY.forEach((k) => {
      if (body[k] === undefined) return;
      const n = body[k] === '' || body[k] === null ? null : Number(body[k]);
      if (n !== null && !Number.isFinite(n)) return;
      if (String(n) !== String(application[k] === null ? null : Number(application[k]))) {
        data[k] = n; changed.push(k);
      }
    });

    BOOLS.forEach((k) => {
      if (body[k] === undefined) return;
      const b = body[k] === true || body[k] === 'Yes' || body[k] === 'true'
        ? true
        : body[k] === false || body[k] === 'No' || body[k] === 'false' ? false : null;
      if (b !== application[k]) { data[k] = b; changed.push(k); }
    });

    if (changed.length === 0) {
      return res.json({ success: true, message: 'Nothing to update', data: application });
    }

    // Recompute the totals whenever any income component moved.
    if (MONEY.some((k) => changed.includes(k)) || changed.includes('peopleOnProperty')) {
      const value = (k) => {
        const raw = data[k] !== undefined ? data[k] : application[k];
        return raw === null || raw === undefined ? 0 : Number(raw);
      };
      const total = MONEY.reduce((sum, k) => sum + value(k), 0);
      data.totalHouseholdIncome = total;
      const people = data.peopleOnProperty !== undefined ? data.peopleOnProperty : application.peopleOnProperty;
      data.totalIncomePerPerson = people && people > 0 ? total / people : null;
    }

    const updated = await prisma.application.update({
      where: { id: application.id },
      data,
      include: { documents: { orderBy: [{ importance: 'asc' }, { requirementGroup: 'asc' }, { createdAt: 'asc' }] }, user: { select: { email: true } } },
    });

    await audit.record(req, {
      action: audit.ACTIONS.UPDATE_APPLICATION,
      entityType: 'Application',
      entityId: application.id,
      details: `Edited ${changed.join(', ')} on ${application.reference || application.id.slice(0, 8)} (status ${application.status})`,
    });

    // Someone whose submitted application was altered deserves to know.
    if (application.status !== 'DRAFT') {
      await notify.toUser(application.userId, {
        type: notify.TYPE.APPLICATION_UPDATED,
        title: 'Your application was updated by the municipality',
        body: `An official corrected ${changed.length} detail${changed.length === 1 ? '' : 's'} on ${application.reference || application.id.slice(0, 8)}.`,
        link: `/applications/${application.id}`,
        entityType: 'Application',
        entityId: application.id,
      });
    }

    res.json({
      success: true,
      message: `Updated ${changed.length} field${changed.length === 1 ? '' : 's'}`,
      data: { ...updated, eligibility: eligibility.assess(updated) },
    });
  } catch (error) {
    console.error('admin update application error:', error);
    res.status(500).json({ success: false, message: 'We could not save your changes. Please try again.' });
  }
});

/** Delete an application and its uploaded files. */
router.delete('/applications/:id', async (req, res) => {
  try {
    const application = await prisma.application.findUnique({
      where: { id: req.params.id },
      include: { documents: { orderBy: [{ importance: 'asc' }, { requirementGroup: 'asc' }, { createdAt: 'asc' }] }, user: { select: { email: true } } },
    });

    if (!application) return res.status(404).json({ success: false, message: 'We could not find that application.' });

    const filesRemoved = files.removeDocumentFiles(application.documents);
    files.removeApplicationDir(application.id);

    await prisma.application.delete({ where: { id: application.id } });

    await audit.record(req, {
      action: audit.ACTIONS.DELETE_APPLICATION,
      entityType: 'Application',
      entityId: application.id,
      details: `Deleted ${application.reference || application.id.slice(0, 8)} for ${application.user?.email} (was ${application.status}) — ${filesRemoved} file(s) removed`,
    });

    res.json({ success: true, message: 'Application deleted', data: { filesRemoved } });
  } catch (error) {
    console.error('admin delete application error:', error);
    res.status(500).json({ success: false, message: 'We could not remove that application. Please try again.' });
  }
});

/**
 * Run the service-level sweep on demand.
 *
 * The scheduled timer is the normal path; this exists so an operator can force a
 * check after changing the target, and so the behaviour is testable without
 * waiting for the interval.
 */
router.post('/sla/check', async (req, res) => {
  try {
    const result = await slaMonitor.run();
    res.json({
      success: true,
      message: result.skipped
        ? 'Another instance is already running the check'
        : `Checked ${result.checked} pending application(s), escalated ${result.announced.length}`,
      data: result,
    });
  } catch (error) {
    console.error('sla check error:', error);
    res.status(500).json({ success: false, message: 'The service-level check could not be run. Please try again.' });
  }
});

/**
 * Mark a single document as rejected or acceptable.
 *
 * The schema always allowed Document.status = 'Rejected' but nothing ever set it,
 * so an admin who found one unreadable bank statement had to decline the whole
 * application. This lets them reject the document and leave the application in
 * the queue.
 */
router.patch('/documents/:id/status', async (req, res) => {
  try {
    const { status, reason } = req.body || {};

    if (!['Rejected', 'Uploaded'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Status must be Rejected or Uploaded' });
    }

    const document = await prisma.document.findUnique({
      where: { id: req.params.id },
      include: { application: true },
    });

    if (!document) {
      return res.status(404).json({ success: false, message: 'We could not find that document.' });
    }

    if (!document.filePath) {
      return res.status(400).json({ success: false, message: 'That document has no file to review' });
    }

    const updated = await prisma.document.update({
      where: { id: document.id },
      data: { status },
    });

    await audit.record(req, {
      action: status === 'Rejected' ? audit.ACTIONS.REJECT_DOCUMENT : audit.ACTIONS.ACCEPT_DOCUMENT,
      entityType: 'Document',
      entityId: document.id,
      details: `${document.name} on ${document.application.reference || document.applicationId.slice(0, 8)}${reason ? ` — ${reason}` : ''}`,
    });

    // A rejected document is the one case where the applicant must act, so the
    // notification says what to do rather than only what happened.
    await notify.toUser(document.application.userId, {
      type: status === 'Rejected' ? notify.TYPE.DOCUMENT_REJECTED : notify.TYPE.DOCUMENT_ACCEPTED,
      title: status === 'Rejected' ? `${document.name} was rejected` : `${document.name} was accepted`,
      body: status === 'Rejected'
        ? `${reason || 'It could not be accepted as submitted.'} Contact your municipal office to replace it.`
        : 'No further action is needed for this document.',
      link: `/applications/${document.applicationId}`,
      entityType: 'Document',
      entityId: document.id,
    });

    // Only a rejection is worth an SMS. Texting somebody to say a document was
    // accepted spends the municipality's money to tell them nothing has changed.
    if (status === 'Rejected') {
      const applicant = await prisma.user.findUnique({
        where: { id: document.application.userId },
        select: { cellNumber: true },
      });
      await sms.send(
        applicant?.cellNumber || document.application.cellNumber,
        smsTemplates.build('DOCUMENT_REJECTED', {
          reference: document.application.reference || document.applicationId.slice(0, 8),
          documentName: document.name,
        }),
        {
          purpose: 'DOCUMENT_REJECTED',
          userId: document.application.userId,
          entityType: 'Document',
          entityId: document.id,
        }
      );
    }

    res.json({
      success: true,
      message: status === 'Rejected' ? 'Document rejected' : 'Document accepted',
      data: updated,
    });
  } catch (error) {
    console.error('document status error:', error);
    res.status(500).json({ success: false, message: 'We could not update that document. Please try again.' });
  }
});

module.exports = router;
