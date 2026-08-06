const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { writeAuditLog, getClientIp } = require('../utils/audit');

const router = express.Router();
const prisma = new PrismaClient();

// Default SLA: applications should be reviewed within this many days of submission
const SLA_DAYS = parseInt(process.env.SLA_DAYS || '14', 10);

router.use(authenticate, requireAdmin);

function daysBetween(from, to = new Date()) {
  if (!from) return null;
  const ms = to.getTime() - new Date(from).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

// ─── Applications list (existing) ───────────────────────────────────────────
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

    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
    const skip = (pageNum - 1) * limitNum;

    const where = {};

    if (status && status !== 'ALL' && status !== 'All Applications') {
      where.status = status.toUpperCase();
    } else {
      where.status = { in: ['PENDING', 'APPROVED', 'DECLINED', 'DRAFT'] };
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

    const allowedSort = ['createdAt', 'submittedAt', 'status', 'surname'];
    const sortField = allowedSort.includes(sortBy) ? sortBy : 'createdAt';

    const [applications, total] = await Promise.all([
      prisma.application.findMany({
        where,
        include: {
          user: {
            select: { id: true, email: true, firstName: true, lastName: true },
          },
          documents: {
            select: { id: true, name: true, type: true, status: true, importance: true },
          },
        },
        orderBy: { [sortField]: sortOrder === 'asc' ? 'asc' : 'desc' },
        skip,
        take: limitNum,
      }),
      prisma.application.count({ where }),
    ]);

    const formatted = applications.map((app) => ({
      id: app.id,
      displayId: app.id.slice(0, 8),
      fullName: [app.names, app.surname].filter(Boolean).join(' ') || 'N/A',
      cellNumber: app.cellNumber || 'N/A',
      employmentStatus: app.employmentStatus || 'N/A',
      totalIncome: app.totalHouseholdIncome
        ? `R ${Number(app.totalHouseholdIncome).toLocaleString('en-ZA', { minimumFractionDigits: 2 })}`
        : 'R 0.00',
      totalIncomeRaw: app.totalHouseholdIncome,
      dateApplied: app.submittedAt
        ? new Date(app.submittedAt).toLocaleDateString('en-ZA')
        : new Date(app.createdAt).toLocaleDateString('en-ZA'),
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
    console.error(error);
    res.status(500).json({ success: false, message: 'Failed to fetch applications' });
  }
});

router.get('/applications/:id', async (req, res) => {
  try {
    const application = await prisma.application.findUnique({
      where: { id: req.params.id },
      include: {
        documents: true,
        user: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            cellNumber: true,
            idNumber: true,
          },
        },
      },
    });

    if (!application) {
      return res.status(404).json({ success: false, message: 'Application not found' });
    }

    await writeAuditLog({
      userId: req.user.id,
      userEmail: req.user.email,
      userRole: req.user.role,
      action: 'VIEW_APPLICATION',
      entityType: 'Application',
      entityId: application.id,
      ipAddress: getClientIp(req),
    });

    res.json({ success: true, data: application });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Failed to fetch application' });
  }
});

router.patch('/applications/:id/status', async (req, res) => {
  try {
    const { status, reviewNotes } = req.body;

    if (!['APPROVED', 'DECLINED', 'PENDING'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }

    const application = await prisma.application.findUnique({
      where: { id: req.params.id },
    });

    if (!application) {
      return res.status(404).json({ success: false, message: 'Application not found' });
    }

    const updated = await prisma.application.update({
      where: { id: req.params.id },
      data: {
        status,
        reviewedAt: new Date(),
        reviewedBy: req.user.id,
        reviewNotes: reviewNotes || null,
      },
      include: {
        documents: true,
        user: { select: { email: true, firstName: true, lastName: true } },
      },
    });

    await writeAuditLog({
      userId: req.user.id,
      userEmail: req.user.email,
      userRole: req.user.role,
      action: status === 'APPROVED' ? 'APPROVE_APPLICATION' : status === 'DECLINED' ? 'DECLINE_APPLICATION' : 'UPDATE_APPLICATION_STATUS',
      entityType: 'Application',
      entityId: updated.id,
      details: { from: application.status, to: status, reviewNotes },
      ipAddress: getClientIp(req),
    });

    res.json({
      success: true,
      message: `Application ${status.toLowerCase()} successfully`,
      data: updated,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Failed to update status' });
  }
});

// ─── Dashboard summary counts ───────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const [pending, approved, declined, draft, totalApps, totalApplicants] = await Promise.all([
      prisma.application.count({ where: { status: 'PENDING' } }),
      prisma.application.count({ where: { status: 'APPROVED' } }),
      prisma.application.count({ where: { status: 'DECLINED' } }),
      prisma.application.count({ where: { status: 'DRAFT' } }),
      prisma.application.count(),
      prisma.user.count({ where: { role: 'APPLICANT' } }),
    ]);

    res.json({
      success: true,
      data: { pending, approved, declined, draft, total: totalApps, totalApplicants },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Failed to fetch stats' });
  }
});

