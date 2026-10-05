-- Opt-in version 3 of the EXISTING observer schema. Frozen 005/006 are unchanged.
-- Counts are ingested observations, never dispatch authority or provider proof.
ALTER TABLE __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_schema_migrations
  DROP CONSTRAINT telemetry_schema_migrations_version_check;
ALTER TABLE __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_schema_migrations
  ADD CONSTRAINT telemetry_schema_migrations_version_check CHECK (version IN (1,2,3));
CREATE TABLE __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_metric_settings (
  singleton boolean PRIMARY KEY CHECK (singleton),
  settings_hash text NOT NULL CHECK (settings_hash ~ '^sha256:[a-f0-9]{64}$'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object')
);
CREATE TABLE __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_metric_totals (
  singleton boolean PRIMARY KEY CHECK (singleton),
  source_count integer NOT NULL CHECK (source_count BETWEEN 0 AND 1000000),
  window_count integer NOT NULL CHECK (window_count BETWEEN 0 AND 1000000),
  state_hash text NOT NULL CHECK (state_hash ~ '^sha256:[a-f0-9]{64}$')
);
CREATE TABLE __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_metric_sources (
  source_kind text NOT NULL CHECK (source_kind IN ('policy','lifecycle')),
  event_ref text NOT NULL CHECK (event_ref ~ '^evt_[a-f0-9]{48}$'),
  event_hash text NOT NULL CHECK (event_hash ~ '^sha256:[a-f0-9]{64}$'),
  tenant_hash text NOT NULL CHECK (tenant_hash ~ '^sha256:[a-f0-9]{64}$'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
  state_hash text NOT NULL CHECK (state_hash ~ '^sha256:[a-f0-9]{64}$'),
  PRIMARY KEY (source_kind,event_ref)
);
CREATE INDEX telemetry_metric_sources_tenant ON __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_metric_sources (tenant_hash);
CREATE TABLE __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_metric_windows (
  tenant_hash text NOT NULL CHECK (tenant_hash ~ '^sha256:[a-f0-9]{64}$'),
  rule_id text NOT NULL CHECK (rule_id IN ('control_disabled','control_failed','lease_expiry_observed','policy_failure','policy_timeout','rate_denied')),
  window_start_ms bigint NOT NULL CHECK (window_start_ms BETWEEN 0 AND 9007199254740991),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
  state_hash text NOT NULL CHECK (state_hash ~ '^sha256:[a-f0-9]{64}$'),
  PRIMARY KEY (tenant_hash,rule_id,window_start_ms)
);
CREATE TABLE __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_metric_alerts (
  event_ref text PRIMARY KEY CHECK (event_ref ~ '^evt_[a-f0-9]{48}$'),
  event_hash text NOT NULL CHECK (event_hash ~ '^sha256:[a-f0-9]{64}$'),
  tenant_hash text NOT NULL CHECK (tenant_hash ~ '^sha256:[a-f0-9]{64}$'),
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
  CHECK ((state='pending' AND claim_hash IS NULL AND lease_expires_ms IS NULL)
    OR (state IN ('claimed','acked') AND claim_hash IS NOT NULL AND lease_expires_ms IS NOT NULL AND generation>0 AND attempts>0)),
  CHECK ((state='acked' AND acknowledged_ms IS NOT NULL AND acknowledgement_hash IS NOT NULL)
    OR (state<>'acked' AND acknowledged_ms IS NULL AND acknowledgement_hash IS NULL))
);
CREATE INDEX telemetry_metric_alerts_pending ON __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_metric_alerts (state,next_attempt_ms,created_ms,event_ref);
CREATE INDEX telemetry_metric_alerts_tenant ON __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_metric_alerts (tenant_hash);
CREATE UNIQUE INDEX telemetry_metric_alerts_active_claim ON __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_metric_alerts (claim_hash) WHERE state='claimed';
