import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalize, sha256Ref } from '../src/canonical.mjs';
import {
  createE2BAuthorityFreeSourceVerifier,
  scanE2BStagedBytesAuthorityFree,
} from '../src/adapters/e2b-source-verifier.mjs';
import {
  createImmutableWorkspaceExport,
  destroyImmutableWorkspaceExport,
} from '../src/adapters/e2b-workspace-export.mjs';
import { inspectLocalWorkspace } from '../src/adapters/local-reference.mjs';
import { sha256BytesRef, sha256FileRef } from '../src/e2b-qualification.mjs';
import { requireExternalEndpoint, requireOpaqueRef } from '../src/util.mjs';

const SYNTHETIC_AMK_KEY = `amk_${'a'.repeat(64)}`;
const DOCUMENTED_AMK_PLACEHOLDER = 'amk_your_api_key_here';

function independentTrust(options = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicKeyHash = sha256BytesRef(publicKey.export({ type: 'spki', format: 'der' }));
  return {
    independentVerifierPublicKey: publicKey,
    independentVerifierPublicKeyHash: publicKeyHash,
    requestIndependentVerification: options.requestIndependentVerification
      ?? (async (payload) => {
        const signedPayload = options.transformPayload?.(payload) ?? payload;
        return {
          ...signedPayload,
          signature: sign(
            null,
            Buffer.from(canonicalize(signedPayload), 'utf8'),
            privateKey,
          ).toString('base64url'),
        };
      }),
  };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-e2b-source-verifier-'));
  const source = path.join(root, 'source');
  const exportRoot = path.join(root, 'exports');
  const evidenceDirectory = path.join(root, 'evidence');
  const bootstrapPath = path.join(root, 'bootstrap.mjs');
  const runnerPath = path.join(root, 'runner.mjs');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(source, { recursive: true }));
  await writeFile(path.join(source, 'input.txt'), 'sanitized input\n');
  await writeFile(bootstrapPath, 'bootstrap artifact\n');
  await writeFile(runnerPath, 'runner artifact\n');
  const inspected = await inspectLocalWorkspace({ source_workspace: source });
  const exported = await createImmutableWorkspaceExport({
    source_workspace: source,
    export_root: exportRoot,
    export_id: 'source_verifier_fixture',
    expected_workspace_digest: inspected.workspace_digest,
  });
  const bootstrapHash = await sha256FileRef(bootstrapPath);
  const runnerHash = await sha256FileRef(runnerPath);
  const request = {
    schema: 'agoragentic.risk-fork.authority-free-source-request.v1',
    provider: 'e2b-clean-template-v1',
    cleanup_ref: 'cleanup:source-verifier',
    capsule_hash: sha256Ref('capsule'),
    workspace_digest: exported.workspace_digest,
    workspace_manifest_hash: exported.manifest_hash,
    file_count: exported.file_count,
    total_bytes: exported.total_bytes,
    files: exported.files,
    clean_template_id_hash: sha256Ref('template-id'),
    clean_template_evidence_hash: sha256Ref('template-evidence'),
    trusted_bootstrap_command_hash: sha256Ref('bootstrap-command'),
    trusted_runner_command_hash: sha256Ref('runner-command'),
    trusted_bootstrap_artifact_hash: bootstrapHash,
    trusted_runner_artifact_hash: runnerHash,
    request_hash: null,
  };
  request.request_hash = sha256Ref({ ...request, request_hash: null });
  t.after(async () => {
    await destroyImmutableWorkspaceExport({
      export_root: exportRoot,
      export_id: exported.export_id,
    }).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    exportRoot,
    evidenceDirectory,
    bootstrapPath,
    runnerPath,
    bootstrapHash,
    runnerHash,
    exported,
    request,
  };
}

