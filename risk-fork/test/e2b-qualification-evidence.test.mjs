import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { E2BRiskForkAdapter } from '../src/adapters/e2b.mjs';
import {
  E2B_QUALIFICATION_CONTROLS,
  createE2BQualificationEvidence,
  createE2BQualificationTrustVerifier,
  createE2BRuntimeSdkIntegrityVerifier,
  isE2BQualificationEvidenceCanonical,
  loadVerifiedE2BRuntimeSdk,
  sha256BytesRef,
  validateE2BQualificationEvidence,
} from '../src/e2b-qualification.mjs';
import { canonicalize } from '../src/canonical.mjs';
import { hash } from './helpers.mjs';

const TEMPLATE_ID = 'template-risk-fork-qualified-v1';
const TEMPLATE_HASH = hash('template-risk-fork-qualified-v1');
const BOOTSTRAP_HASH = hash('qualified-bootstrap');
const RUNNER_HASH = hash('qualified-runner');

function input(overrides = {}) {
  return {
    provider: {
      name: 'e2b',
      project_ref_hash: hash('e2b-project'),
      region: 'us-east-1',
    },
    sdk: {
      package: 'e2b',
      version: '2.39.0',
      integrity_hash: hash('e2b@2.39.0-integrity'),
    },
    template: {
      template_id_hash: hash(TEMPLATE_ID),
      build_id_hash: hash('build-qualified-v1'),
      template_evidence_hash: TEMPLATE_HASH,
      provenance_hash: hash('template-provenance'),
    },
    runtime: {
      bootstrap_artifact_hash: BOOTSTRAP_HASH,
      runner_artifact_hash: RUNNER_HASH,
      boot_guard_artifact_hash: hash('qualified-boot-guard'),
    },
    run: {
      approval_ref_hash: hash('approval-ref'),
      run_ref_hash: hash('run-ref'),
      started_at: '2030-01-01T00:00:00.000Z',
      completed_at: '2030-01-01T00:00:30.000Z',
      sandbox_count: 1,
      synthetic_workspace: true,
    },
    limits: {
      hard_ttl_ms: 60_000,
      idle_ttl_ms: 10_000,
      max_execution_ms: 5_000,
      max_cost_usd: '0.25',
    },
    observations: {
      fork_start_ms: 1200,
      execution_ms: 250,
      cleanup_ms: 500,
      observed_cost_usd: '0.02',
    },
    controls: Object.fromEntries(E2B_QUALIFICATION_CONTROLS.map((name) => [name, 'verified'])),
    cleanup: {
      kill_requested: 'verified',
      absence_verified: 'verified',
      orphan_reconciliation: 'verified',
    },
    evidence_refs: [
      { ref: 'evidence:e2b-qualified-run', hash: hash('e2b-qualified-run') },
    ],
    ...overrides,
  };
}

function qualificationTrust(evidence) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const verifier = createE2BQualificationTrustVerifier({
    publicKey,
    publicKeyHash: sha256BytesRef(publicKey.export({ type: 'spki', format: 'der' })),
  });
  const payload = verifier.createPayload(evidence);
  return {
    qualificationTrustVerifier: verifier,
    qualificationTrust: Object.freeze({
      ...payload,
      signature: sign(
        null,
        Buffer.from(canonicalize(payload), 'utf8'),
        privateKey,
      ).toString('base64url'),
    }),
  };
}

test('qualification evidence is closed, hash-bound, schema-valid, and exact-profile-bound', async () => {
  const evidence = createE2BQualificationEvidence(input());
  assert.equal(evidence.status, 'verified');
  assert.equal(isE2BQualificationEvidenceCanonical(evidence), true);
  assert.equal(isE2BQualificationEvidenceCanonical({
    ...evidence,
    evidence_hash: hash('tampered-evidence'),
  }), false);
  assert.deepEqual(validateE2BQualificationEvidence(evidence, {
    templateId: TEMPLATE_ID,
    templateHash: TEMPLATE_HASH,
    bootstrapArtifactHash: BOOTSTRAP_HASH,
    runnerArtifactHash: RUNNER_HASH,
  }), evidence);

  const schemaPath = fileURLToPath(new URL('../schema/e2b-qualification-evidence.v1.json', import.meta.url));
  const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  assert.equal(validate(evidence), true, ajv.errorsText(validate.errors));
});

