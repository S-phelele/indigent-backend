#!/usr/bin/env node
/**
 * Get a working database, from nothing, in one command.
 *
 *     npm run db:setup
 *
 * Written because "clone the repo and run these six commands in the right order"
 * is how a team ends up with six subtly different databases. This does the whole
 * thing, checks each step actually worked, and says plainly which one failed
 * rather than leaving a half-built database that looks like broken code.
 *
 * Safe to run repeatedly. It applies migrations rather than resetting, so an
 * existing database keeps its data; nothing here drops anything.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PRISMA = path.join(ROOT, 'node_modules', 'prisma', 'build', 'index.js');

let failed = false;

const say = (message) => console.log(message);
const step = (n, message) => console.log(`\n${n}. ${message}`);

function run(command, { quiet = false } = {}) {
  return execSync(command, {
    cwd: ROOT,
    stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
  });
}

// ---------------------------------------------------------------------------
say('\nSetting up the Indigent Register database\n');

// 1 --------------------------------------------------------------------------
step(1, 'Checking the configuration');

if (!fs.existsSync(path.join(ROOT, '.env'))) {
  const example = path.join(ROOT, '.env.example');
  if (fs.existsSync(example)) {
    fs.copyFileSync(example, path.join(ROOT, '.env'));
    say('   Created .env from .env.example.');
    say('   Open it and set DATABASE_URL and JWT_SECRET before going further.');
    say('\n   Special characters in a password must be percent-encoded: @ becomes %40.\n');
    process.exit(1);
  }
  say('   No .env and no .env.example to copy. Cannot continue.');
  process.exit(1);
}

require('dotenv').config({ path: path.join(ROOT, '.env') });

if (!process.env.DATABASE_URL) {
  say('   DATABASE_URL is not set in .env. Cannot continue.');
  process.exit(1);
}
say('   .env found, DATABASE_URL set.');

// 2 --------------------------------------------------------------------------
step(2, 'Reaching the database');
try {
  /**
   * A trivial query first.
   *
   * A stopped server or a wrong password is then reported here, in one sentence,
   * rather than surfacing three steps later as a migration failure whose stack
   * trace says nothing about the actual cause.
   */
  run(
    'node -e "const{PrismaClient}=require(\'@prisma/client\');'
    + 'new PrismaClient().$queryRaw`SELECT 1`'
    + '.then(()=>process.exit(0))'
    + '.catch(e=>{console.error(e.message.split(String.fromCharCode(10))[0]);process.exit(1)})"',
    { quiet: true }
  );
  say('   Connected.');
} catch (error) {
  say('   Could not reach the database.');
  say('\n   Check that PostgreSQL is running, and that DATABASE_URL in .env is right.');
  say('   On Windows the service is usually called postgresql-x64-NN.\n');
  process.exit(1);
}

// 3 --------------------------------------------------------------------------
step(3, 'Applying the schema');
try {
  run(`node "${PRISMA}" migrate deploy`);
} catch {
  say('\n   Migration failed. Nothing else will work until this does.');
  process.exit(1);
}

// 4 --------------------------------------------------------------------------
step(4, 'Generating the Prisma client');
try {
  run(`node "${PRISMA}" generate`, { quiet: true });
  say('   Done.');
} catch (error) {
  /**
   * On Windows this is almost always EPERM: a running backend holds the query
   * engine DLL open and it cannot be replaced.
   *
   * Whether that matters depends entirely on whether a usable client already
   * exists. Somebody re-running setup with their server up is fine and should
   * not be told the setup failed; somebody on a fresh clone has no client at
   * all and nothing will work until they get one. Those are different
   * situations and reporting them the same way trains people to ignore the
   * message.
   */
  let clientUsable = false;
  try {
    run('node -e "require(\'@prisma/client\').PrismaClient"', { quiet: true });
    clientUsable = true;
  } catch { /* no usable client */ }

  if (clientUsable) {
    say('   Skipped — a client is already generated and the engine is in use.');
    say('   If you have just changed schema.prisma, stop the backend and run:');
    say('     npx prisma generate');
  } else {
    say('   Could not generate the client, and there is no usable one.');
    say('   Stop anything using the database (the backend holds the query engine) and run:');
    say('     npx prisma generate');
    failed = true;
  }
}

// 5 --------------------------------------------------------------------------
step(5, 'Checking the audit trail is protected');
try {
  const out = run(`node "${path.join(__dirname, 'verify-audit-immutability.js')}"`, { quiet: true });
  const passed = /(\d+) passed, (\d+) failed/.exec(out);
  if (passed && passed[2] === '0') {
    say(`   ${passed[1]} checks passed — the audit trail refuses to be edited.`);
  } else {
    say(`   ${out.trim().split('\n').slice(-3).join('\n   ')}`);
    failed = true;
  }
} catch (error) {
  say('   The audit-immutability check did not pass. The triggers may be missing.');
  say('   Run: npm run verify:audit');
  failed = true;
}

// 6 --------------------------------------------------------------------------
step(6, 'Creating the development accounts');
try {
  run('node prisma/seed.js');
} catch {
  say('   Seeding failed. The schema is in place; you can retry with: npm run db:seed');
  failed = true;
}

// ---------------------------------------------------------------------------
if (failed) {
  say('\nSet up with warnings — see above.\n');
  process.exit(1);
}

say(`
Ready. Start the API with:

  npm run dev

Then walk the whole workflow with the accounts above, or check it end to end:

  npm run verify:workflow
`);
