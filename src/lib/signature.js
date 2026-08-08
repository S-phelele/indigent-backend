/**
 * Drawn electronic signatures.
 *
 * The supervisor signs the file off by drawing on a canvas — finger, stylus or
 * mouse. The browser hands us a PNG data URI; this module decides whether to
 * accept it and what to keep alongside it.
 *
 * ## Why this is legally sufficient
 *
 * Under the Electronic Communications and Transactions Act 25 of 2002, an
 * *ordinary* electronic signature is "data attached to, incorporated in, or
 * logically associated with other data and which is intended by the user to
 * serve as a signature". A drawn mark, captured against a named user in an
 * authenticated session and stored with the record it signs, meets that.
 *
 * ECTA reserves *advanced* electronic signatures — accredited, certificate
 * based — for the short list of instruments in section 13(1), which does not
 * include a municipal indigent approval. So this is the appropriate level, and
 * building a certificate infrastructure for it would be an expensive answer to
 * a question nobody asked.
 *
 * What gives the signature its weight is not the image. It is the surrounding
 * evidence: which authenticated account drew it, at what moment, from which
 * address, against which version of which file. All of that is stored with it,
 * and none of it can be edited afterwards.
 */

/** Signatures are small line drawings. Anything larger is not one. */
const MAX_BYTES = Number(process.env.SIGNATURE_MAX_BYTES || 500 * 1024);

/** A trivially short data URI is an empty canvas, not a signature. */
const MIN_BYTES = 512;

const ACCEPTED = ['image/png', 'image/jpeg', 'image/svg+xml'];

const DATA_URI = /^data:(image\/(?:png|jpeg|svg\+xml));base64,([A-Za-z0-9+/]+={0,2})$/;

/**
 * Check a signature payload.
 *
 * Returns `{ valid, reason }` rather than throwing, so a route can put the
 * reason in front of the person who just tried to sign.
 */
function validate(dataUri) {
  if (!dataUri || typeof dataUri !== 'string') {
    return { valid: false, reason: 'Please sign in the box before confirming.' };
  }

  const match = DATA_URI.exec(dataUri.trim());
  if (!match) {
    return { valid: false, reason: 'That signature could not be read. Please clear it and sign again.' };
  }

  const [, mime, base64] = match;
  if (!ACCEPTED.includes(mime)) {
    return { valid: false, reason: 'That signature format is not supported.' };
  }

  // Length of the decoded payload, without allocating a buffer for it.
  const padding = (base64.match(/=+$/) || [''])[0].length;
  const bytes = Math.floor((base64.length * 3) / 4) - padding;

  if (bytes < MIN_BYTES) {
    return { valid: false, reason: 'The signature box looks empty. Please sign before confirming.' };
  }
  if (bytes > MAX_BYTES) {
    return { valid: false, reason: 'That signature is too large. Please clear it and sign again.' };
  }

  return { valid: true, mime, bytes };
}

/**
 * What is stored with the mark.
 *
 * The IP and the moment matter more than the picture: they are what makes the
 * signature evidence rather than decoration. `signatureName` is the signatory's
 * name as it stood when they signed, kept separately so that renaming an account
 * later cannot rewrite who signed a decision.
 */
function context(req, user) {
  const forwarded = req?.headers?.['x-forwarded-for'];
  const ip = typeof forwarded === 'string' && forwarded.length
    ? forwarded.split(',')[0].trim()
    : req?.ip || req?.socket?.remoteAddress || null;

  return {
    signatureName: [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email,
    signedAt: new Date(),
    signatureIp: ip,
  };
}

/**
 * A short, human description of a signature for display.
 *
 * Shown beneath the image so a reader sees the provenance without opening the
 * audit trail — which is the point of making the chain transparent.
 */
function describe(step) {
  if (!step?.signature) return null;
  const when = step.signedAt ? new Date(step.signedAt) : null;
  return {
    name: step.signatureName || step.actorName || 'Municipal official',
    role: step.actorRole || null,
    signedAt: when,
    signedAtLabel: when
      ? when.toLocaleString('en-ZA', { dateStyle: 'long', timeStyle: 'short' })
      : null,
    ip: step.signatureIp || null,
    statement: 'Signed electronically under the Electronic Communications and Transactions Act 25 of 2002.',
  };
}

module.exports = { validate, context, describe, MAX_BYTES, ACCEPTED };
