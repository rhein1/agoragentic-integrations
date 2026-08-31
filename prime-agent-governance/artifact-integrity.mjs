import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  readlinkSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { types } from 'node:util';

export const PRIME_AGENT_EXTENSION_MANIFEST_FILES = Object.freeze([
  'artifact-integrity.mjs',
  'host-contract.mjs',
  'index.mjs',
  'runtime-contract.mjs',
  'release-verifier.mjs',
  'compatibility-runner.mjs',
  'evidence/build-dependency-audit.mjs',
  'evidence/build-evidence.mjs',
  'evidence/build-marketplace-record.mjs',
  'package.json',
  'README.md',
  'RUNTIME_INTEGRATION.md',
  'SKILL.md',
]);

export const PRIME_AGENT_QUALIFICATION_MANIFEST_FILES = Object.freeze([
  'package.json',
  'schema/evidence-packet.v1.schema.json',
  'src/index.mjs',
]);

export const PRIME_AGENT_INTEGRITY_PROFILE_SCHEMA = 'agoragentic.prime-agent.integrity-profile.v1';

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const INTEGRITY_PROFILE_KEYS = Object.freeze([
  'schema',
  'profile_version',
  'host_release_asset_sha256',
  'dependency_lock_digest',
  'extension_manifest_digest',
  'dependency_closures',
  'profile_hash',
]);
const DEPENDENCY_CLOSURE_KEYS = Object.freeze([
  'platform',
  'architecture',
  'materialization_method',
  'materialization_environment',
  'materialization_network_status',
  'node_version',
  'npm_version',
  'dependency_file_count',
  'dependency_tree_digest',
]);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

export function integritySha256(value) {
  const bytes = Buffer.isBuffer(value)
    ? value
    : Buffer.from(typeof value === 'string' ? value : JSON.stringify(canonicalize(value)));
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function sha256File(path) {
  return integritySha256(readFileSync(path));
}

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactOwnKeys(value, expectedKeys) {
  if (!isPlainRecord(value)) return false;
  const observedKeys = Reflect.ownKeys(value);
  return observedKeys.length === expectedKeys.length
    && expectedKeys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value');
    });
}

function isClosedDenseArray(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  const expectedKeys = [...value.keys()].map(String);
  return Reflect.ownKeys(value).every((key) => key === 'length' || expectedKeys.includes(key))
    && expectedKeys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value');
    });
}

function snapshotIntegrityJson(value, path = 'integrity profile', state = {
  nodes: 0,
  seen: new WeakSet(),
}, depth = 0) {
  state.nodes += 1;
  if (state.nodes > 4096) throw new TypeError(`${path} exceeds the JSON node limit`);
  if (depth > 32) throw new TypeError(`${path} exceeds the JSON depth limit`);
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must contain finite numbers`);
    return value;
  }
  if (typeof value !== 'object') throw new TypeError(`${path} must contain only JSON values`);
  if (types.isProxy(value)) throw new TypeError(`${path} must not be a Proxy`);
  if (state.seen.has(value)) throw new TypeError(`${path} must not contain a cycle`);
  state.seen.add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new TypeError(`${path} must use the standard Array prototype`);
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    const length = lengthDescriptor?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > 4096 - state.nodes) {
      throw new TypeError(`${path} exceeds the JSON node limit`);
    }
    const keys = Reflect.ownKeys(value);
    const expectedKeys = Array.from({ length }, (_, index) => String(index));
    if (keys.length !== expectedKeys.length + 1
      || !keys.includes('length')
      || expectedKeys.some((key) => !keys.includes(key))) {
      throw new TypeError(`${path} must be a closed dense array`);
    }
    return expectedKeys.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError(`${path} must not contain accessor or non-enumerable entries`);
      }
      return snapshotIntegrityJson(descriptor.value, `${path}[${key}]`, state, depth + 1);
    });
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must contain only plain objects`);
  }
  const clone = Object.create(null);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length > 4096 - state.nodes) {
    throw new TypeError(`${path} exceeds the JSON node limit`);
  }
  for (const key of ownKeys) {
    if (typeof key !== 'string') throw new TypeError(`${path} must not contain symbol keys`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`${path} must not contain accessor or non-enumerable properties`);
    }
    clone[key] = snapshotIntegrityJson(descriptor.value, `${path}.<field>`, state, depth + 1);
  }
  return clone;
}

