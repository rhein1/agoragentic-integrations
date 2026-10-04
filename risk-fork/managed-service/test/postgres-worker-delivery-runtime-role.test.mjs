import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import test from 'node:test';

import { verifyPostgresWorkerDeliveryAttestation } from '../src/postgres-worker-delivery-attestation.mjs';
import { createPostgresWorkerDeliveryStore } from '../src/postgres-worker-delivery-store.mjs';
import { sha256Ref } from '../../src/canonical.mjs';
import { quotePostgresAuthorityIdentifier } from '../../src/adapters/postgres-authority-migrator.mjs';

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
const token = () => randomUUID().replaceAll('-', '').slice(0, 18);

test('worker delivery runtime role is attested, operational, and least privilege', { skip, timeout: 120_000 }, async (t) => {
  assert.ok(connectionString);
  const rootAdmin = new pg.Pool({ connectionString, max: 4 });
  const suffix = token();
  const childDatabase = `risk_fork_worker_role_${suffix}`;
  const schemaName = `worker_delivery_role_${suffix}`;
  const migrator = `worker_delivery_migrator_${suffix}`;
  const runtime = `worker_delivery_runtime_${suffix}`;
  const database = childDatabase;
  let childCreated = false;
  let admin;
  let runtimePool;
  let migratorCreated = false;
  let runtimeCreated = false;
  let schemaCreated = false;
  let membershipCreated = false;
  const membership = `worker_delivery_membership_${suffix}`;
  t.after(async () => {
    const errors = [];
    const attempt = async (action) => { try { await action(); } catch (error) { errors.push(error); } };
    await attempt(() => store?.close());
    await attempt(() => runtimePool?.end());
    if (schemaCreated) await attempt(() => admin?.query(`DROP SCHEMA ${schema} CASCADE`));
    await attempt(() => admin?.end());
    if (childCreated) {
      await attempt(() => rootAdmin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [childDatabase]));
      await attempt(() => rootAdmin.query(`DROP DATABASE ${qid(childDatabase)}`));
    }
    if (membershipCreated) await attempt(() => rootAdmin.query(`DROP ROLE ${qid(membership)}`));
    if (runtimeCreated) await attempt(() => rootAdmin.query(`DROP ROLE ${qid(runtime)}`));
    if (migratorCreated) await attempt(() => rootAdmin.query(`DROP ROLE ${qid(migrator)}`));
    if (childCreated) await attempt(async () => {
      const result = await rootAdmin.query('SELECT datname FROM pg_database WHERE datname = $1', [childDatabase]);
      assert.equal(result.rowCount, 0);
    });
    if (runtimeCreated || migratorCreated || membershipCreated) await attempt(async () => {
      const result = await rootAdmin.query(
        'SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])',
        [[runtime, migrator, membership].filter((name, index) => [runtimeCreated, migratorCreated, membershipCreated][index])],
      );
      assert.deepEqual(result.rows, []);
    });
    await attempt(() => rootAdmin.end());
    if (errors.length) throw new AggregateError(errors, 'worker delivery runtime-role cleanup failed');
  });
  const childConnection = new URL(connectionString);
  childConnection.pathname = `/${childDatabase}`;
  admin = new pg.Pool({ connectionString: childConnection.toString(), max: 4 });
  const schema = qid(schemaName);
  const migratorPassword = `migrator-${token()}`;
  const runtimePassword = `runtime-${token()}`;
  runtimePool = new pg.Pool({
    connectionString: (() => {
      const url = new URL(childConnection);
      url.username = runtime;
      url.password = runtimePassword;
      return url.toString();
    })(), max: 2,
  });
  const controlPlane = { config: { environment: 'local_test', enabled: true } };
  let store;
  const adminQuery = (sql, params = []) => admin.query(sql, params);
  const template = async (name) => {
    const source = await readFile(new URL(`../ops/postgres/${name}`, import.meta.url), 'utf8');
    return source
      .replaceAll('__RISK_FORK_MANAGED_DATABASE__', database)
      .replaceAll('__RISK_FORK_MANAGED_SCHEMA__', schemaName)
      .replaceAll('__RISK_FORK_MANAGED_MIGRATOR_ROLE__', migrator)
      .replaceAll('__RISK_FORK_MANAGED_RUNTIME_ROLE__', runtime);
  };

  await rootAdmin.query(`CREATE DATABASE ${qid(childDatabase)}`);
  childCreated = true;
  await adminQuery(`CREATE ROLE ${qid(migrator)} LOGIN NOINHERIT PASSWORD '${migratorPassword}'`);
  migratorCreated = true;
  await adminQuery(`CREATE ROLE ${qid(runtime)} LOGIN NOINHERIT PASSWORD '${runtimePassword}'`);
  runtimeCreated = true;
  await adminQuery(await template('owner-bootstrap.sql.template'));
  schemaCreated = true;

  const migrationClient = await admin.connect();
  try {
    await migrationClient.query(`SET ROLE ${qid(migrator)}`);
    const source = (await readFile(new URL('../migrations/002_worker_delivery.pg.sql', import.meta.url), 'utf8'))
      .replace(/\r\n?/g, '\n');
    await migrationClient.query(source.replaceAll('__RISK_FORK_MANAGED_SCHEMA__', schema));
    await migrationClient.query(
      `INSERT INTO ${schema}.managed_worker_delivery_schema_migrations (version, migration_hash) VALUES (1, $1)`,
      [sha256Ref(source)],
    );
    await migrationClient.query('RESET ROLE');
  } finally { migrationClient.release(); }

  const grantClient = await admin.connect();
  try {
    await grantClient.query(`SET ROLE ${qid(migrator)}`);
    await grantClient.query(await template('worker-delivery-roles.sql.template'));
    await grantClient.query('RESET ROLE');
  } finally { grantClient.release(); }

  const client = await runtimePool.connect();
  try {
    const identity = await client.query('SELECT current_user, session_user');
    assert.equal(identity.rows[0].current_user, runtime);
    assert.equal(identity.rows[0].session_user, runtime);
    const report = await verifyPostgresWorkerDeliveryAttestation(client, { schemaName, expectedOwner: migrator });
    assert.equal(report.catalog_verified, true);
    assert.equal(report.runtime_privileges_verified, true);

    store = await createPostgresWorkerDeliveryStore({
      pool: runtimePool, schemaName, requireTls: false, disposableDb: true,
      controlPlane, expectedOwner: migrator,
    });
    const namespace = 'runtime:role';
    const record = {
      schema: 'agoragentic.risk-fork.worker-delivery.v1', namespace,
      attempt_ref: sha256Ref(`attempt-${suffix}`), key_id: 'key:runtime-role',
      iv: Buffer.alloc(12, 1).toString('base64url'),
      ciphertext: Buffer.from('runtime-role-ciphertext').toString('base64url'),
      tag: Buffer.alloc(16, 2).toString('base64url'),
    };
    assert.equal(await store.insert(record, 4), true);
    assert.deepEqual((await store.get(namespace, record.attempt_ref)).record, record);
    assert.deepEqual(await store.listPending(namespace, 4), [record.attempt_ref]);
    assert.equal(await store.acknowledge(namespace, record.attempt_ref, sha256Ref('runtime-response')), true);
    assert.deepEqual(await store.listPending(namespace, 4), []);

    await assert.rejects(client.query(`CREATE TABLE ${schema}.runtime_denied(id integer)`));
    await assert.rejects(client.query(`DELETE FROM ${schema}.managed_worker_delivery_attempts`));
    await assert.rejects(client.query(`TRUNCATE ${schema}.managed_worker_delivery_attempts`));
    await assert.rejects(client.query(`UPDATE ${schema}.managed_worker_delivery_schema_migrations SET version = 1`));
    await assert.rejects(client.query(`SELECT ${schema}.reject_managed_worker_delivery_delete()`));
  } finally { client.release(); }

  const attest = async () => {
    const c = await runtimePool.connect();
    try { return await verifyPostgresWorkerDeliveryAttestation(c, { schemaName, expectedOwner: migrator }); }
    finally { c.release(); }
  };
  const attestWithOwner = async (expectedOwner) => {
    const c = await runtimePool.connect();
    try { return await verifyPostgresWorkerDeliveryAttestation(c, { schemaName, expectedOwner }); }
    finally { c.release(); }
  };
  const expectAttestationFailure = async (mutation, restore) => {
    await mutation();
    await assert.rejects(attest());
    await restore();
    await attest();
  };

  await adminQuery(`CREATE ROLE ${qid(membership)} NOLOGIN NOINHERIT`);
  membershipCreated = true;

  await expectAttestationFailure(
    () => adminQuery(`GRANT SELECT ON ${schema}.managed_worker_delivery_attempts TO PUBLIC`),
    () => adminQuery(`REVOKE SELECT ON ${schema}.managed_worker_delivery_attempts FROM PUBLIC`),
  );
  await expectAttestationFailure(
    () => adminQuery(`GRANT INSERT ON ${schema}.managed_worker_delivery_attempts TO PUBLIC`),
    () => adminQuery(`REVOKE INSERT ON ${schema}.managed_worker_delivery_attempts FROM PUBLIC`),
  );
  await expectAttestationFailure(
    () => adminQuery(`GRANT USAGE ON SCHEMA ${schema} TO PUBLIC`),
    () => adminQuery(`REVOKE USAGE ON SCHEMA ${schema} FROM PUBLIC`),
  );
  await expectAttestationFailure(
    () => adminQuery(`GRANT CONNECT ON DATABASE ${qid(database)} TO PUBLIC`),
    () => adminQuery(`REVOKE CONNECT ON DATABASE ${qid(database)} FROM PUBLIC`),
  );
  await expectAttestationFailure(
    () => adminQuery(`GRANT SELECT ON ${schema}.managed_worker_delivery_attempts TO ${qid(membership)}`),
    () => adminQuery(`REVOKE SELECT ON ${schema}.managed_worker_delivery_attempts FROM ${qid(membership)}`),
  );
  await expectAttestationFailure(
    () => adminQuery(`GRANT USAGE ON SCHEMA ${schema} TO ${qid(membership)}`),
    () => adminQuery(`REVOKE USAGE ON SCHEMA ${schema} FROM ${qid(membership)}`),
  );
  await expectAttestationFailure(
    () => adminQuery(`GRANT EXECUTE ON FUNCTION ${schema}.reject_managed_worker_delivery_delete() TO ${qid(membership)}`),
    () => adminQuery(`REVOKE EXECUTE ON FUNCTION ${schema}.reject_managed_worker_delivery_delete() FROM ${qid(membership)}`),
  );
  await expectAttestationFailure(
    () => adminQuery(`ALTER DEFAULT PRIVILEGES FOR ROLE ${qid(migrator)} IN SCHEMA ${schema}
      GRANT SELECT ON TABLES TO ${qid(membership)}`),
    () => adminQuery(`ALTER DEFAULT PRIVILEGES FOR ROLE ${qid(migrator)} IN SCHEMA ${schema}
      REVOKE SELECT ON TABLES FROM ${qid(membership)}`),
  );

  await expectAttestationFailure(
    () => adminQuery(`CREATE TABLE ${schema}.unreviewed_catalog(id integer)`),
    () => adminQuery(`DROP TABLE ${schema}.unreviewed_catalog`),
  );
  await expectAttestationFailure(
    () => adminQuery(`CREATE FUNCTION ${schema}.unreviewed_function() RETURNS integer LANGUAGE sql AS 'SELECT 1'`),
    () => adminQuery(`DROP FUNCTION ${schema}.unreviewed_function()`),
  );
  const functionDef = (await adminQuery(
    `SELECT pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = $1 AND p.proname = 'protect_managed_worker_delivery_record'`, [schemaName],
  )).rows[0]?.definition;
  assert.ok(functionDef);
  await expectAttestationFailure(
    () => adminQuery(`CREATE OR REPLACE FUNCTION ${schema}.protect_managed_worker_delivery_record()
      RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER AS $$ BEGIN RETURN NEW; END; $$`),
    () => adminQuery(functionDef),
  );
  await expectAttestationFailure(
    () => adminQuery(`ALTER TABLE ${schema}.managed_worker_delivery_attempts DISABLE TRIGGER managed_worker_delivery_protect_record`),
    () => adminQuery(`ALTER TABLE ${schema}.managed_worker_delivery_attempts ENABLE TRIGGER managed_worker_delivery_protect_record`),
  );
  await expectAttestationFailure(
    () => adminQuery(`ALTER TABLE ${schema}.managed_worker_delivery_namespaces ADD CONSTRAINT unreviewed_check CHECK (max_attempts > 0)`),
    () => adminQuery(`ALTER TABLE ${schema}.managed_worker_delivery_namespaces DROP CONSTRAINT unreviewed_check`),
  );
  await expectAttestationFailure(
    () => adminQuery(`CREATE INDEX unreviewed_delivery_index ON ${schema}.managed_worker_delivery_attempts (key_id)`),
    () => adminQuery(`DROP INDEX ${schema}.unreviewed_delivery_index`),
  );
  await expectAttestationFailure(
    () => adminQuery(`GRANT UPDATE ON ${schema}.managed_worker_delivery_attempts TO ${qid(runtime)}`),
    async () => {
      await adminQuery(`REVOKE UPDATE ON ${schema}.managed_worker_delivery_attempts FROM ${qid(runtime)}`);
      // PostgreSQL's table-level REVOKE also removes column UPDATE grants.
      await adminQuery(`GRANT UPDATE (acknowledged, response_hash, acknowledged_at)
        ON ${schema}.managed_worker_delivery_attempts TO ${qid(runtime)}`);
    },
  );
  await expectAttestationFailure(
    () => adminQuery(`GRANT UPDATE (key_id) ON ${schema}.managed_worker_delivery_attempts TO ${qid(runtime)}`),
    () => adminQuery(`REVOKE UPDATE (key_id) ON ${schema}.managed_worker_delivery_attempts FROM ${qid(runtime)}`),
  );
  await expectAttestationFailure(
    () => adminQuery(`GRANT INSERT ON ${schema}.managed_worker_delivery_schema_migrations TO ${qid(runtime)}`),
    () => adminQuery(`REVOKE INSERT ON ${schema}.managed_worker_delivery_schema_migrations FROM ${qid(runtime)}`),
  );
  await expectAttestationFailure(
    () => adminQuery(`GRANT INSERT (key_id) ON ${schema}.managed_worker_delivery_attempts TO PUBLIC`),
    () => adminQuery(`REVOKE INSERT (key_id) ON ${schema}.managed_worker_delivery_attempts FROM PUBLIC`),
  );
  await expectAttestationFailure(
    () => adminQuery(`GRANT REFERENCES ON ${schema}.managed_worker_delivery_attempts TO PUBLIC`),
    () => adminQuery(`REVOKE REFERENCES ON ${schema}.managed_worker_delivery_attempts FROM PUBLIC`),
  );
  await expectAttestationFailure(
    () => adminQuery(`GRANT SELECT ON ${schema}.managed_worker_delivery_attempts TO ${qid(runtime)} WITH GRANT OPTION`),
    () => adminQuery(`REVOKE GRANT OPTION FOR SELECT ON ${schema}.managed_worker_delivery_attempts FROM ${qid(runtime)}`),
  );
  await expectAttestationFailure(
    () => adminQuery(`ALTER DEFAULT PRIVILEGES FOR ROLE ${qid(migrator)} IN SCHEMA ${schema} GRANT EXECUTE ON FUNCTIONS TO ${qid(runtime)}`),
    () => adminQuery(`ALTER DEFAULT PRIVILEGES FOR ROLE ${qid(migrator)} IN SCHEMA ${schema} REVOKE EXECUTE ON FUNCTIONS FROM ${qid(runtime)}`),
  );
  await expectAttestationFailure(
    () => adminQuery(`GRANT CREATE ON DATABASE ${qid(database)} TO ${qid(runtime)}`),
    () => adminQuery(`REVOKE CREATE ON DATABASE ${qid(database)} FROM ${qid(runtime)}`),
  );
  await expectAttestationFailure(
    () => adminQuery(`GRANT CREATE ON SCHEMA ${schema} TO ${qid(runtime)}`),
    () => adminQuery(`REVOKE CREATE ON SCHEMA ${schema} FROM ${qid(runtime)}`),
  );
  await expectAttestationFailure(
    () => adminQuery(`ALTER ROLE ${qid(runtime)} SUPERUSER`),
    () => adminQuery(`ALTER ROLE ${qid(runtime)} NOSUPERUSER`),
  );
  await assert.rejects(attestWithOwner(runtime));
  await adminQuery(`CREATE TABLE ${schema}.runtime_owned_drift(id integer)`);
  await adminQuery(`ALTER TABLE ${schema}.runtime_owned_drift OWNER TO ${qid(runtime)}`);
  await assert.rejects(attest());
  await adminQuery(`ALTER TABLE ${schema}.runtime_owned_drift OWNER TO ${qid(migrator)}`);
  await adminQuery(`DROP TABLE ${schema}.runtime_owned_drift`);
  await attest();
  try {
    await expectAttestationFailure(
      () => adminQuery(`GRANT ${qid(membership)} TO ${qid(runtime)}`),
      () => adminQuery(`REVOKE ${qid(membership)} FROM ${qid(runtime)}`),
    );
  } finally {
    await adminQuery(`DROP ROLE ${qid(membership)}`);
    membershipCreated = false;
  }
});
