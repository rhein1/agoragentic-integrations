import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  EVIDENCE_CLASSES,
  QUALIFICATION_LEVELS,
  createQualificationEvidencePacket,
  evaluateQualification,
  observeReleaseDrift,
  sha256Ref,
  verifyQualificationEvidencePacket,
} from '../src/index.mjs';

const evidencePacketSchema = JSON.parse(readFileSync(
  new URL('../schema/evidence-packet.v1.schema.json', import.meta.url),
  'utf8',
));

const boundaries = Object.freeze({
  credentials_used: false,
  paid_provider_calls: false,
  production_deployed: false,
  package_published: false,
  outreach_performed: false,
  public_compatibility_claimed: false,
  wallet_mutated: false,
  settlement_mutated: false,
  trust_mutated: false,
  ranking_mutated: false,
});

function observation(status, proofClass, ref = 'test:evidence') {
  return { status, proof_class: proofClass, evidence_refs: [ref] };
}

function primeInput() {
  const pinned = {
    tag: 'v0.7.2',
    commit: '83a0f9f9566219551fcb6ffaf7f519a815749a58',
  };
  return {
    integration_id: 'prime-agent-governance',
    declared_level: 'source_adapter',
    generated_at: '2026-08-29T12:00:00Z',
    subject: {
      project: 'Prime Agent',
      repository: 'https://github.com/PrimeIntellect-ai/prime-agent',
    },
    release: {
      ...pinned,
      asset_name: 'prime-agent-0.7.2.tgz',
      asset_sha256: 'bc5471f2a626d727b88a45eb745fff93b10c554a3c4fc5912f25d8c64b987f5e',
      asset_size_bytes: 9387295,
      asset_url: 'https://github.com/PrimeIntellect-ai/prime-agent/releases/download/v0.7.2/prime-agent-0.7.2.tgz',
    },
    release_observation: observeReleaseDrift({
      pinned,
      observedLatest: {
        tag: 'v0.8.1',
        commit: '514633727bf26d74f39f3119c2b0e31a5ceb2a9d',
        observed_at: '2026-08-29T12:00:00Z',
      },
    }),
    observations: {
      official_project_identified: observation('passed', 'official_metadata'),
      metadata_mapping_tested: observation('passed', 'local_test'),
      source_adapter_tested: observation('passed', 'local_test'),
      policy_boundary_observed: observation('unknown', 'static_source'),
      immutable_release_pin_verified: observation('passed', 'artifact_digest'),
      exact_host_artifact_loaded: observation('passed', 'host_runtime'),
      compatibility_matrix_passed: observation('passed', 'host_runtime'),
      restricted_exact_runtime_observed: observation('unknown', 'static_source'),
      hosted_endpoint_observed: observation('unknown', 'static_source'),
      production_activation_observed: observation('unknown', 'static_source'),
      owner_promotion_approved: observation('unknown', 'static_source'),
    },
    promotion_blockers: [],
    boundaries,
  };
}

test('the contract exposes all eight distinct qualification levels and closed proof classes', () => {
  assert.deepEqual(QUALIFICATION_LEVELS, [
    'research_only',
    'metadata_mapping',
    'source_adapter',
    'policy_enforcement',
    'runtime_compatibility',
    'exact_runtime_verification',
    'hosted_availability',
    'production_activation',
  ]);
  assert.equal(EVIDENCE_CLASSES.includes('model_claim'), false);
  assert.equal(EVIDENCE_CLASSES.includes('restricted_runtime'), true);
});

test('real artifact load evidence can nominate runtime compatibility without auto-promotion', () => {
  const result = evaluateQualification(primeInput());
  assert.equal(result.level_results.runtime_compatibility.qualified, true);
  assert.equal(result.level_results.policy_enforcement.qualified, false);
  assert.equal(result.level_results.exact_runtime_verification.qualified, false);
  assert.equal(result.level_results.hosted_availability.qualified, false);
  assert.equal(result.level_results.production_activation.qualified, false);
  assert.equal(result.evidence_level, 'runtime_compatibility');
  assert.equal(result.declared_level, 'source_adapter');
  assert.equal(result.effective_level, 'source_adapter');
  assert.equal(result.promotion_candidate_level, 'runtime_compatibility');
  assert.equal(result.promotion_blocked, false);
  assert.deepEqual(result.promotion_blockers, []);
  assert.equal(result.human_promotion_required, true);
  assert.equal(result.auto_promoted, false);
});

