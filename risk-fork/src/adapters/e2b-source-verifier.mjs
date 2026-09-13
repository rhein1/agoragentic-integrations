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
import { TextDecoder } from 'node:util';

import { canonicalize, sha256Ref } from '../canonical.mjs';
import { sha256BytesRef, sha256FileRef } from '../e2b-qualification.mjs';
import {
  AGORAGENTIC_API_KEY_PATTERN,
  BEARER_CREDENTIAL_PATTERN,
  EMBEDDED_CREDENTIAL_TOKEN_PATTERN,
  GENERIC_CREDENTIAL_TOKEN_PATTERN,
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
  securityPatternMatches,
  securityPatternsMatch,
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
  BEARER_CREDENTIAL_PATTERN,
  AGORAGENTIC_API_KEY_PATTERN,
  EMBEDDED_CREDENTIAL_TOKEN_PATTERN,
  GENERIC_CREDENTIAL_TOKEN_PATTERN,
  /\be2b_[A-Za-z0-9_-]{12,}/,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/i,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|https?):\/\/[^/\s:@]+:[^@\s/]{3,}@/i,
]);
const SECRET_ASSIGNMENT_KEY = String.raw`(?:api[_-]?key|access[_-]?token|refresh[_-]?token|npm[_-]?token|slack[_-]?token|database[_-]?url|authorization|credential|password|passphrase|private[_-]?key|client[_-]?secret|seed[_-]?phrase|mnemonic|wallet[_-]?(?:key|secret))`;
const SECRET_ASSIGNMENT_KEY_PATTERN = new RegExp(`^(?:${SECRET_ASSIGNMENT_KEY})$`, 'i');
const SECRET_ASSIGNMENT_DELIMITER_SOURCES = String.raw`=:\u02D0\u02F8\u0589\u05C3\u0703\u0704\u1400\u16EC\u1803\u1809\u205A\u207C\u208C\u2236\u2260\u2E40\u30A0\uA4FD\uA4FF\uA789\uFE13\uFE30\uFE55\uFE66\uFF1A\uFF1D\u{10781}\u{11DD9}`;
const SECRET_ASSIGNMENT_DELIMITER_PATTERN = /^[=:]$/u;
const SECRET_ASSIGNMENT_EXACT_KEY_PATTERN = new RegExp(
  String.raw`(?<![A-Za-z0-9_])(?:"(${SECRET_ASSIGNMENT_KEY})"|'(${SECRET_ASSIGNMENT_KEY})'|(${SECRET_ASSIGNMENT_KEY}))\s*([${SECRET_ASSIGNMENT_DELIMITER_SOURCES}])`,
  'giu',
);
const SECRET_ASSIGNMENT_CONFUSABLE_KEY_PATTERN = new RegExp(
  String.raw`(?<![A-Za-z0-9_])(?:"((?=[^"\r\n]{0,119}[^\x00-\x7f"\r\n])[^"\r\n]{1,120})"|'((?=[^'\r\n]{0,119}[^\x00-\x7f'\r\n])[^'\r\n]{1,120})'|((?=[^\s${SECRET_ASSIGNMENT_DELIMITER_SOURCES}\n,;{}\[\]"']{0,119}[^\x00-\x7f\s${SECRET_ASSIGNMENT_DELIMITER_SOURCES}\n,;{}\[\]"'])[^\s${SECRET_ASSIGNMENT_DELIMITER_SOURCES}\n,;{}\[\]"']{1,120}))\s*([${SECRET_ASSIGNMENT_DELIMITER_SOURCES}])`,
  'gu',
);
const SECRET_ASSIGNMENT_DELIMITER_SOURCE_PATTERN = new RegExp(
  `[${SECRET_ASSIGNMENT_DELIMITER_SOURCES}]`,
  'u',
);
const NON_ASCII_PATTERN = /[^\x00-\x7f]/u;
const MIN_SECRET_ASSIGNMENT_BYTES = 8;
const BASE64_CANDIDATE_PATTERN = /[A-Za-z0-9+/_-]{16,}={0,2}/g;
const MIME_BASE64_BLOCK_PATTERN = /(?:[A-Za-z0-9+/_-]{4,76}[ \t]*\r?\n){1,}[A-Za-z0-9+/_-]{2,76}={0,2}/g;

function exactPatternMatches(pattern, value) {
  pattern.lastIndex = 0;
  const matched = pattern.test(value);
  pattern.lastIndex = 0;
  return matched;
}

