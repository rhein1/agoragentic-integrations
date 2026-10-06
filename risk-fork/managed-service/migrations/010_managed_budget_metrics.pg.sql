-- Explicit version 5 of the independent observer ledger. No settings/custody
-- rewrite, tables, columns or grants. Frozen 005/006/007/009 are unchanged.
ALTER TABLE __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_schema_migrations
  DROP CONSTRAINT telemetry_schema_migrations_version_check;
ALTER TABLE __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_schema_migrations
  ADD CONSTRAINT telemetry_schema_migrations_version_check CHECK (version IN (1,2,3,4,5));
ALTER TABLE __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_metric_windows
  DROP CONSTRAINT telemetry_metric_windows_rule_id_check;
ALTER TABLE __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_metric_windows
  ADD CONSTRAINT telemetry_metric_windows_rule_id_check CHECK (rule_id IN
    ('budget_denied','control_disabled','control_failed','execution_failure_observed','lease_expiry_observed','policy_failure','policy_timeout','rate_denied'));
ALTER TABLE __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_events
  DROP CONSTRAINT telemetry_events_event_check;
ALTER TABLE __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_events
  ADD CONSTRAINT telemetry_events_event_check CHECK (event IN
    ('control_denied','rate_denied','policy_error','policy_allowed','policy_candidate','invocation_budget_denied','daily_budget_denied'));
ALTER TABLE __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_events
  DROP CONSTRAINT telemetry_events_check;
ALTER TABLE __RISK_FORK_TELEMETRY_SCHEMA__.telemetry_events
  ADD CONSTRAINT telemetry_events_check CHECK (
    (event='policy_allowed' AND outcome='allowed' AND status=200)
    OR (event='policy_candidate' AND outcome='candidate' AND status=200)
    OR (event='rate_denied' AND outcome='rate_limited' AND status=429)
    OR (event='control_denied' AND outcome IN ('disabled','failed_closed') AND status=503)
    OR (event='policy_error' AND outcome IN ('failed_closed','timeout') AND status=503)
    OR (event IN ('invocation_budget_denied','daily_budget_denied') AND outcome='budget_limited' AND status=429 AND route_class='admission'));
