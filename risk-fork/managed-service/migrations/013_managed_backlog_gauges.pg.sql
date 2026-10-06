-- Explicit version 8 of the existing observer ledger. Latest-state custody
-- only: polls are not lifecycle events, event counters or threshold alerts.
-- Frozen versions 1-7, their settings, counts and delivery rows are unchanged.
ALTER TABLE __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_schema_migrations
  DROP CONSTRAINT telemetry_schema_migrations_version_check;
ALTER TABLE __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_schema_migrations
  ADD CONSTRAINT telemetry_schema_migrations_version_check CHECK (version IN (1,2,3,4,5,6,7,8));
CREATE TABLE __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_backlog_settings (
  singleton boolean PRIMARY KEY CHECK (singleton),
  settings_hash text NOT NULL CHECK (settings_hash ~ '^sha256:[a-f0-9]{64}$'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object' AND octet_length(payload::text)<=1024)
);
CREATE TABLE __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_backlog_state (
  tenant_hash text PRIMARY KEY CHECK (tenant_hash ~ '^sha256:[a-f0-9]{64}$'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object' AND octet_length(payload::text)<=8192),
  state_hash text NOT NULL CHECK (state_hash ~ '^sha256:[a-f0-9]{64}$')
);
CREATE TABLE __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_backlog_totals (
  singleton boolean PRIMARY KEY CHECK (singleton),
  tenant_count integer NOT NULL CHECK (tenant_count BETWEEN 0 AND 10000),
  state_hash text NOT NULL CHECK (state_hash ~ '^sha256:[a-f0-9]{64}$')
);
