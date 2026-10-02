import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UPSTREAM, ROLES, buildOpenShellPlan, validateOpenShellPlan, summarizeOpenShellObservation, openShellReadiness, OpenShellScaffoldAdapter } from './scaffold.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixture.json', import.meta.url), 'utf8'));
const fresh = () => structuredClone(fixture);
const plan = () => buildOpenShellPlan(fresh());
const rejects = (input, code) => assert.throws(() => buildOpenShellPlan(input), { code });

for (const role of ROLES) {
  test(`${role}: offline, authority-free, immutable plan`, () => {
    const input = { ...fresh(), role, readEndpoints: [] };
    const result = buildOpenShellPlan(input);
    assert.equal(result.status, 'offline_proposal');
    assert.ok(Object.values(result.authority).every((value) => value === false));
    assert.deepEqual(result.createSpec.command, ['/bin/true']);
    assert.deepEqual(result.createSpec.providers, []);
    assert.deepEqual(result.createSpec.environment, {});
    assert.deepEqual(result.createSpec.serviceExposures, []);
    assert.equal(result.hostRequirements.deadlineEnforced, false);
    assert.equal(result.hostRequirements.ownerApprovalRequired, true);
    assert.throws(() => { result.createSpec.policy.filesystem.readWrite.push('/'); }, TypeError);
    assert.deepEqual(validateOpenShellPlan(JSON.parse(JSON.stringify(result))), result);
    input.readEndpoints.push({ host: 'changed.example.com', paths: ['/'] });
    assert.equal(result.request.readEndpoints.length, 0);
  });
}

test('cartographer emits exact GET/HEAD rules with explicit enforcement, no credential/IP escape hatch', () => {
  const policy = plan().createSpec.policy;
  assert.equal(policy.landlock.compatibility, 'hard_requirement');
  assert.equal(policy.filesystem.includeWorkdir, false);
  assert.deepEqual(policy.filesystem.readWrite, ['/sandbox/output', '/tmp']);
  assert.deepEqual(policy.process, { runAsUser: 'sandbox', runAsGroup: 'sandbox' });
  const rule = policy.networkPolicies.read_0;
  assert.deepEqual(rule.binaries, [{ path: '/usr/bin/curl' }]);
  const item = rule.endpoints[0];
  assert.equal(item.enforcement, 1);
  assert.equal(item.protocol, 'rest');
  assert.equal(item.tls, 0);
  assert.equal(item.port, 443);
  assert.ok(item.rules.every(({ allow }) => ['GET', 'HEAD'].includes(allow.method)));
  assert.deepEqual(Object.keys(item).sort(), ['host', 'port', 'protocol', 'tls', 'enforcement', 'rules'].sort());
});

test('deterministic normalization and digest binds all policy and host-limit inputs', () => {
  const a = fresh();
  a.readEndpoints.push({ host: 'a.example.com', paths: ['/z', '/a', '/a'] });
  const b = fresh();
  b.readEndpoints.unshift({ host: 'a.example.com', paths: ['/a', '/z'] });
  assert.deepEqual(buildOpenShellPlan(a), buildOpenShellPlan(b));
  const c = { ...b, maxRuntimeSeconds: 61 };
  assert.notEqual(buildOpenShellPlan(c).planDigest, buildOpenShellPlan(b).planDigest);
  assert.equal(buildOpenShellPlan(c).policyDigest, buildOpenShellPlan(b).policyDigest);
});

test('optional omitted fields use bounded defaults, not permissive policy', () => {
  const input = fresh();
  delete input.readEndpoints;
  delete input.maxRuntimeSeconds;
  const result = buildOpenShellPlan(input);
  assert.deepEqual(result.createSpec.policy.networkPolicies, {});
  assert.equal(result.hostRequirements.maxRuntimeSeconds, 60);
});

