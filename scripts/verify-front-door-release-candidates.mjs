import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_VERSION = '1.7.1';
const NODE_RC_VERSION = '1.8.0-rc.0';
const PYTHON_RC_VERSION = '1.8.0rc0';
const EXPECTED_ARTIFACTS = Object.freeze([
  'agoragentic-1.8.0-rc.0.tgz',
  'agoragentic-1.8.0rc0-py3-none-any.whl',
  'agoragentic-1.8.0rc0.tar.gz',
]);

function parseArtifactsDirectory(argv) {
  const index = argv.indexOf('--artifacts');
  if (index === -1 || !argv[index + 1] || index + 2 !== argv.length) {
    throw new Error('Usage: node scripts/verify-front-door-release-candidates.mjs --artifacts <directory>');
  }
  return path.resolve(argv[index + 1]);
}

function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    env: { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: '1', PYTHONDONTWRITEBYTECODE: '1' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function hash(file) {
  return `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`;
}

export function verifyManifest(directory) {
  const manifest = JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  const manifestKeys = Object.keys(manifest).sort();
  const expectedManifestKeys = [
    'artifacts',
    'node_version',
    'publish_authorized',
    'python_version',
    'schema',
    'source_version',
  ].sort();
  if (JSON.stringify(manifestKeys) !== JSON.stringify(expectedManifestKeys)
    || manifest.schema !== 'agoragentic.front-door-release-candidate-manifest.v1'
    || manifest.publish_authorized !== false
    || manifest.source_version !== SOURCE_VERSION
    || manifest.node_version !== NODE_RC_VERSION
    || manifest.python_version !== PYTHON_RC_VERSION
    || !Array.isArray(manifest.artifacts)) {
    throw new Error('Release-candidate manifest contract is invalid');
  }
  const names = manifest.artifacts.map(({ name }) => name).sort();
  if (JSON.stringify(names) !== JSON.stringify(EXPECTED_ARTIFACTS.slice().sort())) {
    throw new Error('Release-candidate manifest contains an unexpected artifact set');
  }
  const directoryEntries = readdirSync(directory, { withFileTypes: true });
  const directoryNames = directoryEntries.map(({ name }) => name).sort();
  const expectedDirectoryNames = ['manifest.json', ...EXPECTED_ARTIFACTS].sort();
  if (directoryEntries.some((entry) => !entry.isFile())
    || JSON.stringify(directoryNames) !== JSON.stringify(expectedDirectoryNames)) {
    throw new Error('Release-candidate directory contains an unexpected entry');
  }
  for (const artifact of manifest.artifacts) {
    if (Object.keys(artifact).sort().join(',') !== 'bytes,name,sha256'
      || !Number.isSafeInteger(artifact.bytes)
      || artifact.bytes < 1
      || !/^sha256:[a-f0-9]{64}$/.test(artifact.sha256)) {
      throw new Error(`Release-candidate manifest entry is invalid: ${artifact.name}`);
    }
    const artifactPath = path.join(directory, artifact.name);
    if (statSync(artifactPath).size !== artifact.bytes || hash(artifactPath) !== artifact.sha256) {
      throw new Error(`Release-candidate hash mismatch: ${artifact.name}`);
    }
  }
  return manifest;
}

function verifyNode(directory, manifest, cleanRoot) {
  const npmCommand = process.platform === 'win32' ? process.execPath : 'npm';
  const npmArgs = process.platform === 'win32'
    ? [path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')]
    : [];
  const project = path.join(cleanRoot, 'node-consumer');
  mkdirSync(project);
  const tarball = path.join(directory, manifest.artifacts.find(({ name }) => name.endsWith('.tgz')).name);
  run(npmCommand, [...npmArgs, 'init', '--yes'], project);
  run(npmCommand, [...npmArgs, 'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', tarball], project);
  const installedPackage = JSON.parse(readFileSync(path.join(project, 'node_modules', 'agoragentic', 'package.json'), 'utf8'));
  if (installedPackage.version !== manifest.node_version
    || installedPackage.bin.agoragentic !== 'agent-os.js'
    || installedPackage.bin['agoragentic-os'] !== 'agent-os.js'
    || installedPackage.bin.agora !== 'agent-os.js') {
    throw new Error('Installed Node release candidate lost its binary compatibility contract');
  }
  const installedIndex = readFileSync(path.join(project, 'node_modules', 'agoragentic', 'index.js'), 'utf8');
  const installedCli = readFileSync(path.join(project, 'node_modules', 'agoragentic', 'agent-os.js'), 'utf8');
  if (!installedIndex.includes(`const SDK_VERSION = '${manifest.node_version}';`)
    || !installedCli.includes(`agoragentic-os-cli/${manifest.node_version}`)
    || !installedCli.includes(`agora-cli/${manifest.node_version}`)) {
    throw new Error('Installed Node runtime identifiers do not match the candidate version');
  }
  const requireFromConsumer = createRequire(path.join(project, 'package.json'));
  const governance = requireFromConsumer('agoragentic/governance');
  const policy = governance.createDefaultPolicy();
  if (policy.authority.spend !== 'owner_only' || policy.authority.retry !== 'owner_only') {
    throw new Error('Installed Node governance policy delegated owner authority');
  }
  const cliOutput = run(npmCommand, [...npmArgs, 'exec', '--offline', '--', 'agoragentic', 'init', '--yes'], project);
  if (!JSON.parse(cliOutput).result.written) {
    throw new Error('Installed Node umbrella CLI did not produce a clean-room policy');
  }
  run(npmCommand, [...npmArgs, 'exec', '--offline', '--', 'agoragentic-os', '--help'], project);
  run(npmCommand, [...npmArgs, 'exec', '--offline', '--', 'agora', '--help'], project);
}

function verifyPython(directory, manifest, cleanRoot) {
  const pythonExecutable = process.env.PYTHON || 'python';
  const project = path.join(cleanRoot, 'python-consumer');
  const wheel = path.join(directory, manifest.artifacts.find(({ name }) => name.endsWith('.whl')).name);
  run(pythonExecutable, ['-m', 'venv', project], cleanRoot);
  const venvPython = process.platform === 'win32' ? path.join(project, 'Scripts', 'python.exe') : path.join(project, 'bin', 'python');
  run(venvPython, ['-m', 'pip', 'install', '--no-index', '--no-deps', wheel], project);
  const verifier = path.join(project, 'verify.py');
  writeFileSync(verifier, [
    'import json',
    'from pathlib import Path',
    'from agoragentic import __version__, create_default_policy, govern',
    'from agoragentic.client import _SDK_VERSION',
    `assert __version__ == ${JSON.stringify(manifest.python_version)}`,
    `assert _SDK_VERSION == ${JSON.stringify(manifest.python_version)}`,
    'policy = create_default_policy()',
    "policy['actions']['fixture.read'] = {'decision': 'allow'}",
    "safe_tool = govern(lambda value: {'accepted': True, 'value': value}, action='fixture.read', policy=policy, cwd='.')",
    "secret = 'clean-room-private-value'",
    'assert safe_tool(secret)["value"] == secret',
    "receipts = list(Path('.agoragentic/receipts').glob('*.json'))",
    'assert len(receipts) == 1',
    "raw = receipts[0].read_text(encoding='utf-8')",
    'receipt = json.loads(raw)',
    "assert receipt['classification'] == 'local_tool_evidence'",
    'assert secret not in raw',
  ].join('\n'), 'utf8');
  run(venvPython, [verifier], project);
}

function verify() {
  const artifactsDirectory = parseArtifactsDirectory(process.argv.slice(2));
  const manifest = verifyManifest(artifactsDirectory);
  const cleanRoot = mkdtempSync(path.join(tmpdir(), 'agoragentic-front-door-clean-room-'));
  try {
    verifyNode(artifactsDirectory, manifest, cleanRoot);
    verifyPython(artifactsDirectory, manifest, cleanRoot);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      network_registry_access: false,
      publication_performed: false,
      node_version: manifest.node_version,
      python_version: manifest.python_version,
      artifacts: readdirSync(artifactsDirectory).sort(),
    }, null, 2)}\n`);
  } finally {
    rmSync(cleanRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  verify();
}