export function verifyPrimeAgentIntegrityProfile(profile) {
  const errors = [];
  try {
    profile = snapshotIntegrityJson(profile);
  } catch (error) {
    return Object.freeze({ ok: false, errors: Object.freeze([error.message]), expected_hash: null });
  }
  if (!hasExactOwnKeys(profile, INTEGRITY_PROFILE_KEYS)) {
    return Object.freeze({ ok: false, errors: Object.freeze(['integrity profile must be a schema-closed plain object']) });
  }
  if (profile.schema !== PRIME_AGENT_INTEGRITY_PROFILE_SCHEMA) errors.push('integrity profile schema mismatch');
  if (profile.profile_version !== 1) errors.push('integrity profile version must be 1');
  for (const key of ['host_release_asset_sha256', 'dependency_lock_digest', 'extension_manifest_digest']) {
    if (!SHA256_PATTERN.test(profile[key] || '')) errors.push(`integrity profile ${key} is invalid`);
  }
  if (!isClosedDenseArray(profile.dependency_closures) || profile.dependency_closures.length < 1) {
    errors.push('integrity profile dependency_closures must be a non-empty closed dense array');
  } else {
    const tuples = new Set();
    for (const [index, closure] of profile.dependency_closures.entries()) {
      const path = `integrity profile dependency_closures[${index}]`;
      if (!hasExactOwnKeys(closure, DEPENDENCY_CLOSURE_KEYS)) {
        errors.push(`${path} must be a schema-closed plain object`);
        continue;
      }
      for (const key of ['platform', 'architecture']) {
        if (typeof closure[key] !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(closure[key])) {
          errors.push(`${path}.${key} is invalid`);
        }
      }
      if (!['exact_release_runtime', 'npm_ci_exact_platform'].includes(closure.materialization_method)) {
        errors.push(`${path}.materialization_method is invalid`);
      }
      if (
        typeof closure.materialization_environment !== 'string'
        || !/^[a-zA-Z0-9._ -]{1,120}$/.test(closure.materialization_environment)
      ) errors.push(`${path}.materialization_environment is invalid`);
      if (!['not_recorded', 'offline_cache_only'].includes(closure.materialization_network_status)) {
        errors.push(`${path}.materialization_network_status is invalid`);
      }
      if (typeof closure.node_version !== 'string' || !/^v\d+\.\d+\.\d+$/.test(closure.node_version)) {
        errors.push(`${path}.node_version is invalid`);
      }
      if (closure.npm_version !== 'not_recorded' && !/^\d+\.\d+\.\d+$/.test(closure.npm_version || '')) {
        errors.push(`${path}.npm_version is invalid`);
      }
      if (!Number.isInteger(closure.dependency_file_count) || closure.dependency_file_count < 1) {
        errors.push(`${path}.dependency_file_count is invalid`);
      }
      if (!SHA256_PATTERN.test(closure.dependency_tree_digest || '')) {
        errors.push(`${path}.dependency_tree_digest is invalid`);
      }
      const tuple = `${closure.platform}/${closure.architecture}`;
      if (tuples.has(tuple)) errors.push(`${path} duplicates ${tuple}`);
      tuples.add(tuple);
    }
  }
  const { profile_hash: observedHash, ...body } = profile;
  const expectedHash = integritySha256(body);
  if (!SHA256_PATTERN.test(observedHash || '') || observedHash !== expectedHash) {
    errors.push('integrity profile hash mismatch');
  }
  return Object.freeze({
    ok: errors.length === 0,
    errors: Object.freeze(errors),
    expected_hash: expectedHash,
  });
}

export function loadPrimeAgentIntegrityProfile(profilePath) {
  let profile = null;
  try {
    profile = JSON.parse(readFileSync(resolve(String(profilePath || '')), 'utf8'));
  } catch {
    return Object.freeze({
      valid: false,
      blockers: Object.freeze(['integrity_profile_invalid']),
      profile: null,
    });
  }
  const verification = verifyPrimeAgentIntegrityProfile(profile);
  return Object.freeze({
    valid: verification.ok,
    blockers: Object.freeze(verification.errors.map((error) => `integrity_profile:${error}`)),
    profile: verification.ok ? Object.freeze(profile) : null,
  });
}

export function selectPrimeAgentDependencyClosure(profile, platform, architecture) {
  if (!profile || !Array.isArray(profile.dependency_closures)) return null;
  return profile.dependency_closures.find((closure) => (
    closure.platform === platform && closure.architecture === architecture
  )) || null;
}

function normalizedPath(path) {
  return path.split(sep).join('/');
}

function assertInside(root, candidate) {
  const rel = relative(root, candidate);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new TypeError(`path escapes integrity root: ${candidate}`);
  }
}

