import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyPostgresRequestPolicyAttestation } from '../src/postgres-request-policy-attestation.mjs';
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
