const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

router.use(authenticate, requireAdmin);

// List applications with filters & pagination
router.get('/applications', async (req, res) => {
  try {
    const {
      status,          // PENDING | APPROVED | DECLINED | ALL
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
      // Exclude drafts from admin view by default
      where.status = { in: ['PENDING', 'APPROVED', 'DECLINED'] };
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
        orderBy: { [sortBy]: sortOrder === 'asc' ? 'asc' : 'desc' },
        skip,
        take: limitNum,
      }),
      prisma.application.count({ where }),
    ]);

    // Format for frontend table
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

// Get single application detail
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

    res.json({ success: true, data: application });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Failed to fetch application' });
  }
});

// Update application status (Approve / Decline)
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
      include: { documents: true, user: { select: { email: true, firstName: true, lastName: true } } },
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

// Dashboard stats
router.get('/stats', async (req, res) => {
  try {
    const [pending, approved, declined, total] = await Promise.all([
      prisma.application.count({ where: { status: 'PENDING' } }),
      prisma.application.count({ where: { status: 'APPROVED' } }),
      prisma.application.count({ where: { status: 'DECLINED' } }),
      prisma.application.count({ where: { status: { in: ['PENDING', 'APPROVED', 'DECLINED'] } } }),
    ]);

    res.json({
      success: true,
      data: { pending, approved, declined, total },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Failed to fetch stats' });
  }
});

module.exports = router;