for (const host of ['127.0.0.1', '169.254.169.254', '::1', '[::1]', '2130706433', '0177.0.0.1', '0x7f000001', 'localhost', 'foo.localhost', 'metadata.internal', 'foo.local', 'foo.lan', 'foo.onion', '*.example.com', '**.example.com', 'https://example.com', 'user@example.com', 'example.com:443', 'example.com.', 'EXAMPLE.com', 'exämple.com', 'example.com\n', 'a..example.com']) {
  test(`reject hostname ${JSON.stringify(host)}`, () => {
    rejects({ ...fresh(), readEndpoints: [{ host, paths: ['/'] }] }, 'invalid_public_hostname');
  });
}
for (const path of ['/*', '/**', '//evil', '/x//y', '/../x', '/a/./b', '/a/../b', '/%2e%2e/x', '/x%2fy', '/x?token=secret', '/x#fragment', '/x\\y', '/x\n', 'relative', 7, null]) {
  test(`reject path ${JSON.stringify(path)}`, () => {
    rejects({ ...fresh(), readEndpoints: [{ host: 'docs.example.com', paths: [path] }] }, 'invalid_exact_path');
  });
}
for (const value of [0, -1, 301, 1.5, '60', null, true]) {
  test(`reject runtime limit ${JSON.stringify(value)}`, () => rejects({ ...fresh(), maxRuntimeSeconds: value }, 'invalid_runtime_limit'));
}
for (const field of ['enabled', 'approved', 'providers', 'environment', 'rawSpec', 'policy', 'command', 'gateway', 'token', 'filesystem']) {
  test(`deny unrecognized authority/override field ${field}`, () => rejects({ ...fresh(), [field]: true }, 'unknown_field'));
}
for (const role of ['emissary', 'steward']) {
  test(`${role} cannot inherit cartographer egress`, () => rejects({ ...fresh(), role }, 'role_egress_denied'));
}
for (const image of ['ubuntu:latest', 'ubuntu', 'repo/name@sha256:abc', 'repo/name@sha256:' + 'A'.repeat(64), 'repo/name@sha256:' + '1'.repeat(64) + '\n']) {
  test(`reject unpinned/noncanonical image ${JSON.stringify(image)}`, () => rejects({ ...fresh(), image }, 'digest_pinned_image_required'));
}

test('reject duplicate hosts, excessive endpoints, null endpoints and empty path lists', () => {
  rejects({ ...fresh(), readEndpoints: [fixture.readEndpoints[0], fixture.readEndpoints[0]] }, 'duplicate_host');
  rejects({ ...fresh(), readEndpoints: Array(17).fill(fixture.readEndpoints[0]) }, 'invalid_endpoints');
  rejects({ ...fresh(), readEndpoints: null }, 'invalid_endpoints');
  rejects({ ...fresh(), readEndpoints: [{ host: 'example.com', paths: [] }] }, 'invalid_paths');
  rejects({ ...fresh(), readEndpoints: [{ host: 'example.com', paths: ['/'], allowedIps: ['10.0.0.1'] }] }, 'unknown_field');
});

test('reject invalid schema, missing fields, role and identifiers', () => {
  rejects({ ...fresh(), schema: 'unknown' }, 'unsupported_request_schema');
  const input = fresh(); delete input.image;
  rejects(input, 'missing_field');
  rejects({ ...fresh(), role: 'admin' }, 'unsupported_role');
  for (const runId of ['../x', '', 'a'.repeat(25), 'a\n', '--option']) rejects({ ...fresh(), runId }, 'invalid_identifier');
});

test('reject non-data objects, accessors without invoking them, cyclic and hostile keys', () => {
  rejects(new Date(), 'plain_object_required');
  let touched = false;
  const input = fresh();
  Object.defineProperty(input, 'token', { enumerable: true, get() { touched = true; return 'secret'; } });
  rejects(input, 'accessor_or_hidden_field_denied');
  assert.equal(touched, false);
  const cyclic = fresh(); cyclic.extra = cyclic;
  rejects(cyclic, 'cyclic_input');
  rejects(JSON.parse('{"__proto__":{"polluted":true}}'), 'unsafe_key');
  rejects({ ...fresh(), extra: () => true }, 'json_data_required');
  rejects({ ...fresh(), extra: Infinity }, 'json_data_required');
  rejects({ ...fresh(), readEndpoints: Array(2) }, 'sparse_array_denied');
  assert.equal({}.polluted, undefined);
});

test('reject edited, extended, and authority-bearing serialized plans', () => {
  for (const change of [
    (p) => { p.authority.execution = true; },
    (p) => { p.createSpec.policy.networkPolicies.read_0.endpoints[0].enforcement = 0; },
    (p) => { p.createSpec.rawSpec = { policy: {} }; },
    (p) => { p.extra = true; },
    (p) => { p.planDigest = 'sha256:' + '0'.repeat(64); },
  ]) {
    const changed = structuredClone(plan()); change(changed);
    assert.throws(() => validateOpenShellPlan(changed), { code: 'plan_mismatch' });
  }
});

