#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TARGET_GIT_URL = 'git+https://github.com/rhein1/agoragentic-harness-core.git';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

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

function runNpm(args, cwd) {
  if (process.platform !== 'win32') return run('npm', args, cwd);
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean);
  const npmCli = candidates.find((candidate) => existsSync(candidate));
  if (!npmCli) throw new Error('unable to locate npm-cli.js for direct execution');
  return run(process.execPath, [npmCli, ...args], cwd);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function requireText(root, relativePath) {
  const target = path.join(root, relativePath);
  assert(existsSync(target), `required file is missing: ${relativePath}`);
  return readFileSync(target, 'utf8');
}

export function parseArguments(argv) {
  if (argv.length !== 2 || argv[0] !== '--repo' || !argv[1]) {
    throw new Error('usage: node scripts/verify-harness-core-extraction.mjs --repo <path>');
  }
  return { repo: path.resolve(argv[1]) };
}

export function verifyStaticExtraction(repo) {
  assert(existsSync(path.join(repo, '.git')), 'extracted repository must retain Git history');
  assert(!existsSync(path.join(repo, 'harness-core')), 'canonical package must be at repository root');

  const requiredFiles = [
    '.github/CODEOWNERS',
    '.github/ISSUE_TEMPLATE/bug.yml',
    '.github/ISSUE_TEMPLATE/config.yml',
    '.github/pull_request_template.md',
    '.github/workflows/ci.yml',
    '.github/workflows/publish.yml',
    '.gitignore',
    'CONTRIBUTING.md',
    'EXTRACTION_PROVENANCE.json',
    'LICENSE',
    'MIGRATION.md',
    'README.md',
    'ROADMAP.md',
    'SECURITY.md',
    'TRUSTED_PUBLISHING.md',
    'examples/frameworks/README.md',
    'examples/frameworks/framework-wrapping-examples.json',
    'examples/frameworks/validate.mjs',
    'package-lock.json',
    'package.json',
  ];
  for (const relativePath of requiredFiles) requireText(repo, relativePath);

  const pkg = readJson(path.join(repo, 'package.json'));
  assert(pkg.name === 'agoragentic-harness-core', 'unexpected package name');
  assert(pkg.version === '0.3.0', 'standalone candidate must remain version 0.3.0');
  assert(pkg.repository?.type === 'git', 'repository type must be git');
  assert(pkg.repository?.url === TARGET_GIT_URL, 'package repository must point to the standalone repo');
  assert(!Object.hasOwn(pkg.repository, 'directory'), 'standalone package must not declare repository.directory');
  assert(pkg.homepage === 'https://github.com/rhein1/agoragentic-harness-core', 'unexpected homepage');
  assert(pkg.bugs?.url === 'https://github.com/rhein1/agoragentic-harness-core/issues', 'unexpected issue URL');
  for (const shipped of ['CONTRIBUTING.md', 'MIGRATION.md', 'ROADMAP.md', 'SECURITY.md', 'examples/']) {
    assert(pkg.files.includes(shipped), `package files[] must include ${shipped}`);
  }

  const readme = requireText(repo, 'README.md');
  assert(readme.includes('Put a policy gate and a receipt around any agent action.'), 'flagship heading is missing');
  assert(
    readme.includes('intent → policy → approval → host tool → evidence → local receipt'),
    'flagship flow is missing',
  );
  assert(readme.includes('Host execution is outside the generic `run` path.'), 'host executor boundary is missing');
  assert(
    readme.includes('Local receipts are not settlement receipts, certifications, endorsements, or marketplace verification.'),
    'local receipt boundary is missing',
  );
  assert(readme.includes('examples/frameworks/'), 'standalone examples link is missing');
  assert(!readme.includes('agoragentic-integrations/tree/main/examples/harness-core-frameworks'), 'old example link remains');

  const ci = requireText(repo, '.github/workflows/ci.yml');
  for (const token of ['AGORAGENTIC_NO_SPEND: 1', 'AGORAGENTIC_ALLOW_REAL_SPEND: 0', 'AGORAGENTIC_ALLOW_NETWORK_CANARIES: 0']) {
    assert(ci.includes(token), `CI safety setting is missing: ${token}`);
  }
  assert(ci.includes('node-version: [20, 22, 24]'), 'CI must cover Node 20, 22, and 24');
  assert(ci.includes('npm run pack:smoke'), 'CI pack smoke is missing');

  const publish = requireText(repo, '.github/workflows/publish.yml');
  assert(publish.includes('types: [published]'), 'publish must be release-only');
  assert(publish.includes('id-token: write'), 'trusted publishing needs id-token: write');
  assert(publish.includes('npm publish --access public --provenance'), 'provenance publish command is missing');
  assert(publish.includes('expected="v${version}"'), 'publish tag must exactly match package version');
  assert(!/(?:NPM_TOKEN|NODE_AUTH_TOKEN|_authToken)/.test(publish), 'publish workflow must not use a long-lived npm token');

  const provenance = readJson(path.join(repo, 'EXTRACTION_PROVENANCE.json'));
  assert(provenance.schema === 'agoragentic.harness-core.extraction-provenance.v1', 'unexpected provenance schema');
  assert(
    provenance.source_repository === 'https://github.com/rhein1/agoragentic-integrations',
    'unexpected or unsafe source repository provenance',
  );
  assert(provenance.source_subtree === 'harness-core', 'unexpected source subtree');
  assert(provenance.target_repository === 'rhein1/agoragentic-harness-core', 'unexpected target repository');
  assert(provenance.package_name === pkg.name && provenance.package_version === pkg.version, 'package provenance mismatch');
  assert(provenance.state === 'owner_review_required', 'prepared extraction must remain owner-review gated');
  assert(Object.values(provenance.authority).every((value) => value === false), 'preparation must grant no release authority');

  return { pkg, provenance };
}

