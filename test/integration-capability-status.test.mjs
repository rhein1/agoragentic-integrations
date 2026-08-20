import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  renderCapabilityStatus,
  verifyCapabilityStatus,
} from '../scripts/generate-integration-capability-status.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'integrations.json'), 'utf8'));
const expected = fs.readFileSync(
  path.join(root, 'docs', 'INTEGRATION_CAPABILITY_STATUS.md'),
  'utf8',
);

test('generated capability status matches the machine inventory', () => {
  const result = verifyCapabilityStatus({ manifest, expected });
  assert.equal(result.ok, true);
  assert.equal(result.generated, expected);
});

test('generated capability status retains proof and authority boundaries', () => {
  const rendered = renderCapabilityStatus(manifest);
  assert.match(rendered, /do not grant authority/i);
  assert.match(rendered, /Codex Harness Mapping Stub.*none.*documented.*none/);
  assert.match(rendered, /OpenCode Harness Plugin.*experimental.*local/);
  assert.doesNotMatch(rendered, /Codex Harness Mapping Stub.*host_enforced/);
  assert.doesNotMatch(rendered, /settlement \|/);
});

test('a machine-record change makes the committed status stale', () => {
  const changed = structuredClone(manifest);
  changed.integrations.find((entry) => entry.id === 'crewai')
    .capability_record.capabilities.router_client = 'tested';
  assert.notEqual(renderCapabilityStatus(changed), expected);
});
