import {
  createPublicKey,
  verify as verifySignature,
} from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  realpath,
} from 'node:fs/promises';
import path from 'node:path';

import { canonicalize, sha256Ref } from '../canonical.mjs';
import { sha256BytesRef, sha256FileRef } from '../e2b-qualification.mjs';
import {
  assertAllowedKeys,
  assertPlainObject,
  boundedInteger,
  cloneJson,
  deepFreeze,
  normalizeRelativePath,
  requireOpaqueRef,
  requireSha256Ref,
  requireString,
  safeEqual,
} from '../util.mjs';
import { readImmutableWorkspaceExport } from './e2b-workspace-export.mjs';

const REQUEST_SCHEMA = 'agoragentic.risk-fork.authority-free-source-request.v1';
const ATTESTATION_SCHEMA = 'agoragentic.risk-fork.authority-free-source-attestation.v1';
const EVIDENCE_SCHEMA = 'agoragentic.risk-fork.e2b-source-verification-evidence.v1';
export const E2B_INDEPENDENT_SOURCE_ATTESTATION_SCHEMA =
  'agoragentic.risk-fork.e2b-independent-source-attestation.v1';
const REQUEST_KEYS = Object.freeze([
  'schema',
  'provider',
  'cleanup_ref',
  'capsule_hash',
  'workspace_digest',
  'workspace_manifest_hash',
  'file_count',
  'total_bytes',
  'files',
  'clean_template_id_hash',
  'clean_template_evidence_hash',
  'trusted_bootstrap_command_hash',
  'trusted_runner_command_hash',
  'trusted_bootstrap_artifact_hash',
  'trusted_runner_artifact_hash',
  'request_hash',
]);
const SECRET_PATH_PATTERN = /(?:^|\/)(?:\.env(?:\..*)?|\.aws|\.azure|\.config\/gcloud|\.docker\/config\.json|\.git-credentials|\.netrc|\.npmrc|\.pypirc|\.ssh|credentials?(?:\.[^/]*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|private[_-]?key(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|wallet(?:\.[^/]*)?)(?:$|\/)/i;
const SECRET_CONTENT_PATTERNS = Object.freeze([
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /-----BEGIN PGP PRIVATE KEY BLOCK-----/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\be2b_[A-Za-z0-9_-]{12,}/,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/i,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|https?):\/\/[^/\s:@]+:[^@\s/]{3,}@/i,
]);
const SECRET_ASSIGNMENT_KEY = String.raw`(?:api[_-]?key|access[_-]?token|refresh[_-]?token|npm[_-]?token|slack[_-]?token|database[_-]?url|authorization|credential|password|passphrase|private[_-]?key|client[_-]?secret|seed[_-]?phrase|mnemonic|wallet[_-]?(?:key|secret))`;
const SECRET_ASSIGNMENT_PATTERN = new RegExp(
  String.raw`(?:^|[^A-Za-z0-9_])(?:"${SECRET_ASSIGNMENT_KEY}"|'${SECRET_ASSIGNMENT_KEY}'|${SECRET_ASSIGNMENT_KEY})\s*[=:]\s*(?:"((?:\\[\s\S]|[^"\\])*)"|'((?:\\[\s\S]|[^'\\])*)'|([^&\s"',;}\]]+))`,
  'gi',
);
const MIN_SECRET_ASSIGNMENT_BYTES = 8;

function containsSecretAssignment(exactBytesText) {
  SECRET_ASSIGNMENT_PATTERN.lastIndex = 0;
  for (let match = SECRET_ASSIGNMENT_PATTERN.exec(exactBytesText);
    match;
    match = SECRET_ASSIGNMENT_PATTERN.exec(exactBytesText)) {
    const value = match[1] ?? match[2] ?? match[3] ?? '';
    if (value.length >= MIN_SECRET_ASSIGNMENT_BYTES) return true;
  }
  return false;
}

function requireEd25519Signature(value) {
  if (typeof value !== 'string'
    || value.length < 80
    || value.length > 100
    || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new TypeError('E2B independent source signature must be canonical base64url');
  }
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== 64 || bytes.toString('base64url') !== value) {
    throw new TypeError('E2B independent source signature must be a canonical Ed25519 signature');
  }
  return bytes;
}