// ─── Applicants list + stats ────────────────────────────────────────────────
router.get('/applicants', async (req, res) => {
  try {
    const { search, page = 1, limit = 20 } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10)));
    const skip = (pageNum - 1) * limitNum;

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
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          cellNumber: true,
          idNumber: true,
          isVerified: true,
          createdAt: true,
          _count: { select: { applications: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limitNum,
      }),
      prisma.user.count({ where }),
    ]);

    const data = users.map((u) => ({
      id: u.id,
      fullName: [u.firstName, u.lastName].filter(Boolean).join(' ') || '—',
      email: u.email,
      cellNumber: u.cellNumber || '—',
      idNumber: u.idNumber || '—',
      isVerified: u.isVerified,
      applicationsCount: u._count.applications,
      registeredAt: u.createdAt,
      registeredDate: new Date(u.createdAt).toLocaleDateString('en-ZA'),
    }));

    res.json({
      success: true,
      data,
      pagination: { page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Failed to fetch applicants' });
  }
});

router.get('/stats/applicants', async (req, res) => {
  try {
    const total = await prisma.user.count({ where: { role: 'APPLICANT' } });
    const verified = await prisma.user.count({ where: { role: 'APPLICANT', isVerified: true } });

    // Registrations last 30 days by day
    const since = new Date();
    since.setDate(since.getDate() - 30);

    const recent = await prisma.user.findMany({
      where: { role: 'APPLICANT', createdAt: { gte: since } },
      select: { createdAt: true },
      orderBy: { createdAt: 'asc' },
    });

    const byDay = {};
    for (let i = 0; i <= 30; i++) {
      const d = new Date();
      d.setDate(d.getDate() - (30 - i));
      const key = d.toISOString().slice(0, 10);
      byDay[key] = 0;
    }
    recent.forEach((u) => {
      const key = new Date(u.createdAt).toISOString().slice(0, 10);
      if (byDay[key] !== undefined) byDay[key] += 1;
    });

    const last7 = Object.entries(byDay).slice(-7);
    const prev7 = Object.entries(byDay).slice(-14, -7);
    const last7Total = last7.reduce((s, [, v]) => s + v, 0);
    const prev7Total = prev7.reduce((s, [, v]) => s + v, 0);
    let growthLabel = 'Stable';
    if (prev7Total === 0 && last7Total > 0) growthLabel = 'Growing';
    else if (prev7Total > 0) {
      const pct = ((last7Total - prev7Total) / prev7Total) * 100;
      if (pct > 5) growthLabel = 'Growing';
      else if (pct < -5) growthLabel = 'Declining';
    }

    // Applicants with at least one application
    const withApps = await prisma.user.count({
      where: { role: 'APPLICANT', applications: { some: {} } },
    });

    res.json({
      success: true,
      data: {
        total,
        verified,
        unverified: total - verified,
        withApplications: withApps,
        withoutApplications: total - withApps,
        registeredLast30Days: recent.length,
        last7Days: last7Total,
        previous7Days: prev7Total,
        growthLabel,
        dailyRegistrations: Object.entries(byDay).map(([date, count]) => ({ date, count })),
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Failed to fetch applicant stats' });
  }
});

// ─── Application statistics ─────────────────────────────────────────────────
router.get('/stats/applications', async (req, res) => {
  try {
    const [draft, pending, approved, declined, total] = await Promise.all([
      prisma.application.count({ where: { status: 'DRAFT' } }),
      prisma.application.count({ where: { status: 'PENDING' } }),
      prisma.application.count({ where: { status: 'APPROVED' } }),
      prisma.application.count({ where: { status: 'DECLINED' } }),
      prisma.application.count(),
    ]);

    const byEmployment = await prisma.application.groupBy({
      by: ['employmentStatus'],
      _count: { id: true },
    });

    const since = new Date();
    since.setDate(since.getDate() - 30);

    const recentApps = await prisma.application.findMany({
      where: { createdAt: { gte: since } },
      select: { createdAt: true, status: true, submittedAt: true },
    });

    const byDay = {};
    for (let i = 0; i <= 30; i++) {
      const d = new Date();
      d.setDate(d.getDate() - (30 - i));
      byDay[d.toISOString().slice(0, 10)] = { created: 0, submitted: 0 };
    }
    recentApps.forEach((a) => {
      const createdKey = new Date(a.createdAt).toISOString().slice(0, 10);
      if (byDay[createdKey]) byDay[createdKey].created += 1;
      if (a.submittedAt) {
        const subKey = new Date(a.submittedAt).toISOString().slice(0, 10);
        if (byDay[subKey]) byDay[subKey].submitted += 1;
      }
    });

    res.json({
      success: true,
      data: {
        total,
        draft,
        pending,
        approved,
        declined,
        approvalRate: total - draft > 0 ? Math.round((approved / (approved + declined || 1)) * 100) : 0,
        byEmployment: byEmployment.map((e) => ({
          status: e.employmentStatus || 'UNKNOWN',
          count: e._count.id,
        })),
        dailyActivity: Object.entries(byDay).map(([date, v]) => ({
          date,
          created: v.created,
          submitted: v.submitted,
        })),
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Failed to fetch application stats' });
  }
});

// ─── Analytics (charts) ─────────────────────────────────────────────────────
router.get('/stats/analytics', async (req, res) => {
  try {
    const days = Math.min(90, Math.max(7, parseInt(req.query.days || '30', 10)));
    const since = new Date();
    since.setDate(since.getDate() - days);

    const [users, apps, decisions] = await Promise.all([
      prisma.user.findMany({
        where: { role: 'APPLICANT', createdAt: { gte: since } },
        select: { createdAt: true },
      }),
      prisma.application.findMany({
        where: { createdAt: { gte: since } },
        select: { createdAt: true, status: true, submittedAt: true },
      }),
      prisma.application.findMany({
        where: {
          reviewedAt: { gte: since },
          status: { in: ['APPROVED', 'DECLINED'] },
        },
        select: { reviewedAt: true, status: true },
      }),
    ]);

    const timeline = {};
    for (let i = 0; i <= days; i++) {
      const d = new Date();
      d.setDate(d.getDate() - (days - i));
      const key = d.toISOString().slice(0, 10);
      timeline[key] = { registrations: 0, applications: 0, approved: 0, declined: 0 };
    }

    users.forEach((u) => {
      const k = new Date(u.createdAt).toISOString().slice(0, 10);
      if (timeline[k]) timeline[k].registrations += 1;
    });
    apps.forEach((a) => {
      const k = new Date(a.createdAt).toISOString().slice(0, 10);
      if (timeline[k]) timeline[k].applications += 1;
    });
    decisions.forEach((a) => {
      const k = new Date(a.reviewedAt).toISOString().slice(0, 10);
      if (timeline[k]) {
        if (a.status === 'APPROVED') timeline[k].approved += 1;
        if (a.status === 'DECLINED') timeline[k].declined += 1;
      }
    });

    const series = Object.entries(timeline).map(([date, v]) => ({ date, ...v }));

    const statusTotals = {
      draft: await prisma.application.count({ where: { status: 'DRAFT' } }),
      pending: await prisma.application.count({ where: { status: 'PENDING' } }),
      approved: await prisma.application.count({ where: { status: 'APPROVED' } }),
      declined: await prisma.application.count({ where: { status: 'DECLINED' } }),
    };

    res.json({
      success: true,
      data: {
        days,
        series,
        statusTotals,
        totals: {
          registrations: users.length,
          applications: apps.length,
          approved: decisions.filter((d) => d.status === 'APPROVED').length,
          declined: decisions.filter((d) => d.status === 'DECLINED').length,
        },
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Failed to fetch analytics' });
  }
});

// ─── SLA Monitor ────────────────────────────────────────────────────────────
router.get('/sla', async (req, res) => {
  try {
    const pending = await prisma.application.findMany({
      where: { status: 'PENDING' },
      include: {
        user: { select: { email: true, firstName: true, lastName: true } },
      },
      orderBy: { submittedAt: 'asc' },
    });

    const now = new Date();
    const items = pending.map((app) => {
      const submitted = app.submittedAt || app.createdAt;
      const ageDays = daysBetween(submitted, now);
      const remaining = SLA_DAYS - (ageDays ?? 0);
      let slaStatus = 'ON_TRACK';
      if (remaining < 0) slaStatus = 'BREACHED';
      else if (remaining <= 3) slaStatus = 'AT_RISK';

      return {
        id: app.id,
        fullName: [app.names, app.surname].filter(Boolean).join(' ') || 'N/A',
        email: app.user?.email || '—',
        cellNumber: app.cellNumber || '—',
        submittedAt: submitted,
        submittedDate: new Date(submitted).toLocaleDateString('en-ZA'),
        ageDays,
        slaDays: SLA_DAYS,
        remainingDays: remaining,
        slaStatus,
      };
    });

    const summary = {
      slaDays: SLA_DAYS,
      totalPending: items.length,
      onTrack: items.filter((i) => i.slaStatus === 'ON_TRACK').length,
      atRisk: items.filter((i) => i.slaStatus === 'AT_RISK').length,
      breached: items.filter((i) => i.slaStatus === 'BREACHED').length,
    };

    // Completed applications average resolution time
    const completed = await prisma.application.findMany({
      where: {
        status: { in: ['APPROVED', 'DECLINED'] },
        submittedAt: { not: null },
        reviewedAt: { not: null },
      },
      select: { submittedAt: true, reviewedAt: true, status: true },
      take: 500,
      orderBy: { reviewedAt: 'desc' },
    });

    const resolutionDays = completed
      .map((c) => daysBetween(c.submittedAt, c.reviewedAt))
      .filter((d) => d != null && d >= 0);

    const avgResolution =
      resolutionDays.length > 0
        ? Math.round((resolutionDays.reduce((a, b) => a + b, 0) / resolutionDays.length) * 10) / 10
        : null;

    res.json({
      success: true,
      data: {
        summary: { ...summary, avgResolutionDays: avgResolution },
        items,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Failed to fetch SLA data' });
  }
});

// ─── Audit logs ─────────────────────────────────────────────────────────────
router.get('/audit-logs', async (req, res) => {
  try {
    const { page = 1, limit = 50, action, search } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10)));
    const skip = (pageNum - 1) * limitNum;

    const where = {};
    if (action && action !== 'ALL') where.action = action;
    if (search) {
      where.OR = [
        { userEmail: { contains: search, mode: 'insensitive' } },
        { action: { contains: search, mode: 'insensitive' } },
        { entityType: { contains: search, mode: 'insensitive' } },
        { details: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limitNum,
      }),
      prisma.auditLog.count({ where }),
    ]);

    res.json({
      success: true,
      data: logs,
      pagination: { page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Failed to fetch audit logs' });
  }
});

// Export helpers return JSON rows; client generates CSV/PDF
router.get('/export/applicants', async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      where: { role: 'APPLICANT' },
      select: {
        email: true,
        firstName: true,
        lastName: true,
        cellNumber: true,
        idNumber: true,
        isVerified: true,
        createdAt: true,
        _count: { select: { applications: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    await writeAuditLog({
      userId: req.user.id,
      userEmail: req.user.email,
      userRole: req.user.role,
      action: 'EXPORT_APPLICANTS',
      entityType: 'User',
      details: { count: users.length },
      ipAddress: getClientIp(req),
    });

    res.json({
      success: true,
      data: users.map((u) => ({
        fullName: [u.firstName, u.lastName].filter(Boolean).join(' '),
        email: u.email,
        cellNumber: u.cellNumber || '',
        idNumber: u.idNumber || '',
        verified: u.isVerified ? 'Yes' : 'No',
        applications: u._count.applications,
        registeredAt: new Date(u.createdAt).toISOString(),
      })),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Export failed' });
  }
});

router.get('/export/applications', async (req, res) => {
  try {
    const apps = await prisma.application.findMany({
      include: { user: { select: { email: true } } },
      orderBy: { createdAt: 'desc' },
    });

    await writeAuditLog({
      userId: req.user.id,
      userEmail: req.user.email,
      userRole: req.user.role,
      action: 'EXPORT_APPLICATIONS',
      entityType: 'Application',
      details: { count: apps.length },
      ipAddress: getClientIp(req),
    });

    res.json({
      success: true,
      data: apps.map((a) => ({
        id: a.id,
        fullName: [a.names, a.surname].filter(Boolean).join(' '),
        email: a.user?.email || '',
        cellNumber: a.cellNumber || '',
        idNumber: a.idNumber || '',
        status: a.status,
        employmentStatus: a.employmentStatus || '',
        totalHouseholdIncome: a.totalHouseholdIncome != null ? Number(a.totalHouseholdIncome) : '',
        residentialAddress: a.residentialAddress || '',
        addressVerified: a.addressVerified ? 'Yes' : 'No',
        submittedAt: a.submittedAt ? new Date(a.submittedAt).toISOString() : '',
        reviewedAt: a.reviewedAt ? new Date(a.reviewedAt).toISOString() : '',
        createdAt: new Date(a.createdAt).toISOString(),
      })),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Export failed' });
  }
});

module.exports = router;
