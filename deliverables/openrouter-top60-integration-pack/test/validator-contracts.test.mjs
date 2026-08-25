import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { afterEach } from 'node:test';
import { validatePack } from '../scripts/validate.mjs';

const sourceRoot = fileURLToPath(new URL('..', import.meta.url));
const temporaryRoots = [];
const blockedHostDecisionPath = 'decisions/blocked-qualified-host-enforcement.json';
const mcpPackageName = `agoragentic-${'mcp'}`;

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
    summary: { entries: 60, decisions: 58, files: result.summary.files }
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

test('catalog schema must be an object', async () => {
  for (const malformed of [[], null, 'not-an-object']) {
    const root = await copyPack();
    await writeJson(root, 'catalog/schema.json', malformed);
    assertRejected(await validatePack(root), 'catalog/schema.json must be an object');
  }
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

test('versioned MCP registry coordinates are rejected from blocker records', async () => {
  const root = await copyPack();
  const packet = await readJson(root, blockedHostDecisionPath);
  packet.items[0].required_controls[0] = `Do not install ${mcpPackageName}@9.9.9`;
  await writeJson(root, blockedHostDecisionPath, packet);
  assertRejected(
    await validatePack(root),
    `${blockedHostDecisionPath}.items[0].required_controls[0] must not contain a versioned agoragentic-mcp registry coordinate`
  );
});

test('equivalent npx MCP launch forms are rejected from blocker text', async () => {
  const commands = [
    `npx --yes ${mcpPackageName}`,
    `npx -- ${mcpPackageName}`,
    `npx.cmd --yes ${mcpPackageName}`,
    `npx "${mcpPackageName}" --stdio`,
    `npx "agoragentic"-mcp --stdio`,
    `npx ${mcpPackageName}&& echo unsafe`,
    `npx --package=${mcpPackageName} harmless`,
    `npx --package=alias@npm:${mcpPackageName} alias`,
    `npx -p ${mcpPackageName} harmless`,
    `npx.ps1 ${mcpPackageName}`,
    `npm exec ${mcpPackageName}`,
    `npm --prefix ./tmp exec ${mcpPackageName}`,
    `pnpm dlx ${mcpPackageName}`,
    `pnpm --dir ./tmp dlx ${mcpPackageName}`,
    `yarn dlx ${mcpPackageName}`,
    `bunx ${mcpPackageName}`,
    `pnpx ${mcpPackageName}`,
    `bun x ${mcpPackageName}`,
    `sh -c 'npx ${mcpPackageName}'`,
    `bash -lc "npx ${mcpPackageName}"`,
    `cmd /c "npx ${mcpPackageName}"`,
    `powershell -Command "npx ${mcpPackageName}"`,
  ];
  for (const command of commands) {
    const root = await copyPack();
    const packet = await readJson(root, blockedHostDecisionPath);
    packet.items[0].required_controls[0] = `Run ${command}`;
    await writeJson(root, blockedHostDecisionPath, packet);
    assertRejected(
      await validatePack(root),
      `${blockedHostDecisionPath}.items[0].required_controls[0] must not contain a registry-resolving agoragentic-mcp command`
    );
  }
});

test('split npx MCP arguments are rejected structurally', async () => {
  for (const configuration of [
    { command: 'npx.cmd', args: ['--yes', mcpPackageName] },
    { command: 'npx', args: { nested: ['--yes', mcpPackageName] } },
  ]) {
    const root = await copyPack();
    const packet = await readJson(root, blockedHostDecisionPath);
    packet.items[0].configuration = configuration;
    await writeJson(root, blockedHostDecisionPath, packet);
    assertRejected(
      await validatePack(root),
      `${blockedHostDecisionPath}.items[0].configuration must not contain split npx arguments for agoragentic-mcp`
    );
  }
});

test('direct MCP endpoints are rejected from blocker records', async () => {
  for (const endpoint of [
    `https://agoragentic.com/api/${'mcp'}`,
    `https://agoragentic.com:443/api/${'mcp'}`,
    `https://agoragentic.com/api/%6dcp`,
    `https://agoragentic.com/API/${'MCP'}`,
    `https://www.agoragentic.com/api/${'mcp'}`,
    String.raw`https:\agoragentic.com\api\mcp`,
  ]) {
    const root = await copyPack();
    const packet = await readJson(root, blockedHostDecisionPath);
    packet.items[0].required_controls[0] = `Configure ${endpoint} in this host`;
    await writeJson(root, blockedHostDecisionPath, packet);
    assertRejected(
      await validatePack(root),
      `${blockedHostDecisionPath}.items[0].required_controls[0] must not contain the direct hosted MCP endpoint`
    );
  }
});

test('credential and authorization forwarding are rejected from blocker records', async () => {
  const root = await copyPack();
  const packet = await readJson(root, blockedHostDecisionPath);
  packet.items[0].configuration = {
    headers: { Authorization: `Bearer \${AGORAGENTIC_${'API_KEY'}}` }
  };
  await writeJson(root, blockedHostDecisionPath, packet);
  assertRejected(
    await validatePack(root),
    `${blockedHostDecisionPath}.items[0].configuration.headers must not forward MCP credentials or authorization headers`
  );
});

test('enabled MCP configuration is rejected from blocker records', async () => {
  const root = await copyPack();
  const packet = await readJson(root, blockedHostDecisionPath);
  packet.items[0].configuration = { enabled: true };
  await writeJson(root, blockedHostDecisionPath, packet);
  assertRejected(
    await validatePack(root),
    `${blockedHostDecisionPath}.items[0].configuration.enabled must not enable an MCP configuration`
  );
});

test('restored ready_config status and host-configs artifact are rejected', async () => {
  const root = await copyPack();
  const entries = await readJson(root, 'catalog/entries-01.json');
  entries[2].status = 'ready_config';
  entries[2].artifact = 'host-configs.json';
  await writeJson(root, 'catalog/entries-01.json', entries);
  await writeJson(root, 'host-configs.json', { status: 'candidate_only', hosts: [] });
  const result = await validatePack(root);
  assertRejected(result, 'catalog/entries-01.json[2].status ready_config is forbidden pending qualified host enforcement');
  assert.ok(result.errors.includes('catalog/entries-01.json[2].artifact must not reference host-configs.json'));
  assert.ok(result.errors.includes('host-configs.json is forbidden pending qualified host enforcement'));
});

test('renamed manifest-declared MCP configurations are inspected and rejected', async () => {
  const root = await copyPack();
  await writeJson(root, 'mcp-host.json', {
    enabled: true,
    url: `https://agoragentic.com:443/api/${'mcp'}`,
    headers: { Authorization: `Bearer \${AGORAGENTIC_${'API_KEY'}}` },
  });
  await reconcileManifest(root);
  const result = await validatePack(root);
  assertRejected(result, 'pack-manifest.json.files must equal the closed review-pack inventory');
  assert.ok(result.errors.includes('mcp-host.json.enabled must not enable an MCP configuration'));
  assert.ok(result.errors.includes('mcp-host.json.url must not contain the direct hosted MCP endpoint'));
  assert.ok(result.errors.includes('mcp-host.json.headers must not forward MCP credentials or authorization headers'));
});

test('pack files may not escape through symbolic links', async () => {
  const root = await copyPack();
  const externalRoot = await mkdtemp(path.join(tmpdir(), 'agoragentic-openrouter-outside-'));
  temporaryRoots.push(externalRoot);
  const outside = path.join(externalRoot, 'catalog');
  const target = path.join(root, 'catalog');
  await cp(target, outside, { recursive: true });
  await rm(target, { recursive: true, force: true });
  await symlink(outside, target, 'junction');
  const result = await validatePack(root);
  assertRejected(result, 'catalog/entries-01.json must not traverse symbolic links');
  assert.ok(result.errors.includes('pack file inventory must not contain symbolic links: catalog'));
});

test('direct adapters are pinned to their exact catalog artifacts', async () => {
  const root = await copyPack();
  const entries02 = await readJson(root, 'catalog/entries-02.json');
  const entries06 = await readJson(root, 'catalog/entries-06.json');
  const codebuff = entries02.find((entry) => entry.slug === 'codebuff');
  const oration = entries06.find((entry) => entry.slug === 'oration-ai');
  [codebuff.artifact, oration.artifact] = [oration.artifact, codebuff.artifact];
  await writeJson(root, 'catalog/entries-02.json', entries02);
  await writeJson(root, 'catalog/entries-06.json', entries06);
  const result = await validatePack(root);
  assertRejected(result, 'catalog entry codebuff.artifact must be adapters/codebuff-tools.ts');
  assert.ok(result.errors.includes('catalog entry oration-ai.artifact must be adapters/oration-client.mjs'));
});

test('malformed decision collections return structured validation errors instead of throwing', async () => {
  for (const malformed of [{}, 'not-an-array', null]) {
    const root = await copyPack();
    const packet = await readJson(root, 'decisions/covered-existing.json');
    packet.items = malformed;
    await writeJson(root, 'decisions/covered-existing.json', packet);
    assertRejected(
      await validatePack(root),
      'decisions/covered-existing.json.items must contain exactly 5 entries',
    );
  }
});

test('mismatched blocker records are rejected', async () => {
  const root = await copyPack();
  const packet = await readJson(root, blockedHostDecisionPath);
  const originalSlug = packet.items[0].slug;
  packet.items[0].slug = `${originalSlug}-mismatch`;
  await writeJson(root, blockedHostDecisionPath, packet);
  assertRejected(await validatePack(root), `catalog entry ${originalSlug} has no matching decision record`);
});

test('blocker action drift from the catalog is rejected', async () => {
  const root = await copyPack();
  const packet = await readJson(root, blockedHostDecisionPath);
  const slug = packet.items[0].slug;
  packet.items[0].action = 'Unreviewed blocker action';
  await writeJson(root, blockedHostDecisionPath, packet);
  assertRejected(await validatePack(root), `decision ${slug}.action does not match catalog`);
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
