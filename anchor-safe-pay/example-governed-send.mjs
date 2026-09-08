import { readFile } from 'node:fs/promises';
import {
  buildActionBinding,
  buildMandateBinding,
  createAnchorSafePayHarness,
  createFixtureSafePayScreenAdapter,
  createFixtureSimulatedSend,
} from './safe-pay-harness-adapter.js';

const action = await fixture('action.json');
const mandate = await fixture('owner-mandate.json');
const approval = await fixture('owner-approval.json');
const allowVerdict = await fixture('safe-pay-allow.json');

const binding = buildActionBinding(action);
const mandateBinding = buildMandateBinding(mandate);
if (approval.action_digest !== binding.action_digest) {
  throw new Error('The fixture approval does not match the exact proposed action.');
}
if (approval.mandate_hash !== mandateBinding.mandate_hash) {
  throw new Error('The fixture approval does not match the exact caller-declared mandate.');
}

const screenRecipient = createFixtureSafePayScreenAdapter({
  verdict: allowVerdict,
});
const simulatedSend = createFixtureSimulatedSend();
const harness = createAnchorSafePayHarness({
  enabled: true,
  fixtureNow: '2030-01-01T00:00:00.000Z',
});

const receipt = await harness.governedSend({
  action,
  mandate,
  approval,
  screenRecipient,
  simulatedSend,
});

if (receipt.decision !== 'allow' || receipt.funds_moved !== false) {
  throw new Error(`Fixture run did not reach the expected no-funds result: ${receipt.reason_code}`);
}
if (simulatedSend.fixtureCallCount() !== 1) {
  throw new Error('The inert fixture simulator was not invoked exactly once.');
}

console.log(JSON.stringify(receipt, null, 2));

async function fixture(name) {
  return JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
}
