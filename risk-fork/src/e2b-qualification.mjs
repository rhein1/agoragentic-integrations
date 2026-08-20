import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from 'node:crypto';
import {
  lstat,
  open,
  readFile,
  readdir,
  realpath,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { canonicalize, sha256Ref } from './canonical.mjs';
import {
  assertAllowedKeys,
  assertPlainObject,
  boundedInteger,
  deepFreeze,
  requireEnum,
  requireIsoDate,
  requireOpaqueRef,
  requireSha256Ref,
  requireString,
  safeEqual,
} from './util.mjs';

export const E2B_QUALIFICATION_SCHEMA =
  'agoragentic.risk-fork.e2b-qualification-evidence.v1';
export const E2B_QUALIFICATION_TRUST_SCHEMA =
  'agoragentic.risk-fork.e2b-qualification-trust.v1';
export const E2B_RUNTIME_SDK_INTEGRITY_SCHEMA =
  'agoragentic.risk-fork.e2b-runtime-sdk-dependency-closure.v2';

const QUALIFICATION_TRUST_VERIFIERS = new WeakSet();
const RUNTIME_SDK_INTEGRITY_VERIFIERS = new WeakSet();
const MAX_RUNTIME_SDK_PACKAGES = 128;
const MAX_RUNTIME_SDK_FILES_PER_PACKAGE = 2_048;
const MAX_RUNTIME_SDK_FILES = 8_192;
const MAX_RUNTIME_SDK_BYTES_PER_PACKAGE = 64 * 1024 * 1024;
const MAX_RUNTIME_SDK_BYTES = 256 * 1024 * 1024;
const MAX_RUNTIME_DEPENDENCIES_PER_PACKAGE = 256;

export const E2B_QUALIFICATION_CONTROLS = Object.freeze([
  'first_instruction_ipv4_egress_denied',
  'first_instruction_ipv6_egress_denied',
  'inherited_environment_absent',
  'inherited_processes_absent',
  'credential_files_absent',
  'wallet_material_absent',
  'persistent_mounts_absent',
  'unauthorized_sockets_absent',
  'fresh_entropy_verified',
  'template_provenance_verified',
  'bootstrap_binding_verified',
  'runner_binding_verified',
  'hard_ttl_verified',
  'idle_ttl_verified',
  'max_execution_time_verified',
  'destruction_semantics_verified',
  'orphan_reconciliation_verified',
  'latency_observed',
  'cost_within_cap',
]);

const CONTROL_STATUSES = Object.freeze(['verified', 'failed', 'unknown']);
const TOP_LEVEL_KEYS = Object.freeze([
  'schema',
  'status',
  'provider',
  'sdk',
  'template',
  'runtime',
  'run',
  'limits',
  'observations',
  'controls',
  'cleanup',
  'evidence_refs',
  'authority_flags',
  'evidence_hash',
]);
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/;

function canonicalDecimal(value, field) {
  if (typeof value !== 'string' || !DECIMAL_PATTERN.test(value)) {
    throw new TypeError(`${field} must be a canonical non-negative decimal with at most 6 places`);
  }
  const [whole, fraction = ''] = value.split('.');
  return `${whole}.${fraction.padEnd(6, '0')}`;
}

function decimalMicros(value, field) {
  return BigInt(canonicalDecimal(value, field).replace('.', ''));
}

function normalizedStatusMap(value, keys, field) {
  assertPlainObject(value, field);
  assertAllowedKeys(value, keys, field);
  const normalized = {};
  for (const key of keys) {
    normalized[key] = requireEnum(value[key], CONTROL_STATUSES, `${field}.${key}`);
  }
  return normalized;
}

function deriveStatus(controls, cleanup) {
  const values = [...Object.values(controls), ...Object.values(cleanup)];
  if (values.includes('failed')) return 'failed';
  if (values.every((status) => status === 'verified')) return 'verified';
  return 'unknown';
}

function normalizeEvidence(value, { includeComputedFields }) {
  assertPlainObject(value, 'E2B qualification evidence');
  assertAllowedKeys(
    value,
    includeComputedFields ? TOP_LEVEL_KEYS : TOP_LEVEL_KEYS.filter(
      (key) => !['schema', 'status', 'authority_flags', 'evidence_hash'].includes(key),
    ),
    'E2B qualification evidence',
  );

  const provider = value.provider;
  assertPlainObject(provider, 'E2B qualification evidence.provider');
  assertAllowedKeys(
    provider,
    ['name', 'project_ref_hash', 'region'],
    'E2B qualification evidence.provider',
  );
  if (provider.name !== 'e2b') throw new TypeError('E2B qualification provider must be e2b');
  const normalizedProvider = {
    name: 'e2b',
    project_ref_hash: requireSha256Ref(
      provider.project_ref_hash,
      'E2B qualification provider.project_ref_hash',
    ),
    region: requireOpaqueRef(provider.region, 'E2B qualification provider.region', {
      maxLength: 100,
    }),
  };

  const sdk = value.sdk;
  assertPlainObject(sdk, 'E2B qualification evidence.sdk');
  assertAllowedKeys(sdk, ['package', 'version', 'integrity_hash'], 'E2B qualification evidence.sdk');
  if (sdk.package !== 'e2b' || sdk.version !== '2.39.0') {
    throw new TypeError('E2B qualification requires the exact e2b@2.39.0 SDK');
  }
  const normalizedSdk = {
    package: 'e2b',
    version: '2.39.0',
    integrity_hash: requireSha256Ref(
      sdk.integrity_hash,
      'E2B qualification sdk.integrity_hash',
    ),
  };

  const template = value.template;
  assertPlainObject(template, 'E2B qualification evidence.template');
  assertAllowedKeys(template, [
    'template_id_hash',
    'build_id_hash',
    'template_evidence_hash',
    'provenance_hash',
  ], 'E2B qualification evidence.template');
  const normalizedTemplate = Object.fromEntries(Object.entries({
    template_id_hash: template.template_id_hash,
    build_id_hash: template.build_id_hash,
    template_evidence_hash: template.template_evidence_hash,
    provenance_hash: template.provenance_hash,
  }).map(([key, entry]) => [
    key,
    requireSha256Ref(entry, `E2B qualification template.${key}`),
  ]));

  const runtime = value.runtime;
  assertPlainObject(runtime, 'E2B qualification evidence.runtime');
  assertAllowedKeys(runtime, [
    'bootstrap_artifact_hash',
    'runner_artifact_hash',
    'boot_guard_artifact_hash',
  ], 'E2B qualification evidence.runtime');
  const normalizedRuntime = Object.fromEntries(Object.entries({
    bootstrap_artifact_hash: runtime.bootstrap_artifact_hash,
    runner_artifact_hash: runtime.runner_artifact_hash,
    boot_guard_artifact_hash: runtime.boot_guard_artifact_hash,
  }).map(([key, entry]) => [
    key,
    requireSha256Ref(entry, `E2B qualification runtime.${key}`),
  ]));

  const run = value.run;
  assertPlainObject(run, 'E2B qualification evidence.run');
  assertAllowedKeys(run, [
    'approval_ref_hash',
    'run_ref_hash',
    'started_at',
    'completed_at',
    'sandbox_count',
    'synthetic_workspace',
  ], 'E2B qualification evidence.run');
  const startedAt = requireIsoDate(run.started_at, 'E2B qualification run.started_at');
  const completedAt = requireIsoDate(run.completed_at, 'E2B qualification run.completed_at');
  if (Date.parse(completedAt) < Date.parse(startedAt)) {
    throw new TypeError('E2B qualification run completion precedes its start');
  }
  if (typeof run.synthetic_workspace !== 'boolean') {
    throw new TypeError('E2B qualification run.synthetic_workspace must be boolean');
  }
  const normalizedRun = {
    approval_ref_hash: requireSha256Ref(
      run.approval_ref_hash,
      'E2B qualification run.approval_ref_hash',
    ),
    run_ref_hash: requireSha256Ref(run.run_ref_hash, 'E2B qualification run.run_ref_hash'),
    started_at: startedAt,
    completed_at: completedAt,
    sandbox_count: boundedInteger(run.sandbox_count, 'E2B qualification run.sandbox_count', {
      min: 0,
      max: 1,
    }),
    synthetic_workspace: run.synthetic_workspace,
  };

  const limits = value.limits;
  assertPlainObject(limits, 'E2B qualification evidence.limits');
  assertAllowedKeys(limits, [
    'hard_ttl_ms',
    'idle_ttl_ms',
    'max_execution_ms',
    'max_cost_usd',
  ], 'E2B qualification evidence.limits');
  const normalizedLimits = {
    hard_ttl_ms: boundedInteger(limits.hard_ttl_ms, 'E2B qualification limits.hard_ttl_ms', {
      min: 1_000,
      max: 24 * 60 * 60 * 1_000,
    }),
    idle_ttl_ms: boundedInteger(limits.idle_ttl_ms, 'E2B qualification limits.idle_ttl_ms', {
      min: 1_000,
      max: 24 * 60 * 60 * 1_000,
    }),
    max_execution_ms: boundedInteger(
      limits.max_execution_ms,
      'E2B qualification limits.max_execution_ms',
      { min: 100, max: 10 * 60 * 1_000 },
    ),
    max_cost_usd: limits.max_cost_usd,
  };
  decimalMicros(normalizedLimits.max_cost_usd, 'E2B qualification limits.max_cost_usd');
  if (normalizedLimits.idle_ttl_ms > normalizedLimits.hard_ttl_ms
    || normalizedLimits.max_execution_ms > normalizedLimits.hard_ttl_ms) {
    throw new TypeError('E2B qualification lifecycle limits exceed the hard TTL');
  }

  const observations = value.observations;
  assertPlainObject(observations, 'E2B qualification evidence.observations');
  assertAllowedKeys(observations, [
    'fork_start_ms',
    'execution_ms',
    'cleanup_ms',
    'observed_cost_usd',
  ], 'E2B qualification evidence.observations');
  const normalizedObservations = {
    fork_start_ms: boundedInteger(
      observations.fork_start_ms,
      'E2B qualification observations.fork_start_ms',
      { min: 0, max: 24 * 60 * 60 * 1_000 },
    ),
    execution_ms: boundedInteger(
      observations.execution_ms,
      'E2B qualification observations.execution_ms',
      { min: 0, max: 24 * 60 * 60 * 1_000 },
    ),
    cleanup_ms: boundedInteger(
      observations.cleanup_ms,
      'E2B qualification observations.cleanup_ms',
      { min: 0, max: 24 * 60 * 60 * 1_000 },
    ),
    observed_cost_usd: observations.observed_cost_usd,
  };
  const observedCost = normalizedObservations.observed_cost_usd === null
    ? null
    : decimalMicros(
        normalizedObservations.observed_cost_usd,
        'E2B qualification observations.observed_cost_usd',
      );
  const maxCost = decimalMicros(
    normalizedLimits.max_cost_usd,
    'E2B qualification limits.max_cost_usd',
  );

  const controls = normalizedStatusMap(
    value.controls,
    E2B_QUALIFICATION_CONTROLS,
    'E2B qualification evidence.controls',
  );
  const cleanup = normalizedStatusMap(
    value.cleanup,
    ['kill_requested', 'absence_verified', 'orphan_reconciliation'],
    'E2B qualification evidence.cleanup',
  );
  if (observedCost === null && controls.cost_within_cap === 'verified') {
    throw new Error('Verified E2B qualification requires observed cost evidence');
  }
  if (observedCost !== null && observedCost > maxCost
    && controls.cost_within_cap === 'verified') {
    throw new Error('E2B qualification observed cost exceeds its explicit cost cap');
  }

  if (!Array.isArray(value.evidence_refs)
    || value.evidence_refs.length < 1
    || value.evidence_refs.length > 64) {
    throw new TypeError('E2B qualification evidence_refs must contain 1 to 64 records');
  }
  const evidenceRefs = value.evidence_refs.map((entry, index) => {
    const field = `E2B qualification evidence_refs[${index}]`;
    assertPlainObject(entry, field);
    assertAllowedKeys(entry, ['ref', 'hash'], field);
    return {
      ref: requireOpaqueRef(entry.ref, `${field}.ref`, { maxLength: 500 }),
      hash: requireSha256Ref(entry.hash, `${field}.hash`),
    };
  });
  const refs = evidenceRefs.map((entry) => entry.ref);
  if (new Set(refs).size !== refs.length) {
    throw new TypeError('E2B qualification evidence refs must be unique');
  }

  const status = deriveStatus(controls, cleanup);
  if (status === 'verified'
    && (normalizedRun.sandbox_count !== 1 || normalizedRun.synthetic_workspace !== true)) {
    throw new Error('Verified E2B qualification requires exactly one synthetic sandbox');
  }
  const authorityFlags = {
    credentials_included: false,
    wallet_material_included: false,
    execution_authority_included: false,
    production_activation_granted: false,
  };
  if (includeComputedFields) {
    if (value.schema !== E2B_QUALIFICATION_SCHEMA) {
      throw new TypeError('E2B qualification evidence schema is invalid');
    }
    if (value.status !== status) {
      throw new Error('E2B qualification evidence status contradicts its control results');
    }
    assertPlainObject(value.authority_flags, 'E2B qualification evidence.authority_flags');
    assertAllowedKeys(
      value.authority_flags,
      Object.keys(authorityFlags),
      'E2B qualification evidence.authority_flags',
    );
    for (const key of Object.keys(authorityFlags)) {
      if (value.authority_flags[key] !== false) {
        throw new Error(`E2B qualification evidence cannot grant ${key}`);
      }
    }
  }

  return {
    schema: E2B_QUALIFICATION_SCHEMA,
    status,
    provider: normalizedProvider,
    sdk: normalizedSdk,
    template: normalizedTemplate,
    runtime: normalizedRuntime,
    run: normalizedRun,
    limits: normalizedLimits,
    observations: normalizedObservations,
    controls,
    cleanup,
    evidence_refs: evidenceRefs,
    authority_flags: authorityFlags,
    evidence_hash: includeComputedFields
      ? requireSha256Ref(value.evidence_hash, 'E2B qualification evidence.evidence_hash')
      : null,
  };
}

function assertExpectedBindings(evidence, expected) {
  const bindings = [
    ['template_id_hash', expected.templateId == null ? null : sha256Ref(expected.templateId)],
    ['template_evidence_hash', expected.templateHash],
    ['bootstrap_artifact_hash', expected.bootstrapArtifactHash],
    ['runner_artifact_hash', expected.runnerArtifactHash],
  ];
  for (const [field, wanted] of bindings) {
    if (wanted == null) continue;
    const actual = Object.hasOwn(evidence.template, field)
      ? evidence.template[field]
      : evidence.runtime[field];
    requireSha256Ref(wanted, `expected E2B ${field}`);
    if (!safeEqual(actual, wanted)) {
      throw new Error(`E2B qualification binding mismatch: ${field}`);
    }
  }
}

function qualificationTrustPayload(evidence, verifierKeyHash) {
  return deepFreeze({
    schema: E2B_QUALIFICATION_TRUST_SCHEMA,
    evidence_hash: evidence.evidence_hash,
    verifier_key_hash: requireSha256Ref(
      verifierKeyHash,
      'E2B qualification verifier key hash',
    ),
  });
}

function requireEd25519Signature(value) {
  if (typeof value !== 'string'
    || value.length < 80
    || value.length > 100
    || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new TypeError('E2B qualification trust signature must be canonical base64url');
  }
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== 64 || bytes.toString('base64url') !== value) {
    throw new TypeError('E2B qualification trust signature must be a canonical Ed25519 signature');
  }
  return bytes;
}

