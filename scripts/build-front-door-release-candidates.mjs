import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const NODE_RC_VERSION = '1.8.0-rc.0';
export const PYTHON_RC_VERSION = '1.8.0rc0';
const SOURCE_VERSION = '1.7.1';

function parseOutputDirectory(argv) {
  const index = argv.indexOf('--output');
  if (index === -1 || !argv[index + 1] || index + 2 !== argv.length) {
    throw new Error('Usage: node scripts/build-front-door-release-candidates.mjs --output <empty-directory>');
  }
  return path.resolve(argv[index + 1]);
}

function ensureEmptyDirectory(directory) {
  mkdirSync(directory, { recursive: true });
  if (readdirSync(directory).length !== 0) {
    throw new Error(`Release-candidate output directory must be empty: ${directory}`);
  }
}

function replaceExactly(file, expected, replacement) {
  const source = readFileSync(file, 'utf8');
  if (source.split(expected).length - 1 !== 1) {
    throw new Error(`${file} must contain exactly one ${JSON.stringify(expected)} marker`);
  }
  writeFileSync(file, source.replace(expected, replacement), 'utf8');
}

function run(command, args, cwd) {
  execFileSync(command, args, {
    cwd,
    env: { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: '1', PYTHONDONTWRITEBYTECODE: '1' },
    stdio: 'inherit',
  });
}

function sha256(file) {
  return `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`;
}

function build() {
  const repositoryRoot = path.resolve(import.meta.dirname, '..');
  const outputDirectory = parseOutputDirectory(process.argv.slice(2));
  ensureEmptyDirectory(outputDirectory);
  const stagingRoot = mkdtempSync(path.join(tmpdir(), 'agoragentic-front-door-rc-'));
  const nodeStage = path.join(stagingRoot, 'node');
  const pythonStage = path.join(stagingRoot, 'python');
  const npmCommand = process.platform === 'win32' ? process.execPath : 'npm';
  const npmArgs = process.platform === 'win32'
    ? [path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')]
    : [];
  const pythonExecutable = process.env.PYTHON || 'python';

  try {
    cpSync(path.join(repositoryRoot, 'sdk', 'node'), nodeStage, { recursive: true });
    cpSync(path.join(repositoryRoot, 'sdk', 'python'), pythonStage, { recursive: true });

    const nodePackagePath = path.join(nodeStage, 'package.json');
    const nodePackage = JSON.parse(readFileSync(nodePackagePath, 'utf8'));
    if (nodePackage.version !== SOURCE_VERSION) {
      throw new Error(`Expected Node source version ${SOURCE_VERSION}; received ${nodePackage.version}`);
    }
    nodePackage.version = NODE_RC_VERSION;
    writeFileSync(nodePackagePath, `${JSON.stringify(nodePackage, null, 2)}\n`, 'utf8');
    replaceExactly(path.join(nodeStage, 'index.js'), `const SDK_VERSION = '${SOURCE_VERSION}';`, `const SDK_VERSION = '${NODE_RC_VERSION}';`);
    replaceExactly(path.join(nodeStage, 'agent-os.js'), "'User-Agent': 'agoragentic-os-cli/1.6.5'", `'User-Agent': 'agoragentic-os-cli/${NODE_RC_VERSION}'`);
    replaceExactly(path.join(nodeStage, 'agent-os.js'), "'User-Agent': 'agora-cli/1.6.5'", `'User-Agent': 'agora-cli/${NODE_RC_VERSION}'`);

    replaceExactly(path.join(pythonStage, 'pyproject.toml'), `version = "${SOURCE_VERSION}"`, `version = "${PYTHON_RC_VERSION}"`);
    replaceExactly(path.join(pythonStage, 'src', 'agoragentic', '__init__.py'), `__version__ = "${SOURCE_VERSION}"`, `__version__ = "${PYTHON_RC_VERSION}"`);
    replaceExactly(path.join(pythonStage, 'src', 'agoragentic', 'client.py'), `_SDK_VERSION = "${SOURCE_VERSION}"`, `_SDK_VERSION = "${PYTHON_RC_VERSION}"`);

    run(npmCommand, [...npmArgs, 'pack', '--pack-destination', outputDirectory], nodeStage);
    run(pythonExecutable, ['-m', 'build', '--no-isolation', '--outdir', outputDirectory, pythonStage], repositoryRoot);

    const artifacts = readdirSync(outputDirectory)
      .filter((name) => name !== 'manifest.json')
      .sort()
      .map((name) => {
        const artifactPath = path.join(outputDirectory, name);
        if (!statSync(artifactPath).isFile()) throw new Error(`Unexpected artifact entry: ${name}`);
        return { name, bytes: statSync(artifactPath).size, sha256: sha256(artifactPath) };
      });
    const expected = [
      `agoragentic-${NODE_RC_VERSION}.tgz`,
      `agoragentic-${PYTHON_RC_VERSION}.tar.gz`,
      `agoragentic-${PYTHON_RC_VERSION}-py3-none-any.whl`,
    ].sort();
    if (JSON.stringify(artifacts.map(({ name }) => name)) !== JSON.stringify(expected)) {
      throw new Error(`Unexpected release-candidate artifacts: ${artifacts.map(({ name }) => name).join(', ')}`);
    }
    const manifest = {
      schema: 'agoragentic.front-door-release-candidate-manifest.v1',
      publish_authorized: false,
      source_version: SOURCE_VERSION,
      node_version: NODE_RC_VERSION,
      python_version: PYTHON_RC_VERSION,
      artifacts,
    };
    writeFileSync(path.join(outputDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

build();
