import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { verifyPostgresMcpPortableHandleAttestation } from '../src/adapters/postgres-portable-handle-attestation.mjs';

test('portable attestation is read-only and fails closed on ambiguous catalog results', async () => {
  const queries = [];
  const client = { async query(sql) { queries.push(sql); return { rowCount: 0, rows: [] }; } };
  await assert.rejects(verifyPostgresMcpPortableHandleAttestation(client));
  assert.equal(queries.some((sql) => /^\s*(CREATE|ALTER|DROP|GRANT|REVOKE)\b/i.test(sql)), false);
});

test('portable role template contains only reviewed runtime grants', async () => {
  const sql = await readFile(new URL('../ops/postgres/mcp-portable-handles-roles.sql.template', import.meta.url), 'utf8');
  assert.doesNotMatch(sql, /GRANT\s+ALL/i);
  assert.doesNotMatch(sql, /GRANT SELECT, INSERT, UPDATE ON TABLE/);
  assert.match(sql, /GRANT UPDATE \(consumption_count, revoked_at\) ON TABLE __MCP_HANDLE_SCHEMA__\.portable_handles/);
  assert.match(sql, /REVOKE CREATE, TEMPORARY ON DATABASE/);
  assert.match(sql, /REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES/);
});
