const express = require('express');
const prisma = require('../lib/prisma');
const { protect } = require('../middleware/auth');

const router = express.Router();

router.use(...protect);

/**
 * The recipient's own inbox. There is deliberately no way to read anyone else's:
 * every query is scoped to req.user.id rather than taking an id from the client.
 */
router.get('/', async (req, res) => {
  try {
    const { unreadOnly, page = 1, limit = 20 } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));

    const where = { userId: req.user.id, ...(unreadOnly === 'true' ? { readAt: null } : {}) };

    const [notifications, total, unread] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (pageNum - 1) * limitNum,
        take: limitNum,
      }),
      prisma.notification.count({ where }),
      prisma.notification.count({ where: { userId: req.user.id, readAt: null } }),
    ]);

    res.json({
      success: true,
      data: notifications,
      unreadCount: unread,
      pagination: { page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) },
    });
  } catch (error) {
    console.error('notifications list error:', error);
    res.status(500).json({ success: false, message: 'We could not load your notifications. Please try again.' });
  }
});

/** Cheap endpoint for the bell badge — polled far more often than the list. */
router.get('/unread-count', async (req, res) => {
  try {
    const unreadCount = await prisma.notification.count({
      where: { userId: req.user.id, readAt: null },
    });
    res.json({ success: true, data: { unreadCount } });
  } catch (error) {
    console.error('unread-count error:', error);
    res.status(500).json({ success: false, message: 'We could not load your notifications. Please try again.' });
  }
});

router.patch('/:id/read', async (req, res) => {
  try {
    // updateMany rather than update, so the userId scope is part of the write —
    // a mismatched id affects zero rows instead of touching someone else's inbox.
    const result = await prisma.notification.updateMany({
      where: { id: req.params.id, userId: req.user.id, readAt: null },
      data: { readAt: new Date() },
    });

    if (result.count === 0) {
      const exists = await prisma.notification.findFirst({
        where: { id: req.params.id, userId: req.user.id },
        select: { id: true },
      });
      if (!exists) return res.status(404).json({ success: false, message: 'We could not find that notification.' });
    }

    res.json({ success: true, message: 'Marked as read' });
  } catch (error) {
    console.error('mark read error:', error);
    res.status(500).json({ success: false, message: 'We could not update that notification. Please try again.' });
  }
});

router.post('/read-all', async (req, res) => {
  try {
    const result = await prisma.notification.updateMany({
      where: { userId: req.user.id, readAt: null },
      data: { readAt: new Date() },
    });
    res.json({ success: true, message: `Marked ${result.count} as read`, data: { updated: result.count } });
  } catch (error) {
    console.error('read-all error:', error);
    res.status(500).json({ success: false, message: 'We could not update your notifications. Please try again.' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await prisma.notification.deleteMany({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (result.count === 0) {
      return res.status(404).json({ success: false, message: 'We could not find that notification.' });
    }
    res.json({ success: true, message: 'Notification removed' });
  } catch (error) {
    console.error('delete notification error:', error);
    res.status(500).json({ success: false, message: 'We could not remove that notification. Please try again.' });
  }
});

module.exports = router;