function isSecretAssignmentWhitespace(character) {
  const codePoint = character.charCodeAt(0);
  return (codePoint >= 0x0009 && codePoint <= 0x000d)
    || codePoint === 0x0020
    || codePoint === 0x00a0
    || codePoint === 0x1680
    || (codePoint >= 0x2000 && codePoint <= 0x200a)
    || codePoint === 0x2028
    || codePoint === 0x2029
    || codePoint === 0x202f
    || codePoint === 0x205f
    || codePoint === 0x3000
    || codePoint === 0xfeff;
}

function isUnquotedSecretAssignmentTerminator(character) {
  return isSecretAssignmentWhitespace(character)
    || character === '&'
    || character === '"'
    || character === "'"
    || character === ','
    || character === ';'
    || character === '{'
    || character === '}'
    || character === ']';
}

function readSecretAssignmentValue(text, startIndex, valueEncoding) {
  let index = startIndex;
  while (index < text.length && isSecretAssignmentWhitespace(text[index])) index += 1;
  if (index >= text.length) {
    return { matched: false, hasMinimumBytes: false, nextIndex: index };
  }

  const quote = text[index] === '"' || text[index] === "'" ? text[index] : null;
  if (quote) {
    const valueStart = index + 1;
    let hasMinimumBytes = false;
    index = valueStart;
    while (index < text.length) {
      if (text[index] === quote) {
        return { matched: true, hasMinimumBytes, nextIndex: index + 1 };
      }
      if (text[index] === '\\') {
        index += 1;
        if (index >= text.length) {
          return { matched: false, hasMinimumBytes: false, nextIndex: index };
        }
      }
      index += 1;
      if (!hasMinimumBytes) {
        hasMinimumBytes = Buffer.byteLength(
          text.slice(valueStart, index),
          valueEncoding,
        ) >= MIN_SECRET_ASSIGNMENT_BYTES;
      }
      if (hasMinimumBytes) {
        return { matched: true, hasMinimumBytes: true, nextIndex: index };
      }
    }
    return { matched: false, hasMinimumBytes: false, nextIndex: index };
  }

  const valueStart = index;
  while (index < text.length && !isUnquotedSecretAssignmentTerminator(text[index])) {
    index += 1;
    if (Buffer.byteLength(text.slice(valueStart, index), valueEncoding)
      >= MIN_SECRET_ASSIGNMENT_BYTES) {
      return { matched: true, hasMinimumBytes: true, nextIndex: index };
    }
  }
  return {
    matched: index > valueStart,
    hasMinimumBytes: false,
    nextIndex: index,
  };
}

function containsSecretAssignment(text, { normalizeUnicode, valueEncoding }) {
  const inspectConfusableKeys = normalizeUnicode
    && NON_ASCII_PATTERN.test(text)
    && SECRET_ASSIGNMENT_DELIMITER_SOURCE_PATTERN.test(text);
  const assignmentPatterns = inspectConfusableKeys
    ? [SECRET_ASSIGNMENT_EXACT_KEY_PATTERN, SECRET_ASSIGNMENT_CONFUSABLE_KEY_PATTERN]
    : [SECRET_ASSIGNMENT_EXACT_KEY_PATTERN];
  for (const assignmentPattern of assignmentPatterns) {
    assignmentPattern.lastIndex = 0;
    for (let match = assignmentPattern.exec(text);
      match;
      match = assignmentPattern.exec(text)) {
      const key = match[1] ?? match[2] ?? match[3] ?? '';
      const delimiter = match[4] ?? '';
      const keyMatches = normalizeUnicode
        ? securityPatternMatches(SECRET_ASSIGNMENT_KEY_PATTERN, key)
        : exactPatternMatches(SECRET_ASSIGNMENT_KEY_PATTERN, key);
      const delimiterMatches = normalizeUnicode
        ? securityPatternMatches(SECRET_ASSIGNMENT_DELIMITER_PATTERN, delimiter)
        : exactPatternMatches(SECRET_ASSIGNMENT_DELIMITER_PATTERN, delimiter);
      if (!keyMatches || !delimiterMatches) continue;
      const value = readSecretAssignmentValue(text, assignmentPattern.lastIndex, valueEncoding);
      assignmentPattern.lastIndex = value.nextIndex;
      if (value.matched && value.hasMinimumBytes) {
        assignmentPattern.lastIndex = 0;
        return true;
      }
    }
    assignmentPattern.lastIndex = 0;
  }
  return false;
}

