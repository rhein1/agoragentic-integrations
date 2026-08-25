import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { builtinModules, createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';
import {
  extractCompleteReadmeLicense,
  getCompleteReadmeLicenseFallback,
  selectStandaloneLicenseEntry,
} from './license-notices.mjs';

const packageRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const repositoryRoot = path.resolve(packageRoot, '..');
const mcpRoot = path.join(repositoryRoot, 'mcp');
const riskForkRoot = path.join(repositoryRoot, 'risk-fork');
const transactionAssuranceRoot = path.join(repositoryRoot, 'transaction-assurance');
const snapshotRoot = path.join(packageRoot, '.build', 'upstream');
const snapshotMcpRoot = path.join(snapshotRoot, 'mcp');
const snapshotRiskForkRoot = path.join(snapshotRoot, 'risk-fork');
const packageNodeModules = path.join(packageRoot, 'node_modules');
const resolutionRoots = [packageRoot, mcpRoot, riskForkRoot];
const require = createRequire(import.meta.url);
const INTEGRITY_MANIFEST_SCHEMA = 'agoragentic.risk-fork-hosted-mcp.integrity.v2';
const REVIEWED_SOURCE_ATTESTATION_SCHEMA = 'agoragentic.risk-fork-hosted-mcp.reviewed-sources.v2';
const REVIEWED_SOURCE_NORMALIZATION = 'utf8_crlf_to_lf_lone_cr_preserved';
const REFRESH_REVIEWED_SOURCES_FLAG = '--refresh-reviewed-sources';
const EXPECTED_ARTIFACT_PATH = 'dist/runtime/index.mjs';
const THIRD_PARTY_NOTICES_PATH = 'THIRD_PARTY_NOTICES.txt';
const WINDOWS_RESERVED_BASENAME_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const EXPECTED_BUILD_TRANSFORMS = Object.freeze([
  'reviewed UTF-8 source CRLF pairs normalized to LF while lone CR bytes remain distinct',
  'canonical upstream project sources verified against the reviewed SHA-256 digest inventory',
  'pg-native optional adapter disabled; reviewed pg JavaScript driver bundled',
  'e2b is retained only as the exact optional peer e2b@2.39.0',
]);
const EXPECTED_PACKAGE_JSON = Object.freeze({
  name: '@agoragentic/risk-fork-hosted-mcp',
  version: '0.1.0-alpha.0',
  description: 'Private, unpublished, integrity-bound hosted MCP enforcement and Risk Fork runtime bundle.',
  type: 'module',
  private: true,
  license: 'MIT',
  engines: { node: '>=20.0.0' },
  exports: {
    '.': './dist/runtime/index.mjs',
    './e2b-context/*': './e2b-context/*',
    './migrations/*': './migrations/*',
    './ops/postgres/*': './ops/postgres/*',
    './schema/*': './schema/*',
  },
  files: [
    'dist/runtime/index.mjs',
    'e2b-context/',
    'integrity-manifest.json',
    'migrations/001_distributed_authority.pg.sql',
    'ops/postgres/',
    'schema/e2b-qualification-evidence.v1.json',
    'scripts/verify-integrity.mjs',
    'THIRD_PARTY_NOTICES.txt',
    'README.md',
    'LICENSE',
  ],
  scripts: {
    build: 'node scripts/build.mjs',
    check: 'node --check src/index.mjs && node --check scripts/build.mjs && node --check scripts/license-notices.mjs && node --check scripts/verify-integrity.mjs && node --check test/package-artifact.test.mjs',
    test: 'node --test --test-concurrency=1 test/package-artifact.test.mjs',
    verify: 'node scripts/verify-integrity.mjs',
    'verify:source': 'node scripts/verify-integrity.mjs --source',
    'pack:dry': 'npm pack --dry-run --json',
    prepack: 'node scripts/build.mjs && node scripts/verify-integrity.mjs --source --quiet',
    prepublishOnly: 'node -e "throw new Error(\'RISK_FORK_HOSTED_MCP_PUBLISH_DISABLED\')"',
  },
  devDependencies: {
    '@modelcontextprotocol/client': '2.0.0',
    '@modelcontextprotocol/node': '2.0.0',
    '@modelcontextprotocol/sdk': '1.30.0',
    '@modelcontextprotocol/server': '2.0.0',
    ajv: '8.20.0',
    'ajv-formats': '3.0.1',
    esbuild: '0.28.1',
    pg: '8.16.3',
  },
  peerDependencies: { e2b: '2.39.0' },
  peerDependenciesMeta: { e2b: { optional: true } },
  repository: {
    type: 'git',
    url: 'git+https://github.com/rhein1/agoragentic-integrations.git',
    directory: 'risk-fork-hosted-mcp',
  },
});
const EXPECTED_SOURCES = Object.freeze({
  mcp: { name: 'agoragentic-mcp', version: '2.0.0' },
  risk_fork: { name: '@agoragentic/risk-fork', version: '0.1.0-alpha.0' },
});
const EXPECTED_PACKAGE_SOURCE_PATHS = Object.freeze([
  'risk-fork-hosted-mcp/src/index.mjs',
  'risk-fork-hosted-mcp/src/pg-native-disabled.js',
]);
const EXPECTED_EXPORTS = Object.freeze([
  'E2BRiskForkAdapter',
  'E2B_EXTERNAL_BIRTH_CONTROLS',
  'E2B_EXTERNAL_PROVIDER_CONTROLS',
  'E2B_EXTERNAL_QUALIFICATION_EVIDENCE_REFS',
  'E2B_EXTERNAL_QUALIFICATION_OBSERVATION_SCHEMA',
  'E2B_INDEPENDENT_SOURCE_ATTESTATION_SCHEMA',
  'E2B_QUALIFICATION_CONTROLS',
  'E2B_QUALIFICATION_SCHEMA',
  'E2B_QUALIFICATION_TRUST_SCHEMA',
  'E2B_RISK_FORK_PATHS',
  'E2B_RUNTIME_SDK_INTEGRITY_SCHEMA',
  'E2B_SECURE_SNAPSHOT_PROFILE_UNAVAILABLE',
  'FileExecutionAuthorizationTransaction',
  'FileParentHeadTransaction',
  'HOSTED_MCP_BUNDLE_METADATA',
  'MCP_ENFORCEMENT_SCHEMAS',
  'MCP_V2_PROTOCOL_VERSION',
  'PostgresDistributedCommitAuthority',
  'REQUIRED_PROVIDER_METHODS',
  'RiskForkCommitError',
  'RiskForkController',
  'RiskForkMcpBoundary',
  'RiskForkPreparationError',
  'RiskForkProvider',
  'acquirePostgresAuthorityClient',
  'applyE2BExternalQualificationObservation',
  'assertHostCanEnforce',
  'assertPreparedForCleanCommit',
  'assertRiskForkProvider',
  'buildExecutionBinding',
  'buildFallbackToolList',
  'buildPostgresAuthorityPoolConfig',
  'classifyRisk',
  'closeRemoteSession',
  'commitPreparedArtifact',
  'computeMcpCleanImportEvidenceHash',
  'connectRemoteClient',
  'createE2BAuthorityFreeSourceVerifier',
  'createE2BExternalQualificationObservationVerifier',
  'createE2BQualificationEvidence',
  'createE2BQualificationTrustVerifier',
  'createE2BRuntimeSdkIntegrityVerifier',
  'createForkIdentity',
  'createMcpEnforcementBoundary',
  'createMcpInterceptionPlan',
  'createPostgresAuthorityPool',
  'createRemoteToolDirectory',
  'createSavepointCapsule',
  'createTrustedMcpServerVerifier',
  'deriveParentAuthorityRef',
  'executeFallbackTool',
  'isE2BQualificationEvidenceCanonical',
  'isE2BRuntimeSdkIntegrityVerifier',
  'isPostgresDistributedCommitAuthority',
  'isProductionPostgresDistributedCommitAuthority',
  'loadVerifiedE2BRuntimeSdk',
  'migratePostgresDistributedAuthority',
  'networkPolicy',
  'quotePostgresAuthorityIdentifier',
  'requireProviderCapability',
  'riskDecisionCanonicalBytes',
  'runAcpAdapter',
  'runMcpRelay',
  'scanE2BStagedBytesAuthorityFree',
  'scanTaintedValue',
  'sha256BytesRef',
  'sha256FileRef',
  'validateCommitCandidate',
  'validateE2BQualificationEvidence',
  'verifyCommitArtifact',
  'verifyE2BExternalQualificationObservation',
  'verifyE2BQualificationTrust',
  'verifyExecutionBinding',
  'verifyPostgresAuthorityClientTransport',
  'verifyPostgresDistributedAuthoritySchema',
  'verifyRiskDecision',
  'verifySavepointCapsule',
]);

function parseExactFlags(args, allowedFlags, label) {
  const seen = new Set();
  for (const argument of args) {
    if (!allowedFlags.has(argument) || seen.has(argument)) {
      throw new Error(`Unsupported ${label} arguments: ${args.join(' ')}`);
    }
    seen.add(argument);
  }
  return seen;
}

const buildFlags = parseExactFlags(
  process.argv.slice(2),
  new Set([REFRESH_REVIEWED_SOURCES_FLAG]),
  'hosted MCP build',
);
const refreshReviewedSources = buildFlags.has(REFRESH_REVIEWED_SOURCES_FLAG);
const REVIEWED_SOURCE_EXACT_FILES = Object.freeze([
  'mcp/mcp-server.js',
  'mcp/package.json',
  'risk-fork/migrations/001_distributed_authority.pg.sql',
  'risk-fork/package.json',
  'risk-fork/schema/e2b-qualification-evidence.v1.json',
]);
const REVIEWED_SOURCE_RECURSIVE_ROOTS = Object.freeze([
  'risk-fork/e2b-template',
  'risk-fork/ops/postgres',
  'risk-fork/src',
  'transaction-assurance/src',
]);
const PACKAGED_REVIEWED_ASSETS = Object.freeze([
  {
    source: 'risk-fork/e2b-template/bin/boot-guard.mjs',
    target: 'e2b-context/risk-fork/e2b-template/bin/boot-guard.mjs',
  },
  {
    source: 'risk-fork/e2b-template/bin/bootstrap.mjs',
    target: 'e2b-context/risk-fork/e2b-template/bin/bootstrap.mjs',
  },
  {
    source: 'risk-fork/e2b-template/bin/run.mjs',
    target: 'e2b-context/risk-fork/e2b-template/bin/run.mjs',
  },
  {
    source: 'risk-fork/e2b-template/lib/runtime-contract.mjs',
    target: 'e2b-context/risk-fork/e2b-template/lib/runtime-contract.mjs',
  },
  {
    source: 'risk-fork/e2b-template/template.mjs',
    target: 'e2b-context/risk-fork/e2b-template/template.mjs',
  },
  {
    source: 'risk-fork/src/canonical.mjs',
    target: 'e2b-context/risk-fork/src/canonical.mjs',
  },
  {
    source: 'risk-fork/src/child-operation.mjs',
    target: 'e2b-context/risk-fork/src/child-operation.mjs',
  },
  {
    source: 'risk-fork/src/util.mjs',
    target: 'e2b-context/risk-fork/src/util.mjs',
  },
  {
    source: 'transaction-assurance/src/canonical.mjs',
    target: 'e2b-context/transaction-assurance/src/canonical.mjs',
  },
  {
    source: 'risk-fork/migrations/001_distributed_authority.pg.sql',
    target: 'migrations/001_distributed_authority.pg.sql',
  },
  {
    source: 'risk-fork/ops/postgres/owner-bootstrap.sql.template',
    target: 'ops/postgres/owner-bootstrap.sql.template',
  },
  {
    source: 'risk-fork/ops/postgres/roles.sql.template',
    target: 'ops/postgres/roles.sql.template',
  },
  {
    source: 'risk-fork/schema/e2b-qualification-evidence.v1.json',
    target: 'schema/e2b-qualification-evidence.v1.json',
  },
]);

function inside(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function insideOrEqual(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function compareOrdinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameFilesystemPath(left, right) {
  const normalizedLeft = path.normalize(path.resolve(left));
  const normalizedRight = path.normalize(path.resolve(right));
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function assertExactKeys(value, expectedKeys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || JSON.stringify(Object.keys(value)) !== JSON.stringify(expectedKeys)) {
    throw new Error(`${label} must use the exact reviewed key contract`);
  }
}

function assertOrdinalUnique(values, label, { paths = false } = {}) {
  const folded = new Set();
  let previous = null;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (typeof value !== 'string' || value === '' || (paths && !isCanonicalRepositoryPath(value))) {
      throw new Error(`${label} contains an invalid value at index ${index}: ${String(value)}`);
    }
    if (previous !== null && compareOrdinal(previous, value) >= 0) {
      throw new Error(`${label} must be strictly ordinal-sorted and unique`);
    }
    const caseFolded = value.toLowerCase();
    if (folded.has(caseFolded)) {
      throw new Error(`${label} contains a case-fold alias: ${value}`);
    }
    folded.add(caseFolded);
    previous = value;
  }
}

function assertPackageTarget(candidate, label) {
  const resolved = path.resolve(candidate);
  if (!inside(packageRoot, resolved)) throw new Error(`${label} escapes the package root`);
  return resolved;
}

function resolveBuildPackage(specifier) {
  for (const root of resolutionRoots) {
    const nodeModulesRoot = path.join(root, 'node_modules');
    try {
      const resolved = require.resolve(specifier, { paths: [root] });
      if (inside(nodeModulesRoot, resolved)) return resolved;
    } catch (error) {
      if (error?.code !== 'MODULE_NOT_FOUND') throw error;
    }
  }
  throw new Error(`Missing exact build dependency: ${specifier}`);
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function canonicalReviewedSourceBytes(bytes, sourcePath) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`Reviewed source is not valid UTF-8 text: ${sourcePath}`, { cause: error });
  }
  let crlfPairs = 0;
  for (let index = 0; index + 1 < bytes.byteLength; index += 1) {
    if (bytes[index] === 0x0d && bytes[index + 1] === 0x0a) {
      crlfPairs += 1;
      index += 1;
    }
  }
  if (crlfPairs === 0) return Buffer.from(bytes);
  const normalized = Buffer.allocUnsafe(bytes.byteLength - crlfPairs);
  let target = 0;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] === 0x0d && bytes[index + 1] === 0x0a) {
      normalized[target] = 0x0a;
      target += 1;
      index += 1;
    } else {
      normalized[target] = bytes[index];
      target += 1;
    }
  }
  return normalized;
}

