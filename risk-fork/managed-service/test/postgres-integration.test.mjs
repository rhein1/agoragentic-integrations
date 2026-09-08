import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { sha256Ref } from '../../src/canonical.mjs';
import { createCleanupVerificationEvidence } from '../../src/provider.mjs';
import {
  createPostgresAuthorityPool,
  quotePostgresAuthorityIdentifier,
} from '../../src/adapters/postgres-authority-migrator.mjs';
import { createManagedAuthenticator, hashManagedApiKey } from '../src/auth.mjs';
import { createManagedServiceConfig } from '../src/config.mjs';
import { createManagedRiskForkControlPlane } from '../src/control-plane.mjs';
import { MANAGED_API_KEY_SCHEMA } from '../src/constants.mjs';
import { migrateManagedServicePostgres } from '../src/postgres-migrator.mjs';
import { PostgresManagedServiceStore } from '../src/postgres-store.mjs';
import { createManagedProviderRegistry } from '../src/provider-registry.mjs';
import {
  invocationRequest,
  SAME_TENANT_TOKEN,
  testLeaseToken,
  TestProvider,
  TEST_TOKEN,
} from './helpers.mjs';

const connectionString = process.env.RISK_FORK_MANAGED_TEST_POSTGRES_URL ?? null;
const disposableConfirmation =
  process.env.RISK_FORK_MANAGED_TEST_CONFIRM_DISPOSABLE === 'YES_DELETE_DATA';
const postgresRequired = process.env.RISK_FORK_MANAGED_REQUIRE_POSTGRES_TESTS === '1';

