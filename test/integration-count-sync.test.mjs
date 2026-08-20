import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  planIntegrationCountSync,
  verifyIntegrationCountSync,
} from '../scripts/sync-integration-counts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'integrations.json'), 'utf8'));

test('all public count surfaces match the canonical inventory', () => {
  const result = verifyIntegrationCountSync();
  assert.equal(result.ok, true);
  assert.deepEqual(result.updates.filter((update) => update.changed), []);
});

test('an inventory change makes every projected count surface stale', () => {
  const changed = structuredClone(manifest);
  changed.integrations.push({ id: 'fixture-only' });
  const updates = planIntegrationCountSync({ manifest: changed });
  assert.deepEqual(
    updates.filter((update) => update.changed).map((update) => update.path).sort(),
    [
      'INTEGRATION_CATALOG_GUIDE.md',
      'README.md',
      'assets/agoragentic-agent-commerce-banner.svg',
      'ecosystem.json',
      'llms-full.txt',
      'llms.txt',
    ],
  );
});

test('missing projection markers fail closed instead of silently skipping copy', () => {
  assert.throws(
    () => planIntegrationCountSync({
      manifest,
      readFile(relativePath) {
        if (relativePath === 'README.md') return 'marker removed';
        return fs.readFileSync(path.join(root, relativePath), 'utf8');
      },
    }),
    /expected one root README inventory count marker/,
  );
});