function normalizeRuntimeSdkBinding(value, field = 'E2B runtime SDK binding') {
  assertPlainObject(value, field);
  assertAllowedKeys(value, ['package', 'version', 'integrity_hash'], field);
  if (value.package !== 'e2b' || value.version !== '2.39.0') {
    throw new TypeError(`${field} requires exact e2b@2.39.0`);
  }
  return deepFreeze({
    package: 'e2b',
    version: '2.39.0',
    integrity_hash: requireSha256Ref(value.integrity_hash, `${field}.integrity_hash`),
  });
}

function sameFileIdentity(left, right) {
  return left.isFile()
    && right.isFile()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.nlink === right.nlink;
}

function isContainedPath(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function resolveE2BPackageDirectory() {
  const entry = fileURLToPath(import.meta.resolve('e2b'));
  let directory = path.dirname(entry);
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
      if (manifest.name === 'e2b') return directory;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error('Unable to resolve the installed e2b package directory');
}

async function readStableRegularFile(file, root) {
  const before = await lstat(file);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error('E2B runtime SDK package tree contains a symlink or special file');
  }
  if (before.nlink !== 1) {
    throw new Error('E2B runtime SDK package tree contains a hard-linked file');
  }
  const resolved = await realpath(file);
  if (!isContainedPath(root, resolved)) {
    throw new Error('E2B runtime SDK package file escapes its canonical package directory');
  }
  const handle = await open(file, 'r');
  try {
    const opened = await handle.stat();
    if (!sameFileIdentity(before, opened)) {
      throw new Error('E2B runtime SDK package file changed before inspection');
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameFileIdentity(opened, after) || bytes.byteLength !== after.size) {
      throw new Error('E2B runtime SDK package file changed during inspection');
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function canonicalPackageName(value, field) {
  const name = requireString(value, field, { maxLength: 214 });
  if (!/^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)
    || name.includes('..')) {
    throw new TypeError(`${field} is not a canonical package name`);
  }
  return name;
}

function canonicalPackageVersion(value, field) {
  const version = requireString(value, field, { maxLength: 200 });
  if (!/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/.test(version)) {
    throw new TypeError(`${field} is not a canonical package version`);
  }
  return version;
}

function canonicalDependencySpec(value, field) {
  const spec = requireString(value, field, { maxLength: 1_000 });
  if (/[\0\r\n]/.test(spec)) throw new TypeError(`${field} is invalid`);
  return spec;
}

function aliasPackageName(requestedName, spec, field) {
  if (!spec.startsWith('npm:')) return requestedName;
  const alias = spec.slice(4);
  const separator = alias.startsWith('@')
    ? alias.indexOf('@', alias.indexOf('/') + 1)
    : alias.lastIndexOf('@');
  if (separator <= 0 || separator === alias.length - 1) {
    throw new TypeError(`${field} npm alias is invalid`);
  }
  return canonicalPackageName(alias.slice(0, separator), `${field} npm alias package`);
}

function runtimeDependencyDeclarations(manifest, field) {
  const declarations = new Map();
  const add = (nameValue, specValue, kind) => {
    const name = canonicalPackageName(nameValue, `${field}.${kind} name`);
    const spec = canonicalDependencySpec(specValue, `${field}.${kind}.${name}`);
    const current = declarations.get(name) ?? [];
    current.push({ kind, spec });
    declarations.set(name, current);
  };
  const addMap = (value, kind) => {
    if (value === undefined) return;
    assertPlainObject(value, `${field}.${kind}`);
    const entries = Object.entries(value);
    if (entries.length > MAX_RUNTIME_DEPENDENCIES_PER_PACKAGE) {
      throw new Error(
        `${field}.${kind} exceeds ${MAX_RUNTIME_DEPENDENCIES_PER_PACKAGE} entries`,
      );
    }
    for (const [name, spec] of entries) add(name, spec, kind);
  };
  addMap(manifest.dependencies, 'dependency');
  addMap(manifest.optionalDependencies, 'optional_dependency');

  if (manifest.peerDependencies !== undefined) {
    assertPlainObject(manifest.peerDependencies, `${field}.peerDependencies`);
    if (Object.keys(manifest.peerDependencies).length > MAX_RUNTIME_DEPENDENCIES_PER_PACKAGE) {
      throw new Error(
        `${field}.peerDependencies exceeds ${MAX_RUNTIME_DEPENDENCIES_PER_PACKAGE} entries`,
      );
    }
    if (manifest.peerDependenciesMeta !== undefined) {
      assertPlainObject(manifest.peerDependenciesMeta, `${field}.peerDependenciesMeta`);
    }
    for (const [name, spec] of Object.entries(manifest.peerDependencies)) {
      const meta = manifest.peerDependenciesMeta?.[name];
      if (meta !== undefined) assertPlainObject(meta, `${field}.peerDependenciesMeta.${name}`);
      add(
        name,
        spec,
        meta?.optional === true ? 'optional_peer_dependency' : 'required_peer_dependency',
      );
    }
  }

  if (declarations.size > MAX_RUNTIME_DEPENDENCIES_PER_PACKAGE) {
    throw new Error(`${field} runtime dependency closure is too broad`);
  }
  return [...declarations.entries()].sort(([left], [right]) => (
    left === right ? 0 : left < right ? -1 : 1
  )).map(([requestedName, entries]) => {
    entries.sort((left, right) => (
      left.kind === right.kind
        ? (left.spec === right.spec ? 0 : left.spec < right.spec ? -1 : 1)
        : left.kind < right.kind ? -1 : 1
    ));
    const actualNames = new Set(entries.map((entry) => (
      aliasPackageName(requestedName, entry.spec, `${field}.${requestedName}`)
    )));
    if (actualNames.size !== 1) {
      throw new Error(`${field}.${requestedName} has contradictory package aliases`);
    }
    const hasOptionalDependency = entries.some(
      (entry) => entry.kind === 'optional_dependency',
    );
    const required = entries.some((entry) => entry.kind === 'required_peer_dependency')
      || entries.some((entry) => entry.kind === 'dependency') && !hasOptionalDependency;
    return {
      requested_name: requestedName,
      expected_package_name: [...actualNames][0],
      required,
      declarations: entries,
    };
  });
}

async function canonicalRealDirectory(directory, field) {
  const requested = path.resolve(directory);
  const info = await lstat(requested);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`${field} must be a real directory`);
  }
  const resolved = await realpath(requested);
  if (path.relative(requested, resolved) !== '') {
    throw new Error(`${field} must be canonical and must not traverse a link`);
  }
  return resolved;
}

