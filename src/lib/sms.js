const prisma = require('./prisma');

/**
 * Outbound SMS.
 *
 * SMS is the only channel that reliably reaches this audience. Email assumes an
 * address and a device to check it on; the portal assumes the person knows to go
 * and look. A text message arrives on the R200 handset the household already has,
 * which is why the whole notification design leans on it.
 *
 * ## Providers
 *
 * Same shape as the geocoder: one interface, provider chosen by configuration.
 *
 *  - **console** (default) — writes the message to the server log and to the
 *    SmsMessage table. Nothing leaves the machine. This is what development uses,
 *    and the stored copy is readable in the admin portal's SMS outbox, so the
 *    whole flow can be exercised without a gateway account or spending a cent.
 *  - **http** — a generic JSON POST, configured with SMS_HTTP_URL and
 *    SMS_HTTP_TOKEN. Most South African gateways (Clickatell, BulkSMS, Infobip,
 *    SMSPortal) accept a request of this shape, so going live is configuration
 *    rather than a code change.
 *
 * A failure here must never break the action that caused it. Nobody should fail
 * to register because a gateway timed out; the row is written with status FAILED
 * and the error kept for whoever investigates.
 */

const PROVIDER = process.env.SMS_PROVIDER || 'console';
const SENDER = process.env.SMS_SENDER_ID || 'Indigent';
const TIMEOUT_MS = parseInt(process.env.SMS_TIMEOUT_MS || '10000', 10);

/** GSM-7 messages are 160 characters, then 153 per part once concatenated. */
function countSegments(body) {
  const len = body.length;
  if (len <= 160) return 1;
  return Math.ceil(len / 153);
}

/**
 * South African numbers, normalised to E.164.
 *
 * People write their number every way there is: 0821234567, 082 123 4567,
 * +27 82 123 4567, 27821234567. All of those are one number and must not become
 * four rows in the outbox — or worse, three silent failures.
 */
function normaliseNumber(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/[^\d+]/g, '');

  if (/^\+27\d{9}$/.test(digits)) return digits;
  if (/^27\d{9}$/.test(digits)) return `+${digits}`;
  if (/^0\d{9}$/.test(digits)) return `+27${digits.slice(1)}`;
  // A bare nine digits starting with a valid SA prefix — someone dropped the 0.
  if (/^[6-8]\d{8}$/.test(digits)) return `+27${digits}`;
  return null;
}

/**
 * Strip anything that must not be persisted.
 *
 * The outbox stores message bodies, so a temporary password written into one
 * would sit in the database in clear text — defeating the point of hashing it in
 * the users table. Callers pass `secrets` and those substrings are replaced
 * before the row is written. The provider still sends the real text.
 */
function redact(body, secrets = []) {
  return secrets.filter(Boolean).reduce(
    (text, secret) => text.split(secret).join('••••••••'),
    body
  );
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

async function sendViaConsole(to, body) {
  const rule = '─'.repeat(64);
  console.log(
    `\n${rule}\n  SMS to ${to}   (console provider — nothing was actually sent)\n${rule}\n`
    + `${body.split('\n').map((l) => `  ${l}`).join('\n')}\n${rule}\n`
  );
  return { providerRef: `console-${Date.now()}` };
}

async function sendViaHttp(to, body) {
  const url = process.env.SMS_HTTP_URL;
  if (!url) throw new Error('SMS_PROVIDER is "http" but SMS_HTTP_URL is not set');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.SMS_HTTP_TOKEN ? { Authorization: `Bearer ${process.env.SMS_HTTP_TOKEN}` } : {}),
      },
      body: JSON.stringify({ to, from: SENDER, body }),
      signal: controller.signal,
    });

    const text = await res.text();
    if (!res.ok) throw new Error(`gateway returned ${res.status}: ${text.slice(0, 200)}`);

    let ref = null;
    try { ref = JSON.parse(text)?.id ?? JSON.parse(text)?.messageId ?? null; } catch { /* not JSON */ }
    return { providerRef: ref };
  } finally {
    clearTimeout(timer);
  }
}

const PROVIDERS = { console: sendViaConsole, http: sendViaHttp };

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * Send one message and record it.
 *
 * Always resolves. Callers get `{ ok, reason }` and are free to ignore it — no
 * caller should be structured so that a failed SMS aborts its work.
 */
async function send(to, body, { purpose = 'GENERAL', userId, entityType, entityId, secrets = [] } = {}) {
  const toNumber = normaliseNumber(to);
  const text = String(body || '').trim();

  if (!toNumber) {
    console.warn(`[sms] ${purpose}: no usable cell number (${JSON.stringify(to)}) — not sent`);
    return { ok: false, reason: 'invalid-number' };
  }
  if (!text) {
    console.warn(`[sms] ${purpose}: empty message body — not sent`);
    return { ok: false, reason: 'empty-body' };
  }

  const stored = redact(text, secrets);
  const base = {
    toNumber,
    body: stored,
    purpose,
    provider: PROVIDER,
    segments: countSegments(text),
    userId: userId ?? null,
    entityType: entityType ?? null,
    entityId: entityId ?? null,
  };

  const sender = PROVIDERS[PROVIDER];
  if (!sender) {
    console.error(`[sms] unknown SMS_PROVIDER "${PROVIDER}" — falling back to console`);
  }

  try {
    const { providerRef } = await (sender || sendViaConsole)(toNumber, text);
    await record({ ...base, status: 'SENT', providerRef: providerRef ?? null, sentAt: new Date() });
    return { ok: true };
  } catch (error) {
    console.error(`[sms] ${purpose} to ${toNumber} failed:`, error.message);
    await record({ ...base, status: 'FAILED', error: error.message.slice(0, 500) });
    return { ok: false, reason: error.message };
  }
}

/** Persist the attempt. A logging failure must not surface as a send failure. */
async function record(data) {
  try {
    await prisma.smsMessage.create({ data });
  } catch (error) {
    console.error('[sms] could not write to the outbox:', error.message);
  }
}

module.exports = { send, normaliseNumber, countSegments, redact, PROVIDER };