test('an unresolved promotion blocker preserves evidence while withholding promotion candidacy', () => {
  const input = primeInput();
  input.observations.dependency_security_audit = observation(
    'failed',
    'official_metadata',
    'https://github.com/advisories/GHSA-jmr9-qjv8-65gv',
  );
  input.promotion_blockers = ['dependency_security_audit'];
  const result = evaluateQualification(input);
  assert.equal(result.level_results.runtime_compatibility.qualified, true);
  assert.equal(result.evidence_level, 'runtime_compatibility');
  assert.equal(result.effective_level, 'source_adapter');
  assert.equal(result.promotion_candidate_level, null);
  assert.deepEqual(result.promotion_candidate_levels, []);
  assert.equal(result.promotion_blocked, true);
  assert.deepEqual(result.promotion_blockers, ['dependency_security_audit']);
  assert.equal(result.human_promotion_required, true);
  assert.equal(result.hard_stop_violated, false);

  const packet = createQualificationEvidencePacket(input);
  assert.equal(verifyQualificationEvidencePacket(packet).ok, true);

  const missing = primeInput();
  missing.promotion_blockers = ['dependency_security_audit'];
  assert.throws(
    () => evaluateQualification(missing),
    /unique unresolved observation identifiers/,
  );

  const resolved = primeInput();
  resolved.observations.dependency_security_audit = observation('passed', 'official_metadata');
  resolved.promotion_blockers = ['dependency_security_audit'];
  assert.throws(
    () => evaluateQualification(resolved),
    /unique unresolved observation identifiers/,
  );
});

test('policy and runtime compatibility are sibling branches after source adapter', () => {
  const policyInput = primeInput();
  policyInput.observations.policy_boundary_observed = observation('passed', 'host_runtime');
  for (const id of [
    'immutable_release_pin_verified',
    'exact_host_artifact_loaded',
    'compatibility_matrix_passed',
  ]) {
    policyInput.observations[id] = observation('unknown', 'static_source');
  }
  const policyResult = evaluateQualification(policyInput);
  assert.equal(policyResult.level_results.policy_enforcement.qualified, true);
  assert.equal(policyResult.level_results.runtime_compatibility.qualified, false);
  assert.equal(policyResult.evidence_level, 'policy_enforcement');
  assert.equal(policyResult.promotion_candidate_level, 'policy_enforcement');

  const runtimeInput = primeInput();
  runtimeInput.declared_level = 'policy_enforcement';
  const runtimeResult = evaluateQualification(runtimeInput);
  assert.equal(runtimeResult.level_results.runtime_compatibility.qualified, true);
  assert.equal(runtimeResult.regression_detected, true);
  assert.equal(runtimeResult.effective_level, 'source_adapter');
  assert.equal(runtimeResult.promotion_candidate_level, null);
});

test('simultaneously qualified sibling branches remain an explicit partial-order result', () => {
  const input = primeInput();
  input.observations.policy_boundary_observed = observation('passed', 'host_runtime');
  const result = evaluateQualification(input);
  assert.equal(result.evidence_level, null);
  assert.deepEqual(result.evidence_levels, [
    'policy_enforcement',
    'runtime_compatibility',
  ]);
  assert.equal(result.promotion_candidate_level, null);
  assert.deepEqual(result.promotion_candidate_levels, [
    'policy_enforcement',
    'runtime_compatibility',
  ]);
  assert.equal(result.human_promotion_required, true);
  assert.equal(result.auto_promoted, false);
});

test('exact-only evidence cannot bypass runtime compatibility prerequisites', () => {
  const input = primeInput();
  for (const id of [
    'immutable_release_pin_verified',
    'exact_host_artifact_loaded',
    'compatibility_matrix_passed',
  ]) {
    input.observations[id] = observation('unknown', 'static_source');
  }
  input.observations.restricted_exact_runtime_observed = observation(
    'passed',
    'restricted_runtime',
  );
  const result = evaluateQualification(input);
  assert.equal(result.level_results.runtime_compatibility.qualified, false);
  assert.equal(result.level_results.exact_runtime_verification.qualified, false);
  assert.deepEqual(
    result.level_results.exact_runtime_verification.unmet.map((entry) => entry.observation_id),
    [
      'immutable_release_pin_verified',
      'exact_host_artifact_loaded',
      'compatibility_matrix_passed',
    ],
  );
  assert.equal(result.level_results.hosted_availability.qualified, false);
  assert.equal(result.level_results.production_activation.qualified, false);
  assert.equal(result.promotion_candidate_level, null);
});