function independentAttestationPayload(request, verifierKeyHash, verifierArtifactHash) {
  return deepFreeze({
    schema: E2B_INDEPENDENT_SOURCE_ATTESTATION_SCHEMA,
    status: 'verified',
    source_request_hash: request.request_hash,
    workspace_digest: request.workspace_digest,
    workspace_manifest_hash: request.workspace_manifest_hash,
    file_manifest_hash: sha256Ref(request.files),
    clean_template_id_hash: request.clean_template_id_hash,
    clean_template_evidence_hash: request.clean_template_evidence_hash,
    trusted_bootstrap_artifact_hash: request.trusted_bootstrap_artifact_hash,
    trusted_runner_artifact_hash: request.trusted_runner_artifact_hash,
    scanner_artifact_hash: verifierArtifactHash,
    verifier_key_hash: verifierKeyHash,
    claims: {
      authority_free: true,
      credentials_absent: true,
      wallet_material_absent: true,
      execution_authority_absent: true,
      exact_request_export_manifest_binding_verified: true,
    },
  });
}

function validateRequest(value) {
  assertPlainObject(value, 'E2B authority-free source request');
  assertAllowedKeys(value, REQUEST_KEYS, 'E2B authority-free source request');
  if (value.schema !== REQUEST_SCHEMA || value.provider !== 'e2b-clean-template-v1') {
    throw new TypeError('E2B authority-free source request schema or provider is invalid');
  }
  requireOpaqueRef(value.cleanup_ref, 'E2B source request.cleanup_ref');
  for (const field of [
    'capsule_hash',
    'workspace_digest',
    'workspace_manifest_hash',
    'clean_template_id_hash',
    'clean_template_evidence_hash',
    'trusted_bootstrap_command_hash',
    'trusted_runner_command_hash',
    'trusted_bootstrap_artifact_hash',
    'trusted_runner_artifact_hash',
    'request_hash',
  ]) {
    requireSha256Ref(value[field], `E2B source request.${field}`);
  }
  const fileCount = boundedInteger(value.file_count, 'E2B source request.file_count', {
    min: 0,
    max: 100_000,
  });
  const totalBytes = boundedInteger(value.total_bytes, 'E2B source request.total_bytes', {
    min: 0,
    max: 1024 * 1024 * 1024,
  });
  if (!Array.isArray(value.files) || value.files.length !== fileCount) {
    throw new TypeError('E2B source request file manifest is invalid');
  }
  let summedBytes = 0;
  const files = value.files.map((entry, index) => {
    const field = `E2B source request.files[${index}]`;
    assertPlainObject(entry, field);
    assertAllowedKeys(entry, ['path', 'bytes', 'content_hash'], field);
    const relative = normalizeRelativePath(entry.path, `${field}.path`);
    const bytes = boundedInteger(entry.bytes, `${field}.bytes`, {
      min: 0,
      max: 1024 * 1024 * 1024,
    });
    summedBytes += bytes;
    return {
      path: relative,
      bytes,
      content_hash: requireSha256Ref(entry.content_hash, `${field}.content_hash`),
    };
  });
  if (summedBytes !== totalBytes) throw new Error('E2B source request total_bytes mismatch');
  const uniquePaths = new Set(files.map((entry) => entry.path));
  if (uniquePaths.size !== files.length) throw new Error('E2B source request paths are not unique');
  const expectedHash = sha256Ref({ ...cloneJson(value), request_hash: null });
  if (!safeEqual(value.request_hash, expectedHash)) {
    throw new Error('E2B authority-free source request hash mismatch');
  }
  const normalized = { ...cloneJson(value), files };
  if (canonicalize(normalized) !== canonicalize(value)) {
    throw new Error('E2B authority-free source request is not canonical and closed');
  }
  return normalized;
}

