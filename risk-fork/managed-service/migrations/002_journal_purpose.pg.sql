-- Explicit owner-run upgrade. Never rewrite migration 001 or infer purpose
-- from the invocation's mutable current lease. Bind existing receipts to their
-- own exact audit-head event; ambiguous legacy evidence aborts the migration.
ALTER TABLE __RISK_FORK_MANAGED_SCHEMA__.managed_resource_journal_receipts
  ADD COLUMN lease_kind text;

UPDATE __RISK_FORK_MANAGED_SCHEMA__.managed_resource_journal_receipts AS receipt
   SET lease_kind = CASE audit.event_type
     WHEN 'provider_resources_recovered' THEN 'recovery'
     ELSE 'execution'
   END
  FROM __RISK_FORK_MANAGED_SCHEMA__.managed_audit_events AS audit
 WHERE audit.tenant_id = receipt.tenant_id
   AND audit.invocation_ref = receipt.invocation_ref
   AND audit.event_hash = receipt.response_json->>'audit_head_hash'
   AND audit.event_type IN (
     'provider_resources_recovered', 'provider_resource_journaled', 'provider_resources_recorded'
   );

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM __RISK_FORK_MANAGED_SCHEMA__.managed_resource_journal_receipts
    WHERE lease_kind IS NULL) THEN
    RAISE EXCEPTION 'legacy resource-journal purpose cannot be attested' USING ERRCODE = '55000';
  END IF;
END;
$$;

ALTER TABLE __RISK_FORK_MANAGED_SCHEMA__.managed_resource_journal_receipts
  ALTER COLUMN lease_kind SET NOT NULL,
  ADD CONSTRAINT managed_resource_journal_purpose CHECK (lease_kind IN ('execution', 'recovery'));
