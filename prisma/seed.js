const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');

/**
 * The starting set of accounts, for a database that has just been built.
 *
 * One account per role, because the approval chain enforces separation of
 * duties: whoever verified an application may not also assess it, and whoever
 * assessed it may not sign it off. A single admin account cannot walk a case
 * through the chain, so seeding one would leave a new developer unable to test
 * the main thing the system does.
 *
 * Idempotent. Running it again resets the passwords and reactivates the
 * accounts, which is also how to recover when somebody changes one mid-test.
 * It never touches an account outside this list.
 *
 * These are development credentials with a published password. `npm run
 * db:demo:remove` takes them out again, and they must not exist on a live
 * register.
 */

const prisma = new PrismaClient();

const PASSWORD = 'Demo@2026';
const DOMAIN = '@demo.local';

const ACCOUNTS = [
  { email: `superuser${DOMAIN}`, role: 'SUPERUSER', firstName: 'Zanele', lastName: 'Khumalo',
    does: 'Everything, including every stage of one case' },
  { email: `admin${DOMAIN}`, role: 'ADMIN', firstName: 'Ayanda', lastName: 'Mahlangu',
    does: 'Everything, including the final decision' },
  { email: `councillor${DOMAIN}`, role: 'COUNCILLOR', firstName: 'Bongani', lastName: 'Zulu', ward: 'Ward 7',
    does: 'Registers households door to door' },
  { email: `capture${DOMAIN}`, role: 'CAPTURE_OFFICER', firstName: 'Carol', lastName: 'Petersen',
    does: 'Captures walk-in applications at the front desk' },
  { email: `verifier${DOMAIN}`, role: 'VERIFICATION_OFFICER', firstName: 'Dumisani', lastName: 'Ndlovu',
    does: 'Site visits and external checks' },
  { email: `assessor${DOMAIN}`, role: 'ASSESSMENT_OFFICER', firstName: 'Elmarie', lastName: 'van Wyk',
    does: 'Applies the means test against the threshold' },
  { email: `supervisor${DOMAIN}`, role: 'SUPERVISOR', firstName: 'Farai', lastName: 'Chikafu',
    does: 'Signs the application off' },
  /**
   * The applicant needs an ID number and a verified cell number, or they cannot
   * get past the verification gate to start an application at all — which would
   * make the whole walkthrough untestable from the first screen.
   */
  { email: `applicant${DOMAIN}`, role: 'APPLICANT', firstName: 'Grace', lastName: 'Mthembu',
    cellNumber: '+27821110001', idNumber: '8503124800081', does: 'Applies for support' },
];

async function seed() {
  const password = await bcrypt.hash(PASSWORD, 10);

  for (const account of ACCOUNTS) {
    const { does, ...fields } = account;
    await prisma.user.upsert({
      where: { email: account.email },
      update: {
        password,
        role: account.role,
        isActive: true,
        /**
         * Re-asserted on every seed, not only on create.
         *
         * An applicant whose number is unverified is refused every route by the
         * cell-verification gate, so a re-seeded account that kept an old
         * unverified state would look broken in a way nothing on screen
         * explains. The date is set too: submission freezes it onto the
         * application, and a null there reads as "verified, nobody knows when".
         */
        isVerified: true,
        cellVerifiedAt: new Date(),
        // Cleared deliberately. The forced password change is right for a real
        // account created by somebody else, and would stop a developer at the
        // first screen.
        mustChangePassword: false,
      },
      create: { ...fields, password, isVerified: true, cellVerifiedAt: new Date() },
    });
  }

  const width = Math.max(...ACCOUNTS.map((a) => a.email.length));
  console.log(`\n${ACCOUNTS.length} accounts ready. Password for all of them: ${PASSWORD}\n`);
  ACCOUNTS.forEach((a) => console.log(`  ${a.email.padEnd(width)}  ${a.does}`));
  console.log(`
  Applicant portal  http://localhost:5173   applicant${DOMAIN}
  Admin portal      http://localhost:5174   everyone else
`);
}

/**
 * Remove them again.
 *
 * An account that has captured or owns applications is left alone rather than
 * deleted: deleting it would cascade and take that work with it. Refusing is the
 * recoverable failure; a surprise cascade is not.
 */
async function remove() {
  const accounts = await prisma.user.findMany({
    where: { email: { endsWith: DOMAIN } },
    select: { id: true, email: true, _count: { select: { applications: true, captured: true } } },
  });

  const busy = accounts.filter((a) => a._count.applications > 0 || a._count.captured > 0);
  if (busy.length) {
    console.log('\nThese accounts have work attached and were left alone:\n');
    busy.forEach((a) => console.log(`  ${a.email} — ${a._count.applications} application(s), ${a._count.captured} capture(s)`));
    console.log('\nDelete those applications first if you really want the accounts gone.\n');
  }

  const removable = accounts.filter((a) => a._count.applications === 0 && a._count.captured === 0);
  const { count } = await prisma.user.deleteMany({ where: { id: { in: removable.map((a) => a.id) } } });
  console.log(`Removed ${count} account(s).`);
}

if (require.main === module) {
  (async () => {
    try {
      if (process.argv.includes('--remove')) await remove();
      else await seed();
    } catch (error) {
      console.error('Seed failed:', error.message);
      process.exitCode = 1;
    } finally {
      await prisma.$disconnect();
    }
  })();
}

module.exports = { ACCOUNTS, PASSWORD, DOMAIN, seed, remove };