export function scanE2BStagedBytesAuthorityFree(files) {
  for (const file of files) {
    if (SECRET_PATH_PATTERN.test(file.path)) {
      throw new Error('E2B staged export contains a secret-shaped path');
    }
    const content = Buffer.from(file.data_base64, 'base64');
    if (content.byteLength !== file.bytes
      || !safeEqual(sha256Ref(content.toString('base64')), file.content_hash)) {
      throw new Error('E2B staged export exact-byte binding mismatch');
    }
    const exactText = content.toString('latin1');
    if (SECRET_CONTENT_PATTERNS.some((pattern) => pattern.test(exactText))
      || containsSecretAssignment(exactText)) {
      throw new Error('E2B staged export contains authority or secret-shaped material');
    }
  }
}

async function assertRealDirectory(directory, field) {
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new TypeError(`${field} must be a real directory`);
  }
  const resolved = await realpath(directory);
  if (resolved !== directory) throw new Error(`${field} must already be canonical`);
}

async function persistEvidence(directory, record) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertRealDirectory(directory, 'E2B source evidence directory');
  const name = `e2b-source-${record.request_hash.slice(7, 31)}.json`;
  const target = path.join(directory, name);
  const handle = await open(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o400,
  );
  try {
    await handle.writeFile(`${canonicalize(record)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function createE2BAuthorityFreeSourceVerifier(options = {}) {
  const verifierArtifactHash = requireSha256Ref(
    options.verifierArtifactHash,
    'E2B source verifierArtifactHash',
  );
  const evidenceDirectory = path.resolve(requireString(
    options.evidenceDirectory,
    'E2B source evidenceDirectory',
  ));
  const trustedBootstrapArtifactPath = options.trustedBootstrapArtifactPath;
  const trustedRunnerArtifactPath = options.trustedRunnerArtifactPath;
  if (!(typeof trustedBootstrapArtifactPath === 'string'
    || trustedBootstrapArtifactPath instanceof URL)) {
    throw new TypeError('trustedBootstrapArtifactPath must be a path or file URL');
  }
  if (!(typeof trustedRunnerArtifactPath === 'string'
    || trustedRunnerArtifactPath instanceof URL)) {
    throw new TypeError('trustedRunnerArtifactPath must be a path or file URL');
  }
  if (typeof options.requestIndependentVerification !== 'function') {
    throw new TypeError(
      'requestIndependentVerification must be an external independent source verifier',
    );
  }
  let independentVerifierPublicKey;
  try {
    independentVerifierPublicKey = options.independentVerifierPublicKey?.type === 'public'
      ? options.independentVerifierPublicKey
      : createPublicKey(options.independentVerifierPublicKey);
  } catch {
    throw new TypeError('independentVerifierPublicKey must be a valid public key');
  }
  if (independentVerifierPublicKey.asymmetricKeyType !== 'ed25519') {
    throw new TypeError('independentVerifierPublicKey must be Ed25519');
  }
  const observedIndependentVerifierKeyHash = sha256BytesRef(
    independentVerifierPublicKey.export({ type: 'spki', format: 'der' }),
  );
  const expectedIndependentVerifierKeyHash = requireSha256Ref(
    options.independentVerifierPublicKeyHash,
    'independentVerifierPublicKeyHash',
  );
  if (!safeEqual(observedIndependentVerifierKeyHash, expectedIndependentVerifierKeyHash)) {
    throw new Error('independentVerifierPublicKeyHash does not match the pinned public key');
  }
  const clock = options.clock ?? (() => new Date());
  if (typeof clock !== 'function') throw new TypeError('E2B source verifier clock must be a function');

  return async function verifyAuthorityFreeSource(requestValue, context = {}) {
    const request = validateRequest(requestValue);
    assertPlainObject(context, 'E2B source verifier context');
    assertAllowedKeys(context, ['export_directory'], 'E2B source verifier context');
    const exportDirectory = path.resolve(requireString(
      context.export_directory,
      'E2B source verifier export_directory',
    ));
    await assertRealDirectory(exportDirectory, 'E2B source verifier export_directory');
    const exportId = path.basename(exportDirectory);
    const exportRoot = path.dirname(exportDirectory);
    const staged = await readImmutableWorkspaceExport({
      export_root: exportRoot,
      export_id: exportId,
      manifest_hash: request.workspace_manifest_hash,
      workspace_digest: request.workspace_digest,
    });
    if (staged.manifest.file_count !== request.file_count
      || staged.manifest.total_bytes !== request.total_bytes
      || canonicalize(staged.manifest.files) !== canonicalize(request.files)) {
      throw new Error('E2B independently reopened staged export does not match the request manifest');
    }
    scanE2BStagedBytesAuthorityFree(staged.files);

    const bootstrapArtifactHash = await sha256FileRef(trustedBootstrapArtifactPath);
    const runnerArtifactHash = await sha256FileRef(trustedRunnerArtifactPath);
    if (!safeEqual(bootstrapArtifactHash, request.trusted_bootstrap_artifact_hash)) {
      throw new Error('E2B trusted bootstrap artifact hash does not match the reviewed file');
    }
    if (!safeEqual(runnerArtifactHash, request.trusted_runner_artifact_hash)) {
      throw new Error('E2B trusted runner artifact hash does not match the reviewed file');
    }

    const independentPayload = independentAttestationPayload(
      request,
      observedIndependentVerifierKeyHash,
      verifierArtifactHash,
    );
    const independentAttestation = await options.requestIndependentVerification(
      independentPayload,
      { export_directory: exportDirectory },
    );
    assertPlainObject(independentAttestation, 'E2B independent source attestation');
    assertAllowedKeys(
      independentAttestation,
      [...Object.keys(independentPayload), 'signature'],
      'E2B independent source attestation',
    );
    const { signature: signatureValue, ...signedPayload } = independentAttestation;
    if (canonicalize(signedPayload) !== canonicalize(independentPayload)) {
      throw new Error('E2B independent source attestation binding mismatch');
    }
    const signature = requireEd25519Signature(signatureValue);
    if (!verifySignature(
      null,
      Buffer.from(canonicalize(independentPayload), 'utf8'),
      independentVerifierPublicKey,
      signature,
    )) {
      throw new Error('E2B independent source attestation signature is invalid');
    }
    const independentAttestationHash = sha256Ref(independentAttestation);

    const evidenceCore = {
      schema: EVIDENCE_SCHEMA,
      status: 'verified_deterministic_clean_side_second_pass',
      observed_at: new Date(clock()).toISOString(),
      request_hash: request.request_hash,
      capsule_hash: request.capsule_hash,
      workspace_digest: request.workspace_digest,
      workspace_manifest_hash: request.workspace_manifest_hash,
      file_manifest_hash: sha256Ref(request.files),
      verifier_artifact_hash: verifierArtifactHash,
      trusted_bootstrap_artifact_hash: bootstrapArtifactHash,
      trusted_runner_artifact_hash: runnerArtifactHash,
      file_count: request.file_count,
      total_bytes: request.total_bytes,
      exact_staged_bytes_reopened: true,
      secret_and_authority_scan_passed: true,
      independent_signature_verified: true,
      independent_verifier_key_hash: observedIndependentVerifierKeyHash,
      independent_attestation_hash: independentAttestationHash,
      same_process_independent_review_claimed: false,
      raw_bytes_included: false,
      local_paths_included: false,
      credentials_included: false,
      wallet_material_included: false,
      execution_authority_included: false,
      evidence_hash: null,
    };
    const evidence = {
      ...evidenceCore,
      evidence_hash: sha256Ref(evidenceCore),
    };
    await persistEvidence(evidenceDirectory, evidence);
    return deepFreeze({
      schema: ATTESTATION_SCHEMA,
      status: 'verified',
      request_hash: request.request_hash,
      evidence_ref: `e2b-source-verification:${request.request_hash.slice(7, 31)}`,
      evidence_hash: evidence.evidence_hash,
      workspace_digest: request.workspace_digest,
      workspace_manifest_hash: request.workspace_manifest_hash,
      trusted_bootstrap_artifact_hash: bootstrapArtifactHash,
      trusted_runner_artifact_hash: runnerArtifactHash,
      claims: {
        authority_free: true,
        credentials_absent: true,
        wallet_material_absent: true,
        execution_authority_absent: true,
        workspace_manifest_verified: true,
        immutable_export_verified: true,
        trusted_runtime_artifacts_verified: true,
      },
    });
  };
}
