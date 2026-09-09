import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { verifyManifest } from '../scripts/verify-front-door-release-candidates.mjs';

const root = path.resolve(import.meta.dirname, '..');
const read = (relativePath) => readFileSync(path.join(root, relativePath), 'utf8');
const artifactNames = [
  'agoragentic-1.8.0-rc.0.tgz',
  'agoragentic-1.8.0rc0-py3-none-any.whl',
  'agoragentic-1.8.0rc0.tar.gz',
];

function writeFixture(directory, overrides = {}) {
  const artifacts = artifactNames.map((name) => {
    const content = Buffer.from(`fixture:${name}`);
    writeFileSync(path.join(directory, name), content);
    return {
      name,
      bytes: content.length,
      sha256: `sha256:${createHash('sha256').update(content).digest('hex')}`,
    };
  });
  const manifest = {
    schema: 'agoragentic.front-door-release-candidate-manifest.v1',
    publish_authorized: false,
    source_version: '1.7.1',
    node_version: '1.8.0-rc.0',
    python_version: '1.8.0rc0',
    artifacts,
    ...overrides,
  };
  writeFileSync(path.join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

test('front-door candidate build is versioned, non-publishing, and offline-verifiable', () => {
  const build = read('scripts/build-front-door-release-candidates.mjs');
  const verify = read('scripts/verify-front-door-release-candidates.mjs');
  const workflow = read('.github/workflows/front-door-release-candidate.yml');

  assert.match(build, /NODE_RC_VERSION = '1\.8\.0-rc\.0'/);
  assert.match(build, /PYTHON_RC_VERSION = '1\.8\.0rc0'/);
  assert.match(build, /publish_authorized: false/);
  assert.match(verify, /'--offline'/);
  assert.match(verify, /'--no-index'/);
  assert.match(workflow, /^permissions:\s*\n\s*contents: read$/m);
  assert.doesNotMatch(
    `${build}\n${verify}\n${workflow}`,
    /npm\s+publish|twine\s+upload|gh-action-pypi-publish|id-token:\s*write/i,
  );
});

test('candidate verifier rejects false source attribution and unmanifested files', () => {
  const sourceFixture = mkdtempSync(path.join(tmpdir(), 'agoragentic-front-door-source-mutation-'));
  const extraFixture = mkdtempSync(path.join(tmpdir(), 'agoragentic-front-door-extra-artifact-'));
  try {
    writeFixture(sourceFixture, { source_version: 'tampered-source' });
    assert.throws(() => verifyManifest(sourceFixture), /manifest contract is invalid/);

    writeFixture(extraFixture);
    writeFileSync(path.join(extraFixture, 'unmanifested-package.tgz'), 'unreviewed', 'utf8');
    assert.throws(() => verifyManifest(extraFixture), /directory contains an unexpected entry/);
  } finally {
    rmSync(sourceFixture, { recursive: true, force: true });
    rmSync(extraFixture, { recursive: true, force: true });
  }
});
