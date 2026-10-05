import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyPostgresRequestPolicyAttestation } from '../src/postgres-request-policy-attestation.mjs';
import { PostgresManagedRequestPolicyStore } from '../src/postgres-request-policy-store.mjs';
import { policyCatalogQuery, policyManifest } from './helpers/request-policy-catalog-fixture.mjs';

function fixture(catalog = policyManifest.catalog) {
  return { async query(sql, values) {
    if (sql.includes("current_setting('server_version_num')")) return { rowCount: 1,
      rows: [{ version: 160015, fsync: 'on', sync: 'on', triggers: 'origin' }] };
    const result = policyCatalogQuery(sql, values, catalog);
    if (!result) throw new Error('Unexpected test query');
    return result;
  } };
}
test('policy source catalog checks exact PG16 baseline, including internal FK triggers', async () => {
  assert.deepEqual(await verifyPostgresRequestPolicyAttestation(fixture()), {
    schema_name: 'risk_fork_request_policy', catalog_verified: true, runtime_privileges_verified: false, production_qualified: false,
  });
  for (const key of Object.keys(policyManifest.catalog)) {
    const catalog = structuredClone(policyManifest.catalog);
    if (catalog[key].length) catalog[key][0].synthetic_drift = true;
    else catalog[key].push({ synthetic_drift: true });
    await assert.rejects(verifyPostgresRequestPolicyAttestation(fixture(catalog)), { code: 'POLICY_POSTGRES_ATTESTATION_FAILED' }, key);
  }
  const disabled = structuredClone(policyManifest.catalog); disabled.internal_triggers[0].tgenabled = 'D';
  await assert.rejects(verifyPostgresRequestPolicyAttestation(fixture(disabled)), { code: 'POLICY_POSTGRES_ATTESTATION_FAILED' });
});
test('policy attestation closes options, rejects unsafe settings and redacts query failures', async () => {
  for (const options of [null, [], { extra: true }, { schemaName: 'Invalid-Name' }, { expectedOwner: '' },
    { expectedOwner: null }, { expectedManifest: policyManifest }]) {
    await assert.rejects(verifyPostgresRequestPolicyAttestation(fixture(), options), { code: 'POLICY_POSTGRES_ATTESTATION_FAILED' });
  }
  const privateDetail = 'private connection credential';
  await assert.rejects(verifyPostgresRequestPolicyAttestation({ query() { throw new Error(privateDetail); } }),
    (error) => error.code === 'POLICY_POSTGRES_ATTESTATION_FAILED' && !JSON.stringify(error).includes(privateDetail) && !error.message.includes(privateDetail));
  for (const settings of [{ version: 170000 }, { fsync: 'off' }, { sync: 'off' }, { triggers: 'replica' }]) {
    const client = fixture(); const query = client.query.bind(client);
    client.query = (sql, values) => sql.includes("current_setting('server_version_num')")
      ? { rowCount: 1, rows: [{ version: 160015, fsync: 'on', sync: 'on', triggers: 'origin', ...settings }] } : query(sql, values);
    await assert.rejects(verifyPostgresRequestPolicyAttestation(client), { code: 'POLICY_POSTGRES_ATTESTATION_FAILED' });
  }
});
test('catalog drift before or during clock acquisition rolls back before policy reads/writes', async () => {
  for (const point of ['before_clock', 'after_clock']) {
    const catalog = structuredClone(policyManifest.catalog);
    if (point === 'before_clock') catalog.relations[0].kind = 'v';
    const reader = fixture(catalog), events = [];
    const client = { release() { events.push('release'); }, async query(sql, values) {
      events.push(sql);
      if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql.startsWith('SET LOCAL')) return { rows: [], rowCount: 0 };
      if (sql.startsWith('SELECT last_seen_ms')) {
        // Simulate a catalog change during the clock wait. The repeated check,
        // not just preflight, must reject it before configuration or writes.
        catalog.relations[0].kind = 'v';
        return { rows: [{ last_seen_ms: '0' }], rowCount: 1 };
      }
      return reader.query(sql, values);
    } };
    const quotas = Object.fromEntries(['admission', 'execution', 'cleanup', 'recovery', 'read'].map((route) => [route,
      { windowMs: 60000, perKey: 3, perTenant: 5, maxSubjects: 20 }]));
    const store = new PostgresManagedRequestPolicyStore({ pool: { connect: async () => client }, quotas, requireTls: false, disposableDb: true });
    await assert.rejects(store.readControl(), { code: 'POLICY_UNAVAILABLE' });
    assert.equal(events.filter((sql) => sql.startsWith('SELECT last_seen_ms')).length, point === 'before_clock' ? 0 : 1);
    assert.equal(events.some((sql) => sql.startsWith('SELECT enabled') || sql.startsWith('UPDATE') || sql.startsWith('INSERT')), false);
    assert.deepEqual(events.slice(-2), ['ROLLBACK', 'release']);
    await store.close();
  }
});
