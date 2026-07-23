import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const sdkRoot = path.join(root, 'sdk');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

test('public SDK source versions and repository paths are synchronized', () => {
  const nodePackage = readJson('sdk/node/package.json');
  const cliPackage = readJson('sdk/agent-os-cli/package.json');
  const pythonProject = read('sdk/python/pyproject.toml');
  const pythonInit = read('sdk/python/src/agoragentic/__init__.py');
  const pythonClient = read('sdk/python/src/agoragentic/client.py');

  assert.equal(nodePackage.version, '1.7.1');
  assert.equal(cliPackage.version, '1.7.1');
  assert.equal(cliPackage.dependencies.agoragentic, '^1.7.1');
  assert.equal(nodePackage.repository.directory, 'sdk/node');
  assert.equal(cliPackage.repository.directory, 'sdk/agent-os-cli');
  assert.match(pythonProject, /^version = "1\.7\.1"$/m);
  assert.match(pythonInit, /^__version__ = "1\.7\.1"$/m);
  assert.match(pythonClient, /^_SDK_VERSION = "1\.7\.1"$/m);
});

test('Node ESM source imports and exposes the documented entry contract', async () => {
  const entry = path.join(sdkRoot, 'node', 'index.mjs');
  const mod = await import(pathToFileURL(entry).href);
  assert.ok(mod.default);
  assert.equal(mod.agoragentic, mod.default);
  assert.equal(typeof mod.AgoragenticClient, 'function');
});

test('public package mirror excludes the obsolete root Python package and retired Syrin exports', () => {
  assert.equal(fs.existsSync(path.join(root, 'pyproject.toml')), false);
  assert.equal(fs.existsSync(path.join(root, 'src', 'agoragentic')), false);
  assert.match(read('.gitignore'), /^sdk\/python\/src\/\*\.egg-info\/$/m);

  const publicPackageFiles = [
    'sdk/node/package.json',
    'sdk/node/index.js',
    'sdk/node/index.d.ts',
    'sdk/python/pyproject.toml',
    'sdk/python/src/agoragentic/__init__.py',
  ];
  for (const relativePath of publicPackageFiles) {
    assert.doesNotMatch(read(relativePath), /syrin/i, `${relativePath} must not expose retired Syrin package APIs`);
  }
});

test('PyPI trusted publishing builds from the public sdk/python source', () => {
  const workflow = read('.github/workflows/publish-pypi.yml');
  assert.match(workflow, /working-directory: sdk\/python/);
  assert.match(workflow, /py-v\$\{package_version\}/);
  assert.match(workflow, /packages-dir: sdk\/python\/dist\//);
  assert.doesNotMatch(workflow, /password:|api-token:|PYPI_API_TOKEN/);
});

test('trusted publishers bind release tags through environment variables', () => {
  for (const relativePath of ['.github/workflows/publish-mcp.yml', '.github/workflows/publish-pypi.yml']) {
    const workflow = read(relativePath);
    assert.match(workflow, /RELEASE_TAG: \$\{\{ github\.event\.release\.tag_name \}\}/);
    assert.match(workflow, /test "\$\{RELEASE_TAG\}"/);
    assert.doesNotMatch(workflow, /test "\$\{\{ github\.event\.release\.tag_name \}\}"/);
  }
});
