import { createHash } from 'node:crypto';
import {
  lstat,
  readFile,
  readdir,
  realpath,
} from 'node:fs/promises';
import { builtinModules, createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TextDecoder } from 'node:util';

const packageRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const repositoryRoot = path.resolve(packageRoot, '..');
const mcpRoot = path.join(repositoryRoot, 'mcp');
const riskForkRoot = path.join(repositoryRoot, 'risk-fork');
const transactionAssuranceRoot = path.join(repositoryRoot, 'transaction-assurance');
const snapshotRoot = path.join(packageRoot, '.build', 'upstream');
const snapshotMcpRoot = path.join(snapshotRoot, 'mcp');
const snapshotRiskForkRoot = path.join(snapshotRoot, 'risk-fork');
const snapshotTransactionAssuranceRoot = path.join(snapshotRoot, 'transaction-assurance');
const packageNodeModules = path.join(packageRoot, 'node_modules');
const sourceResolutionRoots = Object.freeze([packageRoot, mcpRoot, riskForkRoot]);
const sourceRequire = createRequire(import.meta.url);
const INTEGRITY_MANIFEST_SCHEMA = 'agoragentic.risk-fork-hosted-mcp.integrity.v2';
const REVIEWED_SOURCE_ATTESTATION_SCHEMA = 'agoragentic.risk-fork-hosted-mcp.reviewed-sources.v2';
const REVIEWED_SOURCE_NORMALIZATION = 'utf8_crlf_to_lf_lone_cr_preserved';
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
  'verifyE2BQualificationTrust',
  'verifyExecutionBinding',
  'verifyPostgresAuthorityClientTransport',
  'verifyPostgresDistributedAuthoritySchema',
  'verifyRiskDecision',
  'verifySavepointCapsule',
]);
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
  { source: 'risk-fork/e2b-template/bin/boot-guard.mjs', target: 'e2b-context/risk-fork/e2b-template/bin/boot-guard.mjs' },
  { source: 'risk-fork/e2b-template/bin/bootstrap.mjs', target: 'e2b-context/risk-fork/e2b-template/bin/bootstrap.mjs' },
  { source: 'risk-fork/e2b-template/bin/run.mjs', target: 'e2b-context/risk-fork/e2b-template/bin/run.mjs' },
  { source: 'risk-fork/e2b-template/lib/runtime-contract.mjs', target: 'e2b-context/risk-fork/e2b-template/lib/runtime-contract.mjs' },
  { source: 'risk-fork/e2b-template/template.mjs', target: 'e2b-context/risk-fork/e2b-template/template.mjs' },
  { source: 'risk-fork/src/canonical.mjs', target: 'e2b-context/risk-fork/src/canonical.mjs' },
  { source: 'risk-fork/src/child-operation.mjs', target: 'e2b-context/risk-fork/src/child-operation.mjs' },
  { source: 'risk-fork/src/util.mjs', target: 'e2b-context/risk-fork/src/util.mjs' },
  { source: 'transaction-assurance/src/canonical.mjs', target: 'e2b-context/transaction-assurance/src/canonical.mjs' },
  { source: 'risk-fork/migrations/001_distributed_authority.pg.sql', target: 'migrations/001_distributed_authority.pg.sql' },
  { source: 'risk-fork/ops/postgres/owner-bootstrap.sql.template', target: 'ops/postgres/owner-bootstrap.sql.template' },
  { source: 'risk-fork/ops/postgres/roles.sql.template', target: 'ops/postgres/roles.sql.template' },
  { source: 'risk-fork/schema/e2b-qualification-evidence.v1.json', target: 'schema/e2b-qualification-evidence.v1.json' },
]);
const PACKAGED_PHYSICAL_ROOTS = Object.freeze([
  'dist/runtime',
  'e2b-context',
  'migrations',
  'ops/postgres',
  'schema',
]);

function parseExactFlags(args, allowedFlags) {
  const seen = new Set();
  for (const argument of args) {
    if (!allowedFlags.has(argument) || seen.has(argument)) {
      throw new Error(`Unsupported hosted MCP integrity arguments: ${args.join(' ')}`);
    }
    seen.add(argument);
  }
  return seen;
}

const verifyFlags = parseExactFlags(process.argv.slice(2), new Set(['--quiet', '--source']));
const verifySources = verifyFlags.has('--source');
const quiet = verifyFlags.has('--quiet');

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

