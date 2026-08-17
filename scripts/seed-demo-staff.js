#!/usr/bin/env node
/**
 * Kept as the name people already type. The seed itself lives in
 * `prisma/seed.js`, so `npx prisma migrate reset` and this command create
 * exactly the same accounts.
 *
 * Two seeds with different credentials is precisely how "it works on my machine"
 * starts, so there is only one list and this defers to it.
 *
 *     node scripts/seed-demo-staff.js            create or reset them
 *     node scripts/seed-demo-staff.js --remove   take them out again
 */
/**
 * Called, not merely required.
 *
 * `prisma/seed.js` guards its own entry point with `require.main === module` so
 * that importing it does not seed as a side effect. Requiring it from here
 * therefore ran nothing at all: `npm run demo:seed` printed no output, exited
 * zero, and created no accounts — so the whole walkthrough failed at the sign-in
 * screen with nothing to say why.
 */
const { seed, remove } = require('../prisma/seed');
const prisma = require('../src/lib/prisma');

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