export function buildTreeIntegrity(rootPath, { excludeTopLevel = [] } = {}) {
  const root = resolve(String(rootPath || ''));
  const blockers = [];
  const entries = [];
  const excluded = new Set(excludeTopLevel);
  if (!existsSync(root) || !lstatSync(root).isDirectory()) {
    return Object.freeze({
      valid: false,
      blockers: Object.freeze(['integrity_root_invalid']),
      file_count: 0,
      tree_digest: null,
    });
  }

  function walk(directory, relativeDirectory = '') {
    for (const item of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relativePath = relativeDirectory ? join(relativeDirectory, item.name) : item.name;
      const topLevel = relativePath.split(sep)[0];
      if (excluded.has(topLevel)) continue;
      const absolutePath = resolve(directory, item.name);
      assertInside(root, absolutePath);
      const portablePath = normalizedPath(relativePath);
      const info = lstatSync(absolutePath);
      if (info.isSymbolicLink()) {
        entries.push({ path: portablePath, type: 'symlink', target: normalizedPath(readlinkSync(absolutePath)) });
      } else if (info.isDirectory()) {
        walk(absolutePath, relativePath);
      } else if (info.isFile()) {
        entries.push({
          path: portablePath,
          type: 'file',
          size_bytes: info.size,
          sha256: sha256File(absolutePath),
        });
      } else {
        blockers.push(`unsupported_integrity_entry:${portablePath}`);
      }
    }
  }

  try {
    walk(root);
  } catch (error) {
    blockers.push(`integrity_walk_failed:${error.code || error.name || 'error'}`);
  }
  return Object.freeze({
    valid: blockers.length === 0,
    blockers: Object.freeze(blockers),
    file_count: entries.length,
    tree_digest: blockers.length === 0 ? integritySha256(entries) : null,
  });
}

export function buildPrimeAgentExtensionIntegrity(extensionPath, { expectedManifestDigest = null } = {}) {
  const requestedRoot = resolve(String(extensionPath || ''));
  const blockers = [];
  let root = requestedRoot;
  try {
    root = realpathSync(requestedRoot);
    if (!lstatSync(root).isDirectory()) blockers.push('extension_integrity_root_invalid');
  } catch {
    blockers.push('extension_integrity_root_invalid');
  }
  const qualificationRoot = resolve(root, '..', 'integration-qualification');
  let packageJson = null;
  let qualificationPackageJson = null;
  const files = [];
  const qualificationFiles = [];
  try {
    packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  } catch {
    blockers.push('extension_package_metadata_invalid');
  }
  try {
    qualificationPackageJson = JSON.parse(
      readFileSync(join(qualificationRoot, 'package.json'), 'utf8'),
    );
  } catch {
    blockers.push('qualification_package_metadata_invalid');
  }
  const exact = (condition, blocker) => {
    if (!condition) blockers.push(blocker);
  };
  exact(packageJson?.name === '@agoragentic/prime-agent', 'extension_package_name_mismatch');
  exact(packageJson?.version === '0.2.0-alpha.0', 'extension_package_version_mismatch');
  exact(packageJson?.type === 'module', 'extension_package_type_mismatch');
  exact(packageJson?.private === true, 'extension_package_must_remain_private');
  exact(
    Array.isArray(packageJson?.pi?.extensions)
      && packageJson.pi.extensions.length === 1
      && packageJson.pi.extensions[0] === './index.mjs',
    'extension_manifest_mismatch',
  );
  exact(
    qualificationPackageJson?.name === '@agoragentic/integration-qualification',
    'qualification_package_name_mismatch',
  );
  exact(
    qualificationPackageJson?.version === '0.1.0-alpha.0',
    'qualification_package_version_mismatch',
  );
  exact(qualificationPackageJson?.type === 'module', 'qualification_package_type_mismatch');
  exact(qualificationPackageJson?.private === true, 'qualification_package_must_remain_private');
  exact(
    qualificationPackageJson?.exports?.['.'] === './src/index.mjs',
    'qualification_package_export_mismatch',
  );

  for (const relativePath of PRIME_AGENT_EXTENSION_MANIFEST_FILES) {
    const absolutePath = resolve(root, relativePath);
    try {
      assertInside(root, absolutePath);
      if (!existsSync(absolutePath) || !lstatSync(absolutePath).isFile()) {
        blockers.push(`extension_manifest_file_missing:${relativePath}`);
      } else {
        files.push({ path: relativePath, sha256: sha256File(absolutePath) });
      }
    } catch (error) {
      blockers.push(`extension_manifest_file_invalid:${relativePath}:${error.code || error.name || 'error'}`);
    }
  }

  for (const relativePath of PRIME_AGENT_QUALIFICATION_MANIFEST_FILES) {
    const absolutePath = resolve(qualificationRoot, relativePath);
    try {
      assertInside(qualificationRoot, absolutePath);
      if (!existsSync(absolutePath) || !lstatSync(absolutePath).isFile()) {
        blockers.push(`qualification_manifest_file_missing:${relativePath}`);
      } else {
        qualificationFiles.push({ path: relativePath, sha256: sha256File(absolutePath) });
      }
    } catch (error) {
      blockers.push(`qualification_manifest_file_invalid:${relativePath}:${error.code || error.name || 'error'}`);
    }
  }

  const body = {
    schema: 'agoragentic.prime-agent.extension-integrity.v2',
    package_name: packageJson?.name || null,
    package_version: packageJson?.version || null,
    distribution_status: 'source_only',
    files,
    qualification_dependency: {
      package_name: qualificationPackageJson?.name || null,
      package_version: qualificationPackageJson?.version || null,
      distribution_status: 'source_only_workspace_dependency',
      files: qualificationFiles,
    },
  };
  const manifestDigest = blockers.length === 0 ? integritySha256(body) : null;
  if (expectedManifestDigest !== null) {
    if (!SHA256_PATTERN.test(expectedManifestDigest || '')) {
      blockers.push('pinned_extension_manifest_digest_invalid');
    } else if (manifestDigest !== expectedManifestDigest) {
      blockers.push('extension_manifest_digest_mismatch');
    }
  }
  return Object.freeze({
    ...body,
    valid: blockers.length === 0,
    blockers: Object.freeze([...new Set(blockers)]),
    manifest_digest: manifestDigest,
  });
}

