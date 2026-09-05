import { sha256Ref } from '../../src/canonical.mjs';
import { RiskForkProvider } from '../../src/provider.mjs';
import { createManagedAuthenticator, hashManagedApiKey } from '../src/auth.mjs';
import { createManagedServiceConfig } from '../src/config.mjs';
import { createManagedRiskForkControlPlane } from '../src/control-plane.mjs';
import { MANAGED_API_KEY_SCHEMA } from '../src/constants.mjs';
import { MemoryManagedServiceStore } from '../src/memory-store.mjs';
import { createManagedProviderRegistry } from '../src/provider-registry.mjs';

export const TEST_TOKEN = `rf_local_fixture_${'a'.repeat(32)}`;
export const OTHER_TOKEN = `rf_local_fixture_${'b'.repeat(32)}`;
export const SAME_TENANT_TOKEN = `rf_local_fixture_${'c'.repeat(32)}`;

export function testLeaseToken(label = 'lease') {
  if (typeof label !== 'string' || !/^[A-Za-z0-9._~-]{1,64}$/.test(label)) {
    throw new TypeError('test lease-token label must be URL-safe');
  }
  return `lease_${label}_${'x'.repeat(48)}`;
}

export class TestProvider extends RiskForkProvider {
  constructor(id = 'local-test-provider') {
    super({
      id,
      capabilities: {
        supports_filesystem_snapshot: true,
        supports_network_policy: true,
        supports_verified_destruction: true,
        supports_hard_ttl: true,
        child_credentials_mode: 'prohibited',
        isolation_class: 'local_test_fixture_only',
        adapter_implementation: 'managed_service_test_fixture',
        mock_conformance: 'local_unit_test',
      },
    });
  }

  async createSavepoint() {}
  async createFork() {}
  async getForkStatus() {}
  async executeInFork() {}
  async collectEvidence() {}
  async collectDiff() {}
  async suspendFork() {}
  async destroyFork() {}
  async verifyDestroyed() {}
  async destroySavepoint() {}
  async verifySavepointDestroyed() {}
}

