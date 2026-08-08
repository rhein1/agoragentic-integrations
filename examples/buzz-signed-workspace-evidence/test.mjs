import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  BUZZ_EVIDENCE_CONSTANTS,
  BUZZ_UPSTREAM_PROVENANCE,
  BuzzEvidenceError,
  buildBuzzTransactionAssuranceReference,
  canonicalBuzzEventId,
  compileBuzzEvidenceBundle,
} from './buzz-event-evidence.mjs';
import { MAX_INPUT_BYTES } from './cli.mjs';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PUBKEY_A = '1'.repeat(64);
const PUBKEY_B = '2'.repeat(64);
const SIGNATURE = '3'.repeat(128);
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

function typedAttestations(message) {
  const preliminary = compileBuzzEvidenceBundle({ events: [message] });
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
  assert.match(instance.evidence_root, shaRefPattern);
  assert.match(instance.mandate_ref, shaRefPattern);
  assert.match(instance.transaction_assurance_receipt_ref, shaRefPattern);
  assert.match(instance.reference_hash, shaRefPattern);
  assert.match(instance.buzz_event_id, new RegExp(schema.properties.buzz_event_id.pattern));
  assert.equal(typeof instance.transaction_id, 'string');
  assert(instance.transaction_id.length <= schema.properties.transaction_id.maxLength);

  const stateSchema = schema.properties.states;
  assert.deepEqual(Object.keys(instance.states).sort(), stateSchema.required.slice().sort());
  for (const value of Object.values(instance.states)) {
    assert.equal(typeof value, 'string');
    assert(value.length <= stateSchema.properties.authority.maxLength);
  }

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
  assert.equal(bundle.source.metadata_policy, 'hash_only');
  assert.equal(bundle.source.raw_source_metadata_embedded, false);
  assert.equal(bundle.source.compatibility_verified_against_live_relay, false);
  assert.equal(bundle.events[0].author_pubkey, undefined);
  assert.match(bundle.events[0].references.channel_ref_hashes[0], /^sha256:[a-f0-9]{64}$/);
  assert.equal(bundle.transaction_assurance_readiness.ready_for_economic_action, false);
  assert(bundle.transaction_assurance_readiness.blockers.includes('workspace_membership_is_not_an_economic_mandate'));
  assert.doesNotMatch(serialized, /channel-private-42|private-engineering|username:password|internal-release-identifier/);
});

test('records typed, event-bound attestations as unverified claims rather than external verification', () => {
  const message = event();
  const bundle = compileBuzzEvidenceBundle({ events: [message] }, typedAttestations(message));

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
    () => compileBuzzEvidenceBundle({ events: [message] }, mismatched),
    error => error instanceof BuzzEvidenceError && error.code === 'attestation_binding_mismatch',
  );

  const forgedButWellFormed = typedAttestations(message);
  forgedButWellFormed.signature_attestations[message.id].verifier = 'attacker-supplied-label';
  forgedButWellFormed.signature_attestations[message.id].attestation_ref = ref('f');
  const forgedBundle = compileBuzzEvidenceBundle({ events: [message] }, forgedButWellFormed);
  assert.equal(
    forgedBundle.events[0].signature.status,
    'validity_claimed_by_unverified_attestation_reference',
  );
  assert.equal(forgedBundle.events[0].signature.signature_valid, null);
  assert.equal(forgedBundle.events[0].signature.attestation_reference_verified, false);
});

test('commits all material evidence and source metadata into the event root', () => {
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
    compileBuzzEvidenceBundle({ ...input, relay_url: 'wss://other.example.test' }, options).event_root,
    baseline,
  );

  const signatureMutationEvent = { ...message, sig: '4'.repeat(128) };
  assert.notEqual(
    compileBuzzEvidenceBundle({ ...input, events: [signatureMutationEvent] }, typedAttestations(signatureMutationEvent)).event_root,
    baseline,
  );
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

test('bounded content is redacted and never represented as exact after redaction', () => {
  const message = event({
    content: 'Deploy with Authorization: Bearer abcdefghijklmnop and api_key=secret-value-123.',
  });
  const bundle = compileBuzzEvidenceBundle({ events: [message] }, {
    content_policy: 'bounded',
  });
  const evidence = bundle.events[0];

  assert.match(evidence.content.bounded_content, /\[REDACTED\]/);
  assert(evidence.content.redaction_count >= 1);
  assert.equal(evidence.source_integrity.exact_content_embedded, false);
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

    const npmCli = process.env.npm_execpath;
    assert(npmCli, 'npm_execpath must be available when running the package test script');
    const npmFlags = ['--ignore-scripts', '--offline', '--no-audit', '--no-fund'];
    const pack = spawnSync(process.execPath, [npmCli, 'pack', MODULE_DIR, ...npmFlags], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 20_000,
    });
    assert.equal(pack.status, 0, pack.error?.message || pack.stderr || pack.stdout);
    const tarball = (await readdir(directory))
      .find(file => file.endsWith('.tgz'));
    assert(tarball, 'npm pack did not produce a tarball');

    const install = spawnSync(process.execPath, [npmCli, 'install', join(directory, tarball), ...npmFlags], {
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
    evidence_root: ref('b'),
    mandate_ref: ref('c'),
    transaction_assurance_receipt_ref: ref('d'),
    states: {
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
  assert.equal(reference.authority.grants_publication, false);
  assert.match(reference.reference_hash, /^sha256:[a-f0-9]{64}$/);
});

test('the deterministic proposal-only fixture conforms to its declared schema contract', async () => {
  const schema = JSON.parse(await readFile(new URL('./receipt-reference.schema.json', import.meta.url), 'utf8'));
  const fixture = JSON.parse(await readFile(new URL('./receipt-reference.example.json', import.meta.url), 'utf8'));
  assertReceiptReferenceInstance(schema, fixture);

  const regenerated = buildBuzzTransactionAssuranceReference({
    transaction_id: fixture.transaction_id,
    buzz_event_id: fixture.buzz_event_id,
    evidence_root: fixture.evidence_root,
    mandate_ref: fixture.mandate_ref,
    transaction_assurance_receipt_ref: fixture.transaction_assurance_receipt_ref,
    states: fixture.states,
  });
  assert.deepEqual(regenerated, fixture);
});