function portable(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function repoRelative(absolutePath) {
  const relative = path.relative(repositoryRoot, absolutePath);
  if (relative === '' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Build input escapes the repository: ${absolutePath}`);
  }
  const canonical = portable(relative);
  if (!isCanonicalRepositoryPath(canonical)) {
    throw new Error(`Build input path is not canonical: ${canonical}`);
  }
  return canonical;
}

function isCanonicalRepositoryPath(relativePath) {
  if (typeof relativePath !== 'string'
    || relativePath === ''
    || relativePath.includes('\\')
    || relativePath.includes(':')
    || path.posix.isAbsolute(relativePath)
    || path.posix.normalize(relativePath) !== relativePath) {
    return false;
  }
  return relativePath.split('/').every((segment) => {
    const basename = segment.split('.')[0];
    return segment !== '.'
      && segment !== '..'
      && !segment.endsWith('.')
      && !segment.endsWith(' ')
      && /^[A-Za-z0-9@._-]+$/.test(segment)
      && !WINDOWS_RESERVED_BASENAME_PATTERN.test(basename);
  });
}

function resolveRepositorySource(relativePath, label = 'reviewed source') {
  if (!isCanonicalRepositoryPath(relativePath)) {
    throw new Error(`${label} path is not canonical: ${String(relativePath)}`);
  }
  const resolved = path.resolve(repositoryRoot, ...relativePath.split('/'));
  if (!inside(repositoryRoot, resolved)) throw new Error(`${label} escapes the repository`);
  return resolved;
}

async function assertSafeReviewedSourcePath(relativePath, expectedType, label = 'reviewed source') {
  const resolved = resolveRepositorySource(relativePath, label);
  const repositoryStat = await lstat(repositoryRoot);
  if (!repositoryStat.isDirectory() || repositoryStat.isSymbolicLink()) {
    throw new Error(`${label} repository root is not a real directory`);
  }
  const realRepositoryRoot = await realpath(repositoryRoot);
  if (!sameFilesystemPath(realRepositoryRoot, repositoryRoot)) {
    throw new Error(`${label} repository root traverses a symlink or reparse point`);
  }

  let current = repositoryRoot;
  const segments = relativePath.split('/');
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    const componentStat = await lstat(current);
    if (componentStat.isSymbolicLink()) {
      throw new Error(`${label} traverses a symlink or reparse point: ${relativePath}`);
    }
    const componentRealPath = await realpath(current);
    const expectedRealPath = path.join(realRepositoryRoot, ...segments.slice(0, index + 1));
    if (!insideOrEqual(realRepositoryRoot, componentRealPath)
      || !sameFilesystemPath(componentRealPath, expectedRealPath)) {
      throw new Error(`${label} escapes its real repository root: ${relativePath}`);
    }
    const isFinal = index === segments.length - 1;
    if (!isFinal && !componentStat.isDirectory()) {
      throw new Error(`${label} has a non-directory ancestor: ${relativePath}`);
    }
    if (isFinal && expectedType === 'directory' && !componentStat.isDirectory()) {
      throw new Error(`${label} is not a real directory: ${relativePath}`);
    }
    if (isFinal && expectedType === 'file' && !componentStat.isFile()) {
      throw new Error(`${label} is not a regular file: ${relativePath}`);
    }
  }
  return resolved;
}

function isReviewedSourcePath(relativePath) {
  return isCanonicalRepositoryPath(relativePath)
    && (REVIEWED_SOURCE_EXACT_FILES.includes(relativePath)
      || REVIEWED_SOURCE_RECURSIVE_ROOTS.some((root) => relativePath.startsWith(`${root}/`)));
}

function assertCaseFoldUnique(values, label) {
  const folded = new Set();
  const exact = new Set();
  for (const value of values) {
    if (exact.has(value)) throw new Error(`${label} contains a duplicate: ${value}`);
    const caseFolded = value.toLowerCase();
    if (folded.has(caseFolded)) throw new Error(`${label} contains a case-fold alias: ${value}`);
    exact.add(value);
    folded.add(caseFolded);
  }
}

function assertStaticBuildContract() {
  assertOrdinalUnique(REVIEWED_SOURCE_EXACT_FILES, 'Reviewed exact source paths', { paths: true });
  assertOrdinalUnique(REVIEWED_SOURCE_RECURSIVE_ROOTS, 'Reviewed recursive source roots', { paths: true });
  assertOrdinalUnique(EXPECTED_PACKAGE_SOURCE_PATHS, 'Package source paths', { paths: true });
  assertOrdinalUnique(EXPECTED_EXPORTS, 'Runtime export contract');
  for (let index = 0; index < PACKAGED_REVIEWED_ASSETS.length; index += 1) {
    const mapping = PACKAGED_REVIEWED_ASSETS[index];
    assertExactKeys(mapping, ['source', 'target'], `Packaged reviewed asset mapping ${index}`);
    if (!isReviewedSourcePath(mapping.source) || !isCanonicalRepositoryPath(mapping.target)) {
      throw new Error(`Packaged reviewed asset mapping ${index} is outside the exact path contract`);
    }
  }
  assertOrdinalUnique(
    PACKAGED_REVIEWED_ASSETS.map((mapping) => mapping.target),
    'Packaged reviewed asset targets',
    { paths: true },
  );
  assertCaseFoldUnique(
    PACKAGED_REVIEWED_ASSETS.map((mapping) => mapping.source),
    'Packaged reviewed asset sources',
  );
}

function expectedInputSource(inputPath, reviewedSourcePaths) {
  if (reviewedSourcePaths.has(inputPath)) return 'reviewed_source';
  if (EXPECTED_PACKAGE_SOURCE_PATHS.includes(inputPath)) return 'package_source';
  if (inputPath.startsWith('risk-fork-hosted-mcp/node_modules/')) return 'workspace_dependency';
  throw new Error(`Build input is outside the exact hosted MCP input contract: ${inputPath}`);
}

function mergeExactInputRecords(records, reviewedSourcePaths) {
  const byPath = new Map();
  const caseFoldedPaths = new Map();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    assertExactKeys(record, ['path', 'source', 'bytes', 'sha256'], `Build input ${index}`);
    if (!isCanonicalRepositoryPath(record.path)
      || record.source !== expectedInputSource(record.path, reviewedSourcePaths)
      || !Number.isSafeInteger(record.bytes)
      || record.bytes <= 0
      || !/^sha256:[a-f0-9]{64}$/.test(record.sha256)) {
      throw new Error(`Build input contract is invalid: ${String(record.path)}`);
    }
    const folded = record.path.toLowerCase();
    const aliased = caseFoldedPaths.get(folded);
    if (aliased !== undefined && aliased !== record.path) {
      throw new Error(`Build input contains a case-fold alias: ${aliased} / ${record.path}`);
    }
    caseFoldedPaths.set(folded, record.path);
    const existing = byPath.get(record.path);
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(record)) {
      throw new Error(`Build input has conflicting duplicate integrity records: ${record.path}`);
    }
    if (existing === undefined) byPath.set(record.path, record);
  }
  const inputs = [...byPath.values()].sort((left, right) => compareOrdinal(left.path, right.path));
  assertOrdinalUnique(inputs.map((record) => record.path), 'Build inputs', { paths: true });
  const packageSources = inputs
    .filter((record) => record.source === 'package_source')
    .map((record) => record.path);
  if (JSON.stringify(packageSources) !== JSON.stringify(EXPECTED_PACKAGE_SOURCE_PATHS)) {
    throw new Error('Build inputs do not contain the exact package source contract');
  }
  return inputs;
}

function assertGeneratedManifestContract(manifest, expectedAttestation) {
  assertExactKeys(manifest, [
    'schema',
    'package',
    'source_attestation',
    'reviewed_sources',
    'sources',
    'build',
    'runtime_dependencies',
    'optional_peer_dependencies',
    'exports',
    'inputs',
    'third_party_notices',
    'artifact',
    'packaged_assets',
  ], 'Hosted MCP integrity manifest');
  assertExactKeys(manifest.package, ['name', 'version', 'private'], 'Manifest package');
  assertExactKeys(
    manifest.source_attestation,
    ['schema', 'normalization', 'files', 'sha256'],
    'Manifest source attestation',
  );
  assertExactKeys(manifest.sources, ['mcp', 'risk_fork'], 'Manifest sources');
  assertExactKeys(manifest.sources.mcp, ['name', 'version'], 'Manifest MCP source');
  assertExactKeys(manifest.sources.risk_fork, ['name', 'version'], 'Manifest Risk Fork source');
  assertExactKeys(
    manifest.build,
    ['builder', 'platform', 'target', 'format', 'transforms', 'external_imports'],
    'Manifest build',
  );
  assertExactKeys(
    manifest.third_party_notices,
    ['path', 'bytes', 'sha256', 'sources'],
    'Manifest third-party notices',
  );
  assertExactKeys(manifest.artifact, ['path', 'bytes', 'sha256'], 'Manifest artifact');
  if (manifest.schema !== INTEGRITY_MANIFEST_SCHEMA
    || JSON.stringify(manifest.package) !== JSON.stringify({
      name: EXPECTED_PACKAGE_JSON.name,
      version: EXPECTED_PACKAGE_JSON.version,
      private: true,
    })
    || JSON.stringify(manifest.source_attestation) !== JSON.stringify(expectedAttestation)
    || JSON.stringify(manifest.sources) !== JSON.stringify(EXPECTED_SOURCES)
    || manifest.build.builder !== 'esbuild@0.28.1'
    || manifest.build.platform !== 'node'
    || manifest.build.target !== 'node20'
    || manifest.build.format !== 'esm'
    || JSON.stringify(manifest.build.transforms) !== JSON.stringify(EXPECTED_BUILD_TRANSFORMS)
    || JSON.stringify(manifest.runtime_dependencies) !== '[]'
    || JSON.stringify(manifest.optional_peer_dependencies) !== JSON.stringify([
      { name: 'e2b', version: '2.39.0', optional: true },
    ])
    || JSON.stringify(manifest.exports) !== JSON.stringify(EXPECTED_EXPORTS)
    || manifest.third_party_notices.path !== THIRD_PARTY_NOTICES_PATH
    || manifest.artifact.path !== EXPECTED_ARTIFACT_PATH) {
    throw new Error('Generated hosted MCP integrity manifest violates the exact contract');
  }
  assertOrdinalUnique(manifest.build.external_imports, 'Manifest external imports');
  assertOrdinalUnique(manifest.inputs.map((record) => record.path), 'Manifest inputs', { paths: true });
  assertOrdinalUnique(
    manifest.packaged_assets.map((record) => record.path),
    'Manifest packaged assets',
    { paths: true },
  );
  assertOrdinalUnique(
    manifest.third_party_notices.sources.map((source) => source.package),
    'Manifest third-party notice sources',
  );
  assertCaseFoldUnique(
    manifest.third_party_notices.sources.map((source) => source.path),
    'Manifest third-party notice source paths',
  );
  for (let index = 0; index < manifest.third_party_notices.sources.length; index += 1) {
    assertExactKeys(manifest.third_party_notices.sources[index], [
      'package',
      'version',
      'declared_license',
      'method',
      'path',
      'source_bytes',
      'source_sha256',
      'notice_bytes',
      'notice_sha256',
    ], `Manifest third-party notice source ${index}`);
  }
  const expectedAssetByPath = new Map(
    PACKAGED_REVIEWED_ASSETS.map((mapping) => [mapping.target, mapping.source]),
  );
  for (let index = 0; index < manifest.packaged_assets.length; index += 1) {
    const asset = manifest.packaged_assets[index];
    if (asset.path === THIRD_PARTY_NOTICES_PATH) {
      assertExactKeys(asset, ['path', 'bytes', 'sha256'], `Manifest packaged asset ${index}`);
      continue;
    }
    assertExactKeys(
      asset,
      ['path', 'source_path', 'bytes', 'sha256'],
      `Manifest packaged asset ${index}`,
    );
    if (asset.source_path !== expectedAssetByPath.get(asset.path)) {
      throw new Error(`Manifest packaged asset mapping is invalid: ${asset.path}`);
    }
  }
}

async function listRegularFiles(relativeRoot) {
  const root = await assertSafeReviewedSourcePath(
    relativeRoot,
    'directory',
    'reviewed source root',
  );
  const output = [];

  async function walk(directory, relativeDirectory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareOrdinal(left.name, right.name));
    assertOrdinalUnique(entries.map((entry) => entry.name), `Reviewed source directory ${relativeDirectory}`);
    for (const entry of entries) {
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        const absolutePath = await assertSafeReviewedSourcePath(
          relativePath,
          'directory',
          'reviewed source directory',
        );
        await walk(absolutePath, relativePath);
      } else if (entry.isFile()) {
        await assertSafeReviewedSourcePath(relativePath, 'file');
        output.push(relativePath);
      } else {
        throw new Error(`Reviewed source inventory contains a non-regular entry: ${relativePath}`);
      }
    }
  }

  await walk(root, relativeRoot);
  return output;
}

async function discoverReviewedSourcePaths() {
  const paths = [...REVIEWED_SOURCE_EXACT_FILES];
  for (const relativeRoot of REVIEWED_SOURCE_RECURSIVE_ROOTS) {
    paths.push(...await listRegularFiles(relativeRoot));
  }
  const sorted = [...paths].sort(compareOrdinal);
  assertOrdinalUnique(sorted, 'Reviewed source path inventory', { paths: true });
  for (const relativePath of sorted) {
    if (!isReviewedSourcePath(relativePath)) {
      throw new Error(`Discovered source is outside the reviewed inventory: ${relativePath}`);
    }
    await assertSafeReviewedSourcePath(relativePath, 'file');
  }
  return sorted;
}

function validateReviewedSourceRecords(records) {
  if (!Array.isArray(records) || records.length < 10) {
    throw new Error('Reviewed source digest inventory is unexpectedly incomplete');
  }
  const normalized = records.map((record, index) => {
    assertExactKeys(record, ['path', 'bytes', 'sha256'], `Reviewed source digest record ${index}`);
    if (!isReviewedSourcePath(record.path)) {
      throw new Error(`Reviewed source digest path is not allowed: ${String(record.path)}`);
    }
    resolveRepositorySource(record.path, 'reviewed source digest');
    if (!Number.isSafeInteger(record.bytes) || record.bytes <= 0
      || !/^sha256:[a-f0-9]{64}$/.test(record.sha256 ?? '')) {
      throw new Error(`Reviewed source digest is invalid: ${record.path}`);
    }
    return { path: record.path, bytes: record.bytes, sha256: record.sha256 };
  });
  assertOrdinalUnique(
    normalized.map((record) => record.path),
    'Reviewed source digest inventory',
    { paths: true },
  );
  return normalized;
}

function reviewedSourceAttestation(records) {
  const canonical = Buffer.from(
    `${REVIEWED_SOURCE_ATTESTATION_SCHEMA}\n${REVIEWED_SOURCE_NORMALIZATION}\n${JSON.stringify(records)}\n`,
    'utf8',
  );
  return Object.freeze({
    schema: REVIEWED_SOURCE_ATTESTATION_SCHEMA,
    normalization: REVIEWED_SOURCE_NORMALIZATION,
    files: records.length,
    sha256: sha256(canonical),
  });
}

async function currentReviewedSourceRecords() {
  const records = [];
  for (const sourcePath of await discoverReviewedSourcePaths()) {
    const resolvedSource = await assertSafeReviewedSourcePath(sourcePath, 'file');
    const bytes = canonicalReviewedSourceBytes(
      await readFile(resolvedSource),
      sourcePath,
    );
    records.push({ path: sourcePath, bytes: bytes.byteLength, sha256: sha256(bytes) });
  }
  return validateReviewedSourceRecords(records);
}

async function loadReviewedSourceRecords() {
  const current = await currentReviewedSourceRecords();
  if (refreshReviewedSources) return current;

  let existing;
  try {
    existing = JSON.parse(await readFile(path.join(packageRoot, 'integrity-manifest.json'), 'utf8'));
  } catch (error) {
    throw new Error('A valid integrity manifest is required to build reviewed sources', { cause: error });
  }
  if (existing.schema !== INTEGRITY_MANIFEST_SCHEMA) {
    throw new Error('A v2 integrity manifest is required for an ordinary reviewed-source build');
  }
  const pinned = validateReviewedSourceRecords(existing.reviewed_sources);
  const attestation = reviewedSourceAttestation(pinned);
  assertExactKeys(
    existing.source_attestation,
    ['schema', 'normalization', 'files', 'sha256'],
    'Reviewed source attestation',
  );
  if (existing.source_attestation.schema !== attestation.schema
    || existing.source_attestation?.normalization !== attestation.normalization
    || existing.source_attestation?.files !== attestation.files
    || existing.source_attestation?.sha256 !== attestation.sha256) {
    throw new Error('Reviewed source attestation does not match its exact digest inventory');
  }
  if (JSON.stringify(current) !== JSON.stringify(pinned)) {
    throw new Error(
      `Reviewed source bytes changed; ${REFRESH_REVIEWED_SOURCES_FLAG} is required before independent review`,
    );
  }
  return pinned;
}

function snapshotSourcePath(snapshotRoot, absolutePath) {
  const relative = path.relative(snapshotRoot, absolutePath);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)) return null;
  const canonical = portable(relative);
  return isCanonicalRepositoryPath(canonical) ? canonical : null;
}

async function materializeReviewedSources(records, snapshotRoot) {
  const snapshot = assertPackageTarget(snapshotRoot, 'reviewed source snapshot');
  await rm(snapshot, { recursive: true, force: true });
  for (const record of records) {
    const sourcePath = record.path;
    const resolvedSource = await assertSafeReviewedSourcePath(sourcePath, 'file');
    const bytes = canonicalReviewedSourceBytes(
      await readFile(resolvedSource),
      sourcePath,
    );
    if (bytes.byteLength !== record.bytes || sha256(bytes) !== record.sha256) {
      throw new Error(`Reviewed source integrity mismatch: ${sourcePath}`);
    }
    const target = assertPackageTarget(
      path.join(snapshot, ...sourcePath.split('/')),
      `reviewed source snapshot ${sourcePath}`,
    );
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
}

async function acquireBuildLock(lockPath) {
  const deadline = Date.now() + 120_000;
  while (true) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({
          pid: process.pid,
          started_at: new Date().toISOString(),
        })}\n`, 'utf8');
      } catch (error) {
        await handle.close().catch(() => {});
        await rm(lockPath, { force: true }).catch(() => {});
        throw error;
      }
      return async () => {
        try {
          await handle.close();
        } finally {
          await rm(lockPath, { force: true });
        }
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) {
        throw new Error(
          'Hosted MCP build lock remained present; refusing to remove a potentially active or stale lock',
        );
      }
      await delay(25);
    }
  }
}

