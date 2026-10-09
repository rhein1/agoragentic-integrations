import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import {
  createE2BRuntimeSdkIntegrityVerifier,
  isE2BRuntimeSdkIntegrityVerifier,
  isE2BRuntimeSdkProcessIntegrityVerifier,
} from '../src/e2b-qualification.mjs';
import { createE2BRuntimeSdkProcessBoundary, isE2BRuntimeSdkProcessBoundary } from '../src/e2b-sdk-process.mjs';
import * as publicRoot from '../src/index.mjs';
import * as publicQualification from '../src/e2b-qualification.mjs';
import { E2BRiskForkAdapter } from '../src/adapters/e2b.mjs';

const hash = `sha256:${'a'.repeat(64)}`;
test('public entrypoints do not export a raw provider process capability', () => {
  for (const entry of [publicRoot, publicQualification]) {
    assert.equal(Object.hasOwn(entry, 'createE2BRuntimeSdkProcessBoundary'), false);
    assert.equal(Object.hasOwn(entry, 'isE2BRuntimeSdkProcessBoundary'), false);
  }
});
test('adapter cannot configure provider process options without authentic signed qualification', () => {
  assert.throws(() => new E2BRiskForkAdapter({ sdkProcessOptions: options(),
    verifyAuthorityFreeSource: async () => ({}), trustedBootstrapArtifactHash: hash,
    trustedRunnerArtifactHash: hash }), /signed qualification/);
});
const options = () => ({ runtimeArtifactPath: path.join(os.tmpdir(), 'not-an-sdk-runtime.mjs'),
  runtimeArtifactHash: hash, nodeArtifactHash: hash,
  packageDirectory: path.join(os.tmpdir(), 'not-an-sdk-package') });

test('SDK process capability and verifier brands reject copied and ordinary loader objects', async () => {
  const boundary = createE2BRuntimeSdkProcessBoundary(options());
  assert.equal(Object.isFrozen(boundary), true);
  assert.equal(isE2BRuntimeSdkProcessBoundary(boundary), true);
  assert.equal(isE2BRuntimeSdkProcessBoundary({ ...boundary }), false);
  assert.throws(() => createE2BRuntimeSdkIntegrityVerifier({ processBoundary: { ...boundary } }), /original/);
  const verifier = createE2BRuntimeSdkIntegrityVerifier({ processBoundary: boundary });
  assert.equal(isE2BRuntimeSdkIntegrityVerifier(verifier), true);
  assert.equal(isE2BRuntimeSdkProcessIntegrityVerifier(verifier), true);
  assert.equal(isE2BRuntimeSdkProcessIntegrityVerifier({ ...verifier }), false);
  assert.equal(isE2BRuntimeSdkProcessIntegrityVerifier(createE2BRuntimeSdkIntegrityVerifier()), false);
  await boundary.close();
});

test('SDK process rejects alternate loaders, relative artifacts and missing exact pins before launch', () => {
  for (const extra of [{ sdkLoader() {} }, { SandboxClass: class {} }, { env: {} },
    { execArgv: ['--import=anything'] }, { runtimeArtifactPath: 'relative.mjs' },
    { nodeArtifactHash: undefined }, { lifetimeMs: 600_001 }, { deadlineMs: 99 },
    { providerApiKey: 'synthetic\0not-a-real-key' }, { providerApiKey: 'synthetic\nnot-a-real-key' }]) {
    assert.throws(() => createE2BRuntimeSdkProcessBoundary({ ...options(), ...extra }));
  }
});

test('SDK process verifier cannot combine a capability with in-process loading options', async () => {
  const boundary = createE2BRuntimeSdkProcessBoundary(options());
  for (const extra of [{ packageDirectory: options().packageDirectory }, { readOnlyRuntime: {} }]) {
    assert.throws(() => createE2BRuntimeSdkIntegrityVerifier({ processBoundary: boundary, ...extra }), /only/);
  }
  await boundary.close();
});

test('unsupported or unverified host profile fails before any SDK process or provider operation', async () => {
  const boundary = createE2BRuntimeSdkProcessBoundary(options());
  await assert.rejects(boundary.inspect(), { code: 'E2B_SDK_PROCESS_PROFILE_UNVERIFIED' });
  assert.equal(boundary.metrics().process_starts, 0);
  await assert.rejects(boundary.inspect());
  const cleanup = await boundary.close();
  assert.equal(cleanup.sdk_process_terminated, true);
  assert.equal(cleanup.provider_cleanup_verified, false);
  assert.equal(cleanup.provider_outcome, 'unknown');
});

test('read-only SDK inspection requires a closed explicit runtime artifact profile', () => {
  assert.throws(() => createE2BRuntimeSdkIntegrityVerifier({ readOnlyRuntime: {
    runtimeArtifactPath: options().runtimeArtifactPath, runtimeArtifactHash: hash, nodeArtifactHash: hash,
  } }), /explicit/);
  assert.throws(() => createE2BRuntimeSdkIntegrityVerifier({ packageDirectory: options().packageDirectory,
    readOnlyRuntime: { runtimeArtifactPath: 'relative', runtimeArtifactHash: hash, nodeArtifactHash: hash } }), /canonical/);
});

test('local SDK lifecycle counters are immutable and never claim remote cleanup or qualification', async () => {
  const boundary = createE2BRuntimeSdkProcessBoundary(options());
  const metrics = boundary.metrics();
  assert.equal(Object.isFrozen(metrics), true);
  assert.equal(metrics.production_qualified, false);
  assert.equal(metrics.provider_cleanup_verified, false);
  assert.equal(metrics.process_starts, 0);
  await boundary.close();
  assert.equal(boundary.metrics().sdk_process_retired, true);
  assert.equal(metrics.sdk_process_retired, false, 'counter snapshots are detached');
});
