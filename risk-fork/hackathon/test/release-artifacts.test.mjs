import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createDeterministicZip } from '../src/offline-kit.mjs';
import {
  npmPackagePurl,
  RELEASE_ARTIFACT_SCHEMA,
  verifyReleaseArtifactSet,
  verifyReleaseSbomAgainstKit,
  writeReleaseSidecars,
} from '../scripts/release-artifacts.mjs';

const SOURCE_COMMIT = 'a'.repeat(40);

test('release envelope binds ZIP, checksum, SPDX SBOM, and exact source commit', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-release-artifacts-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const artifactDirectory = path.join(temporary, SOURCE_COMMIT.slice(0, 12));
  const kitDirectory = path.join(artifactDirectory, 'risk-fork-hackathon-demo');
  const dependencyRoot = path.join(kitDirectory, 'risk-fork/node_modules/example-dependency');
  await mkdir(dependencyRoot, { recursive: true });
  await writeFile(path.join(kitDirectory, 'risk-fork/package.json'), JSON.stringify({
    name: '@agoragentic/risk-fork', version: '0.1.0-alpha.1', license: 'Apache-2.0',
  }));
  await writeFile(path.join(dependencyRoot, 'package.json'), JSON.stringify({
    name: 'example-dependency', version: '1.2.3', license: 'MIT',
  }));
  await writeFile(path.join(kitDirectory, 'DEPENDENCY_PROVENANCE.json'), JSON.stringify({
    schema: 'agoragentic.risk-fork.offline-dependency-provenance.v1',
    materialization: 'npm_ci_offline_from_lock_cache',
    network_used: false,
    install_scripts_executed: false,
    packages: [{
      name: 'example-dependency',
      version: '1.2.3',
      resolved: 'https://registry.npmjs.org/example-dependency/-/example-dependency-1.2.3.tgz',
      integrity: `sha512-${Buffer.alloc(64, 7).toString('base64')}`,
      tree_sha256: 'b'.repeat(64),
    }],
  }));
  const payloadDirectory = path.join(temporary, 'payload');
  await mkdir(payloadDirectory);
  await writeFile(path.join(payloadDirectory, 'README.md'), 'offline payload\n');
  const zipPath = path.join(artifactDirectory, `risk-fork-hackathon-demo-${SOURCE_COMMIT.slice(0, 12)}.zip`);
  const zip = await createDeterministicZip({ sourceDirectory: payloadDirectory, outputPath: zipPath });
  const build = {
    source_commit: SOURCE_COMMIT,
    artifact_container: artifactDirectory,
    kit_directory: kitDirectory,
    zip_path: zipPath,
    zip_sha256: zip.sha256,
    zip_bytes: zip.bytes,
    manifest_sha256: 'c'.repeat(64),
    manifest_bytes: 100,
    file_count: 1,
    payload_bytes: 16,
  };
  const sidecars = await writeReleaseSidecars({ build });
  const verified = await verifyReleaseArtifactSet({ artifactDirectory });
  assert.equal(verified.verified, true);
  assert.equal(verified.source_commit, SOURCE_COMMIT);
  assert.equal(verified.zip_sha256, zip.sha256);

  const buildManifest = JSON.parse(await readFile(
    path.join(artifactDirectory, sidecars.build_manifest.filename),
    'utf8',
  ));
  assert.equal(buildManifest.schema, RELEASE_ARTIFACT_SCHEMA);
  assert.equal(buildManifest.live_traffic_protected, false);
  assert.equal(buildManifest.gui_client_verification, 'unknown_not_tested');
  const sbomBytes = await readFile(path.join(artifactDirectory, sidecars.sbom.filename));
  assert.equal(createHash('sha256').update(sbomBytes).digest('hex'), buildManifest.sbom.sha256);
  const sbom = JSON.parse(sbomBytes);
  assert.equal(sbom.spdxVersion, 'SPDX-2.3');
  assert.equal(sbom.packages.length, 2);
  assert.equal(sbom.relationships.some((item) => item.relationshipType === 'DEPENDS_ON'), true);
  assert.equal(
    sbom.packages[0].externalRefs[0].referenceLocator,
    'pkg:npm/%40agoragentic/risk-fork@0.1.0-alpha.1',
  );
  assert.equal(npmPackagePurl('@scope/name', '1.2.3'), 'pkg:npm/%40scope/name@1.2.3');

  sbom.packages[1].name = 'fabricated-dependency';
  const forgedSbomBytes = Buffer.from(`${JSON.stringify(sbom, null, 2)}\n`, 'utf8');
  await writeFile(path.join(artifactDirectory, sidecars.sbom.filename), forgedSbomBytes);
  buildManifest.sbom.sha256 = createHash('sha256').update(forgedSbomBytes).digest('hex');
  buildManifest.sbom.bytes = forgedSbomBytes.length;
  await writeFile(
    path.join(artifactDirectory, sidecars.build_manifest.filename),
    `${JSON.stringify(buildManifest, null, 2)}\n`,
  );
  const rehashedForgery = await verifyReleaseArtifactSet({ artifactDirectory });
  assert.equal(rehashedForgery.verified, true, 'header/hash verification alone should see the regression fixture');
  await assert.rejects(
    verifyReleaseSbomAgainstKit({
      sbomPath: rehashedForgery.sbom_path,
      kitDirectory,
      sourceCommit: SOURCE_COMMIT,
      zipSha256: zip.sha256,
    }),
    /does not exactly match/,
  );
});

