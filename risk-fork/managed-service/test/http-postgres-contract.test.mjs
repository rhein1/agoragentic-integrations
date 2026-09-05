import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { sha256Ref } from '../../src/canonical.mjs';
import { createManagedServiceHttpHandler } from '../src/http-handler.mjs';
import {
  createManagedResourceJournalReceipt,
  managedClientRequestHash,
  managedProviderRecoveryKey,
  managedResourceJournalRequestHash,
} from '../src/invocation-integrity.mjs';
import { PostgresManagedServiceStore } from '../src/postgres-store.mjs';
import { createFixture, invocationRequest, TEST_TOKEN } from './helpers.mjs';

function postgresInvocationRow(overrides = {}) {
  const admittedAt = '2026-09-05T12:00:00.000Z';
  const row = {
    tenant_id: 'tenant_alpha',
    invocation_ref: 'rfi_clock_test',
    admitted_key_id: 'key_alpha',
    provider_id: 'local-test-provider',
    provider_binding_hash: sha256Ref({ provider_binding: true }),
    provider_adapter_digest: sha256Ref({ provider_adapter: true }),
    provider_qualification_receipt_hash: sha256Ref({ provider_qualification: true }),
    idempotency_hash: sha256Ref({ idempotency: true }),
    operation_json: { kind: 'mcp_tool_call', tool_name: 'example.safe_tool', arguments: {} },
    estimated_cost_micros: 0,
    actual_cost_micros: null,
    budget_day_utc: '2026-09-05',
    state: 'admitted',
    lease_kind: null,
    lease_owner: null,
    lease_token_hash: null,
    lease_claim_audit_hash: null,
    lease_expires_at: null,
    lease_generation: 0,
    savepoint_ref: null,
    fork_ref: null,
    cleanup_requests: [],
    execution_outcome: null,
    execution_evidence_hash: null,
    result_hash: null,
    admitted_at: admittedAt,
    updated_at: admittedAt,
    terminal_at: null,
    audit_head_hash: sha256Ref({ audit_head: true }),
    audit_event_count: 1,
    ...overrides,
  };
  row.operation_hash = Object.hasOwn(overrides, 'operation_hash')
    ? overrides.operation_hash
    : sha256Ref(row.operation_json);
  row.request_hash = Object.hasOwn(overrides, 'request_hash')
    ? overrides.request_hash
    : managedClientRequestHash({
      providerId: row.provider_id,
      operation: row.operation_json,
      estimatedCostMicros: row.estimated_cost_micros,
    });
  row.provider_recovery_key = Object.hasOwn(overrides, 'provider_recovery_key')
    ? overrides.provider_recovery_key
    : managedProviderRecoveryKey({
      tenantId: row.tenant_id,
      idempotencyHash: row.idempotency_hash,
      providerBindingHash: row.provider_binding_hash,
    });
  return row;
}

