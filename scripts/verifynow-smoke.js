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
 *
 * ## A list of people (the quick real-data run)
 *
 *   node scripts/verifynow-smoke.js --file my-test.local.csv                     # sandbox, free
 *   node scripts/verifynow-smoke.js --file my-test.local.csv --production \
 *        --confirm-spend 106 [--out verifynow-report.csv]                         # REAL, billed
 *
 * The file is a short list of CONSENTING people (see verifynow-people.example.csv for
 * the columns). Nothing is sent until it has been read and costed, and a production run
 * refuses to start unless --confirm-spend is exactly the credit total it printed, so
 * the spend is a number you have read and typed. A list of more than 10 needs --max.
 * ID numbers are shown masked; no name, address or account number is ever printed or
 * written, and --out writes only masked IDs, outcomes and credits.
 * Use a name ending ".local.csv": git ignores those, so real details are never committed.
 * Re-running the same file replays within VerifyNow's retry window without a second
 * charge; --new-run forces fresh requests.
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
if (!opt('file') && !idNumber && !flag('skip-id') && !flag('property')) fail('Give --id <13-digit ID number>. Use your own, with your own consent.');
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


// ---------------------------------------------------------------------------
// A list of people
// ---------------------------------------------------------------------------

async function runBatch() {
  const fs = require('fs');
  const sb = require('../src/lib/smokeBatch');

  const reportType = process.env.VERIFYNOW_ID_REPORT_TYPE || 'consumer_trace_lite';
  const idCredits = { consumer_trace_lite: 3, said_verification: 1, home_affairs_real_time_idv: 10 }[reportType];
  if (!idCredits) fail(`VERIFYNOW_ID_REPORT_TYPE "${reportType}" is not one of consumer_trace_lite, said_verification, home_affairs_real_time_idv.`);

  let text;
  try { text = fs.readFileSync(opt('file'), 'utf8'); } catch (e) { fail(`Cannot read ${opt('file')}: ${e.code || e.message}`); }

  const maxRows = parseInt(opt('max') || '10', 10);
  const { rows, problems, total } = sb.parse(text, { idCredits, maxRows });

  const errors = problems.filter((p) => !p.warning);
  for (const p of problems) console.log(`${p.warning ? 'note ' : 'FIX  '} line ${p.line || '-'}${p.id ? ` (${sb.mask(p.id)})` : ''}: ${p.message}`);
  if (errors.length) fail('Nothing was sent. Fix the lines above and run again.');
  if (!rows.length) fail('No people in the file.');

  const rate = 2.99;
  console.log(`\nMode: ${production ? 'PRODUCTION: real checks, real credits' : 'SANDBOX: mock data, free'}      ID report: ${reportType}`);
  console.log(`\n${total.people} people:`);
  rows.forEach((r, i) => console.log(`  #${i + 1}  ${sb.mask(r.id)}   ${r.checks.map((c) => `${c.kind} ${c.credits}`).join(' + ')}  = ${r.checks.reduce((n, c) => n + c.credits, 0)} credits`));
  console.log(`\nWould spend ${total.credits} credits (~R${(total.credits * rate).toFixed(2)} at the starter rate, VAT included): `
    + `${total.counts.id} ID, ${total.counts.bank} bank, ${total.counts.property} deeds.`);

  if (production) {
    const confirmed = parseInt(opt('confirm-spend') || '', 10);
    if (confirmed !== total.credits) {
      console.log(`\nThis is a REAL run. To start it, add:   --confirm-spend ${total.credits}`);
      console.log('That number is the most it can spend; typing it is how you say you have read the cost above.');
      process.exit(3);
    }
    console.log('\nStarting in 10 seconds. Press Ctrl+C now to stop.');
    await new Promise((r) => setTimeout(r, 10000));
  }

  const salt = flag('new-run') ? String(Date.now()) : '';
  // The mode is part of the key: a sandbox run and a production run of the same list are different
  // requests, and VerifyNow answers 409 when one key is reused for a different request.
  const keyFor = (row, kind) => `smoke-${crypto.createHash('sha256').update(`${production ? 'production' : 'sandbox'}|${row.id}|${kind}|${(row.account || '').slice(-4)}|${salt}`).digest('hex').slice(0, 40)}`;
  const clean = (msg) => String(msg).replace(/\d{7,}/g, '•••');   // never let a number from an error reach the screen

  const start = await vp.balance();
  console.log(`\nCredit balance before: ${start}\n`);

  const entries = [];
  const shapeShown = {};
  let aborted = null;

  for (let i = 0; i < rows.length && !aborted; i += 1) {
    const row = rows[i];
    const before = await vp.balance();
    const parts = [];

    for (const c of row.checks) {
      // Print the structure of the first real response of each kind, and only that.
      if (!shapeShown[c.kind]) process.env.VERIFYNOW_DEBUG_SHAPE = '1';
      let outcome; let note = ''; let credits;
      try {
        let result; let verdict;
        if (c.kind === 'id') {
          result = await provider.checkId({ idNumber: row.id, idempotencyKey: keyFor(row, 'id') });
          verdict = idCheck.evaluate(result, { fullName: row.first, surname: row.surname });
        } else if (c.kind === 'bank') {
          result = await provider.checkBank({ idNumber: row.id, fullName: row.first, surname: row.surname, accountNumber: row.account, bankName: row.bankName, bankBranchCode: row.branch, accountType: row.type, idempotencyKey: keyFor(row, 'bank') });
          verdict = idCheck.evaluateBank(result, { accountNumber: row.account });
        } else {
          result = await provider.checkProperty({ idNumber: row.id, idempotencyKey: keyFor(row, 'property') });
          // Nothing is declared in a test list, so a pass/fail here would mean nothing. Report what was found.
          verdict = { outcome: result.properties.length ? 'FOUND' : 'NONE' };
        }
        outcome = verdict.outcome;
        note = sb.noteFor(c.kind, result, verdict);
        credits = result.credits;
      } catch (e) {
        if (!(e instanceof vp.ProviderError)) throw e;
        outcome = 'ERROR';
        note = e.rejected ? `input rejected: ${clean(e.message)}` : e.retryable ? `temporary fault: ${clean(e.message)}` : clean(e.message);
        // A key problem, an empty balance or a settings error will fail every row the same way: stop,
        // do not keep going. A problem with one person (no answer for their ID, a bad account) does not.
        if (e.fatal) aborted = `Stopped at row ${i + 1}: ${clean(e.message)}`;
      } finally {
        delete process.env.VERIFYNOW_DEBUG_SHAPE;
        shapeShown[c.kind] = true;
      }
      entries.push({ row: i + 1, id: row.id, kind: c.kind, outcome, credits, note });
      parts.push(`${c.kind} ${outcome}${note ? ` (${note})` : ''}`);
      if (aborted) break;
    }

    const after = await vp.balance();
    console.log(`#${i + 1}  ${sb.mask(row.id)}   ${parts.join('  ·  ')}   — charged ${before - after}`);
    if (!production && i < rows.length - 1) await new Promise((r) => setTimeout(r, 300));
  }

  const end = await vp.balance();
  const tally = {};
  for (const e of entries) { tally[e.kind] = tally[e.kind] || {}; tally[e.kind][e.outcome] = (tally[e.kind][e.outcome] || 0) + 1; }

  console.log('\n──────────── summary ────────────');
  for (const [kind, counts] of Object.entries(tally)) console.log(`${kind.padEnd(9)} ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}`);
  console.log(`credits: planned up to ${total.credits}, actually spent ${start - end}  (balance ${start} → ${end})`);

  const look = entries.filter((e) => !['PASS', 'NONE'].includes(e.outcome));
  if (look.length) {
    console.log('\nWorth a person\'s eye (the code is not necessarily wrong: these are the places the register and the list disagree):');
    for (const e of look) console.log(`  #${e.row} ${sb.mask(e.id)}  ${e.kind}: ${e.outcome}${e.note ? ` — ${e.note}` : ''}`);
  }
  if (aborted) console.log(`\n${aborted}`);

  if (opt('out')) {
    fs.writeFileSync(opt('out'), sb.reportCsv(entries), { mode: 0o600 });
    console.log(`\nReport written to ${opt('out')} (masked IDs, outcomes and credits only). Do not commit it.`);
  }
  console.log('\nLines starting "[verifynow shape]" show the field names VerifyNow really returned (no values).');
  if (aborted) process.exit(1);
}

(async () => {
  if (opt('file')) return runBatch();
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
