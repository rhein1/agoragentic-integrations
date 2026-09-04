import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { normalizeSamTool } from './normalize.mjs';

async function fixture(name) {
  return JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
}

async function validator() {
  const schema = JSON.parse(await readFile(new URL('./sam-tool-import.schema.json', import.meta.url), 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

test('public schema accepts the canonical packet and rejects authority omissions', async () => {
  const validate = await validator();
  const packet = normalizeSamTool({
    discovery: await fixture('find-remote-tool.json'),
    description: await fixture('describe-remote-tool.json'),
    observedAt: '2026-08-19T20:00:00.000Z',
  });
  assert.equal(validate(packet), true, JSON.stringify(validate.errors));

  const missingAuthority = structuredClone(packet);
  delete missingAuthority.authority_flags.payment_enabled;
  assert.equal(validate(missingAuthority), false);

  const enabledAuthority = structuredClone(packet);
  enabledAuthority.authority_flags.public_execute_enabled = true;
  assert.equal(validate(enabledAuthority), false);

  const rawLabelKeys = structuredClone(packet);
  rawLabelKeys.transport_evidence.observed_label_keys = ['tenant-alpha-control-plane'];
  assert.equal(validate(rawLabelKeys), false);
});

test('public schema rejects private transport targets', async () => {
  const validate = await validator();
  const packet = normalizeSamTool({
    discovery: await fixture('find-remote-tool.json'),
    description: await fixture('describe-remote-tool.json'),
    observedAt: '2026-08-19T20:00:00.000Z',
    includePrivateTarget: true,
  });
  assert.ok(packet.private_transport_target);
  assert.equal(validate(packet), false);
});