test('runtime SDK integrity verifier loads only the exact signed e2b package tree', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-e2b-sdk-integrity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'dist'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'e2b',
    version: '2.39.0',
    main: 'dist/index.js',
  }));
  await writeFile(path.join(root, 'dist', 'index.js'), 'module.exports = { Sandbox: class Sandbox {} };\n');

  const verifier = createE2BRuntimeSdkIntegrityVerifier({ packageDirectory: root });
  const inspected = await verifier.inspect();
  const loaded = await loadVerifiedE2BRuntimeSdk(inspected, verifier);
  assert.equal(loaded.package, 'e2b');
  assert.equal(loaded.version, '2.39.0');
  assert.equal(loaded.integrity_hash, inspected.integrity_hash);
  assert.equal(typeof loaded.module.default.Sandbox, 'function');

  await writeFile(path.join(root, 'dist', 'index.js'), 'module.exports = { Sandbox: class Tampered {} };\n');
  await assert.rejects(
    loadVerifiedE2BRuntimeSdk(inspected, verifier),
    /integrity|binding|changed/i,
  );
  await assert.rejects(
    loadVerifiedE2BRuntimeSdk(inspected, Object.freeze({
      inspect: async () => inspected,
      load: async () => ({ module: { Sandbox: class Sandbox {} }, ...inspected }),
    })),
    /trusted|verifier|factory/i,
  );
});

async function writeRuntimePackage(root, manifest, source = 'module.exports = {};\n') {
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify(manifest));
  await writeFile(path.join(root, manifest.main ?? 'index.js'), source);
}

test('runtime SDK closure binds recursive dependencies plus present and absent optional peers', async (t) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-e2b-sdk-closure-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const modules = path.join(fixture, 'node_modules');
  const sdkRoot = path.join(modules, 'e2b');
  const importMarker = '__riskForkSyntheticClosureImported';
  delete globalThis[importMarker];
  t.after(() => { delete globalThis[importMarker]; });
  await mkdir(path.join(sdkRoot, 'dist'), { recursive: true });
  await writeFile(path.join(sdkRoot, 'package.json'), JSON.stringify({
    name: 'e2b',
    version: '2.39.0',
    main: 'dist/index.js',
    dependencies: { 'required-dependency': '1.0.0' },
    optionalDependencies: {
      'present-optional': '1.0.0',
      'late-optional': '1.0.0',
    },
    peerDependencies: {
      'required-peer': '1.0.0',
      'optional-peer': '1.0.0',
    },
    peerDependenciesMeta: {
      'optional-peer': { optional: true },
    },
  }));
  await writeFile(
    path.join(sdkRoot, 'dist', 'index.js'),
    `globalThis.${importMarker} = true; module.exports = { Sandbox: class Sandbox {} };\n`,
  );
  await writeRuntimePackage(path.join(modules, 'required-dependency'), {
    name: 'required-dependency',
    version: '1.0.0',
    main: 'index.js',
    dependencies: { 'transitive-dependency': '1.0.0' },
  });
  await writeRuntimePackage(path.join(modules, 'transitive-dependency'), {
    name: 'transitive-dependency',
    version: '1.0.0',
    main: 'index.js',
  });
  await writeRuntimePackage(path.join(modules, 'present-optional'), {
    name: 'present-optional',
    version: '1.0.0',
    main: 'index.js',
  });
  await writeRuntimePackage(path.join(modules, 'required-peer'), {
    name: 'required-peer',
    version: '1.0.0',
    main: 'index.js',
  });

  const verifier = createE2BRuntimeSdkIntegrityVerifier({ packageDirectory: sdkRoot });
  const absentOptionalBinding = await verifier.inspect();
  await writeRuntimePackage(path.join(modules, 'optional-peer'), {
    name: 'optional-peer',
    version: '1.0.0',
    main: 'index.js',
  });
  const presentOptionalPeerBinding = await verifier.inspect();
  assert.notEqual(
    presentOptionalPeerBinding.integrity_hash,
    absentOptionalBinding.integrity_hash,
    'installing a previously absent optional peer must change the closure binding',
  );
  await rm(path.join(modules, 'optional-peer'), { recursive: true, force: true });

  await writeRuntimePackage(path.join(modules, 'late-optional'), {
    name: 'late-optional',
    version: '1.0.0',
    main: 'index.js',
  });
  await assert.rejects(
    loadVerifiedE2BRuntimeSdk(absentOptionalBinding, verifier),
    /integrity|binding/i,
  );
  assert.equal(globalThis[importMarker], undefined, 'optional drift must fail before SDK import');
  await rm(path.join(modules, 'late-optional'), { recursive: true, force: true });
  await rm(path.join(modules, 'required-peer'), { recursive: true, force: true });
  await assert.rejects(
    loadVerifiedE2BRuntimeSdk(absentOptionalBinding, verifier),
    /required-peer|required.*missing/i,
  );
  assert.equal(globalThis[importMarker], undefined, 'missing required peer must fail before import');
});

