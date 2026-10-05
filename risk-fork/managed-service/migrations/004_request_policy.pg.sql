-- Independent request-policy ledger: NOT control-plane migration 004.
CREATE TABLE __RISK_FORK_POLICY_SCHEMA__.request_policy_schema_migrations (
  version integer PRIMARY KEY CHECK (version = 1),
  migration_hash text NOT NULL CHECK (migration_hash ~ '^sha256:[a-f0-9]{64}$')
);
CREATE TABLE __RISK_FORK_POLICY_SCHEMA__.request_policy_control (
  singleton boolean PRIMARY KEY CHECK (singleton),
  enabled boolean NOT NULL DEFAULT false,
  epoch bigint NOT NULL DEFAULT 0 CHECK (epoch BETWEEN 0 AND 9007199254740991),
  policy_hash text NOT NULL CHECK (policy_hash ~ '^sha256:[a-f0-9]{64}$')
);
CREATE TABLE __RISK_FORK_POLICY_SCHEMA__.request_policy_routes (
  route_class text PRIMARY KEY CHECK (route_class IN ('admission', 'execution', 'cleanup', 'recovery', 'read')),
  window_ms integer NOT NULL CHECK (window_ms BETWEEN 1000 AND 3600000),
  per_key integer NOT NULL CHECK (per_key BETWEEN 1 AND 1000000),
  per_tenant integer NOT NULL CHECK (per_tenant BETWEEN 1 AND 1000000),
  max_subjects integer NOT NULL CHECK (max_subjects BETWEEN 2 AND 1000000)
);
CREATE TABLE __RISK_FORK_POLICY_SCHEMA__.request_policy_clock (
  singleton boolean PRIMARY KEY CHECK (singleton),
  last_seen_ms bigint NOT NULL DEFAULT 0 CHECK (last_seen_ms BETWEEN 0 AND 9007199254740991)
);
INSERT INTO __RISK_FORK_POLICY_SCHEMA__.request_policy_clock VALUES (true, 0);
CREATE TABLE __RISK_FORK_POLICY_SCHEMA__.request_policy_subjects (
  route_class text NOT NULL REFERENCES __RISK_FORK_POLICY_SCHEMA__.request_policy_routes(route_class),
  subject_kind text NOT NULL CHECK (subject_kind IN ('key', 'tenant')),
  subject_hash text NOT NULL CHECK (subject_hash ~ '^sha256:[a-f0-9]{64}$'),
  bucket_start_ms bigint NOT NULL CHECK (bucket_start_ms BETWEEN 0 AND 9007199254740991),
  used integer NOT NULL CHECK (used BETWEEN 1 AND 1000000),
  PRIMARY KEY (route_class, subject_kind, subject_hash)
);
CREATE FUNCTION __RISK_FORK_POLICY_SCHEMA__.guard_request_policy_control()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $policy_guard$
BEGIN
  IF NEW.singleton IS DISTINCT FROM OLD.singleton
     OR NEW.policy_hash IS DISTINCT FROM OLD.policy_hash
     OR NEW.epoch <> OLD.epoch + 1 THEN
    RAISE EXCEPTION 'request policy control update must advance the epoch exactly once';
  END IF;
  RETURN NEW;
END;
$policy_guard$;
REVOKE ALL ON FUNCTION __RISK_FORK_POLICY_SCHEMA__.guard_request_policy_control() FROM PUBLIC;
CREATE TRIGGER request_policy_control_epoch BEFORE UPDATE
ON __RISK_FORK_POLICY_SCHEMA__.request_policy_control FOR EACH ROW
EXECUTE FUNCTION __RISK_FORK_POLICY_SCHEMA__.guard_request_policy_control();