for (const [exitCode, expected] of [[0, 'reported_success'], [1, 'reported_failure'], [137, 'reported_failure']]) {
  test(`execution report ${exitCode} remains unverified`, () => {
    const report = summarizeOpenShellObservation(plan(), 'sandbox-123', { kind: 'exec', sandboxId: 'sandbox-123', exitCode });
    assert.equal(report.reportedStatus, expected);
    assert.equal(report.verified, false);
    assert.equal(report.settlementProof, false);
    assert.equal(report.executionAuthority, false);
    assert.equal(report.evidenceClass, 'caller_reported_unverified');
  });
}
for (const exitCode of [undefined, null, '', '0', -1, 256, 0.5, false]) {
  test(`missing/invalid terminal exit ${String(exitCode)} is not success`, () => {
    const report = { kind: 'exec', sandboxId: 'sandbox-123' };
    if (exitCode !== undefined) report.exitCode = exitCode;
    assert.throws(() => summarizeOpenShellObservation(plan(), 'sandbox-123', report), { code: 'terminal_exit_code_required' });
  });
}
for (const [outcome, status] of [['completed', 'reported_completed'], ['accepted', 'reported_pending'], ['already_absent', 'reported_absent_unverified'], ['unspecified', 'unknown'], ['unknown', 'unknown']]) {
  test(`deletion ${outcome} preserves pending/uncertainty`, () => {
    const result = summarizeOpenShellObservation(plan(), 'original-id', { kind: 'delete', sandboxId: 'original-id', outcome });
    assert.equal(result.reportedStatus, status);
    assert.equal(result.verified, false);
  });
}

test('observations cannot change identity, carry raw logs, or mix terminal types', () => {
  assert.throws(() => summarizeOpenShellObservation(plan(), 'original', { kind: 'exec', sandboxId: 'replacement', exitCode: 0 }), { code: 'sandbox_identity_mismatch' });
  assert.throws(() => summarizeOpenShellObservation(plan(), 'original', { kind: 'exec', sandboxId: 'original', exitCode: 0, stdout: 'secret' }), { code: 'unknown_field' });
  assert.throws(() => summarizeOpenShellObservation(plan(), 'original', { kind: 'delete', sandboxId: 'original', outcome: 'future' }), { code: 'unknown_deletion_outcome' });
  assert.throws(() => summarizeOpenShellObservation(plan(), 'original', { kind: 'delete', sandboxId: 'original', outcome: 'completed', exitCode: 0 }), { code: 'unexpected_exit_code' });
});

test('adapter is hard-off regardless of flags, booleans or supplied client', async () => {
  let calls = 0;
  const adapter = new OpenShellScaffoldAdapter({ enabled: true, client: { create() { calls++; } } });
  assert.equal(adapter.prepare(fresh()).status, 'offline_proposal');
  await assert.rejects(adapter.invoke('create_sandbox', { enabled: true, approved: true, plan: plan() }), { code: 'openshell_activation_not_implemented' });
  assert.equal(calls, 0);
  assert.equal(openShellReadiness().activationSupported, false);
  assert.equal(openShellReadiness().liveTrafficProtected, false);
});

test('upstream pin matches checked-in lock; runtime proof is not claimed', () => {
  const lock = JSON.parse(readFileSync(new URL('./upstream.lock.json', import.meta.url), 'utf8'));
  for (const key of ['release', 'commit', 'sdk']) assert.equal(UPSTREAM[key], lock[key]);
  assert.equal(lock.runtimeTested, false);
});

test('CLI is offline, reads fixture, denies apply, limits input, and does not echo malformed secrets', () => {
  const cli = fileURLToPath(new URL('./preview.mjs', import.meta.url));
  const file = fileURLToPath(new URL('./fixture.json', import.meta.url));
  const result = JSON.parse(execFileSync(process.execPath, [cli, file], { encoding: 'utf8' }));
  assert.deepEqual(result, plan());
  const ready = JSON.parse(execFileSync(process.execPath, [cli, '--readiness'], { encoding: 'utf8' }));
  assert.equal(ready.activationSupported, false);
  assert.equal(spawnSync(process.execPath, [cli, '--apply'], { encoding: 'utf8' }).status, 2);
  const dir = mkdtempSync(join(tmpdir(), 'openshell-scaffold-'));
  try {
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{"secret":"do-not-echo-this"');
    const failed = spawnSync(process.execPath, [cli, bad], { encoding: 'utf8' });
    assert.equal(failed.status, 2);
    assert.equal(failed.stderr.includes('do-not-echo-this'), false);
    writeFileSync(bad, 'x'.repeat(65537));
    assert.match(spawnSync(process.execPath, [cli, bad], { encoding: 'utf8' }).stderr, /request_too_large/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
