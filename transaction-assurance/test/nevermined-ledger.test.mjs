import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  normalizeNeverminedLedger as normalize, normalizeNeverminedExport,
  NEVERMINED_PROFILE_ID, NEVERMINED_PROFILE_DIGEST,
  parseNeverminedJson as parse, canonicalNeverminedJson as jcs,
  renderNeverminedReport,
} from '../src/adapters/nevermined-ledger.mjs';
import { neverminedExitCode } from '../src/adapters/nevermined-cli.mjs';
const base = path.dirname(fileURLToPath(import.meta.url));
const example = path.join(base, '../examples/nevermined/7c3e0c1');
const fixture = () => JSON.parse(fs.readFileSync(path.join(example, 'synthetic-import.json'), 'utf8'));
const withRaw = (changes) => { const input = fixture(); Object.assign(input.record.raw, changes); return input; };
const code = (expected) => (error) => error?.code === expected;

// Negative fixtures first: parsing cannot erase ambiguous syntax before normalization.
for (const [name, input, expected] of [
  ['duplicate root keys', '{"x":1,"x":2}', 'duplicate_key'],
  ['duplicate nested keys', '{"nested":{"x":1,"x":2}}', 'duplicate_key'],
  ['escaped duplicate keys', '{"x":1,"\\u0078":2}', 'duplicate_key'],
  ['prototype keys', '{"__proto__":{}}', 'unsafe_key'],
  ['trailing tokens', '{} true', 'invalid_json'],
  ['trailing comma', '[1,]', 'invalid_json'],
  ['lone surrogate', '"\\ud800"', 'invalid_unicode'],
  ['non-finite number', '1e400', 'unsafe_number'],
  ['unsafe integer', '9007199254740993', 'unsafe_number'],
  ['leading zero literal', '01', 'invalid_json'],
  ['bad escape', '"\\q"', 'invalid_json'],
  ['expression', 'process.env', 'invalid_json'],
  ['oversize JSON', ' '.repeat(1048577), 'input_too_large'],
  ['oversize string', JSON.stringify('x'.repeat(65537)), 'limit_exceeded'],
  ['too many entries', JSON.stringify(Array(1001).fill(0)), 'limit_exceeded'],
  ['too deep', '['.repeat(33) + '0' + ']'.repeat(33), 'limit_exceeded'],
]) test(name, () => assert.throws(() => parse(input), code(expected)));

