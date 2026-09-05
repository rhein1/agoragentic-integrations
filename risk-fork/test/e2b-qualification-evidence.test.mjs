import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
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
  E2B_EXTERNAL_BIRTH_CONTROLS,
  E2B_EXTERNAL_QUALIFICATION_EVIDENCE_REFS,
  E2B_EXTERNAL_PROVIDER_CONTROLS,
  E2B_QUALIFICATION_CONTROLS,
  E2B_QUALIFICATION_FAILURE_CLASSES,
  E2B_QUALIFICATION_FAILURE_STAGES,
  applyE2BExternalQualificationObservation,
  createE2BExternalQualificationObservationVerifier,
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
const OBSERVER_NOW = '2030-01-01T00:01:30.000Z';
const OBSERVER_MAX_RECEIPT_AGE_MS = 60_000;
const EXTERNALLY_OBSERVED_CONTROLS = new Set([
  'first_instruction_ipv4_egress_denied',
  'first_instruction_ipv6_egress_denied',
  'cost_within_cap',
  ...E2B_EXTERNAL_BIRTH_CONTROLS,
  ...E2B_EXTERNAL_PROVIDER_CONTROLS,
]);

async function canonicalFixtureRoot(prefix) {
  const canonicalTemp = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(canonicalTemp, prefix));
  const canonicalRoot = await realpath(root);
  return canonicalRoot;
}

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
      observed_cost_usd: null,
    },
    controls: Object.fromEntries(E2B_QUALIFICATION_CONTROLS.map((name) => [
      name,
      EXTERNALLY_OBSERVED_CONTROLS.has(name) ? 'unknown' : 'verified',
    ])),
    cleanup: {
      kill_requested: 'verified',
      absence_verified: 'verified',
      orphan_reconciliation: 'verified',
    },
    evidence_refs: Object.entries(E2B_EXTERNAL_QUALIFICATION_EVIDENCE_REFS)
      .map(([field, ref]) => ({ ref, hash: hash(field) })),
    ...overrides,
  };
}

