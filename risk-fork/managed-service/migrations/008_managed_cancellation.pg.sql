-- Managed control-plane migration version 4. Filenames 004--007 belong to
-- independent policy/telemetry migration sets; their bytes remain frozen.
-- Owner-executed only. Runtime initialization never creates or repairs this.
ALTER TABLE __RISK_FORK_MANAGED_SCHEMA__.managed_invocations
  ADD COLUMN cancel_requested_at timestamptz,
  ADD COLUMN cancel_requested_by text,
  ADD COLUMN cancel_request_hash text,
  ADD COLUMN cancel_reason_hash text,
  ADD CONSTRAINT managed_cancellation_marker CHECK (
    (cancel_requested_at IS NULL AND cancel_requested_by IS NULL
      AND cancel_request_hash IS NULL AND cancel_reason_hash IS NULL)
    OR (cancel_requested_at IS NOT NULL AND cancel_requested_by = admitted_key_id
      AND cancel_request_hash ~ '^sha256:[a-f0-9]{64}$'
      AND cancel_reason_hash ~ '^sha256:[a-f0-9]{64}$'
      AND cancel_requested_by IS NOT NULL AND cancel_request_hash IS NOT NULL
      AND cancel_reason_hash IS NOT NULL
      AND state IN ('cleanup_pending', 'recovery_required', 'failed_closed'))
  );

CREATE FUNCTION __RISK_FORK_MANAGED_SCHEMA__.reject_managed_cancellation_rearm()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
BEGIN
  IF OLD.cancel_requested_at IS NOT NULL AND (
    NEW.cancel_requested_at IS DISTINCT FROM OLD.cancel_requested_at
    OR NEW.cancel_requested_by IS DISTINCT FROM OLD.cancel_requested_by
    OR NEW.cancel_request_hash IS DISTINCT FROM OLD.cancel_request_hash
    OR NEW.cancel_reason_hash IS DISTINCT FROM OLD.cancel_reason_hash
  ) THEN
    RAISE EXCEPTION 'risk fork managed cancellation is permanent'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER managed_invocations_no_cancellation_rearm
  BEFORE UPDATE ON __RISK_FORK_MANAGED_SCHEMA__.managed_invocations
  FOR EACH ROW EXECUTE FUNCTION __RISK_FORK_MANAGED_SCHEMA__.reject_managed_cancellation_rearm();

REVOKE ALL ON FUNCTION __RISK_FORK_MANAGED_SCHEMA__.reject_managed_cancellation_rearm() FROM PUBLIC;