function insideOrEqual(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function inside(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative !== ''
    && !relative.startsWith(`..${path.sep}`)
    && relative !== '..'
    && !path.isAbsolute(relative);
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

function isReviewedSourcePath(relativePath) {
  return isCanonicalRepositoryPath(relativePath)
    && (REVIEWED_SOURCE_EXACT_FILES.includes(relativePath)
      || REVIEWED_SOURCE_RECURSIVE_ROOTS.some((root) => relativePath.startsWith(`${root}/`)));
}

async function assertSafePathComponents(base, relativePath, expectedType, label) {
  const resolved = resolveBelow(base, relativePath, label);
  const baseStat = await lstat(base);
  if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) {
    throw new Error(`${label} root is not a real directory`);
  }
  const realBase = await realpath(base);
  if (!sameFilesystemPath(realBase, base)) {
    throw new Error(`${label} root traverses a symlink or reparse point`);
  }
  let current = base;
  const segments = relativePath.split('/');
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    const componentStat = await lstat(current);
    if (componentStat.isSymbolicLink()) {
      throw new Error(`${label} traverses a symlink or reparse point: ${relativePath}`);
    }
    const componentRealPath = await realpath(current);
    const expectedRealPath = path.join(realBase, ...segments.slice(0, index + 1));
    if (!insideOrEqual(realBase, componentRealPath)
      || !sameFilesystemPath(componentRealPath, expectedRealPath)) {
      throw new Error(`${label} escapes its real verification root: ${relativePath}`);
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

async function listRegularReviewedFiles(relativeRoot) {
  const root = await assertSafePathComponents(
    repositoryRoot,
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
        const absolutePath = await assertSafePathComponents(
          repositoryRoot,
          relativePath,
          'directory',
          'reviewed source directory',
        );
        await walk(absolutePath, relativePath);
      } else if (entry.isFile()) {
        await assertSafePathComponents(repositoryRoot, relativePath, 'file', 'reviewed source');
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
    paths.push(...await listRegularReviewedFiles(relativeRoot));
  }
  const sorted = paths.sort(compareOrdinal);
  assertOrdinalUnique(sorted, 'Reviewed source path inventory', { paths: true });
  for (const relativePath of sorted) {
    if (!isReviewedSourcePath(relativePath)) {
      throw new Error(`Discovered source is outside the reviewed inventory: ${relativePath}`);
    }
    await assertSafePathComponents(repositoryRoot, relativePath, 'file', 'reviewed source');
  }
  return sorted;
}

function validateReviewedSourceRecords(records) {
  if (!Array.isArray(records) || records.length < 10) {
    throw new Error('Reviewed source digest inventory is unexpectedly incomplete');
  }
  const normalized = records.map((record, index) => {
    assertExactKeys(record, ['path', 'bytes', 'sha256'], `Reviewed source digest record ${index}`);
    if (!isReviewedSourcePath(record.path)
      || !Number.isSafeInteger(record.bytes)
      || record.bytes <= 0
      || !/^sha256:[a-f0-9]{64}$/.test(record.sha256 ?? '')) {
      throw new Error(`Reviewed source digest record ${index} is invalid`);
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
  return {
    schema: REVIEWED_SOURCE_ATTESTATION_SCHEMA,
    normalization: REVIEWED_SOURCE_NORMALIZATION,
    files: records.length,
    sha256: sha256(canonical),
  };
}

function resolveBelow(base, relative, label) {
  if (!isCanonicalRepositoryPath(relative)) {
    throw new Error(`${label} path is not canonical: ${String(relative)}`);
  }
  const resolved = path.resolve(base, ...relative.split('/'));
  const back = path.relative(base, resolved);
  if (back === '' || back === '..' || back.startsWith(`..${path.sep}`) || path.isAbsolute(back)) {
    throw new Error(`${label} escapes its verification root`);
  }
  return resolved;
}

function portable(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function repoRelative(absolutePath) {
  const relative = path.relative(repositoryRoot, absolutePath);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)) {
    throw new Error(`Independently derived build input escapes the repository: ${absolutePath}`);
  }
  const canonical = portable(relative);
  if (!isCanonicalRepositoryPath(canonical)) {
    throw new Error(`Independently derived build input path is not canonical: ${canonical}`);
  }
  return canonical;
}

function snapshotSourcePath(absolutePath) {
  const relative = path.relative(snapshotRoot, absolutePath);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)) return null;
  const canonical = portable(relative);
  return isCanonicalRepositoryPath(canonical) ? canonical : null;
}

function reviewedSnapshotPath(absolutePath) {
  const mappings = [
    [mcpRoot, snapshotMcpRoot],
    [riskForkRoot, snapshotRiskForkRoot],
    [transactionAssuranceRoot, snapshotTransactionAssuranceRoot],
  ];
  for (const [sourceRoot, reviewedRoot] of mappings) {
    const nodeModulesRoot = path.join(sourceRoot, 'node_modules');
    if ((sameFilesystemPath(absolutePath, sourceRoot) || inside(sourceRoot, absolutePath))
      && !(sameFilesystemPath(absolutePath, nodeModulesRoot) || inside(nodeModulesRoot, absolutePath))) {
      return path.join(reviewedRoot, path.relative(sourceRoot, absolutePath));
    }
  }
  return null;
}

function esbuildLoaderForReviewedPath(relativePath) {
  const extension = path.posix.extname(relativePath);
  if (extension === '.json') return 'json';
  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') return 'js';
  throw new Error('Independently bundled reviewed source has an unsupported loader');
}

function resolveSourceBuildPackage(specifier) {
  for (const root of sourceResolutionRoots) {
    const nodeModulesRoot = path.join(root, 'node_modules');
    try {
      const resolved = sourceRequire.resolve(specifier, { paths: [root] });
      if (inside(nodeModulesRoot, resolved)) return resolved;
    } catch (error) {
      if (error?.code !== 'MODULE_NOT_FOUND') throw error;
    }
  }
  throw new Error(`Missing exact source-verification build dependency: ${specifier}`);
}

function packageNameFromInput(inputPath) {
  const parts = inputPath.split('/');
  const marker = parts.lastIndexOf('node_modules');
  if (marker < 0 || marker + 1 >= parts.length) return null;
  if (parts[marker + 1].startsWith('@')) {
    if (marker + 2 >= parts.length) {
      throw new Error(`Invalid scoped package build input: ${inputPath}`);
    }
    return parts.slice(marker + 1, marker + 3).join('/');
  }
  return parts[marker + 1];
}

function sourcePackageRootRelative(inputPath, packageName) {
  const marker = inputPath.lastIndexOf('/node_modules/');
  if (marker < 0) throw new Error(`Build input does not identify a package root: ${inputPath}`);
  return inputPath.slice(0, marker + '/node_modules/'.length) + packageName;
}

async function findSourcePackageRoot(inputPath, packageName) {
  const rootRelative = sourcePackageRootRelative(inputPath, packageName);
  const absolute = await assertSafePathComponents(
    repositoryRoot,
    rootRelative,
    'directory',
    `third-party package ${packageName}`,
  );
  const packageJsonRelative = `${rootRelative}/package.json`;
  const packageJson = await assertSafePathComponents(
    repositoryRoot,
    packageJsonRelative,
    'file',
    `third-party package ${packageName}`,
  );
  return { absolute, packageJson, packageJsonRelative, rootRelative };
}

async function independentlyDeriveNoticeClosure(metafileInputPaths) {
  const licenseHelpersPath = await assertSafePathComponents(
    packageRoot,
    'scripts/license-notices.mjs',
    'file',
    'source-verification license helpers',
  );
  const {
    extractCompleteReadmeLicense,
    getCompleteReadmeLicenseFallback,
    selectStandaloneLicenseEntry,
  } = await import(pathToFileURL(licenseHelpersPath).href);
  const packageInputByName = new Map();
  for (const inputPath of metafileInputPaths) {
    const packageName = packageNameFromInput(inputPath);
    if (packageName === null) continue;
    const rootRelative = sourcePackageRootRelative(inputPath, packageName);
    const existing = packageInputByName.get(packageName);
    if (existing !== undefined && existing.rootRelative !== rootRelative) {
      throw new Error('Multiple package roots for one bundled dependency name are not allowed');
    }
    if (existing === undefined) packageInputByName.set(packageName, { inputPath, rootRelative });
  }
  const packageNames = [...packageInputByName.keys()].sort(compareOrdinal);
  assertOrdinalUnique(packageNames, 'Independently derived third-party package inventory');

  const inputPaths = [];
  const notices = [];
  const sources = [];
  for (const packageName of packageNames) {
    const matchingInput = packageInputByName.get(packageName).inputPath;
    const packageRootInfo = await findSourcePackageRoot(matchingInput, packageName);
    const packageBytes = await readFile(packageRootInfo.packageJson);
    const pkg = JSON.parse(packageBytes.toString('utf8'));
    const packageIdentity = pkg.name ?? packageName;
    const version = typeof pkg.version === 'string' ? pkg.version : 'unknown';
    const declaredLicense = typeof pkg.license === 'string' ? pkg.license : 'see bundled source';
    inputPaths.push(packageRootInfo.packageJsonRelative);

    let licenseRecord = null;
    const licenseEntry = selectStandaloneLicenseEntry(
      await readdir(packageRootInfo.absolute, { withFileTypes: true }),
      packageIdentity,
      version,
    );
    if (licenseEntry) {
      const licenseRelative = `${packageRootInfo.rootRelative}/${licenseEntry}`;
      const licensePath = await assertSafePathComponents(
        repositoryRoot,
        licenseRelative,
        'file',
        `third-party notice source ${packageIdentity}`,
      );
      const bytes = await readFile(licensePath);
      const text = bytes.toString('utf8').replace(/\r\n?/g, '\n').trim();
      if (text.length === 0 || text.includes('\u0000') || text.includes('\uFFFD')) {
        throw new Error(`${packageIdentity}@${version} has an invalid standalone license file`);
      }
      licenseRecord = {
        method: 'standalone_license_file',
        path: licenseRelative,
        sourceBytes: bytes,
        text,
      };
    } else {
      const fallback = getCompleteReadmeLicenseFallback(packageIdentity, version);
      if (!fallback) {
        throw new Error(
          `${packageIdentity}@${version} has no standalone license file or reviewed complete README fallback`,
        );
      }
      const readmeRelative = `${packageRootInfo.rootRelative}/${fallback.file}`;
      const readmePath = await assertSafePathComponents(
        repositoryRoot,
        readmeRelative,
        'file',
        `third-party notice source ${packageIdentity}`,
      );
      const readmeBytes = await readFile(readmePath);
      const extracted = extractCompleteReadmeLicense({
        bytes: readmeBytes,
        packageName: packageIdentity,
        version,
        declaredLicense,
      });
      licenseRecord = {
        method: extracted.method,
        path: readmeRelative,
        sourceBytes: readmeBytes,
        text: extracted.text,
      };
    }

    inputPaths.push(licenseRecord.path);
    const noticeBytes = Buffer.from(licenseRecord.text, 'utf8');
    const sourceRecord = {
      package: packageIdentity,
      version,
      declared_license: declaredLicense,
      method: licenseRecord.method,
      path: licenseRecord.path,
      source_bytes: licenseRecord.sourceBytes.byteLength,
      source_sha256: sha256(licenseRecord.sourceBytes),
      notice_bytes: noticeBytes.byteLength,
      notice_sha256: sha256(noticeBytes),
    };
    sources.push(sourceRecord);
    notices.push([
      `${sourceRecord.package}@${sourceRecord.version}`,
      `Declared license: ${sourceRecord.declared_license}`,
      `Notice source: ${sourceRecord.path}`,
      `Notice source method: ${sourceRecord.method}`,
      `Notice source bytes: ${sourceRecord.source_bytes}`,
      `Notice source SHA-256: ${sourceRecord.source_sha256}`,
      `Extracted notice bytes: ${sourceRecord.notice_bytes}`,
      `Extracted notice SHA-256: ${sourceRecord.notice_sha256}`,
      licenseRecord.text,
    ].join('\n'));
  }
  assertOrdinalUnique(
    sources.map((source) => source.package),
    'Independently derived third-party notice source inventory',
  );
  assertCaseFoldUnique(inputPaths, 'Independently derived third-party notice input paths');
  const contents = Buffer.from(`${[
    'THIRD-PARTY NOTICES',
    '',
    'This file is generated deterministically from the exact packages bundled into dist/runtime/index.mjs.',
    '',
    ...notices.flatMap((notice) => ['='.repeat(72), notice, '']),
  ].join('\n').trim()}\n`, 'utf8');
  return {
    artifact: {
      bytes: contents.byteLength,
      contents,
      sha256: sha256(contents),
    },
    inputPaths,
    sources,
  };
}

async function independentlyDeriveBuildInputClosure(sourceAttestation, reviewedSourceByPath) {
  const esbuildPath = resolveSourceBuildPackage('esbuild');
  const esbuildRelative = repoRelative(esbuildPath);
  await assertSafePathComponents(
    repositoryRoot,
    esbuildRelative,
    'file',
    'source-verification esbuild dependency',
  );
  const esbuild = sourceRequire(esbuildPath);
  if (esbuild.version !== '0.28.1') {
    throw new Error(`Expected source-verification esbuild 0.28.1, received ${esbuild.version}`);
  }

  const entryPoint = await assertSafePathComponents(
    repositoryRoot,
    EXPECTED_PACKAGE_SOURCE_PATHS[0],
    'file',
    'source-verification entry point',
  );
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
    nodePaths: [
      packageNodeModules,
      path.join(mcpRoot, 'node_modules'),
      path.join(riskForkRoot, 'node_modules'),
    ],
    outdir: path.join(packageRoot, 'dist', 'runtime'),
    platform: 'node',
    plugins: [{
      name: 'independently-verify-canonical-inputs-and-disable-pg-native',
      setup(build) {
        build.onResolve({ filter: /^pg-native$/ }, () => ({
          path: path.join(packageRoot, 'src', 'pg-native-disabled.js'),
        }));
        build.onResolve({ filter: /^\.\.?\// }, (args) => {
          const resolved = path.resolve(args.resolveDir, args.path);
          const reviewedSnapshot = reviewedSnapshotPath(resolved);
          if (reviewedSnapshot !== null) return { path: reviewedSnapshot };
          if (snapshotSourcePath(resolved) !== null) return { path: resolved };
          return undefined;
        });
        build.onResolve({ filter: /^[A-Za-z@]/ }, async (args) => {
          if (args.pluginData?.independentlyPinnedHostedDependency === true
            || args.path === 'e2b'
            || builtinModules.includes(args.path)
            || (args.path.startsWith('node:') && builtinModules.includes(args.path.slice(5)))) {
            return undefined;
          }
          const importer = args.importer === '' ? null : path.resolve(args.importer);
          if (importer === null || ![
            mcpRoot,
            riskForkRoot,
            snapshotRoot,
            transactionAssuranceRoot,
          ].some((root) => insideOrEqual(root, importer))) {
            return undefined;
          }
          return build.resolve(args.path, {
            kind: args.kind,
            pluginData: { independentlyPinnedHostedDependency: true },
            resolveDir: packageRoot,
          });
        });
        build.onLoad({ filter: /.*/ }, async (args) => {
          const absolutePath = path.resolve(args.path);
          const reviewedSourcePath = snapshotSourcePath(absolutePath);
          if (reviewedSourcePath !== null) {
            const reviewedRecord = reviewedSourceByPath.get(reviewedSourcePath);
            if (reviewedRecord === undefined) {
              throw new Error('Independently bundled snapshot input is outside the reviewed source closure');
            }
            const resolvedSource = await assertSafePathComponents(
              repositoryRoot,
              reviewedSourcePath,
              'file',
              'independently bundled reviewed source',
            );
            const contents = canonicalReviewedSourceBytes(
              await readFile(resolvedSource),
              reviewedSourcePath,
            );
            if (contents.byteLength !== reviewedRecord.bytes
              || sha256(contents) !== reviewedRecord.sha256) {
              throw new Error('Independently bundled reviewed source changed during verification');
            }
            return {
              contents,
              loader: esbuildLoaderForReviewedPath(reviewedSourcePath),
              resolveDir: path.dirname(absolutePath),
            };
          }
          const relativePath = repoRelative(absolutePath);
          await assertSafePathComponents(
            repositoryRoot,
            relativePath,
            'file',
            'independently derived esbuild input',
          );
          return undefined;
        });
      },
    }],
    sourcemap: false,
    splitting: false,
    target: ['node20'],
    treeShaking: true,
    write: false,
  });
  if (result.outputFiles.length !== 1) {
    throw new Error('Expected one independently derived hosted MCP bundle');
  }
  const outputMetadata = Object.values(result.metafile.outputs);
  if (outputMetadata.length !== 1) {
    throw new Error('Expected one independently derived hosted MCP output metadata record');
  }
  const externalImports = [...new Set(
    (outputMetadata[0].imports ?? [])
      .filter((entry) => entry.external)
      .map((entry) => entry.path),
  )].sort(compareOrdinal);
  assertOrdinalUnique(externalImports, 'Independently derived external import inventory');

  const metafileInputPaths = Object.keys(result.metafile.inputs).map((inputPath) => {
    const portableInputPath = portable(inputPath);
    const absolutePath = path.isAbsolute(inputPath)
      ? path.resolve(inputPath)
      : path.resolve(repositoryRoot, ...portableInputPath.split('/'));
    return snapshotSourcePath(absolutePath) ?? repoRelative(absolutePath);
  }).sort(compareOrdinal);
  assertOrdinalUnique(
    metafileInputPaths,
    'Independently derived esbuild input inventory',
    { paths: true },
  );
  for (const inputPath of metafileInputPaths) {
    if (expectedInputSource(inputPath, reviewedSourceByPath) === null) {
      throw new Error(`Independently derived build input is outside the exact contract: ${inputPath}`);
    }
    await assertSafePathComponents(
      repositoryRoot,
      inputPath,
      'file',
      'independently derived esbuild input',
    );
  }

  const notices = await independentlyDeriveNoticeClosure(metafileInputPaths);
  const paths = [...new Set([
    ...metafileInputPaths,
    ...PACKAGED_REVIEWED_ASSETS.map((mapping) => mapping.source),
    ...notices.inputPaths,
  ])].sort(compareOrdinal);
  assertOrdinalUnique(paths, 'Independently derived build input closure', { paths: true });
  for (const inputPath of paths) {
    if (expectedInputSource(inputPath, reviewedSourceByPath) === null) {
      throw new Error(`Independently justified input is outside the exact contract: ${inputPath}`);
    }
  }
  return {
    artifact: {
      bytes: result.outputFiles[0].contents.byteLength,
      sha256: sha256(result.outputFiles[0].contents),
    },
    externalImports,
    noticeArtifact: notices.artifact,
    noticeSources: notices.sources,
    paths,
  };
}

async function verifyFile(base, record, label, { canonicalReviewedSource = false } = {}) {
  const resolved = await assertSafePathComponents(base, record.path, 'file', label);
  const rawBytes = await readFile(resolved);
  const bytes = canonicalReviewedSource
    ? canonicalReviewedSourceBytes(rawBytes, record.path)
    : rawBytes;
  if (bytes.byteLength !== record.bytes || sha256(bytes) !== record.sha256) {
    throw new Error(`${label} integrity mismatch: ${record.path}`);
  }
  return resolved;
}

function expectedInputSource(inputPath, reviewedSourceByPath) {
  if (reviewedSourceByPath.has(inputPath)) return 'reviewed_source';
  if (EXPECTED_PACKAGE_SOURCE_PATHS.includes(inputPath)) return 'package_source';
  if (inputPath.startsWith('risk-fork-hosted-mcp/node_modules/')) return 'workspace_dependency';
  return null;
}

function validateInputRecords(records, reviewedSourceByPath) {
  if (!Array.isArray(records)) throw new Error('Manifest inputs must be an array');
  for (let index = 0; index < records.length; index += 1) {
    const input = records[index];
    assertExactKeys(input, ['path', 'source', 'bytes', 'sha256'], `Manifest input ${index}`);
    const expectedSource = isCanonicalRepositoryPath(input.path)
      ? expectedInputSource(input.path, reviewedSourceByPath)
      : null;
    if (expectedSource === null
      || input.source !== expectedSource
      || !Number.isSafeInteger(input.bytes)
      || input.bytes <= 0
      || !/^sha256:[a-f0-9]{64}$/.test(input.sha256 ?? '')) {
      throw new Error(`Hosted MCP integrity input contract is invalid: ${String(input.path)}`);
    }
    if (input.source === 'reviewed_source') {
      const reviewed = reviewedSourceByPath.get(input.path);
      if (reviewed.bytes !== input.bytes || reviewed.sha256 !== input.sha256) {
        throw new Error(`Build input is not bound to the reviewed source inventory: ${input.path}`);
      }
    }
  }
  assertOrdinalUnique(records.map((record) => record.path), 'Manifest inputs', { paths: true });
  const packageSources = records
    .filter((record) => record.source === 'package_source')
    .map((record) => record.path);
  if (JSON.stringify(packageSources) !== JSON.stringify(EXPECTED_PACKAGE_SOURCE_PATHS)) {
    throw new Error('Manifest inputs do not contain the exact package source contract');
  }
}

function validateManifestContract(manifest, sourceAttestation, reviewedSourceByPath) {
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
    || JSON.stringify(manifest.source_attestation) !== JSON.stringify(sourceAttestation)
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
    || !Number.isSafeInteger(manifest.third_party_notices.bytes)
    || manifest.third_party_notices.bytes <= 0
    || !/^sha256:[a-f0-9]{64}$/.test(manifest.third_party_notices.sha256 ?? '')
    || manifest.artifact.path !== EXPECTED_ARTIFACT_PATH
    || !Number.isSafeInteger(manifest.artifact.bytes)
    || manifest.artifact.bytes <= 0
    || !/^sha256:[a-f0-9]{64}$/.test(manifest.artifact.sha256 ?? '')) {
    throw new Error('Hosted MCP integrity manifest contract is invalid');
  }

  const allowedExternalImports = new Set([
    ...builtinModules,
    ...builtinModules.map((name) => `node:${name}`),
    'e2b',
  ]);
  if (!Array.isArray(manifest.build.external_imports)
    || manifest.build.external_imports.some((specifier) => !allowedExternalImports.has(specifier))) {
    throw new Error('Hosted MCP bundle contains an unapproved external import');
  }
  assertOrdinalUnique(manifest.build.external_imports, 'Manifest external imports');
  if (!manifest.build.external_imports.includes('e2b')) {
    throw new Error('Hosted MCP bundle does not retain the exact optional e2b peer import');
  }

  validateInputRecords(manifest.inputs, reviewedSourceByPath);
  if (!Array.isArray(manifest.third_party_notices.sources)) {
    throw new Error('Third-party notice sources must be an array');
  }
  assertOrdinalUnique(
    manifest.third_party_notices.sources.map((source) => source.package),
    'Third-party notice source inventory',
  );
  assertCaseFoldUnique(
    manifest.third_party_notices.sources.map((source) => source.path),
    'Third-party notice source paths',
  );
  for (let index = 0; index < manifest.third_party_notices.sources.length; index += 1) {
    const source = manifest.third_party_notices.sources[index];
    assertExactKeys(source, [
      'package',
      'version',
      'declared_license',
      'method',
      'path',
      'source_bytes',
      'source_sha256',
      'notice_bytes',
      'notice_sha256',
    ], `Third-party notice source ${index}`);
    if (typeof source.package !== 'string' || source.package === ''
      || typeof source.version !== 'string' || source.version === ''
      || typeof source.declared_license !== 'string' || source.declared_license === ''
      || !/^(?:standalone_license_file|markdown_license_section)$/.test(source.method ?? '')
      || !isCanonicalRepositoryPath(source.path)
      || !Number.isSafeInteger(source.source_bytes) || source.source_bytes <= 0
      || !/^sha256:[a-f0-9]{64}$/.test(source.source_sha256 ?? '')
      || !Number.isSafeInteger(source.notice_bytes) || source.notice_bytes <= 0
      || !/^sha256:[a-f0-9]{64}$/.test(source.notice_sha256 ?? '')) {
      throw new Error(`Third-party notice source contract is invalid at index ${index}`);
    }
  }

  if (!Array.isArray(manifest.packaged_assets)) {
    throw new Error('Manifest packaged assets must be an array');
  }
  assertOrdinalUnique(
    manifest.packaged_assets.map((asset) => asset.path),
    'Manifest packaged assets',
    { paths: true },
  );
  const expectedAssetPaths = [
    THIRD_PARTY_NOTICES_PATH,
    ...PACKAGED_REVIEWED_ASSETS.map((mapping) => mapping.target),
  ].sort(compareOrdinal);
  if (JSON.stringify(manifest.packaged_assets.map((asset) => asset.path))
    !== JSON.stringify(expectedAssetPaths)) {
    throw new Error('Manifest packaged assets do not match the exact reviewed target contract');
  }
  const expectedAssetByPath = new Map(
    PACKAGED_REVIEWED_ASSETS.map((mapping) => [mapping.target, mapping.source]),
  );
  for (let index = 0; index < manifest.packaged_assets.length; index += 1) {
    const asset = manifest.packaged_assets[index];
    if (asset.path === THIRD_PARTY_NOTICES_PATH) {
      assertExactKeys(asset, ['path', 'bytes', 'sha256'], `Manifest packaged asset ${index}`);
    } else {
      assertExactKeys(
        asset,
        ['path', 'source_path', 'bytes', 'sha256'],
        `Manifest packaged asset ${index}`,
      );
      if (asset.source_path !== expectedAssetByPath.get(asset.path)) {
        throw new Error(`Manifest packaged asset mapping is invalid: ${asset.path}`);
      }
    }
    if (!Number.isSafeInteger(asset.bytes) || asset.bytes <= 0
      || !/^sha256:[a-f0-9]{64}$/.test(asset.sha256 ?? '')) {
      throw new Error(`Manifest packaged asset integrity is invalid: ${asset.path}`);
    }
  }
}

