import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertSafeExtractionPaths,
  buildStandalonePackageJson,
  canonicalSourceRepository,
  parseArguments,
  rewriteStandaloneReadme,
} from '../scripts/prepare-harness-core-extraction.mjs';

test('argument parsing requires source, source-ref, and output', () => {
  assert.deepEqual(
    parseArguments(['--source', '.', '--source-ref', 'HEAD', '--output', '../out']),
    { source: '.', 'source-ref': 'HEAD', output: '../out' },
  );
  assert.throws(() => parseArguments(['--source', '.']), /--source-ref is required/);
  assert.throws(() => parseArguments(['source', '.']), /invalid argument/);
});

test('source provenance accepts only the public integrations origin', () => {
  assert.equal(
    canonicalSourceRepository('git@github.com:rhein1/agoragentic-integrations.git'),
    'https://github.com/rhein1/agoragentic-integrations',
  );
  assert.equal(
    canonicalSourceRepository('https://github.com/rhein1/agoragentic-integrations.git'),
    'https://github.com/rhein1/agoragentic-integrations',
  );
  assert.throws(
    () => canonicalSourceRepository('https://token@example.com/rhein1/agoragentic-integrations.git'),
    /public rhein1\/agoragentic-integrations/,
  );
  assert.throws(() => canonicalSourceRepository('C:\\private\\clone'), /public rhein1\/agoragentic-integrations/);
});

test('extraction output must be absent and outside the source repository', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'harness-extraction-paths-'));
  const source = path.join(root, 'source');
  const sibling = path.join(root, 'standalone');
  mkdirSync(source);
  try {
    const safe = assertSafeExtractionPaths(source, sibling);
    assert.equal(safe.output, sibling);
    assert.throws(() => assertSafeExtractionPaths(source, source), /outside/);
    assert.throws(() => assertSafeExtractionPaths(source, path.join(source, 'nested')), /outside/);
    mkdirSync(sibling);
    assert.throws(() => assertSafeExtractionPaths(source, sibling), /must not already exist/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('standalone metadata removes monorepo ownership and includes moved docs and examples', () => {
  const output = buildStandalonePackageJson({
    name: 'agoragentic-harness-core',
    version: '0.3.0',
    files: ['README.md'],
    repository: {
      type: 'git',
      url: 'git+https://github.com/rhein1/agoragentic-integrations.git',
      directory: 'harness-core',
    },
  });
  assert.deepEqual(output.repository, {
    type: 'git',
    url: 'git+https://github.com/rhein1/agoragentic-harness-core.git',
  });
  assert.equal(output.homepage, 'https://github.com/rhein1/agoragentic-harness-core');
  assert.equal(output.bugs.url, 'https://github.com/rhein1/agoragentic-harness-core/issues');
  for (const shipped of ['CONTRIBUTING.md', 'MIGRATION.md', 'ROADMAP.md', 'SECURITY.md', 'examples/']) {
    assert.ok(output.files.includes(shipped));
  }
});

test('standalone README rewrite moves checkout and framework-example links', () => {
  const source = [
    '# Agoragentic Harness Core',
    'https://github.com/rhein1/agoragentic-integrations/tree/main/examples/harness-core-frameworks',
    'git clone https://github.com/rhein1/agoragentic-integrations.git',
    'cd agoragentic-integrations/harness-core',
  ].join('\r\n');
  const output = rewriteStandaloneReadme(source);
  assert.match(output, /examples\/frameworks\//);
  assert.match(output, /git clone https:\/\/github\.com\/rhein1\/agoragentic-harness-core\.git/);
  assert.match(output, /Standalone repository operations/);
  assert.doesNotMatch(output, /agoragentic-integrations\/tree\/main\/examples\/harness-core-frameworks/);
});