test('hosted and production evidence cannot bypass their prerequisite chain', () => {
  const input = primeInput();
  input.observations.restricted_exact_runtime_observed = observation(
    'passed',
    'restricted_runtime',
  );
  input.observations.hosted_endpoint_observed = observation('unknown', 'static_source');
  input.observations.production_activation_observed = observation(
    'passed',
    'production_observation',
  );
  input.observations.owner_promotion_approved = observation('passed', 'human_decision');
  const result = evaluateQualification(input);
  assert.equal(result.level_results.exact_runtime_verification.qualified, true);
  assert.equal(result.level_results.hosted_availability.qualified, false);
  assert.equal(result.level_results.production_activation.qualified, false);
  assert.equal(
    result.level_results.production_activation.unmet.some(
      (entry) => entry.observation_id === 'hosted_endpoint_observed',
    ),
    true,
  );
  assert.equal(result.promotion_candidate_level, 'exact_runtime_verification');
});

test('fixtures, source, documentation, and model-like claims cannot satisfy runtime levels', () => {
  const input = primeInput();
  for (const id of [
    'immutable_release_pin_verified',
    'exact_host_artifact_loaded',
    'compatibility_matrix_passed',
    'restricted_exact_runtime_observed',
  ]) {
    input.observations[id] = observation('passed', 'static_source', 'docs:claim');
  }
  const result = evaluateQualification(input);
  assert.equal(result.level_results.runtime_compatibility.qualified, false);
  assert.equal(result.level_results.exact_runtime_verification.qualified, false);
  assert.equal(result.promotion_candidate_level, null);
});

test('exact runtime, hosted availability, and production activation require separate evidence classes', () => {
  const input = primeInput();
  input.observations.restricted_exact_runtime_observed = observation('passed', 'host_runtime');
  input.observations.hosted_endpoint_observed = observation('passed', 'host_runtime');
  input.observations.production_activation_observed = observation('passed', 'hosted_observation');
  input.observations.owner_promotion_approved = observation('passed', 'official_metadata');
  const result = evaluateQualification(input);
  assert.equal(result.level_results.exact_runtime_verification.qualified, false);
  assert.equal(result.level_results.hosted_availability.qualified, false);
  assert.equal(result.level_results.production_activation.qualified, false);
});

test('hard-stop activity blocks promotion even when compatibility evidence passes', () => {
  const input = primeInput();
  input.boundaries = { ...boundaries, paid_provider_calls: true };
  const result = evaluateQualification(input);
  assert.equal(result.hard_stop_violated, true);
  assert.deepEqual(result.violated_boundaries, ['paid_provider_calls']);
  assert.equal(result.promotion_candidate_level, null);
  assert.equal(result.human_promotion_required, false);
});

test('a public compatibility claim is an explicit promotion hard stop', () => {
  const input = primeInput();
  input.boundaries = { ...boundaries, public_compatibility_claimed: true };
  const result = evaluateQualification(input);
  assert.equal(result.hard_stop_violated, true);
  assert.deepEqual(result.violated_boundaries, ['public_compatibility_claimed']);
  assert.equal(result.promotion_candidate_level, null);
  assert.equal(result.human_promotion_required, false);
  assert.equal(result.auto_promoted, false);
});

