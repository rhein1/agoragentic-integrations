import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  OFFLINE_KIT_BANNER,
  OFFLINE_KIT_TRUTH,
  verifyZipArchive,
} from '../src/offline-kit.mjs';

export const RELEASE_ARTIFACT_SCHEMA = 'agoragentic.risk-fork.hackathon-release-build.v1';
export const SPDX_VERSION = 'SPDX-2.3';
export const RELEASE_FIXED_CREATED_AT = '1980-01-01T00:00:00Z';
const BUILD_OWNER_NAME = '.risk-fork-offline-kit-owner.json';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function exactCommit(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
    throw new Error('Release source commit must be an exact lowercase 40-character Git SHA');
  }
  return value;
}

function safeBasename(value, label) {
  if (typeof value !== 'string'
    || value.length < 1
    || value !== path.basename(value)
    || value.includes('/')
    || value.includes('\\')) {
    throw new Error(`${label} must be a single portable filename`);
  }
  return value;
}

function assertExactObjectKeys(value, expectedKeys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a closed object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`${label} does not match its closed schema`);
  }
}

function spdxId(value) {
  return `SPDXRef-${value.replace(/[^A-Za-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '')}`;
}

function declaredLicense(value) {
  if (typeof value !== 'string' || value.length < 1 || value === 'SEE_PACKAGE') return 'NOASSERTION';
  return value;
}

export function npmPackagePurl(name, version) {
  if (typeof name !== 'string' || typeof version !== 'string' || version.length < 1) {
    throw new TypeError('npm purl requires a package name and version');
  }
  if (name.startsWith('@')) {
    const separator = name.indexOf('/');
    if (separator <= 1 || separator === name.length - 1 || name.indexOf('/', separator + 1) !== -1) {
      throw new Error('Scoped npm package name is invalid');
    }
    const scope = encodeURIComponent(name.slice(1, separator));
    const packageName = encodeURIComponent(name.slice(separator + 1));
    return `pkg:npm/%40${scope}/${packageName}@${encodeURIComponent(version)}`;
  }
  if (name.includes('/')) throw new Error('Unscoped npm package name is invalid');
  return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
}

function sha512FromIntegrity(value) {
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(value ?? '');
  if (!match) throw new Error('Dependency integrity must be canonical SHA-512');
  const bytes = Buffer.from(match[1], 'base64');
  if (bytes.length !== 64 || bytes.toString('base64') !== match[1]) {
    throw new Error('Dependency integrity is not canonical SHA-512');
  }
  return bytes.toString('hex');
}

async function dependencyLicense(kitDirectory, dependency) {
  const packageJson = JSON.parse(await readFile(path.join(
    kitDirectory,
    'risk-fork',
    'node_modules',
    ...dependency.name.split('/'),
    'package.json',
  ), 'utf8'));
  if (packageJson.name !== dependency.name || packageJson.version !== dependency.version) {
    throw new Error(`Bundled dependency metadata drifted for ${dependency.name}`);
  }
  return declaredLicense(packageJson.license);
}

