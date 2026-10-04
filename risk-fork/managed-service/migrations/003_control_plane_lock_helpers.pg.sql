-- Owner-executed lock interface for the managed control plane.
-- The runtime role receives EXECUTE only; table UPDATE on tenants and API keys
-- is intentionally not part of the control-plane runtime grant boundary.

CREATE FUNCTION __RISK_FORK_MANAGED_SCHEMA__.lock_managed_tenant_share(p_tenant_id text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_status text;
BEGIN
  SELECT status INTO v_status
    FROM __RISK_FORK_MANAGED_SCHEMA__.managed_tenants
   WHERE tenant_id = p_tenant_id
   FOR SHARE;
  RETURN v_status;
END;
$$;

CREATE FUNCTION __RISK_FORK_MANAGED_SCHEMA__.lock_managed_api_key_share(
  p_tenant_id text,
  p_key_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM 1
    FROM __RISK_FORK_MANAGED_SCHEMA__.managed_api_keys
   WHERE tenant_id = p_tenant_id AND key_id = p_key_id
   FOR SHARE;
  RETURN FOUND;
END;
$$;

CREATE FUNCTION __RISK_FORK_MANAGED_SCHEMA__.lock_managed_tenant_update(p_tenant_id text)
RETURNS TABLE (
  tenant_id text,
  status text,
  daily_budget_micros bigint,
  max_invocation_cost_micros bigint,
  max_concurrent_invocations integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  RETURN QUERY
  SELECT t.tenant_id, t.status, t.daily_budget_micros,
         t.max_invocation_cost_micros, t.max_concurrent_invocations
    FROM __RISK_FORK_MANAGED_SCHEMA__.managed_tenants AS t
   WHERE t.tenant_id = p_tenant_id
   FOR UPDATE;
END;
$$;

REVOKE ALL ON FUNCTION __RISK_FORK_MANAGED_SCHEMA__.lock_managed_tenant_share(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION __RISK_FORK_MANAGED_SCHEMA__.lock_managed_api_key_share(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION __RISK_FORK_MANAGED_SCHEMA__.lock_managed_tenant_update(text) FROM PUBLIC;