test('packet creation rejects open or malformed schema input', () => {
  const unknownTopLevel = primeInput();
  unknownTopLevel.unreviewed = true;
  assert.throws(
    () => createQualificationEvidencePacket(unknownTopLevel),
    /packet input\.<field> is not allowed/,
  );

  const unknownNested = primeInput();
  unknownNested.subject.local_path = 'C:\\private';
  assert.throws(
    () => createQualificationEvidencePacket(unknownNested),
    /packet input\.<field>\.<field> contains a local or private path|subject\.<field> is not allowed/,
  );

  const malformed = primeInput();
  malformed.generated_at = 'not-a-date';
  malformed.release.commit = 'v0.7.2';
  malformed.release_observation.auto_update = true;
  malformed.observations.official_project_identified.evidence_refs = ['same', 'same'];
  assert.throws(
    () => createQualificationEvidencePacket(malformed),
    (error) => {
      assert.match(error.message, /generated_at must be an RFC 3339 date-time/);
      assert.match(error.message, /release\.commit must be a lowercase 40-character commit hash/);
      assert.match(error.message, /release_observation\.auto_update must be false/);
      assert.match(error.message, /evidence_refs must contain 1 to 256 bounded strings/);
      return true;
    },
  );

  const inconsistentDrift = primeInput();
  inconsistentDrift.release_observation.status = 'current';
  assert.throws(
    () => createQualificationEvidencePacket(inconsistentDrift),
    /status does not match the observed release identity/,
  );

  const undefinedOptional = primeInput();
  undefinedOptional.release.asset_url = undefined;
  assert.throws(
    () => createQualificationEvidencePacket(undefinedOptional),
    /(?:release\.asset_url must be an HTTPS URI without credentials|packet input\.<field>\.<field> must contain only JSON values)/,
  );

  const impossibleDate = primeInput();
  impossibleDate.generated_at = '2026-02-30T12:00:00Z';
  assert.throws(
    () => createQualificationEvidencePacket(impossibleDate),
    /generated_at must be an RFC 3339 date-time/,
  );

  const insecureUrls = primeInput();
  insecureUrls.subject.repository = 'http://github.com/PrimeIntellect-ai/prime-agent';
  insecureUrls.release.asset_url = 'https://token@example.com/prime-agent-0.7.2.tgz';
  assert.throws(
    () => createQualificationEvidencePacket(insecureUrls),
    /HTTPS URI without credentials/,
  );

  const incompleteArtifact = primeInput();
  delete incompleteArtifact.release.asset_size_bytes;
  delete incompleteArtifact.release.asset_url;
  assert.throws(
    () => createQualificationEvidencePacket(incompleteArtifact),
    /release\.asset_size_bytes is required.*release\.asset_url is required/,
  );

  const unsafeArtifactSize = primeInput();
  unsafeArtifactSize.release.asset_size_bytes = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(
    () => createQualificationEvidencePacket(unsafeArtifactSize),
    /asset_size_bytes must be a positive safe integer/,
  );

  const nonJsonRecord = primeInput();
  nonJsonRecord.observations = new Map();
  assert.throws(
    () => createQualificationEvidencePacket(nonJsonRecord),
    /(?:observations must be an object|packet input\.<field> must use a plain object)/,
  );
});

test('evidence references are nonblank and artifact byte counts are portable safe integers', () => {
  assert.equal(
    evidencePacketSchema.properties.release.properties.asset_size_bytes.maximum,
    Number.MAX_SAFE_INTEGER,
  );
  assert.equal(
    evidencePacketSchema.$defs.observation.properties.evidence_refs.items.pattern,
    '\\S',
  );

  const blankInput = primeInput();
  blankInput.observations.source_adapter_tested.evidence_refs = ['   '];
  assert.throws(
    () => createQualificationEvidencePacket(blankInput),
    /evidence_refs must contain 1 to 256 bounded strings/,
  );

  const rehashedBlankPacket = structuredClone(createQualificationEvidencePacket(primeInput()));
  for (const observationValue of Object.values(rehashedBlankPacket.observations)) {
    observationValue.evidence_refs = ['   '];
  }
  delete rehashedBlankPacket.evidence_hash;
  rehashedBlankPacket.evidence_hash = sha256Ref(rehashedBlankPacket);
  const verification = verifyQualificationEvidencePacket(rehashedBlankPacket);
  assert.equal(verification.ok, false);
  assert.ok(verification.errors.some((error) => error.includes('evidence_refs')));
});

