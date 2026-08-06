const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const { authenticate } = require('../middleware/auth');
const { writeAuditLog, getClientIp } = require('../utils/audit');

const router = express.Router();
const prisma = new PrismaClient();

const generateToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
};

// Register (Applicant)
router.post('/register', async (req, res) => {
  try {
    const { email, password, firstName, lastName, cellNumber, idNumber } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required' });
    }

    // Password rules: min 8 chars, upper, lower, special
    const passwordErrors = [];
    if (password.length < 8) passwordErrors.push('at least 8 characters');
    if (!/[A-Z]/.test(password)) passwordErrors.push('a capital letter');
    if (!/[a-z]/.test(password)) passwordErrors.push('a small letter');
    if (!/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`~]/.test(password)) {
      passwordErrors.push('a special character (e.g. @, !, #, %, &)');
    }
    if (passwordErrors.length) {
      return res.status(400).json({
        success: false,
        message: `Password must include ${passwordErrors.join(', ')}`,
      });
    }

    const existing = await prisma.user.findFirst({
      where: {
        OR: [
          { email },
          ...(idNumber ? [{ idNumber }] : []),
        ],
      },
    });

    if (existing) {
      return res.status(400).json({ success: false, message: 'Email or ID number already registered' });
    }

    const hashed = await bcrypt.hash(password, 12);

    const user = await prisma.user.create({
      data: {
        email,
        password: hashed,
        firstName,
        lastName,
        cellNumber,
        idNumber,
        role: 'APPLICANT',
      },
      select: { id: true, email: true, role: true, firstName: true, lastName: true, cellNumber: true },
    });

    const token = generateToken(user.id);

    await writeAuditLog({
      userId: user.id,
      userEmail: user.email,
      userRole: user.role,
      action: 'REGISTER',
      entityType: 'User',
      entityId: user.id,
      ipAddress: getClientIp(req),
    });

    res.status(201).json({
      success: true,
      message: 'Registration successful',
      data: { user, token },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Registration failed' });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required' });
    }

    const user = await prisma.user.findUnique({ where: { email } });

    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    const token = generateToken(user.id);

    await writeAuditLog({
      userId: user.id,
      userEmail: user.email,
      userRole: user.role,
      action: 'LOGIN',
      entityType: 'User',
      entityId: user.id,
      ipAddress: getClientIp(req),
    });

    res.json({
      success: true,
      message: 'Login successful',
      data: {
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
          firstName: user.firstName,
          lastName: user.lastName,
          cellNumber: user.cellNumber,
          idNumber: user.idNumber,
          isVerified: user.isVerified,
        },
        token,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Login failed' });
  }
});

// Send OTP to cell number
router.post('/send-otp', async (req, res) => {
  try {
    const { cellNumber } = req.body;

    if (!cellNumber || cellNumber.length < 10) {
      return res.status(400).json({ success: false, message: 'Valid cell number is required' });
    }

    // Generate 6-digit OTP
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiryMinutes = parseInt(process.env.OTP_EXPIRY_MINUTES || '10', 10);
    const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000);

    // Invalidate previous OTPs for this number
    await prisma.otp.updateMany({
      where: { cellNumber, used: false },
      data: { used: true },
    });

    await prisma.otp.create({
      data: {
        cellNumber,
        code,
        expiresAt,
        userId: req.user?.id || null,
      },
    });

    // In production: send SMS via gateway. For demo we log it.
    console.log(`[OTP] Cell: ${cellNumber} | Code: ${code} | Expires: ${expiresAt.toISOString()}`);

    res.json({
      success: true,
      message: `OTP sent to number ending in ${cellNumber.slice(-4)}`,
      // Only for development/demo – remove in production
      demoOtp: process.env.NODE_ENV !== 'production' ? code : undefined,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Failed to send OTP' });
  }
});

// Verify OTP
router.post('/verify-otp', async (req, res) => {
  try {
    const { cellNumber, code } = req.body;

    if (!cellNumber || !code) {
      return res.status(400).json({ success: false, message: 'Cell number and OTP code are required' });
    }

    const otp = await prisma.otp.findFirst({
      where: {
        cellNumber,
        code,
        used: false,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!otp) {
      return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
    }

    await prisma.otp.update({
      where: { id: otp.id },
      data: { used: true },
    });

    // Mark user as verified if logged in
    if (req.headers.authorization) {
      try {
        const token = req.headers.authorization.split(' ')[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        await prisma.user.update({
          where: { id: decoded.userId },
          data: { isVerified: true, cellNumber },
        });
      } catch (_) {}
    }

    res.json({
      success: true,
      message: 'OTP verified successfully',
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'OTP verification failed' });
  }
});

// Get current user
router.get('/me', authenticate, async (req, res) => {
  res.json({ success: true, data: req.user });
});

module.exports = router;
