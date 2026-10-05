-- Version 1 of an INDEPENDENT observer ledger, not policy/control migration 005.
CREATE TABLE __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_schema_migrations (
  version integer PRIMARY KEY CHECK (version = 1),
  migration_hash text NOT NULL CHECK (migration_hash ~ '^sha256:[a-f0-9]{64}$')
);
CREATE TABLE __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_settings (
  singleton boolean PRIMARY KEY CHECK (singleton),
  settings_hash text NOT NULL CHECK (settings_hash ~ '^sha256:[a-f0-9]{64}$'),
  max_events integer NOT NULL CHECK (max_events BETWEEN 1 AND 1000000),
  max_events_per_tenant integer NOT NULL CHECK (max_events_per_tenant BETWEEN 1 AND max_events),
  lease_ms integer NOT NULL CHECK (lease_ms BETWEEN 100 AND 30000),
  retry_ms integer NOT NULL CHECK (retry_ms BETWEEN 100 AND 60000),
  retention_ms integer NOT NULL CHECK (retention_ms BETWEEN 1000 AND 604800000)
);
CREATE TABLE __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_clock (
  singleton boolean PRIMARY KEY CHECK (singleton),
  last_seen_ms bigint NOT NULL DEFAULT 0 CHECK (last_seen_ms BETWEEN 0 AND 9007199254740991)
);
INSERT INTO __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_clock VALUES (true, 0);
CREATE TABLE __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_events (
  event_ref text PRIMARY KEY CHECK (event_ref ~ '^evt_[a-f0-9]{48}$'),
  event_hash text NOT NULL CHECK (event_hash ~ '^sha256:[a-f0-9]{64}$'),
  event text NOT NULL CHECK (event IN ('control_denied','rate_denied','policy_error','policy_allowed','policy_candidate')),
  route_class text NOT NULL CHECK (route_class IN ('admission','execution','cleanup','recovery','read')),
  status integer NOT NULL,
  outcome text NOT NULL,
  duration_ms integer NOT NULL CHECK (duration_ms BETWEEN 0 AND 2147483647),
  tenant_hash text NOT NULL CHECK (tenant_hash ~ '^sha256:[a-f0-9]{64}$'),
  key_hash text NOT NULL CHECK (key_hash ~ '^sha256:[a-f0-9]{64}$'),
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
  CHECK ((event='policy_allowed' AND outcome='allowed' AND status=200)
    OR (event='policy_candidate' AND outcome='candidate' AND status=200)
    OR (event='rate_denied' AND outcome='rate_limited' AND status=429)
    OR (event='control_denied' AND outcome IN ('disabled','failed_closed') AND status=503)
    OR (event='policy_error' AND outcome IN ('failed_closed','timeout') AND status=503)),
  CHECK ((state='pending' AND claim_hash IS NULL AND lease_expires_ms IS NULL)
    OR (state IN ('claimed','acked') AND claim_hash IS NOT NULL AND lease_expires_ms IS NOT NULL
      AND generation>0 AND attempts>0)),
  CHECK ((state='acked' AND acknowledged_ms IS NOT NULL AND acknowledgement_hash IS NOT NULL)
    OR (state<>'acked' AND acknowledged_ms IS NULL AND acknowledgement_hash IS NULL))
);
CREATE INDEX telemetry_pending ON __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_events (state,next_attempt_ms,created_ms,event_ref);
CREATE INDEX telemetry_tenant ON __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_events (tenant_hash);
CREATE UNIQUE INDEX telemetry_active_claim ON __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_events (claim_hash) WHERE state='claimed';
