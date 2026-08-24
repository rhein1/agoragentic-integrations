import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { builtinModules, createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
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
const REVIEWED_SOURCE_COMMIT = 'dede3ae3806a03e63660a5772a28433a75573048';
const PACKAGED_REVIEWED_ASSETS = Object.freeze([
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
  {
    source: 'risk-fork/e2b-template/template.mjs',
    target: 'e2b-context/risk-fork/e2b-template/template.mjs',
  },
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
]);

function inside(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
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

function portable(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function repoRelative(absolutePath) {
  const relative = path.relative(repositoryRoot, absolutePath);
  if (relative === '' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Build input escapes the repository: ${absolutePath}`);
  }
  return portable(relative);
}

function snapshotSourcePath(snapshotRoot, absolutePath) {
  const relative = path.relative(snapshotRoot, absolutePath);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)) return null;
  return portable(relative);
}

function gitBytes(commit, sourcePath) {
  return execFileSync('git', ['show', `${commit}:${sourcePath}`], {
    cwd: repositoryRoot,
    encoding: 'buffer',
    maxBuffer: 32 * 1024 * 1024,
  });
}

async function materializeReviewedSources(commit, snapshotRoot) {
  const listed = execFileSync('git', [
    'ls-tree',
    '-r',
    '--name-only',
    commit,
    '--',
    'mcp',
    'risk-fork',
    'transaction-assurance/src',
  ], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  }).split(/\r?\n/).filter(Boolean).filter((sourcePath) => (
    sourcePath === 'mcp/mcp-server.js'
      || sourcePath === 'mcp/package.json'
      || sourcePath === 'risk-fork/package.json'
      || sourcePath === 'risk-fork/migrations/001_distributed_authority.pg.sql'
      || sourcePath === 'risk-fork/schema/e2b-qualification-evidence.v1.json'
      || sourcePath.startsWith('risk-fork/e2b-template/')
      || sourcePath.startsWith('risk-fork/ops/postgres/')
      || sourcePath.startsWith('risk-fork/src/')
      || sourcePath.startsWith('transaction-assurance/src/')
  ));
  if (listed.length < 10) throw new Error('Reviewed source snapshot is unexpectedly incomplete');
  const snapshot = assertPackageTarget(snapshotRoot, 'reviewed source snapshot');
  await rm(snapshot, { recursive: true, force: true });
  for (const sourcePath of listed.sort()) {
    const target = assertPackageTarget(
      path.join(snapshot, ...sourcePath.split('/')),
      `reviewed source snapshot ${sourcePath}`,
    );
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, gitBytes(commit, sourcePath));
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
  const packageNames = [...new Set(inputPaths.map(packageNameFromInput).filter(Boolean))].sort();
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

const sourceCommit = REVIEWED_SOURCE_COMMIT;
if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('Source commit is not a full Git object id');
execFileSync('git', ['cat-file', '-e', `${sourceCommit}^{commit}`], {
  cwd: repositoryRoot,
  stdio: 'ignore',
});
const buildRoot = assertPackageTarget(path.join(packageRoot, '.build'), 'build root');
await mkdir(buildRoot, { recursive: true });
const buildLockPath = assertPackageTarget(
  path.join(buildRoot, 'build.lock'),
  'build lock',
);
const releaseBuildLock = await acquireBuildLock(buildLockPath);
try {
await materializeReviewedSources(sourceCommit, snapshotRoot);

const packageJsonPath = path.join(packageRoot, 'package.json');
const mcpPackagePath = path.join(snapshotMcpRoot, 'package.json');
const riskForkPackagePath = path.join(snapshotRiskForkRoot, 'package.json');
const ownPackage = JSON.parse(await readFile(packageJsonPath, 'utf8'));
const mcpPackage = JSON.parse(await readFile(mcpPackagePath, 'utf8'));
const riskForkPackage = JSON.parse(await readFile(riskForkPackagePath, 'utf8'));

if (ownPackage.version !== '0.1.0-alpha.0'
  || mcpPackage.version !== '2.0.0'
  || riskForkPackage.version !== '0.1.0-alpha.0') {
  throw new Error('Hosted MCP bundle source versions do not match the reviewed exact versions');
}
if (ownPackage.peerDependencies?.e2b !== '2.39.0'
  || ownPackage.peerDependenciesMeta?.e2b?.optional !== true
  || Object.keys(ownPackage.peerDependencies).length !== 1
  || Object.keys(ownPackage.peerDependenciesMeta).length !== 1) {
  throw new Error('Hosted MCP bundle requires only optional exact peer e2b@2.39.0');
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

const metafileInputPaths = Object.keys(result.metafile.inputs).map((input) => portable(input));
const upstreamInputs = [];
for (const input of metafileInputPaths) {
  const absolute = path.resolve(repositoryRoot, ...input.split('/'));
  const bytes = await readFile(absolute);
  const reviewedSource = snapshotSourcePath(snapshotRoot, absolute);
  upstreamInputs.push({
    path: reviewedSource ?? repoRelative(absolute),
    source: reviewedSource
      ? 'git_blob'
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
    source: 'git_blob',
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
const inputs = [...new Map(upstreamInputs.map((entry) => [entry.path, entry])).values()]
  .sort((left, right) => left.path.localeCompare(right.path));

const distPath = assertPackageTarget(path.join(packageRoot, 'dist', 'runtime', 'index.mjs'), 'bundle path');
const noticesPath = assertPackageTarget(path.join(packageRoot, 'THIRD_PARTY_NOTICES.txt'), 'notices path');
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

const exportedNames = [
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
  'assertHostCanEnforce',
  'assertPreparedForCleanCommit',
  'assertRiskForkProvider',
  'acquirePostgresAuthorityClient',
  'buildExecutionBinding',
  'buildFallbackToolList',
  'buildPostgresAuthorityPoolConfig',
  'classifyRisk',
  'closeRemoteSession',
  'commitPreparedArtifact',
  'computeMcpCleanImportEvidenceHash',
  'connectRemoteClient',
  'createForkIdentity',
  'createE2BAuthorityFreeSourceVerifier',
  'createE2BQualificationEvidence',
  'createE2BQualificationTrustVerifier',
  'createE2BRuntimeSdkIntegrityVerifier',
  'createMcpEnforcementBoundary',
  'createMcpInterceptionPlan',
  'createRemoteToolDirectory',
  'createSavepointCapsule',
  'createPostgresAuthorityPool',
  'createTrustedMcpServerVerifier',
  'deriveParentAuthorityRef',
  'executeFallbackTool',
  'isPostgresDistributedCommitAuthority',
  'isE2BQualificationEvidenceCanonical',
  'isE2BRuntimeSdkIntegrityVerifier',
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
].sort();
const noticeBytes = Buffer.from(notices.text, 'utf8');
const packagedAssets = [
  ...reviewedAssets.map(({ content: _content, ...record }) => record),
  {
    path: 'THIRD_PARTY_NOTICES.txt',
    bytes: noticeBytes.byteLength,
    sha256: sha256(noticeBytes),
  },
].sort((left, right) => left.path.localeCompare(right.path));
const manifest = {
  schema: 'agoragentic.risk-fork-hosted-mcp.integrity.v1',
  package: { name: ownPackage.name, version: ownPackage.version, private: true },
  source_commit: sourceCommit,
  sources: {
    mcp: { name: mcpPackage.name, version: mcpPackage.version },
    risk_fork: { name: riskForkPackage.name, version: riskForkPackage.version },
  },
  build: {
    builder: `esbuild@${esbuild.version}`,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    transforms: [
      'upstream project sources materialized from source_commit Git blobs',
      'pg-native optional adapter disabled; reviewed pg JavaScript driver bundled',
      'e2b is retained only as the exact optional peer e2b@2.39.0',
    ],
    external_imports: (outputMeta.imports ?? [])
      .filter((entry) => entry.external)
      .map((entry) => entry.path)
      .sort(),
  },
  runtime_dependencies: [],
  optional_peer_dependencies: [
    { name: 'e2b', version: '2.39.0', optional: true },
  ],
  exports: exportedNames,
  inputs,
  third_party_notices: {
    path: 'THIRD_PARTY_NOTICES.txt',
    bytes: noticeBytes.byteLength,
    sha256: sha256(noticeBytes),
    sources: notices.sources,
  },
  artifact: {
    path: 'dist/runtime/index.mjs',
    bytes: output.contents.byteLength,
    sha256: sha256(output.contents),
  },
  packaged_assets: packagedAssets,
};
const manifestPath = assertPackageTarget(path.join(packageRoot, 'integrity-manifest.json'), 'manifest path');
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
} finally {
  try {
    await rm(snapshotRoot, { recursive: true, force: true });
  } finally {
    await releaseBuildLock();
  }
}
