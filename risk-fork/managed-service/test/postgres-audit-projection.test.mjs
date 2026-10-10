import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { sha256Ref } from '../../src/canonical.mjs';
import {
  createPostgresAuthorityPool,
  quotePostgresAuthorityIdentifier,
} from '../../src/adapters/postgres-authority-migrator.mjs';
import { createManagedAuthenticator, hashManagedApiKey } from '../src/auth.mjs';
import { verifyManagedAuditWindow } from '../src/audit.mjs';
import { createManagedServiceConfig } from '../src/config.mjs';
import { createManagedRiskForkControlPlane } from '../src/control-plane.mjs';
import { migrateManagedServicePostgres } from '../src/postgres-migrator.mjs';
import { PostgresManagedServiceStore } from '../src/postgres-store.mjs';
import { createManagedProviderRegistry } from '../src/provider-registry.mjs';
import {
  invocationRequest,
  OTHER_TOKEN,
  TestProvider,
  TEST_TOKEN,
  createStablePostgresClock,
} from './helpers.mjs';

const connectionString = process.env.RISK_FORK_MANAGED_TEST_POSTGRES_URL ?? null;
const disposableConfirmation =
  process.env.RISK_FORK_MANAGED_TEST_CONFIRM_DISPOSABLE === 'YES_DELETE_DATA';
const postgresRequired = process.env.RISK_FORK_MANAGED_REQUIRE_POSTGRES_TESTS === '1';

function postgresSkipReason() {
  if (connectionString === null) return 'RISK_FORK_MANAGED_TEST_POSTGRES_URL is not configured';
  let url;
  try { url = new URL(connectionString); } catch { return 'PostgreSQL test URL is invalid'; }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.pathname !== '/risk_fork_managed_test') {
    return 'PostgreSQL integration tests require the loopback risk_fork_managed_test database';
  }
  if (!disposableConfirmation) {
    return 'RISK_FORK_MANAGED_TEST_CONFIRM_DISPOSABLE=YES_DELETE_DATA is required';
  }
  return false;
}

const skipReason = postgresSkipReason();
if (postgresRequired && skipReason !== false) {
  throw new Error(`Mandatory managed PostgreSQL test is unavailable: ${skipReason}`);
}

const scopes = [
  'audit:read', 'invocations:read', 'invocations:write',
  'worker:execution:claim', 'worker:execution:write',
  'worker:cleanup:claim', 'worker:cleanup:write',
  'worker:recovery:claim', 'worker:recovery:write',
];

