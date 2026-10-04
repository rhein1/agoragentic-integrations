CREATE TABLE __RISK_FORK_MANAGED_SCHEMA__.managed_worker_delivery_schema_migrations (
  version integer PRIMARY KEY CHECK (version >= 1),
  migration_hash text NOT NULL CHECK (migration_hash ~ '^sha256:[a-f0-9]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE __RISK_FORK_MANAGED_SCHEMA__.managed_worker_delivery_namespaces (
  namespace text PRIMARY KEY CHECK (namespace ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$'),
  max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 10000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION __RISK_FORK_MANAGED_SCHEMA__.protect_managed_worker_delivery_namespace()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
BEGIN
  IF NEW.namespace <> OLD.namespace OR NEW.max_attempts <> OLD.max_attempts
    OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'risk fork worker delivery namespace policy is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER managed_worker_delivery_protect_namespace
  BEFORE UPDATE ON __RISK_FORK_MANAGED_SCHEMA__.managed_worker_delivery_namespaces
  FOR EACH ROW EXECUTE FUNCTION __RISK_FORK_MANAGED_SCHEMA__.protect_managed_worker_delivery_namespace();

CREATE TABLE __RISK_FORK_MANAGED_SCHEMA__.managed_worker_delivery_attempts (
  namespace text NOT NULL CHECK (namespace ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$'),
  attempt_ref text NOT NULL CHECK (attempt_ref ~ '^sha256:[a-f0-9]{64}$'),
  key_id text NOT NULL CHECK (key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$'),
  iv text NOT NULL CHECK (iv ~ '^[A-Za-z0-9_-]+$'),
  ciphertext text NOT NULL CHECK (ciphertext ~ '^[A-Za-z0-9_-]+$'),
  tag text NOT NULL CHECK (tag ~ '^[A-Za-z0-9_-]+$'),
  acknowledged boolean NOT NULL DEFAULT false,
  response_hash text CHECK (response_hash IS NULL OR response_hash ~ '^sha256:[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  acknowledged_at timestamptz,
  PRIMARY KEY (namespace, attempt_ref),
  FOREIGN KEY (namespace) REFERENCES __RISK_FORK_MANAGED_SCHEMA__.managed_worker_delivery_namespaces(namespace),
  CHECK ((acknowledged = false AND response_hash IS NULL AND acknowledged_at IS NULL)
    OR (acknowledged = true AND response_hash IS NOT NULL AND acknowledged_at IS NOT NULL))
);

CREATE FUNCTION __RISK_FORK_MANAGED_SCHEMA__.protect_managed_worker_delivery_record()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
BEGIN
  IF NEW.namespace <> OLD.namespace OR NEW.attempt_ref <> OLD.attempt_ref
    OR NEW.key_id <> OLD.key_id OR NEW.iv <> OLD.iv
    OR NEW.ciphertext <> OLD.ciphertext OR NEW.tag <> OLD.tag
    OR NEW.created_at <> OLD.created_at
    OR (OLD.acknowledged AND (NEW.acknowledged <> OLD.acknowledged
      OR NEW.response_hash <> OLD.response_hash OR NEW.acknowledged_at <> OLD.acknowledged_at))
    OR (NOT OLD.acknowledged AND NEW.acknowledged = false
      AND (NEW.response_hash IS NOT NULL OR NEW.acknowledged_at IS NOT NULL))
    OR (NOT OLD.acknowledged AND NEW.acknowledged = true
      AND NEW.response_hash IS NULL) THEN
    RAISE EXCEPTION 'risk fork worker delivery record is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER managed_worker_delivery_protect_record
  BEFORE UPDATE ON __RISK_FORK_MANAGED_SCHEMA__.managed_worker_delivery_attempts
  FOR EACH ROW EXECUTE FUNCTION __RISK_FORK_MANAGED_SCHEMA__.protect_managed_worker_delivery_record();

CREATE FUNCTION __RISK_FORK_MANAGED_SCHEMA__.reject_managed_worker_delivery_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
BEGIN
  RAISE EXCEPTION 'risk fork worker delivery tombstones are append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER managed_worker_delivery_namespace_no_delete
  BEFORE DELETE ON __RISK_FORK_MANAGED_SCHEMA__.managed_worker_delivery_namespaces
  FOR EACH ROW EXECUTE FUNCTION __RISK_FORK_MANAGED_SCHEMA__.reject_managed_worker_delivery_delete();

CREATE TRIGGER managed_worker_delivery_no_delete
  BEFORE DELETE ON __RISK_FORK_MANAGED_SCHEMA__.managed_worker_delivery_attempts
  FOR EACH ROW EXECUTE FUNCTION __RISK_FORK_MANAGED_SCHEMA__.reject_managed_worker_delivery_delete();

CREATE FUNCTION __RISK_FORK_MANAGED_SCHEMA__.reject_managed_worker_delivery_truncate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
BEGIN
  RAISE EXCEPTION 'risk fork worker delivery tombstones cannot be truncated'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER managed_worker_delivery_no_truncate
  BEFORE TRUNCATE ON __RISK_FORK_MANAGED_SCHEMA__.managed_worker_delivery_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION __RISK_FORK_MANAGED_SCHEMA__.reject_managed_worker_delivery_truncate();

CREATE TRIGGER managed_worker_delivery_namespace_no_truncate
  BEFORE TRUNCATE ON __RISK_FORK_MANAGED_SCHEMA__.managed_worker_delivery_namespaces
  FOR EACH STATEMENT EXECUTE FUNCTION __RISK_FORK_MANAGED_SCHEMA__.reject_managed_worker_delivery_truncate();

REVOKE ALL ON FUNCTION __RISK_FORK_MANAGED_SCHEMA__.protect_managed_worker_delivery_record() FROM PUBLIC;
REVOKE ALL ON FUNCTION __RISK_FORK_MANAGED_SCHEMA__.protect_managed_worker_delivery_namespace() FROM PUBLIC;
REVOKE ALL ON FUNCTION __RISK_FORK_MANAGED_SCHEMA__.reject_managed_worker_delivery_delete() FROM PUBLIC;
REVOKE ALL ON FUNCTION __RISK_FORK_MANAGED_SCHEMA__.reject_managed_worker_delivery_truncate() FROM PUBLIC;