function packageNameFromInput(inputPath) {
  const parts = inputPath.split('/');
  const marker = parts.lastIndexOf('node_modules');
  if (marker < 0 || marker + 1 >= parts.length) return null;
  if (parts[marker + 1].startsWith('@')) return parts.slice(marker + 1, marker + 3).join('/');
  return parts[marker + 1];
}

async function findPackageRoot(inputPath, packageName) {
  const marker = inputPath.lastIndexOf('/node_modules/');
  const rootRelative = inputPath.slice(0, marker + '/node_modules/'.length) + packageName;
  const absolute = path.resolve(repositoryRoot, ...rootRelative.split('/'));
  const packageJson = path.join(absolute, 'package.json');
  await stat(packageJson);
  return { absolute, packageJson, relative: repoRelative(absolute) };
}

async function buildThirdPartyNotices(inputPaths) {
  const packageNames = [...new Set(inputPaths.map(packageNameFromInput).filter(Boolean))]
    .sort(compareOrdinal);
  assertOrdinalUnique(packageNames, 'Third-party notice package inventory');
  const notices = [];
  const noticeInputs = [];
  const noticeSources = [];
  for (const packageName of packageNames) {
    const matchingInput = inputPaths.find((input) => packageNameFromInput(input) === packageName);
    const packageRootInfo = await findPackageRoot(matchingInput, packageName);
    const packageBytes = await readFile(packageRootInfo.packageJson);
    const pkg = JSON.parse(packageBytes.toString('utf8'));
    noticeInputs.push({
      path: repoRelative(packageRootInfo.packageJson),
      source: 'workspace_dependency',
      bytes: packageBytes.byteLength,
      sha256: sha256(packageBytes),
    });
    const version = typeof pkg.version === 'string' ? pkg.version : 'unknown';
    const declaredLicense = typeof pkg.license === 'string' ? pkg.license : 'see bundled source';
    let licenseRecord = null;
    const licenseEntry = selectStandaloneLicenseEntry(
      await readdir(packageRootInfo.absolute, { withFileTypes: true }),
      pkg.name ?? packageName,
      version,
    );
    if (licenseEntry) {
      const licensePath = path.join(packageRootInfo.absolute, licenseEntry);
      const bytes = await readFile(licensePath);
      const text = bytes.toString('utf8').replace(/\r\n?/g, '\n').trim();
      if (text.length === 0 || text.includes('\u0000') || text.includes('\uFFFD')) {
        throw new Error(`${pkg.name ?? packageName}@${version} has an invalid standalone license file`);
      }
      licenseRecord = {
        method: 'standalone_license_file',
        path: repoRelative(licensePath),
        sourceBytes: bytes,
        text,
      };
      noticeInputs.push({
        path: licenseRecord.path,
        source: 'workspace_dependency',
        bytes: bytes.byteLength,
        sha256: sha256(bytes),
      });
    }
    if (!licenseRecord) {
      const fallback = getCompleteReadmeLicenseFallback(pkg.name ?? packageName, version);
      if (!fallback) {
        throw new Error(
          `${pkg.name ?? packageName}@${version} has no standalone license file or reviewed complete README fallback`,
        );
      }
      const readmePath = path.join(packageRootInfo.absolute, fallback.file);
      let readmeBytes;
      try {
        readmeBytes = await readFile(readmePath);
      } catch (error) {
        if (error?.code === 'ENOENT') {
          throw new Error(`${pkg.name ?? packageName}@${version} reviewed README license source is missing`);
        }
        throw error;
      }
      const extracted = extractCompleteReadmeLicense({
        bytes: readmeBytes,
        packageName: pkg.name ?? packageName,
        version,
        declaredLicense,
      });
      licenseRecord = {
        method: extracted.method,
        path: repoRelative(readmePath),
        sourceBytes: readmeBytes,
        text: extracted.text,
      };
      noticeInputs.push({
        path: licenseRecord.path,
        source: 'workspace_dependency',
        bytes: readmeBytes.byteLength,
        sha256: sha256(readmeBytes),
      });
    }
    const noticeBytes = Buffer.from(licenseRecord.text, 'utf8');
    const sourceSha256 = sha256(licenseRecord.sourceBytes);
    const noticeSha256 = sha256(noticeBytes);
    noticeSources.push({
      package: pkg.name ?? packageName,
      version,
      declared_license: declaredLicense,
      method: licenseRecord.method,
      path: licenseRecord.path,
      source_bytes: licenseRecord.sourceBytes.byteLength,
      source_sha256: sourceSha256,
      notice_bytes: noticeBytes.byteLength,
      notice_sha256: noticeSha256,
    });
    notices.push([
      `${pkg.name ?? packageName}@${version}`,
      `Declared license: ${declaredLicense}`,
      `Notice source: ${licenseRecord.path}`,
      `Notice source method: ${licenseRecord.method}`,
      `Notice source bytes: ${licenseRecord.sourceBytes.byteLength}`,
      `Notice source SHA-256: ${sourceSha256}`,
      `Extracted notice bytes: ${noticeBytes.byteLength}`,
      `Extracted notice SHA-256: ${noticeSha256}`,
      licenseRecord.text,
    ].join('\n'));
  }
  assertOrdinalUnique(
    noticeSources.map((source) => source.package),
    'Third-party notice source inventory',
  );
  return {
    text: `${[
      'THIRD-PARTY NOTICES',
      '',
      'This file is generated deterministically from the exact packages bundled into dist/runtime/index.mjs.',
      '',
      ...notices.flatMap((notice) => ['='.repeat(72), notice, '']),
    ].join('\n').trim()}\n`,
    inputs: noticeInputs,
    sources: noticeSources,
  };
}

