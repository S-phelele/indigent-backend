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
require('../prisma/seed');