async function assertSafePackagedPhysicalPath(relativePath, expectedType) {
  try {
    return await assertSafePathComponents(
      packageRoot,
      relativePath,
      expectedType,
      'packaged physical inventory',
    );
  } catch {
    throw new Error('Packaged physical inventory contains an unsafe path component');
  }
}

function expectedPhysicalDirectories(relativeRoot, expectedFiles) {
  const directories = new Set([relativeRoot]);
  const rootDepth = relativeRoot.split('/').length;
  for (const expectedFile of expectedFiles) {
    const segments = expectedFile.split('/');
    for (let depth = rootDepth; depth < segments.length; depth += 1) {
      directories.add(segments.slice(0, depth).join('/'));
    }
  }
  return directories;
}

async function listExactPackagedPhysicalRoot(relativeRoot, expectedFiles) {
  const root = await assertSafePackagedPhysicalPath(relativeRoot, 'directory');
  const allowedDirectories = expectedPhysicalDirectories(relativeRoot, expectedFiles);
  const files = [];
  let unexpectedDirectoryCount = 0;

  async function walk(directory, relativeDirectory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareOrdinal(left.name, right.name));
    try {
      assertOrdinalUnique(
        entries.map((entry) => entry.name),
        'Packaged physical directory entries',
      );
    } catch {
      throw new Error('Packaged physical inventory contains ambiguous directory entries');
    }
    for (const entry of entries) {
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      if (!isCanonicalRepositoryPath(relativePath)) {
        throw new Error('Packaged physical inventory contains a noncanonical entry');
      }
      if (entry.isSymbolicLink()) {
        throw new Error('Packaged physical inventory contains a symlink or reparse point');
      }
      if (entry.isDirectory()) {
        if (!allowedDirectories.has(relativePath)) {
          unexpectedDirectoryCount += 1;
          continue;
        }
        const absolutePath = await assertSafePackagedPhysicalPath(relativePath, 'directory');
        await walk(absolutePath, relativePath);
      } else if (entry.isFile()) {
        await assertSafePackagedPhysicalPath(relativePath, 'file');
        files.push(relativePath);
      } else {
        throw new Error('Packaged physical inventory contains a special entry');
      }
    }
  }

  await walk(root, relativeRoot);
  return { files, unexpectedDirectoryCount };
}