test('invalid UTF-8 and BOM are rejected consistently', () => {
  assert.throws(() => parse(Buffer.from([0xc3, 0x28])), code('invalid_utf8'));
  for (const input of ['\ufeff{}', Buffer.from('\ufeff{}')]) assert.throws(() => parse(input), code('invalid_json'));
});
test('valid Unicode, escapes, 32 levels and literals parse', () => {
  assert.equal(parse('"\\ud83d\\ude00"'), '😀');
  assert.equal(parse('"a\\\\\\\"b"'), 'a\\"b');
  assert.equal(parse('null'), null); assert.equal(parse('true'), true);
  assert.doesNotThrow(() => parse('['.repeat(32) + '0' + ']'.repeat(32)));
});
test('JCS sorts numeric-looking and Unicode keys by UTF-16 without normalization', () => {
  assert.equal(jcs(parse('{"2":0,"10":0,"1":0}')), '{"1":0,"10":0,"2":0}');
  assert.equal(jcs(parse('{"דּ":0,"😀":0,"€":0,"ö":0,"1":0,"\\r":0}')), '{"\\r":0,"1":0,"ö":0,"€":0,"😀":0,"דּ":0}');
  assert.notEqual(jcs(parse('"é"')), jcs(parse('"e\\u0301"')));
  assert.equal(jcs(parse('{"a":-0,"b":1e-7,"c":4.50}')), '{"a":0,"b":1e-7,"c":4.5}');
});
test('JS input getters, proxies and toJSON are not executed', () => {
  let calls = 0; const value = fixture();
  Object.defineProperty(value.record.raw, 'id', { enumerable: true, get() { calls++; return 'unsafe'; } });
  assert.throws(() => normalize(value), code('invalid_input')); assert.equal(calls, 0);
  assert.throws(() => normalize(new Proxy({}, { ownKeys() { calls++; return []; } })), code('invalid_input'));
  assert.throws(() => normalize({ toJSON() { calls++; return fixture(); } }), code('invalid_input'));
  assert.equal(calls, 0);
});
test('cycles and sparse arrays reject', () => {
  const input = fixture(); input.record.raw.loop = input;
  assert.throws(() => normalize(input), code('limit_exceeded'));
  input.record.raw.loop = Array(3); assert.throws(() => normalize(input), code('invalid_input'));
});
test('caller-supplied settled status never self-verifies', () => {
  const result = normalize(fixture());
  assert.equal(result.assessment.parse_status, 'accepted');
  assert.equal(result.core.merchant_payment.provider_status, 'Settled');
  assert.equal(result.assessment.overall_evidence_status, 'unresolved');
  assert.deepEqual(result.assessment.independent_settlement, { provenance: 'reported_observation', chain_status: 'not_checked', matching_status: 'not_checked', evidence_ref: null });
  assert.equal(result.assessment.authority, 'not_checked'); assert.equal(result.assessment.outcome, 'not_checked');
  assert.equal(result.core.authority_refs.principal_ref, null);
  assert.equal(result.core.authority_refs.agent_ref, null);
});
test('all identifiers, timestamps, originals and separate fee units survive', () => {
  const source = fixture(); const c = normalize(source).core;
  assert.equal(c.identifiers.request_id, source.record.raw.requestId);
  assert.equal(c.authority_refs.delegation_ref, source.record.raw.delegationId);
  assert.equal(c.merchant_payment.created_at, source.record.raw.createdAt);
  assert.equal(c.merchant_payment.amount_atomic, '10000');
  assert.equal(c.merchant_payment.amount_display, '0.01');
  assert.equal(c.original.network, 'base'); assert.equal(c.merchant_payment.network, 'eip155:8453');
  assert.equal(c.fee_legs[0].amount_atomic, '200'); assert.equal(c.fee_legs[0].budget_cents, '0');
  assert.equal(c.fee_legs[0].settlement_ref, null); assert.equal(c.fee_legs[0].authorization_nonce, source.record.raw.feeNonce);
});
test('exact money never rounds or uses a float', () => {
  const r = normalize(withRaw({ amount: '9'.repeat(78), assetDecimals: 30 }));
  assert.equal(r.core.merchant_payment.amount_atomic, '9'.repeat(78));
  assert.equal(r.core.merchant_payment.amount_display, '9'.repeat(48) + '.' + '9'.repeat(30));
  assert.equal(normalize(withRaw({ amount: '0001000', assetDecimals: 0 })).core.merchant_payment.amount_display, '1000');
  assert.throws(() => normalize(withRaw({ amount: '9'.repeat(79) })), code('limit_exceeded'));
});
for (const value of [null, 1000, '1.1', '1e3', '-2', true, '']) test(`amount ${JSON.stringify(value)} remains uncheckable`, () => {
  const r = normalize(withRaw({ amount: value }));
  assert.equal(r.core.merchant_payment.amount_atomic, null);
  assert.equal(r.core.original.amount, value);
  assert.equal(r.assessment.amount_reconciliation.ledger_amount, 'not_checked');
});
for (const value of [null, '6', -1, 31, 1.5, true]) test(`scale ${JSON.stringify(value)} is not guessed`, () => {
  const r = normalize(withRaw({ assetDecimals: value }));
  assert.equal(r.core.merchant_payment.decimals, null); assert.equal(r.core.merchant_payment.amount_display, null);
});
for (const values of [{ protocol: 'mpp' }, { network: 'solana' }, { asset: 'EURC' }, { network: 'toString' }]) test(`unsupported ${JSON.stringify(values)} is preserved`, () => {
  const r = normalize(withRaw(values));
  assert.equal(r.assessment.overall_evidence_status, 'unsupported');
  assert.equal(r.assessment.independent_settlement.chain_status, 'not_checked');
  for (const [k, v] of Object.entries(values)) assert.equal(r.core.original[k], v);
});
test('opaque processor and abbreviated hashes are not chain hashes', () => {
  assert.equal(normalize(withRaw({ txHash: 'pi_synthetic' })).core.merchant_payment.settlement_ref_kind, 'opaque');
  assert.equal(normalize(withRaw({ txHash: '0x123…' })).core.merchant_payment.settlement_ref_kind, 'abbreviated');
  assert.equal(normalize(withRaw({ status: 'constructor' })).core.merchant_payment.status_family, 'unknown');
});
test('unknown profiles preserve projected digest, not guessed identifiers', () => {
  const input = fixture(); input.source.schema_revision = 'unknown';
  const r = normalize(input); assert.equal(r.assessment.overall_evidence_status, 'unsupported');
  assert.equal(r.core.identity.payment_identity_key, null); assert.equal(r.core.identifiers.payment_id, null);
  assert.equal(r.core.original.id, input.record.raw.id);
  input.source.schema_revision = fixture().source.schema_revision; input.profile_digest = 'sha256:' + '0'.repeat(64);
  assert.throws(() => normalize(input), code('profile_digest_mismatch'));
});
test('pin and namespace cannot be omitted or silently overridden', () => {
  const input = fixture(); delete input.source.namespace;
  assert.throws(() => normalize(input), code('invalid_envelope'));
  assert.throws(() => normalize(fixture(), { profileId: 'wrong' }), code('profile_id_mismatch'));
});
test('immutable core excludes capture metadata and history-dependent assessment', () => {
  const input = fixture(); const first = normalize(input);
  const later = fixture(); later.source.captured_at = '2026-09-10T00:00:00Z'; later.source.record_ref = 'another:local-capture';
  const duplicate = normalize(later, { history: [input] });
  assert.equal(duplicate.assessment.import_disposition, 'duplicate');
  assert.equal(jcs(first.core), jcs(duplicate.core));
  assert.notDeepEqual(first.observation_context, duplicate.observation_context);
  assert(Object.isFrozen(first.core));
});
test('namespace prevents unrelated payment IDs from colliding', () => {
  const a = fixture(); const b = fixture(); b.source.namespace = 'synthetic:other';
  assert.notEqual(normalize(a).core.identity.payment_identity_key, normalize(b).core.identity.payment_identity_key);
  assert.equal(normalize(b, { history: [a] }).assessment.import_disposition, 'new');
});
test('compatible snapshot is an update, preserving prior reference', () => {
  const prior = withRaw({ status: 'Issued', txHash: null });
  const result = normalize(fixture(), { history: [prior] });
  assert.equal(result.assessment.import_disposition, 'update');
  assert.equal(result.assessment.overall_evidence_status, 'unresolved');
  assert.equal(result.assessment.prior_observation_keys.length, 1);
});
test('actual incompatible supplied claims are never overwritten by missing delivery', () => {
  const result = normalize(withRaw({ amount: '20000' }), { history: [fixture()] });
  assert.equal(result.assessment.import_disposition, 'conflict');
  assert.equal(result.assessment.overall_evidence_status, 'contradicted');
  assert(result.assessment.conflicts.includes('amount_atomic'));
  assert.equal(result.assessment.outcome, 'not_checked');
  assert.equal(result.assessment.independent_settlement.chain_status, 'not_checked');
});
test('conflict survives duplicates and permutations of supplied history', () => {
  const good = fixture(); const bad = withRaw({ status: 'Failed' });
  for (const history of [[good, bad], [bad, good]]) {
    const r = normalize(good, { history });
    assert.equal(r.assessment.import_disposition, 'conflict'); assert.equal(r.assessment.overall_evidence_status, 'contradicted');
  }
});
test('absence in an older snapshot is not contradictory evidence', () => {
  const r = normalize(withRaw({ txHash: null }), { history: [fixture()] });
  assert.equal(r.assessment.import_disposition, 'update'); assert.equal(r.assessment.overall_evidence_status, 'unresolved');
});
test('history must be raw, bounded evidence; claimed checks cannot promote', () => {
  assert.throws(() => normalize(fixture(), { history: [normalize(fixture())] }), code('invalid_envelope'));
  const injected = fixture(); injected.independent_settlement = { chain_status: 'settled' };
  assert.throws(() => normalize(injected), code('invalid_envelope'));
  const r = normalize(withRaw({ settlement_confirmed: true, authority: 'verified' }));
  assert.equal(r.assessment.authority, 'not_checked'); assert(!hasOwn(r.core.original, 'settlement_confirmed'));
});
function hasOwn(value, key) { return Object.hasOwn(value, key); }
test('batch detects duplicates and conflicts on all affected observations', () => {
  const input = fixture(); input.record.raw = [fixture().record.raw, fixture().record.raw];
  assert.deepEqual(normalizeNeverminedExport(input).records.map((r) => r.assessment.import_disposition), ['new', 'duplicate']);
  input.record.raw.push(withRaw({ amount: '777' }).record.raw);
  assert(normalizeNeverminedExport(input).records.every((r) => r.assessment.import_disposition === 'conflict'));
});
test('redaction occurs before digest, output, and human reporting', () => {
  const input = withRaw({ apiKey: 'SECRET_CANARY_ONE', feeFailureReason: 'SECRET_CANARY_ONE', extra: { prompt: 'SECRET_CANARY_ONE' }, resourceUrl: 'https://user:SECRET_CANARY_ONE@service.example/path?token=SECRET_CANARY_ONE#SECRET_CANARY_ONE' });
  const a = normalize(input); const json = JSON.stringify(a) + renderNeverminedReport(a);
  assert(!json.includes('SECRET_CANARY_ONE')); assert(!json.includes('user:'));
  const changed = JSON.parse(JSON.stringify(input).replaceAll('SECRET_CANARY_ONE', 'SECRET_CANARY_TWO'));
  assert.equal(a.core.source.redacted_source_hash, normalize(changed).core.source.redacted_source_hash);
  assert.equal(a.core.merchant_payment.resource_url, 'https://service.example/path');
});
test('recognized secrets in allowed fields reject without echoing', () => {
  const token = 'Bearer TEST_ONLY_NEVER_A_REAL_TOKEN';
  let error; try { normalize(withRaw({ id: token })); } catch (e) { error = e; }
  assert.equal(error.code, 'secret_in_evidence_field'); assert(!String(error).includes(token));
});
test('vendor fixture is unchanged and never labeled observed', () => {
  const original = fs.readFileSync(path.join(example, 'vendor-docs-example.json'));
  const provenance = JSON.parse(fs.readFileSync(path.join(example, 'provenance.json')));
  assert.equal(provenance.fixture_hash, 'sha256:' + createHash('sha256').update(original).digest('hex'));
  assert.equal(provenance.observed_transaction, false); assert.equal(provenance.sanitized_real_export, false);
  const input = fixture(); input.record.raw = JSON.parse(original)[0];
  const r = normalize(input); assert.equal(r.core.identity.payment_identity_key, null);
  assert.equal(r.core.merchant_payment.settlement_ref_kind, 'abbreviated');
  assert.equal(r.assessment.independent_settlement.chain_status, 'not_checked');
});
test('golden Stage A report and profile digest are reproducible', () => {
  assert.equal(jcs(normalize(fixture())), jcs(JSON.parse(fs.readFileSync(path.join(example, 'synthetic-expected.json')))));
  assert.match(NEVERMINED_PROFILE_DIGEST, /^sha256:[a-f0-9]{64}$/);
  const reordered = fixture(); reordered.record.raw = Object.fromEntries(Object.entries(reordered.record.raw).reverse());
  assert.equal(jcs(normalize(fixture()).core), jcs(normalize(reordered).core));
});
test('CLI strict precedence and default unresolved are explicit', () => {
  const states = ['unresolved', 'unsupported', 'contradicted'].map((state) => ({ assessment: { overall_evidence_status: state } }));
  assert.equal(neverminedExitCode(states), 0);
  assert.equal(neverminedExitCode(states, ['unresolved', 'unsupported', 'contradicted']), 3);
  assert.equal(neverminedExitCode(states, ['unresolved', 'unsupported']), 4);
  assert.equal(neverminedExitCode(states, ['unresolved']), 2);
});
test('actual CLI import works with network and DNS disabled before imports', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nevermined-stage-a-'));
  try {
    const cli = path.join(base, '../bin/agora-assure.mjs');
    const loader = path.join(base, 'fixtures/nevermined-no-network-preload.mjs');
    const args = ['--import', loader, cli, 'nevermined', 'import', '--input', path.join(example, 'synthetic-import.json'), '--profile', NEVERMINED_PROFILE_ID];
    const call = (extra = []) => spawnSync(process.execPath, [...args, ...extra], { encoding: 'utf8', env: { ...process.env, NVM_API_KEY: 'NEVERMINED_ENV_SECRET_CANARY' }, timeout: 10000 });
    const result = call(); assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).records[0].assessment.overall_evidence_status, 'unresolved');
    assert(!result.stdout.includes('NEVERMINED_ENV_SECRET_CANARY')); assert(!result.stderr.includes('NEVERMINED_ENV_SECRET_CANARY'));
    assert.equal(call(['--fail-on', 'unresolved']).status, 2);
    const output = path.join(temp, 'result.json'); assert.equal(call(['--output', output]).status, 0);
    assert.equal(call(['--output', output]).status, 64); // Never clobber a prior report.
    const gated = spawnSync(process.execPath, [cli, 'nevermined', 'attach-settlement'], { encoding: 'utf8' });
    assert.equal(gated.status, 64); assert(gated.stderr.includes('stage_b_gated'));
    const bad = path.join(temp, 'bad.json'); fs.writeFileSync(bad, '{"api_key":"SECRET_CANARY","api_key":1}');
    const invalid = spawnSync(process.execPath, [cli, 'nevermined', 'import', '--input', bad, '--profile', NEVERMINED_PROFILE_ID], { encoding: 'utf8' });
    assert.equal(invalid.status, 64); assert.equal(invalid.stdout, ''); assert(!invalid.stderr.includes('SECRET_CANARY'));
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('blank or whitespace-bearing payment identifiers never establish identity', () => {
  for (const id of [' ', ' payment-1', 'payment 1', 'x'.repeat(257)]) {
    const result = normalize(withRaw({ id }));
    assert.equal(result.core.identity.payment_identity_key, null);
    assert.equal(result.core.identifiers.payment_id, id);
    assert.equal(result.assessment.parse_status, 'incomplete');
  }
});
