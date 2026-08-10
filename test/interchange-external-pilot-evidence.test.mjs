import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const evidencePath = new URL('../interchange/evidence/anchor-x402-pilot-2026-07.json', import.meta.url);
const caseStudyPath = new URL('../interchange/ANCHOR_X402_PILOT.md', import.meta.url);
const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
const caseStudy = readFileSync(caseStudyPath, 'utf8');

test('Anchor evidence stays bounded to completed key control and read-only exchange', () => {
  assert.equal(evidence.schema, 'agoragentic.interchange.external-pilot-evidence.v1');
  assert.equal(evidence.key_control.result, 'verified_federation_key_control');
  assert.equal(evidence.capability_exchange.status, 'completed_closed');
  assert.equal(evidence.capability_exchange.public_fields_only, true);
  assert.equal(evidence.capability_exchange.raw_response_bodies_retained, false);
  assert.equal(evidence.capability_exchange.hashes_reproduced_by_both_operators, true);
  assert.equal(evidence.capability_exchange.closed_at_immutable_expiry, true);
  assert.equal(
    Date.parse(evidence.capability_exchange.ended_at)
      - Date.parse(evidence.capability_exchange.started_at),
    24 * 60 * 60 * 1000,
    'the recorded canary window must remain exactly 24 hours',
  );

  assert.ok(
    evidence.capability_exchange.counterparty_gets_used
      <= evidence.capability_exchange.counterparty_get_limit,
    'counterparty request budget must not be exceeded',
  );
  assert.ok(
    evidence.capability_exchange.platform_request_slots_used
      <= evidence.capability_exchange.platform_request_slot_limit,
    'platform request-slot budget must not be exceeded',
  );
  assert.equal(
    evidence.capability_exchange.total_platform_gets_to_counterparty,
    evidence.capability_exchange.platform_request_slots_used
      + evidence.capability_exchange.separately_approved_diagnostic_gets,
  );
});

test('Anchor evidence grants no operational or money authority', () => {
  for (const [authority, enabled] of Object.entries(evidence.authority)) {
    assert.equal(enabled, false, `${authority} must remain false`);
  }
});

test('Anchor claims do not turn an interoperability pilot into demand or global priority', () => {
  assert.equal(evidence.claims.agoragentic_first_external_federation_pilot, true);
  assert.equal(evidence.claims.global_world_first, false);
  assert.equal(evidence.claims.organic_demand, false);
  assert.equal(evidence.claims.paying_partner, false);
  assert.equal(evidence.claims.partnership, false);
  assert.equal(evidence.claims.connected_marketplace_network, false);

  assert.match(caseStudy, /Agoragentic's first external\s+federation pilot/);
  assert.match(caseStudy, /does not claim that Agoragentic or Anchor invented x402/);
  assert.match(caseStudy, /recruited interoperability pilot, not organic demand/);
});

test('public evidence contains no private key or retained raw body field', () => {
  const serialized = JSON.stringify(evidence);
  assert.doesNotMatch(serialized, /private[_ -]?key/i);
  assert.doesNotMatch(serialized, /wallet[_ -]?secret/i);
  assert.doesNotMatch(serialized, /raw[_ -]?response[_ -]?body\s*:/i);
  assert.match(evidence.key_control.key_fingerprint, /^sha256:[0-9a-f]{64}$/);
});