async function fixture(t, clockOptions = {}) {
  const schemaName = `risk_fork_audit_projection_${randomUUID().replaceAll('-', '')}`;
  const schema = quotePostgresAuthorityIdentifier(schemaName);
  const rawPool = await createPostgresAuthorityPool({
    connectionString,
    requireTls: false,
    maxConnections: 8,
    applicationName: 'risk-fork-managed-audit-projection-test',
  });
  t.after(async () => {
    try { await rawPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
    finally { await rawPool.end(); }
  });
  await migrateManagedServicePostgres({ pool: rawPool, schemaName, requireTls: false });
  const stableClock = await createStablePostgresClock(rawPool, schemaName, clockOptions);
  const pool = stableClock.pool;
  await pool.query(`INSERT INTO ${schema}.managed_tenants
    (tenant_id, status, daily_budget_micros, max_invocation_cost_micros, max_concurrent_invocations)
    VALUES ('tenant_alpha', 'active', 1000000, 500000, 16),
           ('tenant_other', 'active', 1000000, 500000, 16)`);
  const credentials = [
    ['key_alpha', 'tenant_alpha', TEST_TOKEN],
    ['key_other', 'tenant_other', OTHER_TOKEN],
  ];
  for (const [keyId, tenantId, token] of credentials) {
    await pool.query(`INSERT INTO ${schema}.managed_api_keys
      (key_hash, key_id, tenant_id, scopes, not_before, expires_at)
      VALUES ($1, $2, $3, $4::jsonb, clock_timestamp() - interval '1 minute',
              clock_timestamp() + interval '1 hour')`,
    [hashManagedApiKey(token), keyId, tenantId, JSON.stringify(scopes)]);
  }
  const store = new PostgresManagedServiceStore({ pool, schemaName, requireTls: false });
  const providerRegistry = createManagedProviderRegistry([{
    provider: new TestProvider(), enabled: true,
    adapter_digest: sha256Ref({ fixture: 'audit-projection' }),
    qualification_class: 'local_test',
    qualification_receipt_hash: sha256Ref({ fixture: true }),
    tenant_ids: ['tenant_alpha', 'tenant_other'],
    verify_resource_binding: async () => true,
    verify_cleanup_evidence: async () => true,
    verify_recovery_absence: async () => false,
  }]);
  const authenticator = createManagedAuthenticator({ store, clock: stableClock.clock });
  const refs = ['rfi_Z', 'rfi_a', 'rfi_z', 'rfi_A', 'rfi_zz', 'rfi_other'];
  const controlPlane = createManagedRiskForkControlPlane({
    config: createManagedServiceConfig({
      enabled: true,
      environment: 'local_test',
      limits: { max_concurrent_invocations: 16 },
    }),
    store,
    providerRegistry,
    requirePrincipal: authenticator.requirePrincipal,
    clock: stableClock.clock,
    invocationRef: () => refs.shift(),
  });
  const principal = await authenticator.authenticate(`Bearer ${TEST_TOKEN}`, 'invocations:write');
  const otherPrincipal = await authenticator.authenticate(`Bearer ${OTHER_TOKEN}`, 'invocations:write');
  const leaseMs = 120_000;
  return { controlPlane, leaseMs, otherPrincipal, pool, principal, schema, schemaName, store };
}

async function admit(fixture, idempotencyKey, principal = fixture.principal) {
  return fixture.controlPlane.admitInvocation(principal, invocationRequest({
    idempotency_key: idempotencyKey,
    estimated_cost_micros: 0,
  }));
}

test('PostgreSQL audit discovery uses C ordering, a finite upper bound, and a fresh cycle for late refs',
  { skip: skipReason }, async (t) => {
    const f = await fixture(t);
    await admit(f, 'audit-pg-order-1');
    await admit(f, 'audit-pg-order-2');
    await assert.rejects(f.controlPlane.listAuditInvocations(f.principal,
      { upper_ref: 'rfi_Z', limit: 64 }), TypeError);
    const first = await f.controlPlane.listAuditInvocations(f.principal, { limit: 1 });
    assert.equal(first.upper_ref, 'rfi_a');
    assert.deepEqual(first.invocations.map((row) => row.invocation_ref), ['rfi_Z']);
    assert.equal(first.complete, false);

    await admit(f, 'audit-pg-order-3'); // rfi_z, above the pinned upper bound
    await admit(f, 'audit-pg-order-4'); // rfi_A, behind the current cursor
    await admit(f, 'audit-pg-order-5'); // rfi_zz, above the pinned upper bound
    const second = await f.controlPlane.listAuditInvocations(f.principal, {
      after_ref: first.next_after_ref,
      upper_ref: first.upper_ref,
      limit: 1,
    });
    assert.deepEqual(second.invocations.map((row) => row.invocation_ref), ['rfi_a']);
    assert.equal(second.complete, true);

    const fresh = await f.controlPlane.listAuditInvocations(f.principal);
    assert.deepEqual(fresh.invocations.map((row) => row.invocation_ref),
      ['rfi_A', 'rfi_Z', 'rfi_a', 'rfi_z', 'rfi_zz']);
    assert.deepEqual(Object.keys(fresh.invocations[0]).sort(),
      ['audit_event_count', 'audit_head_hash', 'invocation_ref']);
    assert.equal(Object.isFrozen(fresh.invocations[0]), true);
  });

test('PostgreSQL audit windows verify exact continuation and reject checkpoint/hash tampering',
  { skip: skipReason }, async (t) => {
    const f = await fixture(t);
    const admitted = await admit(f, 'audit-pg-window-1');
    const ref = admitted.invocation.invocation_ref;
    const first = await f.controlPlane.readAuditWindow(f.principal, ref, { limit: 1 });
    assert.equal(first.events.length, 1);
    assert.equal(first.complete, true);
    assert.equal(first.next_after_sequence, 1);

    await f.controlPlane.claimExecution(f.principal, {
      invocation_ref: ref,
      lease_token: `lease_audit_projection_${'x'.repeat(48)}`,
      worker_id: 'audit_projection_worker',
      lease_ms: f.leaseMs,
    });
    const second = await f.controlPlane.readAuditWindow(f.principal, ref, {
      after_sequence: first.next_after_sequence,
      prior_event_hash: first.next_prior_event_hash,
      limit: 1,
    });
    assert.equal(second.events.length, 1);
    assert.equal(second.events[0].event_type, 'execution_lease_claimed');
    assert.equal(second.complete, true);
    assert.equal(second.next_after_sequence, 2);

    await assert.rejects(f.controlPlane.readAuditWindow(f.principal, ref, {
      after_sequence: 1,
      prior_event_hash: sha256Ref('tampered checkpoint'),
      limit: 1,
    }));
    await assert.rejects(f.controlPlane.readAuditWindow(f.principal, ref, {
      after_sequence: 99,
      prior_event_hash: second.next_prior_event_hash,
      limit: 1,
    }));
    assert.deepEqual(await f.controlPlane.readAuditWindow(f.principal, ref, {
      after_sequence: first.next_after_sequence,
      prior_event_hash: first.next_prior_event_hash,
      limit: 1,
    }), second);
  });

test('PostgreSQL audit window snapshot is repeatable while a later append commits',
  { skip: skipReason }, async (t) => {
    const f = await fixture(t);
    const admitted = await admit(f, 'audit-pg-snapshot-1');
    const ref = admitted.invocation.invocation_ref;
    let committedDuringRead = false;
    let timeoutObserved = false;
    const barrierStore = new PostgresManagedServiceStore({ schemaName: f.schemaName, requireTls: false,
      pool: { connect: async () => {
        const client = await f.pool.connect();
        return { release: () => client.release(), query: async (sql, values) => {
          const result = await client.query(sql, values);
          if (sql.startsWith('SET LOCAL statement_timeout')) {
            const timeout = await client.query('SHOW statement_timeout');
            assert.equal(timeout.rows[0].statement_timeout, '5s');
            timeoutObserved = true;
          }
          if (!committedDuringRead && sql.startsWith('SELECT audit_event_count, audit_head_hash')) {
            // Commit an actual authority mutation after the actual reader has
            // pinned its snapshot, before it queries following audit events.
            await f.controlPlane.claimExecution(f.principal, { invocation_ref: ref,
              lease_token: `lease_audit_snapshot_${'x'.repeat(48)}`,
              worker_id: 'audit_snapshot_worker', lease_ms: f.leaseMs });
            committedDuringRead = true;
          }
          return result;
        } };
      } },
    });
    const raw = await barrierStore.getAuditWindow('tenant_alpha', ref, { limit: 64 });
    const stable = verifyManagedAuditWindow(raw, { tenant_id: 'tenant_alpha', invocation_ref: ref });
    assert.equal(committedDuringRead, true);
    assert.equal(timeoutObserved, true);
    assert.equal(stable.audit_event_count, 1);
    assert.equal(stable.events.length, 1);
    assert.equal(stable.complete, true);
    const current = await f.controlPlane.readAuditWindow(f.principal, ref, { limit: 64 });
    assert.equal(current.audit_event_count, 2);
    assert.equal(current.events.length, 2);
  });

test('PostgreSQL audit cursors reject int4 overflow and retain the bounded ahead-checkpoint error',
  { skip: skipReason }, async (t) => {
    const f = await fixture(t);
    const admitted = await admit(f, 'audit-pg-int4-boundary');
    const ref = admitted.invocation.invocation_ref;
    const prior = sha256Ref('known prefix');
    await assert.rejects(f.controlPlane.readAuditWindow(f.principal, ref, {
      after_sequence: 2_147_483_647, prior_event_hash: prior,
    }), (error) => /checkpoint is ahead of the source/.test(error.message)
      && error.code !== '22003');
    await assert.rejects(f.controlPlane.readAuditWindow(f.principal, ref, {
      after_sequence: 2_147_483_648, prior_event_hash: prior,
    }), TypeError);
  });

test('PostgreSQL audit projection is tenant-scoped and revocation takes effect before reads',
  { skip: skipReason }, async (t) => {
    const f = await fixture(t);
    const alpha = await admit(f, 'audit-pg-scope-alpha');
    const other = await admit(f, 'audit-pg-scope-other', f.otherPrincipal);
    assert.deepEqual((await f.controlPlane.listAuditInvocations(f.otherPrincipal)).invocations
      .map((row) => row.invocation_ref), [other.invocation.invocation_ref]);
    await assert.rejects(
      f.controlPlane.readAuditWindow(f.otherPrincipal, alpha.invocation.invocation_ref),
      (error) => error.code === 'INVOCATION_NOT_FOUND' && error.status === 404,
    );

    await f.pool.query(`UPDATE ${f.schema}.managed_api_keys
      SET revoked_at = clock_timestamp() WHERE key_id = 'key_alpha'`);
    await assert.rejects(
      f.controlPlane.listAuditInvocations(f.principal),
      (error) => ['AUTHENTICATION_FAILED', 'AUTHORIZATION_DENIED'].includes(error.code),
    );
    await assert.rejects(
      f.controlPlane.readAuditWindow(f.principal, alpha.invocation.invocation_ref),
      (error) => ['AUTHENTICATION_FAILED', 'AUTHORIZATION_DENIED'].includes(error.code),
    );
  });

for (const [label, logicalStart, expectedCode] of [
  ['before midnight', '2026-09-05T23:57:59.999Z', null],
  ['at midnight', '2026-09-05T23:58:00.000Z', null],
  ['after midnight', '2026-09-05T23:58:00.001Z', 'LEASE_CROSSES_BUDGET_DAY'],
]) {
  test(`PostgreSQL execution lease boundary is exact ${label}`, { skip: skipReason }, async (t) => {
    const f = await fixture(t, { logicalStart, advanceClock: false });
    const admitted = await admit(f, `audit-pg-budget-boundary-${label.replaceAll(' ', '-')}`);
    const claim = () => f.controlPlane.claimExecution(f.principal, {
      invocation_ref: admitted.invocation.invocation_ref,
      lease_token: `lease_audit_boundary_${label.replaceAll(' ', '_')}_${'x'.repeat(48)}`,
      worker_id: `audit_boundary_${label.replaceAll(' ', '_')}`,
      lease_ms: f.leaseMs,
    });
    if (expectedCode === null) {
      await claim();
    } else {
      await assert.rejects(claim(), (error) => error.code === expectedCode);
    }
  });
}