test('runtime and schema both reject credential-bearing HTTPS URLs', () => {
  const httpsDefinition = evidencePacketSchema.$defs.credentiallessHttpsUri;
  const httpsPattern = new RegExp(httpsDefinition.pattern);
  assert.equal(httpsDefinition.format, 'uri');
  assert.equal(evidencePacketSchema.properties.subject.properties.repository.$ref,
    '#/$defs/credentiallessHttpsUri');
  assert.equal(evidencePacketSchema.properties.release.properties.asset_url.$ref,
    '#/$defs/credentiallessHttpsUri');

  for (const credentialUrl of [
    'https://user@example.com/project',
    'https://user:password@example.com/project',
    'https://user%40name@example.com/project',
  ]) {
    assert.equal(httpsPattern.test(credentialUrl), false, credentialUrl);
    const repositoryInput = primeInput();
    repositoryInput.subject.repository = credentialUrl;
    assert.throws(
      () => createQualificationEvidencePacket(repositoryInput),
      /subject\.repository must be an HTTPS URI without credentials/,
    );

    const assetInput = primeInput();
    assetInput.release.asset_url = credentialUrl;
    assert.throws(
      () => createQualificationEvidencePacket(assetInput),
      /release\.asset_url must be an HTTPS URI without credentials/,
    );
  }

  for (const malformedUrl of [
    'https:///foo',
    'https:////example.com/path',
  ]) {
    assert.equal(httpsPattern.test(malformedUrl), false, malformedUrl);
    const malformedInput = primeInput();
    malformedInput.subject.repository = malformedUrl;
    assert.throws(
      () => createQualificationEvidencePacket(malformedInput),
      /subject\.repository must be an HTTPS URI without credentials/,
    );

    const rehashedMalformed = structuredClone(createQualificationEvidencePacket(primeInput()));
    rehashedMalformed.subject.repository = malformedUrl;
    delete rehashedMalformed.evidence_hash;
    rehashedMalformed.evidence_hash = sha256Ref(rehashedMalformed);
    const malformedVerification = verifyQualificationEvidencePacket(rehashedMalformed);
    assert.equal(malformedVerification.ok, false);
    assert.ok(malformedVerification.errors.some((error) => error.includes('HTTPS URI')));
  }

  for (const publicUrl of [
    'https://example.com/project',
    'HTTPS://example.com/project?maintainer=user@example.com',
    'https://[2001:db8::1]/release.tgz',
    'https://[2001:db8::1]:443/release.tgz',
  ]) {
    assert.equal(httpsPattern.test(publicUrl), true, publicUrl);
    const publicInput = primeInput();
    publicInput.subject.repository = publicUrl;
    assert.equal(
      verifyQualificationEvidencePacket(createQualificationEvidencePacket(publicInput)).ok,
      true,
      publicUrl,
    );
  }
});

test('public-safe packet creation and verification reject secrets, private paths, and active data', () => {
  for (const unsafe of [
    'Bearer AAAAAAAAAAAAAAAA',
    'github_pat_abcdefghijklmnopqrstuvwxyz012345',
    'glpat-abcdefghijklmnopqrstuvwxyz012345',
    'glpat_abcdefghijklmnopqrstuvwxyz012345',
    'sk_test_abcdefghijklmnopqrstuvwxyz012345',
    'npm_abcdefghijklmnopqrstuvwxyz012345',
    'hf_abcdefghijklmnopqrstuvwxyz012345',
    ['wh', 'sec_abcdefghijklmnopqrstuvwxyz012345'].join(''),
    'glrt-abcdefghijklmnopqrstuvwxyz012345',
    'glft-abcdefghijklmnopqrstuvwxyz012345',
    'gldt-abcdefghijklmnopqrstuvwxyz012345',
    'xoxc-abcdefghijklmnopqrstuvwxyz012345',
    'SG.abcdefghijklmnop.qrstuvwxyzABCDEF',
    'AccountKey=abcdefghijklmnopqrstuvwxyz012345',
    'api_key=abcdefghijklmnop',
    '-----BEGIN OPENSSH PRIVATE KEY-----',
  ]) {
    const input = primeInput();
    input.observations.source_adapter_tested.summary = unsafe;
    assert.throws(
      () => createQualificationEvidencePacket(input),
      (error) => {
        assert.match(error.message, /credential-like text/);
        assert.equal(error.message.includes(unsafe), false);
        return true;
      },
    );
  }

  for (const unsafePath of [
    'C:\\Users\\alice\\private\\receipt.json',
    '/home/alice/private/receipt.json',
    '/etc/shadow',
    '/opt/private/tool.json',
    '/mnt/c/Users/alice/private/receipt.json',
    '/workspace/private/receipt.json',
    '/data/private/receipt.json',
    '/app/private/receipt.json',
    '/github/workspace/receipt.json',
    'path=/etc/passwd',
    'path=/dev/shm/private.json',
    'cwd:/etc/passwd',
    'path:/dev/shm/private.json',
    'scheme:/private/receipt.json',
    'cwd:C:\\Users\\alice\\secret',
    'cwd:\\\\server\\share\\secret',
    'cwd=C:\\Users\\alice\\secret',
    '[C:\\Users\\alice\\secret]',
    '\\\\server\\private\\receipt.json',
    '//server/private/receipt.json',
  ]) {
    const input = primeInput();
    input.observations.source_adapter_tested.evidence_refs = [unsafePath];
    assert.throws(
      () => createQualificationEvidencePacket(input),
      (error) => {
        assert.match(error.message, /local or private path/);
        assert.equal(error.message.includes(unsafePath), false);
        return true;
      },
    );
  }

  const rehashed = structuredClone(createQualificationEvidencePacket(primeInput()));
  rehashed.observations.source_adapter_tested.summary = 'Bearer BBBBBBBBBBBBBBBB';
  delete rehashed.evidence_hash;
  rehashed.evidence_hash = sha256Ref(rehashed);
  const rehashedVerification = verifyQualificationEvidencePacket(rehashed);
  assert.equal(rehashedVerification.ok, false);
  assert.equal(
    rehashedVerification.errors.some((error) => error.includes('credential-like text')),
    true,
  );

  const nullBlockerPacket = structuredClone(createQualificationEvidencePacket(primeInput()));
  nullBlockerPacket.observations.dependency_security_audit = null;
  nullBlockerPacket.promotion_blockers = ['dependency_security_audit'];
  delete nullBlockerPacket.evidence_hash;
  nullBlockerPacket.evidence_hash = sha256Ref(nullBlockerPacket);
  const nullBlockerVerification = verifyQualificationEvidencePacket(nullBlockerPacket);
  assert.equal(nullBlockerVerification.ok, false);
  assert.ok(nullBlockerVerification.errors.some((error) => error.includes('promotion_blockers')));

  let getterReads = 0;
  const accessorInput = primeInput();
  Object.defineProperty(accessorInput.observations.source_adapter_tested, 'summary', {
    enumerable: true,
    get() {
      getterReads += 1;
      return 'looks safe';
    },
  });
  assert.throws(
    () => createQualificationEvidencePacket(accessorInput),
    /contains an accessor or non-enumerable property/,
  );
  assert.equal(getterReads, 0);

  let proxyTrapReads = 0;
  const proxyInput = new Proxy(primeInput(), {
    ownKeys(target) {
      proxyTrapReads += 1;
      return Reflect.ownKeys(target);
    },
  });
  assert.throws(() => createQualificationEvidencePacket(proxyInput), /must not be a Proxy/);
  assert.equal(proxyTrapReads, 0);

  const secretProperty = 'github_pat_abcdefghijklmnopqrstuvwxyz012345';
  const invalidSecretKeyInput = primeInput();
  invalidSecretKeyInput[secretProperty] = undefined;
  assert.throws(
    () => createQualificationEvidencePacket(invalidSecretKeyInput),
    (error) => {
      assert.equal(error.message.includes(secretProperty), false);
      assert.match(error.message, /<field>/);
      return true;
    },
  );

  const cyclicInput = primeInput();
  cyclicInput.observations.source_adapter_tested.loop = cyclicInput.observations;
  assert.throws(() => createQualificationEvidencePacket(cyclicInput), /must not contain a cycle/);
});

