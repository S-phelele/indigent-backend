#!/usr/bin/env node
/**
 * Prove the VerifyNow integration against the REAL service, for one consenting
 * person, and measure what each check really costs.
 *
 *   # Free: VerifyNow's sandbox (mock data, no credits). Do this first.
 *   VERIFYNOW_API_KEY=vn_live_... node scripts/verifynow-smoke.js --id 8001015009087 \
 *       --first Thabo --surname Mokoena
 *
 *   # Real and BILLED: add --production. Use your OWN ID number, with your own consent.
 *   VERIFYNOW_API_KEY=vn_live_... node scripts/verifynow-smoke.js --production \
 *       --id <your ID> --first <your first name> --surname <your surname> \
 *       --bank FNB --account <your account number> --type SAVINGS --property
 *
 * It uses the same adapter the API uses, so it tests the real code path. Then it:
 *
 *  1. reads the credit balance (free) before and after EACH check, and prints the
 *     difference: that is the true price of that product on your account, which
 *     settles any disagreement between VerifyNow's own pages;
 *  2. prints the STRUCTURE of every response (field names and types, never values),
 *     so you can compare it with what the code expects and send me the shape if a
 *     field is named differently. No personal details are printed or logged;
 *  3. prints the outcome the register would record (PASS / FAIL / INCONCLUSIVE).
 *
 * Without --production it is forced into sandbox, whatever VERIFYNOW_MODE says.
 * With it, nothing is sent until you have read the cost line printed first.
 *
 * Options: --id, --first, --surname (the person's, as declared); --bank <name>
 * --account <number> [--type CURRENT|SAVINGS|TRANSMISSION|UNKNOWN] [--branch <code>]
 * for a bank check; --property for a deeds check; --skip-id to skip the ID check.
 */
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const flag = (name) => args.includes(`--${name}`);

const production = flag('production');
process.env.VERIFYNOW_MODE = production ? 'production' : 'sandbox';
process.env.VERIFY_PROVIDER = 'verifynow';
process.env.VERIFYNOW_DEBUG_SHAPE = '1';

const vp = require('../src/lib/verifyProvider');
const idCheck = require('../src/lib/idCheck');
const banks = require('../src/lib/banks');
const crypto = require('crypto');

const fail = (msg) => { console.error(`\n${msg}\n`); process.exit(2); };
if (!process.env.VERIFYNOW_API_KEY) fail('Set VERIFYNOW_API_KEY (from your VerifyNow dashboard, API Keys).');

const idNumber = opt('id');
if (!idNumber && !flag('skip-id') && !flag('property')) fail('Give --id <13-digit ID number>. Use your own, with your own consent.');
const declared = { fullName: opt('first') || '', surname: opt('surname') || '' };
const key = (what) => `smoke-${crypto.randomUUID()}-${what}`;

const provider = vp.named('verifynow');
const fmt = (n) => (n === null ? 'unknown' : String(n));

async function measure(label, expectedCredits, run) {
  const before = await vp.balance();
  let result; let error;
  try { result = await run(); } catch (e) { error = e; }
  const after = await vp.balance();
  const spent = before - after;
  console.log(`\n── ${label}`);
  console.log(`   balance ${before} → ${after}   charged: ${spent} credit(s)   (the code expects ${expectedCredits}${spent !== expectedCredits ? '  ← DIFFERENT: tell me, and set VERIFYNOW_CREDITS_* ' : ''})`);
  if (error) console.log(`   ${error.name}: ${error.message}`);
  return { result, error, spent };
}

(async () => {
  console.log(`Mode: ${production ? 'PRODUCTION: real checks, real credits' : 'SANDBOX: mock data, free'}`);
  console.log(`ID report: ${process.env.VERIFYNOW_ID_REPORT_TYPE || 'consumer_trace_lite'}`);
  const start = await vp.balance();
  console.log(`Credit balance now: ${start}`);

  const planned = [];
  if (!flag('skip-id') && idNumber) planned.push(['ID check', process.env.VERIFYNOW_ID_REPORT_TYPE === 'home_affairs_real_time_idv' ? 10 : process.env.VERIFYNOW_ID_REPORT_TYPE === 'said_verification' ? 1 : 3]);
  if (opt('bank') && opt('account')) planned.push(['bank check', 6]);
  if (flag('property')) planned.push(['deeds check', 10]);
  if (!planned.length) fail('Nothing to run. Give --id, and/or --bank with --account, and/or --property.');
  if (production) {
    const total = planned.reduce((n, [, c]) => n + c, 0);
    console.log(`\nAbout to spend up to ${total} credits (~R${(total * 2.99).toFixed(2)} at the starter rate): ${planned.map(([l, c]) => `${l} ${c}`).join(', ')}.`);
    console.log('Starting in 5 seconds. Press Ctrl+C now to stop.');
    await new Promise((r) => setTimeout(r, 5000));
  }

  if (!flag('skip-id') && idNumber) {
    const { result } = await measure('ID check', planned[0][1], () => provider.checkId({ idNumber, idempotencyKey: key('id') }));
    if (result) {
      const verdict = idCheck.evaluate(result, { fullName: declared.fullName, surname: declared.surname });
      console.log(`   outcome: ${verdict.outcome} — ${verdict.findings}`);
      console.log(`   deceased flag: ${result.deceased === null ? 'NOT RETURNED' : result.deceased}`);
    }
  }

  if (opt('bank') && opt('account')) {
    const bank = banks.find(opt('bank'));
    const code = opt('branch') || bank?.bankCode;
    if (!code) fail(`"${opt('bank')}" is not a bank VerifyNow supports. Pass --branch <6-digit code> to try anyway.`);
    const { result } = await measure('bank check', 6, () => provider.checkBank({
      idNumber, fullName: declared.fullName, surname: declared.surname, accountNumber: opt('account').replace(/\D/g, ''),
      bankName: bank?.bankName || opt('bank'), bankBranchCode: code, accountType: (opt('type') || 'UNKNOWN').toUpperCase(), idempotencyKey: key('bank'),
    }));
    if (result) { const v = idCheck.evaluateBank(result, { accountNumber: opt('account') }); console.log(`   outcome: ${v.outcome} — ${v.findings}`); }
  }

  if (flag('property')) {
    const { result } = await measure('deeds check', 10, () => provider.checkProperty({ idNumber, idempotencyKey: key('property') }));
    if (result) { const v = idCheck.evaluateProperty(result, { tenure: null, ownsOtherProperty: null }); console.log(`   properties on the register: ${result.properties.length}`); console.log(`   outcome (with nothing declared): ${v.outcome}`); }
  }

  const end = await vp.balance();
  console.log(`\nDone. Credits spent in total: ${start - end}. Balance: ${end}.`);
  console.log('Lines starting "[verifynow shape]" above show the field names VerifyNow really returned (no values).');
})().catch((e) => fail(`${e.name}: ${e.message}`));