export function verifyExtraction(repo) {
  const { pkg, provenance } = verifyStaticExtraction(repo);
  const remotes = run('git', ['remote'], repo);
  assert(remotes === '', 'prepared extraction must not retain or add a Git remote');

  const historyCommitCount = Number(run('git', ['rev-list', '--count', 'HEAD'], repo));
  const packageHistoryCount = Number(run('git', ['log', '--format=%H', '--', 'package.json'], repo).split(/\r?\n/).filter(Boolean).length);
  assert(historyCommitCount > 1, 'filtered history must contain more than one commit');
  assert(packageHistoryCount > 1, 'package.json history was not preserved');
  assert(historyCommitCount === provenance.extracted_history_commit_count, 'history count does not match provenance');

  runNpm(['ci', '--no-audit', '--no-fund'], repo);
  runNpm(['test'], repo);
  run(process.execPath, ['examples/frameworks/validate.mjs'], repo);
  runNpm(['run', 'pack:smoke'], repo);
  const pack = JSON.parse(runNpm(['pack', '--dry-run', '--json'], repo));
  assert(Array.isArray(pack) && pack.length === 1, 'npm pack dry run returned an unexpected payload');
  assert(pack[0].name === pkg.name && pack[0].version === pkg.version, 'npm pack identity mismatch');
  assert(pack[0].files.some((entry) => entry.path === 'examples/frameworks/framework-wrapping-examples.json'), 'framework examples are missing from the package');

  const summary = {
    ok: true,
    repository: repo,
    package: `${pkg.name}@${pkg.version}`,
    history_commit_count: historyCommitCount,
    package_history_commit_count: packageHistoryCount,
    packed_file_count: pack[0].files.length,
    remote_count: 0,
    authority: 'validation_only',
  };
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

function main() {
  try {
    const { repo } = parseArguments(process.argv.slice(2));
    verifyExtraction(repo);
  } catch (error) {
    console.error(`HARNESS EXTRACTION VERIFY FAILED: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
