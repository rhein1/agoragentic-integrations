-- Explicit version 7 of the independent observer ledger. Only exact recorded
-- incomplete attempts; no diagnosis, state/settings/custody or privilege change.
-- Frozen 005/006/007/009/010/011 remain unchanged.
ALTER TABLE __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_schema_migrations
  DROP CONSTRAINT telemetry_schema_migrations_version_check;
ALTER TABLE __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_schema_migrations
  ADD CONSTRAINT telemetry_schema_migrations_version_check CHECK (version IN (1,2,3,4,5,6,7));
ALTER TABLE __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_metric_windows
  DROP CONSTRAINT telemetry_metric_windows_rule_id_check;
ALTER TABLE __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_metric_windows
  ADD CONSTRAINT telemetry_metric_windows_rule_id_check CHECK (rule_id IN
    ('budget_denied','cleanup_incomplete_observed','cleanup_verified','control_disabled','control_failed','execution_failure_observed','lease_expiry_observed','policy_failure','policy_timeout','rate_denied','recovery_absence_verified'));