test('copied installed e2b closure rejects transitive drift, missing packages, and substitution before import', async (t) => {
  const installedEntry = fileURLToPath(import.meta.resolve('e2b'));
  let installedRoot = path.dirname(installedEntry);
  let foundInstalledRoot = false;
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      const manifest = JSON.parse(await readFile(path.join(installedRoot, 'package.json'), 'utf8'));
      if (manifest.name === 'e2b') {
        foundInstalledRoot = true;
        break;
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    installedRoot = path.dirname(installedRoot);
  }
  assert.equal(foundInstalledRoot, true, 'the real installed e2b package root must be discoverable');
  const installedModules = path.dirname(installedRoot);
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-real-e2b-closure-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const copiedModules = path.join(fixture, 'node_modules');
  await cp(installedModules, copiedModules, { recursive: true, errorOnExist: true });
  const copiedSdkRoot = path.join(copiedModules, 'e2b');
  const copiedSdkEntry = path.join(copiedSdkRoot, 'dist', 'index.js');
  const originalSdkBytes = await readFile(copiedSdkEntry);
  const sdkImportMarker = '__riskForkCopiedSdkImported';
  delete globalThis[sdkImportMarker];
  await writeFile(
    copiedSdkEntry,
    Buffer.concat([
      Buffer.from(`globalThis.${sdkImportMarker} = true;\n`, 'utf8'),
      originalSdkBytes,
    ]),
  );
  const copiedVerifier = createE2BRuntimeSdkIntegrityVerifier({
    packageDirectory: copiedSdkRoot,
  });
  const expected = await copiedVerifier.inspect();
  const transitiveRoot = path.join(copiedModules, 'openapi-fetch');
  const transitiveEntry = path.join(transitiveRoot, 'dist', 'index.cjs');
  const originalTransitiveBytes = await readFile(transitiveEntry);
  const importMarker = '__riskForkTamperedTransitiveImported';
  delete globalThis[importMarker];
  t.after(() => {
    delete globalThis[sdkImportMarker];
    delete globalThis[importMarker];
  });
  await writeFile(
    transitiveEntry,
    Buffer.concat([
      Buffer.from(`globalThis.${importMarker} = true;\n`, 'utf8'),
      originalTransitiveBytes,
    ]),
  );
  await assert.rejects(
    loadVerifiedE2BRuntimeSdk(expected, copiedVerifier),
    /integrity|binding/i,
  );
  assert.equal(
    globalThis[importMarker],
    undefined,
    'a copied transitive dependency must be rejected before its executable bytes import',
  );
  assert.equal(
    globalThis[sdkImportMarker],
    undefined,
    'transitive drift must be rejected before the copied root SDK import begins',
  );

  await writeFile(transitiveEntry, originalTransitiveBytes);
  await rm(transitiveRoot, { recursive: true, force: true });
  await assert.rejects(
    loadVerifiedE2BRuntimeSdk(expected, copiedVerifier),
    /openapi-fetch|required.*missing/i,
  );
  assert.equal(globalThis[sdkImportMarker], undefined);
  assert.equal(globalThis[importMarker], undefined);

  await cp(
    path.join(installedModules, 'chalk'),
    transitiveRoot,
    { recursive: true, errorOnExist: true },
  );
  await assert.rejects(
    loadVerifiedE2BRuntimeSdk(expected, copiedVerifier),
    /package identity mismatch|expected openapi-fetch.*observed chalk/i,
  );
  assert.equal(globalThis[sdkImportMarker], undefined);
  assert.equal(globalThis[importMarker], undefined);
});

test('every unknown or failed mandatory control keeps the adapter production-unqualified', () => {
  for (const status of ['unknown', 'failed']) {
    for (const control of E2B_QUALIFICATION_CONTROLS) {
      const controls = Object.fromEntries(
        E2B_QUALIFICATION_CONTROLS.map((name) => [name, name === control ? status : 'verified']),
      );
      const evidence = createE2BQualificationEvidence(input({ controls }));
      assert.notEqual(evidence.status, 'verified', `${control}=${status}`);
      assert.equal(isE2BQualificationEvidenceCanonical(evidence), true, `${control}=${status}`);
      const adapter = new E2BRiskForkAdapter({
        cleanTemplateId: TEMPLATE_ID,
        cleanTemplateHash: TEMPLATE_HASH,
        workspaceExportDirectory: 'exports',
        cleanupJournalDirectory: 'journal',
        trustedBootstrapArtifactHash: BOOTSTRAP_HASH,
        trustedRunnerArtifactHash: RUNNER_HASH,
        verifyAuthorityFreeSource: async () => ({}),
        qualificationEvidence: evidence,
      });
      assert.equal(adapter.capabilities.supports_idle_ttl, false, `${control}=${status}`);
      assert.equal(adapter.capabilities.credentialed_provider_validation, 'not_run');
      assert.equal(adapter.capabilities.containment_claim, 'not_verified');
    }
  }
});

