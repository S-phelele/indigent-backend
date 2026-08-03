const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { authenticate } = require('../middleware/auth');
const { geocodeAddress } = require('../utils/geocode');

const router = express.Router();
const prisma = new PrismaClient();

router.use(authenticate);

/**
 * POST /api/geocode
 * Body: { address: string, applicationId?: string }
 * Geocodes address via Google Maps and optionally saves to application.
 */
router.post('/', async (req, res) => {
  try {
    const { address, applicationId } = req.body;

    if (!address || !String(address).trim()) {
      return res.status(400).json({ success: false, message: 'Address is required' });
    }

    const result = await geocodeAddress(address);

    // If applicationId provided, persist verification on that draft (owner or admin)
    if (applicationId) {
      const application = await prisma.application.findUnique({
        where: { id: applicationId },
      });

      if (!application) {
        return res.status(404).json({ success: false, message: 'Application not found' });
      }

      if (req.user.role !== 'ADMIN' && application.userId !== req.user.id) {
        return res.status(403).json({ success: false, message: 'Access denied' });
      }

      const updated = await prisma.application.update({
        where: { id: applicationId },
        data: {
          residentialAddress: address.trim(),
          addressLatitude: result.latitude,
          addressLongitude: result.longitude,
          addressFormatted: result.formattedAddress,
          addressPlaceId: result.placeId,
          addressVerified: true,
          addressVerifiedAt: new Date(),
        },
        include: { documents: true },
      });

      return res.json({
        success: true,
        message: 'Address verified successfully',
        data: {
          ...result,
          application: updated,
        },
      });
    }

    res.json({
      success: true,
      message: 'Address verified successfully',
      data: result,
    });
  } catch (error) {
    console.error('Geocode error:', error);
    const status =
      error.code === 'NO_API_KEY' || error.code === 'REQUEST_DENIED'
        ? 503
        : error.code === 'ZERO_RESULTS' || error.code === 'INVALID_ADDRESS'
          ? 400
          : 500;

    res.status(status).json({
      success: false,
      message: error.message || 'Failed to verify address',
      code: error.code,
    });
  }
});

module.exports = router;