export async function createSpdxDocument({
  kitDirectory,
  sourceCommit,
  zipSha256,
} = {}) {
  exactCommit(sourceCommit);
  if (!/^[0-9a-f]{64}$/.test(zipSha256 ?? '')) throw new Error('ZIP SHA-256 is invalid');
  const rootPackage = JSON.parse(await readFile(path.join(kitDirectory, 'risk-fork/package.json'), 'utf8'));
  const provenance = JSON.parse(await readFile(path.join(kitDirectory, 'DEPENDENCY_PROVENANCE.json'), 'utf8'));
  if (provenance.schema !== 'agoragentic.risk-fork.offline-dependency-provenance.v1'
    || provenance.materialization !== 'npm_ci_offline_from_lock_cache'
    || provenance.network_used !== false
    || provenance.install_scripts_executed !== false
    || !Array.isArray(provenance.packages)) {
    throw new Error('Offline dependency provenance cannot support the release SBOM');
  }

  const rootId = spdxId('Package-Risk-Fork');
  const dependencies = [];
  for (const dependency of [...provenance.packages].sort((a, b) => (
    a.name < b.name ? -1 : (a.name > b.name ? 1 : 0)
  ))) {
    dependencies.push({
      SPDXID: spdxId(`Package-${dependency.name}-${dependency.version}`),
      name: dependency.name,
      versionInfo: dependency.version,
      downloadLocation: dependency.resolved,
      filesAnalyzed: false,
      checksums: [{ algorithm: 'SHA512', checksumValue: sha512FromIntegrity(dependency.integrity) }],
      licenseConcluded: 'NOASSERTION',
      licenseDeclared: await dependencyLicense(kitDirectory, dependency),
      copyrightText: 'NOASSERTION',
      externalRefs: [{
        referenceCategory: 'PACKAGE-MANAGER',
        referenceType: 'purl',
        referenceLocator: npmPackagePurl(dependency.name, dependency.version),
      }],
      comment: `Exact offline-reified dependency tree sha256:${dependency.tree_sha256}`,
    });
  }

  return {
    spdxVersion: SPDX_VERSION,
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `Risk Fork hackathon offline kit ${sourceCommit.slice(0, 12)}`,
    documentNamespace: `https://agoragentic.com/spdx/risk-fork/${sourceCommit}/${zipSha256}`,
    creationInfo: {
      created: RELEASE_FIXED_CREATED_AT,
      creators: ['Organization: Agoragentic', 'Tool: risk-fork-release-artifacts'],
    },
    documentDescribes: [rootId],
    packages: [
      {
        SPDXID: rootId,
        name: rootPackage.name,
        versionInfo: rootPackage.version,
        downloadLocation: `git+https://github.com/rhein1/agoragentic-integrations.git@${sourceCommit}`,
        filesAnalyzed: false,
        licenseConcluded: 'NOASSERTION',
        licenseDeclared: declaredLicense(rootPackage.license),
        copyrightText: 'NOASSERTION',
        externalRefs: [{
          referenceCategory: 'PACKAGE-MANAGER',
          referenceType: 'purl',
          referenceLocator: npmPackagePurl(rootPackage.name, rootPackage.version),
        }],
        comment: 'Source package represented inside the exact-commit offline demonstration ZIP.',
      },
      ...dependencies,
    ],
    relationships: [
      { spdxElementId: 'SPDXRef-DOCUMENT', relationshipType: 'DESCRIBES', relatedSpdxElement: rootId },
      ...dependencies.map((dependency) => ({
        spdxElementId: rootId,
        relationshipType: 'DEPENDS_ON',
        relatedSpdxElement: dependency.SPDXID,
      })),
    ],
  };
}

async function writeExclusive(file, bytes) {
  await writeFile(file, bytes, { flag: 'wx', mode: 0o644 });
  return { filename: path.basename(file), sha256: sha256(bytes), bytes: bytes.length };
}

export async function writeReleaseSidecars({ build } = {}) {
  exactCommit(build?.source_commit);
  const artifactDirectory = path.resolve(build.artifact_container);
  const zipPath = path.resolve(build.zip_path);
  if (path.dirname(zipPath) !== artifactDirectory) {
    throw new Error('Offline ZIP must be directly inside its commit-pinned artifact directory');
  }
  const zipBytes = await readFile(zipPath);
  if (sha256(zipBytes) !== build.zip_sha256 || zipBytes.length !== build.zip_bytes) {
    throw new Error('Offline ZIP bytes do not match the builder result');
  }

  const stem = `risk-fork-hackathon-demo-${build.source_commit.slice(0, 12)}`;
  const sbom = await createSpdxDocument({
    kitDirectory: build.kit_directory,
    sourceCommit: build.source_commit,
    zipSha256: build.zip_sha256,
  });
  const sbomRecord = await writeExclusive(
    path.join(artifactDirectory, `${stem}.spdx.json`),
    Buffer.from(stableJson(sbom), 'utf8'),
  );
  const checksumRecord = await writeExclusive(
    path.join(artifactDirectory, `${stem}.sha256`),
    Buffer.from(`${build.zip_sha256}  ${path.basename(zipPath)}\n`, 'utf8'),
  );
  const buildManifest = {
    schema: RELEASE_ARTIFACT_SCHEMA,
    banner: OFFLINE_KIT_BANNER,
    ...OFFLINE_KIT_TRUTH,
    source_commit: build.source_commit,
    source_materialization: 'exact_git_blobs',
    deterministic_created_at: RELEASE_FIXED_CREATED_AT,
    distribution: 'dependency_complete_offline_zip',
    npm_registry_publication: false,
    provider_qualification: false,
    gui_client_verification: 'unknown_not_tested',
    zip: {
      filename: path.basename(zipPath),
      sha256: build.zip_sha256,
      bytes: build.zip_bytes,
      internal_manifest_sha256: build.manifest_sha256,
      internal_manifest_bytes: build.manifest_bytes,
      payload_file_count: build.file_count,
      payload_bytes: build.payload_bytes,
    },
    checksum: checksumRecord,
    sbom: sbomRecord,
  };
  const manifestRecord = await writeExclusive(
    path.join(artifactDirectory, `${stem}.build.json`),
    Buffer.from(stableJson(buildManifest), 'utf8'),
  );
  return Object.freeze({
    artifact_directory: artifactDirectory,
    zip: { filename: path.basename(zipPath), sha256: build.zip_sha256, bytes: build.zip_bytes },
    checksum: checksumRecord,
    sbom: sbomRecord,
    build_manifest: manifestRecord,
  });
}

