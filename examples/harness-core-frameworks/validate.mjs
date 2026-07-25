import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const inventory = JSON.parse(
  await readFile(new URL('./framework-wrapping-examples.json', import.meta.url), 'utf8'),
);

assert.equal(inventory.schema, 'agoragentic.harness.framework-wrapping-examples.v1');
assert.equal(inventory.not_framework_replacement, true);
assert.ok(Array.isArray(inventory.examples) && inventory.examples.length > 0);

const ids = new Set();
for (const example of inventory.examples) {
  assert.match(example.id, /^[a-z0-9_]+$/);
  assert.equal(ids.has(example.id), false, `duplicate example id: ${example.id}`);
  ids.add(example.id);
  assert.equal(example.framework_replacement, false);
  assert.equal(example.agent_os_preview_only, true);
  assert.ok(Array.isArray(example.wraps) && example.wraps.length > 0);
  assert.ok(Array.isArray(example.harness_outputs) && example.harness_outputs.length > 0);
  assert.deepEqual(example.authority_boundary, inventory.authority_boundary);
}

console.log(`Validated ${inventory.examples.length} local framework wrapping examples.`);
