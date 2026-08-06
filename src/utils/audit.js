const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function writeAuditLog({
  userId = null,
  userEmail = null,
  userRole = null,
  action,
  entityType = null,
  entityId = null,
  details = null,
  ipAddress = null,
}) {
  try {
    await prisma.auditLog.create({
      data: {
        userId,
        userEmail,
        userRole,
        action,
        entityType,
        entityId,
        details: typeof details === 'object' ? JSON.stringify(details) : details,
        ipAddress,
      },
    });
  } catch (err) {
    console.error('Audit log write failed:', err.message);
  }
}

function getClientIp(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    null
  );
}

module.exports = { writeAuditLog, getClientIp };