function qualificationTrust(evidence, externalObservationVerifier, keyPair = null) {
  const { privateKey, publicKey } = keyPair ?? generateKeyPairSync('ed25519');
  const verifier = createE2BQualificationTrustVerifier({
    publicKey,
    publicKeyHash: sha256BytesRef(publicKey.export({ type: 'spki', format: 'der' })),
  });
  const payload = verifier.createPayload(evidence, {}, externalObservationVerifier);
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

function externalObservationReadyInput(overrides = {}) {
  return input(overrides);
}

function observationAudience(evidence) {
  return {
    profile: 'agoragentic.risk-fork.e2b-qualification',
    project_ref_hash: evidence.provider.project_ref_hash,
    run_ref_hash: evidence.run.run_ref_hash,
    template_id_hash: evidence.template.template_id_hash,
    template_build_id_hash: evidence.template.build_id_hash,
  };
}

function signedExternalObservation(
  evidence,
  overrides = {},
  keyPair = null,
  verifierOptions = {},
) {
  const { privateKey, publicKey } = keyPair ?? generateKeyPairSync('ed25519');
  const verifier = createE2BExternalQualificationObservationVerifier({
    publicKey,
    publicKeyHash: sha256BytesRef(publicKey.export({ type: 'spki', format: 'der' })),
    clock: verifierOptions.clock ?? (() => new Date(OBSERVER_NOW)),
    maxReceiptAgeMs:
      verifierOptions.maxReceiptAgeMs ?? OBSERVER_MAX_RECEIPT_AGE_MS,
    audience: verifierOptions.audience ?? observationAudience(evidence),
  });
  const payload = verifier.createPayload(evidence, {
    observed_at: '2030-01-01T00:01:00.000Z',
    issued_at: '2030-01-01T00:01:05.000Z',
    expires_at: '2030-01-01T00:02:00.000Z',
    first_instruction_ipv4_egress_denied: true,
    first_instruction_ipv6_egress_denied: true,
    ...overrides,
    observer_boundary: {
      producer_class: 'privileged_host_supervisor',
      status: 'verified',
      evidence_hash: hash('external-observer-privilege-boundary'),
      child_write_access: false,
      reusable_signing_authority_in_child: false,
      ...overrides.observer_boundary,
    },
    birth_controls: {
      ...Object.fromEntries(E2B_EXTERNAL_BIRTH_CONTROLS.map((control) => [
        control,
        { status: 'verified', evidence_hash: hash(`external-${control}`) },
      ])),
      ...overrides.birth_controls,
    },
    ipv6_provider_denial: {
      status: 'verified',
      evidence_hash: hash('provider-ipv6-denial-record'),
      ...overrides.ipv6_provider_denial,
    },
    provider_controls: {
      ...Object.fromEntries(E2B_EXTERNAL_PROVIDER_CONTROLS.map((control) => [
        control,
        { status: 'verified', evidence_hash: hash(`external-${control}`) },
      ])),
      ...overrides.provider_controls,
    },
    cost: {
      provider_cap: {
        amount_usd: '0.25',
        evidence_hash: hash('provider-hard-cost-cap-record'),
        ...overrides.cost?.provider_cap,
      },
      derived_estimate: {
        amount_usd: '0.0001',
        evidence_hash: hash('derived-cost-estimate-record'),
        ...overrides.cost?.derived_estimate,
      },
      aggregate_console_delta: {
        amount_usd: '0',
        evidence_hash: hash('aggregate-console-delta-record'),
        ...overrides.cost?.aggregate_console_delta,
      },
      actual_sandbox: {
        status: 'finalized',
        amount_usd: '0.02',
        evidence_hash: hash('provider-finalized-sandbox-cost-record'),
        ...overrides.cost?.actual_sandbox,
      },
    },
  });
  return {
    verifier,
    privateKey,
    publicKey,
    observation: Object.freeze({
      ...payload,
      signature: sign(
        null,
        Buffer.from(canonicalize(payload), 'utf8'),
        privateKey,
      ).toString('base64url'),
    }),
  };
}

function qualifiedEvidence(overrides = {}) {
  const provisional = createE2BQualificationEvidence(externalObservationReadyInput());
  const signed = signedExternalObservation(provisional, overrides);
  return {
    provisional,
    signed,
    evidence: applyE2BExternalQualificationObservation(
      provisional,
      signed.observation,
      signed.verifier,
    ),
  };
}

function rehashEvidence(value) {
  return {
    ...value,
    evidence_hash: hash({ ...value, evidence_hash: null }),
  };
}

test('qualification evidence is closed, hash-bound, schema-valid, and exact-profile-bound', async () => {
  const evidence = createE2BQualificationEvidence(input());
  assert.equal(evidence.status, 'unknown');
  assert.equal(evidence.external_observation_receipt, null);
  assert.equal(Object.hasOwn(evidence.observations, 'failure_stage'), false);
  assert.equal(Object.hasOwn(evidence.observations, 'failure_class'), false);
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
  const diagnosticEvidence = createE2BQualificationEvidence(input({
    observations: {
      ...input().observations,
      failure_stage: 'none',
      failure_class: 'none',
    },
  }));
  assert.equal(isE2BQualificationEvidenceCanonical(diagnosticEvidence), true);
  assert.equal(validate(diagnosticEvidence), true, ajv.errorsText(validate.errors));

  const providerAbsence = createE2BQualificationEvidence(input({
    observations: {
      ...input().observations,
      failure_stage: 'initial_provider_info_fetch',
      failure_class: 'provider_absence',
    },
  }));
  assert.equal(providerAbsence.status, 'unknown');
  assert.equal(validate(providerAbsence), true, ajv.errorsText(validate.errors));
  const signedProviderAbsence = signedExternalObservation(providerAbsence);
  assert.throws(
    () => applyE2BExternalQualificationObservation(
      providerAbsence,
      signedProviderAbsence.observation,
      signedProviderAbsence.verifier,
    ),
    /verified.*primary canary failure/i,
  );

  for (const observations of [{
    ...input().observations,
    failure_stage: 'initial_provider_info_fetch',
  }, {
    ...input().observations,
    failure_stage: 'none',
    failure_class: 'provider_call_failure',
  }, {
    ...input().observations,
    failure_stage: 'provider_message_selected_stage',
    failure_class: 'provider_call_failure',
  }]) {
    assert.throws(
      () => createE2BQualificationEvidence(input({ observations })),
      /failure_stage|failure_class|appear together|both be none/i,
    );
  }

  assert.equal(Object.isFrozen(E2B_QUALIFICATION_FAILURE_STAGES), true);
  assert.equal(Object.isFrozen(E2B_QUALIFICATION_FAILURE_CLASSES), true);
  const finalized = qualifiedEvidence().evidence;
  assert.equal(validate(finalized), true, ajv.errorsText(validate.errors));
});

test('runtime SDK integrity verifier loads only the exact signed e2b package tree', async (t) => {
  const root = await canonicalFixtureRoot('risk-fork-e2b-sdk-integrity-');
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
  const fixture = await canonicalFixtureRoot('risk-fork-e2b-sdk-closure-');
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
  const fixture = await canonicalFixtureRoot('risk-fork-real-e2b-closure-');
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
      let provisionalInput = externalObservationReadyInput();
      let observationOverrides = {};
      if (!EXTERNALLY_OBSERVED_CONTROLS.has(control)) {
        provisionalInput = externalObservationReadyInput({
          controls: { ...externalObservationReadyInput().controls, [control]: status },
        });
      } else if (control === 'first_instruction_ipv4_egress_denied') {
        if (status === 'failed') {
          observationOverrides = { first_instruction_ipv4_egress_denied: false };
        }
      } else if (control === 'first_instruction_ipv6_egress_denied') {
        observationOverrides = {
          ipv6_provider_denial: {
            status,
            evidence_hash: status === 'unknown' ? null : hash('provider-ipv6-failed'),
          },
        };
      } else if (control === 'cost_within_cap') {
        observationOverrides = status === 'unknown'
          ? {
              cost: {
                actual_sandbox: {
                  status: 'unknown',
                  amount_usd: null,
                  evidence_hash: null,
                },
              },
            }
          : { cost: { actual_sandbox: { amount_usd: '0.26' } } };
      } else if (E2B_EXTERNAL_BIRTH_CONTROLS.includes(control)) {
        observationOverrides = {
          birth_controls: {
            [control]: {
              status,
              evidence_hash: status === 'unknown' ? null : hash(`${control}-${status}`),
            },
          },
        };
      } else {
        observationOverrides = {
          provider_controls: {
            [control]: {
              status,
              evidence_hash: hash(`${control}-${status}`),
            },
          },
        };
      }
      const provisional = createE2BQualificationEvidence(provisionalInput);
      let evidence = provisional;
      let externalQualificationObservationVerifier;
      if (!(control === 'first_instruction_ipv4_egress_denied' && status === 'unknown')) {
        const signed = signedExternalObservation(provisional, observationOverrides);
        evidence = applyE2BExternalQualificationObservation(
          provisional,
          signed.observation,
          signed.verifier,
        );
        externalQualificationObservationVerifier = signed.verifier;
      }
      assert.notEqual(evidence.status, 'verified', `${control}=${status}`);
      assert.equal(isE2BQualificationEvidenceCanonical(
        evidence,
        {},
        externalQualificationObservationVerifier,
      ), true, `${control}=${status}`);
      const adapter = new E2BRiskForkAdapter({
        cleanTemplateId: TEMPLATE_ID,
        cleanTemplateHash: TEMPLATE_HASH,
        workspaceExportDirectory: 'exports',
        cleanupJournalDirectory: 'journal',
        trustedBootstrapArtifactHash: BOOTSTRAP_HASH,
        trustedRunnerArtifactHash: RUNNER_HASH,
        verifyAuthorityFreeSource: async () => ({}),
        qualificationEvidence: evidence,
        externalQualificationObservationVerifier,
      });
      assert.equal(adapter.capabilities.supports_idle_ttl, false, `${control}=${status}`);
      assert.equal(adapter.capabilities.credentialed_provider_validation, 'not_run');
      assert.equal(adapter.capabilities.containment_claim, 'not_verified');
    }
  }
});

