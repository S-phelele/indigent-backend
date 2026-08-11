#!/usr/bin/env node
/**
 * Prove the audit trail cannot be tampered with.
 *
 * Run against a real database:
 *
 *     node scripts/verify-audit-immutability.js
 *
 * This is not in `tests/` on purpose. Everything under `tests/` runs without a
 * database so `npm test` works anywhere; this needs a live PostgreSQL with the
 * migrations applied, because the thing being tested *is* the database. A unit
 * test with a mocked client would prove nothing at all here — the protection is
 * a trigger, and only PostgreSQL can be asked whether it holds.
 *
 * ## What it checks
 *
 * The append-only tables must refuse UPDATE, DELETE and TRUNCATE, and must keep
 * refusing UPDATE and TRUNCATE even when the retention sweep's flag is set. The
 * one permitted exception is DELETE inside a sweep, which exists because POPIA
 * s14 obliges the municipality to remove expired records and an application
 * cascades into these tables.
 *
 * ## What it does to your data
 *
 * Nothing. Every mutation it attempts is expected to fail. It inserts two probe
 * rows to test row-level triggers against real rows, then removes them through
 * the same audited path the retention sweep uses. It never touches a row it did
 * not create, and it prints the before and after counts so you can see that.
 *
 * Exits non-zero if any protection is missing, so it can gate a deployment.
 */

const prisma = require('../src/lib/prisma');

const PROBE = 'audit-immutability-probe';

let passes = 0;
let failures = 0;