async function replaceExportWithExactBytes(value, exactValue) {
  const payload = path.join(value.exported.payload_directory, 'input.txt');
  const manifestPath = path.join(value.exported.export_directory, 'manifest.json');
  const bytes = Buffer.isBuffer(exactValue) ? exactValue : Buffer.from(exactValue, 'utf8');
  const file = {
    path: 'input.txt',
    bytes: bytes.byteLength,
    content_hash: sha256Ref(bytes.toString('base64')),
  };
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.workspace_digest = sha256Ref([file]);
  manifest.file_count = 1;
  manifest.total_bytes = bytes.byteLength;
  manifest.files = [file];
  manifest.manifest_hash = null;
  manifest.manifest_hash = sha256Ref({ ...manifest, manifest_hash: null });
  await chmod(payload, 0o600);
  await chmod(manifestPath, 0o600);
  await writeFile(payload, bytes);
  await writeFile(manifestPath, JSON.stringify(manifest));
  const request = {
    ...structuredClone(value.request),
    workspace_digest: manifest.workspace_digest,
    workspace_manifest_hash: manifest.manifest_hash,
    file_count: 1,
    total_bytes: bytes.byteLength,
    files: [file],
    request_hash: null,
  };
  request.request_hash = sha256Ref({ ...request, request_hash: null });
  return request;
}