function postgresSkipReason() {
  if (connectionString === null) return 'RISK_FORK_MANAGED_TEST_POSTGRES_URL is not configured';
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    return 'PostgreSQL test URL is invalid';
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (!loopback || url.pathname !== '/risk_fork_managed_test') {
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

test('PostgreSQL migration and tenant admission work against an explicit disposable database', {
  skip: skipReason,
}, async () => {
  const schemaName = `risk_fork_managed_test_${randomUUID().replaceAll('-', '')}`;
  const quotedSchema = quotePostgresAuthorityIdentifier(schemaName);
  const pool = await createPostgresAuthorityPool({
    connectionString,
    requireTls: false,
    maxConnections: 4,
    applicationName: 'risk-fork-managed-integration-test',
  });
  try {
    const migration = await migrateManagedServicePostgres({
      pool,
      requireTls: false,
      schemaName,
    });
    assert.equal(migration.migration_version, 1);
    assert.equal(migration.production_qualified, false);
    const credentialNow = Date.now();

    await pool.query(
      `INSERT INTO ${quotedSchema}.managed_tenants (
         tenant_id, status, daily_budget_micros,
         max_invocation_cost_micros, max_concurrent_invocations
       ) VALUES ($1, 'active', $2, $3, $4)`,
      ['tenant_alpha', 1_000_000, 500_000, 4],
    );
    await pool.query(
      `INSERT INTO ${quotedSchema}.managed_api_keys (
         key_hash, key_id, tenant_id, scopes, not_before, expires_at
       ) VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
      [
        hashManagedApiKey(TEST_TOKEN),
        'key_alpha',
        'tenant_alpha',
        JSON.stringify([
          'audit:read',
          'invocations:read',
          'invocations:write',
          'worker:claim',
          'worker:write',
        ]),
        new Date(credentialNow - 60_000).toISOString(),
        new Date(credentialNow + 3_600_000).toISOString(),
      ],
    );
    await pool.query(
      `INSERT INTO ${quotedSchema}.managed_api_keys (
         key_hash, key_id, tenant_id, scopes, not_before, expires_at
       ) VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
      [
        hashManagedApiKey(SAME_TENANT_TOKEN),
        'key_alpha_secondary',
        'tenant_alpha',
        JSON.stringify([
          'audit:read',
          'invocations:read',
          'invocations:write',
          'worker:claim',
          'worker:write',
        ]),
        new Date(credentialNow - 60_000).toISOString(),
        new Date(credentialNow + 3_600_000).toISOString(),
      ],
    );

    const store = new PostgresManagedServiceStore({
      pool,
      schemaName,
      requireTls: false,
      maxClockSkewMs: 30_000,
      eventRef: (() => {
        let sequence = 0;
        return () => `evt_pg_${++sequence}`;
      })(),
    });
    const provider = new TestProvider();
    let resourceVerifierCalls = 0;
    const providerRegistry = createManagedProviderRegistry([{
      provider,
      enabled: true,
      adapter_digest: sha256Ref({ adapter: 'postgres_test_fixture', version: 1 }),
      qualification_class: 'local_test',
      qualification_receipt_hash: sha256Ref({ local_postgres_fixture: true }),
      tenant_ids: ['tenant_alpha'],
      verify_resource_binding: async ({ resources, tenant_id: tenantId }) => {
        resourceVerifierCalls += 1;
        return tenantId === 'tenant_alpha'
          && resources.savepoint_ref === 'savepoint_pg'
          && resources.fork_ref === 'fork_pg'
          && resources.absent_resource_kinds.length === 0;
      },
      verify_cleanup_evidence: async () => true,
      verify_recovery_absence: async () => false,
    }]);
    const config = createManagedServiceConfig({
      enabled: true,
      environment: 'local_test',
      limits: { max_invocation_age_ms: 10_000 },
    });
    const clock = () => new Date(Date.now() - 20_000);
    const authenticator = createManagedAuthenticator({ store, clock });
    const principal = await authenticator.authenticate(
      `Bearer ${TEST_TOKEN}`,
      'invocations:write',
    );
    const sameTenantPrincipal = await authenticator.authenticate(
      `Bearer ${SAME_TENANT_TOKEN}`,
      'invocations:write',
    );
    let invocationSequence = 0;
    const controlPlane = createManagedRiskForkControlPlane({
      config,
      store,
      providerRegistry,
      requirePrincipal: authenticator.requirePrincipal,
      clock,
      invocationRef: () => `rfi_pg_${String(++invocationSequence).padStart(4, '0')}`,
    });
    const concurrent = await Promise.all([
      controlPlane.admitInvocation(principal, invocationRequest()),
      controlPlane.admitInvocation(principal, invocationRequest()),
    ]);
    assert.deepEqual(concurrent.map((result) => result.created).sort(), [false, true]);
    assert.equal(concurrent[0].invocation.tenant_id, 'tenant_alpha');
    assert.equal(concurrent[0].invocation.state, 'admitted');
    assert.equal(concurrent[0].invocation.invocation_ref, concurrent[1].invocation.invocation_ref);
    const executionToken = testLeaseToken('pg_execution');
    const executionClaimRequest = {
      invocation_ref: concurrent[0].invocation.invocation_ref,
      lease_token: executionToken,
      worker_id: 'worker_pg',
      lease_ms: 5_000,
    };
    const executionClaims = await Promise.all([
      controlPlane.claimExecution(principal, executionClaimRequest),
      controlPlane.claimExecution(principal, executionClaimRequest),
    ]);
    assert.deepEqual(
      executionClaims.map((claim) => claim.claim_replayed).sort(),
      [false, true],
    );
    assert.deepEqual(executionClaims[0].invocation, executionClaims[1].invocation);
    const execution = executionClaims[0];
    const sequentialReplay = await controlPlane.claimExecution(principal, executionClaimRequest);
    assert.equal(sequentialReplay.claim_replayed, true);
    assert.deepEqual(sequentialReplay.invocation, execution.invocation);
    assert.equal(execution.invocation.lease_owner, principal.key_id);
    assert.equal(execution.invocation.lease_generation, 1);
    const tokenReuseTarget = await controlPlane.admitInvocation(principal, invocationRequest({
      idempotency_key: 'idempotency-key-pg-token-reuse-0002',
      estimated_cost_micros: 0,
    }));
    await assert.rejects(
      controlPlane.claimExecution(principal, {
        ...executionClaimRequest,
        invocation_ref: tokenReuseTarget.invocation.invocation_ref,
      }),
      (error) => error.code === 'LEASE_TOKEN_REPLAYED' && error.status === 409,
    );
    const replayDurability = await pool.query(
      `SELECT
         (SELECT count(*)::integer
            FROM ${quotedSchema}.managed_audit_events
           WHERE tenant_id = $1 AND invocation_ref = $2
             AND event_type = 'execution_lease_claimed') AS claim_audits,
         (SELECT count(*)::integer
            FROM ${quotedSchema}.managed_lease_token_uses
           WHERE tenant_id = $1) AS token_uses`,
      ['tenant_alpha', concurrent[0].invocation.invocation_ref],
    );
    assert.deepEqual(replayDurability.rows[0], { claim_audits: 1, token_uses: 1 });
    await assert.rejects(
      controlPlane.claimExecution(principal, {
        ...executionClaimRequest,
        lease_token: testLeaseToken('pg_execution_wrong'),
      }),
      (error) => error.code === 'LEASE_ALREADY_HELD' && error.status === 409,
    );
    await assert.rejects(
      controlPlane.renewLease(sameTenantPrincipal, {
        invocation_ref: concurrent[0].invocation.invocation_ref,
        lease_token: execution.lease_token,
        lease_ms: 5_000,
      }),
      (error) => error.code === 'LEASE_OWNER_MISMATCH' && error.status === 403,
    );
    await pool.query(
      `UPDATE ${quotedSchema}.managed_invocations
          SET lease_expires_at = clock_timestamp() - interval '1 second'
        WHERE tenant_id = $1 AND invocation_ref = $2`,
      ['tenant_alpha', concurrent[0].invocation.invocation_ref],
    );
    const expiredLeaseHealth = await controlPlane.health();
    assert.equal(expiredLeaseHealth.ready, false);
    assert.equal(expiredLeaseHealth.storage.expired_execution_lease_count, 1);
    assert.equal(expiredLeaseHealth.storage.recovery_required_count, 0);
    await assert.rejects(
      controlPlane.admitInvocation(principal, invocationRequest({
        idempotency_key: 'idempotency-key-pg-unswept-expiry-0002',
      })),
      (error) => error.code === 'TENANT_RECONCILIATION_REQUIRED',
    );
    await pool.query(
      `UPDATE ${quotedSchema}.managed_invocations
          SET lease_expires_at = clock_timestamp() + interval '1 minute'
        WHERE tenant_id = $1 AND invocation_ref = $2`,
      ['tenant_alpha', concurrent[0].invocation.invocation_ref],
    );
    const resourceRequest = {
      invocation_ref: concurrent[0].invocation.invocation_ref,
      lease_token: execution.lease_token,
      savepoint_ref: 'savepoint_pg',
      fork_ref: 'fork_pg',
    };
    const runningResponses = await Promise.all([
      controlPlane.recordResources(principal, resourceRequest),
      controlPlane.recordResources(principal, resourceRequest),
    ]);
    assert.deepEqual(runningResponses[0], runningResponses[1]);
    const running = runningResponses[0];
    assert.equal(running.state, 'running');
    const verifierCallsAfterConcurrentJournal = resourceVerifierCalls;
    assert.deepEqual(
      await controlPlane.recordResources(principal, resourceRequest),
      running,
    );
    assert.equal(resourceVerifierCalls, verifierCallsAfterConcurrentJournal);
    const resourceJournalDurability = await pool.query(
      `SELECT
         (SELECT count(*)::integer
            FROM ${quotedSchema}.managed_resource_journal_receipts
           WHERE tenant_id = $1 AND invocation_ref = $2) AS receipt_count,
         (SELECT response_hash
            FROM ${quotedSchema}.managed_resource_journal_receipts
           WHERE tenant_id = $1 AND invocation_ref = $2) AS response_hash,
         (SELECT count(*)::integer
            FROM ${quotedSchema}.managed_audit_events
           WHERE tenant_id = $1 AND invocation_ref = $2
             AND event_type = 'provider_resources_recorded') AS resource_audits`,
      ['tenant_alpha', concurrent[0].invocation.invocation_ref],
    );
    assert.deepEqual(resourceJournalDurability.rows[0], {
      receipt_count: 1,
      response_hash: sha256Ref(running),
      resource_audits: 1,
    });
    await assert.rejects(
      controlPlane.recordExecutionOutcome(sameTenantPrincipal, {
        invocation_ref: concurrent[0].invocation.invocation_ref,
        lease_token: execution.lease_token,
        outcome: 'succeeded',
        actual_cost_micros: 75_000,
        execution_evidence_hash: sha256Ref({ pg_execution_wrong_claimant: true }),
        result_hash: sha256Ref({ pg_result_wrong_claimant: true }),
      }),
      (error) => error.code === 'LEASE_OWNER_MISMATCH' && error.status === 403,
    );
    const cleanupPending = await controlPlane.recordExecutionOutcome(principal, {
      invocation_ref: concurrent[0].invocation.invocation_ref,
      lease_token: execution.lease_token,
      outcome: 'succeeded',
      actual_cost_micros: 75_000,
      execution_evidence_hash: sha256Ref({ pg_execution: true }),
      result_hash: sha256Ref({ pg_result: true }),
    });
    assert.equal(cleanupPending.state, 'cleanup_pending');
    assert.equal(cleanupPending.actual_cost_micros, 75_000);
    assert.equal((await controlPlane.listAuditEvents(
      principal,
      concurrent[0].invocation.invocation_ref,
    )).length, 4);
    const collisionControlPlane = createManagedRiskForkControlPlane({
      config,
      store,
      providerRegistry,
      requirePrincipal: authenticator.requirePrincipal,
      clock,
      invocationRef: () => concurrent[0].invocation.invocation_ref,
    });
    await assert.rejects(
      collisionControlPlane.admitInvocation(principal, invocationRequest({
        idempotency_key: 'idempotency-key-pg-ref-collision-0003',
      })),
      (error) => error.code === 'INVOCATION_REFERENCE_CONFLICT' && error.status === 503,
    );
    const usageAfterCollision = await pool.query(
      `SELECT reserved_micros, spent_micros
         FROM ${quotedSchema}.managed_usage_buckets
        WHERE tenant_id = $1 AND budget_day_utc = CURRENT_DATE`,
      ['tenant_alpha'],
    );
    assert.equal(Number(usageAfterCollision.rows[0].reserved_micros), 0);
    assert.equal(Number(usageAfterCollision.rows[0].spent_micros), 75_000);
    const second = await controlPlane.admitInvocation(principal, invocationRequest({
      idempotency_key: 'idempotency-key-pg-suspension-0002',
    }));
    await pool.query(
      `UPDATE ${quotedSchema}.managed_invocations
          SET admitted_at = clock_timestamp() - interval '1 day'
        WHERE tenant_id = $1 AND invocation_ref = $2`,
      ['tenant_alpha', second.invocation.invocation_ref],
    );
    await assert.rejects(
      controlPlane.claimExecution(principal, {
        invocation_ref: second.invocation.invocation_ref,
        lease_token: testLeaseToken('pg_expired_admission'),
        worker_id: 'worker_pg_expired_admission',
        lease_ms: 5_000,
      }),
      (error) => error.code === 'INVOCATION_EXPIRED',
    );
    await pool.query(
      `UPDATE ${quotedSchema}.managed_tenants SET status = 'suspended' WHERE tenant_id = $1`,
      ['tenant_alpha'],
    );
    await assert.rejects(
      controlPlane.claimExecution(principal, {
        invocation_ref: second.invocation.invocation_ref,
        lease_token: testLeaseToken('pg_suspended'),
        worker_id: 'worker_pg_suspended',
        lease_ms: 5_000,
      }),
      (error) => error.code === 'TENANT_NOT_ACTIVE',
    );
    const cleanupClaimRequest = {
      invocation_ref: concurrent[0].invocation.invocation_ref,
      lease_token: testLeaseToken('pg_cleanup'),
      worker_id: 'cleanup_pg_suspended',
      lease_ms: 5_000,
    };
    const cleanup = await controlPlane.claimCleanup(principal, cleanupClaimRequest);
    const cleanupReplay = await controlPlane.claimCleanup(principal, cleanupClaimRequest);
    assert.equal(cleanup.claim_replayed, false);
    assert.equal(cleanupReplay.claim_replayed, true);
    assert.deepEqual(cleanupReplay.invocation, cleanup.invocation);
    assert.equal(cleanup.invocation.lease_kind, 'cleanup');
    assert.equal(Object.hasOwn(cleanup.invocation, 'operation'), false);
    const cleanupEvidence = cleanup.invocation.cleanup_requests.map((request, index) => (
      createCleanupVerificationEvidence(request, {
        status: 'verified',
        observed_at: clock().toISOString(),
        evidence_ref: `cleanup_pg_commit_deadline_${index}`,
        observation_hash: sha256Ref({ cleanup_pg_commit_deadline: index }),
      })
    ));
    await assert.rejects(
      controlPlane.completeCleanup(principal, {
        invocation_ref: concurrent[0].invocation.invocation_ref,
        lease_token: cleanup.lease_token,
        cleanup_evidence: cleanupEvidence,
      }),
      (error) => error.code === 'VERIFICATION_DEADLINE_EXCEEDED' && error.status === 409,
    );
    assert.equal((await controlPlane.getInvocation(
      principal,
      concurrent[0].invocation.invocation_ref,
    )).state, 'cleanup_pending');
    assert.equal((await store.health()).ready, true);
    const controlPlaneHealth = await controlPlane.health();
    assert.equal(controlPlaneHealth.ready, true);
    assert.equal(controlPlaneHealth.provider_binding_obligation_count, 1);
    assert.equal(controlPlaneHealth.provider_binding_obligations_complete, true);
    assert.equal(controlPlaneHealth.unavailable_provider_binding_count, 0);
    await pool.query(
      `INSERT INTO ${quotedSchema}.managed_schema_migrations
         (version, migration_hash) VALUES (2, $1)`,
      [sha256Ref({ intentionally_unreviewed_test_migration: true })],
    );
    const driftedHealth = await store.health();
    assert.equal(driftedHealth.ready, false);
    assert.equal(driftedHealth.migration_verified, false);
    assert.equal(driftedHealth.migration_count, 2);
    assert.equal((await controlPlane.health()).ready, false);
    await pool.query(`DELETE FROM ${quotedSchema}.managed_schema_migrations WHERE version = 2`);
    assert.equal((await store.health()).ready, true);
    assert.equal((await controlPlane.health()).ready, true);
    await pool.query(`DROP TABLE ${quotedSchema}.managed_resource_journal_receipts`);
    await assert.rejects(
      migrateManagedServicePostgres({
        pool,
        requireTls: false,
        schemaName,
      }),
      (error) => error.code === 'MANAGED_SCHEMA_INCOMPLETE' && error.status === 503,
    );
  } finally {
    try {
      await pool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
    } finally {
      await pool.end();
    }
  }
});
