const prisma = require('./prisma');

/**
 * Action vocabulary. These strings are also the filter options in the admin
 * portal's Audit Logs page — keep the two in sync.
 */
const ACTIONS = {
  LOGIN: 'LOGIN',
  REGISTER: 'REGISTER',
  PASSWORD_RESET: 'PASSWORD_RESET',
  VERIFY_CELL: 'VERIFY_CELL',
  PASSWORD_CHANGE: 'PASSWORD_CHANGE',

  /// Sign-in security. Separate actions so a burst of failures against one
  /// account is visible in the audit log as a pattern rather than buried.
  LOGIN_FAILED: 'LOGIN_FAILED',
  LOGIN_BLOCKED: 'LOGIN_BLOCKED',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  ACCOUNT_UNLOCKED: 'ACCOUNT_UNLOCKED',
  SESSIONS_REVOKED: 'SESSIONS_REVOKED',
  VIEW_APPLICATION: 'VIEW_APPLICATION',
  APPROVE_APPLICATION: 'APPROVE_APPLICATION',
  DECLINE_APPLICATION: 'DECLINE_APPLICATION',
  EXPORT_APPLICANTS: 'EXPORT_APPLICANTS',
  EXPORT_APPLICATIONS: 'EXPORT_APPLICATIONS',
  REJECT_DOCUMENT: 'REJECT_DOCUMENT',
  ACCEPT_DOCUMENT: 'ACCEPT_DOCUMENT',
  CREATE_APPLICANT: 'CREATE_APPLICANT',
  UPDATE_APPLICANT: 'UPDATE_APPLICANT',
  DELETE_APPLICANT: 'DELETE_APPLICANT',
  CREATE_APPLICATION: 'CREATE_APPLICATION',
  UPDATE_APPLICATION: 'UPDATE_APPLICATION',
  DELETE_APPLICATION: 'DELETE_APPLICATION',

  // Ward councillors
  CREATE_COUNCILLOR: 'CREATE_COUNCILLOR',
  UPDATE_COUNCILLOR: 'UPDATE_COUNCILLOR',
  DEACTIVATE_COUNCILLOR: 'DEACTIVATE_COUNCILLOR',
  DELETE_COUNCILLOR: 'DELETE_COUNCILLOR',
  RESET_STAFF_PASSWORD: 'RESET_STAFF_PASSWORD',

  /// Door-to-door capture. Separated from CREATE_APPLICATION so a review can ask
  /// "what did this councillor sign up?" without wading through office work.
  FIELD_REGISTER_RESIDENT: 'FIELD_REGISTER_RESIDENT',
  FIELD_CAPTURE_APPLICATION: 'FIELD_CAPTURE_APPLICATION',
  FIELD_SUBMIT_APPLICATION: 'FIELD_SUBMIT_APPLICATION',

  // Verification
  SITE_VISIT: 'SITE_VISIT',
  VERIFICATION_CHECK: 'VERIFICATION_CHECK',
  RECOMMEND_APPLICATION: 'RECOMMEND_APPLICATION',
  REQUEST_INFORMATION: 'REQUEST_INFORMATION',

  // The approval chain
  ASSESS_APPLICATION: 'ASSESS_APPLICATION',
  RETURN_APPLICATION: 'RETURN_APPLICATION',
  SIGN_OFF_APPLICATION: 'SIGN_OFF_APPLICATION',
  RENEW_REGISTRATION: 'RENEW_REGISTRATION',
  RENEWAL_CHECK: 'RENEWAL_CHECK',
  PRINT_APPLICATION: 'PRINT_APPLICATION',

  // POPIA
  SUBJECT_ACCESS_REQUEST: 'SUBJECT_ACCESS_REQUEST',
  SUBJECT_REQUEST_LODGED: 'SUBJECT_REQUEST_LODGED',
  SUBJECT_REQUEST_HANDLED: 'SUBJECT_REQUEST_HANDLED',
  RETENTION_APPLIED: 'RETENTION_APPLIED',
  BREACH_RECORDED: 'BREACH_RECORDED',
  BREACH_UPDATED: 'BREACH_UPDATED',
};

function clientIp(req) {
  if (!req) return null;
  const forwarded = req.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || null;
}

/**
 * Write one audit row.
 *
 * Failures are swallowed: an audit write must never turn a successful login or
 * approval into a 500. They are logged to the server console so a broken audit
 * trail is still visible to operators.
 *
 * `actor` lets callers pass a user explicitly (e.g. at login, before req.user
 * exists); otherwise req.user is used.
 */
async function record(req, { action, entityType, entityId, details, actor } = {}) {
  try {
    const who = actor || req?.user || null;
    await prisma.auditLog.create({
      data: {
        userId: who?.id ?? null,
        userEmail: who?.email ?? null,
        userRole: who?.role ?? null,
        action,
        entityType: entityType ?? null,
        entityId: entityId ?? null,
        details: details ?? null,
        ipAddress: clientIp(req),
      },
    });
  } catch (error) {
    console.error(`[audit] failed to record ${action}:`, error.message);
  }
}

module.exports = { record, ACTIONS };
