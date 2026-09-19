import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const presenter = readFileSync(new URL('../docs/PRESENTER_SCRIPT.md', import.meta.url), 'utf8');
const rehearsal = readFileSync(new URL('../docs/HACKATHON_REHEARSAL.md', import.meta.url), 'utf8');

test('presenter script keeps the active show Risk-Fork-only and payment-proof based', () => {
  assert.match(presenter, /Submit\s+and present Risk Fork only/);
  assert.match(presenter, /Interchange, Governed Agent, Governed Signals, Flash, Bankr and Dynamic/);
  assert.match(presenter, /runtime-risk-fork-payment-proof\.mjs/);
  assert.match(presenter, /\$50/);
  assert.match(presenter, /\$60,000/);
  assert.match(presenter, /six fixed local preparation checks/i);

  const activeCase = presenter.split('## Case 2 —', 2)[1].split(
    '### Superseded historical case',
    2,
  )[0];
  assert.doesNotMatch(activeCase, /irreversible-deployment-proposal/);
  for (const boundary of [
    'no signer',
    'payment',
    'settlement',
    'provider qualification',
    'production protection',
  ]) {
    assert.match(activeCase, new RegExp(boundary, 'i'), boundary);
  }
});

test('presenter script labels the old deployment scenario historical and superseded', () => {
  const historical = presenter.split('### Superseded historical case', 2)[1];
  assert.match(historical, /irreversible-deployment-proposal/);
  assert.match(historical, /superseded/i);
  assert.match(historical, /no deployment/i);
  assert.match(historical, /no clean commit/i);
});

test('rehearsal runbook uses the same bounded financial case', () => {
  assert.match(rehearsal, /Active financial case: synthetic payment proposal/);
  assert.match(rehearsal, /runtime-risk-fork-payment-proof\.mjs/);
  assert.match(rehearsal, /six fixed preparation checks/);
  assert.match(rehearsal, /no\s+signer, execution, payment, settlement, provider qualification/i);
  assert.match(rehearsal, /irreversible-deployment-proposal[\s\S]*historical\/superseded/i);
});