test('only independently signed exact e2b@2.39.0 bindings can satisfy qualification while activation stays default-off', () => {
  const qualified = qualifiedEvidence();
  const { evidence } = qualified;
  const base = {
    cleanTemplateId: TEMPLATE_ID,
    cleanTemplateHash: TEMPLATE_HASH,
    workspaceExportDirectory: 'exports',
    cleanupJournalDirectory: 'journal',
    trustedBootstrapArtifactHash: BOOTSTRAP_HASH,
    trustedRunnerArtifactHash: RUNNER_HASH,
    verifyAuthorityFreeSource: async () => ({}),
    qualificationEvidence: evidence,
    externalQualificationObservationVerifier: qualified.signed.verifier,
  };
  const unsignedAdapter = new E2BRiskForkAdapter(base);
  assert.equal(unsignedAdapter.capabilities.supports_idle_ttl, false);
  assert.equal(unsignedAdapter.capabilities.credentialed_provider_validation, 'not_run');
  assert.equal(unsignedAdapter.capabilities.containment_claim, 'not_verified');

  const adapter = new E2BRiskForkAdapter({
    ...base,
    ...qualificationTrust(evidence, qualified.signed.verifier),
  });
  assert.equal(adapter.qualificationEligible, true);
  assert.equal(adapter.qualified, false);
  assert.equal(adapter.capabilities.supports_idle_ttl, false);
  assert.equal(
    adapter.capabilities.credentialed_provider_validation,
    'evidence_present_activation_blocked',
  );
  assert.equal(adapter.capabilities.containment_claim, 'not_verified');

  assert.throws(
    () => new E2BRiskForkAdapter({
      ...base,
      ...qualificationTrust(evidence, qualified.signed.verifier),
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

  const trusted = qualificationTrust(evidence, qualified.signed.verifier);
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

test('qualification evidence rejects raw authority and direct external-control forgery', () => {
  assert.throws(
    () => createE2BQualificationEvidence(input({
      evidence_refs: [{ ref: 'api_key=abcdefghijklmnop', hash: hash('unsafe') }],
    })),
    /secret|opaque/i,
  );
  assert.throws(
    () => createE2BQualificationEvidence(input({
      controls: Object.fromEntries(
        E2B_QUALIFICATION_CONTROLS.map((control) => [control, 'verified']),
      ),
      observations: {
        fork_start_ms: 1,
        execution_ms: 1,
        cleanup_ms: 1,
        observed_cost_usd: '0.02',
      },
    })),
    /observer receipt|without.*receipt|external/i,
  );
  const evidence = createE2BQualificationEvidence(input());
  assert.throws(
    () => validateE2BQualificationEvidence({ ...evidence, raw_logs: 'forbidden' }),
    /unsupported fields/i,
  );
});

test('unobserved provider cost stays explicit and can never qualify as verified', () => {
  const observations = {
    fork_start_ms: 1,
    execution_ms: 1,
    cleanup_ms: 1,
    observed_cost_usd: null,
  };
  const evidence = createE2BQualificationEvidence(input({ observations }));
  assert.equal(evidence.status, 'unknown');
  assert.equal(evidence.observations.observed_cost_usd, null);
  assert.throws(
    () => createE2BQualificationEvidence(input({
      observations,
      controls: {
        ...input().controls,
        cost_within_cap: 'verified',
      },
    })),
    /observer receipt|without.*receipt|cost/i,
  );
});

test('a pinned independent observation exact-binds first-instruction IPv4/IPv6 and finalized actual cost', async () => {
  const provisional = createE2BQualificationEvidence(externalObservationReadyInput());
  const { verifier, observation } = signedExternalObservation(provisional);
  const finalized = applyE2BExternalQualificationObservation(
    provisional,
    observation,
    verifier,
  );

  assert.equal(provisional.status, 'unknown');
  assert.equal(finalized.status, 'verified');
  assert.equal(finalized.controls.first_instruction_ipv4_egress_denied, 'verified');
  assert.equal(finalized.controls.first_instruction_ipv6_egress_denied, 'verified');
  assert.equal(finalized.controls.cost_within_cap, 'verified');
  assert.deepEqual(finalized.external_observation_receipt, observation);
  assert.deepEqual(observation.observer_boundary, {
    producer_class: 'privileged_host_supervisor',
    status: 'verified',
    evidence_hash: hash('external-observer-privilege-boundary'),
    child_write_access: false,
    reusable_signing_authority_in_child: false,
  });
  assert.throws(
    () => validateE2BQualificationEvidence(finalized),
    /pinned|observer|verifier/i,
  );
  assert.deepEqual(
    validateE2BQualificationEvidence(finalized, {}, verifier),
    finalized,
  );
  const schemaPath = fileURLToPath(new URL('../schema/e2b-qualification-evidence.v1.json', import.meta.url));
  const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
  const schemaValidate = new Ajv2020({ allErrors: true, strict: true });
  addFormats(schemaValidate);
  const validateFinalized = schemaValidate.compile(schema);
  assert.equal(validateFinalized(finalized), true, schemaValidate.errorsText(validateFinalized.errors));
  const boundaryDowngrade = JSON.parse(JSON.stringify(finalized));
  boundaryDowngrade.external_observation_receipt.observer_boundary.status = 'unknown';
  assert.equal(validateFinalized(boundaryDowngrade), false);
  for (const control of E2B_EXTERNAL_PROVIDER_CONTROLS) {
    assert.equal(finalized.controls[control], 'verified');
    assert.equal(
      finalized.evidence_refs.some(
        ({ ref, hash: refHash }) => ref === `evidence:e2b-external-${
          control.replaceAll('_', '-')
        }` && refHash === hash(`external-${control}`),
      ),
      true,
    );
  }
  for (const control of E2B_EXTERNAL_BIRTH_CONTROLS) {
    assert.equal(provisional.controls[control], 'unknown');
    assert.equal(finalized.controls[control], 'verified');
    assert.equal(
      finalized.evidence_refs.some(
        ({ ref, hash: refHash }) => ref === `evidence:e2b-external-${
          control.replaceAll('_', '-')
        }` && refHash === hash(`external-${control}`),
      ),
      true,
    );
  }
  assert.equal(
    finalized.evidence_refs.some(
      ({ ref, hash: refHash }) => ref === 'evidence:e2b-external-observer-boundary'
        && refHash === hash('external-observer-privilege-boundary'),
    ),
    true,
  );
  assert.equal(finalized.observations.observed_cost_usd, '0.020000');
  assert.equal(observation.observer.algorithm, 'Ed25519');
  assert.equal(observation.observer.public_key_hash, verifier.key_hash);
  assert.deepEqual(observation.audience, observationAudience(provisional));
  assert.equal(observation.observed_at, '2030-01-01T00:01:00.000Z');
  assert.equal(observation.issued_at, '2030-01-01T00:01:05.000Z');
  assert.equal(observation.expires_at, '2030-01-01T00:02:00.000Z');
  assert.equal(observation.cost.provider_cap.amount_usd, '0.250000');
  assert.equal(observation.cost.derived_estimate.amount_usd, '0.000100');
  assert.equal(observation.cost.aggregate_console_delta.amount_usd, '0.000000');
  assert.equal(observation.cost.actual_sandbox.status, 'finalized');
  assert.equal(observation.cost.actual_sandbox.amount_usd, '0.020000');
  assert.equal(finalized.authority_flags.production_activation_granted, false);
  assert.deepEqual(observation.requested_limits, provisional.limits);
  assert.deepEqual(observation.bindings, {
    approval_ref_hash: provisional.run.approval_ref_hash,
    run_ref_hash: provisional.run.run_ref_hash,
    project_ref_hash: provisional.provider.project_ref_hash,
    sdk_integrity_hash: provisional.sdk.integrity_hash,
    template_id_hash: provisional.template.template_id_hash,
    template_build_id_hash: provisional.template.build_id_hash,
    template_evidence_hash: provisional.template.template_evidence_hash,
    template_provenance_hash: provisional.template.provenance_hash,
    bootstrap_artifact_hash: provisional.runtime.bootstrap_artifact_hash,
    runner_artifact_hash: provisional.runtime.runner_artifact_hash,
    boot_guard_artifact_hash: provisional.runtime.boot_guard_artifact_hash,
    limits_hash: hash(provisional.limits),
    ...Object.fromEntries(Object.entries(E2B_EXTERNAL_QUALIFICATION_EVIDENCE_REFS)
      .map(([field, ref]) => [
        field,
        provisional.evidence_refs.find((entry) => entry.ref === ref).hash,
      ])),
  });
  assert.equal(
    finalized.evidence_refs.some(
      ({ ref, hash: refHash }) => ref === 'evidence:e2b-external-qualification-observation'
        && refHash === hash(observation),
    ),
    true,
  );
});

test('missing, changed, or directly forged observer receipts cannot validate', () => {
  const { evidence, signed } = qualifiedEvidence();
  const missingReceipt = rehashEvidence({
    ...evidence,
    external_observation_receipt: null,
  });
  assert.throws(
    () => validateE2BQualificationEvidence(missingReceipt, {}, signed.verifier),
    /receipt|observer results|unknown/i,
  );

  const { signature, ...payload } = evidence.external_observation_receipt;
  const changedPayload = {
    ...payload,
    cost: {
      ...payload.cost,
      derived_estimate: {
        ...payload.cost.derived_estimate,
        amount_usd: '0.000200',
      },
    },
    observation_hash: null,
  };
  const changedReceipt = {
    ...changedPayload,
    observation_hash: hash(changedPayload),
    signature,
  };
  const changedEvidence = rehashEvidence({
    ...evidence,
    external_observation_receipt: changedReceipt,
  });
  assert.throws(
    () => validateE2BQualificationEvidence(changedEvidence, {}, signed.verifier),
    /signature|binding|receipt/i,
  );

  const changedDerivedControl = rehashEvidence({
    ...evidence,
    status: 'failed',
    controls: {
      ...evidence.controls,
      first_instruction_ipv4_egress_denied: 'failed',
    },
  });
  assert.throws(
    () => validateE2BQualificationEvidence(changedDerivedControl, {}, signed.verifier),
    /exactly match|receipt|binding/i,
  );

  assert.throws(
    () => createE2BQualificationEvidence({
      ...externalObservationReadyInput(),
      controls: Object.fromEntries(
        E2B_QUALIFICATION_CONTROLS.map((control) => [control, 'verified']),
      ),
      observations: {
        ...externalObservationReadyInput().observations,
        observed_cost_usd: '0.02',
      },
    }),
    /receipt|external/i,
  );
});

test('observer and qualification-trust roles require distinct Ed25519 keys', () => {
  const { evidence, signed } = qualifiedEvidence();
  assert.throws(
    () => qualificationTrust(evidence, signed.verifier, {
      privateKey: signed.privateKey,
      publicKey: signed.publicKey,
    }),
    /distinct|observer.*qualification/i,
  );
});

test('birth controls require a closed privilege-separated observer boundary', () => {
  const provisional = createE2BQualificationEvidence(externalObservationReadyInput());
  for (const control of E2B_EXTERNAL_BIRTH_CONTROLS) {
    assert.throws(
      () => createE2BQualificationEvidence(externalObservationReadyInput({
        controls: {
          ...externalObservationReadyInput().controls,
          [control]: 'verified',
        },
      })),
      /observer receipt|without.*receipt|unknown/i,
    );
  }

  const unknownBirthControls = Object.fromEntries(E2B_EXTERNAL_BIRTH_CONTROLS.map(
    (control) => [control, { status: 'unknown', evidence_hash: null }],
  ));
  assert.throws(
    () => signedExternalObservation(provisional, {
      observer_boundary: { status: 'unknown', evidence_hash: null },
    }),
    /privilege separation|birth controls/i,
  );
  const unqualified = signedExternalObservation(provisional, {
    observer_boundary: { status: 'unknown', evidence_hash: null },
    birth_controls: unknownBirthControls,
  });
  const finalized = applyE2BExternalQualificationObservation(
    provisional,
    unqualified.observation,
    unqualified.verifier,
  );
  assert.equal(finalized.status, 'unknown');
  for (const control of E2B_EXTERNAL_BIRTH_CONTROLS) {
    assert.equal(finalized.controls[control], 'unknown');
  }

  for (const authorityField of [
    ['child_write_access', true],
    ['reusable_signing_authority_in_child', true],
  ]) {
    assert.throws(
      () => signedExternalObservation(provisional, {
        observer_boundary: { [authorityField[0]]: authorityField[1] },
      }),
      /authority|child|boundary/i,
    );
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const baseVerifierOptions = {
    publicKey,
    publicKeyHash: sha256BytesRef(publicKey.export({ type: 'spki', format: 'der' })),
    clock: () => new Date(OBSERVER_NOW),
    maxReceiptAgeMs: OBSERVER_MAX_RECEIPT_AGE_MS,
    audience: observationAudience(provisional),
  };
  for (const extra of [{ privateKey }, { sign: () => 'forbidden' }]) {
    assert.throws(
      () => createE2BExternalQualificationObservationVerifier({
        ...baseVerifierOptions,
        ...extra,
      }),
      /unsupported|fields/i,
    );
  }
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString('utf8');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString('utf8');
  for (const privateKeyInput of [
    privateKey,
    privatePem,
    `${publicPem}${privatePem}${publicPem}`,
    `${publicPem}garbage\n${publicPem}`,
  ]) {
    assert.throws(
      () => createE2BExternalQualificationObservationVerifier({
        ...baseVerifierOptions,
        publicKey: privateKeyInput,
      }),
      /publicKey is invalid/i,
    );
  }
  const pemVerifier = createE2BExternalQualificationObservationVerifier({
    ...baseVerifierOptions,
    publicKey: publicPem,
  });
  assert.equal(pemVerifier.key_hash, baseVerifierOptions.publicKeyHash);
  for (const privateKeyInput of [privateKey, privatePem]) {
    assert.throws(
      () => createE2BQualificationTrustVerifier({
        publicKey: privateKeyInput,
        publicKeyHash: baseVerifierOptions.publicKeyHash,
      }),
      /publicKey is invalid/i,
    );
  }
  const pemTrustVerifier = createE2BQualificationTrustVerifier({
    publicKey: publicPem,
    publicKeyHash: baseVerifierOptions.publicKeyHash,
  });
  assert.equal(pemTrustVerifier.key_hash, baseVerifierOptions.publicKeyHash);
});

test('observer receipts reject future issue, expiry, overlong lifetime, and audience drift', () => {
  const provisional = createE2BQualificationEvidence(externalObservationReadyInput());

  assert.throws(
    () => signedExternalObservation(provisional, {
      expires_at: '2030-01-01T00:02:01.000Z',
    }),
    /lifetime|age|policy/i,
  );
  assert.throws(
    () => signedExternalObservation(provisional, {
      issued_at: '2030-01-01T00:00:59.000Z',
    }),
    /ordering|observed|issued/i,
  );

  const future = signedExternalObservation(provisional, {
    issued_at: '2030-01-01T00:01:40.000Z',
    expires_at: '2030-01-01T00:01:50.000Z',
  }, null, {
    clock: () => new Date('2030-01-01T00:01:45.000Z'),
  });
  const futureRejectingVerifier = createE2BExternalQualificationObservationVerifier({
    publicKey: future.publicKey,
    publicKeyHash: sha256BytesRef(future.publicKey.export({ type: 'spki', format: 'der' })),
    clock: () => new Date('2030-01-01T00:01:30.000Z'),
    maxReceiptAgeMs: OBSERVER_MAX_RECEIPT_AGE_MS,
    audience: observationAudience(provisional),
  });
  assert.throws(
    () => applyE2BExternalQualificationObservation(
      provisional,
      future.observation,
      futureRejectingVerifier,
    ),
    /future-issued|future/i,
  );

  let now = new Date(OBSERVER_NOW);
  const expiring = signedExternalObservation(provisional, {}, null, {
    clock: () => new Date(now),
  });
  const finalized = applyE2BExternalQualificationObservation(
    provisional,
    expiring.observation,
    expiring.verifier,
  );
  assert.equal(
    isE2BQualificationEvidenceCanonical(finalized, {}, expiring.verifier),
    true,
  );
  now = new Date('2030-01-01T00:02:00.000Z');
  assert.throws(
    () => validateE2BQualificationEvidence(finalized, {}, expiring.verifier),
    /expired/i,
  );
  assert.equal(
    isE2BQualificationEvidenceCanonical(finalized, {}, expiring.verifier),
    false,
  );

  const wrongAudienceVerifier = createE2BExternalQualificationObservationVerifier({
    publicKey: expiring.publicKey,
    publicKeyHash: sha256BytesRef(expiring.publicKey.export({ type: 'spki', format: 'der' })),
    clock: () => new Date(OBSERVER_NOW),
    maxReceiptAgeMs: OBSERVER_MAX_RECEIPT_AGE_MS,
    audience: {
      ...observationAudience(provisional),
      project_ref_hash: hash('wrong-observer-audience-project'),
    },
  });
  assert.throws(
    () => applyE2BExternalQualificationObservation(
      provisional,
      expiring.observation,
      wrongAudienceVerifier,
    ),
    /audience/i,
  );
});

test('unknown finalized per-sandbox cost and IPv6 no-route without provider evidence fail closed', () => {
  const provisional = createE2BQualificationEvidence(externalObservationReadyInput());
  const unknownCost = signedExternalObservation(provisional, {
    cost: {
      actual_sandbox: {
        status: 'unknown',
        amount_usd: null,
        evidence_hash: null,
      },
    },
  });
  const costUnknownEvidence = applyE2BExternalQualificationObservation(
    provisional,
    unknownCost.observation,
    unknownCost.verifier,
  );
  assert.equal(costUnknownEvidence.controls.cost_within_cap, 'unknown');
  assert.equal(costUnknownEvidence.observations.observed_cost_usd, null);
  assert.equal(costUnknownEvidence.status, 'unknown');
  assert.deepEqual(
    validateE2BQualificationEvidence(costUnknownEvidence, {}, unknownCost.verifier),
    costUnknownEvidence,
  );

  const noRouteOnly = signedExternalObservation(provisional, {
    first_instruction_ipv6_egress_denied: true,
    ipv6_provider_denial: { status: 'unknown', evidence_hash: null },
  });
  const ipv6UnknownEvidence = applyE2BExternalQualificationObservation(
    provisional,
    noRouteOnly.observation,
    noRouteOnly.verifier,
  );
  assert.equal(
    ipv6UnknownEvidence.external_observation_receipt.network
      .first_instruction_ipv6_egress_denied,
    true,
  );
  assert.equal(
    ipv6UnknownEvidence.external_observation_receipt.network.ipv6_provider_denial.status,
    'unknown',
  );
  assert.equal(ipv6UnknownEvidence.controls.first_instruction_ipv6_egress_denied, 'unknown');
  assert.equal(ipv6UnknownEvidence.status, 'unknown');
});

test('external qualification finalization fails closed on wrong bindings, untrusted verifiers, and unfinalized inputs', () => {
  const provisional = createE2BQualificationEvidence(externalObservationReadyInput());
  const trusted = signedExternalObservation(provisional);
  const finalSignatureCharacter = trusted.observation.signature.at(-1);
  const changedRun = createE2BQualificationEvidence(externalObservationReadyInput({
    run: {
      ...externalObservationReadyInput().run,
      run_ref_hash: hash('different-run'),
    },
  }));

  assert.throws(
    () => applyE2BExternalQualificationObservation(
      changedRun,
      trusted.observation,
      trusted.verifier,
    ),
    /audience|binding|evidence|run/i,
  );
  assert.throws(
    () => applyE2BExternalQualificationObservation(
      provisional,
      {
        ...trusted.observation,
        signature: `${trusted.observation.signature.slice(0, -1)}${
          finalSignatureCharacter === 'A' ? 'B' : 'A'
        }`,
      },
      trusted.verifier,
    ),
    /signature|observation/i,
  );
  assert.throws(
    () => applyE2BExternalQualificationObservation(
      provisional,
      trusted.observation,
      Object.freeze({ verify: () => true }),
    ),
    /trusted|verifier|factory/i,
  );
  assert.throws(
    () => signedExternalObservation(provisional, { observed_at: '2029-12-31T23:59:59.000Z' }),
    /completed|observation|time/i,
  );
  assert.throws(
    () => createE2BExternalQualificationObservationVerifier({
      publicKey: generateKeyPairSync('ed25519').publicKey,
      publicKeyHash: hash('wrong-key'),
    }),
    /key hash mismatch/i,
  );
  for (const requiredRef of Object.values(E2B_EXTERNAL_QUALIFICATION_EVIDENCE_REFS)) {
    const missingRef = createE2BQualificationEvidence(externalObservationReadyInput({
      evidence_refs: externalObservationReadyInput().evidence_refs.filter(
        ({ ref }) => ref !== requiredRef,
      ),
    }));
    assert.throws(
      () => signedExternalObservation(missingRef),
      /missing|provisional/i,
    );
  }

  const overCap = signedExternalObservation(provisional, {
    cost: { actual_sandbox: { amount_usd: '0.26' } },
  });
  const failed = applyE2BExternalQualificationObservation(
    provisional,
    overCap.observation,
    overCap.verifier,
  );
  assert.equal(failed.status, 'failed');
  assert.equal(failed.controls.cost_within_cap, 'failed');
  assert.equal(failed.observations.observed_cost_usd, '0.260000');
  assert.equal(failed.authority_flags.production_activation_granted, false);

  const providerCapOverRequested = signedExternalObservation(provisional, {
    cost: {
      provider_cap: { amount_usd: '0.26' },
      actual_sandbox: { amount_usd: '0.01' },
    },
  });
  const providerCapFailed = applyE2BExternalQualificationObservation(
    provisional,
    providerCapOverRequested.observation,
    providerCapOverRequested.verifier,
  );
  assert.equal(providerCapFailed.controls.cost_within_cap, 'failed');
  assert.equal(providerCapFailed.status, 'failed');
  assert.equal(
    providerCapFailed.external_observation_receipt.cost.provider_cap.amount_usd,
    '0.260000',
  );
  assert.equal(providerCapFailed.observations.observed_cost_usd, '0.010000');
});

test('each externally observed provider control preserves failed and timeout-ambiguous outcomes', () => {
  const provisional = createE2BQualificationEvidence(externalObservationReadyInput());
  for (const control of E2B_EXTERNAL_PROVIDER_CONTROLS) {
    assert.throws(
      () => createE2BQualificationEvidence(externalObservationReadyInput({
        controls: {
          ...externalObservationReadyInput().controls,
          [control]: 'verified',
        },
      })),
      /observer receipt|without.*receipt|unknown/i,
    );
    for (const status of ['failed', 'unknown']) {
      const evidenceHash = hash(`${control}-${status}-provider-record`);
      const signed = signedExternalObservation(provisional, {
        provider_controls: {
          [control]: { status, evidence_hash: evidenceHash },
        },
      });
      const finalized = applyE2BExternalQualificationObservation(
        provisional,
        signed.observation,
        signed.verifier,
      );
      assert.equal(finalized.controls[control], status);
      assert.equal(finalized.status, status);
      assert.equal(finalized.authority_flags.production_activation_granted, false);
      assert.equal(
        finalized.evidence_refs.some(
          ({ ref, hash: refHash }) => ref === `evidence:e2b-external-${
            control.replaceAll('_', '-')
          }` && refHash === evidenceHash,
        ),
        true,
      );
    }
  }
});

test('provider-control finalization rejects missing fields, signed-field drift, and limit drift', () => {
  const provisional = createE2BQualificationEvidence(externalObservationReadyInput());
  const trusted = signedExternalObservation(provisional);
  const [control] = E2B_EXTERNAL_PROVIDER_CONTROLS;
  const { [control]: _omitted, ...missingControl } = trusted.observation.provider_controls;

  assert.throws(
    () => applyE2BExternalQualificationObservation(
      provisional,
      { ...trusted.observation, provider_controls: missingControl },
      trusted.verifier,
    ),
    /provider controls|plain object|missing|undefined/i,
  );
  assert.throws(
    () => applyE2BExternalQualificationObservation(
      provisional,
      {
        ...trusted.observation,
        provider_controls: {
          ...trusted.observation.provider_controls,
          [control]: {
            ...trusted.observation.provider_controls[control],
            status: 'failed',
          },
        },
      },
      trusted.verifier,
    ),
    /binding|signature|observation/i,
  );
  assert.throws(
    () => applyE2BExternalQualificationObservation(
      provisional,
      {
        ...trusted.observation,
        requested_limits: {
          ...trusted.observation.requested_limits,
          hard_ttl_ms: trusted.observation.requested_limits.hard_ttl_ms + 1,
        },
      },
      trusted.verifier,
    ),
    /binding|signature|observation/i,
  );
  assert.throws(
    () => applyE2BExternalQualificationObservation(
      provisional,
      {
        ...trusted.observation,
        provider_controls: {
          ...trusted.observation.provider_controls,
          [control]: {
            ...trusted.observation.provider_controls[control],
            evidence_hash: hash('drifted-provider-control-record'),
          },
        },
      },
      trusted.verifier,
    ),
    /binding|signature|observation/i,
  );
});