async function verifyExactPackagedPhysicalInventory() {
  const expectedFiles = [
    EXPECTED_ARTIFACT_PATH,
    ...PACKAGED_REVIEWED_ASSETS.map((mapping) => mapping.target),
  ].sort(compareOrdinal);
  assertOrdinalUnique(expectedFiles, 'Expected packaged physical files', { paths: true });
  for (const expectedFile of expectedFiles) {
    const matchingRoots = PACKAGED_PHYSICAL_ROOTS.filter((relativeRoot) => (
      expectedFile.startsWith(`${relativeRoot}/`)
    ));
    if (matchingRoots.length !== 1) {
      throw new Error('Expected packaged physical file does not belong to exactly one physical root');
    }
  }

  const actualFiles = [];
  let unexpectedDirectoryCount = 0;
  for (const relativeRoot of PACKAGED_PHYSICAL_ROOTS) {
    const rootFiles = expectedFiles.filter((expectedPath) => (
      expectedPath.startsWith(`${relativeRoot}/`)
    ));
    if (rootFiles.length === 0) {
      throw new Error('Packaged physical root has no exact file contract');
    }
    const physicalRoot = await listExactPackagedPhysicalRoot(relativeRoot, rootFiles);
    actualFiles.push(...physicalRoot.files);
    unexpectedDirectoryCount += physicalRoot.unexpectedDirectoryCount;
  }
  actualFiles.sort(compareOrdinal);
  try {
    assertOrdinalUnique(actualFiles, 'Actual packaged physical files', { paths: true });
  } catch {
    throw new Error('Packaged physical inventory contains ambiguous file paths');
  }

  const expectedSet = new Set(expectedFiles);
  const actualSet = new Set(actualFiles);
  const missingCount = expectedFiles.filter((expectedPath) => !actualSet.has(expectedPath)).length;
  const unexpectedFileCount = actualFiles.filter((actualPath) => !expectedSet.has(actualPath)).length;
  const unexpectedCount = unexpectedFileCount + unexpectedDirectoryCount;
  if (missingCount !== 0 || unexpectedCount !== 0) {
    throw new Error(
      `Packaged physical file inventory does not match the exact contract; missing_count: ${missingCount}; unexpected_count: ${unexpectedCount}`,
    );
  }
}