assertStaticBuildContract();
const buildRoot = assertPackageTarget(path.join(packageRoot, '.build'), 'build root');
await mkdir(buildRoot, { recursive: true });
const buildLockPath = assertPackageTarget(
  path.join(buildRoot, 'build.lock'),
  'build lock',
);
const releaseBuildLock = await acquireBuildLock(buildLockPath);
try {
const reviewedSources = await loadReviewedSourceRecords();
const sourceAttestation = reviewedSourceAttestation(reviewedSources);
await materializeReviewedSources(reviewedSources, snapshotRoot);

const packageJsonPath = path.join(packageRoot, 'package.json');
const mcpPackagePath = path.join(snapshotMcpRoot, 'package.json');
const riskForkPackagePath = path.join(snapshotRiskForkRoot, 'package.json');
const ownPackage = JSON.parse(await readFile(packageJsonPath, 'utf8'));
const mcpPackage = JSON.parse(await readFile(mcpPackagePath, 'utf8'));
const riskForkPackage = JSON.parse(await readFile(riskForkPackagePath, 'utf8'));

if (JSON.stringify(ownPackage) !== JSON.stringify(EXPECTED_PACKAGE_JSON)) {
  throw new Error('Hosted MCP package.json does not match the exact reviewed package contract');
}
if (mcpPackage.name !== EXPECTED_SOURCES.mcp.name
  || mcpPackage.version !== EXPECTED_SOURCES.mcp.version
  || riskForkPackage.name !== EXPECTED_SOURCES.risk_fork.name
  || riskForkPackage.version !== EXPECTED_SOURCES.risk_fork.version) {
  throw new Error('Hosted MCP bundle sources do not match the reviewed exact source contract');
}

const esbuild = require(resolveBuildPackage('esbuild'));
if (esbuild.version !== '0.28.1') {
  throw new Error(`Expected esbuild 0.28.1, received ${esbuild.version}`);
}

const entryPoint = path.join(packageRoot, 'src', 'index.mjs');
const result = await esbuild.build({
  absWorkingDir: repositoryRoot,
  entryPoints: [entryPoint],
  bundle: true,
  banner: {
    js: "import { createRequire as __agoragenticCreateRequire } from 'node:module'; const require = __agoragenticCreateRequire(import.meta.url);",
  },
  charset: 'utf8',
  define: {
    __AGORAGENTIC_REVIEWED_SOURCE_INTEGRITY__: JSON.stringify(sourceAttestation.sha256),
  },
  external: ['e2b'],
  format: 'esm',
  legalComments: 'eof',
  logLevel: 'silent',
  mainFields: ['module', 'main'],
  metafile: true,
  nodePaths: [packageNodeModules, path.join(mcpRoot, 'node_modules'), path.join(riskForkRoot, 'node_modules')],
  outdir: path.join(packageRoot, 'dist', 'runtime'),
  platform: 'node',
  plugins: [{
    name: 'pin-reviewed-upstream-and-disable-unreviewed-optional-pg-native',
    setup(build) {
      build.onResolve({ filter: /^\.\.?\// }, (args) => {
        const resolved = path.resolve(args.resolveDir, args.path);
        const mappings = [
          [mcpRoot, snapshotMcpRoot],
          [riskForkRoot, snapshotRiskForkRoot],
          [transactionAssuranceRoot, path.join(snapshotRoot, 'transaction-assurance')],
        ];
        for (const [sourceRoot, reviewedRoot] of mappings) {
          const nodeModulesRoot = path.join(sourceRoot, 'node_modules');
          if ((resolved === sourceRoot || inside(sourceRoot, resolved))
            && !(resolved === nodeModulesRoot || inside(nodeModulesRoot, resolved))) {
            return { path: path.join(reviewedRoot, path.relative(sourceRoot, resolved)) };
          }
        }
        return null;
      });
      build.onResolve({ filter: /^pg-native$/ }, () => ({
        path: path.join(packageRoot, 'src', 'pg-native-disabled.js'),
      }));
    },
  }],
  sourcemap: false,
  splitting: false,
  target: ['node20'],
  treeShaking: true,
  write: false,
});

if (result.outputFiles.length !== 1) throw new Error('Expected one self-contained hosted MCP bundle');
const output = result.outputFiles[0];
const outputMeta = Object.values(result.metafile.outputs)[0];
const allowedBuiltins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
const allowedOptionalPeers = new Set(['e2b']);
const unsafeExternal = (outputMeta.imports ?? []).filter((entry) => (
  entry.external && !allowedBuiltins.has(entry.path) && !allowedOptionalPeers.has(entry.path)
));
if (unsafeExternal.length > 0) {
  throw new Error(`Bundle retains non-builtin runtime imports: ${unsafeExternal.map((item) => item.path).join(', ')}`);
}
const externalImports = [...new Set(
  (outputMeta.imports ?? []).filter((entry) => entry.external).map((entry) => entry.path),
)].sort(compareOrdinal);
assertOrdinalUnique(externalImports, 'External import inventory');
if (!externalImports.includes('e2b')) {
  throw new Error('Bundle does not retain the exact optional e2b peer import');
}

const metafileInputPaths = Object.keys(result.metafile.inputs)
  .map((input) => portable(input))
  .sort(compareOrdinal);
assertOrdinalUnique(metafileInputPaths, 'Esbuild input inventory', { paths: true });
const upstreamInputs = [];
for (const input of metafileInputPaths) {
  const absolute = path.resolve(repositoryRoot, ...input.split('/'));
  const bytes = await readFile(absolute);
  const reviewedSource = snapshotSourcePath(snapshotRoot, absolute);
  upstreamInputs.push({
    path: reviewedSource ?? repoRelative(absolute),
    source: reviewedSource
      ? 'reviewed_source'
      : input.includes('/node_modules/')
        ? 'workspace_dependency'
        : 'package_source',
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
  });
}

const reviewedAssets = [];
for (const mapping of PACKAGED_REVIEWED_ASSETS) {
  const sourcePath = path.join(snapshotRoot, ...mapping.source.split('/'));
  const content = await readFile(sourcePath);
  const integrity = sha256(content);
  upstreamInputs.push({
    path: mapping.source,
    source: 'reviewed_source',
    bytes: content.byteLength,
    sha256: integrity,
  });
  reviewedAssets.push({
    path: mapping.target,
    source_path: mapping.source,
    bytes: content.byteLength,
    sha256: integrity,
    content,
  });
}

const notices = await buildThirdPartyNotices(metafileInputPaths);
upstreamInputs.push(...notices.inputs);
const reviewedSourcePaths = new Set(reviewedSources.map((record) => record.path));
const inputs = mergeExactInputRecords(upstreamInputs, reviewedSourcePaths);

const distPath = assertPackageTarget(
  path.join(packageRoot, ...EXPECTED_ARTIFACT_PATH.split('/')),
  'bundle path',
);
const noticesPath = assertPackageTarget(
  path.join(packageRoot, THIRD_PARTY_NOTICES_PATH),
  'notices path',
);
for (const directory of ['e2b-context', 'migrations', 'ops', 'schema']) {
  await rm(assertPackageTarget(path.join(packageRoot, directory), `${directory} asset root`), {
    recursive: true,
    force: true,
  });
}
await mkdir(path.dirname(distPath), { recursive: true });
await writeFile(distPath, output.contents);
for (const asset of reviewedAssets) {
  const target = assertPackageTarget(path.join(packageRoot, ...asset.path.split('/')), 'reviewed asset');
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, asset.content);
}
await writeFile(noticesPath, notices.text, 'utf8');