test('clean-side verifier independently reopens exact staged bytes and persists hash-only evidence', async (t) => {
  const value = await fixture(t);
  const verifier = createE2BAuthorityFreeSourceVerifier({
    verifierArtifactHash: sha256Ref('reviewed-source-verifier'),
    evidenceDirectory: value.evidenceDirectory,
    trustedBootstrapArtifactPath: value.bootstrapPath,
    trustedRunnerArtifactPath: value.runnerPath,
    clock: () => new Date('2030-01-01T00:00:00.000Z'),
    ...independentTrust(),
  });
  const attestation = await verifier(value.request, {
    export_directory: value.exported.export_directory,
  });
  assert.equal(attestation.status, 'verified');
  assert.equal(attestation.request_hash, value.request.request_hash);
  assert.equal(attestation.workspace_manifest_hash, value.exported.manifest_hash);
  assert.equal(attestation.claims.workspace_manifest_verified, true);
  assert.equal(attestation.claims.trusted_runtime_artifacts_verified, true);

  const evidenceFiles = await readdir(value.evidenceDirectory);
  assert.equal(evidenceFiles.length, 1);
  const evidence = JSON.parse(await readFile(
    path.join(value.evidenceDirectory, evidenceFiles[0]),
    'utf8',
  ));
  const serialized = JSON.stringify(evidence);
  assert.equal(serialized.includes(value.exported.export_directory), false);
  assert.equal(serialized.includes('sanitized input'), false);
  assert.equal(evidence.raw_bytes_included, false);
  assert.equal(evidence.local_paths_included, false);
  assert.equal(evidence.independent_signature_verified, true);
  assert.match(evidence.independent_verifier_key_hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(attestation.evidence_hash, evidence.evidence_hash);
});

test('source verifier rejects request, manifest, staged-byte, and runtime-artifact drift', async (t) => {
  const value = await fixture(t);
  const verifier = createE2BAuthorityFreeSourceVerifier({
    verifierArtifactHash: sha256Ref('reviewed-source-verifier'),
    evidenceDirectory: value.evidenceDirectory,
    trustedBootstrapArtifactPath: value.bootstrapPath,
    trustedRunnerArtifactPath: value.runnerPath,
    ...independentTrust(),
  });

  await assert.rejects(
    verifier({ ...value.request, request_hash: sha256Ref('wrong') }, {
      export_directory: value.exported.export_directory,
    }),
    /request hash/i,
  );

  await writeFile(value.bootstrapPath, 'changed bootstrap artifact\n');
  await assert.rejects(
    verifier(value.request, { export_directory: value.exported.export_directory }),
    /bootstrap artifact hash/i,
  );

  await writeFile(value.bootstrapPath, 'bootstrap artifact\n');
  const payload = path.join(value.exported.payload_directory, 'input.txt');
  await chmod(payload, 0o600);
  await writeFile(payload, 'changed staged bytes\n');
  await assert.rejects(
    verifier(value.request, { export_directory: value.exported.export_directory }),
    /manifest|digest|staged|exceeds/i,
  );
});

test('independent exact-byte second pass rejects quoted JSON and shell secret assignments', async (t) => {
  for (const [name, content] of [
    ['quoted JSON key', '{"api_key":"longsecretvalue"}\n'],
    ['quoted shell value', 'API_KEY="longsecretvalue"\n'],
  ]) {
    await t.test(name, async (subtest) => {
      const bytes = Buffer.from(content, 'utf8');
      assert.throws(
        () => scanE2BStagedBytesAuthorityFree([{
          path: 'input.txt',
          bytes: bytes.byteLength,
          content_hash: sha256Ref(bytes.toString('base64')),
          data_base64: bytes.toString('base64'),
        }]),
        /authority|secret/i,
      );
      const value = await fixture(subtest);
      const verifier = createE2BAuthorityFreeSourceVerifier({
        verifierArtifactHash: sha256Ref('reviewed-source-verifier'),
        evidenceDirectory: value.evidenceDirectory,
        trustedBootstrapArtifactPath: value.bootstrapPath,
        trustedRunnerArtifactPath: value.runnerPath,
        ...independentTrust(),
      });
      const request = await replaceExportWithExactBytes(value, content);
      await assert.rejects(
        verifier(request, { export_directory: value.exported.export_directory }),
        /authority|secret/i,
      );
    });
  }
});

test('synthetic amk_ material is rejected at opaque-ref, origin, and exact-byte boundaries', () => {
  assert.throws(
    () => requireOpaqueRef(`evidence:${SYNTHETIC_AMK_KEY}`, 'synthetic evidence ref'),
    /secret material/i,
  );
  assert.throws(
    () => requireExternalEndpoint(
      `https://example.invalid/${SYNTHETIC_AMK_KEY}`,
      'synthetic origin',
    ),
    /secret material/i,
  );

  const bytes = Buffer.from(`result=${SYNTHETIC_AMK_KEY}\n`, 'utf8');
  assert.throws(
    () => scanE2BStagedBytesAuthorityFree([{
      path: 'input.txt',
      bytes: bytes.byteLength,
      content_hash: sha256Ref(bytes.toString('base64')),
      data_base64: bytes.toString('base64'),
    }]),
    /authority|secret/i,
  );
});

test('exact-byte second pass rejects embedded, UTF-16, and base64 generated keys', () => {
  const utf16le = Buffer.from(`x${SYNTHETIC_AMK_KEY}y`, 'utf16le');
  const utf16be = Buffer.from(utf16le);
  utf16be.swap16();
  const encoded = Buffer.from(`x${SYNTHETIC_AMK_KEY}y`, 'utf8').toString('base64');
  const mimeEncoded = `${encoded.slice(0, 76)}\r\n${encoded.slice(76)}`;
  const paddedMimeVariants = [
    `${'p'.repeat(47)}${SYNTHETIC_AMK_KEY}`,
    `${'p'.repeat(47)}${SYNTHETIC_AMK_KEY}s`,
    `${'p'.repeat(48)}${SYNTHETIC_AMK_KEY}`,
  ].map((value) => {
    const base64 = Buffer.from(value, 'utf8').toString('base64');
    return Buffer.from(base64.match(/.{1,76}/g).join('\r\n'), 'ascii');
  });
  const variants = [
    Buffer.from(`x${SYNTHETIC_AMK_KEY}y`, 'utf8'),
    utf16le,
    utf16be,
    Buffer.from(encoded, 'ascii'),
    Buffer.from(mimeEncoded, 'ascii'),
    Buffer.concat([Buffer.from([0x58]), utf16le]),
    Buffer.concat([utf16be, Buffer.from([0x58])]),
    ...paddedMimeVariants,
  ];

  for (const bytes of variants) {
    assert.throws(
      () => scanE2BStagedBytesAuthorityFree([{
        path: 'input.txt',
        bytes: bytes.byteLength,
        content_hash: sha256Ref(bytes.toString('base64')),
        data_base64: bytes.toString('base64'),
      }]),
      /authority|secret/i,
    );
  }
});

test('exact-byte second pass rejects generated keys in paths without echoing them', () => {
  const bytes = Buffer.from('sanitized content', 'utf8');
  assert.throws(
    () => scanE2BStagedBytesAuthorityFree([{
      path: `src/x${SYNTHETIC_AMK_KEY}y.txt`,
      bytes: bytes.byteLength,
      content_hash: sha256Ref(bytes.toString('base64')),
      data_base64: bytes.toString('base64'),
    }]),
    (error) => {
      assert.match(error.message, /secret-shaped path/i);
      assert.equal(error.message.includes(SYNTHETIC_AMK_KEY), false);
      return true;
    },
  );
});

test('short documented amk_ placeholders remain valid non-secret examples', () => {
  assert.equal(
    requireOpaqueRef(`example:${DOCUMENTED_AMK_PLACEHOLDER}`, 'placeholder ref'),
    `example:${DOCUMENTED_AMK_PLACEHOLDER}`,
  );
  assert.equal(
    requireExternalEndpoint(
      `https://example.invalid/${DOCUMENTED_AMK_PLACEHOLDER}`,
      'placeholder origin',
    ),
    `https://example.invalid/${DOCUMENTED_AMK_PLACEHOLDER}`,
  );
  const bytes = Buffer.from(`example=${DOCUMENTED_AMK_PLACEHOLDER}\n`, 'utf8');
  assert.doesNotThrow(() => scanE2BStagedBytesAuthorityFree([{
    path: 'input.txt',
    bytes: bytes.byteLength,
    content_hash: sha256Ref(bytes.toString('base64')),
    data_base64: bytes.toString('base64'),
  }]));
});

test('defense-in-depth scan rejects common authority material outside the original regex set', () => {
  for (const content of [
    'DATABASE_URL=postgres://alice:Sup3rSecret@db.internal/prod',
    `const auth = "${['xoxb', '123456789012', 'abcdefghijklmnopqrstuv'].join('-')}"`,
    '-----BEGIN PGP PRIVATE KEY BLOCK-----\nabc\n-----END PGP PRIVATE KEY BLOCK-----',
    'NPM_TOKEN=abcdefghijklmnopqrstuvwxyz123456',
  ]) {
    const bytes = Buffer.from(content, 'utf8');
    assert.throws(
      () => scanE2BStagedBytesAuthorityFree([{
        path: 'input.txt',
        bytes: bytes.byteLength,
        content_hash: sha256Ref(bytes.toString('base64')),
        data_base64: bytes.toString('base64'),
      }]),
      /authority|secret/i,
    );
  }
});

test('categorical absence claims require a pinned independent signature over exact bindings', async (t) => {
  const value = await fixture(t);
  const common = {
    verifierArtifactHash: sha256Ref('reviewed-source-verifier'),
    evidenceDirectory: value.evidenceDirectory,
    trustedBootstrapArtifactPath: value.bootstrapPath,
    trustedRunnerArtifactPath: value.runnerPath,
  };
  assert.throws(
    () => createE2BAuthorityFreeSourceVerifier(common),
    /independent|public key|signature|trust/i,
  );

  const trust = independentTrust({
    requestIndependentVerification: async (payload) => ({
      ...payload,
      signature: 'A'.repeat(86),
    }),
  });
  const verifier = createE2BAuthorityFreeSourceVerifier({ ...common, ...trust });
  await assert.rejects(
    verifier(value.request, { export_directory: value.exported.export_directory }),
    /signature|independent/i,
  );
  assert.deepEqual(await readdir(value.evidenceDirectory).catch(() => []), []);

  const driftedVerifier = createE2BAuthorityFreeSourceVerifier({
    ...common,
    ...independentTrust({
      transformPayload: (payload) => ({
        ...payload,
        workspace_manifest_hash: sha256Ref('substituted-manifest'),
      }),
    }),
  });
  await assert.rejects(
    driftedVerifier(value.request, { export_directory: value.exported.export_directory }),
    /binding|manifest|independent/i,
  );
  assert.deepEqual(await readdir(value.evidenceDirectory).catch(() => []), []);
});
