import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const checker = path.join(repoRoot, 'scripts', 'verify-doc-links.mjs');

function runFixture(readme, files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-links-'));
  fs.writeFileSync(path.join(root, 'README.md'), readme, 'utf8');
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolute = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, contents, 'utf8');
  }
  const result = spawnSync(process.execPath, [checker], {
    cwd: root,
    encoding: 'utf8',
  });
  fs.rmSync(root, { recursive: true, force: true });
  return result;
}

test('accepts balanced and escaped parentheses in inline destinations', () => {
  const result = runFixture(
    '[balanced](docs/foo_(bar).md)\n\n[escaped](docs/foo_\\(bar\\).md)\n',
    { 'docs/foo_(bar).md': '# Parentheses\n' },
  );

  assert.equal(result.status, 0, result.stderr);
});

test('keeps shorter fence markers inside a longer outer fence', () => {
  const result = runFixture('````markdown\n```text\n[ignored](missing.md)\n```\n````\n');

  assert.equal(result.status, 0, result.stderr);
});

test('still rejects a missing documentation target', () => {
  const result = runFixture('[missing](missing.md)\n');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing missing\.md/);
});
