CREATE SCHEMA IF NOT EXISTS __RISK_FORK_SCHEMA__;

CREATE TABLE IF NOT EXISTS __RISK_FORK_SCHEMA__.authority_schema_migrations (
  version integer PRIMARY KEY CHECK (version >= 1),
  migration_hash text NOT NULL CHECK (migration_hash ~ '^sha256:[a-f0-9]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS __RISK_FORK_SCHEMA__.authority_meta (
  authority_id text PRIMARY KEY,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  audit_sequence bigint NOT NULL DEFAULT 0 CHECK (audit_sequence >= 0),
  audit_head_hash text NULL CHECK (
    audit_head_hash IS NULL OR audit_head_hash ~ '^sha256:[a-f0-9]{64}$'
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS __RISK_FORK_SCHEMA__.parent_heads (
  authority_id text NOT NULL REFERENCES __RISK_FORK_SCHEMA__.authority_meta(authority_id),
  parent_ref text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'reserved', 'ambiguous')),
  head_hash text NOT NULL CHECK (head_hash ~ '^sha256:[a-f0-9]{64}$'),
  current_governance jsonb NULL,
  governance_hash text NULL CHECK (
    governance_hash IS NULL OR governance_hash ~ '^sha256:[a-f0-9]{64}$'
  ),
  pending_operation_ref text NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (authority_id, parent_ref),
  CHECK (
    (status = 'active' AND pending_operation_ref IS NULL)
    OR (status IN ('reserved', 'ambiguous') AND pending_operation_ref IS NOT NULL)
  ),
  CHECK ((current_governance IS NULL) = (governance_hash IS NULL))
);

CREATE TABLE IF NOT EXISTS __RISK_FORK_SCHEMA__.commit_approvals (
  authority_id text NOT NULL REFERENCES __RISK_FORK_SCHEMA__.authority_meta(authority_id),
  approval_key text NOT NULL CHECK (approval_key ~ '^sha256:[a-f0-9]{64}$'),
  parent_ref text NOT NULL,
  status text NOT NULL CHECK (
    status IN ('active', 'reserved', 'consumed', 'revoked', 'superseded')
  ),
  artifact_hash text NOT NULL CHECK (artifact_hash ~ '^sha256:[a-f0-9]{64}$'),
  capsule_hash text NOT NULL CHECK (capsule_hash ~ '^sha256:[a-f0-9]{64}$'),
  parent_state_hash text NOT NULL CHECK (parent_state_hash ~ '^sha256:[a-f0-9]{64}$'),
  commit_type text NOT NULL CHECK (
    commit_type IN ('TYPED_RESULT', 'WORKSPACE_DIFF', 'CONSEQUENTIAL_ACTION_PROPOSAL')
  ),
  governance_hash text NOT NULL CHECK (governance_hash ~ '^sha256:[a-f0-9]{64}$'),
  evidence_ref text NOT NULL,
  evidence_hash text NOT NULL CHECK (evidence_hash ~ '^sha256:[a-f0-9]{64}$'),
  operation_ref text NULL,
  registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  consumed_at timestamptz NULL,
  revocation_evidence_ref text NULL,
  revocation_evidence_hash text NULL CHECK (
    revocation_evidence_hash IS NULL
    OR revocation_evidence_hash ~ '^sha256:[a-f0-9]{64}$'
  ),
  PRIMARY KEY (authority_id, approval_key),
  FOREIGN KEY (authority_id, parent_ref)
    REFERENCES __RISK_FORK_SCHEMA__.parent_heads(authority_id, parent_ref),
  UNIQUE (authority_id, parent_ref, evidence_ref),
  CHECK (
    (status = 'active' AND operation_ref IS NULL AND consumed_at IS NULL
      AND revocation_evidence_ref IS NULL AND revocation_evidence_hash IS NULL)
    OR (status = 'reserved' AND operation_ref IS NOT NULL AND consumed_at IS NULL
      AND revocation_evidence_ref IS NULL AND revocation_evidence_hash IS NULL)
    OR (status = 'consumed' AND operation_ref IS NOT NULL AND consumed_at IS NOT NULL
      AND revocation_evidence_ref IS NULL AND revocation_evidence_hash IS NULL)
    OR (status = 'revoked' AND operation_ref IS NULL AND consumed_at IS NULL
      AND revocation_evidence_ref IS NOT NULL AND revocation_evidence_hash IS NOT NULL)
    OR (status = 'superseded' AND operation_ref IS NULL AND consumed_at IS NULL
      AND revocation_evidence_ref IS NULL AND revocation_evidence_hash IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS commit_approvals_one_active_binding
  ON __RISK_FORK_SCHEMA__.commit_approvals (
    authority_id,
    parent_ref,
    artifact_hash,
    capsule_hash,
    parent_state_hash,
    commit_type,
    governance_hash
  )
  WHERE status IN ('active', 'reserved');

CREATE TABLE IF NOT EXISTS __RISK_FORK_SCHEMA__.execution_authorizations (
  authority_id text NOT NULL REFERENCES __RISK_FORK_SCHEMA__.authority_meta(authority_id),
  authorization_id text NOT NULL,
  status text NOT NULL CHECK (
    status IN ('active', 'reserved', 'effect_started', 'consumed', 'revoked', 'ambiguous')
  ),
  authorization_ref text NOT NULL,
  authorization_hash text NOT NULL CHECK (authorization_hash ~ '^sha256:[a-f0-9]{64}$'),
  binding_hash text NOT NULL CHECK (binding_hash ~ '^sha256:[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  evidence_ref text NOT NULL,
  evidence_hash text NOT NULL CHECK (evidence_hash ~ '^sha256:[a-f0-9]{64}$'),
  operation_ref text NULL,
  verification_evidence_ref text NULL,
  verification_evidence_hash text NULL CHECK (
    verification_evidence_hash IS NULL
    OR verification_evidence_hash ~ '^sha256:[a-f0-9]{64}$'
  ),
  result_hash text NULL CHECK (result_hash IS NULL OR result_hash ~ '^sha256:[a-f0-9]{64}$'),
  failure_code text NULL,
  registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  consumed_at timestamptz NULL,
  revocation_evidence_ref text NULL,
  revocation_evidence_hash text NULL CHECK (
    revocation_evidence_hash IS NULL
    OR revocation_evidence_hash ~ '^sha256:[a-f0-9]{64}$'
  ),
  PRIMARY KEY (authority_id, authorization_id),
  CHECK (
    (status = 'active' AND operation_ref IS NULL AND result_hash IS NULL
      AND consumed_at IS NULL AND revocation_evidence_ref IS NULL
      AND revocation_evidence_hash IS NULL AND verification_evidence_ref IS NULL
      AND verification_evidence_hash IS NULL AND failure_code IS NULL)
    OR (status IN ('reserved', 'effect_started')
      AND operation_ref IS NOT NULL AND result_hash IS NULL AND consumed_at IS NULL
      AND revocation_evidence_ref IS NULL AND revocation_evidence_hash IS NULL
      AND verification_evidence_ref IS NOT NULL
      AND verification_evidence_hash IS NOT NULL AND failure_code IS NULL)
    OR (status = 'ambiguous' AND operation_ref IS NOT NULL
      AND result_hash IS NULL AND consumed_at IS NULL
      AND revocation_evidence_ref IS NULL AND revocation_evidence_hash IS NULL
      AND verification_evidence_ref IS NOT NULL
      AND verification_evidence_hash IS NOT NULL)
    OR (status = 'consumed' AND operation_ref IS NOT NULL AND result_hash IS NOT NULL
      AND consumed_at IS NOT NULL AND verification_evidence_ref IS NOT NULL
      AND verification_evidence_hash IS NOT NULL
      AND revocation_evidence_ref IS NULL AND revocation_evidence_hash IS NULL)
    OR (status = 'revoked' AND operation_ref IS NULL AND result_hash IS NULL
      AND consumed_at IS NULL AND revocation_evidence_ref IS NOT NULL
      AND revocation_evidence_hash IS NOT NULL AND verification_evidence_ref IS NULL
      AND verification_evidence_hash IS NULL AND failure_code IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS __RISK_FORK_SCHEMA__.operations (
  authority_id text NOT NULL REFERENCES __RISK_FORK_SCHEMA__.authority_meta(authority_id),
  operation_ref text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^sha256:[a-f0-9]{64}$'),
  authority_request_hash text NOT NULL CHECK (
    authority_request_hash ~ '^sha256:[a-f0-9]{64}$'
  ),
  parent_ref text NOT NULL,
  approval_key text NOT NULL CHECK (approval_key ~ '^sha256:[a-f0-9]{64}$'),
  authorization_id text NULL,
  status text NOT NULL CHECK (
    status IN (
      'prepared',
      'effect_started',
      'committed',
      'ambiguous',
      'aborted'
    )
  ),
  commit_type text NOT NULL CHECK (
    commit_type IN ('TYPED_RESULT', 'WORKSPACE_DIFF', 'CONSEQUENTIAL_ACTION_PROPOSAL')
  ),
  previous_head_hash text NOT NULL CHECK (
    previous_head_hash ~ '^sha256:[a-f0-9]{64}$'
  ),
  next_head_hash text NULL CHECK (
    next_head_hash IS NULL OR next_head_hash ~ '^sha256:[a-f0-9]{64}$'
  ),
  artifact_hash text NOT NULL CHECK (artifact_hash ~ '^sha256:[a-f0-9]{64}$'),
  capsule_hash text NOT NULL CHECK (capsule_hash ~ '^sha256:[a-f0-9]{64}$'),
  governance_hash text NOT NULL CHECK (governance_hash ~ '^sha256:[a-f0-9]{64}$'),
  governance_evidence_hash text NOT NULL CHECK (
    governance_evidence_hash ~ '^sha256:[a-f0-9]{64}$'
  ),
  approval_evidence_ref text NOT NULL,
  approval_evidence_hash text NOT NULL CHECK (
    approval_evidence_hash ~ '^sha256:[a-f0-9]{64}$'
  ),
  authorization_binding_hash text NULL CHECK (
    authorization_binding_hash IS NULL
    OR authorization_binding_hash ~ '^sha256:[a-f0-9]{64}$'
  ),
  capsule_expires_at timestamptz NOT NULL,
  effect_key text NULL,
  effect_token_hash text NULL CHECK (
    effect_token_hash IS NULL OR effect_token_hash ~ '^sha256:[a-f0-9]{64}$'
  ),
  claimant_ref text NULL,
  result jsonb NULL,
  result_hash text NULL CHECK (result_hash IS NULL OR result_hash ~ '^sha256:[a-f0-9]{64}$'),
  transaction_hash text NULL CHECK (
    transaction_hash IS NULL OR transaction_hash ~ '^sha256:[a-f0-9]{64}$'
  ),
  failure_code text NULL,
  failure_message text NULL,
  resolution text NULL CHECK (resolution IS NULL OR resolution = 'effect_succeeded'),
  resolution_evidence_ref text NULL,
  resolution_evidence_hash text NULL CHECK (
    resolution_evidence_hash IS NULL
    OR resolution_evidence_hash ~ '^sha256:[a-f0-9]{64}$'
  ),
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  prepared_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  effect_started_at timestamptz NULL,
  completed_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (authority_id, operation_ref),
  UNIQUE (authority_id, request_hash),
  UNIQUE (authority_id, effect_key),
  FOREIGN KEY (authority_id, parent_ref)
    REFERENCES __RISK_FORK_SCHEMA__.parent_heads(authority_id, parent_ref),
  FOREIGN KEY (authority_id, approval_key)
    REFERENCES __RISK_FORK_SCHEMA__.commit_approvals(authority_id, approval_key),
  FOREIGN KEY (authority_id, authorization_id)
    REFERENCES __RISK_FORK_SCHEMA__.execution_authorizations(authority_id, authorization_id),
  CHECK (
    (commit_type = 'CONSEQUENTIAL_ACTION_PROPOSAL'
      AND authorization_id IS NOT NULL AND authorization_binding_hash IS NOT NULL)
    OR (commit_type <> 'CONSEQUENTIAL_ACTION_PROPOSAL'
      AND authorization_id IS NULL AND authorization_binding_hash IS NULL)
  ),
  CHECK (
    (status = 'prepared' AND effect_key IS NULL AND effect_token_hash IS NULL
      AND result IS NULL AND result_hash IS NULL AND next_head_hash IS NULL
      AND transaction_hash IS NULL AND effect_started_at IS NULL
      AND resolution IS NULL AND resolution_evidence_ref IS NULL
      AND resolution_evidence_hash IS NULL AND completed_at IS NULL)
    OR (status IN ('effect_started', 'ambiguous')
      AND effect_key IS NOT NULL AND effect_token_hash IS NOT NULL
      AND result IS NULL AND result_hash IS NULL AND next_head_hash IS NULL
      AND transaction_hash IS NULL AND effect_started_at IS NOT NULL
      AND resolution IS NULL AND resolution_evidence_ref IS NULL
      AND resolution_evidence_hash IS NULL AND completed_at IS NULL)
    OR (status = 'committed' AND effect_key IS NOT NULL AND effect_token_hash IS NOT NULL
      AND result_hash IS NOT NULL AND next_head_hash IS NOT NULL
      AND transaction_hash IS NOT NULL AND effect_started_at IS NOT NULL
      AND completed_at IS NOT NULL
      AND ((resolution IS NULL AND resolution_evidence_ref IS NULL
          AND resolution_evidence_hash IS NULL)
        OR (resolution = 'effect_succeeded' AND resolution_evidence_ref IS NOT NULL
          AND resolution_evidence_hash IS NOT NULL)))
    OR (status = 'aborted' AND effect_key IS NULL AND effect_token_hash IS NULL
      AND result IS NULL AND result_hash IS NULL AND next_head_hash IS NULL
      AND transaction_hash IS NULL AND effect_started_at IS NULL
      AND resolution IS NULL AND resolution_evidence_ref IS NOT NULL
      AND resolution_evidence_hash IS NOT NULL AND completed_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS __RISK_FORK_SCHEMA__.audit_events (
  authority_id text NOT NULL REFERENCES __RISK_FORK_SCHEMA__.authority_meta(authority_id),
  sequence bigint NOT NULL CHECK (sequence >= 1),
  event_type text NOT NULL,
  operation_ref text NULL,
  parent_ref text NULL,
  authorization_id text NULL,
  observed_at timestamptz NOT NULL,
  previous_event_hash text NULL CHECK (
    previous_event_hash IS NULL OR previous_event_hash ~ '^sha256:[a-f0-9]{64}$'
  ),
  payload jsonb NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^sha256:[a-f0-9]{64}$'),
  event_hash text NOT NULL CHECK (event_hash ~ '^sha256:[a-f0-9]{64}$'),
  PRIMARY KEY (authority_id, sequence),
  UNIQUE (authority_id, event_hash)
);

CREATE OR REPLACE FUNCTION __RISK_FORK_SCHEMA__.reject_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'risk fork authority audit events are append-only'
    USING ERRCODE = '55000';
END;
$function$;

DROP TRIGGER IF EXISTS audit_events_no_update ON __RISK_FORK_SCHEMA__.audit_events;
CREATE TRIGGER audit_events_no_update
  BEFORE UPDATE ON __RISK_FORK_SCHEMA__.audit_events
  FOR EACH ROW EXECUTE FUNCTION __RISK_FORK_SCHEMA__.reject_audit_mutation();

DROP TRIGGER IF EXISTS audit_events_no_delete ON __RISK_FORK_SCHEMA__.audit_events;
CREATE TRIGGER audit_events_no_delete
  BEFORE DELETE ON __RISK_FORK_SCHEMA__.audit_events
  FOR EACH ROW EXECUTE FUNCTION __RISK_FORK_SCHEMA__.reject_audit_mutation();
