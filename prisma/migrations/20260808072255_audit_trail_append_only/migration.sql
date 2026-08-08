-- Make the audit trail append-only at the database level.
--
-- Until now the application never deleted an audit row, but nothing stopped
-- anybody with a database connection from doing so. "We do not do that in the
-- code" is not an assurance an auditor can rely on, and the whole value of an
-- audit trail is that it cannot be quietly edited by the person it incriminates.
--
-- Enforced by trigger rather than by permissions because a trigger travels with
-- the schema. GRANTs live in the cluster and are lost on a restore into a fresh
-- database, which is exactly when nobody remembers to reapply them.
--
-- Applies to the three tables that exist to be evidence:
--   AuditLog      who did what, across the whole system
--   ApprovalStep  who decided, at which stage, and their signature
--   FieldChange   what value changed, from what, to what
--
-- INSERT stays allowed. Everything else is refused with a message that explains
-- why rather than a bare constraint violation.

CREATE OR REPLACE FUNCTION refuse_audit_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'Table % is append-only: % is not permitted. This is the audit trail; correct the record by adding to it, not by changing it.',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation',
          HINT = 'If a retention policy genuinely requires removal, drop the trigger deliberately, record why, and restore it.';
END;
$$ LANGUAGE plpgsql;

-- AuditLog ------------------------------------------------------------------
DROP TRIGGER IF EXISTS audit_log_no_update ON "AuditLog";
CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION refuse_audit_mutation();

DROP TRIGGER IF EXISTS audit_log_no_delete ON "AuditLog";
CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION refuse_audit_mutation();

-- Also refuse TRUNCATE, which bypasses row-level triggers entirely and would
-- otherwise empty the table in one statement.
DROP TRIGGER IF EXISTS audit_log_no_truncate ON "AuditLog";
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON "AuditLog"
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_audit_mutation();

-- FieldChange ---------------------------------------------------------------
DROP TRIGGER IF EXISTS field_change_no_update ON "FieldChange";
CREATE TRIGGER field_change_no_update
  BEFORE UPDATE ON "FieldChange"
  FOR EACH ROW EXECUTE FUNCTION refuse_audit_mutation();

DROP TRIGGER IF EXISTS field_change_no_delete ON "FieldChange";
CREATE TRIGGER field_change_no_delete
  BEFORE DELETE ON "FieldChange"
  FOR EACH ROW EXECUTE FUNCTION refuse_audit_mutation();

DROP TRIGGER IF EXISTS field_change_no_truncate ON "FieldChange";
CREATE TRIGGER field_change_no_truncate
  BEFORE TRUNCATE ON "FieldChange"
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_audit_mutation();

-- ApprovalStep --------------------------------------------------------------
--
-- UPDATE has to stay permitted here, unlike the other two: a step is opened when
-- an officer picks a file up and completed when they decide, which is one row
-- written twice by design. DELETE and TRUNCATE are refused, so a decision or a
-- signature can never be removed once recorded.
DROP TRIGGER IF EXISTS approval_step_no_delete ON "ApprovalStep";
CREATE TRIGGER approval_step_no_delete
  BEFORE DELETE ON "ApprovalStep"
  FOR EACH ROW EXECUTE FUNCTION refuse_audit_mutation();

DROP TRIGGER IF EXISTS approval_step_no_truncate ON "ApprovalStep";
CREATE TRIGGER approval_step_no_truncate
  BEFORE TRUNCATE ON "ApprovalStep"
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_audit_mutation();