function canonicalClosureLocation(anchor, target, field) {
  if (!isContainedPath(anchor, target)) throw new Error(`${field} escapes the closure anchor`);
  const relative = path.relative(anchor, target).split(path.sep).join('/');
  if (relative === '' || relative.startsWith('../') || path.posix.isAbsolute(relative)) {
    throw new Error(`${field} is not a canonical relative package location`);
  }
  return relative;
}

function dependencyPathSegments(name) {
  return name.startsWith('@') ? name.split('/') : [name];
}

async function locateDependencyPackage(fromRoot, requestedName, anchor) {
  const segments = dependencyPathSegments(requestedName);
  let cursor = fromRoot;
  while (isContainedPath(anchor, cursor)) {
    const modulesDirectory = path.basename(cursor) === 'node_modules'
      ? cursor
      : path.join(cursor, 'node_modules');
    const candidate = path.join(modulesDirectory, ...segments);
    if (isContainedPath(anchor, candidate)) {
      try {
        return await canonicalRealDirectory(
          candidate,
          `E2B runtime dependency ${requestedName}`,
        );
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    if (cursor === anchor) break;
    const parent = path.dirname(cursor);
    if (parent === cursor || !isContainedPath(anchor, parent)) break;
    cursor = parent;
  }
  return null;
}

async function inspectRuntimePackageTree(root, anchor, state) {
  const location = canonicalClosureLocation(anchor, root, 'E2B runtime package');
  const files = [];
  const filePaths = new Set();
  let manifestBytes = null;
  let packageBytes = 0;

  async function walk(directory) {
    const canonicalDirectory = await canonicalRealDirectory(
      directory,
      'E2B runtime SDK package directory',
    );
    if (!isContainedPath(root, canonicalDirectory)) {
      throw new Error('E2B runtime SDK package directory escapes its package root');
    }
    const entries = await readdir(canonicalDirectory, { withFileTypes: true });
    entries.sort((left, right) => (
      left.name === right.name ? 0 : left.name < right.name ? -1 : 1
    ));
    for (const entry of entries) {
      const target = path.join(canonicalDirectory, entry.name);
      const info = await lstat(target);
      if (info.isSymbolicLink()) {
        throw new Error('E2B runtime SDK dependency closure contains a symlink');
      }
      if (info.isDirectory()) {
        await walk(target);
        continue;
      }
      if (!info.isFile()) {
        throw new Error('E2B runtime SDK dependency closure contains a special file');
      }
      if (files.length >= MAX_RUNTIME_SDK_FILES_PER_PACKAGE) {
        throw new Error(
          `E2B runtime package exceeds ${MAX_RUNTIME_SDK_FILES_PER_PACKAGE} files`,
        );
      }
      if (state.fileCount >= MAX_RUNTIME_SDK_FILES) {
        throw new Error(`E2B runtime dependency closure exceeds ${MAX_RUNTIME_SDK_FILES} files`);
      }
      const bytes = await readStableRegularFile(target, root);
      packageBytes += bytes.byteLength;
      state.totalBytes += bytes.byteLength;
      state.fileCount += 1;
      if (packageBytes > MAX_RUNTIME_SDK_BYTES_PER_PACKAGE) {
        throw new Error(
          `E2B runtime package exceeds ${MAX_RUNTIME_SDK_BYTES_PER_PACKAGE} bytes`,
        );
      }
      if (state.totalBytes > MAX_RUNTIME_SDK_BYTES) {
        throw new Error(
          `E2B runtime dependency closure exceeds ${MAX_RUNTIME_SDK_BYTES} bytes`,
        );
      }
      const relative = path.relative(root, target).split(path.sep).join('/');
      files.push({
        path: relative,
        size: bytes.byteLength,
        hash: sha256BytesRef(bytes),
      });
      filePaths.add(relative);
      if (relative === 'package.json') manifestBytes = bytes;
    }
  }
  await walk(root);
  if (!manifestBytes) throw new Error(`E2B runtime package ${location} is missing package.json`);
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw new Error(`E2B runtime package ${location} has invalid package.json`);
  }
  assertPlainObject(manifest, `E2B runtime package ${location} manifest`);
  const name = canonicalPackageName(manifest.name, `E2B runtime package ${location} name`);
  const version = canonicalPackageVersion(
    manifest.version,
    `E2B runtime package ${location} version`,
  );
  const recordCore = { location, name, version, files };
  return {
    root,
    manifest,
    filePaths,
    record: {
      ...recordCore,
      package_hash: sha256Ref(recordCore),
    },
  };
}

async function inspectRuntimeSdkPackage(packageDirectory) {
  const requestedRoot = path.resolve(packageDirectory ?? await resolveE2BPackageDirectory());
  const root = await canonicalRealDirectory(requestedRoot, 'E2B runtime SDK package root');
  const anchor = await canonicalRealDirectory(
    path.dirname(root),
    'E2B runtime SDK dependency closure anchor',
  );
  const state = { fileCount: 0, totalBytes: 0 };
  const packagesByRoot = new Map();
  const edges = [];

  async function visit(packageRoot, expectedName) {
    const canonicalRoot = await canonicalRealDirectory(
      packageRoot,
      `E2B runtime package ${expectedName}`,
    );
    const existing = packagesByRoot.get(canonicalRoot);
    if (existing) {
      if (existing.record.name !== expectedName) {
        throw new Error(
          `E2B runtime dependency package identity mismatch: expected ${expectedName}`,
        );
      }
      return existing;
    }
    if (packagesByRoot.size >= MAX_RUNTIME_SDK_PACKAGES) {
      throw new Error(
        `E2B runtime dependency closure exceeds ${MAX_RUNTIME_SDK_PACKAGES} packages`,
      );
    }
    const inspected = await inspectRuntimePackageTree(canonicalRoot, anchor, state);
    if (inspected.record.name !== expectedName) {
      throw new Error(
        `E2B runtime dependency package identity mismatch at ${inspected.record.location}: expected ${expectedName}, observed ${inspected.record.name}`,
      );
    }
    packagesByRoot.set(canonicalRoot, inspected);

    const dependencies = runtimeDependencyDeclarations(
      inspected.manifest,
      `E2B runtime package ${inspected.record.name}@${inspected.record.version}`,
    );
    for (const dependency of dependencies) {
      const targetRoot = await locateDependencyPackage(
        canonicalRoot,
        dependency.requested_name,
        anchor,
      );
      if (!targetRoot) {
        if (dependency.required) {
          throw new Error(
            `E2B runtime dependency ${dependency.requested_name} is required but missing`,
          );
        }
        edges.push({
          from_location: inspected.record.location,
          requested_name: dependency.requested_name,
          expected_package_name: dependency.expected_package_name,
          declarations: dependency.declarations,
          resolution: 'absent_optional',
          target_location: null,
          target_package_hash: null,
          entry_path: null,
        });
        continue;
      }
      const target = await visit(targetRoot, dependency.expected_package_name);
      let resolvedEntry;
      try {
        resolvedEntry = createRequire(path.join(canonicalRoot, 'package.json')).resolve(
          dependency.requested_name,
        );
      } catch {
        throw new Error(
          `E2B runtime dependency ${dependency.requested_name} has no resolvable executable entry`,
        );
      }
      const canonicalEntry = await realpath(path.resolve(resolvedEntry));
      if (path.relative(path.resolve(resolvedEntry), canonicalEntry) !== ''
        || !isContainedPath(target.root, canonicalEntry)) {
        throw new Error(
          `E2B runtime dependency ${dependency.requested_name} executable entry escapes its package`,
        );
      }
      const entryPath = path.relative(target.root, canonicalEntry).split(path.sep).join('/');
      if (!target.filePaths.has(entryPath)) {
        throw new Error(
          `E2B runtime dependency ${dependency.requested_name} executable entry is not integrity-bound`,
        );
      }
      edges.push({
        from_location: inspected.record.location,
        requested_name: dependency.requested_name,
        expected_package_name: dependency.expected_package_name,
        declarations: dependency.declarations,
        resolution: 'present',
        target_location: target.record.location,
        target_package_hash: target.record.package_hash,
        entry_path: entryPath,
      });
    }
    return inspected;
  }

  const sdk = await visit(root, 'e2b');
  if (sdk.record.version !== '2.39.0') {
    throw new Error('E2B runtime SDK dependency closure requires exact e2b@2.39.0');
  }
  if (sdk.manifest.main !== 'dist/index.js' || !sdk.filePaths.has(sdk.manifest.main)) {
    throw new Error('E2B runtime SDK package entrypoint is not the reviewed dist/index.js');
  }
  const packages = [...packagesByRoot.values()]
    .map((entry) => entry.record)
    .sort((left, right) => (
      left.location === right.location ? 0 : left.location < right.location ? -1 : 1
    ));
  edges.sort((left, right) => {
    const leftKey = `${left.from_location}\0${left.requested_name}`;
    const rightKey = `${right.from_location}\0${right.requested_name}`;
    return leftKey === rightKey ? 0 : leftKey < rightKey ? -1 : 1;
  });
  const closure = {
    schema: E2B_RUNTIME_SDK_INTEGRITY_SCHEMA,
    root_location: sdk.record.location,
    root_package_hash: sdk.record.package_hash,
    packages,
    dependency_edges: edges,
  };
  const binding = deepFreeze({
    package: 'e2b',
    version: '2.39.0',
    integrity_hash: sha256Ref(closure),
  });
  return {
    binding,
    entry: path.join(root, sdk.manifest.main),
  };
}

function assertRuntimeSdkBindingMatches(observed, expected) {
  if (observed.package !== expected.package
    || observed.version !== expected.version
    || !safeEqual(observed.integrity_hash, expected.integrity_hash)) {
    throw new Error('E2B runtime SDK integrity binding mismatch');
  }
}

export function createE2BRuntimeSdkIntegrityVerifier(options = {}) {
  assertPlainObject(options, 'E2B runtime SDK integrity verifier options');
  assertAllowedKeys(options, ['packageDirectory'], 'E2B runtime SDK integrity verifier options');
  const packageDirectory = options.packageDirectory == null
    ? null
    : path.resolve(requireString(
        options.packageDirectory,
        'E2B runtime SDK packageDirectory',
        { maxLength: 4_000 },
      ));
  const verifier = {
    async inspect() {
      const inspected = await inspectRuntimeSdkPackage(packageDirectory);
      return inspected.binding;
    },
    async load(value) {
      const expected = normalizeRuntimeSdkBinding(value);
      const before = await inspectRuntimeSdkPackage(packageDirectory);
      assertRuntimeSdkBindingMatches(before.binding, expected);
      const module = await import(pathToFileURL(before.entry).href);
      const after = await inspectRuntimeSdkPackage(packageDirectory);
      assertRuntimeSdkBindingMatches(after.binding, expected);
      if (!safeEqual(before.binding.integrity_hash, after.binding.integrity_hash)) {
        throw new Error('E2B runtime SDK package changed while it was loaded');
      }
      return Object.freeze({ module, ...after.binding });
    },
  };
  RUNTIME_SDK_INTEGRITY_VERIFIERS.add(verifier);
  return Object.freeze(verifier);
}

export function isE2BRuntimeSdkIntegrityVerifier(value) {
  return Boolean(value && RUNTIME_SDK_INTEGRITY_VERIFIERS.has(value));
}

export async function loadVerifiedE2BRuntimeSdk(value, verifier) {
  if (!isE2BRuntimeSdkIntegrityVerifier(verifier)) {
    throw new TypeError(
      'E2B runtime SDK integrity requires a trusted verifier created by createE2BRuntimeSdkIntegrityVerifier',
    );
  }
  return verifier.load(normalizeRuntimeSdkBinding(value));
}

export function createE2BQualificationTrustVerifier(options = {}) {
  assertPlainObject(options, 'E2B qualification trust verifier options');
  assertAllowedKeys(
    options,
    ['publicKey', 'publicKeyHash'],
    'E2B qualification trust verifier options',
  );
  let publicKey;
  try {
    publicKey = options.publicKey?.type === 'public'
      ? options.publicKey
      : createPublicKey(options.publicKey);
  } catch {
    throw new TypeError('E2B qualification trust verifier publicKey is invalid');
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new TypeError('E2B qualification trust verifier requires an Ed25519 public key');
  }
  const keyHash = sha256BytesRef(publicKey.export({ type: 'spki', format: 'der' }));
  const expectedKeyHash = requireSha256Ref(
    options.publicKeyHash,
    'E2B qualification trust verifier publicKeyHash',
  );
  if (!safeEqual(keyHash, expectedKeyHash)) {
    throw new Error('E2B qualification trust verifier public key hash mismatch');
  }

  const verifier = {
    key_hash: keyHash,
    createPayload(value, expected = {}) {
      const evidence = validateE2BQualificationEvidence(value, expected);
      return qualificationTrustPayload(evidence, keyHash);
    },
    verify(value, trust, expected = {}) {
      const evidence = validateE2BQualificationEvidence(value, expected);
      assertPlainObject(trust, 'E2B qualification trust');
      assertAllowedKeys(
        trust,
        ['schema', 'evidence_hash', 'verifier_key_hash', 'signature'],
        'E2B qualification trust',
      );
      const payload = qualificationTrustPayload(evidence, keyHash);
      if (trust.schema !== payload.schema
        || !safeEqual(trust.evidence_hash, payload.evidence_hash)
        || !safeEqual(trust.verifier_key_hash, payload.verifier_key_hash)) {
        throw new Error('E2B qualification trust binding mismatch');
      }
      const signature = requireEd25519Signature(trust.signature);
      if (!verifySignature(
        null,
        Buffer.from(canonicalize(payload), 'utf8'),
        publicKey,
        signature,
      )) {
        throw new Error('E2B qualification trust signature is invalid');
      }
      return deepFreeze({ ...payload, signature: trust.signature });
    },
  };
  QUALIFICATION_TRUST_VERIFIERS.add(verifier);
  return Object.freeze(verifier);
}

export function verifyE2BQualificationTrust(value, trust, verifier, expected = {}) {
  if (!verifier || !QUALIFICATION_TRUST_VERIFIERS.has(verifier)) {
    throw new TypeError(
      'E2B qualification trust requires a trusted verifier created by createE2BQualificationTrustVerifier',
    );
  }
  return verifier.verify(value, trust, expected);
}

export function createE2BQualificationEvidence(input = {}) {
  const evidence = normalizeEvidence(input, { includeComputedFields: false });
  evidence.evidence_hash = sha256Ref({ ...evidence, evidence_hash: null });
  return deepFreeze(evidence);
}

export function validateE2BQualificationEvidence(value, expected = {}) {
  const normalized = normalizeEvidence(value, { includeComputedFields: true });
  const expectedHash = sha256Ref({ ...normalized, evidence_hash: null });
  if (!safeEqual(normalized.evidence_hash, expectedHash)) {
    throw new Error('E2B qualification evidence hash mismatch');
  }
  if (canonicalize(normalized) !== canonicalize(value)) {
    throw new Error('E2B qualification evidence is not canonical and closed');
  }
  assertExpectedBindings(normalized, expected);
  return deepFreeze(normalized);
}

export function isE2BQualificationEvidenceCanonical(value, expected = {}) {
  try {
    validateE2BQualificationEvidence(value, expected);
    return true;
  } catch {
    return false;
  }
}

export function sha256BytesRef(value) {
  const bytes = value instanceof Uint8Array ? value : Buffer.from(value);
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export async function sha256FileRef(file) {
  return sha256BytesRef(await readFile(file));
}