test('timestamps are strict real RFC 3339 date-times in runtime and schema', () => {
  const dateTimeDefinition = evidencePacketSchema.$defs.rfc3339DateTime;
  const dateTimePattern = new RegExp(dateTimeDefinition.pattern);
  assert.equal(dateTimeDefinition.format, 'date-time');
  assert.equal(evidencePacketSchema.properties.generated_at.$ref, '#/$defs/rfc3339DateTime');
  assert.equal(
    evidencePacketSchema.properties.release_observation.properties.observed_at.$ref,
    '#/$defs/rfc3339DateTime',
  );

  const valid = primeInput();
  valid.generated_at = '2024-02-29T23:59:59.123+23:59';
  valid.release_observation.observed_at = '2024-02-29T23:59:59.123+23:59';
  assert.equal(dateTimePattern.test(valid.generated_at), true);
  assert.equal(verifyQualificationEvidencePacket(createQualificationEvidencePacket(valid)).ok, true);

  for (const invalidTimestamp of [
    '2026-02-29T12:00:00Z',
    '2024-02-30T12:00:00Z',
    '2026-01-01T24:00:00Z',
    '2026-01-01T12:60:00Z',
    '2026-01-01T12:00:60Z',
    '2026-01-01T12:00:00+24:00',
    '2026-01-01 12:00:00Z',
    '2026-01-01T12:00:00',
    '2026-01-01t12:00:00z',
  ]) {
    assert.equal(dateTimePattern.test(invalidTimestamp), false, invalidTimestamp);
    const input = primeInput();
    input.generated_at = invalidTimestamp;
    assert.throws(
      () => createQualificationEvidencePacket(input),
      /generated_at must be an RFC 3339 date-time/,
      invalidTimestamp,
    );
  }

  assert.throws(
    () => observeReleaseDrift({
      pinned: { tag: 'v1', commit: 'a'.repeat(40) },
      observedLatest: {
        tag: 'v1',
        commit: 'a'.repeat(40),
        observed_at: '2026-02-30T12:00:00Z',
      },
    }),
    /observedLatest\.observed_at must be an RFC 3339 date-time/,
  );
});

