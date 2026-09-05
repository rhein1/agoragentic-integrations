CREATE TABLE __RISK_FORK_MANAGED_SCHEMA__.managed_tenants (
  tenant_id text PRIMARY KEY CHECK (tenant_id ~ '^[a-z0-9][a-z0-9_-]{2,62}$'),
  status text NOT NULL CHECK (status IN ('active', 'suspended')),
  daily_budget_micros bigint NOT NULL CHECK (daily_budget_micros >= 0),
  max_invocation_cost_micros bigint NOT NULL CHECK (max_invocation_cost_micros >= 0),
  max_concurrent_invocations integer NOT NULL CHECK (max_concurrent_invocations BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (max_invocation_cost_micros <= daily_budget_micros)
);

CREATE TABLE __RISK_FORK_MANAGED_SCHEMA__.managed_api_keys (
  key_hash text PRIMARY KEY CHECK (key_hash ~ '^sha256:[a-f0-9]{64}$'),
  key_id text NOT NULL UNIQUE CHECK (key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$'),
  tenant_id text NOT NULL REFERENCES __RISK_FORK_MANAGED_SCHEMA__.managed_tenants(tenant_id),
  scopes jsonb NOT NULL CHECK (jsonb_typeof(scopes) = 'array'),
  not_before timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at > not_before),
  CHECK (revoked_at IS NULL OR revoked_at >= not_before)
);

CREATE INDEX managed_api_keys_tenant_idx
  ON __RISK_FORK_MANAGED_SCHEMA__.managed_api_keys (tenant_id, key_id);

CREATE TABLE __RISK_FORK_MANAGED_SCHEMA__.managed_usage_buckets (
  tenant_id text NOT NULL REFERENCES __RISK_FORK_MANAGED_SCHEMA__.managed_tenants(tenant_id),
  budget_day_utc date NOT NULL,
  reserved_micros bigint NOT NULL DEFAULT 0 CHECK (reserved_micros >= 0),
  spent_micros bigint NOT NULL DEFAULT 0 CHECK (spent_micros >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, budget_day_utc)
);

CREATE TABLE __RISK_FORK_MANAGED_SCHEMA__.managed_invocations (
  tenant_id text NOT NULL REFERENCES __RISK_FORK_MANAGED_SCHEMA__.managed_tenants(tenant_id),
  invocation_ref text NOT NULL CHECK (invocation_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$'),
  admitted_key_id text NOT NULL,
  provider_id text NOT NULL CHECK (provider_id ~ '^[a-z0-9][a-z0-9._-]{1,99}$'),
  provider_binding_hash text NOT NULL CHECK (provider_binding_hash ~ '^sha256:[a-f0-9]{64}$'),
  provider_adapter_digest text NOT NULL CHECK (provider_adapter_digest ~ '^sha256:[a-f0-9]{64}$'),
  provider_qualification_receipt_hash text NOT NULL CHECK (provider_qualification_receipt_hash ~ '^sha256:[a-f0-9]{64}$'),
  idempotency_hash text NOT NULL CHECK (idempotency_hash ~ '^sha256:[a-f0-9]{64}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^sha256:[a-f0-9]{64}$'),
  operation_hash text NOT NULL CHECK (operation_hash ~ '^sha256:[a-f0-9]{64}$'),
  operation_json jsonb NOT NULL CHECK (jsonb_typeof(operation_json) = 'object'),
  estimated_cost_micros bigint NOT NULL CHECK (estimated_cost_micros >= 0),
  actual_cost_micros bigint CHECK (
    actual_cost_micros IS NULL OR
    (actual_cost_micros >= 0 AND actual_cost_micros <= estimated_cost_micros)
  ),
  budget_day_utc date NOT NULL,
  state text NOT NULL CHECK (state IN (
    'admitted', 'execution_leased', 'running', 'cleanup_pending', 'recovery_required',
    'completed', 'failed_closed'
  )),
  lease_kind text CHECK (lease_kind IS NULL OR lease_kind IN ('execution', 'cleanup', 'recovery')),
  lease_owner text,
  lease_token_hash text CHECK (lease_token_hash IS NULL OR lease_token_hash ~ '^sha256:[a-f0-9]{64}$'),
  lease_expires_at timestamptz,
  lease_generation integer NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  savepoint_ref text,
  fork_ref text,
  cleanup_requests jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(cleanup_requests) = 'array'),
  provider_recovery_key text NOT NULL CHECK (provider_recovery_key ~ '^sha256:[a-f0-9]{64}$'),
  execution_outcome text CHECK (execution_outcome IS NULL OR execution_outcome IN ('succeeded', 'failed', 'ambiguous')),
  execution_evidence_hash text CHECK (execution_evidence_hash IS NULL OR execution_evidence_hash ~ '^sha256:[a-f0-9]{64}$'),
  result_hash text CHECK (result_hash IS NULL OR result_hash ~ '^sha256:[a-f0-9]{64}$'),
  admitted_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  terminal_at timestamptz,
  audit_head_hash text CHECK (audit_head_hash IS NULL OR audit_head_hash ~ '^sha256:[a-f0-9]{64}$'),
  audit_event_count integer NOT NULL DEFAULT 0 CHECK (audit_event_count >= 0),
  lease_claim_audit_hash text CHECK (
    lease_claim_audit_hash IS NULL OR lease_claim_audit_hash ~ '^sha256:[a-f0-9]{64}$'
  ),
  PRIMARY KEY (tenant_id, invocation_ref),
  UNIQUE (tenant_id, idempotency_hash),
  FOREIGN KEY (tenant_id, budget_day_utc)
    REFERENCES __RISK_FORK_MANAGED_SCHEMA__.managed_usage_buckets(tenant_id, budget_day_utc),
  CHECK ((lease_kind IS NULL) = (lease_owner IS NULL)),
  CHECK ((lease_kind IS NULL) = (lease_token_hash IS NULL)),
  CHECK ((lease_kind IS NULL) = (lease_expires_at IS NULL)),
  CHECK ((terminal_at IS NULL) = (state NOT IN ('completed', 'failed_closed')))
);

CREATE INDEX managed_invocations_active_idx
  ON __RISK_FORK_MANAGED_SCHEMA__.managed_invocations (tenant_id, state, admitted_at)
  WHERE state IN ('admitted', 'execution_leased', 'running', 'cleanup_pending');

CREATE INDEX managed_invocations_expired_lease_idx
  ON __RISK_FORK_MANAGED_SCHEMA__.managed_invocations (lease_expires_at)
  WHERE lease_expires_at IS NOT NULL;

CREATE TABLE __RISK_FORK_MANAGED_SCHEMA__.managed_lease_token_uses (
  tenant_id text NOT NULL,
  invocation_ref text NOT NULL,
  lease_token_hash text NOT NULL CHECK (lease_token_hash ~ '^sha256:[a-f0-9]{64}$'),
  first_claimed_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, lease_token_hash),
  FOREIGN KEY (tenant_id, invocation_ref)
    REFERENCES __RISK_FORK_MANAGED_SCHEMA__.managed_invocations(tenant_id, invocation_ref)
);