function check(name, passed, detail = '') {
  if (passed) {
    passes += 1;
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Run something that must be refused by the append-only trigger. */
async function mustRefuse(name, run) {
  try {
    await run();
    check(name, false, 'the mutation was ALLOWED');
  } catch (error) {
    check(name, /append-only/.test(error.message), /append-only/.test(error.message)
      ? 'refused'
      : `refused, but for the wrong reason: ${error.message.slice(0, 120)}`);
  }
}

/** Run something inside a transaction with the retention exception open. */
const withSweepFlag = (fn) => prisma.$transaction(async (tx) => {
  await tx.$executeRaw`SELECT set_config('indigent.retention_sweep', 'on', true)`;
  return fn(tx);
});

async function main() {
  console.log('\nVerifying the audit trail is append-only\n');

  const before = {
    audit: await prisma.auditLog.count(),
    changes: await prisma.fieldChange.count(),
    steps: await prisma.approvalStep.count(),
  };
  console.log(`  starting counts: ${before.audit} audit rows, ${before.changes} field changes, ${before.steps} approval steps\n`);

  // -------------------------------------------------------------------------
  console.log('The audit log:');

  /**
   * A probe row first, so there is something for the trigger to fire on.
   *
   * `UPDATE` and `DELETE` triggers are row-level: against an empty table they
   * never fire, the statement affects nothing and succeeds — which this script
   * would read as the guard being absent. On a freshly built database, where the
   * audit log is genuinely empty, that reported the audit trail as unprotected
   * when it was fine. A false alarm on a new developer's first run is worse than
   * no check at all, because the next real failure gets ignored too.
   *
   * TRUNCATE is statement-level and fires either way, which is why it was the
   * only one of the three that passed.
   */
  // Unique per run. A previous run that failed before its cleanup would
  // otherwise leave a row this one collides with — and the collision is
  // unfixable by ordinary means, because the row cannot be deleted.
  const auditProbeId = `${PROBE}-audit-${Date.now()}`;
  await prisma.auditLog.create({
    data: {
      id: auditProbeId,
      action: 'AUDIT_IMMUTABILITY_PROBE',
      details: 'Written and removed by scripts/verify-audit-immutability.js',
    },
  });

  await mustRefuse('UPDATE is refused', () => prisma.$executeRaw`UPDATE "AuditLog" SET action = 'tampered' WHERE true`);
  await mustRefuse('DELETE is refused', () => prisma.$executeRaw`DELETE FROM "AuditLog" WHERE true`);
  await mustRefuse('TRUNCATE is refused', () => prisma.$executeRawUnsafe('TRUNCATE "AuditLog"'));

  // -------------------------------------------------------------------------
  // Row-level triggers only fire when there is a row. Testing against an empty
  // table reports success while proving nothing, which is how a broken guard
  // survives a green check.
  console.log('\nField changes and approval steps, against real rows:');

  const application = await prisma.application.findFirst({ select: { id: true } });
  if (!application) {
    console.log('  SKIP  no application exists to attach a probe row to');
  } else {
    const change = await prisma.fieldChange.create({
      data: { applicationId: application.id, field: PROBE, oldValue: 'a', newValue: 'b' },
    });
    const step = await prisma.approvalStep.create({
      data: { applicationId: application.id, stage: 'VERIFICATION', outcome: 'PENDING', sequence: 9999, startedAt: new Date() },
    });

    await mustRefuse('a field change cannot be rewritten',
      () => prisma.fieldChange.update({ where: { id: change.id }, data: { newValue: 'tampered' } }));
    await mustRefuse('a field change cannot be removed',
      () => prisma.fieldChange.delete({ where: { id: change.id } }));
    await mustRefuse('an approval step cannot be removed',
      () => prisma.approvalStep.delete({ where: { id: step.id } }));

    // The one mutation that must be ALLOWED: a step is opened when an official
    // picks the case up and completed when they decide. Forbidding UPDATE here
    // would break the approval chain itself.
    try {
      await prisma.approvalStep.update({ where: { id: step.id }, data: { notes: 'completed' } });
      check('an approval step can still be completed', true, 'UPDATE allowed, as the chain requires');
    } catch (error) {
      check('an approval step can still be completed', false, error.message.slice(0, 120));
    }

    // ---------------------------------------------------------------------
    console.log('\nThe retention exception:');

    await mustRefuse('UPDATE stays refused even with the sweep flag set',
      () => withSweepFlag((tx) => tx.$executeRaw`UPDATE "AuditLog" SET action = 'tampered' WHERE true`));
    await mustRefuse('TRUNCATE stays refused even with the sweep flag set',
      () => withSweepFlag((tx) => tx.$executeRawUnsafe('TRUNCATE "AuditLog"')));

    try {
      const removed = await withSweepFlag(async (tx) => {
        const a = await tx.fieldChange.deleteMany({ where: { field: PROBE } });
        const b = await tx.approvalStep.deleteMany({ where: { sequence: 9999 } });
        return a.count + b.count;
      });
      check('a retention sweep can remove expired records', removed === 2, `${removed} probe row(s) removed`);
    } catch (error) {
      check('a retention sweep can remove expired records', false, error.message.slice(0, 160));
    }

    // The flag is set with is_local = true, so PostgreSQL clears it at the end of
    // the transaction. If that ever stopped being true, the exception would be
    // permanently open on a pooled connection.
    const [{ f }] = await prisma.$queryRaw`SELECT current_setting('indigent.retention_sweep', true) AS f`;
    check('the exception closes when the transaction ends', f !== 'on', `flag is now ${JSON.stringify(f)}`);

    await mustRefuse('DELETE is refused again outside a sweep',
      () => prisma.$executeRaw`DELETE FROM "AuditLog" WHERE true`);
  }

  /**
   * Take the audit probe back out, through the only path that can.
   *
   * The whole point of the triggers is that an audit row cannot be removed by
   * ordinary means, so this goes through the same audited sweep the retention
   * policy uses. Leaving it behind would mean a verification script quietly
   * adding a row to the compliance record every time anybody ran it.
   */
  try {
    const removed = await withSweepFlag((tx) =>
      tx.auditLog.deleteMany({ where: { id: auditProbeId } }));
    check('the audit probe is cleaned up afterwards', removed.count === 1, 'removed through a sweep');
  } catch (error) {
    check('the audit probe is cleaned up afterwards', false, error.message.slice(0, 120));
  }

  // -------------------------------------------------------------------------
  console.log('\nNo trigger left disabled:');
  const disabled = await prisma.$queryRaw`
    SELECT c.relname AS table_name, t.tgname
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE NOT t.tgisinternal AND t.tgenabled <> 'O'`;
  check('every append-only trigger is enabled', disabled.length === 0,
    disabled.length ? `disabled: ${disabled.map((d) => d.tgname).join(', ')}` : 'all enabled');

  // -------------------------------------------------------------------------
  const after = {
    audit: await prisma.auditLog.count(),
    changes: await prisma.fieldChange.count(),
    steps: await prisma.approvalStep.count(),
  };
  console.log('');
  check('no audit rows were lost', after.audit >= before.audit, `${before.audit} -> ${after.audit}`);
  check('no probe rows were left behind',
    after.changes === before.changes && after.steps === before.steps,
    `field changes ${before.changes} -> ${after.changes}, steps ${before.steps} -> ${after.steps}`);

  console.log(`\n${passes} passed, ${failures} failed\n`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error('\nThe check could not complete:', error.message);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
