CREATE TABLE __MCP_HANDLE_SCHEMA__.handle_schema_migrations (
  version integer PRIMARY KEY CHECK (version = 1),
  migration_hash text NOT NULL CHECK (migration_hash ~ '^sha256:[a-f0-9]{64}$')
);
CREATE TABLE __MCP_HANDLE_SCHEMA__.handle_namespaces (
  tenant_ref text NOT NULL,
  key_id text NOT NULL,
  key_fingerprint text NOT NULL CHECK (key_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  max_entries integer NOT NULL CHECK (max_entries BETWEEN 1 AND 100000),
  PRIMARY KEY (tenant_ref, key_id)
);
CREATE TABLE __MCP_HANDLE_SCHEMA__.portable_handles (
  tenant_ref text NOT NULL,
  key_id text NOT NULL,
  handle_hash text NOT NULL CHECK (handle_hash ~ '^sha256:[a-f0-9]{64}$'),
  binding jsonb NOT NULL CHECK (jsonb_typeof(binding) = 'object'),
  expires_at timestamptz NOT NULL,
  max_consumptions integer NOT NULL CHECK (max_consumptions BETWEEN 1 AND 1000),
  consumption_count integer NOT NULL DEFAULT 0
    CHECK (consumption_count BETWEEN 0 AND max_consumptions),
  revoked_at timestamptz,
  PRIMARY KEY (tenant_ref, key_id, handle_hash),
  FOREIGN KEY (tenant_ref, key_id)
    REFERENCES __MCP_HANDLE_SCHEMA__.handle_namespaces (tenant_ref, key_id)
);
CREATE TABLE __MCP_HANDLE_SCHEMA__.handle_consumptions (
  tenant_ref text NOT NULL,
  key_id text NOT NULL,
  handle_hash text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^sha256:[a-f0-9]{64}$'),
  authorization_receipt jsonb NOT NULL CHECK (jsonb_typeof(authorization_receipt) = 'object'),
  consumed_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_ref, key_id, handle_hash, request_hash),
  FOREIGN KEY (tenant_ref, key_id, handle_hash)
    REFERENCES __MCP_HANDLE_SCHEMA__.portable_handles (tenant_ref, key_id, handle_hash)
);
CREATE FUNCTION __MCP_HANDLE_SCHEMA__.reject_handle_history_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'MCP handle consumption history is append-only' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER handle_consumptions_immutable
  BEFORE UPDATE OR DELETE ON __MCP_HANDLE_SCHEMA__.handle_consumptions
  FOR EACH ROW EXECUTE FUNCTION __MCP_HANDLE_SCHEMA__.reject_handle_history_mutation();
CREATE TRIGGER handle_consumptions_no_truncate
  BEFORE TRUNCATE ON __MCP_HANDLE_SCHEMA__.handle_consumptions
  FOR EACH STATEMENT EXECUTE FUNCTION __MCP_HANDLE_SCHEMA__.reject_handle_history_mutation();
CREATE TRIGGER handle_namespaces_immutable
  BEFORE UPDATE OR DELETE ON __MCP_HANDLE_SCHEMA__.handle_namespaces
  FOR EACH ROW EXECUTE FUNCTION __MCP_HANDLE_SCHEMA__.reject_handle_history_mutation();
CREATE TRIGGER handle_namespaces_no_truncate
  BEFORE TRUNCATE ON __MCP_HANDLE_SCHEMA__.handle_namespaces
  FOR EACH STATEMENT EXECUTE FUNCTION __MCP_HANDLE_SCHEMA__.reject_handle_history_mutation();
CREATE TRIGGER handle_migrations_immutable
  BEFORE UPDATE OR DELETE ON __MCP_HANDLE_SCHEMA__.handle_schema_migrations
  FOR EACH ROW EXECUTE FUNCTION __MCP_HANDLE_SCHEMA__.reject_handle_history_mutation();
CREATE TRIGGER handle_migrations_no_truncate
  BEFORE TRUNCATE ON __MCP_HANDLE_SCHEMA__.handle_schema_migrations
  FOR EACH STATEMENT EXECUTE FUNCTION __MCP_HANDLE_SCHEMA__.reject_handle_history_mutation();
CREATE FUNCTION __MCP_HANDLE_SCHEMA__.protect_handle_binding()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'MCP handle tombstones cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF (NEW.tenant_ref, NEW.key_id, NEW.handle_hash, NEW.binding, NEW.expires_at, NEW.max_consumptions)
     IS DISTINCT FROM
     (OLD.tenant_ref, OLD.key_id, OLD.handle_hash, OLD.binding, OLD.expires_at, OLD.max_consumptions)
     OR NEW.consumption_count NOT IN (OLD.consumption_count, OLD.consumption_count + 1)
     OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'MCP handle binding identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER portable_handle_binding_immutable
  BEFORE UPDATE OR DELETE ON __MCP_HANDLE_SCHEMA__.portable_handles
  FOR EACH ROW EXECUTE FUNCTION __MCP_HANDLE_SCHEMA__.protect_handle_binding();
CREATE TRIGGER portable_handles_no_truncate
  BEFORE TRUNCATE ON __MCP_HANDLE_SCHEMA__.portable_handles
  FOR EACH STATEMENT EXECUTE FUNCTION __MCP_HANDLE_SCHEMA__.reject_handle_history_mutation();
