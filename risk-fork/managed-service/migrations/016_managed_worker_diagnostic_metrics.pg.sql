-- Explicit v11. Frozen v1-v10 settings, source custody and packet meaning remain.
-- No new outbox, effect authority, inferred history, health or recovery clear.
ALTER TABLE __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_schema_migrations
  DROP CONSTRAINT telemetry_schema_migrations_version_check;
ALTER TABLE __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_schema_migrations
  ADD CONSTRAINT telemetry_schema_migrations_version_check CHECK (version IN (1,2,3,4,5,6,7,8,9,10,11));
ALTER TABLE __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_metric_sources
  DROP CONSTRAINT telemetry_metric_sources_source_kind_check;
ALTER TABLE __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_metric_sources
  ADD CONSTRAINT telemetry_metric_sources_source_kind_check CHECK (source_kind IN ('policy','lifecycle','diagnostic','worker_diagnostic'));
ALTER TABLE __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_metric_windows
  DROP CONSTRAINT telemetry_metric_windows_rule_id_check;
ALTER TABLE __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_metric_windows
  ADD CONSTRAINT telemetry_metric_windows_rule_id_check CHECK (rule_id IN
    ('budget_denied','cleanup_incomplete_observed','cleanup_verified','control_disabled','control_failed','execution_failure_observed','lease_expiry_observed','policy_failure','policy_timeout','rate_denied','recovery_absence_verified',
     'observer_backlog_gauge_read_unconfirmed','observer_backlog_source_read_unconfirmed','observer_backlog_snapshot_append_unconfirmed',
     'observer_lifecycle_sweep_read_unconfirmed','observer_audit_invocations_read_unconfirmed','observer_lifecycle_checkpoint_read_unconfirmed','observer_audit_window_read_unconfirmed','observer_lifecycle_window_append_unconfirmed',
     'worker_lease_fence_unconfirmed','worker_cancellation_read_unconfirmed','worker_provider_call_unconfirmed','worker_broker_contract_unconfirmed',
     'worker_resource_journal_unconfirmed','worker_cleanup_completion_unconfirmed','worker_cleanup_incomplete_append_unconfirmed','worker_recovery_lookup_unconfirmed',
     'worker_recovery_absence_completion_unconfirmed','worker_preparation_read_unconfirmed','worker_cost_read_unconfirmed','worker_execution_outcome_unconfirmed'));
CREATE TABLE __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_worker_diagnostic_settings (
  singleton boolean PRIMARY KEY CHECK (singleton),
  settings_hash text NOT NULL CHECK (settings_hash ~ '^sha256:[a-f0-9]{64}$'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object' AND octet_length(payload::text)<=4096)
);