test('inherited required fields cannot satisfy reusable qualification inputs', () => {
  const inheritedObservationInput = primeInput();
  delete inheritedObservationInput.observations.official_project_identified;
  const priorObservation = Object.getOwnPropertyDescriptor(
    Object.prototype,
    'official_project_identified',
  );
  Object.defineProperty(Object.prototype, 'official_project_identified', {
    configurable: true,
    enumerable: false,
    writable: true,
    value: observation('passed', 'official_metadata', 'prototype:forged'),
  });
  try {
    const result = evaluateQualification(inheritedObservationInput);
    assert.equal(result.level_results.research_only.qualified, false);
    assert.equal(result.level_results.metadata_mapping.qualified, false);
    assert.equal(result.evidence_level, null);
    assert.equal(result.promotion_candidate_level, null);
    assert.equal(result.auto_promoted, false);
  } finally {
    if (priorObservation === undefined) {
      delete Object.prototype.official_project_identified;
    } else {
      Object.defineProperty(Object.prototype, 'official_project_identified', priorObservation);
    }
  }

  const inheritedTopLevelValues = {
    declared_level: 'source_adapter',
    observations: primeInput().observations,
    boundaries,
  };
  const priorDescriptors = new Map();
  try {
    for (const [key, value] of Object.entries(inheritedTopLevelValues)) {
      priorDescriptors.set(key, Object.getOwnPropertyDescriptor(Object.prototype, key));
      Object.defineProperty(Object.prototype, key, {
        configurable: true,
        enumerable: false,
        writable: true,
        value,
      });
    }
    assert.throws(
      () => evaluateQualification({}),
      /qualification record\.declared_level is required/,
    );
    assert.throws(
      () => observeReleaseDrift({}),
      /release observation input\.pinned is required/,
    );
  } finally {
    for (const [key, descriptor] of priorDescriptors) {
      if (descriptor === undefined) delete Object.prototype[key];
      else Object.defineProperty(Object.prototype, key, descriptor);
    }
  }
});

test('rehashing cannot hide array properties, holes, symbols, or prototype values', () => {
  const oversizedInput = primeInput();
  oversizedInput.promotion_blockers = new Array(1_000_000);
  assert.throws(
    () => createQualificationEvidencePacket(oversizedInput),
    /exceeds the JSON node limit/,
  );

  const namedPropertyPacket = structuredClone(createQualificationEvidencePacket(primeInput()));
  namedPropertyPacket.qualification.qualified_levels.unreviewed = 'smuggled';
  assert.throws(
    () => sha256Ref(namedPropertyPacket),
    /contains a non-index own property/,
  );
  const namedVerification = verifyQualificationEvidencePacket(namedPropertyPacket);
  assert.equal(namedVerification.ok, false);
  assert.equal(
    namedVerification.errors.some((error) => error.includes('contains a non-index own property')),
    true,
  );

  const symbolPropertyPacket = structuredClone(createQualificationEvidencePacket(primeInput()));
  symbolPropertyPacket.observations.source_adapter_tested.evidence_refs[
    Symbol('unreviewed')
  ] = 'smuggled';
  assert.throws(
    () => sha256Ref(symbolPropertyPacket),
    /contains a non-index own property/,
  );
  const symbolVerification = verifyQualificationEvidencePacket(symbolPropertyPacket);
  assert.equal(symbolVerification.ok, false);
  assert.equal(
    symbolVerification.errors.some((error) => error.includes('contains a non-index own property')),
    true,
  );

  const inheritedIndexPacket = structuredClone(createQualificationEvidencePacket(primeInput()));
  const qualifiedLevels = inheritedIndexPacket.qualification.qualified_levels;
  const firstLevel = qualifiedLevels[0];
  delete qualifiedLevels[0];
  const forgedArrayPrototype = Object.create(Array.prototype);
  Object.defineProperty(forgedArrayPrototype, '0', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: firstLevel,
  });
  Object.setPrototypeOf(qualifiedLevels, forgedArrayPrototype);
  assert.equal(JSON.stringify(qualifiedLevels).includes(firstLevel), true);
  assert.throws(
    () => sha256Ref(inheritedIndexPacket),
    /must use the standard Array prototype.*\[0\] is required/,
  );
  const inheritedVerification = verifyQualificationEvidencePacket(inheritedIndexPacket);
  assert.equal(inheritedVerification.ok, false);
  assert.equal(
    inheritedVerification.errors.some((error) => error.includes(
      'must use the standard Array prototype',
    )),
    true,
  );
  assert.equal(
    inheritedVerification.errors.some((error) => error.includes('[0] is required')),
    true,
  );
});

