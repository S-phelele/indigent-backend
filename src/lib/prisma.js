const { PrismaClient } = require('@prisma/client');

// Single shared client. Each `new PrismaClient()` opens its own connection pool,
// so instantiating one per route file multiplies pools against the same database.
// New code should require this module rather than constructing its own client.
const prisma = new PrismaClient();

module.exports = prisma;
