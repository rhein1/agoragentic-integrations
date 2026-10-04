import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import test from 'node:test';
import { createPostgresMcpPortableHandleStore } from '../src/adapters/postgres-mcp-portable-handles.mjs';
import { verifyPostgresMcpPortableHandleAttestation } from '../src/adapters/postgres-portable-handle-attestation.mjs';
import { sha256Ref } from '../src/canonical.mjs';
import { createDurableMcpPortableHandleRegistry } from '../src/mcp-portable-handle-boundary.mjs';

const enabled = process.env.RISK_FORK_REQUIRE_POSTGRES_TESTS === '1';
const url = process.env.RISK_FORK_TEST_POSTGRES_URL;

test('portable runtime role passes production attestation and cannot mutate protected state',
  { skip: !enabled }, async (t) => {
    assert.ok(url, 'RISK_FORK_TEST_POSTGRES_URL is required');
    const parsed = new URL(url);
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname));
    assert.match(parsed.pathname, /^\/[a-z0-9_]*test[a-z0-9_]*$/);
    const admin = new pg.Pool({ connectionString: url, max: 4 });
    const token = randomUUID().replaceAll('-', '').slice(0, 16);
    const schema = `portable_role_${token}`;
    const migrator = `portable_migrator_${token}`;
    const runtime = `portable_runtime_${token}`;
    const dbName = new URL(url).pathname.slice(1);
    const q = (sql, params = []) => admin.query(sql, params);
    const ident = (value) => `"` + value + `"`;
    let runtimePool;
    t.after(async () => {
      if (runtimePool) await runtimePool.end();
      await q(`DROP SCHEMA IF EXISTS ` + ident(schema) + ` CASCADE`);
      await q(`REVOKE CONNECT ON DATABASE ` + ident(dbName) + ` FROM ` + ident(runtime));
      await q(`DROP ROLE IF EXISTS ` + ident(runtime));
      await q(`DROP ROLE IF EXISTS ` + ident(migrator));
      await admin.end();
    });
    await q(`CREATE ROLE ` + ident(migrator) + ` NOLOGIN NOINHERIT`);
    await q(`CREATE ROLE ` + ident(runtime) + ` LOGIN NOINHERIT PASSWORD 'fixture-only-password'`);
    await q(`GRANT CONNECT ON DATABASE ` + ident(dbName) + ` TO ` + ident(runtime));
    await q(`REVOKE CREATE, TEMPORARY ON DATABASE ` + ident(dbName) + ` FROM PUBLIC`);
    await q(`REVOKE CREATE, TEMPORARY ON DATABASE ` + ident(dbName) + ` FROM ` + ident(runtime));
    await q(`CREATE SCHEMA ` + ident(schema) + ` AUTHORIZATION ` + ident(migrator));
    const migrationClient = await admin.connect();
    try {
      await migrationClient.query(`SET ROLE ` + ident(migrator));
      const source = (await readFile(new URL('../migrations/mcp-portable-handles/001_registry.pg.sql', import.meta.url), 'utf8')).replace(/\r\n?/g, '\n');
      const migration = source.replaceAll('__MCP_HANDLE_SCHEMA__', ident(schema));
      await migrationClient.query(migration);
      await migrationClient.query(`INSERT INTO ${ident(schema)}.handle_schema_migrations VALUES (1, $1)`, [sha256Ref(source)]);
      await migrationClient.query('RESET ROLE');
    } finally { migrationClient.release(); }
    await q(`REVOKE ALL ON ALL TABLES IN SCHEMA ` + ident(schema) + ` FROM PUBLIC`);
    await q(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ` + ident(schema) + ` FROM PUBLIC`);
    await q(`GRANT USAGE ON SCHEMA ` + ident(schema) + ` TO ` + ident(runtime));
    await q(`GRANT SELECT ON TABLE ` + ident(schema) + `.handle_schema_migrations TO ` + ident(runtime));
    await q(`GRANT SELECT, INSERT ON TABLE ` + ident(schema) + `.handle_namespaces TO ` + ident(runtime));
    await q(`GRANT UPDATE (max_entries) ON TABLE ` + ident(schema) + `.handle_namespaces TO ` + ident(runtime));
    await q(`GRANT SELECT, INSERT ON TABLE ` + ident(schema) + `.portable_handles TO ` + ident(runtime));
    await q(`GRANT UPDATE (consumption_count, revoked_at) ON TABLE ` + ident(schema) + `.portable_handles TO ` + ident(runtime));
    await q(`GRANT SELECT, INSERT ON TABLE ` + ident(schema) + `.handle_consumptions TO ` + ident(runtime));
    await q(`REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA ` + ident(schema) + ` FROM ` + ident(runtime));
    await q(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ` + ident(schema) + ` FROM ` + ident(runtime));
    const runtimeUrl = new URL(url);
    runtimeUrl.username = runtime;
    runtimeUrl.password = 'fixture-only-password';
    runtimePool = new pg.Pool({ connectionString: runtimeUrl.toString(), max: 2 });
    const client = await runtimePool.connect();
    try {
      const report = await verifyPostgresMcpPortableHandleAttestation(client, { schemaName: schema, deploymentMode: 'production', expectedOwner: migrator });
      assert.equal(report.catalog_verified, true);
      assert.equal(report.runtime_privileges_verified, true);
      await q(`GRANT UPDATE ON ${ident(schema)}.portable_handles TO ${ident(runtime)}`);
      await assert.rejects(verifyPostgresMcpPortableHandleAttestation(client,
        { schemaName: schema, deploymentMode: 'production', expectedOwner: migrator }));
      await q(`REVOKE UPDATE ON ${ident(schema)}.portable_handles FROM ${ident(runtime)}`);
      await q(`GRANT UPDATE (consumption_count, revoked_at) ON ${ident(schema)}.portable_handles TO ${ident(runtime)}`);
      await q(`GRANT UPDATE (binding) ON ${ident(schema)}.portable_handles TO ${ident(runtime)}`);
      await assert.rejects(verifyPostgresMcpPortableHandleAttestation(client,
        { schemaName: schema, deploymentMode: 'production', expectedOwner: migrator }));
      await q(`REVOKE UPDATE (binding) ON ${ident(schema)}.portable_handles FROM ${ident(runtime)}`);
      await q(`CREATE TABLE ${ident(schema)}.unreviewed(id integer)`);
      await assert.rejects(verifyPostgresMcpPortableHandleAttestation(client, { schemaName: schema }));
      await q(`DROP TABLE ${ident(schema)}.unreviewed`);
      await q(`CREATE FUNCTION ${ident(schema)}.unreviewed() RETURNS integer LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'`);
      await assert.rejects(verifyPostgresMcpPortableHandleAttestation(client, { schemaName: schema }));
      await q(`DROP FUNCTION ${ident(schema)}.unreviewed()`);
      await q(`GRANT UPDATE ON ${ident(schema)}.handle_namespaces TO ${ident(runtime)}`);
      await assert.rejects(verifyPostgresMcpPortableHandleAttestation(client,
        { schemaName: schema, deploymentMode: 'production', expectedOwner: migrator }));
      await q(`REVOKE UPDATE ON ${ident(schema)}.handle_namespaces FROM ${ident(runtime)}`);
      await q(`GRANT UPDATE (max_entries) ON ${ident(schema)}.handle_namespaces TO ${ident(runtime)}`);
      await q(`GRANT EXECUTE ON FUNCTION ${ident(schema)}.reject_handle_history_mutation() TO ${ident(runtime)}`);
      await assert.rejects(verifyPostgresMcpPortableHandleAttestation(client,
        { schemaName: schema, deploymentMode: 'production', expectedOwner: migrator }));
      await q(`REVOKE EXECUTE ON FUNCTION ${ident(schema)}.reject_handle_history_mutation() FROM ${ident(runtime)}`);
      await q(`ALTER FUNCTION ${ident(schema)}.protect_handle_binding() SECURITY DEFINER`);
      await assert.rejects(verifyPostgresMcpPortableHandleAttestation(client, { schemaName: schema }));
      await q(`ALTER FUNCTION ${ident(schema)}.protect_handle_binding() SECURITY INVOKER`);
      await assert.rejects(client.query(`CREATE TABLE ` + ident(schema) + `.denied(id integer)`));
      await assert.rejects(client.query(`DELETE FROM ` + ident(schema) + `.handle_consumptions`));
      await assert.rejects(client.query(`TRUNCATE ` + ident(schema) + `.portable_handles`));
      await assert.rejects(client.query(`UPDATE ` + ident(schema) + `.handle_schema_migrations SET version=1`));
      await assert.rejects(client.query(`SELECT ` + ident(schema) + `.reject_handle_history_mutation()`));
    } finally { client.release(); }
    await assert.rejects(createPostgresMcpPortableHandleStore({ pool: runtimePool, schemaName: schema, requireTls: false, deploymentMode: 'production', expectedOwner: migrator }));
    const store = await createPostgresMcpPortableHandleStore({ pool: runtimePool, schemaName: schema, requireTls: false, deploymentMode: 'local_test' });
    const registry = createDurableMcpPortableHandleRegistry({ store, tenant_ref: 'tenant:role-test',
      key_id: 'key:role-test', hash_key: Buffer.alloc(32, 89), max_entries: 2 });
    const handle = 'runtime_handle_0123456789abcdef';
    const principal = sha256Ref('runtime:principal');
    const binding = await registry.register({ handle_value: handle, principal_ref: principal,
      issuer: 'https://issuer.fixture.invalid/', audience: 'https://mcp.fixture.invalid/rpc',
      mcp_server_origin: 'https://mcp.fixture.invalid', originating_method: 'tools/call',
      originating_request_hash: sha256Ref('runtime:origin'), allowed_consuming_methods: ['tools/call'],
      ttl_ms: 60_000, single_use: true, max_consumptions: 1 });
    const receipt = await registry.authorize({ handle_value: handle, binding, principal_ref: principal,
      issuer: binding.issuer, audience: binding.audience, mcp_server_origin: binding.mcp_server_origin,
      originating_method: binding.originating_method, originating_request_hash: binding.originating_request_hash,
      consuming_method: 'tools/call', consuming_request_hash: sha256Ref('runtime:consume') });
    assert.equal(receipt.transferable, false);
    registry.close();
    await store.close();
  });
