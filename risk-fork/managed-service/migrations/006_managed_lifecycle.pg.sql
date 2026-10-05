-- Opt-in version 2 of the EXISTING telemetry observer schema. Frozen 005 and
-- its policy event contract remain unchanged. No execution authority lives here.
ALTER TABLE __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_schema_migrations
  DROP CONSTRAINT telemetry_schema_migrations_version_check;
ALTER TABLE __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_schema_migrations
  ADD CONSTRAINT telemetry_schema_migrations_version_check CHECK (version IN (1,2));
CREATE TABLE __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_lifecycle_events (
  event_ref text PRIMARY KEY CHECK (event_ref ~ '^evt_[a-f0-9]{48}$'),
  event_hash text NOT NULL CHECK (event_hash ~ '^sha256:[a-f0-9]{64}$'),
  tenant_hash text NOT NULL CHECK (tenant_hash ~ '^sha256:[a-f0-9]{64}$'),
  invocation_hash text NOT NULL CHECK (invocation_hash ~ '^sha256:[a-f0-9]{64}$'),
  source_sequence integer NOT NULL CHECK (source_sequence BETWEEN 1 AND 2147483647),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
  created_ms bigint NOT NULL CHECK (created_ms BETWEEN 0 AND 9007199254740991),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','claimed','acked')),
  generation bigint NOT NULL DEFAULT 0 CHECK (generation BETWEEN 0 AND 9007199254740991),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 1000000),
  claim_hash text CHECK (claim_hash ~ '^sha256:[a-f0-9]{64}$'),
  lease_expires_ms bigint CHECK (lease_expires_ms BETWEEN 0 AND 9007199254740991),
  next_attempt_ms bigint NOT NULL DEFAULT 0 CHECK (next_attempt_ms BETWEEN 0 AND 9007199254740991),
  acknowledged_ms bigint CHECK (acknowledged_ms BETWEEN 0 AND 9007199254740991),
  acknowledgement_hash text CHECK (acknowledgement_hash ~ '^sha256:[a-f0-9]{64}$'),
  last_error_code text CHECK (last_error_code IN ('SINK_UNAVAILABLE','INVALID_ACK','REQUEST_TIMEOUT')),
  UNIQUE (tenant_hash,invocation_hash,source_sequence),
  CHECK ((state='pending' AND claim_hash IS NULL AND lease_expires_ms IS NULL)
    OR (state IN ('claimed','acked') AND claim_hash IS NOT NULL AND lease_expires_ms IS NOT NULL AND generation>0 AND attempts>0)),
  CHECK ((state='acked' AND acknowledged_ms IS NOT NULL AND acknowledgement_hash IS NOT NULL)
    OR (state<>'acked' AND acknowledged_ms IS NULL AND acknowledgement_hash IS NULL))
);
CREATE INDEX telemetry_lifecycle_pending ON __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_lifecycle_events (state,next_attempt_ms,created_ms,event_ref);
CREATE INDEX telemetry_lifecycle_tenant ON __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_lifecycle_events (tenant_hash);
CREATE UNIQUE INDEX telemetry_lifecycle_active_claim ON __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_lifecycle_events (claim_hash) WHERE state='claimed';
CREATE TABLE __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_lifecycle_checkpoints (
  observer_hash text NOT NULL CHECK (observer_hash ~ '^sha256:[a-f0-9]{64}$'),
  tenant_hash text NOT NULL CHECK (tenant_hash ~ '^sha256:[a-f0-9]{64}$'),
  invocation_hash text NOT NULL CHECK (invocation_hash ~ '^sha256:[a-f0-9]{64}$'),
  sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 2147483647),
  event_hash text NOT NULL CHECK (event_hash ~ '^sha256:[a-f0-9]{64}$'),
  checkpoint_hash text NOT NULL CHECK (checkpoint_hash ~ '^sha256:[a-f0-9]{64}$'),
  PRIMARY KEY (observer_hash,tenant_hash,invocation_hash)
);
CREATE TABLE __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_lifecycle_sweeps (
  observer_hash text NOT NULL CHECK (observer_hash ~ '^sha256:[a-f0-9]{64}$'),
  tenant_hash text NOT NULL CHECK (tenant_hash ~ '^sha256:[a-f0-9]{64}$'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
  state_hash text NOT NULL CHECK (state_hash ~ '^sha256:[a-f0-9]{64}$'),
  PRIMARY KEY (observer_hash,tenant_hash)
);