const noticeBytes = Buffer.from(notices.text, 'utf8');
const packagedAssets = [
  ...reviewedAssets.map(({ content: _content, ...record }) => record),
  {
    path: THIRD_PARTY_NOTICES_PATH,
    bytes: noticeBytes.byteLength,
    sha256: sha256(noticeBytes),
  },
].sort((left, right) => compareOrdinal(left.path, right.path));
assertOrdinalUnique(
  packagedAssets.map((record) => record.path),
  'Packaged asset inventory',
  { paths: true },
);
const expectedPackagedAssetPaths = [
  THIRD_PARTY_NOTICES_PATH,
  ...PACKAGED_REVIEWED_ASSETS.map((mapping) => mapping.target),
].sort(compareOrdinal);
if (JSON.stringify(packagedAssets.map((record) => record.path))
  !== JSON.stringify(expectedPackagedAssetPaths)) {
  throw new Error('Packaged assets do not match the exact reviewed target contract');
}
const manifest = {
  schema: INTEGRITY_MANIFEST_SCHEMA,
  package: {
    name: EXPECTED_PACKAGE_JSON.name,
    version: EXPECTED_PACKAGE_JSON.version,
    private: true,
  },
  source_attestation: sourceAttestation,
  reviewed_sources: reviewedSources,
  sources: {
    mcp: { ...EXPECTED_SOURCES.mcp },
    risk_fork: { ...EXPECTED_SOURCES.risk_fork },
  },
  build: {
    builder: `esbuild@${esbuild.version}`,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    transforms: [...EXPECTED_BUILD_TRANSFORMS],
    external_imports: externalImports,
  },
  runtime_dependencies: [],
  optional_peer_dependencies: [
    { name: 'e2b', version: '2.39.0', optional: true },
  ],
  exports: [...EXPECTED_EXPORTS],
  inputs,
  third_party_notices: {
    path: THIRD_PARTY_NOTICES_PATH,
    bytes: noticeBytes.byteLength,
    sha256: sha256(noticeBytes),
    sources: notices.sources,
  },
  artifact: {
    path: EXPECTED_ARTIFACT_PATH,
    bytes: output.contents.byteLength,
    sha256: sha256(output.contents),
  },
  packaged_assets: packagedAssets,
};
assertGeneratedManifestContract(manifest, sourceAttestation);
const manifestPath = assertPackageTarget(path.join(packageRoot, 'integrity-manifest.json'), 'manifest path');
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
} finally {
  try {
    await rm(snapshotRoot, { recursive: true, force: true });
  } finally {
    await releaseBuildLock();
  }
}
