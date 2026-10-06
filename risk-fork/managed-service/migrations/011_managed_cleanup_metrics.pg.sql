-- Explicit version 6 of the independent observer ledger. No settings/custody
-- rewrite, tables, columns or grants. Frozen 005/006/007/009/010 are unchanged.
ALTER TABLE __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_schema_migrations
  DROP CONSTRAINT telemetry_schema_migrations_version_check;
ALTER TABLE __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_schema_migrations
  ADD CONSTRAINT telemetry_schema_migrations_version_check CHECK (version IN (1,2,3,4,5,6));
ALTER TABLE __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_metric_windows
  DROP CONSTRAINT telemetry_metric_windows_rule_id_check;
ALTER TABLE __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_metric_windows
  ADD CONSTRAINT telemetry_metric_windows_rule_id_check CHECK (rule_id IN
    ('budget_denied','cleanup_verified','control_disabled','control_failed','execution_failure_observed','lease_expiry_observed','policy_failure','policy_timeout','rate_denied','recovery_absence_verified'));
