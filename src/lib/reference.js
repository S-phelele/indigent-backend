const prisma = require('./prisma');

/**
 * Human-readable application references: IND-2026-00042.
 *
 * The UUID primary key is unreadable over a phone, and the admin table was
 * showing its first eight characters as a stand-in. Applicants and call-centre
 * staff need something that can be spoken, written on a form, and searched.
 *
 * Numbering restarts each calendar year, which is how municipal filing usually
 * works and keeps the number short.
 */

const PREFIX = process.env.REFERENCE_PREFIX || 'IND';

/**
 * Allocate the next reference for the current year.
 *
 * Uses a transaction with a serialisable isolation level so two applications
 * submitted at the same moment cannot take the same number. The unique index on
 * `reference` is the final backstop; on the rare conflict we retry.
 */
async function allocate(year = new Date().getUTCFullYear(), attempt = 0) {
  const prefix = `${PREFIX}-${year}-`;

  const latest = await prisma.application.findFirst({
    where: { reference: { startsWith: prefix } },
    orderBy: { reference: 'desc' },
    select: { reference: true },
  });

  const lastSequence = latest ? parseInt(latest.reference.slice(prefix.length), 10) : 0;
  const next = (Number.isFinite(lastSequence) ? lastSequence : 0) + 1;
  const reference = `${prefix}${String(next).padStart(5, '0')}`;

  // Cheap existence check; the unique constraint still guards the real race.
  const clash = await prisma.application.findUnique({ where: { reference }, select: { id: true } });
  if (clash) {
    if (attempt >= 5) throw new Error('Could not allocate an application reference');
    return allocate(year, attempt + 1);
  }

  return reference;
}

module.exports = { allocate, PREFIX };