function assertStaticVerifierContract() {
  assertOrdinalUnique(REVIEWED_SOURCE_EXACT_FILES, 'Reviewed exact source paths', { paths: true });
  assertOrdinalUnique(REVIEWED_SOURCE_RECURSIVE_ROOTS, 'Reviewed recursive source roots', { paths: true });
  assertOrdinalUnique(EXPECTED_PACKAGE_SOURCE_PATHS, 'Package source paths', { paths: true });
  assertOrdinalUnique(EXPECTED_EXPORTS, 'Runtime export contract');
  assertOrdinalUnique(PACKAGED_PHYSICAL_ROOTS, 'Packaged physical roots', { paths: true });
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

assertStaticVerifierContract();
const packageJsonPath = await assertSafePathComponents(
  packageRoot,
  'package.json',
  'file',
  'package contract',
);
const manifestPath = await assertSafePathComponents(
  packageRoot,
  'integrity-manifest.json',
  'file',
  'integrity manifest',
);
const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
if (JSON.stringify(packageJson) !== JSON.stringify(EXPECTED_PACKAGE_JSON)) {
  throw new Error('Hosted MCP package.json does not match the exact reviewed package contract');
}
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const reviewedSources = validateReviewedSourceRecords(manifest.reviewed_sources);
const sourceAttestation = reviewedSourceAttestation(reviewedSources);
const reviewedSourceByPath = new Map(reviewedSources.map((record) => [record.path, record]));
validateManifestContract(manifest, sourceAttestation, reviewedSourceByPath);
await verifyExactPackagedPhysicalInventory();

const artifactPath = await verifyFile(packageRoot, manifest.artifact, 'artifact');
const verifiedPackagedAssetPaths = new Map();
for (const asset of manifest.packaged_assets ?? []) {
  verifiedPackagedAssetPaths.set(
    asset.path,
    await verifyFile(packageRoot, asset, 'packaged asset'),
  );
  if (asset.source_path !== undefined) {
    const input = manifest.inputs?.find((record) => record.path === asset.source_path);
    if (!input
      || input.source !== 'reviewed_source'
      || input.bytes !== asset.bytes
      || input.sha256 !== asset.sha256) {
      throw new Error(`Packaged asset is not bound to a reviewed source digest: ${asset.path}`);
    }
  }
}
const noticeAsset = manifest.packaged_assets.find(
  (asset) => asset.path === manifest.third_party_notices.path,
);
if (!noticeAsset
  || noticeAsset.bytes !== manifest.third_party_notices.bytes
  || noticeAsset.sha256 !== manifest.third_party_notices.sha256) {
  throw new Error('Third-party notices are not bound to the packaged asset');
}
const noticeSources = manifest.third_party_notices.sources;
const packagedNoticeBytes = await readFile(
  verifiedPackagedAssetPaths.get(manifest.third_party_notices.path),
);
const noticesText = packagedNoticeBytes.toString('utf8');
const noticeBlocks = noticesText.split(`${'='.repeat(72)}\n`).slice(1).map((block) => block.trim());
if (noticeBlocks.length !== noticeSources.length) {
  throw new Error('Third-party notice source count does not match the generated notice blocks');
}
for (let index = 0; index < noticeSources.length; index += 1) {
  const source = noticeSources[index];
  if (typeof source.package !== 'string' || source.package === ''
    || typeof source.version !== 'string' || source.version === ''
    || typeof source.declared_license !== 'string' || source.declared_license === ''
    || !/^(?:standalone_license_file|markdown_license_section)$/.test(source.method ?? '')
    || typeof source.path !== 'string' || source.path === ''
    || !Number.isSafeInteger(source.source_bytes) || source.source_bytes <= 0
    || !/^sha256:[a-f0-9]{64}$/.test(source.source_sha256 ?? '')
    || !Number.isSafeInteger(source.notice_bytes) || source.notice_bytes <= 0
    || !/^sha256:[a-f0-9]{64}$/.test(source.notice_sha256 ?? '')) {
    throw new Error(`Third-party notice source contract is invalid at index ${index}`);
  }
  const input = manifest.inputs.find((entry) => entry.path === source.path);
  if (!input
    || input.source !== 'workspace_dependency'
    || input.bytes !== source.source_bytes
    || input.sha256 !== source.source_sha256) {
    throw new Error(`Third-party notice source is not bound to an exact workspace input: ${source.path}`);
  }
  const prefix = [
    `${source.package}@${source.version}`,
    `Declared license: ${source.declared_license}`,
    `Notice source: ${source.path}`,
    `Notice source method: ${source.method}`,
    `Notice source bytes: ${source.source_bytes}`,
    `Notice source SHA-256: ${source.source_sha256}`,
    `Extracted notice bytes: ${source.notice_bytes}`,
    `Extracted notice SHA-256: ${source.notice_sha256}`,
    '',
  ].join('\n');
  const block = noticeBlocks[index];
  if (!block.startsWith(prefix)) {
    throw new Error(`Third-party notice metadata does not match its generated block: ${source.package}`);
  }
  const noticeBytes = Buffer.from(block.slice(prefix.length).trim(), 'utf8');
  if (noticeBytes.byteLength !== source.notice_bytes || sha256(noticeBytes) !== source.notice_sha256) {
    throw new Error(`Third-party extracted notice integrity mismatch: ${source.package}`);
  }
}
if (verifySources) {
  const discoveredReviewedSourcePaths = await discoverReviewedSourcePaths();
  if (JSON.stringify(discoveredReviewedSourcePaths)
    !== JSON.stringify(reviewedSources.map((record) => record.path))) {
    throw new Error('Reviewed source inventory does not exactly match the repository source closure');
  }
  for (const reviewed of reviewedSources) {
    await verifyFile(repositoryRoot, reviewed, 'reviewed source', { canonicalReviewedSource: true });
  }
  const independentlyDerivedClosure = await independentlyDeriveBuildInputClosure(
    sourceAttestation,
    reviewedSourceByPath,
  );
  if (independentlyDerivedClosure.artifact.bytes !== manifest.artifact.bytes
    || independentlyDerivedClosure.artifact.sha256 !== manifest.artifact.sha256) {
    throw new Error([
      'Manifest artifact does not match the independently rebuilt source artifact',
      `manifest_sha256: ${manifest.artifact.sha256}`,
      `independent_sha256: ${independentlyDerivedClosure.artifact.sha256}`,
    ].join('; '));
  }
  const manifestInputPaths = manifest.inputs.map((input) => input.path);
  if (JSON.stringify(manifestInputPaths) !== JSON.stringify(independentlyDerivedClosure.paths)) {
    const manifestPathSet = new Set(manifestInputPaths);
    const derivedPathSet = new Set(independentlyDerivedClosure.paths);
    const omitted = independentlyDerivedClosure.paths.filter((inputPath) => !manifestPathSet.has(inputPath));
    const unexpected = manifestInputPaths.filter((inputPath) => !derivedPathSet.has(inputPath));
    throw new Error([
      'Manifest build inputs do not exactly match the independently derived esbuild dependency closure',
      `omitted_count: ${omitted.length}`,
      `unexpected_count: ${unexpected.length}`,
    ].join('; '));
  }
  if (JSON.stringify(manifest.build.external_imports)
    !== JSON.stringify(independentlyDerivedClosure.externalImports)) {
    const manifestExternalSet = new Set(manifest.build.external_imports);
    const derivedExternalSet = new Set(independentlyDerivedClosure.externalImports);
    const omitted = independentlyDerivedClosure.externalImports.filter(
      (specifier) => !manifestExternalSet.has(specifier),
    );
    const unexpected = manifest.build.external_imports.filter(
      (specifier) => !derivedExternalSet.has(specifier),
    );
    throw new Error([
      'Manifest external imports do not exactly match the independently derived esbuild output closure',
      `omitted_count: ${omitted.length}`,
      `unexpected_count: ${unexpected.length}`,
    ].join('; '));
  }
  if (JSON.stringify(manifest.third_party_notices.sources)
    !== JSON.stringify(independentlyDerivedClosure.noticeSources)) {
    throw new Error(
      'Manifest third-party notice sources do not match the independently derived dependency notice closure',
    );
  }
  if (independentlyDerivedClosure.noticeArtifact.bytes !== manifest.third_party_notices.bytes
    || independentlyDerivedClosure.noticeArtifact.sha256 !== manifest.third_party_notices.sha256
    || independentlyDerivedClosure.noticeArtifact.bytes !== noticeAsset.bytes
    || independentlyDerivedClosure.noticeArtifact.sha256 !== noticeAsset.sha256
    || independentlyDerivedClosure.noticeArtifact.contents.byteLength !== packagedNoticeBytes.byteLength
    || !independentlyDerivedClosure.noticeArtifact.contents.equals(packagedNoticeBytes)) {
    throw new Error([
      'Packaged third-party notices do not match the independently reconstructed notice artifact',
      `manifest_sha256: ${manifest.third_party_notices.sha256}`,
      `independent_sha256: ${independentlyDerivedClosure.noticeArtifact.sha256}`,
    ].join('; '));
  }
  for (const input of manifest.inputs ?? []) {
    if (input.source === 'reviewed_source') {
      await verifyFile(repositoryRoot, input, 'source input', { canonicalReviewedSource: true });
    } else if (input.source === 'package_source' || input.source === 'workspace_dependency') {
      await verifyFile(repositoryRoot, input, 'source input');
    } else {
      throw new Error(`Unsupported integrity input source: ${String(input.source)}`);
    }
  }
}

const bundle = await readFile(artifactPath);
const text = bundle.toString('utf8');
if (/\.\.\/mcp|\.\.\/risk-fork/.test(text) || /C:\\projects\\|C:\/projects\//i.test(text)) {
  throw new Error('Bundle contains a cross-worktree runtime reference');
}
const api = await import(`${pathToFileURL(artifactPath).href}?sha=${manifest.artifact.sha256.slice(7)}`);
const actualExports = Object.keys(api).sort(compareOrdinal);
if (JSON.stringify(actualExports) !== JSON.stringify(EXPECTED_EXPORTS)) {
  throw new Error('Bundle runtime exports do not match the integrity manifest');
}
if (api.HOSTED_MCP_BUNDLE_METADATA?.reviewed_source_integrity !== sourceAttestation.sha256
  || api.HOSTED_MCP_BUNDLE_METADATA?.authority_granted !== false
  || api.HOSTED_MCP_BUNDLE_METADATA?.outbound_mcp_transport_qualified !== false
  || api.HOSTED_MCP_BUNDLE_METADATA?.managed_postgres_qualified !== false
  || api.HOSTED_MCP_BUNDLE_METADATA?.e2b_live_qualified !== false) {
  throw new Error('Bundle runtime metadata does not preserve reviewed default-off authority state');
}
if (!quiet) {
  const marker = verifySources
    ? 'RISK_FORK_HOSTED_MCP_SOURCE_INTEGRITY_OK'
    : 'RISK_FORK_HOSTED_MCP_ARTIFACT_INTEGRITY_OK';
  process.stdout.write(`${marker} ${manifest.artifact.sha256}\n`);
}