test('release verification rejects a checksum sidecar changed after build', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-release-tamper-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const artifactDirectory = path.join(temporary, SOURCE_COMMIT.slice(0, 12));
  const kitDirectory = path.join(artifactDirectory, 'risk-fork-hackathon-demo');
  const dependencyRoot = path.join(kitDirectory, 'risk-fork/node_modules/example-dependency');
  await mkdir(dependencyRoot, { recursive: true });
  await writeFile(path.join(kitDirectory, 'risk-fork/package.json'), JSON.stringify({
    name: '@agoragentic/risk-fork', version: '0.1.0-alpha.1', license: 'Apache-2.0',
  }));
  await writeFile(path.join(dependencyRoot, 'package.json'), JSON.stringify({
    name: 'example-dependency', version: '1.2.3', license: 'MIT',
  }));
  await writeFile(path.join(kitDirectory, 'DEPENDENCY_PROVENANCE.json'), JSON.stringify({
    schema: 'agoragentic.risk-fork.offline-dependency-provenance.v1',
    materialization: 'npm_ci_offline_from_lock_cache', network_used: false,
    install_scripts_executed: false,
    packages: [{ name: 'example-dependency', version: '1.2.3',
      resolved: 'https://registry.npmjs.org/example-dependency/-/example-dependency-1.2.3.tgz',
      integrity: `sha512-${Buffer.alloc(64, 8).toString('base64')}`, tree_sha256: 'd'.repeat(64) }],
  }));
  const payloadDirectory = path.join(temporary, 'payload');
  await mkdir(payloadDirectory);
  await writeFile(path.join(payloadDirectory, 'README.md'), 'offline payload\n');
  const zipPath = path.join(artifactDirectory, `risk-fork-hackathon-demo-${SOURCE_COMMIT.slice(0, 12)}.zip`);
  const zip = await createDeterministicZip({ sourceDirectory: payloadDirectory, outputPath: zipPath });
  const sidecars = await writeReleaseSidecars({ build: {
    source_commit: SOURCE_COMMIT, artifact_container: artifactDirectory, kit_directory: kitDirectory,
    zip_path: zipPath, zip_sha256: zip.sha256, zip_bytes: zip.bytes,
    manifest_sha256: 'e'.repeat(64), manifest_bytes: 100, file_count: 1, payload_bytes: 16,
  } });
  await writeFile(path.join(artifactDirectory, sidecars.checksum.filename), 'tampered\n');
  await assert.rejects(
    verifyReleaseArtifactSet({ artifactDirectory }),
    /Checksum bytes do not match/,
  );
});
