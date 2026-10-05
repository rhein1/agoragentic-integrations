import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import test from 'node:test';

import { sha256Ref } from '../../src/canonical.mjs';
import { quotePostgresAuthorityIdentifier } from '../../src/adapters/postgres-authority-migrator.mjs';
import { createManagedAuthenticator, hashManagedApiKey } from '../src/auth.mjs';
import { createManagedServiceConfig } from '../src/config.mjs';
import { createManagedRiskForkControlPlane } from '../src/control-plane.mjs';
import { migrateManagedServicePostgres } from '../src/postgres-migrator.mjs';
import { PostgresManagedServiceStore } from '../src/postgres-store.mjs';
import { verifyPostgresControlPlaneAttestation } from '../src/postgres-control-plane-attestation.mjs';
import { createManagedProviderRegistry } from '../src/provider-registry.mjs';
import { invocationRequest, testLeaseToken, TestProvider, TEST_TOKEN } from './helpers.mjs';
import { waitForDisposableDatabaseDrain } from './disposable-database-drain.mjs';

const connectionString = process.env.RISK_FORK_MANAGED_TEST_POSTGRES_URL;
let skip = 'An explicit disposable loopback risk_fork_managed_test database is required';
try {
  const url = new URL(connectionString);
  if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    && url.pathname === '/risk_fork_managed_test'
    && process.env.RISK_FORK_MANAGED_TEST_CONFIRM_DISPOSABLE === 'YES_DELETE_DATA') skip = false;
} catch { /* Never select an unreviewed database. */ }
if (skip && process.env.RISK_FORK_MANAGED_REQUIRE_POSTGRES_TESTS === '1') throw new Error(skip);

const qid = (value) => quotePostgresAuthorityIdentifier(value);
const suffix = () => randomUUID().replaceAll('-', '').slice(0, 18);
const scopes = ['audit:read', 'invocations:read', 'invocations:write',
  'worker:execution:claim', 'worker:execution:write',
  'worker:cleanup:claim', 'worker:cleanup:write',
  'worker:recovery:claim', 'worker:recovery:write'];

