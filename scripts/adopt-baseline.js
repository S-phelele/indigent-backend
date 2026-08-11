#!/usr/bin/env node
/**
 * Move an existing database onto the squashed baseline, without touching data.
 *
 *     node scripts/adopt-baseline.js
 *
 * Anybody whose database was built by the old nineteen migrations needs this
 * once. A fresh clone does not — `npm run db:setup` applies the baseline to an
 * empty database and there is nothing to adopt.
 *
 * ## What the problem actually is
 *
 * Prisma records every applied migration by name and checksum. After the squash
 * those nineteen names no longer exist on disk, and the one name that does has
 * never been recorded — so `migrate deploy` would try to create tables that are
 * already there and fail on the first CREATE TABLE.
 *
 * The fix is bookkeeping, not schema: replace the nineteen rows with one row
 * saying the baseline is already applied. **No DDL runs.** The database is
 * untouched; only Prisma's record of how it got that way changes.
 *
 * ## Why it refuses when the schema does not match
 *
 * Marking the baseline as applied is a promise that the database already looks
 * exactly like it. If that is not true, the promise is a lie and the next
 * migration will fail somewhere much harder to diagnose. So it is checked first,
 * and a mismatch stops everything.
 */

const { execSync } = require('child_process');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const ROOT = path.join(__dirname, '..');
const PRISMA = path.join(ROOT, 'node_modules', 'prisma', 'build', 'index.js');
const BASELINE = '00000000000000_baseline';

require('dotenv').config({ path: path.join(ROOT, '.env') });
const prisma = new PrismaClient();

const say = (m) => console.log(m);

(async () => {
  say('\nAdopting the squashed baseline\n');

  // -------------------------------------------------------------------------
  say('1. Looking at what is recorded');
  let recorded = [];
  try {
    recorded = await prisma.$queryRaw`
      SELECT migration_name FROM _prisma_migrations ORDER BY started_at`;
  } catch {
    say('   No migration history at all — this looks like a fresh database.');
    say('   Run `npm run db:setup` instead; there is nothing to adopt.\n');
    await prisma.$disconnect();
    process.exit(1);
  }

  const names = recorded.map((r) => r.migration_name);
  if (names.length === 1 && names[0] === BASELINE) {
    say('   Already on the baseline. Nothing to do.\n');
    await prisma.$disconnect();
    return;
  }
  say(`   ${names.length} migration(s) recorded, none of them the baseline.`);

  // -------------------------------------------------------------------------
  say('\n2. Checking the database already matches the schema');
  let drift = '';
  try {
    drift = execSync(
      `node "${PRISMA}" migrate diff --from-schema-datasource prisma/schema.prisma `
      + '--to-schema-datamodel prisma/schema.prisma --script',
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
  } catch (error) {
    say('   Could not compare the database with the schema. Stopping.');
    await prisma.$disconnect();
    process.exit(1);
  }

  // The diff prints only comments when there is nothing to change.
  const meaningful = drift
    .split('\n')
    .filter((line) => line.trim() && !line.trim().startsWith('--'));

  if (meaningful.length) {
    say('   Your database does NOT match the schema. Stopping before anything is changed.\n');
    say('   What differs:');
    meaningful.slice(0, 12).forEach((line) => say(`     ${line.trim()}`));
    if (meaningful.length > 12) say(`     … and ${meaningful.length - 12} more`);
    say('\n   Bring it up to date first, or if this is throwaway data, start clean:');
    say('     npm run db:reset\n');
    await prisma.$disconnect();
    process.exit(1);
  }
  say('   It matches. Marking the baseline as applied is safe.');

  // -------------------------------------------------------------------------
  say('\n3. Checking the audit-trail triggers are present');
  const [{ count: triggerCount }] = await prisma.$queryRaw`
    SELECT count(*)::int AS count FROM pg_trigger WHERE NOT tgisinternal`;
  if (triggerCount < 8) {
    /**
     * A database built before the triggers existed would pass the schema check
     * above and still be missing them, because Prisma's schema has no idea they
     * exist. Applying them here rather than leaving a silently unprotected audit
     * trail.
     */
    say(`   Only ${triggerCount} of 8 found. Applying them from the baseline.`);
    const fs = require('fs');
    const sql = fs.readFileSync(
      path.join(ROOT, 'prisma', 'migrations', BASELINE, 'migration.sql'), 'utf8'
    );
    const beyond = sql.split('-- Beyond the schema')[1];
    if (!beyond) {
      say('   Could not find the trigger section in the baseline. Stopping.');
      await prisma.$disconnect();
      process.exit(1);
    }
    for (const statement of beyond.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) {
      if (!/^(CREATE|DROP)/im.test(statement)) continue;
      await prisma.$executeRawUnsafe(`${statement};`);
    }
    say('   Applied.');
  } else {
    say(`   All ${triggerCount} present.`);
  }

  // -------------------------------------------------------------------------
  say('\n4. Rewriting the migration history');
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`DELETE FROM _prisma_migrations`;
    await tx.$executeRaw`
      INSERT INTO _prisma_migrations
        (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
      VALUES (gen_random_uuid()::text, '', NOW(), ${BASELINE}, NULL, NULL, NOW(), 1)`;
  });
  say(`   ${names.length} old rows replaced with one: ${BASELINE}`);

  /**
   * The checksum is left empty on purpose.
   *
   * Prisma fills it in on the next `migrate deploy` and compares from then on. A
   * value invented here would be wrong, and a wrong checksum reads as "somebody
   * edited an applied migration" — the exact alarm this is trying not to raise.
   */

  say('\nDone. Your data is untouched. Check it with:\n');
  say('  npx prisma migrate status');
  say('  npm run verify:audit\n');

  await prisma.$disconnect();
})().catch(async (error) => {
  console.error('\nAdoption failed:', error.message);
  console.error('Nothing was changed unless step 4 reported success.\n');
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