function bytePreservationTextViews(content) {
  const views = [{
    text: content.toString('latin1'),
    valueEncoding: 'latin1',
    normalizeAssignments: false,
  }];
  for (const offset of [0, 1]) {
    const available = content.byteLength - offset;
    const evenBytes = available - (available % 2);
    if (evenBytes <= 0) continue;
    const aligned = content.subarray(offset, offset + evenBytes);
    views.push({
      text: aligned.toString('utf16le'),
      valueEncoding: 'utf16le',
      normalizeAssignments: true,
    });
    const bigEndian = Buffer.from(aligned);
    bigEndian.swap16();
    views.push({
      text: bigEndian.toString('utf16le'),
      valueEncoding: 'utf16le',
      normalizeAssignments: true,
    });
  }
  return views;
}

function fatalDecode(content, encoding) {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(content);
  } catch {
    return null;
  }
}

function canonicalUnicodeTextViews(content) {
  const views = [];
  const utf8 = fatalDecode(content, 'utf-8');
  if (utf8 !== null) views.push({ text: utf8, valueEncoding: 'utf8' });
  if (content.byteLength >= 2 && (content.byteLength - 2) % 2 === 0) {
    if (content[0] === 0xff && content[1] === 0xfe) {
      const utf16le = fatalDecode(content.subarray(2), 'utf-16le');
      if (utf16le !== null) views.push({ text: utf16le, valueEncoding: 'utf16le' });
    } else if (content[0] === 0xfe && content[1] === 0xff) {
      const utf16be = fatalDecode(content.subarray(2), 'utf-16be');
      if (utf16be !== null) views.push({ text: utf16be, valueEncoding: 'utf16le' });
    }
  }
  return views;
}

function decodeCanonicalBase64(candidate) {
  const normalized = candidate.replaceAll('-', '+').replaceAll('_', '/').replace(/=+$/, '');
  if (normalized.length % 4 === 1) return null;
  const padded = `${normalized}${'='.repeat((4 - (normalized.length % 4)) % 4)}`;
  const decoded = Buffer.from(padded, 'base64');
  if (decoded.toString('base64').replace(/=+$/, '') !== normalized) return null;
  return decoded;
}

function containsRecognizedSecretText(text) {
  return securityPatternsMatch(SECRET_CONTENT_PATTERNS, text)
    || containsSecretAssignment(text, { normalizeUnicode: true, valueEncoding: 'utf8' });
}

function containsRecognizedSecretView(view, { normalizePatterns, normalizeAssignments }) {
  const patternMatched = normalizePatterns
    ? securityPatternsMatch(SECRET_CONTENT_PATTERNS, view.text)
    : SECRET_CONTENT_PATTERNS.some((pattern) => exactPatternMatches(pattern, view.text));
  return patternMatched || containsSecretAssignment(view.text, {
    normalizeUnicode: normalizeAssignments,
    valueEncoding: view.valueEncoding,
  });
}

function containsRecognizedSecretPayload(content) {
  return bytePreservationTextViews(content).some(
    (view) => containsRecognizedSecretView(view, {
      normalizePatterns: false,
      normalizeAssignments: view.normalizeAssignments,
    }),
  ) || canonicalUnicodeTextViews(content).some(
    (view) => containsRecognizedSecretView(view, {
      normalizePatterns: true,
      normalizeAssignments: true,
    }),
  );
}

function containsRecognizedSecretBytes(content) {
  const rawViews = bytePreservationTextViews(content);
  if (containsRecognizedSecretPayload(content)) return true;
  for (const { text } of rawViews) {
    BASE64_CANDIDATE_PATTERN.lastIndex = 0;
    for (let match = BASE64_CANDIDATE_PATTERN.exec(text);
      match;
      match = BASE64_CANDIDATE_PATTERN.exec(text)) {
      const decoded = decodeCanonicalBase64(match[0]);
      if (decoded && containsRecognizedSecretPayload(decoded)) return true;
    }
    MIME_BASE64_BLOCK_PATTERN.lastIndex = 0;
    for (let match = MIME_BASE64_BLOCK_PATTERN.exec(text);
      match;
      match = MIME_BASE64_BLOCK_PATTERN.exec(text)) {
      const decoded = decodeCanonicalBase64(match[0].replace(/\s/g, ''));
      if (decoded && containsRecognizedSecretPayload(decoded)) return true;
    }
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
    if (securityPatternMatches(SECRET_PATH_PATTERN, file.path)
      || containsRecognizedSecretText(file.path)) {
      throw new Error('E2B staged export contains a secret-shaped path');
    }
    const content = Buffer.from(file.data_base64, 'base64');
    if (content.byteLength !== file.bytes
      || !safeEqual(sha256Ref(content.toString('base64')), file.content_hash)) {
      throw new Error('E2B staged export exact-byte binding mismatch');
    }
    if (containsRecognizedSecretBytes(content)) {
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
