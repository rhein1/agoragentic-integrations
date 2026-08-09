#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TARGET_REPOSITORY = 'rhein1/agoragentic-harness-core';
const TARGET_REPOSITORY_URL = `https://github.com/${TARGET_REPOSITORY}`;
const TARGET_GIT_URL = `git+${TARGET_REPOSITORY_URL}.git`;

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${command} ${args.join(' ')} failed (${result.status})${detail ? `:\n${detail}` : ''}`);
  }
  return result.stdout.trim();
}

function git(cwd, ...args) {
  return run('git', args, cwd);
}

function copyDirectoryContents(source, destination) {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    cpSync(path.join(source, entry.name), path.join(destination, entry.name), {
      recursive: entry.isDirectory(),
      force: true,
    });
  }
}

function replaceRequired(text, from, to, label) {
  if (!text.includes(from)) throw new Error(`missing expected ${label} text`);
  return text.replaceAll(from, to);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value) throw new Error(`invalid argument near ${key || '<end>'}`);
    options[key.slice(2)] = value;
  }
  for (const required of ['source', 'source-ref', 'output']) {
    if (!options[required]) throw new Error(`--${required} is required`);
  }
  return options;
}

export function assertSafeExtractionPaths(sourceRoot, outputPath) {
  const source = realpathSync(sourceRoot);
  const output = path.resolve(outputPath);
  const relative = path.relative(source, output);
  if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new Error('output must be outside the source repository');
  }
  if (existsSync(output)) throw new Error('output must not already exist');
  return { source, output };
}

export function buildStandalonePackageJson(input) {
  const files = [...new Set([
    ...(Array.isArray(input.files) ? input.files : []),
    'CONTRIBUTING.md',
    'MIGRATION.md',
    'ROADMAP.md',
    'SECURITY.md',
    'examples/',
  ])];
  return {
    ...input,
    files,
    repository: {
      type: 'git',
      url: TARGET_GIT_URL,
    },
    homepage: TARGET_REPOSITORY_URL,
    bugs: {
      url: `${TARGET_REPOSITORY_URL}/issues`,
    },
  };
}

export function canonicalSourceRepository(remote) {
  const allowed = new Set([
    'https://github.com/rhein1/agoragentic-integrations',
    'https://github.com/rhein1/agoragentic-integrations.git',
    'git@github.com:rhein1/agoragentic-integrations.git',
    'ssh://git@github.com/rhein1/agoragentic-integrations.git',
  ]);
  const value = String(remote || '').trim();
  if (!allowed.has(value)) {
    throw new Error('source origin must be the public rhein1/agoragentic-integrations repository');
  }
  return 'https://github.com/rhein1/agoragentic-integrations';
}

export function rewriteStandaloneReadme(input) {
  let output = replaceRequired(
    input.replace(/\r\n/g, '\n'),
    'https://github.com/rhein1/agoragentic-integrations/tree/main/examples/harness-core-frameworks',
    'examples/frameworks/',
    'framework examples link',
  );
  output = replaceRequired(
    output,
    'git clone https://github.com/rhein1/agoragentic-integrations.git\ncd agoragentic-integrations/harness-core',
    'git clone https://github.com/rhein1/agoragentic-harness-core.git\ncd agoragentic-harness-core',
    'source checkout instructions',
  );
  output += [
    '',
    '## Standalone repository operations',
    '',
    '- [Migration from the integrations repository](MIGRATION.md)',
    '- [Contribution guide](CONTRIBUTING.md)',
    '- [Security policy](SECURITY.md)',
    '- [Roadmap](ROADMAP.md)',
    '',
  ].join('\n');
  return output;
}

export function prepareExtraction({ source, sourceRef, output }) {
  const sourceTopLevel = git(path.resolve(source), 'rev-parse', '--show-toplevel');
  const safe = assertSafeExtractionPaths(sourceTopLevel, output);
  const sourceCommit = git(safe.source, 'rev-parse', '--verify', `${sourceRef}^{commit}`);
  const sourceRemote = canonicalSourceRepository(git(safe.source, 'remote', 'get-url', 'origin'));
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'harness-core-extraction-'));
  const temporaryClone = path.join(temporaryRoot, 'source');
  let outputCreated = false;

  try {
    run('git', ['clone', '--no-local', '--no-checkout', safe.source, temporaryClone], temporaryRoot);
    git(temporaryClone, 'checkout', '--detach', sourceCommit);

    const overlayRoot = path.join(temporaryClone, 'extraction', 'harness-core', 'standalone-overlay');
    const examplesRoot = path.join(temporaryClone, 'examples', 'harness-core-frameworks');
    for (const required of [overlayRoot, examplesRoot]) {
      if (!existsSync(required) || !statSync(required).isDirectory()) {
        throw new Error(`required extraction input is missing: ${required}`);
      }
    }

    git(
      temporaryClone,
      'subtree',
      'split',
      '--prefix=harness-core',
      '--branch=harness-core-extracted',
      sourceCommit,
    );
    const extractedCommit = git(temporaryClone, 'rev-parse', 'harness-core-extracted^{commit}');

    mkdirSync(path.dirname(safe.output), { recursive: true });
    run(
      'git',
      ['clone', '--no-local', '--branch', 'harness-core-extracted', '--single-branch', temporaryClone, safe.output],
      temporaryRoot,
    );
    outputCreated = true;
    git(safe.output, 'remote', 'remove', 'origin');
    git(safe.output, 'branch', '-m', 'main');

    copyDirectoryContents(overlayRoot, safe.output);
    const standaloneExamples = path.join(safe.output, 'examples', 'frameworks');
    mkdirSync(path.dirname(standaloneExamples), { recursive: true });
    cpSync(examplesRoot, standaloneExamples, { recursive: true, force: true });

    const packagePath = path.join(safe.output, 'package.json');
    const packageJson = buildStandalonePackageJson(readJson(packagePath));
    writeJson(packagePath, packageJson);

    const readmePath = path.join(safe.output, 'README.md');
    writeFileSync(readmePath, rewriteStandaloneReadme(readFileSync(readmePath, 'utf8')), 'utf8');

    const releaseScopePath = path.join(safe.output, 'RELEASE_SCOPE.md');
    writeFileSync(
      releaseScopePath,
      replaceRequired(
        readFileSync(releaseScopePath, 'utf8'),
        'examples/harness-core-frameworks/framework-wrapping-examples.json',
        'examples/frameworks/framework-wrapping-examples.json',
        'release-scope framework examples path',
      ),
      'utf8',
    );

    const packSmokePath = path.join(safe.output, 'scripts', 'pack-smoke.mjs');
    writeFileSync(
      packSmokePath,
      replaceRequired(
        readFileSync(packSmokePath, 'utf8'),
        'node harness-core/scripts/pack-smoke.mjs',
        'node scripts/pack-smoke.mjs',
        'pack-smoke invocation',
      ),
      'utf8',
    );

    const historyCommitCount = Number(git(safe.output, 'rev-list', '--count', 'HEAD'));
    writeJson(path.join(safe.output, 'EXTRACTION_PROVENANCE.json'), {
      schema: 'agoragentic.harness-core.extraction-provenance.v1',
      source_repository: sourceRemote,
      source_commit: sourceCommit,
      source_subtree: 'harness-core',
      extracted_commit: extractedCommit,
      extracted_history_commit_count: historyCommitCount,
      package_name: packageJson.name,
      package_version: packageJson.version,
      target_repository: TARGET_REPOSITORY,
      state: 'owner_review_required',
      authority: {
        github_repository_created: false,
        remote_added: false,
        extracted_history_pushed: false,
        npm_published: false,
        npm_ownership_changed: false,
        release_created: false,
      },
    });

    const status = git(safe.output, 'status', '--porcelain=v1').split(/\r?\n/).filter(Boolean);
    const summary = {
      ok: true,
      output: safe.output,
      source_commit: sourceCommit,
      extracted_commit: extractedCommit,
      history_commit_count: historyCommitCount,
      package_version: packageJson.version,
      pending_owner_review_files: status,
      authority: 'local_preparation_only',
    };
    console.log(JSON.stringify(summary, null, 2));
    return summary;
  } catch (error) {
    if (outputCreated && existsSync(safe.output)) {
      rmSync(safe.output, { recursive: true, force: true });
    }
    throw error;
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    prepareExtraction({
      source: options.source,
      sourceRef: options['source-ref'],
      output: options.output,
    });
  } catch (error) {
    console.error(`HARNESS EXTRACTION PREP FAILED: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