async function readBounded(file, maxBytes = 8 * 1024 * 1024) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maxBytes) {
    throw new Error(`Release artifact is not a bounded regular file: ${path.basename(file)}`);
  }
  return readFile(file);
}

async function assertRecord(directory, record, label) {
  const filename = safeBasename(record?.filename, `${label} filename`);
  if (!/^[0-9a-f]{64}$/.test(record?.sha256 ?? '') || !Number.isSafeInteger(record?.bytes)) {
    throw new Error(`${label} record is invalid`);
  }
  const bytes = await readBounded(path.join(directory, filename));
  if (bytes.length !== record.bytes || sha256(bytes) !== record.sha256) {
    throw new Error(`${label} bytes do not match the release build manifest`);
  }
  return bytes;
}

async function lstatOrNull(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function finalizeReleaseArtifactDirectory({ build, outputBase } = {}) {
  const sourceCommit = exactCommit(build?.source_commit);
  if (typeof outputBase !== 'string' || !path.isAbsolute(outputBase)) {
    throw new TypeError('outputBase must be an explicit absolute path');
  }
  const output = path.resolve(outputBase);
  const artifactDirectory = path.resolve(build?.artifact_container ?? '');
  const kitDirectory = path.resolve(build?.kit_directory ?? '');
  const shortCommit = sourceCommit.slice(0, 12);
  const stem = `risk-fork-hackathon-demo-${shortCommit}`;
  if (path.dirname(artifactDirectory) !== output
    || path.basename(artifactDirectory) !== shortCommit
    || path.dirname(kitDirectory) !== artifactDirectory
    || path.basename(kitDirectory) !== 'risk-fork-hackathon-demo') {
    throw new Error('Release build paths are outside the exact commit-pinned artifact boundary');
  }
  for (const [target, label] of [
    [output, 'release output root'],
    [artifactDirectory, 'release artifact directory'],
    [kitDirectory, 'release kit directory'],
  ]) {
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(target) !== target) {
      throw new Error(`${label} must be an exact real directory`);
    }
  }

  const expectedBeforeFinalization = [
    BUILD_OWNER_NAME,
    'risk-fork-hackathon-demo',
    `${stem}.build.json`,
    `${stem}.sha256`,
    `${stem}.spdx.json`,
    `${stem}.zip`,
  ].sort();
  const names = (await readdir(artifactDirectory)).sort();
  if (!isDeepStrictEqual(names, expectedBeforeFinalization)) {
    throw new Error('Release artifact directory does not match its exact owned pre-finalization inventory');
  }

  const ownerPath = path.join(artifactDirectory, BUILD_OWNER_NAME);
  const ownerBytes = await readBounded(ownerPath, 1024);
  const owner = JSON.parse(ownerBytes.toString('utf8'));
  assertExactObjectKeys(owner, ['owned_stage', 'schema', 'source_commit'], 'Release build owner marker');
  if (owner.schema !== 'agoragentic.risk-fork.offline-kit-build-owner.v1'
    || owner.source_commit !== sourceCommit
    || owner.owned_stage !== true
    || ownerBytes.toString('utf8') !== stableJson(owner)) {
    throw new Error('Release build owner marker is invalid or non-canonical');
  }

  await rm(kitDirectory, { recursive: true, force: false, maxRetries: 0 });
  await rm(ownerPath, { force: false, maxRetries: 0 });
  if (await lstatOrNull(kitDirectory) || await lstatOrNull(ownerPath)) {
    throw new Error('Release build-owned staging data was not removed before artifact finalization');
  }
  const verification = await verifyReleaseArtifactSet({ artifactDirectory });
  return Object.freeze({
    finalized: true,
    source_commit: sourceCommit,
    artifact_directory: artifactDirectory,
    committed_file_count: (await readdir(artifactDirectory)).length,
    verification,
  });
}