export async function createFixture(options = {}) {
  let now = options.now ?? '2026-09-05T12:00:00.000Z';
  let refCounter = 0;
  let leaseCounter = 0;
  let nonceCounter = 0;
  let eventCounter = 0;
  const tenant = {
    tenant_id: 'tenant_alpha',
    status: 'active',
    daily_budget_micros: options.dailyBudget ?? 1_000_000,
    max_invocation_cost_micros: options.invocationBudget ?? 500_000,
    max_concurrent_invocations: options.concurrency ?? 4,
  };
  const otherTenant = {
    ...tenant,
    tenant_id: 'tenant_other',
  };
  const credentials = [
    {
      schema: MANAGED_API_KEY_SCHEMA,
      key_id: 'key_alpha',
      tenant_id: tenant.tenant_id,
      key_hash: hashManagedApiKey(TEST_TOKEN),
      scopes: [
        'audit:read',
        'invocations:read',
        'invocations:write',
        'worker:claim',
        'worker:write',
      ],
      not_before: '2026-09-05T00:00:00.000Z',
      expires_at: options.credentialExpiresAt ?? '2026-09-06T00:00:00.000Z',
      revoked_at: null,
    },
    {
      schema: MANAGED_API_KEY_SCHEMA,
      key_id: 'key_other',
      tenant_id: otherTenant.tenant_id,
      key_hash: hashManagedApiKey(OTHER_TOKEN),
      scopes: [
        'audit:read',
        'invocations:read',
        'invocations:write',
        'worker:claim',
        'worker:write',
      ],
      not_before: '2026-09-05T00:00:00.000Z',
      expires_at: options.credentialExpiresAt ?? '2026-09-06T00:00:00.000Z',
      revoked_at: null,
    },
    {
      schema: MANAGED_API_KEY_SCHEMA,
      key_id: 'key_alpha_secondary',
      tenant_id: tenant.tenant_id,
      key_hash: hashManagedApiKey(SAME_TENANT_TOKEN),
      scopes: [
        'audit:read',
        'invocations:read',
        'invocations:write',
        'worker:claim',
        'worker:write',
      ],
      not_before: '2026-09-05T00:00:00.000Z',
      expires_at: options.credentialExpiresAt ?? '2026-09-06T00:00:00.000Z',
      revoked_at: null,
    },
  ];
  const store = new MemoryManagedServiceStore({
    tenants: [tenant, otherTenant],
    credentials,
    eventRef: options.eventRef ?? (() => `evt_${String(++eventCounter).padStart(4, '0')}`),
  });
  const provider = new TestProvider();
  const attestedResourceBindings = new Set();
  const attestedCleanupEvidence = new Set();
  const attestedRecoveryAbsence = new Set();
  const providerRegistry = createManagedProviderRegistry([{
    provider,
    enabled: true,
    adapter_digest: sha256Ref({ adapter: 'managed_service_test_fixture', version: 1 }),
    qualification_class: 'local_test',
    qualification_receipt_hash: sha256Ref({ fixture: true }),
    tenant_ids: [tenant.tenant_id, otherTenant.tenant_id],
    verify_resource_binding: options.verifyResourceBinding ?? (async ({ resources }) => (
      attestedResourceBindings.has(sha256Ref(resources))
    )),
    verify_cleanup_evidence: options.verifyCleanupEvidence ?? (async ({ evidence }) => (
      attestedCleanupEvidence.has(evidence.evidence_hash)
    )),
    verify_recovery_absence: options.verifyRecoveryAbsence ?? (async ({ evidence }) => (
      attestedRecoveryAbsence.has(sha256Ref(evidence))
    )),
  }]);
  const config = createManagedServiceConfig({
    enabled: true,
    environment: 'local_test',
    limits: {
      max_invocation_cost_micros: options.invocationBudget ?? 500_000,
      daily_budget_micros: options.dailyBudget ?? 1_000_000,
      max_concurrent_invocations: options.concurrency ?? 4,
      max_invocation_age_ms: options.maxInvocationAgeMs ?? 15 * 60_000,
    },
  });
  const authenticator = createManagedAuthenticator({
    store,
    clock: () => new Date(now),
  });
  const controlPlane = createManagedRiskForkControlPlane({
    config,
    store,
    providerRegistry,
    requirePrincipal: authenticator.requirePrincipal,
    clock: () => new Date(now),
    invocationRef: options.invocationRef
      ?? (() => `rfi_${String(++refCounter).padStart(4, '0')}`),
    requestNonce: () => `nonce_${String(++nonceCounter).padStart(8, '0')}`,
  });
  const principal = await authenticator.authenticate(
    `Bearer ${TEST_TOKEN}`,
    'invocations:write',
  );
  const otherPrincipal = await authenticator.authenticate(
    `Bearer ${OTHER_TOKEN}`,
    'invocations:write',
  );
  const sameTenantPrincipal = await authenticator.authenticate(
    `Bearer ${SAME_TENANT_TOKEN}`,
    'invocations:write',
  );
  return {
    authenticator,
    attestResourceBinding(invocation, {
      savepoint_ref = null,
      fork_ref = null,
      absent_resource_kinds = [],
    }) {
      attestedResourceBindings.add(sha256Ref({
        provider_recovery_key: invocation.provider_recovery_key,
        savepoint_ref,
        fork_ref,
        absent_resource_kinds: [...absent_resource_kinds].sort(),
      }));
    },
    attestCleanupEvidence(evidence) {
      attestedCleanupEvidence.add(evidence.evidence_hash);
    },
    attestRecoveryAbsence(evidence) {
      attestedRecoveryAbsence.add(sha256Ref(evidence));
    },
    config,
    controlPlane,
    credentials,
    otherPrincipal,
    principal,
    sameTenantPrincipal,
    provider,
    providerRegistry,
    nextLeaseToken(label = 'fixture') {
      leaseCounter += 1;
      return testLeaseToken(`${label}_${String(leaseCounter).padStart(4, '0')}`);
    },
    setNow(value) { now = value; },
    store,
    tenant,
    otherTenant,
  };
}

export function invocationRequest(overrides = {}) {
  return {
    idempotency_key: 'idempotency-key-00000001',
    provider_id: 'local-test-provider',
    operation: {
      kind: 'mcp_tool_call',
      tool_name: 'example.safe_tool',
      arguments: { value: 'bounded input' },
    },
    estimated_cost_micros: 100_000,
    ...overrides,
  };
}