export function buildPrimeAgentDependencyIntegrity(releaseRoot, expectedLockPath, { expectedClosure = null } = {}) {
  const root = resolve(String(releaseRoot || ''));
  const lockPath = join(root, 'package-lock.json');
  const blockers = [];
  let observedLockDigest = null;
  let expectedLockDigest = null;
  let lock = null;
  try {
    lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    observedLockDigest = sha256File(lockPath);
  } catch {
    blockers.push('materialized_dependency_lock_invalid');
  }
  try {
    expectedLockDigest = sha256File(resolve(String(expectedLockPath || '')));
  } catch {
    blockers.push('pinned_dependency_lock_invalid');
  }
  if (observedLockDigest && expectedLockDigest && observedLockDigest !== expectedLockDigest) {
    blockers.push('materialized_dependency_lock_mismatch');
  }
  if (lock) {
    if (lock.name !== 'prime-agent') blockers.push('dependency_lock_name_mismatch');
    if (lock.version !== '0.7.2') blockers.push('dependency_lock_version_mismatch');
    if (!Number.isInteger(lock.lockfileVersion) || lock.lockfileVersion < 3) {
      blockers.push('dependency_lock_version_unsupported');
    }
    for (const [packagePath, packageRecord] of Object.entries(lock.packages || {})) {
      if (!packagePath.startsWith('node_modules/') || packageRecord?.optional === true) continue;
      const installedPath = resolve(root, packagePath);
      try {
        assertInside(root, installedPath);
        const installedPackage = JSON.parse(readFileSync(join(installedPath, 'package.json'), 'utf8'));
        if (packageRecord.version && installedPackage.version !== packageRecord.version) {
          blockers.push(`dependency_version_mismatch:${packagePath}`);
        }
        if (packageRecord.name && installedPackage.name !== packageRecord.name) {
          blockers.push(`dependency_name_mismatch:${packagePath}`);
        }
      } catch {
        blockers.push(`dependency_package_missing:${packagePath}`);
      }
    }
  }
  const dependencyTree = buildTreeIntegrity(join(root, 'node_modules'));
  blockers.push(...dependencyTree.blockers.map((blocker) => `dependency_tree:${blocker}`));
  if (dependencyTree.file_count < 1) blockers.push('dependency_tree_empty');
  if (expectedClosure !== null) {
    if (!hasExactOwnKeys(expectedClosure, DEPENDENCY_CLOSURE_KEYS)) {
      blockers.push('pinned_dependency_closure_invalid');
    } else if (
      dependencyTree.file_count !== expectedClosure.dependency_file_count
      || dependencyTree.tree_digest !== expectedClosure.dependency_tree_digest
    ) {
      blockers.push('dependency_tree_profile_mismatch');
    }
  }
  return Object.freeze({
    schema: 'agoragentic.prime-agent.dependency-integrity.v1',
    valid: blockers.length === 0,
    blockers: Object.freeze([...new Set(blockers)]),
    lock_digest: observedLockDigest,
    pinned_lock_digest: expectedLockDigest,
    dependency_file_count: dependencyTree.file_count,
    dependency_tree_digest: dependencyTree.tree_digest,
  });
}
