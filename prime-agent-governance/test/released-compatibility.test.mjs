import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  createPrimeAgentCompatibilityReceipt,
  createPrimeAgentCompatibilityRuntimeHandle,
  buildPrimeAgentSafeChildEnvironment,
  evaluatePrimeAgentCompatibilityTranscript,
  finalizePrimeAgentRuntimeRoot,
  runPrimeAgentReleasedCompatibility,
  shutdownPrimeAgentDaemon,
  verifyPrimeAgentCompatibilityReceipt,
} from '../compatibility-runner.mjs';
import {
  buildPrimeAgentDependencyIntegrity,
  buildPrimeAgentExtensionIntegrity,
  integritySha256,
  loadPrimeAgentIntegrityProfile,
  PRIME_AGENT_EXTENSION_MANIFEST_FILES,
  PRIME_AGENT_QUALIFICATION_MANIFEST_FILES,
  verifyPrimeAgentIntegrityProfile,
} from '../artifact-integrity.mjs';
import { PRIME_AGENT_HOST_CONTRACT } from '../host-contract.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(TEST_DIR, '..');
const INTEGRITY_PROFILE_PATH = resolve(PACKAGE_ROOT, 'evidence', 'prime-agent-v0.7.2-integrity-profile.v1.json');
const COMPATIBILITY_RECEIPT_PATH = resolve(PACKAGE_ROOT, 'evidence', 'prime-agent-v0.7.2-released-compatibility.v1.json');

function line(value) {
  return JSON.stringify(value);
}

function currentCompatibilityReceipt() {
  const receipt = JSON.parse(readFileSync(COMPATIBILITY_RECEIPT_PATH, 'utf8'));
  receipt.host_contract_hash = PRIME_AGENT_HOST_CONTRACT.contract_hash;
  delete receipt.receipt_hash;
  receipt.receipt_hash = integritySha256(receipt);
  return receipt;
}

function rehashCompatibilityReceipt(receipt) {
  delete receipt.receipt_hash;
  receipt.receipt_hash = integritySha256(receipt);
  return receipt;
}

function compatibilityCreationResult(receipt) {
  const integrityProfile = loadPrimeAgentIntegrityProfile(INTEGRITY_PROFILE_PATH);
  return {
    valid: true,
    release_verification: {
      valid: true,
      observed: {
        asset_name: receipt.artifact.asset_name,
        asset_size_bytes: receipt.artifact.asset_size_bytes,
        asset_sha256: receipt.artifact.asset_sha256.replace(/^sha256:/, ''),
      },
    },
    materialized_first_party_integrity: {
      valid: true,
      file_count: receipt.artifact.first_party_file_count,
      tree_digest: receipt.artifact.first_party_tree_digest,
    },
    dependency_integrity: {
      valid: true,
      lock_digest: receipt.dependency_closure.lock_digest,
      dependency_file_count: receipt.dependency_closure.dependency_file_count,
      dependency_tree_digest: receipt.dependency_closure.dependency_tree_digest,
    },
    extension_integrity: {
      valid: true,
      package_name: receipt.extension.package_name,
      package_version: receipt.extension.package_version,
      distribution_status: receipt.extension.distribution_status,
      manifest_digest: receipt.extension.manifest_digest,
    },
    integrity_profile: integrityProfile,
    transcript: {
      matrix_passed: true,
      matrix: receipt.compatibility.matrix,
      observed_rpc_commands: receipt.compatibility.observed_rpc_commands,
      message_count: receipt.compatibility.message_count,
      invalid_stdout_record_count: receipt.compatibility.invalid_stdout_record_count,
      carriage_return_count: receipt.compatibility.carriage_return_count,
      compatibility_process_exit_code: receipt.compatibility.process_exit_code,
      compatibility_process_signal: receipt.compatibility.process_signal,
      stdout_digest: receipt.compatibility.stdout_digest,
      stderr_digest: receipt.compatibility.stderr_digest,
    },
    compatibility_process_executed: true,
    compatibility_process_stderr_present: receipt.compatibility.stderr_present,
  };
}