test('HTTP adapter reports bounded truth and enforces auth before tenant routes', async () => {
  const fixture = await createFixture();
  const handle = createManagedServiceHttpHandler({
    controlPlane: fixture.controlPlane,
    authenticator: fixture.authenticator,
  });
  const health = await handle({ method: 'GET', path: '/healthz', headers: {} });
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, {
    alive: true,
    deployed: false,
    live_traffic_protected: false,
  });
  const unauthorized = await handle({
    method: 'POST',
    path: '/v1/invocations',
    headers: {},
    body: JSON.stringify(invocationRequest()),
  });
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.body.error.code, 'AUTHENTICATION_REQUIRED');
  const created = await handle({
    method: 'POST',
    path: '/v1/invocations',
    headers: {
      Authorization: `Bearer ${TEST_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(invocationRequest()),
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.invocation.tenant_id, 'tenant_alpha');
  assert.equal(created.body.invocation.state, 'admitted');
  assert.equal(created.headers['cache-control'], 'no-store');
  const ambiguousWorkerTarget = await handle({
    method: 'POST',
    path: `/internal/v1/invocations/${created.body.invocation.invocation_ref}/claim-execution`,
    headers: {
      Authorization: `Bearer ${TEST_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      invocation_ref: 'rfi_body_target',
      worker_id: 'worker_http',
      lease_ms: 5_000,
    }),
  });
  assert.equal(ambiguousWorkerTarget.status, 400);
  assert.equal(ambiguousWorkerTarget.body.error.code, 'AMBIGUOUS_INVOCATION_TARGET');
  assert.equal((await fixture.controlPlane.getInvocation(
    fixture.principal,
    created.body.invocation.invocation_ref,
  )).state, 'admitted');
  const reflectedField = await handle({
    method: 'POST',
    path: '/v1/invocations',
    headers: {
      Authorization: `Bearer ${TEST_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ...invocationRequest({ idempotency_key: 'idempotency-key-00000002' }),
      'credential-shaped-field-do-not-reflect': true,
    }),
  });
  assert.equal(reflectedField.status, 400);
  assert.equal(reflectedField.body.error.message, 'invocation request contains an unsupported field');
  assert.doesNotMatch(reflectedField.body.error.message, /credential-shaped/);
});

test('HTTP claim retries recover a lost response once without extending authority', async () => {
  const fixture = await createFixture();
  const handle = createManagedServiceHttpHandler({
    controlPlane: fixture.controlPlane,
    authenticator: fixture.authenticator,
  });
  const headers = {
    Authorization: `Bearer ${TEST_TOKEN}`,
    'Content-Type': 'application/json',
  };
  const created = await handle({
    method: 'POST',
    path: '/v1/invocations',
    headers,
    body: JSON.stringify(invocationRequest()),
  });
  assert.equal(created.status, 201);
  const invocationRef = created.body.invocation.invocation_ref;
  const leaseToken = fixture.nextLeaseToken('http_lost_response');
  const request = {
    lease_token: leaseToken,
    worker_id: 'worker_http_lost_response',
    lease_ms: 10_000,
  };
  const first = await handle({
    method: 'POST',
    path: `/internal/v1/invocations/${invocationRef}/claim-execution`,
    headers,
    body: JSON.stringify(request),
  });
  const recovered = await handle({
    method: 'POST',
    path: `/internal/v1/invocations/${invocationRef}/claim-execution`,
    headers,
    body: JSON.stringify(request),
  });
  assert.equal(first.status, 200);
  assert.equal(recovered.status, 200);
  assert.equal(first.headers['cache-control'], 'no-store');
  assert.equal(recovered.headers['cache-control'], 'no-store');
  assert.equal(first.body.claim_replayed, false);
  assert.equal(recovered.body.claim_replayed, true);
  assert.equal(recovered.body.lease_token, leaseToken);
  assert.deepEqual(recovered.body.invocation, first.body.invocation);
  const events = await fixture.controlPlane.listAuditEvents(fixture.principal, invocationRef);
  assert.equal(events.filter((event) => event.event_type === 'execution_lease_claimed').length, 1);

  const concurrentAdmission = await handle({
    method: 'POST',
    path: '/v1/invocations',
    headers,
    body: JSON.stringify(invocationRequest({
      idempotency_key: 'idempotency-key-http-concurrent-0002',
    })),
  });
  const concurrentRef = concurrentAdmission.body.invocation.invocation_ref;
  const concurrentToken = fixture.nextLeaseToken('http_concurrent');
  const concurrentRequest = {
    lease_token: concurrentToken,
    worker_id: 'worker_http_concurrent',
    lease_ms: 10_000,
  };
  const concurrent = await Promise.all([1, 2].map(() => handle({
    method: 'POST',
    path: `/internal/v1/invocations/${concurrentRef}/claim-execution`,
    headers,
    body: JSON.stringify(concurrentRequest),
  })));
  assert.deepEqual(concurrent.map((response) => response.status), [200, 200]);
  assert.deepEqual(
    concurrent.map((response) => response.body.claim_replayed).sort(),
    [false, true],
  );
  assert.deepEqual(concurrent[0].body.invocation, concurrent[1].body.invocation);
  assert.equal((await fixture.controlPlane.listAuditEvents(
    fixture.principal,
    concurrentRef,
  )).filter((event) => event.event_type === 'execution_lease_claimed').length, 1);
});

test('HTTP rejects tenant-wide lease-token reuse across invocation routes', async () => {
  const fixture = await createFixture();
  const handle = createManagedServiceHttpHandler({
    controlPlane: fixture.controlPlane,
    authenticator: fixture.authenticator,
  });
  const headers = {
    Authorization: `Bearer ${TEST_TOKEN}`,
    'Content-Type': 'application/json',
  };
  const admissions = await Promise.all([1, 2].map((index) => handle({
    method: 'POST',
    path: '/v1/invocations',
    headers,
    body: JSON.stringify(invocationRequest({
      idempotency_key: `idempotency-key-http-token-reuse-000${index}`,
    })),
  })));
  const leaseToken = fixture.nextLeaseToken('http_tenant_wide');
  const claimBody = JSON.stringify({
    lease_token: leaseToken,
    worker_id: 'worker_http_tenant_wide',
    lease_ms: 10_000,
  });
  const first = await handle({
    method: 'POST',
    path: `/internal/v1/invocations/${admissions[0].body.invocation.invocation_ref}/claim-execution`,
    headers,
    body: claimBody,
  });
  const rejected = await handle({
    method: 'POST',
    path: `/internal/v1/invocations/${admissions[1].body.invocation.invocation_ref}/claim-execution`,
    headers,
    body: claimBody,
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.claim_replayed, false);
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.error.code, 'LEASE_TOKEN_REPLAYED');
  assert.equal(JSON.stringify(rejected.body).includes(leaseToken), false);
});

test('HTTP resource journal retries converge on one durable response and audit mutation', async () => {
  let verifierCalls = 0;
  const fixture = await createFixture({
    verifyResourceBinding: async () => {
      verifierCalls += 1;
      return true;
    },
  });
  const handle = createManagedServiceHttpHandler({
    controlPlane: fixture.controlPlane,
    authenticator: fixture.authenticator,
  });
  const headers = {
    Authorization: `Bearer ${TEST_TOKEN}`,
    'Content-Type': 'application/json',
  };
  const admitted = await handle({
    method: 'POST',
    path: '/v1/invocations',
    headers,
    body: JSON.stringify(invocationRequest()),
  });
  const invocationRef = admitted.body.invocation.invocation_ref;
  const claim = await handle({
    method: 'POST',
    path: `/internal/v1/invocations/${invocationRef}/claim-execution`,
    headers,
    body: JSON.stringify({
      lease_token: fixture.nextLeaseToken('http_journal_receipt'),
      worker_id: 'worker_http_journal_receipt',
      lease_ms: 30_000,
    }),
  });
  const resourcePath = `/internal/v1/invocations/${invocationRef}/resources`;
  const partialBody = JSON.stringify({
    lease_token: claim.body.lease_token,
    savepoint_ref: 'savepoint_http_journal_receipt',
  });
  const partial = await Promise.all([1, 2].map(() => handle({
    method: 'POST',
    path: resourcePath,
    headers,
    body: partialBody,
  })));
  assert.deepEqual(partial.map((result) => result.status), [200, 200]);
  assert.deepEqual(partial[0].body, partial[1].body);
  const verifierCallsAfterConcurrent = verifierCalls;
  const partialReplay = await handle({
    method: 'POST',
    path: resourcePath,
    headers,
    body: partialBody,
  });
  assert.equal(partialReplay.status, 200);
  assert.deepEqual(partialReplay.body, partial[0].body);
  assert.equal(verifierCalls, verifierCallsAfterConcurrent);

  const completeBody = JSON.stringify({
    lease_token: claim.body.lease_token,
    savepoint_ref: 'savepoint_http_journal_receipt',
    fork_ref: 'fork_http_journal_receipt',
  });
  const complete = await handle({
    method: 'POST',
    path: resourcePath,
    headers,
    body: completeBody,
  });
  const verifierCallsAfterComplete = verifierCalls;
  const completeReplay = await handle({
    method: 'POST',
    path: resourcePath,
    headers,
    body: completeBody,
  });
  assert.equal(complete.status, 200);
  assert.equal(complete.body.state, 'running');
  assert.deepEqual(completeReplay, complete);
  assert.equal(verifierCalls, verifierCallsAfterComplete);
  const events = await fixture.controlPlane.listAuditEvents(fixture.principal, invocationRef);
  assert.equal(events.filter((event) => event.event_type === 'provider_resource_journaled').length, 1);
  assert.equal(events.filter((event) => event.event_type === 'provider_resources_recorded').length, 1);
});

test('HTTP claim tokens are required, bounded, URL-safe, and never reflected on errors', async () => {
  const fixture = await createFixture();
  const handle = createManagedServiceHttpHandler({
    controlPlane: fixture.controlPlane,
    authenticator: fixture.authenticator,
  });
  const headers = {
    Authorization: `Bearer ${TEST_TOKEN}`,
    'Content-Type': 'application/json',
  };
  const created = await handle({
    method: 'POST',
    path: '/v1/invocations',
    headers,
    body: JSON.stringify(invocationRequest()),
  });
  const invocationRef = created.body.invocation.invocation_ref;
  const invalidTokens = [undefined, 'x'.repeat(31), `${'x'.repeat(31)}!`, 'x'.repeat(513)];
  for (const leaseToken of invalidTokens) {
    const body = {
      worker_id: 'worker_http_invalid_token',
      lease_ms: 10_000,
    };
    if (leaseToken !== undefined) body.lease_token = leaseToken;
    const response = await handle({
      method: 'POST',
      path: `/internal/v1/invocations/${invocationRef}/claim-execution`,
      headers,
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 400);
    if (leaseToken !== undefined) {
      assert.equal(JSON.stringify(response.body).includes(leaseToken), false);
    }
  }
  assert.equal((await fixture.controlPlane.getInvocation(
    fixture.principal,
    invocationRef,
  )).state, 'admitted');
});

test('health liveness remains dependency-free when readiness dependencies fail', async () => {
  const fixture = await createFixture();
  let healthCalls = 0;
  const handle = createManagedServiceHttpHandler({
    controlPlane: {
      async health() {
        healthCalls += 1;
        throw new Error('simulated dependency failure');
      },
    },
    authenticator: fixture.authenticator,
  });
  const liveness = await handle({ method: 'GET', path: '/healthz', headers: {} });
  assert.deepEqual(liveness, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
    body: {
      alive: true,
      deployed: false,
      live_traffic_protected: false,
    },
  });
  assert.equal(healthCalls, 0);
  const readiness = await handle({ method: 'GET', path: '/readyz', headers: {} });
  assert.equal(readiness.status, 500);
  assert.equal(readiness.body.error.code, 'INTERNAL_ERROR');
  assert.equal(healthCalls, 1);
});

test('PostgreSQL source schema binds tenant state, hashes credentials, and makes audits append-only', async () => {
  const migration = await readFile(
    new URL('../migrations/001_managed_control_plane.pg.sql', import.meta.url),
    'utf8',
  );
  const store = await readFile(new URL('../src/postgres-store.mjs', import.meta.url), 'utf8');
  assert.match(migration, /key_hash text PRIMARY KEY/);
  assert.doesNotMatch(migration, /(?:api_key|token_value|secret_value) text/i);
  assert.match(migration, /PRIMARY KEY \(tenant_id, invocation_ref\)/);
  assert.match(migration, /UNIQUE \(tenant_id, idempotency_hash\)/);
  assert.match(migration, /lease_claim_audit_hash text CHECK/);
  assert.match(migration, /CREATE TABLE .*managed_lease_token_uses/);
  assert.match(migration, /PRIMARY KEY \(tenant_id, lease_token_hash\)/);
  assert.match(migration, /CREATE TABLE .*managed_resource_journal_receipts/);
  assert.match(migration, /response_json jsonb NOT NULL/);
  assert.match(migration, /response_hash text NOT NULL CHECK/);
  assert.match(migration, /PRIMARY KEY \(tenant_id, invocation_ref, request_hash\)/);
  assert.match(migration, /managed_audit_events_no_update/);
  assert.match(migration, /managed_audit_events_no_delete/);
  assert.match(migration, /reserved_micros bigint NOT NULL/);
  assert.match(store, /WHERE tenant_id = \$1 AND invocation_ref = \$2/g);
  assert.doesNotMatch(store, /SELECT \* FROM .*managed_invocations\s+WHERE invocation_ref = \$1/);
  assert.match(store, /WITH lease_clock AS[\s\S]*lease_expires_at > lease_clock\.now/);
  assert.match(store, /managed_api_keys AS claimant[\s\S]*claimant\.key_id = \$5[\s\S]*claimant\.tenant_id = \$1/);
  assert.match(store, /WITH lease_clock AS[\s\S]*target\.lease_owner = \$5[\s\S]*claimant\.expires_at > lease_clock\.now/);
  assert.match(store, /WITH transition_clock AS[\s\S]*target\.lease_owner = \$13[\s\S]*claimant\.expires_at > transition_clock\.now/);
  assert.match(store, /WITH outcome_clock AS[\s\S]*target\.lease_owner = \$7[\s\S]*claimant\.expires_at > outcome_clock\.now/);
});

test('PostgreSQL health probe is local-pool injectable and reports durability truth', async () => {
  let released = false;
  let migrationCount = 1;
  const migrationHash = sha256Ref((await readFile(
    new URL('../migrations/001_managed_control_plane.pg.sql', import.meta.url),
    'utf8',
  )).replace(/\r\n?/g, '\n'));
  const pool = {
    async connect() {
      return {
        async query(sql) {
          if (sql.includes('information_schema.tables')) {
            return {
              rowCount: 1,
              rows: [{
                table_count: 8,
                trigger_count: 2,
                fsync: 'on',
                synchronous_commit: 'on',
                session_replication_role: 'origin',
              }],
            };
          }
          assert.match(sql, /managed_schema_migrations/);
          return {
            rowCount: 1,
            rows: [{
              migration_hash: migrationHash,
              migration_count: migrationCount,
              recovery_required_count: 0,
              expired_execution_lease_count: 0,
            }],
          };
        },
        release() { released = true; },
      };
    },
  };
  const store = new PostgresManagedServiceStore({
    pool,
    requireTls: false,
  });
  const health = await store.health();
  assert.deepEqual(health, {
    ready: true,
    backend: 'postgresql',
    durable: true,
    tls_required: false,
    tls_ca_validated: false,
    catalog_verified: true,
    migration_verified: true,
    migration_count: 1,
    recovery_required_count: 0,
    expired_execution_lease_count: 0,
  });
  assert.equal(released, true);
  migrationCount = 2;
  const unreviewedMigration = await store.health();
  assert.equal(unreviewedMigration.ready, false);
  assert.equal(unreviewedMigration.migration_verified, false);
  assert.equal(unreviewedMigration.migration_count, 2);
  assert.throws(
    () => new PostgresManagedServiceStore({ pool, requireTls: true }),
    (error) => error.code === 'MANAGED_POSTGRES_TLS_POOL_UNTRUSTED',
  );
});

test('PostgreSQL provider obligations reject non-boolean aggregate results', async () => {
  const pool = {
    async connect() {
      return {
        async query() {
          return {
            rowCount: 1,
            rows: [{
              tenant_id: 'tenant_alpha',
              provider_id: 'local-test-provider',
              provider_binding_hash: sha256Ref({ provider_binding: true }),
              requires_enabled: 'false',
            }],
          };
        },
        release() {},
      };
    },
  };
  const store = new PostgresManagedServiceStore({ pool, requireTls: false });
  await assert.rejects(
    store.providerBindingObligations(),
    /requires_enabled must be boolean/,
  );
});

test('PostgreSQL credential lookup fails closed on database-clock eligibility', async () => {
  let lookupSql = null;
  const pool = {
    async connect() {
      return {
        async query(sql) {
          lookupSql = sql;
          const hasDatabaseEligibility = /revoked_at IS NULL/.test(sql)
            && /not_before <= clock_timestamp\(\)/.test(sql)
            && /expires_at > clock_timestamp\(\)/.test(sql);
          if (hasDatabaseEligibility) return { rowCount: 0, rows: [] };
          return {
            rowCount: 1,
            rows: [{
              key_id: 'expired_key',
              tenant_id: 'tenant_alpha',
              key_hash: sha256Ref({ expired_key: true }),
              scopes: ['audit:read'],
              not_before: '2026-09-04T00:00:00.000Z',
              expires_at: '2026-09-05T00:00:00.000Z',
              revoked_at: null,
            }],
          };
        },
        release() {},
      };
    },
  };
  const store = new PostgresManagedServiceStore({ pool, requireTls: false });
  assert.equal(await store.resolveCredential(sha256Ref({ expired_key: true })), null);
  assert.match(lookupSql, /revoked_at IS NULL/);
});

test('PostgreSQL validates caller clock before locks and refreshes DB time after lock wait', async () => {
  const initialNow = '2026-09-05T12:00:00.000Z';
  const afterLockNow = '2026-09-05T12:00:06.000Z';
  const order = [];
  let clockCalls = 0;
  let auditInsertSql = '';
  const initialRow = postgresInvocationRow();
  const updatedRow = postgresInvocationRow({
    state: 'execution_leased',
    lease_kind: 'execution',
    lease_owner: 'key_alpha',
    lease_token_hash: sha256Ref({ lease: true }),
    lease_expires_at: '2026-09-05T12:00:11.000Z',
    lease_generation: 1,
    updated_at: afterLockNow,
  });
  const pool = {
    async connect() {
      return {
        async query(sql) {
          if (sql.startsWith('BEGIN') || sql.startsWith('SET LOCAL')
            || sql === 'COMMIT' || sql === 'ROLLBACK') {
            return { rowCount: 0, rows: [] };
          }
          if (sql === 'SELECT clock_timestamp() AS managed_now') {
            clockCalls += 1;
            order.push(`clock:${clockCalls}`);
            return {
              rowCount: 1,
              rows: [{ managed_now: clockCalls === 1 ? initialNow : afterLockNow }],
            };
          }
          if (/managed_tenants.*FOR SHARE/s.test(sql)) {
            order.push('tenant-lock');
            return { rowCount: 1, rows: [{ status: 'active' }] };
          }
          if (/SELECT \* .*managed_invocations.*FOR UPDATE/s.test(sql)) {
            order.push('invocation-lock');
            return { rowCount: 1, rows: [initialRow] };
          }
          if (/SELECT EXISTS[\s\S]*managed_api_keys/s.test(sql)) {
            return { rowCount: 1, rows: [{ active: true }] };
          }
          if (/SELECT 1 FROM .*managed_lease_token_uses/s.test(sql)) {
            return { rowCount: 0, rows: [] };
          }
          if (/^\s*SELECT 1 FROM .*managed_invocations/s.test(sql)) {
            return { rowCount: 0, rows: [] };
          }
          if (/INSERT INTO .*managed_lease_token_uses/s.test(sql)) {
            return { rowCount: 1, rows: [] };
          }
          if (/WITH lease_clock AS .*UPDATE .*managed_invocations/s.test(sql)) {
            return { rowCount: 1, rows: [updatedRow] };
          }
          if (/INSERT INTO .*managed_audit_events/s.test(sql)) {
            auditInsertSql = sql;
            return { rowCount: 1, rows: [] };
          }
          if (/SET audit_head_hash/s.test(sql)) {
            return { rowCount: 1, rows: [] };
          }
          if (/SET lease_claim_audit_hash/s.test(sql)) {
            return { rowCount: 1, rows: [] };
          }
          throw new Error(`Unexpected fake PostgreSQL query: ${sql}`);
        },
        release() {},
      };
    },
  };
  const store = new PostgresManagedServiceStore({ pool, requireTls: false });
  const claimed = await store.claimLease({
    tenant_id: 'tenant_alpha',
    invocation_ref: initialRow.invocation_ref,
    worker_id: 'worker_clock_test',
    claimant_key_id: 'key_alpha',
    purpose: 'execution',
    lease_token_hash: updatedRow.lease_token_hash,
    lease_ms: 5_000,
    min_lease_ms: 1_000,
    max_lease_ms: 900_000,
    max_invocation_age_ms: 15 * 60_000,
    now: initialNow,
  });
  assert.equal(claimed.claim_replayed, false);
  assert.equal(claimed.invocation.state, 'execution_leased');
  assert.equal(claimed.invocation.lease_owner, 'key_alpha');
  assert.deepEqual(order, ['clock:1', 'tenant-lock', 'invocation-lock', 'clock:2']);
  assert.match(auditInsertSql, /prior\.sequence = \$3 - 1/);
  assert.match(auditInsertSql, /prior\.event_hash = \$8/);
  assert.match(auditInsertSql, /prior\.occurred_at <= \$6::timestamptz/);
});

test('PostgreSQL exact claim retry returns stored work without any mutation', async () => {
  const now = '2026-09-05T12:00:00.000Z';
  const tokenHash = sha256Ref({ postgres_exact_claim_token: true });
  const claimAuditHash = sha256Ref({ postgres_exact_claim_audit: true });
  const activeRow = postgresInvocationRow({
    state: 'execution_leased',
    lease_kind: 'execution',
    lease_owner: 'key_alpha',
    lease_token_hash: tokenHash,
    lease_claim_audit_hash: claimAuditHash,
    lease_expires_at: '2026-09-05T12:00:10.000Z',
    lease_generation: 1,
    audit_head_hash: claimAuditHash,
    audit_event_count: 2,
  });
  const queries = [];
  const pool = {
    async connect() {
      return {
        async query(sql) {
          queries.push(sql);
          if (sql.startsWith('BEGIN') || sql.startsWith('SET LOCAL')
            || sql === 'COMMIT' || sql === 'ROLLBACK') {
            return { rowCount: 0, rows: [] };
          }
          if (sql === 'SELECT clock_timestamp() AS managed_now') {
            return { rowCount: 1, rows: [{ managed_now: now }] };
          }
          if (/managed_tenants.*FOR SHARE/s.test(sql)) {
            return { rowCount: 1, rows: [{ status: 'active' }] };
          }
          if (/SELECT \* .*managed_invocations.*FOR UPDATE/s.test(sql)) {
            return { rowCount: 1, rows: [activeRow] };
          }
          if (/SELECT EXISTS[\s\S]*managed_api_keys/s.test(sql)) {
            return { rowCount: 1, rows: [{ active: true }] };
          }
          throw new Error(`Unexpected fake PostgreSQL query: ${sql}`);
        },
        release() {},
      };
    },
  };
  const store = new PostgresManagedServiceStore({ pool, requireTls: false });
  const request = {
    tenant_id: 'tenant_alpha',
    invocation_ref: activeRow.invocation_ref,
    worker_id: 'worker_postgres_retry',
    claimant_key_id: 'key_alpha',
    purpose: 'execution',
    lease_token_hash: tokenHash,
    lease_ms: 5_000,
    now,
  };
  const replay = await store.claimLease(request);
  assert.equal(replay.claim_replayed, true);
  assert.equal(replay.invocation.lease_generation, 1);
  assert.equal(replay.invocation.lease_expires_at, activeRow.lease_expires_at);
  assert.deepEqual(replay.invocation.operation, activeRow.operation_json);
  assert.equal(queries.some((sql) => /^\s*(?:UPDATE|INSERT)/.test(sql)), false);

  await assert.rejects(
    store.claimLease({
      ...request,
      lease_token_hash: sha256Ref({ postgres_wrong_retry_token: true }),
    }),
    (error) => error.code === 'LEASE_ALREADY_HELD' && error.status === 409,
  );
  assert.equal(queries.some((sql) => /^\s*(?:UPDATE|INSERT)/.test(sql)), false);
});

test('PostgreSQL rejects a tenant-wide historical lease token before lease mutation', async () => {
  const now = '2026-09-05T12:00:00.000Z';
  const row = postgresInvocationRow({ invocation_ref: 'rfi_tenant_wide_token_target' });
  const queries = [];
  let tokenLookupSql = '';
  const pool = {
    async connect() {
      return {
        async query(sql) {
          queries.push(sql);
          if (sql.startsWith('BEGIN') || sql.startsWith('SET LOCAL') || sql === 'ROLLBACK') {
            return { rowCount: 0, rows: [] };
          }
          if (sql === 'SELECT clock_timestamp() AS managed_now') {
            return { rowCount: 1, rows: [{ managed_now: now }] };
          }
          if (/managed_tenants.*FOR SHARE/s.test(sql)) {
            return { rowCount: 1, rows: [{ status: 'active' }] };
          }
          if (/SELECT \* .*managed_invocations.*FOR UPDATE/s.test(sql)) {
            return { rowCount: 1, rows: [row] };
          }
          if (/SELECT EXISTS[\s\S]*managed_api_keys/s.test(sql)) {
            return { rowCount: 1, rows: [{ active: true }] };
          }
          if (/SELECT 1 FROM .*managed_lease_token_uses/s.test(sql)) {
            tokenLookupSql = sql;
            return { rowCount: 1, rows: [{ exists: 1 }] };
          }
          throw new Error(`Unexpected fake PostgreSQL query: ${sql}`);
        },
        release() {},
      };
    },
  };
  const store = new PostgresManagedServiceStore({ pool, requireTls: false });
  await assert.rejects(
    store.claimLease({
      tenant_id: 'tenant_alpha',
      invocation_ref: row.invocation_ref,
      worker_id: 'worker_tenant_wide_token_target',
      claimant_key_id: 'key_alpha',
      purpose: 'execution',
      lease_token_hash: sha256Ref({ tenant_wide_historical_token: true }),
      lease_ms: 5_000,
      min_lease_ms: 1_000,
      max_lease_ms: 900_000,
      max_invocation_age_ms: 15 * 60_000,
      now,
    }),
    (error) => error.code === 'LEASE_TOKEN_REPLAYED' && error.status === 409,
  );
  assert.match(tokenLookupSql, /WHERE tenant_id = \$1 AND lease_token_hash = \$2/);
  assert.doesNotMatch(tokenLookupSql, /invocation_ref/);
  assert.equal(queries.some((sql) => /^\s*(?:UPDATE|INSERT)/.test(sql)), false);
});

test('PostgreSQL resource journal transition recheck returns its exact durable response without mutation', async () => {
  const now = '2026-09-05T12:00:00.000Z';
  const fixture = await createFixture({
    verifyResourceBinding: async () => true,
  });
  const admitted = await fixture.controlPlane.admitInvocation(
    fixture.principal,
    invocationRequest(),
  );
  const leaseToken = fixture.nextLeaseToken('postgres_journal_receipt');
  await fixture.controlPlane.claimExecution(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: leaseToken,
    worker_id: 'worker_postgres_journal_receipt',
    lease_ms: 10_000,
  });
  const response = await fixture.controlPlane.recordResources(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref,
    lease_token: leaseToken,
    savepoint_ref: 'savepoint_postgres_journal_receipt',
    fork_ref: 'fork_postgres_journal_receipt',
  });
  const tokenHash = sha256Ref({ postgres_journal_receipt_token: true });
  const requestHash = managedResourceJournalRequestHash({
    tenantId: fixture.principal.tenant_id,
    invocationRef: response.invocation_ref,
    claimantKeyId: fixture.principal.key_id,
    leaseTokenHash: tokenHash,
    savepointRef: response.savepoint_ref,
    forkRef: response.fork_ref,
  });
  const receipt = createManagedResourceJournalReceipt({
    tenantId: fixture.principal.tenant_id,
    invocationRef: response.invocation_ref,
    requestHash,
    claimantKeyId: fixture.principal.key_id,
    leaseTokenHash: tokenHash,
    response,
    createdAt: now,
  });
  const queries = [];
  const pool = {
    async connect() {
      return {
        async query(sql) {
          queries.push(sql);
          if (sql.startsWith('BEGIN') || sql.startsWith('SET LOCAL')
            || sql === 'COMMIT' || sql === 'ROLLBACK') {
            return { rowCount: 0, rows: [] };
          }
          if (sql === 'SELECT clock_timestamp() AS managed_now') {
            return { rowCount: 1, rows: [{ managed_now: now }] };
          }
          if (/managed_tenants.*FOR SHARE/s.test(sql)) {
            return { rowCount: 1, rows: [{ status: 'active' }] };
          }
          if (/SELECT \* .*managed_invocations.*FOR UPDATE/s.test(sql)) {
            return {
              rowCount: 1,
              rows: [{
                tenant_id: fixture.principal.tenant_id,
                invocation_ref: response.invocation_ref,
              }],
            };
          }
          if (/FROM .*managed_resource_journal_receipts/s.test(sql)) {
            return {
              rowCount: 1,
              rows: [{
                tenant_id: receipt.tenant_id,
                invocation_ref: receipt.invocation_ref,
                request_hash: receipt.request_hash,
                claimant_key_id: receipt.claimant_key_id,
                lease_token_hash: receipt.lease_token_hash,
                response_json: receipt.response,
                response_hash: receipt.response_hash,
                created_at: receipt.created_at,
              }],
            };
          }
          if (/SELECT EXISTS[\s\S]*managed_api_keys/s.test(sql)) {
            return { rowCount: 1, rows: [{ active: true }] };
          }
          throw new Error(`Unexpected fake PostgreSQL query: ${sql}`);
        },
        release() {},
      };
    },
  };
  const store = new PostgresManagedServiceStore({ pool, requireTls: false });
  const replay = await store.transitionInvocation({
    tenant_id: fixture.principal.tenant_id,
    claimant_key_id: fixture.principal.key_id,
    invocation_ref: response.invocation_ref,
    lease_token_hash: tokenHash,
    resource_journal_request_hash: requestHash,
    expected_states: ['execution_leased'],
    expected_audit_event_count: 2,
    next_state: 'running',
    patch: {
      savepoint_ref: response.savepoint_ref,
      fork_ref: response.fork_ref,
      cleanup_requests: response.cleanup_requests,
    },
    event_type: 'provider_resources_recorded',
    event_details: {},
    now,
  });
  assert.deepEqual(replay, response);
  assert.equal(queries.some((sql) => /^\s*(?:UPDATE|INSERT)/.test(sql)), false);
});

test('PostgreSQL rolls back a mutation when audit time regresses at append', async () => {
  const initialNow = '2026-09-05T12:00:00.000Z';
  const regressedNow = '2026-09-05T11:59:59.000Z';
  const initialRow = postgresInvocationRow();
  const tokenHash = sha256Ref({ regressed_audit_lease: true });
  const updatedRow = postgresInvocationRow({
    state: 'execution_leased',
    lease_kind: 'execution',
    lease_owner: 'key_alpha',
    lease_token_hash: tokenHash,
    lease_expires_at: '2026-09-05T12:00:04.000Z',
    lease_generation: 1,
    updated_at: regressedNow,
  });
  let clockCalls = 0;
  let rolledBack = false;
  let committed = false;
  const pool = {
    async connect() {
      return {
        async query(sql) {
          if (sql.startsWith('BEGIN') || sql.startsWith('SET LOCAL')) {
            return { rowCount: 0, rows: [] };
          }
          if (sql === 'ROLLBACK') {
            rolledBack = true;
            return { rowCount: 0, rows: [] };
          }
          if (sql === 'COMMIT') {
            committed = true;
            return { rowCount: 0, rows: [] };
          }
          if (sql === 'SELECT clock_timestamp() AS managed_now') {
            clockCalls += 1;
            return {
              rowCount: 1,
              rows: [{ managed_now: clockCalls === 1 ? initialNow : regressedNow }],
            };
          }
          if (/managed_tenants.*FOR SHARE/s.test(sql)) {
            return { rowCount: 1, rows: [{ status: 'active' }] };
          }
          if (/SELECT \* .*managed_invocations.*FOR UPDATE/s.test(sql)) {
            return { rowCount: 1, rows: [initialRow] };
          }
          if (/SELECT EXISTS[\s\S]*managed_api_keys/s.test(sql)) {
            return { rowCount: 1, rows: [{ active: true }] };
          }
          if (/SELECT 1 FROM .*managed_lease_token_uses/s.test(sql)) {
            return { rowCount: 0, rows: [] };
          }
          if (/^\s*SELECT 1 FROM .*managed_invocations/s.test(sql)) {
            return { rowCount: 0, rows: [] };
          }
          if (/INSERT INTO .*managed_lease_token_uses/s.test(sql)) {
            return { rowCount: 1, rows: [] };
          }
          if (/WITH lease_clock AS .*UPDATE .*managed_invocations/s.test(sql)) {
            return { rowCount: 1, rows: [updatedRow] };
          }
          if (/INSERT INTO .*managed_audit_events/s.test(sql)) {
            return { rowCount: 0, rows: [] };
          }
          throw new Error(`Unexpected fake PostgreSQL query: ${sql}`);
        },
        release() {},
      };
    },
  };
  const store = new PostgresManagedServiceStore({ pool, requireTls: false });
  await assert.rejects(
    store.claimLease({
      tenant_id: 'tenant_alpha',
      invocation_ref: initialRow.invocation_ref,
      worker_id: 'worker_regressed_clock',
      claimant_key_id: 'key_alpha',
      purpose: 'execution',
      lease_token_hash: tokenHash,
      lease_ms: 5_000,
      min_lease_ms: 1_000,
      max_lease_ms: 900_000,
      max_invocation_age_ms: 15 * 60_000,
      now: initialNow,
    }),
    (error) => error.code === 'AUDIT_APPEND_CONFLICT' && error.status === 503,
  );
  assert.equal(rolledBack, true);
  assert.equal(committed, false);
});

test('PostgreSQL renewal fails when the lease expires at its decisive update', async () => {
  const now = '2026-09-05T12:00:00.000Z';
  const expiredNow = '2026-09-05T12:00:06.000Z';
  const tokenHash = sha256Ref({ lease_gate: true });
  const row = postgresInvocationRow({
    state: 'execution_leased',
    lease_kind: 'execution',
    lease_owner: 'key_alpha',
    lease_token_hash: tokenHash,
    lease_expires_at: '2026-09-05T12:00:05.000Z',
    lease_generation: 1,
  });
  let updateSql = '';
  let clockCalls = 0;
  const pool = {
    async connect() {
      return {
        async query(sql) {
          if (sql.startsWith('BEGIN') || sql.startsWith('SET LOCAL') || sql === 'ROLLBACK') {
            return { rowCount: 0, rows: [] };
          }
          if (sql === 'SELECT clock_timestamp() AS managed_now') {
            clockCalls += 1;
            return { rowCount: 1, rows: [{ managed_now: clockCalls < 3 ? now : expiredNow }] };
          }
          if (/managed_tenants.*FOR SHARE/s.test(sql)) {
            return { rowCount: 1, rows: [{ status: 'active' }] };
          }
          if (/SELECT \* .*managed_invocations.*FOR UPDATE/s.test(sql)) {
            return { rowCount: 1, rows: [row] };
          }
          if (/SELECT EXISTS .*managed_api_keys AS claimant/s.test(sql)) {
            return { rowCount: 1, rows: [{ active: true }] };
          }
          if (/WITH lease_clock AS .*UPDATE .*managed_invocations/s.test(sql)) {
            updateSql = sql;
            return { rowCount: 0, rows: [] };
          }
          throw new Error(`Unexpected fake PostgreSQL query: ${sql}`);
        },
        release() {},
      };
    },
  };
  const store = new PostgresManagedServiceStore({ pool, requireTls: false });
  await assert.rejects(
    store.renewLease({
      tenant_id: 'tenant_alpha',
      claimant_key_id: 'key_alpha',
      invocation_ref: row.invocation_ref,
      lease_token_hash: tokenHash,
      lease_ms: 1_000,
      now,
    }),
    (error) => error.code === 'LEASE_EXPIRED' && error.status === 409,
  );
  assert.match(updateSql, /lease_expires_at > lease_clock\.now/);
  assert.match(updateSql, /lease_token_hash = \$4/);
  assert.match(updateSql, /lease_owner = \$5/);
  assert.match(updateSql, /managed_api_keys AS claimant/);
});

test('PostgreSQL execution claim rechecks admission age at its decisive update', async () => {
  const initialNow = '2026-09-05T12:00:00.000Z';
  const gateNow = '2026-09-05T12:00:02.000Z';
  const row = postgresInvocationRow({ admitted_at: '2026-09-05T11:59:51.000Z' });
  let clockCalls = 0;
  let updateSql = '';
  const pool = {
    async connect() {
      return {
        async query(sql) {
          if (sql.startsWith('BEGIN') || sql.startsWith('SET LOCAL') || sql === 'ROLLBACK') {
            return { rowCount: 0, rows: [] };
          }
          if (sql === 'SELECT clock_timestamp() AS managed_now') {
            clockCalls += 1;
            return {
              rowCount: 1,
              rows: [{ managed_now: clockCalls < 3 ? initialNow : gateNow }],
            };
          }
          if (/managed_tenants.*FOR SHARE/s.test(sql)) {
            return { rowCount: 1, rows: [{ status: 'active' }] };
          }
          if (/SELECT \* .*managed_invocations.*FOR UPDATE/s.test(sql)) {
            return { rowCount: 1, rows: [row] };
          }
          if (/SELECT EXISTS[\s\S]*managed_api_keys/s.test(sql)) {
            return { rowCount: 1, rows: [{ active: true }] };
          }
          if (/SELECT 1 FROM .*managed_lease_token_uses/s.test(sql)) {
            return { rowCount: 0, rows: [] };
          }
          if (/^\s*SELECT 1 FROM .*managed_invocations/s.test(sql)) {
            return { rowCount: 0, rows: [] };
          }
          if (/INSERT INTO .*managed_lease_token_uses/s.test(sql)) {
            return { rowCount: 1, rows: [] };
          }
          if (/WITH lease_clock AS .*UPDATE .*managed_invocations/s.test(sql)) {
            updateSql = sql;
            return { rowCount: 0, rows: [] };
          }
          throw new Error(`Unexpected fake PostgreSQL query: ${sql}`);
        },
        release() {},
      };
    },
  };
  const store = new PostgresManagedServiceStore({ pool, requireTls: false });
  await assert.rejects(
    store.claimLease({
      tenant_id: 'tenant_alpha',
      invocation_ref: row.invocation_ref,
      worker_id: 'worker_stale_at_gate',
      claimant_key_id: 'key_alpha',
      purpose: 'execution',
      lease_token_hash: sha256Ref({ stale_at_gate: true }),
      lease_ms: 5_000,
      min_lease_ms: 1_000,
      max_lease_ms: 900_000,
      max_invocation_age_ms: 10_000,
      now: initialNow,
    }),
    (error) => error.code === 'INVOCATION_EXPIRED' && error.status === 409,
  );
  assert.match(updateSql, /target\.admitted_at > lease_clock\.now/);
  assert.match(updateSql, /NOT EXISTS/);
  assert.equal(clockCalls, 3);
});

test('PostgreSQL execution reads reject a tampered stored operation', async () => {
  const originalOperation = {
    kind: 'mcp_tool_call',
    tool_name: 'example.safe_tool',
    arguments: { value: 'original' },
  };
  const row = postgresInvocationRow({
    operation_hash: sha256Ref(originalOperation),
    operation_json: {
      kind: 'mcp_tool_call',
      tool_name: 'example.different_tool',
      arguments: { value: 'tampered' },
    },
  });
  const pool = {
    async connect() {
      return {
        async query(sql) {
          assert.match(sql, /managed_invocations/);
          return { rowCount: 1, rows: [row] };
        },
        release() {},
      };
    },
  };
  const store = new PostgresManagedServiceStore({ pool, requireTls: false });
  await assert.rejects(
    store.getInvocation('tenant_alpha', row.invocation_ref, { includeOperation: true }),
    (error) => error.code === 'OPERATION_INTEGRITY_FAILED' && error.status === 503,
  );
});

test('PostgreSQL public reads reject a tampered provider recovery key', async () => {
  const row = postgresInvocationRow({
    state: 'recovery_required',
    provider_recovery_key: sha256Ref({ malicious_redirect: true }),
  });
  const pool = {
    async connect() {
      return {
        async query(sql) {
          if (sql.includes('SELECT * FROM') && sql.includes('managed_invocations')) {
            return { rowCount: 1, rows: [row] };
          }
          throw new Error(`Unexpected query: ${sql}`);
        },
        release() {},
      };
    },
  };
  const store = new PostgresManagedServiceStore({ pool, requireTls: false });
  await assert.rejects(
    store.getInvocation('tenant_alpha', row.invocation_ref),
    (error) => error.code === 'RECOVERY_KEY_INTEGRITY_FAILED' && error.status === 503,
  );
});