test('evidence packets are canonical, hash-bound, and reject semantic tampering', () => {
  const packet = createQualificationEvidencePacket(primeInput());
  assert.match(packet.evidence_hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(verifyQualificationEvidencePacket(packet).ok, true);

  const tampered = structuredClone(packet);
  tampered.observations.compatibility_matrix_passed.status = 'unknown';
  const verification = verifyQualificationEvidencePacket(tampered);
  assert.equal(verification.ok, false);
  assert.equal(verification.errors.includes('packet.evidence_hash mismatch'), true);
  assert.equal(
    verification.errors.includes('packet.qualification does not match packet evidence'),
    true,
  );
});

test('a recomputed hash cannot hide a malformed or schema-open packet', () => {
  const malformed = structuredClone(createQualificationEvidencePacket(primeInput()));
  malformed.integration_id = '';
  malformed.generated_at = 'not-a-date';
  malformed.subject = {
    project: 'Prime Agent',
    repository: 'not a URI',
    unreviewed: true,
  };
  malformed.release = { tag: 'v9' };
  malformed.release_observation = {
    status: 'current',
    auto_update: true,
  };
  const { evidence_hash: ignoredHash, ...malformedBody } = malformed;
  void ignoredHash;
  malformed.evidence_hash = sha256Ref(malformedBody);

  const verification = verifyQualificationEvidencePacket(malformed);
  assert.equal(verification.ok, false);
  assert.equal(verification.errors.includes('packet.evidence_hash mismatch'), false);
  assert.equal(
    verification.errors.includes('packet.integration_id must be a bounded lowercase identifier'),
    true,
  );
  assert.equal(
    verification.errors.includes('packet.generated_at must be an RFC 3339 date-time'),
    true,
  );
  assert.equal(verification.errors.includes('packet.subject.<field> is not allowed'), true);
  assert.equal(verification.errors.includes('packet.release.asset_name is required'), true);
  assert.equal(
    verification.errors.includes('packet.release_observation.auto_update must be false'),
    true,
  );

  const schemaOpen = structuredClone(createQualificationEvidencePacket(primeInput()));
  schemaOpen.qualification.unreviewed = 'smuggled';
  const { evidence_hash: ignoredOpenHash, ...schemaOpenBody } = schemaOpen;
  void ignoredOpenHash;
  schemaOpen.evidence_hash = sha256Ref(schemaOpenBody);
  const openVerification = verifyQualificationEvidencePacket(schemaOpen);
  assert.equal(openVerification.ok, false);
  assert.equal(openVerification.errors.includes('packet.evidence_hash mismatch'), false);
  assert.equal(
    openVerification.errors.includes('packet.qualification.<field> is not allowed'),
    true,
  );

  const hardStoppedInput = primeInput();
  hardStoppedInput.boundaries = { ...boundaries, public_compatibility_claimed: true };
  const semanticMismatch = structuredClone(createQualificationEvidencePacket(hardStoppedInput));
  assert.equal(semanticMismatch.qualification.promotion_candidate_level, null);
  semanticMismatch.qualification.promotion_candidate_level = 'runtime_compatibility';
  const { evidence_hash: ignoredSemanticHash, ...semanticMismatchBody } = semanticMismatch;
  void ignoredSemanticHash;
  semanticMismatch.evidence_hash = sha256Ref(semanticMismatchBody);
  const semanticVerification = verifyQualificationEvidencePacket(semanticMismatch);
  assert.equal(semanticVerification.ok, false);
  assert.equal(semanticVerification.errors.includes('packet.evidence_hash mismatch'), false);
  assert.equal(
    semanticVerification.errors.includes(
      'packet.qualification.promotion_candidate_level does not match packet evidence',
    ),
    true,
  );
});

test('release drift observation reports only and never repins, executes, or promotes', () => {
  const observationResult = primeInput().release_observation;
  assert.deepEqual(observationResult, {
    status: 'update_available',
    pinned_tag: 'v0.7.2',
    pinned_commit: '83a0f9f9566219551fcb6ffaf7f519a815749a58',
    observed_latest_tag: 'v0.8.1',
    observed_latest_commit: '514633727bf26d74f39f3119c2b0e31a5ceb2a9d',
    observed_at: '2026-08-29T12:00:00Z',
    auto_update: false,
    pin_changed: false,
    binary_executed: false,
    promotion_changed: false,
  });
});
