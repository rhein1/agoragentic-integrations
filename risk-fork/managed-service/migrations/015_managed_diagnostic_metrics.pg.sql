-- Explicit v10. Frozen v1-v9 sources/settings/windows remain unchanged.
-- Host boundary unconfirmed-bucket facts reuse the existing metric custody and
-- delivery lane. No recovery/clear inference, new outbox or execution authority.
ALTER TABLE __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_schema_migrations
  DROP CONSTRAINT telemetry_schema_migrations_version_check;
ALTER TABLE __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_schema_migrations
  ADD CONSTRAINT telemetry_schema_migrations_version_check CHECK (version IN (1,2,3,4,5,6,7,8,9,10));
ALTER TABLE __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_metric_sources
  DROP CONSTRAINT telemetry_metric_sources_source_kind_check;
ALTER TABLE __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_metric_sources
  ADD CONSTRAINT telemetry_metric_sources_source_kind_check CHECK (source_kind IN ('policy','lifecycle','diagnostic'));
ALTER TABLE __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_metric_windows
  DROP CONSTRAINT telemetry_metric_windows_rule_id_check;
ALTER TABLE __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_metric_windows
  ADD CONSTRAINT telemetry_metric_windows_rule_id_check CHECK (rule_id IN
    ('budget_denied','cleanup_incomplete_observed','cleanup_verified','control_disabled','control_failed','execution_failure_observed','lease_expiry_observed','policy_failure','policy_timeout','rate_denied','recovery_absence_verified',
     'observer_backlog_gauge_read_unconfirmed','observer_backlog_source_read_unconfirmed','observer_backlog_snapshot_append_unconfirmed',
     'observer_lifecycle_sweep_read_unconfirmed','observer_audit_invocations_read_unconfirmed','observer_lifecycle_checkpoint_read_unconfirmed','observer_audit_window_read_unconfirmed','observer_lifecycle_window_append_unconfirmed'));
CREATE TABLE __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_diagnostic_settings (
  singleton boolean PRIMARY KEY CHECK (singleton),
  settings_hash text NOT NULL CHECK (settings_hash ~ '^sha256:[a-f0-9]{64}$'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object' AND octet_length(payload::text)<=2048)
);