export async function verifyReleaseArtifactSet({ artifactDirectory } = {}) {
  if (typeof artifactDirectory !== 'string' || !path.isAbsolute(artifactDirectory)) {
    throw new TypeError('artifactDirectory must be an explicit absolute path');
  }
  let directory = path.resolve(artifactDirectory);
  let resolvedFromParent = false;
  const rootInfo = await lstat(directory);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error('Release artifact root must be a real directory');
  }
  let names = await readdir(directory);
  if (!names.some((name) => name.endsWith('.build.json'))) {
    if (names.length !== 1) {
      throw new Error('Release output root must contain exactly one commit-pinned artifact directory');
    }
    const candidateName = safeBasename(names[0], 'Release artifact directory');
    const candidate = path.join(directory, candidateName);
    const info = await lstat(candidate);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error('Release output root must contain exactly one commit-pinned artifact directory');
    }
    directory = candidate;
    resolvedFromParent = true;
    names = await readdir(candidate);
  }
  const buildNames = names.filter((name) => name.endsWith('.build.json'));
  if (buildNames.length !== 1) throw new Error('Release directory must contain exactly one build manifest');
  const buildBytes = await readBounded(path.join(directory, buildNames[0]));
  const build = JSON.parse(buildBytes.toString('utf8'));
  assertExactObjectKeys(build, [
    'schema',
    'banner',
    ...Object.keys(OFFLINE_KIT_TRUTH),
    'source_commit',
    'source_materialization',
    'deterministic_created_at',
    'distribution',
    'npm_registry_publication',
    'provider_qualification',
    'gui_client_verification',
    'zip',
    'checksum',
    'sbom',
  ], 'Release build manifest');
  assertExactObjectKeys(build.zip, [
    'filename',
    'sha256',
    'bytes',
    'internal_manifest_sha256',
    'internal_manifest_bytes',
    'payload_file_count',
    'payload_bytes',
  ], 'Release ZIP record');
  assertExactObjectKeys(build.checksum, ['filename', 'sha256', 'bytes'], 'Checksum record');
  assertExactObjectKeys(build.sbom, ['filename', 'sha256', 'bytes'], 'SBOM record');
  if (buildBytes.toString('utf8') !== stableJson(build)) {
    throw new Error('Release build manifest must use canonical JSON bytes');
  }
  if (build.schema !== RELEASE_ARTIFACT_SCHEMA
    || build.banner !== OFFLINE_KIT_BANNER
    || build.distribution !== 'dependency_complete_offline_zip'
    || build.source_materialization !== 'exact_git_blobs'
    || build.deterministic_created_at !== RELEASE_FIXED_CREATED_AT) {
    throw new Error('Release build manifest boundary is invalid');
  }
  for (const [key, expected] of Object.entries(OFFLINE_KIT_TRUTH)) {
    if (build[key] !== expected) throw new Error(`Release truth field ${key} is invalid`);
  }
  exactCommit(build.source_commit);
  const stem = `risk-fork-hackathon-demo-${build.source_commit.slice(0, 12)}`;
  if ((resolvedFromParent && path.basename(directory) !== build.source_commit.slice(0, 12))
    || buildNames[0] !== `${stem}.build.json`) {
    throw new Error('Release artifact directory does not match its exact source commit');
  }
  if (build.npm_registry_publication !== false
    || build.provider_qualification !== false
    || build.gui_client_verification !== 'unknown_not_tested') {
    throw new Error('Release status claims are not fail-closed');
  }

  const zipFilename = safeBasename(build.zip?.filename, 'ZIP filename');
  const checksumFilename = safeBasename(build.checksum?.filename, 'Checksum filename');
  const sbomFilename = safeBasename(build.sbom?.filename, 'SBOM filename');
  const expectedNames = [
    `${stem}.build.json`,
    `${stem}.sha256`,
    `${stem}.spdx.json`,
    `${stem}.zip`,
  ].sort();
  if (zipFilename !== `${stem}.zip`
    || checksumFilename !== `${stem}.sha256`
    || sbomFilename !== `${stem}.spdx.json`
    || JSON.stringify([...names].sort()) !== JSON.stringify(expectedNames)) {
    throw new Error('Release artifact directory must contain exactly the four commit-pinned files');
  }
  if (!/^[0-9a-f]{64}$/.test(build.zip?.sha256 ?? '')
    || !Number.isSafeInteger(build.zip?.bytes)
    || build.zip.bytes < 1
    || !/^[0-9a-f]{64}$/.test(build.zip?.internal_manifest_sha256 ?? '')
    || !Number.isSafeInteger(build.zip?.internal_manifest_bytes)
    || build.zip.internal_manifest_bytes < 1
    || !Number.isSafeInteger(build.zip?.payload_file_count)
    || build.zip.payload_file_count < 1
    || !Number.isSafeInteger(build.zip?.payload_bytes)
    || build.zip.payload_bytes < 1) {
    throw new Error('Internal kit manifest record is invalid');
  }
  const zipBytes = await readBounded(path.join(directory, zipFilename), 64 * 1024 * 1024);
  if (zipBytes.length !== build.zip.bytes || sha256(zipBytes) !== build.zip.sha256) {
    throw new Error('ZIP does not match the release build manifest');
  }
  const checksumBytes = await assertRecord(directory, build.checksum, 'Checksum');
  if (checksumBytes.toString('utf8') !== `${build.zip.sha256}  ${zipFilename}\n`) {
    throw new Error('Checksum sidecar is not canonical');
  }
  const sbomBytes = await assertRecord(directory, build.sbom, 'SBOM');
  const sbom = JSON.parse(sbomBytes.toString('utf8'));
  if (sbom.spdxVersion !== SPDX_VERSION
    || sbom.dataLicense !== 'CC0-1.0'
    || !Array.isArray(sbom.packages)
    || sbom.packages.length < 2
    || !sbom.documentNamespace.endsWith(`/${build.source_commit}/${build.zip.sha256}`)) {
    throw new Error('SPDX SBOM boundary is invalid');
  }
  const zipVerification = await verifyZipArchive({ zipPath: path.join(directory, zipFilename) });
  if (zipVerification.sha256 !== build.zip.sha256 || zipVerification.verified !== true) {
    throw new Error('Canonical ZIP verification failed');
  }
  const internalManifestEntries = zipVerification.entries.filter((entry) => entry.path === 'MANIFEST.json');
  const payloadEntries = zipVerification.entries.filter((entry) => entry.path !== 'MANIFEST.json');
  const payloadBytes = payloadEntries.reduce((sum, entry) => sum + entry.bytes, 0);
  if (internalManifestEntries.length !== 1
    || internalManifestEntries[0].sha256 !== build.zip.internal_manifest_sha256
    || internalManifestEntries[0].bytes !== build.zip.internal_manifest_bytes
    || payloadEntries.length !== build.zip.payload_file_count
    || payloadBytes !== build.zip.payload_bytes
    || zipVerification.entry_count !== build.zip.payload_file_count + 1
    || zipVerification.uncompressed_bytes !== build.zip.payload_bytes + build.zip.internal_manifest_bytes) {
    throw new Error('Release build manifest does not match the ZIP payload inventory');
  }
  return Object.freeze({
    schema: 'agoragentic.risk-fork.hackathon-release-verification.v1',
    banner: OFFLINE_KIT_BANNER,
    ...OFFLINE_KIT_TRUTH,
    verified: true,
    source_commit: build.source_commit,
    artifact_directory: directory,
    zip_path: path.join(directory, zipFilename),
    zip_sha256: build.zip.sha256,
    zip_bytes: build.zip.bytes,
    internal_manifest_sha256: build.zip.internal_manifest_sha256,
    internal_manifest_bytes: build.zip.internal_manifest_bytes,
    build_manifest_sha256: sha256(buildBytes),
    sbom_path: path.join(directory, build.sbom.filename),
    sbom_sha256: build.sbom.sha256,
    checksum_sha256: build.checksum.sha256,
  });
}

export async function verifyReleaseSbomAgainstKit({
  sbomPath,
  kitDirectory,
  sourceCommit,
  zipSha256,
} = {}) {
  if (typeof sbomPath !== 'string' || !path.isAbsolute(sbomPath)) {
    throw new TypeError('sbomPath must be an explicit absolute path');
  }
  if (typeof kitDirectory !== 'string' || !path.isAbsolute(kitDirectory)) {
    throw new TypeError('kitDirectory must be an explicit absolute path');
  }
  const observed = JSON.parse((await readBounded(sbomPath)).toString('utf8'));
  const expected = await createSpdxDocument({ kitDirectory, sourceCommit, zipSha256 });
  if (!isDeepStrictEqual(observed, expected)) {
    throw new Error('SPDX SBOM does not exactly match the freshly extracted dependency provenance');
  }
  return Object.freeze({ verified: true, package_count: expected.packages.length });
}