test('only independently signed exact e2b@2.39.0 bindings can enable qualified capabilities', () => {
  const evidence = createE2BQualificationEvidence(input());
  const base = {
    cleanTemplateId: TEMPLATE_ID,
    cleanTemplateHash: TEMPLATE_HASH,
    workspaceExportDirectory: 'exports',
    cleanupJournalDirectory: 'journal',
    trustedBootstrapArtifactHash: BOOTSTRAP_HASH,
    trustedRunnerArtifactHash: RUNNER_HASH,
    verifyAuthorityFreeSource: async () => ({}),
    qualificationEvidence: evidence,
  };
  const unsignedAdapter = new E2BRiskForkAdapter(base);
  assert.equal(unsignedAdapter.capabilities.supports_idle_ttl, false);
  assert.equal(unsignedAdapter.capabilities.credentialed_provider_validation, 'not_run');
  assert.equal(unsignedAdapter.capabilities.containment_claim, 'not_verified');

  const adapter = new E2BRiskForkAdapter({
    ...base,
    ...qualificationTrust(evidence),
  });
  assert.equal(adapter.capabilities.supports_idle_ttl, true);
  assert.equal(adapter.capabilities.credentialed_provider_validation, 'passed');
  assert.equal(adapter.capabilities.containment_claim, 'verified');

  assert.throws(
    () => new E2BRiskForkAdapter({
      ...base,
      ...qualificationTrust(evidence),
      SandboxClass: class Sandbox {},
      sdkVersion: '2.39.0',
    }),
    /qualified.*SDK|integrity.*verifier|inject/i,
  );

  for (const [field, value] of [
    ['templateHash', hash('wrong-template')],
    ['bootstrapArtifactHash', hash('wrong-bootstrap')],
    ['runnerArtifactHash', hash('wrong-runner')],
  ]) {
    assert.throws(
      () => validateE2BQualificationEvidence(evidence, {
        templateId: TEMPLATE_ID,
        templateHash: TEMPLATE_HASH,
        bootstrapArtifactHash: BOOTSTRAP_HASH,
        runnerArtifactHash: RUNNER_HASH,
        [field]: value,
      }),
      /binding mismatch/i,
    );
  }
  assert.throws(
    () => createE2BQualificationEvidence(input({
      sdk: { package: 'e2b', version: '2.40.0', integrity_hash: hash('wrong-sdk') },
    })),
    /2\.39\.0/,
  );

  const trusted = qualificationTrust(evidence);
  const finalSignatureCharacter = trusted.qualificationTrust.signature.at(-1);
  assert.throws(
    () => new E2BRiskForkAdapter({
      ...base,
      ...trusted,
      qualificationTrust: {
        ...trusted.qualificationTrust,
        signature: `${trusted.qualificationTrust.signature.slice(0, -1)}${
          finalSignatureCharacter === 'A' ? 'B' : 'A'
        }`,
      },
    }),
    /signature|trust/i,
  );
  assert.throws(
    () => new E2BRiskForkAdapter({
      ...base,
      qualificationTrust: trusted.qualificationTrust,
      qualificationTrustVerifier: Object.freeze({
        createPayload: () => ({}),
        verify: () => true,
      }),
    }),
    /trusted|verifier|factory/i,
  );
});

test('qualification evidence rejects raw authority, secret-shaped refs, and cost-cap violations', () => {
  assert.throws(
    () => createE2BQualificationEvidence(input({
      evidence_refs: [{ ref: 'api_key=abcdefghijklmnop', hash: hash('unsafe') }],
    })),
    /secret|opaque/i,
  );
  assert.throws(
    () => createE2BQualificationEvidence(input({
      observations: {
        fork_start_ms: 1,
        execution_ms: 1,
        cleanup_ms: 1,
        observed_cost_usd: '0.26',
      },
    })),
    /cost cap/i,
  );
  const evidence = createE2BQualificationEvidence(input());
  assert.throws(
    () => validateE2BQualificationEvidence({ ...evidence, raw_logs: 'forbidden' }),
    /unsupported fields/i,
  );
});

test('unobserved provider cost stays explicit and can never qualify as verified', () => {
  const controls = Object.fromEntries(
    E2B_QUALIFICATION_CONTROLS.map((name) => [
      name,
      name === 'cost_within_cap' ? 'unknown' : 'verified',
    ]),
  );
  const observations = {
    fork_start_ms: 1,
    execution_ms: 1,
    cleanup_ms: 1,
    observed_cost_usd: null,
  };
  const evidence = createE2BQualificationEvidence(input({ controls, observations }));
  assert.equal(evidence.status, 'unknown');
  assert.equal(evidence.observations.observed_cost_usd, null);
  assert.throws(
    () => createE2BQualificationEvidence(input({ observations })),
    /observed cost|required.*cost/i,
  );
});
