-- One sanctioned exception to the append-only rule.
--
-- The previous migration made AuditLog, FieldChange and ApprovalStep refuse
-- UPDATE, DELETE and TRUNCATE. Testing it against real rows exposed a conflict
-- between two obligations that both have to hold:
--
--   POPIA s14 requires personal information to be deleted once the purpose it
--   was collected for has expired. An abandoned draft is the clearest case:
--   somebody started a form, thought better of it, and the municipality has no
--   application to decide. Deleting that draft cascades into FieldChange, so the
--   trigger refused it and the retention sweep failed outright.
--
-- A trigger that refuses absolutely puts audit immutability and the deletion
-- duty in direct conflict, and in practice the deletion duty loses — the sweep
-- errors, somebody switches it off, and the register quietly keeps ID numbers
-- for ever. That is not a trade a municipality is entitled to make.
--
-- So DELETE is permitted, and only DELETE, and only while a transaction-local
-- flag is set. Three things make that narrow enough to be worth having:
--
--   * The flag is set with is_local = true, so PostgreSQL clears it when the
--     transaction ends. It cannot be switched on and left on.
--   * Only the retention sweep sets it, and it writes an audit row naming the
--     policy and the cut-off date before it does.
--   * UPDATE and TRUNCATE stay absolute. Nothing may rewrite history or empty
--     the table, whatever flag is set. Retention removes whole expired records;
--     it never edits what a record says.
--
-- What this does not defend against: somebody with a superuser connection and
-- intent. They can set the flag, and they could equally DROP TRIGGER. That
-- threat is answered by off-box backups and restricted database credentials,
-- not by a trigger. The trigger is here to stop application bugs, casual
-- cleanup and an official acting through the system — which is what actually
-- happens.

CREATE OR REPLACE FUNCTION refuse_audit_mutation() RETURNS trigger AS $$
BEGIN
  -- Statement-level TRUNCATE has no OLD/NEW row to return, and is never
  -- legitimate here regardless, so it is checked first and always refused.
  IF TG_OP = 'DELETE' AND current_setting('indigent.retention_sweep', true) = 'on' THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION
    'Table % is append-only: % is not permitted. This is the audit trail; correct the record by adding to it, not by changing it.',
    TG_TABLE_NAME, TG_OP
    USING
      ERRCODE = 'restrict_violation',
      HINT = 'Records expire through the retention policy, which removes whole expired records inside an audited sweep. Nothing rewrites an audit row.';
END;
$$ LANGUAGE plpgsql;
