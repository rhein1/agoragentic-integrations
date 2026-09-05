export const MANAGED_SERVICE_SCHEMA =
  'agoragentic.risk-fork.managed-service.v1';
export const MANAGED_INVOCATION_SCHEMA =
  'agoragentic.risk-fork.managed-invocation.v1';
export const MANAGED_AUDIT_EVENT_SCHEMA =
  'agoragentic.risk-fork.managed-audit-event.v1';
export const MANAGED_API_KEY_SCHEMA =
  'agoragentic.risk-fork.managed-api-key.v1';
export const MANAGED_RESOURCE_JOURNAL_RECEIPT_SCHEMA =
  'agoragentic.risk-fork.managed-resource-journal-receipt.v1';

// This source tranche has not passed deployment, provider, or live-traffic
// qualification. Production activation therefore cannot be enabled by config.
export const MANAGED_SERVICE_PRODUCTION_QUALIFIED = false;

// Immutable protocol ceilings are used to normalize an idempotent request
// before looking up an existing result. Runtime policy may be tighter, but a
// restart with tighter policy must not make an exact replay undiscoverable.
export const MANAGED_SERVICE_PROTOCOL_LIMITS = Object.freeze({
  max_request_bytes: 4_194_304,
  max_invocation_cost_micros: 1_000_000_000,
  max_idempotency_key_bytes: 1_024,
  min_lease_ms: 1_000,
  max_lease_ms: 900_000,
});

export const INVOCATION_STATES = Object.freeze([
  'admitted',
  'execution_leased',
  'running',
  'cleanup_pending',
  'recovery_required',
  'completed',
  'failed_closed',
]);

export const ACTIVE_INVOCATION_STATES = Object.freeze([
  'admitted',
  'execution_leased',
  'running',
  'cleanup_pending',
]);

export const TERMINAL_INVOCATION_STATES = Object.freeze([
  'completed',
  'failed_closed',
]);

export const MANAGED_SCOPES = Object.freeze([
  'invocations:write',
  'invocations:read',
  'worker:claim',
  'worker:write',
  'audit:read',
]);

export const DEFAULT_LIMITS = Object.freeze({
  max_request_bytes: 1_048_576,
  max_invocation_cost_micros: 5_000_000,
  daily_budget_micros: 25_000_000,
  max_concurrent_invocations: 4,
  min_lease_ms: 5_000,
  max_lease_ms: 120_000,
  max_invocation_age_ms: 15 * 60_000,
  max_idempotency_key_bytes: 256,
});