function fakeDaemonClientPackage(root) {
  const packageRoot = resolve(root, 'package');
  const moduleRoot = resolve(packageRoot, 'dist', 'modes', 'daemon');
  mkdirSync(moduleRoot, { recursive: true });
  writeFileSync(resolve(packageRoot, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
  writeFileSync(resolve(moduleRoot, 'daemon-client.js'), `
    export class DaemonClient {
      async connect() {}
      async waitForHello() {}
      async request() { return { success: true }; }
      close() {}
    }
  `, 'utf8');
  return packageRoot;
}

function waitForServerReady(child) {
  return new Promise((resolveReady, rejectReady) => {
    let output = '';
    const timeout = setTimeout(() => {
      cleanup();
      rejectReady(new Error('timed out waiting for isolated test daemon'));
    }, 5_000);
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const onData = (chunk) => {
      output += chunk;
      if (output.includes('ready\n')) {
        cleanup();
        resolveReady();
      }
    };
    const onError = (error) => {
      cleanup();
      rejectReady(error);
    };
    const onExit = (code, signal) => {
      cleanup();
      rejectReady(new Error(`isolated test daemon exited before ready (${code ?? signal})`));
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', onData);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

async function terminateIsolatedChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolveExit) => child.once('exit', resolveExit));
  child.kill();
  await exited;
}

test('transcript evaluator requires truthful released-host compatibility responses', () => {
  const stdout = [
    line({ id: 'state-1', type: 'response', command: 'get_state', success: true, data: { isStreaming: false } }),
    line({ id: 'commands-1', type: 'response', command: 'get_commands', success: true, data: { commands: [{ name: 'agora-status', source: 'extension' }] } }),
    line({ id: 'status-1', type: 'response', command: 'prompt', success: true }),
    line({ type: 'extension_ui_request', method: 'notify', message: JSON.stringify({ authority_granted_by_extension: false }) }),
    line({ id: 'abort-1', type: 'response', command: 'abort', success: true }),
    line({ id: 'observe-1', type: 'response', command: 'observe', success: false, error: 'Unknown active session: agoragentic-missing-session' }),
    line({ id: 'unobserve-1', type: 'response', command: 'unobserve', success: true }),
    line({ type: 'response', command: 'parse', success: false, error: 'Failed to parse command: invalid JSON' }),
    line({ id: 'unknown-1', type: 'response', command: 'agoragentic_unknown_probe', success: false, error: 'Unknown command: agoragentic_unknown_probe' }),
  ].join('\n');
  const result = evaluatePrimeAgentCompatibilityTranscript({ stdout, exitCode: 0 });
  assert.equal(result.matrix_passed, true);
  assert.equal(result.matrix.length, 10);
  assert.equal(result.carriage_return_count, 0);

  const crlf = stdout.replaceAll('\n', '\r\n');
  const crlfResult = evaluatePrimeAgentCompatibilityTranscript({ stdout: crlf, exitCode: 0 });
  assert.equal(crlfResult.matrix_passed, false);
  assert.ok(crlfResult.carriage_return_count > 0);
  assert.equal(crlfResult.matrix.find((entry) => entry.id === 'jsonl_lf_framing').status, 'failed');

  const safeNotification = line({ type: 'extension_ui_request', method: 'notify', message: JSON.stringify({ authority_granted_by_extension: false }) });
  const unsafeNotification = line({ type: 'extension_ui_request', method: 'notify', message: JSON.stringify({ authority_granted_by_extension: true }) });
  const overclaim = stdout.replace(safeNotification, unsafeNotification);
  assert.equal(evaluatePrimeAgentCompatibilityTranscript({ stdout: overclaim, exitCode: 0 }).matrix_passed, false);

  const malformedCommands = stdout.replace(
    line({ id: 'commands-1', type: 'response', command: 'get_commands', success: true, data: { commands: [{ name: 'agora-status', source: 'extension' }] } }),
    line({ id: 'commands-1', type: 'response', command: 'get_commands', success: true, data: { commands: {} } }),
  );
  const malformedCommandsResult = evaluatePrimeAgentCompatibilityTranscript({
    stdout: malformedCommands,
    exitCode: 0,
  });
  assert.equal(malformedCommandsResult.matrix_passed, false);
  assert.equal(
    malformedCommandsResult.matrix.find((entry) => entry.id === 'extension_discovery').status,
    'failed',
  );
});

test('extension integrity binds the exact reviewed source package, not a lookalike manifest', () => {
  const current = buildPrimeAgentExtensionIntegrity(PACKAGE_ROOT);
  assert.equal(current.valid, true, current.blockers.join(', '));
  const root = mkdtempSync(resolve(tmpdir(), 'agoragentic-prime-extension-lookalike-'));
  try {
    writeFileSync(resolve(root, 'package.json'), JSON.stringify({
      name: '@agoragentic/prime-agent',
      version: '0.2.0-alpha.0',
      type: 'module',
      private: true,
      pi: { extensions: ['./index.mjs'] },
    }), 'utf8');
    const lookalike = buildPrimeAgentExtensionIntegrity(root);
    assert.equal(lookalike.valid, false);
    assert.ok(lookalike.blockers.some((entry) => entry.startsWith('extension_manifest_file_missing:')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('extension integrity rejects a complete rehashed lookalike source package', () => {
  const profile = loadPrimeAgentIntegrityProfile(INTEGRITY_PROFILE_PATH);
  assert.equal(profile.valid, true, profile.blockers.join(', '));
  const root = mkdtempSync(resolve(tmpdir(), 'agoragentic-prime-extension-complete-lookalike-'));
  const extensionRoot = resolve(root, 'prime-agent-governance');
  try {
    cpSync(PACKAGE_ROOT, extensionRoot, { recursive: true });
    cpSync(resolve(PACKAGE_ROOT, '..', 'integration-qualification'), resolve(root, 'integration-qualification'), {
      recursive: true,
    });
    writeFileSync(resolve(extensionRoot, 'index.mjs'), `${readFileSync(resolve(extensionRoot, 'index.mjs'), 'utf8')}\n// lookalike mutation\n`, 'utf8');
    const lookalike = buildPrimeAgentExtensionIntegrity(extensionRoot, {
      expectedManifestDigest: profile.profile.extension_manifest_digest,
    });
    assert.equal(lookalike.valid, false);
    assert.ok(lookalike.blockers.includes('extension_manifest_digest_mismatch'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('extension integrity binds every transitive evidence builder and qualification dependency file', () => {
  const baseline = buildPrimeAgentExtensionIntegrity(PACKAGE_ROOT);
  assert.equal(baseline.valid, true, baseline.blockers.join(', '));
  const root = mkdtempSync(resolve(tmpdir(), 'agoragentic-prime-extension-transitive-'));
  const extensionRoot = resolve(root, 'prime-agent-governance');
  const qualificationRoot = resolve(root, 'integration-qualification');
  try {
    cpSync(PACKAGE_ROOT, extensionRoot, { recursive: true });
    cpSync(resolve(PACKAGE_ROOT, '..', 'integration-qualification'), qualificationRoot, {
      recursive: true,
    });
    const transitiveFiles = [
      ...PRIME_AGENT_EXTENSION_MANIFEST_FILES
        .filter((relativePath) => relativePath.startsWith('evidence/'))
        .map((relativePath) => [extensionRoot, relativePath]),
      ...PRIME_AGENT_QUALIFICATION_MANIFEST_FILES
        .map((relativePath) => [qualificationRoot, relativePath]),
    ];
    for (const [scopeRoot, relativePath] of transitiveFiles) {
      const absolutePath = resolve(scopeRoot, relativePath);
      const original = readFileSync(absolutePath);
      try {
        writeFileSync(absolutePath, Buffer.concat([original, Buffer.from('\n')]));
        const mutation = buildPrimeAgentExtensionIntegrity(extensionRoot, {
          expectedManifestDigest: baseline.manifest_digest,
        });
        assert.equal(mutation.valid, false, `${relativePath} mutation must invalidate the closure`);
        assert.ok(
          mutation.blockers.includes('extension_manifest_digest_mismatch'),
          `${relativePath} mutation must change the extension manifest digest`,
        );
      } finally {
        writeFileSync(absolutePath, original);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('extension integrity follows the same real package root Node uses through an alias', async () => {
  const baseline = buildPrimeAgentExtensionIntegrity(PACKAGE_ROOT);
  assert.equal(baseline.valid, true, baseline.blockers.join(', '));
  const root = mkdtempSync(resolve(tmpdir(), 'agoragentic-prime-extension-alias-'));
  const realWorkspace = resolve(root, 'real');
  const aliasWorkspace = resolve(root, 'alias');
  const realExtensionRoot = resolve(realWorkspace, 'prime-agent-governance');
  const realQualificationRoot = resolve(realWorkspace, 'integration-qualification');
  const aliasExtensionRoot = resolve(aliasWorkspace, 'prime-agent-governance');
  try {
    mkdirSync(realWorkspace, { recursive: true });
    mkdirSync(aliasWorkspace, { recursive: true });
    cpSync(PACKAGE_ROOT, realExtensionRoot, { recursive: true });
    cpSync(resolve(PACKAGE_ROOT, '..', 'integration-qualification'), realQualificationRoot, {
      recursive: true,
    });
    cpSync(
      resolve(PACKAGE_ROOT, '..', 'integration-qualification'),
      resolve(aliasWorkspace, 'integration-qualification'),
      { recursive: true },
    );
    writeFileSync(
      resolve(realQualificationRoot, 'src', 'index.mjs'),
      `${readFileSync(resolve(realQualificationRoot, 'src', 'index.mjs'), 'utf8')}\nexport const INTEGRITY_ALIAS_PROBE = 'mutated-real-sibling';\n`,
      'utf8',
    );
    writeFileSync(
      resolve(realExtensionRoot, 'integrity-alias-probe.mjs'),
      "export { INTEGRITY_ALIAS_PROBE } from '../integration-qualification/src/index.mjs';\n",
      'utf8',
    );
    symlinkSync(realExtensionRoot, aliasExtensionRoot, 'junction');

    const imported = await import(
      `${pathToFileURL(resolve(aliasExtensionRoot, 'integrity-alias-probe.mjs')).href}?alias-test=${Date.now()}`
    );
    assert.equal(imported.INTEGRITY_ALIAS_PROBE, 'mutated-real-sibling');

    const aliased = buildPrimeAgentExtensionIntegrity(aliasExtensionRoot, {
      expectedManifestDigest: baseline.manifest_digest,
    });
    assert.equal(aliased.valid, false);
    assert.ok(aliased.blockers.includes('extension_manifest_digest_mismatch'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('integrity profile is schema closed even when a malformed profile is rehashed', () => {
  const profile = JSON.parse(readFileSync(INTEGRITY_PROFILE_PATH, 'utf8'));
  profile.dependency_closures[0].unreviewed = true;
  delete profile.profile_hash;
  profile.profile_hash = integritySha256(profile);
  const verification = verifyPrimeAgentIntegrityProfile(profile);
  assert.equal(verification.ok, false);
  assert.ok(verification.errors.some((error) => error.includes('schema-closed plain object')));

  const arrayPropertyProfile = JSON.parse(readFileSync(INTEGRITY_PROFILE_PATH, 'utf8'));
  arrayPropertyProfile.dependency_closures.unreviewed = true;
  delete arrayPropertyProfile.profile_hash;
  arrayPropertyProfile.profile_hash = integritySha256(arrayPropertyProfile);
  assert.equal(verifyPrimeAgentIntegrityProfile(arrayPropertyProfile).ok, false);

  const nonEnumerableProfile = JSON.parse(readFileSync(INTEGRITY_PROFILE_PATH, 'utf8'));
  const dependencyClosures = nonEnumerableProfile.dependency_closures;
  delete nonEnumerableProfile.dependency_closures;
  Object.defineProperty(nonEnumerableProfile, 'dependency_closures', {
    value: dependencyClosures,
    enumerable: false,
  });
  delete nonEnumerableProfile.profile_hash;
  nonEnumerableProfile.profile_hash = integritySha256({ ...nonEnumerableProfile });
  assert.equal(verifyPrimeAgentIntegrityProfile(nonEnumerableProfile).ok, false);
});

test('integrity profile verification is passive for proxies, accessors, and cycles', () => {
  const proxyProfile = JSON.parse(readFileSync(INTEGRITY_PROFILE_PATH, 'utf8'));
  let proxyTraps = 0;
  proxyProfile.dependency_closures = new Proxy(proxyProfile.dependency_closures, {
    get(target, key, receiver) {
      proxyTraps += 1;
      return Reflect.get(target, key, receiver);
    },
    getOwnPropertyDescriptor(target, key) {
      proxyTraps += 1;
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
    getPrototypeOf(target) {
      proxyTraps += 1;
      return Reflect.getPrototypeOf(target);
    },
    ownKeys(target) {
      proxyTraps += 1;
      return Reflect.ownKeys(target);
    },
  });
  const proxyVerification = verifyPrimeAgentIntegrityProfile(proxyProfile);
  assert.equal(proxyVerification.ok, false);
  assert.equal(proxyTraps, 0);
  assert.ok(proxyVerification.errors.some((error) => error.includes('must not be a Proxy')));

  const accessorProfile = JSON.parse(readFileSync(INTEGRITY_PROFILE_PATH, 'utf8'));
  let accessorReads = 0;
  Object.defineProperty(accessorProfile.dependency_closures[0], 'platform', {
    enumerable: true,
    get() {
      accessorReads += 1;
      throw new Error('accessor must never execute');
    },
  });
  const accessorVerification = verifyPrimeAgentIntegrityProfile(accessorProfile);
  assert.equal(accessorVerification.ok, false);
  assert.equal(accessorReads, 0);
  assert.ok(accessorVerification.errors.some((error) => error.includes('accessor')));

  const cyclicProfile = JSON.parse(readFileSync(INTEGRITY_PROFILE_PATH, 'utf8'));
  cyclicProfile.dependency_closures[0].cycle = cyclicProfile;
  const cyclicVerification = verifyPrimeAgentIntegrityProfile(cyclicProfile);
  assert.equal(cyclicVerification.ok, false);
  assert.ok(cyclicVerification.errors.some((error) => error.includes('must not contain a cycle')));

  const oversizedProfile = JSON.parse(readFileSync(INTEGRITY_PROFILE_PATH, 'utf8'));
  oversizedProfile.dependency_closures = new Array(4097);
  const oversizedVerification = verifyPrimeAgentIntegrityProfile(oversizedProfile);
  assert.equal(oversizedVerification.ok, false);
  assert.ok(oversizedVerification.errors.some((error) => error.includes('JSON node limit')));
});

test('dependency integrity rejects a content-tampered installed tree against the pinned closure tuple', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'agoragentic-prime-dependency-tamper-'));
  try {
    mkdirSync(resolve(root, 'node_modules', 'example-dependency'), { recursive: true });
    const lock = {
      name: 'prime-agent',
      version: '0.7.2',
      lockfileVersion: 3,
      packages: {
        '': { name: 'prime-agent', version: '0.7.2' },
        'node_modules/example-dependency': { name: 'example-dependency', version: '1.0.0' },
      },
    };
    writeFileSync(resolve(root, 'package-lock.json'), JSON.stringify(lock), 'utf8');
    writeFileSync(resolve(root, 'node_modules', 'example-dependency', 'package.json'), JSON.stringify({
      name: 'example-dependency',
      version: '1.0.0',
    }), 'utf8');
    writeFileSync(resolve(root, 'node_modules', 'example-dependency', 'index.js'), 'export default "trusted";\n', 'utf8');
    const baseline = buildPrimeAgentDependencyIntegrity(root, resolve(root, 'package-lock.json'));
    assert.equal(baseline.valid, true, baseline.blockers.join(', '));
    const pinnedClosure = {
      platform: process.platform,
      architecture: process.arch,
      materialization_method: 'exact_release_runtime',
      materialization_environment: 'Synthetic dependency integrity fixture',
      materialization_network_status: 'not_recorded',
      node_version: process.version,
      npm_version: 'not_recorded',
      dependency_file_count: baseline.dependency_file_count,
      dependency_tree_digest: baseline.dependency_tree_digest,
    };
    writeFileSync(resolve(root, 'node_modules', 'example-dependency', 'index.js'), 'export default "tampered";\n', 'utf8');
    const tampered = buildPrimeAgentDependencyIntegrity(root, resolve(root, 'package-lock.json'), {
      expectedClosure: pinnedClosure,
    });
    assert.equal(tampered.valid, false);
    assert.ok(tampered.blockers.includes('dependency_tree_profile_mismatch'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('compatibility receipt verification snapshots descriptors and rejects adversarial JSON shapes without executing accessors', () => {
  const receipt = currentCompatibilityReceipt();
  assert.equal(verifyPrimeAgentCompatibilityReceipt(receipt).ok, true);

  for (const malformedReceipt of [
    {},
    (() => {
      const value = structuredClone(receipt);
      delete value.host_identity;
      return value;
    })(),
    (() => {
      const value = structuredClone(receipt);
      delete value.compatibility.matrix;
      return value;
    })(),
    { ...structuredClone(receipt), compatibility: 'wrong-type' },
  ]) {
    let verification;
    assert.doesNotThrow(() => {
      verification = verifyPrimeAgentCompatibilityReceipt(malformedReceipt);
    });
    assert.equal(verification.ok, false);
  }

  const summaryOverclaim = structuredClone(receipt);
  summaryOverclaim.compatibility.matrix[0].summary = 'Production compatibility and authority were verified.';
  summaryOverclaim.compatibility.matrix_digest = integritySha256(summaryOverclaim.compatibility.matrix);
  const summaryOverclaimVerification = verifyPrimeAgentCompatibilityReceipt(
    rehashCompatibilityReceipt(summaryOverclaim),
  );
  assert.equal(summaryOverclaimVerification.ok, false);
  assert.ok(summaryOverclaimVerification.errors.includes('receipt.compatibility.matrix content mismatch'));

  const messageCountForgery = structuredClone(receipt);
  messageCountForgery.compatibility.message_count += 1;
  const messageCountVerification = verifyPrimeAgentCompatibilityReceipt(
    rehashCompatibilityReceipt(messageCountForgery),
  );
  assert.equal(messageCountVerification.ok, false);
  assert.ok(messageCountVerification.errors.includes('receipt.compatibility.message_count mismatch'));

  const stderrFlagForgery = structuredClone(receipt);
  stderrFlagForgery.compatibility.stderr_present = true;
  const stderrFlagVerification = verifyPrimeAgentCompatibilityReceipt(
    rehashCompatibilityReceipt(stderrFlagForgery),
  );
  assert.equal(stderrFlagVerification.ok, false);
  assert.ok(stderrFlagVerification.errors.includes('receipt.compatibility.stderr_present must be false'));

  const stderrDigestForgery = structuredClone(receipt);
  stderrDigestForgery.compatibility.stderr_digest = integritySha256('synthetic stderr');
  const stderrDigestVerification = verifyPrimeAgentCompatibilityReceipt(
    rehashCompatibilityReceipt(stderrDigestForgery),
  );
  assert.equal(stderrDigestVerification.ok, false);
  assert.ok(stderrDigestVerification.errors.includes('receipt.compatibility.stderr_digest must bind empty stderr'));

  const creationResult = compatibilityCreationResult(receipt);
  assert.throws(
    () => createPrimeAgentCompatibilityReceipt(creationResult, { observedAt: receipt.observed_at }),
    /must come directly from the exact released compatibility runner/,
  );
  assert.throws(
    () => createPrimeAgentCompatibilityReceipt({
      ...creationResult,
      transcript: { ...creationResult.transcript, message_count: 10 },
    }, { observedAt: receipt.observed_at }),
    /exact expected message count/,
  );
  assert.throws(
    () => createPrimeAgentCompatibilityReceipt({
      ...creationResult,
      transcript: {
        ...creationResult.transcript,
        stderr_digest: integritySha256('synthetic stderr'),
      },
      compatibility_process_stderr_present: true,
    }, { observedAt: receipt.observed_at }),
    /must bind empty stderr/,
  );

  const accessorReceipt = structuredClone(receipt);
  let accessorReads = 0;
  Object.defineProperty(accessorReceipt.artifact, 'asset_name', {
    enumerable: true,
    configurable: true,
    get() {
      accessorReads += 1;
      throw new Error('accessor must never execute');
    },
  });
  const accessorVerification = verifyPrimeAgentCompatibilityReceipt(accessorReceipt);
  assert.equal(accessorVerification.ok, false);
  assert.equal(accessorReads, 0);
  assert.ok(accessorVerification.errors.some((error) => error.includes('accessor property')));

  const cyclicReceipt = structuredClone(receipt);
  cyclicReceipt.cycle = cyclicReceipt;
  const cyclicVerification = verifyPrimeAgentCompatibilityReceipt(cyclicReceipt);
  assert.equal(cyclicVerification.ok, false);
  assert.equal(cyclicVerification.expected_hash, null);
  assert.ok(cyclicVerification.errors.some((error) => error.includes('must not contain a cycle')));

  const symbolReceipt = structuredClone(receipt);
  symbolReceipt.artifact[Symbol('hidden')] = true;
  assert.ok(verifyPrimeAgentCompatibilityReceipt(symbolReceipt).errors.some((error) => error.includes('symbol property')));

  const nonEnumerableReceipt = structuredClone(receipt);
  Object.defineProperty(nonEnumerableReceipt.artifact, 'hidden', { value: true, enumerable: false });
  assert.ok(verifyPrimeAgentCompatibilityReceipt(nonEnumerableReceipt).errors.some((error) => error.includes('non-enumerable')));

  const customPrototypeReceipt = structuredClone(receipt);
  Object.setPrototypeOf(customPrototypeReceipt.artifact, { inherited: true });
  assert.ok(verifyPrimeAgentCompatibilityReceipt(customPrototypeReceipt).errors.some((error) => error.includes('plain object')));

  const holeyReceipt = structuredClone(receipt);
  delete holeyReceipt.compatibility.matrix[0];
  assert.ok(verifyPrimeAgentCompatibilityReceipt(holeyReceipt).errors.some((error) => error.includes('closed dense array')));

  const proxyReceipt = structuredClone(receipt);
  proxyReceipt.artifact = new Proxy(proxyReceipt.artifact, {});
  assert.ok(verifyPrimeAgentCompatibilityReceipt(proxyReceipt).errors.some((error) => error.includes('must not be a Proxy')));

  const oversizedReceipt = structuredClone(receipt);
  oversizedReceipt.compatibility.matrix = new Array(10_001);
  assert.ok(verifyPrimeAgentCompatibilityReceipt(oversizedReceipt).errors.some((error) => error.includes('JSON node limit')));

  const oversizedObjectReceipt = structuredClone(receipt);
  oversizedObjectReceipt.compatibility = Object.fromEntries(
    Array.from({ length: 10_001 }, (_, index) => [`field_${index}`, false]),
  );
  assert.ok(verifyPrimeAgentCompatibilityReceipt(oversizedObjectReceipt).errors.some((error) => error.includes('JSON node limit')));

  for (const unsafeText of [
    ['Bearer', 'synthetic-token-12345678'].join(' '),
    'glpat-abcdefghijklmnopqrstuvwxyz012345',
    'sk_test_abcdefghijklmnopqrstuvwxyz012345',
    'npm_abcdefghijklmnopqrstuvwxyz012345',
    'hf_abcdefghijklmnopqrstuvwxyz012345',
    'whsec_abcdefghijklmnopqrstuvwxyz012345',
    'glrt-abcdefghijklmnopqrstuvwxyz012345',
    'glft-abcdefghijklmnopqrstuvwxyz012345',
    'gldt-abcdefghijklmnopqrstuvwxyz012345',
    'xoxc-abcdefghijklmnopqrstuvwxyz012345',
    'SG.abcdefghijklmnop.qrstuvwxyzABCDEF',
    'AccountKey=abcdefghijklmnopqrstuvwxyz012345',
  ]) {
    const publicSafetyReceipt = structuredClone(receipt);
    publicSafetyReceipt.note = unsafeText;
    const publicSafetyVerification = verifyPrimeAgentCompatibilityReceipt(publicSafetyReceipt);
    assert.ok(publicSafetyVerification.errors.some((error) => error.includes('credential-like text')));
    assert.ok(publicSafetyVerification.errors.every((error) => !error.includes(unsafeText)));
  }

  for (const unsafePath of [
    '/etc/shadow',
    '/opt/private/tool.json',
    '/mnt/c/private',
    '/workspace/private',
    'path=/etc/passwd',
    'cwd=C:\\Users\\alice\\secret',
    '[C:\\Users\\alice\\secret]',
  ]) {
    const publicSafetyReceipt = structuredClone(receipt);
    publicSafetyReceipt.note = unsafePath;
    const publicSafetyVerification = verifyPrimeAgentCompatibilityReceipt(publicSafetyReceipt);
    assert.ok(publicSafetyVerification.errors.some((error) => error.includes('local or private path')));
    assert.ok(publicSafetyVerification.errors.every((error) => !error.includes(unsafePath)));
  }
});

test('safe launch environment redirects home and profile lookup away from ambient Prime credentials', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'agoragentic-prime-profile-isolation-'));
  const ambientHome = resolve(root, 'ambient-home');
  const runtimeRoot = resolve(root, 'runtime');
  const runtimeHome = resolve(runtimeRoot, 'home');
  mkdirSync(resolve(ambientHome, '.prime'), { recursive: true });
  mkdirSync(runtimeRoot, { recursive: true });
  writeFileSync(
    resolve(ambientHome, '.prime', 'config.json'),
    '{"apiKey":"agoragentic-poison-credential"}',
    'utf8',
  );
  try {
    const env = buildPrimeAgentSafeChildEnvironment(runtimeRoot, {
      ...process.env,
      HOME: ambientHome,
      USERPROFILE: ambientHome,
      XDG_CONFIG_HOME: resolve(ambientHome, '.config'),
      PRIME_API_KEY: 'agoragentic-poison-credential',
      OPENAI_API_KEY: 'agoragentic-poison-credential',
    });
    assert.equal(env.HOME, runtimeHome);
    assert.equal(env.USERPROFILE, runtimeHome);
    assert.equal(env.APPDATA, resolve(runtimeHome, 'AppData', 'Roaming'));
    assert.equal(env.LOCALAPPDATA, resolve(runtimeHome, 'AppData', 'Local'));
    assert.equal(env.XDG_CONFIG_HOME, resolve(runtimeHome, '.config'));
    assert.equal(env.XDG_DATA_HOME, resolve(runtimeHome, '.local', 'share'));
    assert.equal(env.XDG_CACHE_HOME, resolve(runtimeHome, '.cache'));
    assert.equal(env.XDG_STATE_HOME, resolve(runtimeHome, '.local', 'state'));
    assert.equal(Object.hasOwn(env, 'PRIME_API_KEY'), false);
    assert.equal(Object.hasOwn(env, 'OPENAI_API_KEY'), false);

    const child = spawnSync(process.execPath, [
      '--input-type=module',
      '--eval',
      `
        import { existsSync } from 'node:fs';
        import { homedir } from 'node:os';
        import { join } from 'node:path';
        const defaultConfigPath = join(homedir(), '.prime', 'config.json');
        process.stdout.write(JSON.stringify({
          home: homedir(),
          default_config_path: defaultConfigPath,
          default_config_exists: existsSync(defaultConfigPath),
          prime_api_key_present: typeof process.env.PRIME_API_KEY === 'string',
          openai_api_key_present: typeof process.env.OPENAI_API_KEY === 'string',
        }));
      `,
    ], {
      cwd: runtimeRoot,
      env,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(child.status, 0, child.stderr);
    const probe = JSON.parse(child.stdout);
    assert.equal(probe.home, runtimeHome);
    assert.equal(probe.default_config_path, resolve(runtimeHome, '.prime', 'config.json'));
    assert.equal(probe.default_config_exists, false);
    assert.equal(probe.prime_api_key_present, false);
    assert.equal(probe.openai_api_key_present, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('daemon cleanup requires the isolated endpoint to disappear after a shutdown acknowledgement', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'agoragentic-prime-daemon-exit-test-'));
  const runtimeHandle = createPrimeAgentCompatibilityRuntimeHandle();
  const runtimeRoot = runtimeHandle.runtime_root;
  const packageRoot = fakeDaemonClientPackage(root);
  const socketPath = runtimeHandle.daemon_socket;
  const serverScript = `
    import { createServer } from 'node:net';
    const server = createServer((socket) => socket.on('error', () => {}));
    server.listen(process.argv[1], () => process.stdout.write('ready\\n'));
    const close = () => server.close(() => process.exit(0));
    process.on('SIGTERM', close);
    process.on('SIGINT', close);
  `;
  const server = spawn(process.execPath, [
    '--input-type=module',
    '--eval',
    serverScript,
    socketPath,
  ], {
    cwd: runtimeRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  try {
    await waitForServerReady(server);
    const cleaned = shutdownPrimeAgentDaemon(packageRoot, runtimeHandle, {
      exitConfirmationTimeoutMs: 250,
      pollIntervalMs: 20,
    });
    assert.equal(cleaned, false, 'a shutdown response alone must not prove daemon exit');
    assert.equal(server.exitCode, null, 'the isolated stalled daemon must still be reachable');
    assert.equal(
      finalizePrimeAgentRuntimeRoot(runtimeHandle, { shutdownConfirmed: cleaned }),
      false,
      'a live or unknown daemon must preserve its runtime root for bounded cleanup and diagnosis',
    );
    assert.equal(existsSync(runtimeRoot), true);
  } finally {
    await terminateIsolatedChild(server);
    finalizePrimeAgentRuntimeRoot(runtimeHandle, { shutdownConfirmed: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('daemon cleanup accepts an acknowledgement only after the isolated endpoint is unreachable', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'agoragentic-prime-daemon-gone-test-'));
  const runtimeHandle = createPrimeAgentCompatibilityRuntimeHandle();
  const runtimeRoot = runtimeHandle.runtime_root;
  const packageRoot = fakeDaemonClientPackage(root);
  try {
    const shutdownConfirmed = shutdownPrimeAgentDaemon(packageRoot, runtimeHandle, {
      exitConfirmationTimeoutMs: 500,
      pollIntervalMs: 20,
    });
    assert.equal(shutdownConfirmed, true);
    assert.equal(finalizePrimeAgentRuntimeRoot(runtimeHandle, { shutdownConfirmed }), true);
    assert.equal(existsSync(runtimeRoot), false);
  } finally {
    finalizePrimeAgentRuntimeRoot(runtimeHandle, { shutdownConfirmed: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('daemon cleanup cannot be retargeted with a forged runtime handle', () => {
  const protectedRoot = mkdtempSync(resolve(tmpdir(), 'agoragentic-prime-protected-fixture-'));
  const protectedFile = resolve(protectedRoot, 'keep.txt');
  writeFileSync(protectedFile, 'keep', 'utf8');
  const forgedHandle = Object.freeze({
    runtime_root: protectedRoot,
    daemon_socket: process.platform === 'win32'
      ? `\\\\.\\pipe\\agoragentic-forged-${process.pid}`
      : resolve(protectedRoot, 'forged.sock'),
  });
  const validHandle = createPrimeAgentCompatibilityRuntimeHandle();
  try {
    assert.equal(finalizePrimeAgentRuntimeRoot(forgedHandle, { shutdownConfirmed: true }), false);
    assert.equal(existsSync(protectedFile), true);
    assert.equal(shutdownPrimeAgentDaemon(protectedRoot, forgedHandle), false);
    assert.equal(existsSync(protectedFile), true);
  } finally {
    finalizePrimeAgentRuntimeRoot(validHandle, { shutdownConfirmed: true });
    rmSync(protectedRoot, { recursive: true, force: true });
  }
});

test('daemon cleanup rejects a rebinding endpoint instead of treating initial absence as exit', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'agoragentic-prime-daemon-rebind-test-'));
  const runtimeHandle = createPrimeAgentCompatibilityRuntimeHandle();
  const runtimeRoot = runtimeHandle.runtime_root;
  const packageRoot = fakeDaemonClientPackage(root);
  const socketPath = runtimeHandle.daemon_socket;
  const serverScript = `
    import { createServer } from 'node:net';
    const socketPath = process.argv[1];
    const server = createServer((socket) => socket.on('error', () => {}));
    process.stdout.write('ready\\n');
    setTimeout(() => server.listen(socketPath), 75);
    const close = () => server.close(() => process.exit(0));
    process.on('SIGTERM', close);
    process.on('SIGINT', close);
  `;
  const server = spawn(process.execPath, [
    '--input-type=module',
    '--eval',
    serverScript,
    socketPath,
  ], {
    cwd: runtimeRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  try {
    await waitForServerReady(server);
    const cleaned = shutdownPrimeAgentDaemon(packageRoot, runtimeHandle, {
      exitConfirmationTimeoutMs: 500,
      pollIntervalMs: 100,
    });
    assert.equal(cleaned, false, 'a newly reachable endpoint must invalidate absence confirmation');
    assert.equal(finalizePrimeAgentRuntimeRoot(runtimeHandle, { shutdownConfirmed: cleaned }), false);
    assert.equal(existsSync(runtimeRoot), true);
  } finally {
    await terminateIsolatedChild(server);
    finalizePrimeAgentRuntimeRoot(runtimeHandle, { shutdownConfirmed: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('real released v0.7.2 package loads the extension and passes the provider-free RPC matrix', {
  skip: !(process.env.PRIME_AGENT_V072_TGZ && process.env.PRIME_AGENT_V072_ROOT),
}, () => {
  const result = runPrimeAgentReleasedCompatibility({
    artifactPath: process.env.PRIME_AGENT_V072_TGZ,
    releaseRoot: process.env.PRIME_AGENT_V072_ROOT,
    extensionPath: PACKAGE_ROOT,
  });
  assert.equal(result.valid, true, result.blockers.join(', '));
  assert.equal(result.immutable_release_pin_verified, true);
  assert.equal(result.exact_host_artifact_loaded, true);
  assert.equal(result.compatibility_matrix_passed, true);
  assert.equal(result.compatibility_process_executed, true);
  assert.equal(result.materialized_first_party_integrity.valid, true);
  assert.equal(result.dependency_integrity.valid, true);
  assert.equal(result.extension_integrity.valid, true);
  assert.equal(result.transcript.matrix.length, 10);
  assert.equal(result.policy_boundary_observed, false);
  assert.equal(result.active_abort_observed, false);
  assert.equal(result.stale_worker_recovery_observed, false);
  assert.equal(result.restricted_exact_runtime_observed, false);
  assert.equal(result.runtime_verified, false);
  assert.equal(result.runtime_executed, false);
  assert.equal(result.exact_runtime_verified, false);
  assert.equal(result.hosted_available, false);
  assert.equal(result.production_activated, false);
  assert.equal(result.credentials_used, false);
  assert.equal(result.paid_provider_calls, false);
  assert.equal(result.authority_granted, false);
  assert.equal(result.package_published, false);
  assert.equal(result.partnership_claimed, false);
  assert.equal(result.public_compatibility_claimed, false);

  assert.throws(
    () => createPrimeAgentCompatibilityReceipt(result, { observedAt: '2026-02-30T12:00:00Z' }),
    /RFC 3339/,
  );
  assert.throws(
    () => createPrimeAgentCompatibilityReceipt(result, { observedAt: '2000-01-01T00:00:00Z' }),
    /must match the exact released compatibility runner observation time/,
  );
  assert.throws(
    () => createPrimeAgentCompatibilityReceipt(result, { observedAt: '2099-01-01T00:00:00Z' }),
    /must match the exact released compatibility runner observation time/,
  );
  const receipt = createPrimeAgentCompatibilityReceipt(result);
  assert.equal(verifyPrimeAgentCompatibilityReceipt(receipt).ok, true);
  const tamperedReceipt = structuredClone(receipt);
  tamperedReceipt.compatibility.matrix[0].status = 'failed';
  assert.equal(verifyPrimeAgentCompatibilityReceipt(tamperedReceipt).ok, false);

  const rehashedDependencyForgery = structuredClone(receipt);
  rehashedDependencyForgery.dependency_closure.dependency_tree_digest = `sha256:${'0'.repeat(64)}`;
  delete rehashedDependencyForgery.receipt_hash;
  rehashedDependencyForgery.receipt_hash = integritySha256(rehashedDependencyForgery);
  const dependencyForgeryVerification = verifyPrimeAgentCompatibilityReceipt(rehashedDependencyForgery);
  assert.equal(dependencyForgeryVerification.ok, false);
  assert.ok(dependencyForgeryVerification.errors.includes('receipt.dependency_closure does not match integrity profile'));

  const rehashedExtensionForgery = structuredClone(receipt);
  rehashedExtensionForgery.extension.manifest_digest = `sha256:${'0'.repeat(64)}`;
  delete rehashedExtensionForgery.receipt_hash;
  rehashedExtensionForgery.receipt_hash = integritySha256(rehashedExtensionForgery);
  const extensionForgeryVerification = verifyPrimeAgentCompatibilityReceipt(rehashedExtensionForgery);
  assert.equal(extensionForgeryVerification.ok, false);
  assert.ok(extensionForgeryVerification.errors.includes('receipt.extension.manifest_digest does not match integrity profile'));

  const schemaOpenReceipt = structuredClone(receipt);
  schemaOpenReceipt.artifact.private_path = 'C:\\private\\prime-agent';
  delete schemaOpenReceipt.receipt_hash;
  schemaOpenReceipt.receipt_hash = integritySha256(schemaOpenReceipt);
  const schemaOpenVerification = verifyPrimeAgentCompatibilityReceipt(schemaOpenReceipt);
  assert.equal(schemaOpenVerification.ok, false);
  assert.ok(schemaOpenVerification.errors.includes('receipt.artifact contains an unknown field'));
  assert.ok(schemaOpenVerification.errors.some((error) => error.includes('local or private path')));

  const impossibleDateReceipt = structuredClone(receipt);
  impossibleDateReceipt.observed_at = '2026-02-30T12:00:00Z';
  delete impossibleDateReceipt.receipt_hash;
  impossibleDateReceipt.receipt_hash = integritySha256(impossibleDateReceipt);
  assert.ok(verifyPrimeAgentCompatibilityReceipt(impossibleDateReceipt).errors.includes('receipt.observed_at is invalid'));

  const arrayPropertyReceipt = structuredClone(receipt);
  arrayPropertyReceipt.compatibility.matrix.unreviewed = true;
  delete arrayPropertyReceipt.receipt_hash;
  arrayPropertyReceipt.receipt_hash = integritySha256(arrayPropertyReceipt);
  assert.ok(
    verifyPrimeAgentCompatibilityReceipt(arrayPropertyReceipt).errors.some(
      (error) => error.includes('closed dense array'),
    ),
  );

  const inheritedReceipt = Object.assign(Object.create({ schema: receipt.schema }), structuredClone(receipt));
  delete inheritedReceipt.schema;
  delete inheritedReceipt.receipt_hash;
  inheritedReceipt.receipt_hash = integritySha256(inheritedReceipt);
  assert.equal(verifyPrimeAgentCompatibilityReceipt(inheritedReceipt).ok, false);
});

test('a separately supplied lookalike release root is rejected before spawn', {
  skip: !(process.env.PRIME_AGENT_V072_TGZ && process.env.PRIME_AGENT_V072_ROOT),
}, () => {
  const root = mkdtempSync(resolve(tmpdir(), 'agoragentic-prime-host-lookalike-'));
  try {
    mkdirSync(resolve(root, 'dist', 'bundle'), { recursive: true });
    mkdirSync(resolve(root, 'node_modules'), { recursive: true });
    writeFileSync(
      resolve(root, 'package.json'),
      readFileSync(resolve(process.env.PRIME_AGENT_V072_ROOT, 'package.json')),
    );
    writeFileSync(resolve(root, 'dist', 'bundle', 'cli.js'), 'process.exit(0);\n', 'utf8');
    writeFileSync(
      resolve(root, 'package-lock.json'),
      readFileSync(resolve(PACKAGE_ROOT, 'evidence', 'prime-agent-v0.7.2-package-lock.json')),
    );
    const result = runPrimeAgentReleasedCompatibility({
      artifactPath: process.env.PRIME_AGENT_V072_TGZ,
      releaseRoot: root,
      extensionPath: PACKAGE_ROOT,
    });
    assert.equal(result.valid, false);
    assert.equal(result.compatibility_process_executed, false);
    assert.ok(result.blockers.includes('materialized_release_tree_mismatch'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