CREATE TABLE __RISK_FORK_MANAGED_SCHEMA__.managed_resource_journal_receipts (
  tenant_id text NOT NULL,
  invocation_ref text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^sha256:[a-f0-9]{64}$'),
  claimant_key_id text NOT NULL,
  lease_token_hash text NOT NULL CHECK (lease_token_hash ~ '^sha256:[a-f0-9]{64}$'),
  response_json jsonb NOT NULL CHECK (jsonb_typeof(response_json) = 'object'),
  response_hash text NOT NULL CHECK (response_hash ~ '^sha256:[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, invocation_ref, request_hash),
  FOREIGN KEY (tenant_id, invocation_ref)
    REFERENCES __RISK_FORK_MANAGED_SCHEMA__.managed_invocations(tenant_id, invocation_ref)
);

CREATE TABLE __RISK_FORK_MANAGED_SCHEMA__.managed_audit_events (
  tenant_id text NOT NULL,
  invocation_ref text NOT NULL,
  sequence integer NOT NULL CHECK (sequence >= 1),
  event_ref text NOT NULL UNIQUE,
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  details_hash text NOT NULL CHECK (details_hash ~ '^sha256:[a-f0-9]{64}$'),
  prior_event_hash text CHECK (prior_event_hash IS NULL OR prior_event_hash ~ '^sha256:[a-f0-9]{64}$'),
  event_hash text NOT NULL UNIQUE CHECK (event_hash ~ '^sha256:[a-f0-9]{64}$'),
  evidence_class text NOT NULL CHECK (evidence_class = 'control_plane_self_attested'),
  PRIMARY KEY (tenant_id, invocation_ref, sequence),
  FOREIGN KEY (tenant_id, invocation_ref)
    REFERENCES __RISK_FORK_MANAGED_SCHEMA__.managed_invocations(tenant_id, invocation_ref),
  CHECK ((sequence = 1 AND prior_event_hash IS NULL) OR (sequence > 1 AND prior_event_hash IS NOT NULL))
);

CREATE FUNCTION __RISK_FORK_MANAGED_SCHEMA__.reject_managed_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
BEGIN
  RAISE EXCEPTION 'risk fork managed audit events are append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER managed_audit_events_no_update
  BEFORE UPDATE ON __RISK_FORK_MANAGED_SCHEMA__.managed_audit_events
  FOR EACH ROW EXECUTE FUNCTION __RISK_FORK_MANAGED_SCHEMA__.reject_managed_audit_mutation();

CREATE TRIGGER managed_audit_events_no_delete
  BEFORE DELETE ON __RISK_FORK_MANAGED_SCHEMA__.managed_audit_events
  FOR EACH ROW EXECUTE FUNCTION __RISK_FORK_MANAGED_SCHEMA__.reject_managed_audit_mutation();

REVOKE ALL ON FUNCTION __RISK_FORK_MANAGED_SCHEMA__.reject_managed_audit_mutation() FROM PUBLIC;