test('managed control-plane runtime role uses owner lock helpers without credential UPDATE',
  { skip, timeout: 120_000 }, async (t) => {
    const root = new pg.Pool({ connectionString, max: 4 });
    const database = `risk_fork_control_role_${suffix()}`;
    const schemaName = `control_role_${suffix()}`;
    const migrator = `control_migrator_${suffix()}`;
    const runtime = `control_runtime_${suffix()}`;
    const migratorPassword = `migrator-${suffix()}`;
    const runtimePassword = `runtime-${suffix()}`;
    const child = new URL(connectionString); child.pathname = `/${database}`;
    const admin = new pg.Pool({ connectionString: child.toString(), max: 4 });
    const migratorConnection = (() => {
      const url = new URL(child); url.username = migrator; url.password = migratorPassword; return url.toString();
    })();
    const runtimePool = new pg.Pool({ connectionString: (() => {
      const url = new URL(child); url.username = runtime; url.password = runtimePassword; return url.toString();
    })(), max: 3 });
    let childCreated = false;
    const cleanup = async () => {
      const failures = [];
      const attempt = async (label, action) => { try { await action(); } catch (error) { failures.push(new Error(label, { cause: error })); } };
      await attempt('close runtime pool', () => runtimePool.end());
      await attempt('close admin pool', () => admin.end());
      if (childCreated) {
        await attempt('drain and drop child database', async () => {
          await waitForDisposableDatabaseDrain(root, database);
          await root.query(`DROP DATABASE ${qid(database)}`);
        });
      }
      await attempt('drop runtime role', () => root.query(`DROP ROLE IF EXISTS ${qid(runtime)}`));
      await attempt('drop migrator role', () => root.query(`DROP ROLE IF EXISTS ${qid(migrator)}`));
      await attempt('assert child database removed', async () => {
        const result = await root.query('SELECT 1 FROM pg_database WHERE datname=$1', [database]);
        assert.equal(result.rowCount, 0);
      });
      await attempt('assert runtime role removed', async () => {
        const result = await root.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [runtime]);
        assert.equal(result.rowCount, 0);
      });
      await attempt('assert migrator role removed', async () => {
        const result = await root.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [migrator]);
        assert.equal(result.rowCount, 0);
      });
      await attempt('close root pool', () => root.end());
      if (failures.length) throw new AggregateError(failures, 'control-plane runtime-role cleanup failed');
    };
    t.after(cleanup);

    await root.query(`CREATE DATABASE ${qid(database)}`); childCreated = true;
    await admin.query(`CREATE ROLE ${qid(migrator)} LOGIN NOINHERIT PASSWORD '${migratorPassword}'`);
    await admin.query(`CREATE ROLE ${qid(runtime)} LOGIN NOINHERIT PASSWORD '${runtimePassword}'`);
    const ownerBootstrap = (await readFile(new URL('../ops/postgres/control-plane-owner-bootstrap.sql.template', import.meta.url), 'utf8'))
      .replaceAll('__RISK_FORK_MANAGED_DATABASE__', database)
      .replaceAll('__RISK_FORK_MANAGED_MIGRATOR_ROLE__', migrator)
      .replaceAll('__RISK_FORK_MANAGED_RUNTIME_ROLE__', runtime);
    await admin.query(ownerBootstrap);
    await migrateManagedServicePostgres({ connectionString: migratorConnection, schemaName, requireTls: false });
    const migrationClient = await admin.connect();
    try {
      await migrationClient.query(`SET ROLE ${qid(migrator)}`);
      const template = (await readFile(new URL('../ops/postgres/control-plane-roles.sql.template', import.meta.url), 'utf8'))
        .replaceAll('__RISK_FORK_MANAGED_DATABASE__', database)
        .replaceAll('__RISK_FORK_MANAGED_SCHEMA__', schemaName)
        .replaceAll('__RISK_FORK_MANAGED_MIGRATOR_ROLE__', migrator)
        .replaceAll('__RISK_FORK_MANAGED_RUNTIME_ROLE__', runtime);
      await migrationClient.query(template);
      await migrationClient.query('RESET ROLE');
    } finally { migrationClient.release(); }

    const adminQuery = (sql, params = []) => admin.query(sql, params);
    await adminQuery(`INSERT INTO ${qid(schemaName)}.managed_tenants
      (tenant_id,status,daily_budget_micros,max_invocation_cost_micros,max_concurrent_invocations)
      VALUES ('tenant_alpha','active',1000000,500000,4)`);
    await adminQuery(`INSERT INTO ${qid(schemaName)}.managed_api_keys
      (key_hash,key_id,tenant_id,scopes,not_before,expires_at)
      VALUES ($1,'key_alpha','tenant_alpha',$2::jsonb,clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour')`,
    [hashManagedApiKey(TEST_TOKEN), JSON.stringify(scopes)]);

    const asMigrator = async (sql, params = []) => {
      const client = await admin.connect();
      try {
        await client.query(`SET ROLE ${qid(migrator)}`);
        const result = await client.query(sql, params);
        await client.query('RESET ROLE');
        return result;
      } finally { client.release(); }
    };
    const attest = async () => {
      const client = await runtimePool.connect();
      try {
        return await verifyPostgresControlPlaneAttestation(client, {
          schemaName, expectedOwner: migrator,
        });
      } finally { client.release(); }
    };
    const expectCatalogDrift = async (label, mutate, restore) => {
      await mutate();
      await assert.rejects(attest(), (error) => error.code === 'MANAGED_POSTGRES_ATTESTATION_FAILED', label);
      await restore();
      const baseline = await attest();
      assert.equal(baseline.catalog_verified, true, `${label} restore`);
      assert.equal(baseline.runtime_privileges_verified, true, `${label} restore privileges`);
    };

    const helperDefinition = (await adminQuery(
      `SELECT pg_catalog.pg_get_functiondef(p.oid) AS definition
         FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname=$1 AND p.proname='lock_managed_api_key_share'`, [schemaName],
    )).rows[0].definition;
    const activeIndexDefinition = (await adminQuery(
      `SELECT pg_catalog.pg_get_indexdef(i.oid) AS definition
         FROM pg_catalog.pg_class i JOIN pg_catalog.pg_namespace n ON n.oid=i.relnamespace
        WHERE n.nspname=$1 AND i.relname='managed_invocations_active_idx'`, [schemaName],
    )).rows[0].definition;
    await expectCatalogDrift('helper body',
      () => asMigrator(`CREATE OR REPLACE FUNCTION ${qid(schemaName)}.lock_managed_api_key_share(p_tenant_id text,p_key_id text)
        RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS 'SELECT false'`),
      () => asMigrator(helperDefinition));
    await expectCatalogDrift('helper search_path',
      () => asMigrator(`CREATE OR REPLACE FUNCTION ${qid(schemaName)}.lock_managed_api_key_share(p_tenant_id text,p_key_id text)
        RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public
        AS $$ BEGIN RETURN false; END; $$`),
      () => asMigrator(helperDefinition));
    await expectCatalogDrift('constraint',
      () => asMigrator(`ALTER TABLE ${qid(schemaName)}.managed_tenants
        ADD CONSTRAINT control_role_unreviewed_check CHECK (daily_budget_micros >= 0)`),
      () => asMigrator(`ALTER TABLE ${qid(schemaName)}.managed_tenants
        DROP CONSTRAINT control_role_unreviewed_check`));
    await expectCatalogDrift('index predicate',
      async () => {
        await asMigrator(`DROP INDEX ${qid(schemaName)}.managed_invocations_active_idx`);
        await asMigrator(`CREATE INDEX managed_invocations_active_idx
          ON ${qid(schemaName)}.managed_invocations (tenant_id,state,admitted_at)
          WHERE state = 'completed'`);
      },
      async () => {
        await asMigrator(`DROP INDEX ${qid(schemaName)}.managed_invocations_active_idx`);
        await asMigrator(activeIndexDefinition);
      });
    await expectCatalogDrift('extra table',
      () => asMigrator(`CREATE TABLE ${qid(schemaName)}.control_role_unreviewed(id integer)`),
      () => asMigrator(`DROP TABLE ${qid(schemaName)}.control_role_unreviewed`));
    await expectCatalogDrift('PUBLIC SELECT',
      () => asMigrator(`GRANT SELECT ON ${qid(schemaName)}.managed_api_keys TO PUBLIC`),
      () => asMigrator(`REVOKE SELECT ON ${qid(schemaName)}.managed_api_keys FROM PUBLIC`));
    await expectCatalogDrift('API-key column UPDATE',
      () => asMigrator(`GRANT UPDATE (scopes) ON ${qid(schemaName)}.managed_api_keys TO ${qid(runtime)}`),
      () => asMigrator(`REVOKE UPDATE (scopes) ON ${qid(schemaName)}.managed_api_keys FROM ${qid(runtime)}`));

    const runtimeClient = await runtimePool.connect();
    try {
      await assert.rejects(runtimeClient.query(`UPDATE ${qid(schemaName)}.managed_api_keys SET scopes='[]'::jsonb WHERE key_id='key_alpha'`));
      const helper = await runtimeClient.query(`SELECT ${qid(schemaName)}.lock_managed_api_key_share($1,$2) AS locked`, ['tenant_alpha', 'key_alpha']);
      assert.equal(helper.rows[0].locked, true);
      await runtimeClient.query('BEGIN');
      const tenantLock = await runtimeClient.query(
        `SELECT ${qid(schemaName)}.lock_managed_tenant_share($1) AS status`, ['tenant_alpha'],
      );
      assert.equal(tenantLock.rows[0].status, 'active');
      const tenantEditor = await admin.connect();
      try {
        await tenantEditor.query('BEGIN');
        await tenantEditor.query("SET LOCAL lock_timeout = '100ms'");
        await assert.rejects(
          tenantEditor.query(`UPDATE ${qid(schemaName)}.managed_tenants SET status='suspended' WHERE tenant_id='tenant_alpha'`),
          (error) => error.code === '55P03',
        );
        await tenantEditor.query('ROLLBACK');
      } finally { tenantEditor.release(); }
      await runtimeClient.query('COMMIT');
      await adminQuery(`UPDATE ${qid(schemaName)}.managed_tenants SET status='suspended' WHERE tenant_id='tenant_alpha'`);
      await adminQuery(`UPDATE ${qid(schemaName)}.managed_tenants SET status='active' WHERE tenant_id='tenant_alpha'`);
    } finally {
      await runtimeClient.query('ROLLBACK').catch(() => {});
      runtimeClient.release();
    }

    const store = new PostgresManagedServiceStore({ pool: runtimePool, schemaName, requireTls: false, expectedOwner: migrator });
    await store.initialize();
    const strictHealth = await store.health();
    assert.equal(strictHealth.exact_catalog_verified, true);
    assert.equal(strictHealth.runtime_privileges_verified, true);
    assert.equal(strictHealth.catalog_verification_scope, 'source_manifest_and_runtime_role');
    const providerRegistry = createManagedProviderRegistry([{
      provider: new TestProvider(), enabled: true, adapter_digest: sha256Ref({ fixture: 'role' }),
      qualification_class: 'local_test', qualification_receipt_hash: sha256Ref({ role: true }),
      tenant_ids: ['tenant_alpha'], verify_resource_binding: async () => true,
      verify_cleanup_evidence: async () => true, verify_recovery_absence: async () => false,
    }]);
    const auth = createManagedAuthenticator({ store });
    const control = createManagedRiskForkControlPlane({
      config: createManagedServiceConfig({ enabled: true, environment: 'local_test' }),
      store, providerRegistry, requirePrincipal: auth.requirePrincipal,
    });
    const principal = await auth.authenticate(`Bearer ${TEST_TOKEN}`, 'invocations:write');
    const admitted = await control.admitInvocation(principal, invocationRequest());
    const leaseToken = testLeaseToken('runtime-role');
    const claim = await control.claimExecution(principal, {
      invocation_ref: admitted.invocation.invocation_ref, lease_token: leaseToken, worker_id: 'worker_runtime_role', lease_ms: 30_000,
    });
    assert.equal(claim.invocation.lease_owner, 'key_alpha');
    const renewed = await control.renewLease(principal, {
      invocation_ref: admitted.invocation.invocation_ref, lease_token: leaseToken, lease_ms: 30_000,
    });
    assert.equal(renewed.lease_owner, 'key_alpha');
    const lockClient = await runtimePool.connect();
    const editor = await admin.connect();
    try {
      await lockClient.query('BEGIN');
      const locked = await lockClient.query(
        `SELECT ${qid(schemaName)}.lock_managed_api_key_share($1,$2) AS locked`,
        ['tenant_alpha', 'key_alpha'],
      );
      assert.equal(locked.rows[0].locked, true);
      await editor.query('BEGIN');
      await editor.query("SET LOCAL lock_timeout = '100ms'");
      await assert.rejects(
        editor.query(`UPDATE ${qid(schemaName)}.managed_api_keys SET scopes='["invocations:read"]'::jsonb WHERE key_id='key_alpha'`),
        (error) => error.code === '55P03',
      );
      await editor.query('ROLLBACK');
      await lockClient.query('COMMIT');
      await editor.query(`UPDATE ${qid(schemaName)}.managed_api_keys SET scopes='["invocations:read"]'::jsonb WHERE key_id='key_alpha'`);
    } finally {
      await editor.query('ROLLBACK').catch(() => {}); editor.release();
      await lockClient.query('ROLLBACK').catch(() => {}); lockClient.release();
    }
    await assert.rejects(control.renewLease(principal, {
      invocation_ref: admitted.invocation.invocation_ref, lease_token: leaseToken, lease_ms: 30_000,
    }), (error) => error.code === 'AUTHORIZATION_DENIED');
    await store.close();
  });
