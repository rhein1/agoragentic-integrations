#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  canonicalize,
  inspectRuntimeWorkspace,
  requireSha256Ref,
  sha256FileRef,
  sha256Ref,
  validateBootEvidenceEnvelope,
} from '../lib/runtime-contract.mjs';

const IDENTITY_PATH = '/tmp/agoragentic-risk-fork-v1.identity.json';
const BOOT_EVIDENCE_PATH = '/run/agoragentic-risk-fork/boot-evidence.json';
const WORKSPACE_ROOT = '/workspace/agoragentic-risk-fork-v1';
const BOOTSTRAP_ARTIFACT_PATH = '/opt/agoragentic/risk-fork/e2b-template/bin/bootstrap.mjs';
const RUNNER_ARTIFACT_PATH = '/opt/agoragentic/risk-fork/e2b-template/bin/run.mjs';
const MAX_REQUEST_BYTES = 128 * 1024;
const REQUEST_KEYS = Object.freeze([
  'schema',
  'fork_identity',
  'capsule_hash',
  'network_policy_hash',
  'clean_template_id_hash',
  'clean_template_evidence_hash',
  'metadata_hash',
  'expected_child_sandbox_id_hash',
  'trusted_bootstrap_artifact_hash',
  'trusted_runner_artifact_hash',
  'inherited_authority_accepted',
  'rekey_required',
  'phase',
  'expected_workspace_digest',
  'bootstrap_nonce',
  'request_hash',
]);
const IDENTITY_KEYS = Object.freeze([
  'schema',
  'parent_agent_id',
  'parent_session_id',
  'fork_agent_id',
  'session_id',
  'runtime_identity',
  'nonce_namespace',
  'entropy_state_ref',
  'issued_at',
  'identity_hash',
]);

function assertPlainObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${field} must be a plain object`);
  }
}

function assertAllowedKeys(value, allowed, field) {
  assertPlainObject(value, field);
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new TypeError(`${field} contains unsupported fields: ${unexpected.sort().join(', ')}`);
  }
}

function requireOpaque(value, field) {
  if (typeof value !== 'string'
    || value.length < 1
    || value.length > 1024
    || /\s|[\u0000-\u001f\u007f]/.test(value)
    || /^[/\\]|^[A-Za-z]:[\\/]/.test(value)) {
    throw new TypeError(`${field} must be an opaque reference`);
  }
  return value;
}

function validateIdentity(value) {
  assertAllowedKeys(value, IDENTITY_KEYS, 'fork identity');
  if (value.schema !== 'agoragentic.risk-fork.identity.v1') {
    throw new TypeError('fork identity schema is invalid');
  }
  for (const field of [
    'parent_agent_id',
    'parent_session_id',
    'fork_agent_id',
    'session_id',
    'runtime_identity',
    'nonce_namespace',
  ]) requireOpaque(value[field], `fork identity.${field}`);
  requireSha256Ref(value.entropy_state_ref, 'fork identity.entropy_state_ref');
  requireSha256Ref(value.identity_hash, 'fork identity.identity_hash');
  if (!Number.isFinite(Date.parse(value.issued_at))
    || new Date(Date.parse(value.issued_at)).toISOString() !== value.issued_at) {
    throw new TypeError('fork identity.issued_at is invalid');
  }
  if (value.parent_agent_id === value.fork_agent_id
    || value.parent_session_id === value.session_id) {
    throw new Error('fork identity inherited the parent identity');
  }
  if (sha256Ref({ ...value, identity_hash: null }) !== value.identity_hash) {
    throw new Error('fork identity hash mismatch');
  }
  return value;
}

function validateRequest(value) {
  assertAllowedKeys(value, REQUEST_KEYS, 'bootstrap request');
  if (value.schema !== 'agoragentic.risk-fork.clean-bootstrap-request.v1') {
    throw new TypeError('bootstrap request schema is invalid');
  }
  const identity = validateIdentity(value.fork_identity);
  for (const field of [
    'capsule_hash',
    'network_policy_hash',
    'clean_template_id_hash',
    'clean_template_evidence_hash',
    'metadata_hash',
    'expected_child_sandbox_id_hash',
    'trusted_bootstrap_artifact_hash',
    'trusted_runner_artifact_hash',
    'expected_workspace_digest',
    'request_hash',
  ]) requireSha256Ref(value[field], `bootstrap request.${field}`);
  if (value.inherited_authority_accepted !== false || value.rekey_required !== true) {
    throw new Error('bootstrap request would inherit authority or skip rekeying');
  }
  if (!['pre_upload', 'post_import'].includes(value.phase)) {
    throw new TypeError('bootstrap request phase is invalid');
  }
  const nonce = requireOpaque(value.bootstrap_nonce, 'bootstrap request.bootstrap_nonce');
  if (nonce.length < 16) throw new TypeError('bootstrap request nonce is too short');
  const expectedHash = sha256Ref({ ...value, request_hash: null });
  if (expectedHash !== value.request_hash) throw new Error('bootstrap request hash mismatch');
  if (canonicalize(value) !== canonicalize({ ...value, fork_identity: identity })) {
    throw new Error('bootstrap request is not canonical');
  }
  return value;
}

async function readJsonBounded(target, maxBytes, field) {
  const bytes = await readFile(target);
  if (bytes.byteLength > maxBytes) throw new Error(`${field} exceeds its byte bound`);
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`${field} is invalid JSON`);
  }
}

export async function runBootstrap(options = {}) {
  const clock = options.clock ?? (() => new Date());
  const now = new Date(clock());
  if (!Number.isFinite(now.getTime())) throw new TypeError('bootstrap clock is invalid');
  const request = validateRequest(options.request ?? await readJsonBounded(
    options.identityPath ?? IDENTITY_PATH,
    MAX_REQUEST_BYTES,
    'bootstrap request',
  ));
  const bootstrapArtifactPath = options.bootstrapArtifactPath ?? BOOTSTRAP_ARTIFACT_PATH;
  const runnerArtifactPath = options.runnerArtifactPath ?? RUNNER_ARTIFACT_PATH;
  const [bootstrapArtifactHash, runnerArtifactHash] = await Promise.all([
    sha256FileRef(bootstrapArtifactPath),
    sha256FileRef(runnerArtifactPath),
  ]);
  if (bootstrapArtifactHash !== request.trusted_bootstrap_artifact_hash) {
    throw new Error('bootstrap runtime artifact hash mismatch');
  }
  if (runnerArtifactHash !== request.trusted_runner_artifact_hash) {
    throw new Error('runner runtime artifact hash mismatch');
  }
  const bootEvidence = validateBootEvidenceEnvelope(
    await readJsonBounded(
      options.bootEvidencePath ?? BOOT_EVIDENCE_PATH,
      MAX_REQUEST_BYTES,
      'boot evidence',
    ),
    {
      now,
      bootstrapArtifactHash,
      runnerArtifactHash,
      evidenceHash: options.expectedBootEvidenceHash,
    },
  );
  if (bootEvidence.boot_nonce === request.bootstrap_nonce) {
    throw new Error('bootstrap nonce must be fresh from the boot evidence nonce');
  }
  const workspace = await inspectRuntimeWorkspace(options.workspaceRoot ?? WORKSPACE_ROOT, {
    allowMissing: request.phase === 'pre_upload',
  });
  if (workspace.workspace_digest !== request.expected_workspace_digest) {
    throw new Error('bootstrap workspace digest mismatch');
  }
  const claims = {
    inherited_parent_processes_absent:
      bootEvidence.claims.inherited_parent_processes_absent,
    unauthorized_environment_absent:
      bootEvidence.claims.unauthorized_environment_absent,
    credential_files_absent: bootEvidence.claims.credential_files_absent,
    wallet_signing_material_absent: bootEvidence.claims.wallet_signing_material_absent,
    inherited_authority_records_absent:
      bootEvidence.claims.inherited_authority_records_absent,
    persistent_mounts_absent: bootEvidence.claims.persistent_mounts_absent,
    unauthorized_sockets_absent: bootEvidence.claims.unauthorized_sockets_absent,
    network_policy_enforced:
      bootEvidence.claims.first_instruction_ipv4_egress_denied
      && bootEvidence.claims.first_instruction_ipv6_egress_denied,
    fresh_fork_identity_verified: true,
    fresh_session_nonce_verified: true,
    fresh_entropy_verified: bootEvidence.claims.fresh_entropy_verified,
    workspace_manifest_verified: true,
    trusted_runtime_artifacts_verified:
      bootEvidence.claims.trusted_runtime_artifacts_verified,
  };
  if (!Object.values(claims).every((claim) => claim === true)) {
    throw new Error('bootstrap inherited-state or containment claims are not verified');
  }
  const expiresAt = new Date(Math.min(
    now.getTime() + 60_000,
    Date.parse(bootEvidence.expires_at),
  ));
  if (expiresAt.getTime() <= now.getTime()) throw new Error('bootstrap attestation would be stale');
  return Object.freeze({
    schema: 'agoragentic.risk-fork.child-bootstrap-attestation.v1',
    phase: request.phase,
    status: 'verified',
    bootstrap_request_hash: request.request_hash,
    child_sandbox_id_hash: request.expected_child_sandbox_id_hash,
    template_id_hash: request.clean_template_id_hash,
    template_evidence_hash: request.clean_template_evidence_hash,
    capsule_hash: request.capsule_hash,
    identity_hash: request.fork_identity.identity_hash,
    network_policy_hash: request.network_policy_hash,
    metadata_hash: request.metadata_hash,
    workspace_digest: workspace.workspace_digest,
    trusted_bootstrap_artifact_hash: bootstrapArtifactHash,
    trusted_runner_artifact_hash: runnerArtifactHash,
    boot_evidence_hash: bootEvidence.evidence_hash,
    attested_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    claims,
  });
}

function parseCli() {
  if (process.argv.length !== 4 || process.argv[2] !== '--identity') {
    throw new TypeError('bootstrap requires exactly --identity <path>');
  }
  if (process.argv[3] !== IDENTITY_PATH) {
    throw new TypeError('bootstrap identity path is not the fixed controller path');
  }
  return process.argv[3];
}

async function main() {
  const result = await runBootstrap({ identityPath: parseCli() });
  process.stdout.write(`${canonicalize(result)}\n`);
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch(() => {
    process.stderr.write('{"status":"failed","code":"E2B_BOOTSTRAP_REJECTED"}\n');
    process.exitCode = 1;
  });
}
