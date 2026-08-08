import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  BUZZ_EVIDENCE_CONSTANTS,
  BUZZ_UPSTREAM_PROVENANCE,
  BuzzEvidenceError,
  buildBuzzTransactionAssuranceReference,
  canonicalBuzzEventId,
  compileBuzzEvidenceBundle,
  verifyBuzzEvidenceBundle,
} from './buzz-event-evidence.mjs';
import { MAX_INPUT_BYTES } from './cli.mjs';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PUBKEY_A = '1'.repeat(64);
const PUBKEY_B = '2'.repeat(64);
const SIGNATURE = '3'.repeat(128);
const RELAY_URL = 'wss://relay.example.test';
const ref = character => `sha256:${character.repeat(64)}`;

const NIP01_VECTOR = Object.freeze({
  pubkey: '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  created_at: 1_234_567_890,
  kind: 1,
  tags: [],
  content: 'Hello, world!',
  id: 'fbe42b8e93e7acf54b8f8d0f8c30612645503f4ba606789709ec906bc581f33a',
});

function event(overrides = {}) {
  const value = {
    pubkey: overrides.pubkey ?? PUBKEY_A,
    created_at: overrides.created_at ?? 1_786_000_000,
    kind: overrides.kind ?? 9,
    tags: overrides.tags ?? [['h', 'channel-1'], ['p', PUBKEY_B]],
    content: overrides.content ?? 'Release candidate is ready for review.',
    sig: overrides.sig ?? SIGNATURE,
  };
  return {
    ...value,
    id: overrides.id ?? canonicalBuzzEventId(value),
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function testStableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => testStableStringify(item)).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => (
    `${JSON.stringify(key)}:${testStableStringify(value[key])}`
  )).join(',')}}`;
}

function testSha256(value) {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function rehashBundle(bundle) {
  bundle.event_commitments = bundle.events.map(value => ({
    event_id: value.event_id,
    commitment_ref: testSha256(testStableStringify(value)),
  }));
  bundle.event_root = testSha256(testStableStringify({
    schema: 'agoragentic.buzz-evidence-root.v2',
    source: bundle.source,
    relationships: bundle.relationships,
    event_commitments: bundle.event_commitments,
  }));
  bundle.bundle_root = testSha256(testStableStringify({
    schema: 'agoragentic.buzz-evidence-bundle-root.v1',
    bundle_schema: bundle.schema,
    source: bundle.source,
    event_root: bundle.event_root,
    event_commitments: bundle.event_commitments,
    events: bundle.events,
    relationships: bundle.relationships,
    summary: bundle.summary,
    privacy: bundle.privacy,
    transaction_assurance_readiness: bundle.transaction_assurance_readiness,
    authority: bundle.authority,
  }));
  bundle.bundle_id = `buzz_bundle_${bundle.bundle_root.slice(7, 19)}`;
  return bundle;
}

function resolveNpmCli() {
  const executableDirectory = dirname(process.execPath);
  const installRoot = dirname(executableDirectory);
  const candidates = [
    process.env.npm_execpath,
    join(executableDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(installRoot, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const pathEntry of (process.env.PATH || '').split(delimiter).filter(Boolean)) {
    candidates.push(join(pathEntry, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    candidates.push(join(dirname(pathEntry), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  }
  return candidates.find(candidate => candidate && existsSync(candidate)) || null;
}

function runNpm(args, options) {
  const npmCli = resolveNpmCli();
  if (npmCli) return spawnSync(process.execPath, [npmCli, ...args], options);
  return spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    ...options,
    shell: process.platform === 'win32',
  });
}

function typedAttestations(message, relayUrl = RELAY_URL) {
  const preliminary = compileBuzzEvidenceBundle({ events: [message], relay_url: relayUrl });
  const signatureHash = preliminary.events[0].signature.signature_hash;
  const binding = {
    event_id: message.id,
    pubkey: message.pubkey,
    signature_hash: signatureHash,
  };
  return {
    signature_attestations: {
      [message.id]: {
        ...binding,
        verification_result: 'valid',
        verifier: 'independent-nostr-verifier',
        verifier_version: '1.0.0',
        attestation_ref: ref('4'),
      },
    },
    principal_attestations: {
      [message.id]: {
        ...binding,
        principal_ref: 'principal:owner-1',
        agent_ref: 'agent:buzz-1',
        attestation_ref: ref('5'),
      },
    },
    audit_attestations: {
      [message.id]: {
        ...binding,
        relay_url_hash: preliminary.source.relay_url_hash,
        persistence_status: 'persisted',
        audit_entry_ref: ref('6'),
        audit_head_ref: ref('7'),
        verifier: 'buzz-audit-export',
        verifier_version: '1.0.0',
        attestation_ref: ref('8'),
      },
    },
  };
}

function assertReceiptReferenceInstance(schema, instance) {
  assert.equal(schema.type, 'object');
  const permittedFields = new Set(Object.keys(schema.properties));
  for (const field of Object.keys(instance)) {
    assert(permittedFields.has(field), `unexpected receipt-reference field: ${field}`);
  }
  for (const field of schema.required) {
    assert(Object.hasOwn(instance, field), `missing receipt-reference field: ${field}`);
  }

  const shaRefPattern = new RegExp(schema.$defs.sha256Ref.pattern);
  assert.equal(instance.schema, schema.properties.schema.const);
  assert.match(instance.evidence_bundle_root, shaRefPattern);
  assert.match(instance.mandate_ref, shaRefPattern);
  assert.match(instance.transaction_assurance_receipt_ref, shaRefPattern);
  assert.match(instance.reference_hash, shaRefPattern);
  assert.match(instance.buzz_event_id, new RegExp(schema.properties.buzz_event_id.pattern));
  assert.equal(typeof instance.transaction_id, 'string');
  assert(instance.transaction_id.length <= schema.properties.transaction_id.maxLength);

  const stateSchema = schema.properties.claimed_states;
  assert.deepEqual(Object.keys(instance.claimed_states).sort(), stateSchema.required.slice().sort());
  for (const value of Object.values(instance.claimed_states)) {
    assert.equal(typeof value, 'string');
    assert(value.length <= stateSchema.properties.authority.maxLength);
  }
  assert.equal(instance.state_claims_verified, schema.properties.state_claims_verified.const);

  for (const [field, definition] of Object.entries(schema.properties.publication.properties)) {
    assert.equal(instance.publication[field], definition.const);
  }
  for (const [field, definition] of Object.entries(schema.properties.authority.properties)) {
    assert.equal(instance.authority[field], definition.const);
  }
  assert(instance.non_claims.length >= schema.properties.non_claims.minItems);
  for (const claim of instance.non_claims) assert.equal(typeof claim, 'string');
}

test('matches an independent fixed NIP-01 serialization vector', () => {
  assert.equal(canonicalBuzzEventId(NIP01_VECTOR), NIP01_VECTOR.id);
});

test('rejects coercion, uppercase wire fields, and NIP-01 kind overflow', () => {
  const valid = event();
  const alphabeticPubkey = event({ pubkey: 'a'.repeat(64) });
  const alphabeticSignature = event({ sig: 'b'.repeat(128) });
  const invalidEvents = [
    { ...valid, id: valid.id.toUpperCase() },
    { ...alphabeticPubkey, pubkey: alphabeticPubkey.pubkey.toUpperCase() },
    { ...alphabeticSignature, sig: alphabeticSignature.sig.toUpperCase() },
    { ...valid, created_at: String(valid.created_at) },
    { ...valid, kind: String(valid.kind) },
    { ...valid, kind: 65_536 },
  ];
  for (const invalid of invalidEvents) {
    assert.throws(
      () => compileBuzzEvidenceBundle({ events: [invalid] }),
      error => error instanceof BuzzEvidenceError && error.code === 'invalid_event',
    );
  }
});

test('compiles canonical Buzz events without emitting raw workspace metadata by default', () => {
  const message = event({
    tags: [
      ['h', 'channel-private-42'],
      ['p', PUBKEY_B],
      ['r', 'https://username:password@private.example/repository'],
      ['d', 'internal-release-identifier'],
    ],
  });
  const bundle = compileBuzzEvidenceBundle({
    events: [message],
    relay_url: 'wss://username:password@relay.private.example',
    community_ref: 'community:private-engineering',
  }, {
    compatibility_verified_against_live_relay: true,
  });
  const serialized = JSON.stringify(bundle);

  assert.equal(bundle.schema, 'agoragentic.buzz-evidence-bundle.v2');
  assert.equal(bundle.events[0].event_type, 'stream_message');
  assert.equal(bundle.events[0].source_integrity.canonical_event_id_verified, true);
  assert.equal(bundle.events[0].signature.status, 'not_verified');
  assert.equal(bundle.events[0].content.policy, 'hash_only');
  assert.equal(bundle.events[0].content.raw_content_embedded, false);
  assert.equal(bundle.events[0].content.safe_for_publication, false);
  assert.equal(bundle.source.metadata_policy, 'hash_only');
  assert.equal(bundle.source.raw_source_metadata_embedded, false);
  assert.equal(bundle.source.compatibility_verified_against_live_relay, false);
  assert.equal(bundle.events[0].author_pubkey, undefined);
  assert.equal(bundle.privacy.raw_content_embedded, false);
  assert.equal(bundle.privacy.safe_for_publication, false);
  assert.equal(bundle.privacy.publication_review_required, true);
  assert.match(bundle.events[0].references.channel_ref_hashes[0], /^sha256:[a-f0-9]{64}$/);
  assert.equal(bundle.transaction_assurance_readiness.ready_for_economic_action, false);
  assert(bundle.transaction_assurance_readiness.blockers.includes('workspace_membership_is_not_an_economic_mandate'));
  assert.doesNotMatch(serialized, /channel-private-42|private-engineering|username:password|internal-release-identifier/);
});

test('records typed, event-bound attestations as unverified claims rather than external verification', () => {
  const message = event();
  const bundle = compileBuzzEvidenceBundle({ events: [message], relay_url: RELAY_URL }, typedAttestations(message));

  assert.equal(bundle.summary.signature_validity_claims_by_unverified_attestation_reference, 1);
  assert.equal(bundle.summary.principal_binding_claims_by_unverified_attestation_reference, 1);
  assert.equal(bundle.summary.relay_persistence_claims_by_unverified_attestation_reference, 1);
  assert.equal(bundle.events[0].signature.status, 'validity_claimed_by_unverified_attestation_reference');
  assert.equal(bundle.events[0].signature.signature_valid, null);
  assert.equal(bundle.events[0].signature.attestation_reference_verified, false);
  assert.equal(bundle.events[0].principal_binding.status, 'binding_claimed_by_unverified_attestation_reference');
  assert.equal(bundle.events[0].principal_binding.binding_verified, false);
  assert.equal(bundle.events[0].relay_audit.status, 'persistence_claimed_by_unverified_attestation_reference');
  assert.equal(bundle.events[0].relay_audit.attestation_reference_verified, false);
  assert.equal(bundle.events[0].relay_audit.claimed_binding.relay_url_hash, bundle.source.relay_url_hash);
  assert.equal(bundle.events[0].authority.principal_mandate_verified, false);
  assert.equal(bundle.source.attestation_references_independently_verified, false);
  assert.equal(bundle.transaction_assurance_readiness.ready_for_payment, false);
  assert(bundle.transaction_assurance_readiness.blockers.includes(
    'signature_attestation_references_not_independently_verified',
  ));
  assert(bundle.transaction_assurance_readiness.blockers.includes(
    'independent_attestation_verifier_and_trust_policy_required',
  ));

  assert.throws(
    () => compileBuzzEvidenceBundle({ events: [message] }, {
      signature_verifications: { [message.id]: { signature_valid: true } },
    }),
    error => error instanceof BuzzEvidenceError && error.code === 'deprecated_evidence_shape',
  );
  assert.throws(
    () => compileBuzzEvidenceBundle({ events: [message] }, { signature_verifications: true }),
    error => error instanceof BuzzEvidenceError && error.code === 'deprecated_evidence_shape',
  );

  const mismatched = typedAttestations(message);
  mismatched.signature_attestations[message.id].pubkey = PUBKEY_B;
  assert.throws(
    () => compileBuzzEvidenceBundle({ events: [message], relay_url: RELAY_URL }, mismatched),
    error => error instanceof BuzzEvidenceError && error.code === 'attestation_binding_mismatch',
  );

  const forgedButWellFormed = typedAttestations(message);
  forgedButWellFormed.signature_attestations[message.id].verifier = 'attacker-supplied-label';
  forgedButWellFormed.signature_attestations[message.id].attestation_ref = ref('f');
  const forgedBundle = compileBuzzEvidenceBundle(
    { events: [message], relay_url: RELAY_URL },
    forgedButWellFormed,
  );
  assert.equal(
    forgedBundle.events[0].signature.status,
    'validity_claimed_by_unverified_attestation_reference',
  );
  assert.equal(forgedBundle.events[0].signature.signature_valid, null);
  assert.equal(forgedBundle.events[0].signature.attestation_reference_verified, false);
});

test('requires relay-audit attestations to bind the exact source relay', () => {
  const message = event();
  const attestations = typedAttestations(message, RELAY_URL);

  assert.throws(
    () => compileBuzzEvidenceBundle({ events: [message] }, attestations),
    error => error instanceof BuzzEvidenceError && error.code === 'relay_binding_required',
  );
  assert.throws(
    () => compileBuzzEvidenceBundle(
      { events: [message], relay_url: 'wss://other-relay.example.test' },
      attestations,
    ),
    error => error instanceof BuzzEvidenceError && error.code === 'attestation_binding_mismatch',
  );

  const missingRelayBinding = clone(attestations);
  delete missingRelayBinding.audit_attestations[message.id].relay_url_hash;
  assert.throws(
    () => compileBuzzEvidenceBundle({ events: [message], relay_url: RELAY_URL }, missingRelayBinding),
    error => error instanceof BuzzEvidenceError && error.code === 'invalid_reference',
  );
});

test('commits normalized event evidence and source metadata into the event root', () => {
  const message = event();
  const input = {
    events: [message],
    relay_url: 'wss://relay.example.test',
    community_ref: 'community:test',
  };
  const options = typedAttestations(message);
  const baseline = compileBuzzEvidenceBundle(input, options).event_root;

  const signatureMutation = clone(options);
  signatureMutation.signature_attestations[message.id].attestation_ref = ref('9');
  assert.notEqual(compileBuzzEvidenceBundle(input, signatureMutation).event_root, baseline);

  const principalMutation = clone(options);
  principalMutation.principal_attestations[message.id].principal_ref = 'principal:owner-2';
  assert.notEqual(compileBuzzEvidenceBundle(input, principalMutation).event_root, baseline);

  const auditMutation = clone(options);
  auditMutation.audit_attestations[message.id].audit_head_ref = ref('a');
  assert.notEqual(compileBuzzEvidenceBundle(input, auditMutation).event_root, baseline);

  assert.notEqual(
    compileBuzzEvidenceBundle(
      { ...input, relay_url: 'wss://other.example.test' },
      typedAttestations(message, 'wss://other.example.test'),
    ).event_root,
    baseline,
  );

  const signatureMutationEvent = { ...message, sig: '4'.repeat(128) };
  assert.notEqual(
    compileBuzzEvidenceBundle({ ...input, events: [signatureMutationEvent] }, typedAttestations(signatureMutationEvent)).event_root,
    baseline,
  );
});

test('commits and verifies the complete deterministic security envelope', () => {
  const message = event();
  const bundle = compileBuzzEvidenceBundle(
    { events: [message], relay_url: RELAY_URL, community_ref: 'community:test' },
    typedAttestations(message),
  );
  const valid = verifyBuzzEvidenceBundle(bundle, { expected_bundle_root: bundle.bundle_root });

  assert.equal(valid.valid, true);
  assert.deepEqual(valid.failures, []);
  assert.equal(valid.recomputed_bundle_root, bundle.bundle_root);
  assert.equal(valid.recomputed_event_root, bundle.event_root);
  assert.equal(bundle.bundle_id, `buzz_bundle_${bundle.bundle_root.slice(7, 19)}`);

  const mutations = [
    ['authority', value => { value.authority.grants_spend = true; }, 'authority_mismatch'],
    ['readiness', value => { value.transaction_assurance_readiness.ready_for_payment = true; }, 'transaction_assurance_readiness_mismatch'],
    ['blockers', value => { value.transaction_assurance_readiness.blockers = []; }, 'transaction_assurance_readiness_mismatch'],
    ['privacy', value => { value.privacy.safe_for_publication = true; }, 'privacy_mismatch'],
    ['summary', value => { value.summary.event_count = 99; }, 'summary_mismatch'],
    ['source', value => { value.source.partnership_claimed = true; }, 'source_policy_mismatch'],
    ['raw source', value => { value.source.relay_url = RELAY_URL; }, 'invalid_source'],
    ['event', value => { value.events[0].content.content_hash = ref('e'); }, 'event_commitments_mismatch'],
    ['raw event', value => { value.events[0].raw_event = { content: 'private' }; }, 'invalid_event_evidence'],
    ['raw reference', value => { value.events[0].references.repository_ref_hashes = ['private-repository']; }, 'event_reference_privacy_mismatch'],
    ['event authority', value => { value.events[0].authority.spend_allowed = true; }, 'event_authority_mismatch'],
    ['signature boundary', value => { value.events[0].signature.status = 'verified'; }, 'signature_evidence_boundary_mismatch'],
    ['relay binding', value => { value.events[0].relay_audit.claimed_binding.relay_url_hash = ref('f'); }, 'relay_attestation_binding_mismatch'],
  ];
  for (const [label, mutate, expectedFailure] of mutations) {
    const tampered = clone(bundle);
    mutate(tampered);
    const result = verifyBuzzEvidenceBundle(tampered, { expected_bundle_root: bundle.bundle_root });
    assert.equal(result.valid, false, `${label} mutation must fail verification`);
    assert(result.failures.includes(expectedFailure), `${label} mutation must report ${expectedFailure}`);
    assert(result.failures.includes('bundle_root_mismatch'), `${label} mutation must break the bundle root`);
  }

  const unexpectedField = { ...clone(bundle), created_at: new Date().toISOString() };
  const unexpectedResult = verifyBuzzEvidenceBundle(unexpectedField);
  assert.equal(unexpectedResult.valid, false);
  assert(unexpectedResult.failures.includes('unexpected_field:created_at'));

  const rehashedPolicyForgery = clone(bundle);
  rehashedPolicyForgery.events[0].authority.spend_allowed = true;
  rehashBundle(rehashedPolicyForgery);
  const rehashedResult = verifyBuzzEvidenceBundle(rehashedPolicyForgery);
  assert.equal(rehashedResult.valid, false);
  assert(rehashedResult.failures.includes('event_authority_mismatch'));
  assert(!rehashedResult.failures.includes('bundle_root_mismatch'));
});

test('pins the classifier to the reviewed Block/Buzz registry subset', async () => {
  const provenance = JSON.parse(await readFile(new URL('./upstream-provenance.json', import.meta.url), 'utf8'));
  assert.equal(BUZZ_UPSTREAM_PROVENANCE.commit, 'f029deafae6ad3b63e13c29104f3be76122cb1df');
  assert.equal(provenance.block_buzz.commit, BUZZ_UPSTREAM_PROVENANCE.commit);
  assert.deepEqual(provenance.block_buzz.classified_kind_subset, BUZZ_EVIDENCE_CONSTANTS.BUZZ_KINDS);
  assert.equal(provenance.block_buzz.kind_registry_sha256, BUZZ_UPSTREAM_PROVENANCE.kind_registry_sha256);
  assert.equal(provenance.nip_01.commit, BUZZ_UPSTREAM_PROVENANCE.nip01_commit);

  const workflow = event({ kind: 46004, created_at: 20, content: 'approval requested' });
  const patch = event({ kind: 1617, created_at: 10, content: 'patch body' });
  const bundle = compileBuzzEvidenceBundle({ events: [workflow, patch] });
  assert.equal(bundle.events[0].event_type, 'git_patch');
  assert.equal(bundle.events[1].event_type, 'workflow_event');
});

test('bounded content uses best-effort redaction and is marked raw and unsafe to publish', () => {
  const message = event({
    content: [
      'Deploy with Authorization: Bearer abcdefghijklmnop and api_key=secret-value-123.',
      'github_pat_SYNTHETIC0123456789ABCDEFG',
      'card=4111111111111111',
      'https://operator:private-password@private.example/path',
    ].join(' '),
  });
  const bundle = compileBuzzEvidenceBundle({ events: [message] }, {
    content_policy: 'bounded',
  });
  const evidence = bundle.events[0];

  assert.match(evidence.content.bounded_content, /\[REDACTED\]|_REDACTED\]/);
  assert(evidence.content.redaction_count >= 4);
  assert.doesNotMatch(evidence.content.bounded_content, /github_pat_|4111111111111111|operator:private-password/);
  assert.equal(evidence.content.policy, 'bounded_best_effort_redaction');
  assert.equal(evidence.content.raw_content_embedded, true);
  assert.equal(evidence.content.redaction_complete, false);
  assert.equal(evidence.content.safe_for_publication, false);
  assert.equal(evidence.source_integrity.raw_workspace_metadata_embedded, true);
  assert.equal(evidence.source_integrity.exact_content_embedded, false);
  assert.equal(bundle.privacy.raw_content_embedded, true);
  assert.equal(bundle.privacy.redaction_assurance, 'best_effort_known_patterns_only');
  assert.equal(bundle.privacy.safe_for_publication, false);
  assert(bundle.transaction_assurance_readiness.blockers.includes(
    'bounded_content_requires_explicit_authority_private_handling_and_publication_review',
  ));
});

test('redacts the complete content before applying the bounded-content limit', () => {
  const token = 'github_pat_SYNTHETIC0123456789ABCDEFG';
  const message = event({ content: `${'x'.repeat(7_990)} ${token} suffix` });
  const bundle = compileBuzzEvidenceBundle({ events: [message] }, { content_policy: 'bounded' });
  const content = bundle.events[0].content;

  assert.equal(content.truncated, true);
  assert.equal(content.redaction_complete, false);
  assert.doesNotMatch(content.bounded_content, /github_pat_|SYNTHETIC0123456789ABCDEFG/);
});

test('the CLI rejects oversized input before parsing it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agoragentic-buzz-evidence-'));
  try {
    const inputPath = join(directory, 'oversized.json');
    await writeFile(inputPath, Buffer.alloc(MAX_INPUT_BYTES + 1, 0x20));
    const result = spawnSync(process.execPath, ['cli.mjs', inputPath], {
      cwd: MODULE_DIR,
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /input_too_large/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('ships license and provenance in the declared package files', async () => {
  const packageJson = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
  const license = await readFile(new URL('./LICENSE', import.meta.url), 'utf8');
  assert(packageJson.files.includes('LICENSE'));
  assert(packageJson.files.includes('upstream-provenance.json'));
  assert(packageJson.files.includes('receipt-reference.example.json'));
  assert.match(license, /Apache License/);
});

test('the packed artifact installs and runs the local CLI without a network action', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agoragentic-buzz-packed-'));
  try {
    const installerDirectory = join(directory, 'installer');
    const inputPath = join(directory, 'events.json');
    const outputPath = join(directory, 'evidence.json');
    await mkdir(installerDirectory, { recursive: true });
    await writeFile(join(installerDirectory, 'package.json'), JSON.stringify({ private: true }), 'utf8');
    await writeFile(inputPath, JSON.stringify([event()]), 'utf8');

    const npmFlags = ['--ignore-scripts', '--offline', '--no-audit', '--no-fund'];
    const pack = runNpm(['pack', MODULE_DIR, ...npmFlags], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 20_000,
    });
    assert.equal(pack.status, 0, pack.error?.message || pack.stderr || pack.stdout);
    const tarball = (await readdir(directory))
      .find(file => file.endsWith('.tgz'));
    assert(tarball, 'npm pack did not produce a tarball');

    const install = runNpm(['install', join(directory, tarball), ...npmFlags], {
      cwd: installerDirectory,
      encoding: 'utf8',
      timeout: 20_000,
    });
    assert.equal(install.status, 0, install.error?.message || install.stderr || install.stdout);

    const installedCli = join(
      installerDirectory,
      'node_modules',
      '@agoragentic',
      'buzz-signed-workspace-evidence',
      'cli.mjs',
    );
    const installedPackageDirectory = dirname(installedCli);
    const installedLicense = await readFile(join(installedPackageDirectory, 'LICENSE'), 'utf8');
    const installedProvenance = JSON.parse(await readFile(
      join(installedPackageDirectory, 'upstream-provenance.json'),
      'utf8',
    ));
    const installedReferenceSchema = JSON.parse(await readFile(
      join(installedPackageDirectory, 'receipt-reference.schema.json'),
      'utf8',
    ));
    const installedReferenceExample = JSON.parse(await readFile(
      join(installedPackageDirectory, 'receipt-reference.example.json'),
      'utf8',
    ));
    assert.match(installedLicense, /Apache License/);
    assert.equal(installedProvenance.block_buzz.commit, BUZZ_UPSTREAM_PROVENANCE.commit);
    assert.equal(installedReferenceSchema.$id, 'https://agoragentic.com/schema/buzz-transaction-assurance-reference.v1.json');
    assert.equal(installedReferenceExample.schema, installedReferenceSchema.properties.schema.const);

    const run = spawnSync(process.execPath, [installedCli, inputPath, '--out', outputPath], {
      cwd: installerDirectory,
      encoding: 'utf8',
      timeout: 20_000,
    });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const output = JSON.parse(await readFile(outputPath, 'utf8'));
    assert.equal(output.schema, 'agoragentic.buzz-evidence-bundle.v2');
    assert.equal(output.authority.grants_spend, false);
    assert.equal(output.authority.posts_to_buzz, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('builds an unsigned proposal-only Transaction Assurance reference', () => {
  const reference = buildBuzzTransactionAssuranceReference({
    transaction_id: 'txn_123',
    buzz_event_id: event().id,
    evidence_bundle_root: ref('b'),
    mandate_ref: ref('c'),
    transaction_assurance_receipt_ref: ref('d'),
    claimed_states: {
      authority: 'verified',
      payment: 'final',
      execution: 'completed',
      delivery: 'verified',
      outcome: 'pass',
      reconciliation: 'complete',
    },
  });

  assert.equal(reference.schema, 'agoragentic.buzz-transaction-assurance-reference.v1');
  assert.equal(reference.publication.event_kind_assigned, false);
  assert.equal(reference.publication.signed, false);
  assert.equal(reference.publication.posted, false);
  assert.equal(reference.claimed_states.payment, 'final');
  assert.equal(reference.state_claims_verified, false);
  assert.equal(reference.authority.grants_publication, false);
  assert.match(reference.reference_hash, /^sha256:[a-f0-9]{64}$/);

  assert.throws(
    () => buildBuzzTransactionAssuranceReference({
      evidence_bundle_root: ref('b'),
      mandate_ref: ref('c'),
      transaction_assurance_receipt_ref: ref('d'),
      states: { payment: 'final' },
    }),
    error => error instanceof BuzzEvidenceError && error.code === 'deprecated_transaction_state_shape',
  );
  assert.throws(
    () => buildBuzzTransactionAssuranceReference({
      evidence_root: ref('b'),
      mandate_ref: ref('c'),
      transaction_assurance_receipt_ref: ref('d'),
    }),
    error => error instanceof BuzzEvidenceError && error.code === 'deprecated_evidence_root_shape',
  );
});

test('the deterministic proposal-only fixture conforms to its declared schema contract', async () => {
  const schema = JSON.parse(await readFile(new URL('./receipt-reference.schema.json', import.meta.url), 'utf8'));
  const fixture = JSON.parse(await readFile(new URL('./receipt-reference.example.json', import.meta.url), 'utf8'));
  assertReceiptReferenceInstance(schema, fixture);

  const regenerated = buildBuzzTransactionAssuranceReference({
    transaction_id: fixture.transaction_id,
    buzz_event_id: fixture.buzz_event_id,
    evidence_bundle_root: fixture.evidence_bundle_root,
    mandate_ref: fixture.mandate_ref,
    transaction_assurance_receipt_ref: fixture.transaction_assurance_receipt_ref,
    claimed_states: fixture.claimed_states,
  });
  assert.deepEqual(regenerated, fixture);
});
