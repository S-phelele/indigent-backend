/**
 * The words that actually reach residents.
 *
 * Kept in one file for three reasons: an SMS costs money per 160 characters, so
 * length is a real constraint that deserves review in one place; the wording is
 * the municipality's voice and shouldn't be scattered through route handlers;
 * and this is the natural seam for isiZulu, Sesotho and Afrikaans versions when
 * they are added.
 *
 * House style: no jargon, no links longer than the message, and always the
 * reference number, because that is what someone quotes at the counter.
 */

const PORTAL_URL = process.env.PORTAL_URL || 'http://localhost:5173';
const HELP_LINE = process.env.MUNICIPAL_HELP_LINE || null;

/** Appended only when configured — a dangling "call " helps nobody. */
const helpSuffix = () => (HELP_LINE ? ` Queries: ${HELP_LINE}` : '');

const templates = {
  /**
   * Sent when staff create an account on someone's behalf. This is the only
   * message carrying a credential, and it is the one that decides whether the
   * resident can ever check on their own application.
   */
  WELCOME_CREDENTIALS: ({ firstName, username, tempPassword }) =>
    `${firstName ? `Hi ${firstName}. ` : ''}An Indigent Register account was created for you.\n`
    + `Sign in at ${PORTAL_URL}\n`
    + `Username: ${username}\n`
    + `Temporary password: ${tempPassword}\n`
    + `Please change it when you sign in.${helpSuffix()}`,

  /** Self-registration. No credential — they chose their own password. */
  WELCOME: ({ firstName }) =>
    `${firstName ? `Welcome ${firstName}. ` : 'Welcome. '}`
    + `Your Indigent Register account is active. Sign in at ${PORTAL_URL} to complete your application.${helpSuffix()}`,

  APPLICATION_SUBMITTED: ({ reference, days }) =>
    `Your indigent application has been received.\n`
    + `Reference: ${reference}\n`
    + `We aim to review it within ${days} working days. You will be notified of the outcome.${helpSuffix()}`,

  /** Captured door to door — the resident may not have seen a screen at all. */
  CAPTURED_BY_COUNCILLOR: ({ reference, councillor, ward }) =>
    `Your indigent application was captured by ${councillor}${ward ? ` (${ward})` : ''} and submitted.\n`
    + `Reference: ${reference}\n`
    + `Keep this number. You can track it at ${PORTAL_URL}${helpSuffix()}`,

  APPLICATION_APPROVED: ({ reference }) =>
    `Good news. Your indigent application ${reference} has been APPROVED.\n`
    + `Your municipal account will be updated with the approved relief.${helpSuffix()}`,

  APPLICATION_DECLINED: ({ reference, reason }) =>
    `Your indigent application ${reference} was not approved.\n`
    + `${reason ? `Reason: ${reason}\n` : ''}`
    + `You may apply again if your circumstances change.${helpSuffix()}`,

  DOCUMENT_REJECTED: ({ reference, documentName }) =>
    `Action needed on application ${reference}.\n`
    + `Your ${documentName} could not be accepted. Please sign in at ${PORTAL_URL} to upload it again.${helpSuffix()}`,

  APPLICATION_REOPENED: ({ reference }) =>
    `Your indigent application ${reference} has been reopened for further review.${helpSuffix()}`,

  SITE_VISIT_SCHEDULED: ({ reference, when }) =>
    `A municipal officer will visit your property to verify application ${reference}`
    + `${when ? ` on ${when}` : ' shortly'}. Please make sure someone is home.${helpSuffix()}`,

  /**
   * Sent after a failed visit, while attempts remain.
   *
   * The count is deliberate: somebody who does not know they are two failures
   * from disqualification cannot do anything about it.
   */
  SITE_VISIT_FAILED: ({ reference, remaining }) =>
    remaining > 0
      ? `We visited your property for application ${reference} but could not confirm your household. `
        + `${remaining} more attempt${remaining === 1 ? '' : 's'} will be made. Please contact us to arrange a time.${helpSuffix()}`
      : `We have attempted to visit your property for ${reference} three times without success. `
        + `Please contact your municipal office urgently.${helpSuffix()}`,

  INFORMATION_REQUESTED: ({ reference }) =>
    `More information is needed for your indigent application ${reference}. `
    + `Please sign in at ${PORTAL_URL} to see what is required.${helpSuffix()}`,

  /** Cell verification and password reset. */
  OTP: ({ code, minutes }) =>
    `${code} is your Indigent Register verification code. It expires in ${minutes} minutes. Do not share it with anyone.`,

  PASSWORD_RESET: ({ code, minutes }) =>
    `${code} is your Indigent Register password reset code. It expires in ${minutes} minutes. `
    + `If you did not request this, ignore this message.`,
};

/**
 * Build a message. Throws on an unknown key rather than sending an empty SMS —
 * a typo here is a resident who never hears from the municipality.
 */
function build(key, values = {}) {
  const template = templates[key];
  if (!template) throw new Error(`[smsTemplates] unknown template "${key}"`);
  return template(values);
}

module.exports = { build, templates, PORTAL_URL };
