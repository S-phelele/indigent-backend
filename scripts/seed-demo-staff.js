#!/usr/bin/env node
/**
 * Create one working account per role, so the whole workflow can be walked
 * through by hand.
 *
 *     node scripts/seed-demo-staff.js
 *
 * ## What it does and does not touch
 *
 * It only ever creates or updates the seven accounts listed below, all of them
 * on the @demo.local domain. It never reads, changes or deletes an applicant, an
 * application, or any account that is not on that domain. Running it twice is
 * safe: existing demo accounts have their password reset and are reactivated,
 * which is also how to recover if somebody changes one mid-test.
 *
 * ## Why the accounts are separate people
 *
 * The approval chain enforces separation of duties: whoever verified an
 * application may not also assess it, and whoever assessed it may not sign it
 * off. Testing that with one account wearing several hats would pass while
 * proving nothing, because the rule being tested is precisely that one person
 * cannot do two of these jobs.
 *
 * ## Remove them afterwards
 *
 *     node scripts/seed-demo-staff.js --remove
 *
 * These are not production accounts. They share a published password and exist
 * so a workflow can be demonstrated; leaving them enabled on a live register
 * would be a way in.
 */

const bcrypt = require('bcryptjs');
const prisma = require('./../src/lib/prisma');

const PASSWORD = 'Demo@2026';
const DOMAIN = '@demo.local';

const PEOPLE = [
  { email: `admin${DOMAIN}`, role: 'ADMIN', firstName: 'Ayanda', lastName: 'Mahlangu', does: 'Everything, including the final decision' },
  { email: `councillor${DOMAIN}`, role: 'COUNCILLOR', firstName: 'Bongani', lastName: 'Zulu', ward: 'Ward 7', does: 'Registers households door to door' },
  { email: `capture${DOMAIN}`, role: 'CAPTURE_OFFICER', firstName: 'Carol', lastName: 'Petersen', does: 'Captures walk-in applications at the front desk' },
  { email: `verifier${DOMAIN}`, role: 'VERIFICATION_OFFICER', firstName: 'Dumisani', lastName: 'Ndlovu', does: 'Site visits and external checks' },
  { email: `assessor${DOMAIN}`, role: 'ASSESSMENT_OFFICER', firstName: 'Elmarie', lastName: 'van Wyk', does: 'Applies the means test against the threshold' },
  { email: `supervisor${DOMAIN}`, role: 'SUPERVISOR', firstName: 'Farai', lastName: 'Chikafu', does: 'Signs the application off' },
  { email: `applicant${DOMAIN}`, role: 'APPLICANT', firstName: 'Grace', lastName: 'Mthembu', cellNumber: '+27821110001', does: 'Applies for support' },
];

async function remove() {
  /**
   * Applications are detached rather than deleted along with the account.
   *
   * If somebody has walked a real household through the demo, deleting the
   * account would cascade and take that work with it. Refusing to delete an
   * account that has applications is the safe failure: it is recoverable, and
   * a surprise cascade is not.
   */
  const accounts = await prisma.user.findMany({
    where: { email: { endsWith: DOMAIN } },
    select: { id: true, email: true, _count: { select: { applications: true } } },
  });

  const withWork = accounts.filter((a) => a._count.applications > 0);
  if (withWork.length) {
    console.log('\nThese demo accounts have applications attached and were left alone:\n');
    withWork.forEach((a) => console.log(`  ${a.email} — ${a._count.applications} application(s)`));
    console.log('\nDelete those applications first if you really want the accounts gone.\n');
  }

  const removable = accounts.filter((a) => a._count.applications === 0).map((a) => a.id);
  const { count } = await prisma.user.deleteMany({ where: { id: { in: removable } } });
  console.log(`Removed ${count} demo account(s).`);
}

async function seed() {
  const password = await bcrypt.hash(PASSWORD, 10);

  for (const person of PEOPLE) {
    const { does, ...fields } = person;
    await prisma.user.upsert({
      where: { email: person.email },
      update: {
        password,
        role: person.role,
        isActive: true,
        // Cleared deliberately: the forced password change is correct for a real
        // account created by somebody else, but it would stop a walkthrough at
        // the first screen.
        mustChangePassword: false,
      },
      create: { ...fields, password, isVerified: true },
    });
  }

  console.log(`\nSeven demo accounts are ready. Password for all of them: ${PASSWORD}\n`);
  const width = Math.max(...PEOPLE.map((p) => p.email.length));
  for (const p of PEOPLE) {
    console.log(`  ${p.email.padEnd(width)}  ${p.does}`);
  }
  console.log(`
  Admin portal      http://localhost:5174   everyone except the applicant
  Applicant portal  http://localhost:5173   applicant${DOMAIN}

Remove them again with:  node scripts/seed-demo-staff.js --remove
`);
}

(async () => {
  try {
    if (process.argv.includes('--remove')) await remove();
    else await seed();
  } catch (error) {
    console.error('Could not seed the demo accounts:', error.message);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();
