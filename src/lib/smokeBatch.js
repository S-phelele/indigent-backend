/**
 * The logic behind `scripts/verifynow-smoke.js --file people.csv`: read a short
 * list of consenting people, work out what a run would cost *before* any credit
 * is spent, and report results without writing anybody's details down.
 *
 * Pure functions, no network and no database, so they can be tested exhaustively.
 *
 * ## Why this is careful
 *
 * Every row is a real person's identity and possibly a bank account, and every
 * check spends money. So:
 *
 *  - a row that cannot be checked correctly (bad ID number, an account number that
 *    cannot be valid, an unsupported bank) is refused up front rather than sent and
 *    billed;
 *  - the same ID number twice is refused: it would be charged twice for one answer;
 *  - the list is capped (10 unless raised on purpose);
 *  - output shows ID numbers masked and never prints a name, an address or an
 *    account number. The register's own spelling of someone's name, and the street
 *    of a property they own, are exactly what must not end up in a terminal log.
 */
const saId = require('./saIdNumber');
const banks = require('./banks');

const TYPES = ['CURRENT', 'SAVINGS', 'TRANSMISSION', 'UNKNOWN'];
const KNOWN_COLUMNS = ['id', 'first', 'surname', 'bank', 'branch', 'account', 'type', 'property'];
const CREDITS = { bank: 6, property: 10 };

/** Minimal CSV: commas, optional double-quoted fields, "" for a quote inside one. */
function splitLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quoted) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i += 1; } else quoted = false; } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const truthy = (v) => ['yes', 'y', 'true', '1'].includes(String(v ?? '').trim().toLowerCase());
const digits = (v) => String(v ?? '').replace(/\D/g, '');

/**
 * Read the list. Returns { rows, problems, total }.
 *
 *   id,first,surname,bank,account,type,property
 *   8503124800081,Grace,Mthembu,FNB,62000009999,SAVINGS,yes
 *
 * `id`, `first` and `surname` are the person's; `bank` + `account` (and optionally
 * `type` and `branch`) ask for a bank check; `property` of yes asks for a deeds
 * check. Lines starting with # and blank lines are ignored.
 *
 * `idCredits` is what the chosen ID product costs.
 */
function parse(text, { idCredits = 3, maxRows = 10 } = {}) {
  const lines = String(text ?? '').replace(/^﻿/, '').split(/\r?\n/);
  const problems = [];
  const rows = [];

  let header = null;
  const seen = new Map();

  lines.forEach((raw, index) => {
    const lineNo = index + 1;
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;

    if (!header) {
      header = splitLine(line).map((h) => h.toLowerCase());
      if (!header.includes('id')) problems.push({ line: lineNo, message: 'The first line must name the columns and include "id".' });
      for (const h of header) if (!KNOWN_COLUMNS.includes(h)) problems.push({ line: lineNo, message: `Unknown column "${h}" (ignored). Known: ${KNOWN_COLUMNS.join(', ')}.`, warning: true });
      return;
    }

    const cells = splitLine(line);
    const get = (name) => cells[header.indexOf(name)] ?? '';
    const id = digits(get('id'));
    const fail = (message) => problems.push({ line: lineNo, message, id });

    const check = saId.validate(id);
    if (!check.valid) return fail(`ID number refused: ${check.reason}.`);
    if (seen.has(id)) return fail(`This ID number is already on line ${seen.get(id)}. Checking it twice would be charged twice.`);

    const surname = get('surname');
    if (!surname) return fail('A surname is needed (the bank check requires it, and the name match uses it).');

    const checks = [{ kind: 'id', credits: idCredits }];
    const row = { line: lineNo, id, first: get('first'), surname, checks };

    const bank = get('bank');
    const account = digits(get('account'));
    if (bank || account) {
      if (!bank || !account) return fail('A bank check needs both "bank" and "account".');
      if (!/^\d{7,13}$/.test(account)) return fail('The account number must be 7 to 13 digits.');
      const known = banks.find(bank);
      const branch = digits(get('branch'));
      if (!known && !banks.isBranchCode(branch)) return fail(`"${bank}" is not a bank VerifyNow supports. Add a six-digit "branch" code to try it anyway.`);
      const type = (get('type') || 'UNKNOWN').toUpperCase();
      if (!TYPES.includes(type)) return fail(`Account type must be one of ${TYPES.join(', ')}.`);
      Object.assign(row, { bankName: known ? known.bankName : bank, branch: branch || known.bankCode, account, type });
      checks.push({ kind: 'bank', credits: CREDITS.bank });
    }
    if (truthy(get('property'))) checks.push({ kind: 'property', credits: CREDITS.property });

    seen.set(id, lineNo);
    rows.push(row);
  });

  if (!header) problems.push({ line: 0, message: 'The file is empty.' });
  if (rows.length > maxRows) {
    problems.push({ line: 0, message: `${rows.length} people is more than the limit of ${maxRows}. Raise it on purpose with --max ${rows.length}.`, tooMany: true });
  }
  return { rows, problems, total: summarise(rows) };
}

/** What the run would cost, per kind of check and in all. */
function summarise(rows) {
  const counts = { id: 0, bank: 0, property: 0 };
  let credits = 0;
  for (const r of rows) for (const c of r.checks) { counts[c.kind] += 1; credits += c.credits; }
  return { people: rows.length, counts, credits };
}

/** ID numbers are never printed whole: nine dots and the last four digits. */
const mask = (id) => `•••••••••${digits(id).slice(-4)}`;

/**
 * A few words on why a check came out as it did, built from the result's flags so
 * that no name, address or account number is ever part of it.
 */
function noteFor(kind, result, verdict) {
  if (!result) return '';
  if (kind === 'id') {
    if (result.found === false) return 'no record';
    if (result.idMismatch) return 'ID number not confirmed';
    if (result.deceased === true) return 'recorded as deceased';
    if (verdict?.outcome === 'INCONCLUSIVE') return 'name differs';
    if (result.deceased === null) return 'deceased flag not returned';
    return '';
  }
  if (kind === 'bank') {
    if (result.accountFound === false) return 'no such account';
    if (result.accountOpen === false) return 'account closed';
    if (result.idMatch === false) return 'held by someone else';
    if (result.idMatch === null) return 'holder not confirmed';
    return '';
  }
  if (kind === 'property') {
    const n = (result.properties || []).length;
    return `${n} ${n === 1 ? 'property' : 'properties'} registered`;
  }
  return '';
}

const csvCell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

/** The report written to disk: row number, masked ID, check, outcome, credits, a short note. Nothing else. */
function reportCsv(entries) {
  const head = ['row', 'id', 'check', 'outcome', 'credits_charged', 'note'];
  const lines = entries.map((e) => [e.row, mask(e.id), e.kind, e.outcome, e.credits ?? '', e.note ?? ''].map(csvCell).join(','));
  return [head.join(','), ...lines].join('\n') + '\n';
}

module.exports = { parse, summarise, mask, noteFor, reportCsv, splitLine, TYPES, CREDITS };
