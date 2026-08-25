import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { afterEach } from 'node:test';
import { validatePack } from '../scripts/validate.mjs';

const sourceRoot = fileURLToPath(new URL('..', import.meta.url));
const temporaryRoots = [];

async function readJson(root, relativePath) {
  return JSON.parse(await readFile(path.join(root, ...relativePath.split('/')), 'utf8'));
}

async function writeJson(root, relativePath, value) {
  await writeFile(path.join(root, ...relativePath.split('/')), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function collectFiles(root) {
  const files = [];
  async function walk(directory, prefix = '') {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isDirectory() && ['.git', 'node_modules', 'coverage'].includes(entry.name)) continue;
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), relativePath);
      else files.push(relativePath);
    }
  }
  await walk(root);
  return files.sort();
}

async function reconcileManifest(root) {
  const manifest = await readJson(root, 'pack-manifest.json');
  manifest.files = await collectFiles(root);
  manifest.file_count = manifest.files.length;
  await writeJson(root, 'pack-manifest.json', manifest);
}

async function copyPack() {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'agoragentic-openrouter-pack-'));
  temporaryRoots.push(temporaryRoot);
  const root = path.join(temporaryRoot, 'pack');
  await cp(sourceRoot, root, {
    recursive: true,
    filter(source) {
      const relative = path.relative(sourceRoot, source);
      if (!relative) return true;
      return !relative
        .split(path.sep)
        .some((part) => ['.git', 'node_modules', 'coverage'].includes(part));
    },
  });
  await reconcileManifest(root);
  return root;
}

function assertRejected(result, expectedError) {
  assert.equal(result.ok, false, 'mutated pack must be rejected');
  assert.ok(result.errors.includes(expectedError), `expected error not found:\n${result.errors.join('\n')}`);
}

afterEach(async () => {
  const roots = temporaryRoots.splice(0);
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })));
});

test('reconciled review pack passes the deterministic validator without network access', async () => {
  const root = await copyPack();
  const result = await validatePack(root);
  assert.deepEqual(result, {
    ok: true,
    errors: [],
    summary: { entries: 60, hosts: 12, decisions: 46, files: result.summary.files }
  });
  assert.ok(result.summary.files >= 31);
});

test('missing authority is rejected fail closed', async () => {
  const root = await copyPack();
  const index = await readJson(root, 'catalog/index.json');
  delete index.authority;
  await writeJson(root, 'catalog/index.json', index);
  assertRejected(await validatePack(root), 'catalog/index.json.authority is required');
});

test('manifest count and file-list contradictions are rejected', async () => {
  const root = await copyPack();
  const manifest = await readJson(root, 'pack-manifest.json');
  manifest.file_count += 1;
  manifest.files = manifest.files.filter(file => file !== 'catalog/source-evidence.json');
  await writeJson(root, 'pack-manifest.json', manifest);
  const result = await validatePack(root);
  assertRejected(result, 'pack-manifest.json.file_count must equal files.length');
  assert.ok(result.errors.includes('pack-manifest.json.files is missing: catalog/source-evidence.json'));
});

test('catalog status drift from its decision packet is rejected', async () => {
  const root = await copyPack();
  const entries = await readJson(root, 'catalog/entries-01.json');
  entries[0].status = 'deprecated';
  await writeJson(root, 'catalog/entries-01.json', entries);
  assertRejected(await validatePack(root), 'decision hermes-agent.group does not match catalog status');
});

test('catalog action drift from its decision packet is rejected', async () => {
  const root = await copyPack();
  const entries = await readJson(root, 'catalog/entries-01.json');
  entries[6].action = 'Unreviewed replacement action';
  await writeJson(root, 'catalog/entries-01.json', entries);
  assertRejected(await validatePack(root), 'decision descript.action does not match catalog');
});

test('runtime verification claims are rejected at item level', async () => {
  const root = await copyPack();
  const decisions = await readJson(root, 'decisions/covered-existing.json');
  decisions.items[0].runtime_verified = true;
  await writeJson(root, 'decisions/covered-existing.json', decisions);
  assertRejected(
    await validatePack(root),
    'decisions/covered-existing.json.items[0].runtime_verified must be false'
  );
});

test('malformed dates and part metadata are rejected', async () => {
  const root = await copyPack();
  const index = await readJson(root, 'catalog/index.json');
  index.snapshot_date = '2026-02-30';
  index.parts[0].first_rank = 0;
  index.parts[0].count = 9;
  await writeJson(root, 'catalog/index.json', index);
  const result = await validatePack(root);
  assertRejected(result, 'catalog/index.json.snapshot_date must be a real calendar date');
  assert.ok(result.errors.includes('catalog/index.json.parts[0].first_rank must be 1'));
  assert.ok(result.errors.includes('catalog/index.json.parts[0].count must be 10'));
});

test('ranking provenance cannot claim preserved evidence or drift from the catalog projection', async () => {
  const root = await copyPack();
  const provenance = await readJson(root, 'catalog/source-evidence.json');
  provenance.independently_reproducible = true;
  provenance.transcription.catalog_projection_sha256 = '0'.repeat(64);
  await writeJson(root, 'catalog/source-evidence.json', provenance);
  const result = await validatePack(root);
  assertRejected(result, 'catalog/source-evidence.json.independently_reproducible must be false');
  assert.ok(result.errors.includes('catalog/source-evidence.json.transcription.catalog_projection_sha256 does not match the catalog projection'));
});
