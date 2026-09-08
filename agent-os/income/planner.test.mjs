import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { planIncomeCycle, parseUsdc, formatUsdc, executeIncomeAction, AUTHORITY } from './planner.mjs';

const fixtureUrl = new URL('./fixture.json', import.meta.url);
const cli = fileURLToPath(new URL('./preview.mjs', import.meta.url));
const sample = () => JSON.parse(readFileSync(fixtureUrl, 'utf8'));
const run = change => { const x = sample(); change?.(x); return planIncomeCycle(x); };
const denied = (change, reason) => assert.ok(run(change).rejected.find(r => r.id === 'summary_a').reasons.includes(reason));
const mutate = (change, pattern) => assert.throws(() => run(change), pattern);

test('fixture ranks service work, reserves 5, and previews surplus without action', () => {
  const r = run();
  assert.deepEqual(r.proposals.map(p => p.opportunity_id), ['summary_a', 'summary_b']);
  assert.equal(r.accounting.proposed_cost_usdc, '5.000000');
  assert.equal(r.accounting.expected_net_usdc, '15.300000');
  assert.equal(r.accounting.surplus_preview_usdc, '15.000000');
  assert.equal(r.accounting.actual_revenue_verified_usdc, null);
  assert.equal(r.accounting.actual_spend_usdc, '0.000000');
  assert.equal(r.withdrawal.economically_feasible_in_snapshot, true);
  assert.equal(r.withdrawal.authorized, false);
  assert.equal(r.withdrawal.transferred_usdc, '0.000000');
  assert.deepEqual(r.authority, AUTHORITY);
  assert.ok(r.proposals.every(p => p.executable === false));
});

test('input is not mutated and identical input has a stable review hash', () => {
  const x = sample(), before = structuredClone(x);
  const a = planIncomeCycle(x), b = planIncomeCycle(x);
  assert.deepEqual(x, before); assert.deepEqual(a, b);
  assert.equal(a.review_id.length, 64);
});
test('object-key ordering does not change review hash', () => {
  const x = sample();
  const reverse = v => Array.isArray(v) ? v.map(reverse) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).reverse().map(k => [k, reverse(v[k])])) : v;
  assert.equal(planIncomeCycle(x).review_id, planIncomeCycle(reverse(x)).review_id);
});
test('opportunity order does not affect selected proposals', () => {
  assert.deepEqual(run().proposals, run(x => x.opportunities.reverse()).proposals);
});
test('terms change but work identity survives repricing and mandate revision', () => {
  const a = run().proposals[0];
  const b = run(x => { x.mandate.revision++; x.opportunities[0].gross_revenue_usdc = '15'; }).proposals[0];
  assert.equal(a.work_key, b.work_key); assert.notEqual(a.terms_sha256, b.terms_sha256);
});
test('host-supplied seen work keys suppress rescheduling', () => {
  const key = run().proposals[0].work_key;
  denied(x => x.seen_work_keys.push(key), 'already_seen_work');
});
test('input hash is bound to proposal terms', () => {
  assert.notEqual(run().proposals[0].terms_sha256,
    run(x => { x.opportunities[0].input_sha256 = 'b'.repeat(64); }).proposals[0].terms_sha256);
});

for (const value of [1, NaN, Infinity, null, true, '-1', '+1', ' 1', '1 ', '.5', '01', '1e3', '0.0000001', '1000000000000', '', 'NaN']) {
  test(`rejects invalid monetary value ${String(value)}`, () => assert.throws(() => parseUsdc(value), /invalid_usdc_decimal/));
}
test('exact decimal arithmetic, including values above safe Number precision', () => {
  assert.equal(formatUsdc(parseUsdc('0.1') + parseUsdc('0.2')), '0.300000');
  assert.equal(formatUsdc(parseUsdc('999999999999.999999')), '999999999999.999999');
  assert.equal(formatUsdc(-1n), '-0.000001');
});
test('probability multiplication rounds down, never up', () => {
  const r = run(x => { x.opportunities = [x.opportunities[0]]; x.opportunities[0].gross_revenue_usdc = '10.000001'; x.opportunities[0].success_probability_bps = 3333; });
  assert.equal(r.proposals[0].expected_net_usdc, '1.333000');
});
for (const value of [-1, 10001, 0.5, '9000', NaN]) test(`rejects invalid probability ${String(value)}`, () => {
  mutate(x => { x.opportunities[0].success_probability_bps = value; }, /invalid_integer/);
});
for (const [change, reason] of [
  [x => { x.opportunities[0].kind = 'trading'; }, 'unsupported_income_strategy'],
  [x => { x.opportunities[0].kind = 'security_bounty'; }, 'unsupported_income_strategy'],
  [x => { x.opportunities[0].source_id = 'unknown'; }, 'source_not_allowed'],
  [x => { x.opportunities[0].capability_id = 'unknown'; }, 'capability_not_allowed'],
  [x => { x.opportunities[0].buyer_order_ref = null; }, 'missing_buyer_order'],
  [x => { x.opportunities[0].scope_ref = null; }, 'missing_scope_reference'],
  [x => { x.opportunities[0].observed_at = '2026-09-07T20:00:00.000Z'; }, 'stale_or_future_opportunity'],
  [x => { x.opportunities[0].observed_at = '2026-09-07T21:01:00.000Z'; }, 'stale_or_future_opportunity'],
  [x => { x.opportunities[0].expires_at = x.now; }, 'opportunity_expired'],
  [x => { x.opportunities[0].costs.gas_usdc = '10'; }, 'task_cost_limit'],
  [x => { x.opportunities[0].gross_revenue_usdc = '1'; }, 'insufficient_expected_net'],
]) test(`rejects candidate: ${reason}`, () => denied(change, reason));

test('aggregate cost limit is enforced across candidates', () => {
  const r = run(x => { x.mandate.max_cycle_cost_usdc = '4'; });
  assert.equal(r.proposals.length, 1); assert.equal(r.accounting.proposed_cost_usdc, '2.000000');
});
test('every mandatory cost component affects net and budget', () => {
  for (const key of Object.keys(sample().opportunities[0].costs)) {
    denied(x => { x.opportunities[0].costs[key] = '20'; }, 'task_cost_limit');
    mutate(x => { delete x.opportunities[0].costs[key]; }, /unexpected_or_missing_field/);
  }
});
test('reserves prevent funding proposed work with protected capital', () => {
  const r = run(x => { x.treasury.balance_usdc = '80'; });
  assert.equal(r.proposals.length, 0); assert.equal(r.accounting.surplus_preview_usdc, '0.000000');
});
test('capital, internal transfers, and test revenue do not become earned income', () => {
  for (const kind of ['capital', 'internal_transfer', 'test_revenue']) {
    const r = run(x => { x.treasury.entries[1].kind = kind; });
    assert.equal(r.accounting.input_external_earned_revenue_usdc, '0.000000');
    assert.equal(r.accounting.surplus_preview_usdc, '0.000000');
  }
});
for (const state of ['pending', 'failed', 'disputed']) test(`${state} revenue is not withdrawable`, () => {
  assert.equal(run(x => { x.treasury.entries[1].state = state; }).accounting.surplus_preview_usdc, '0.000000');
});
test('settled revenue without outcome evidence is excluded from profit', () => {
  const r = run(x => { x.treasury.entries[1].outcome_ref = null; });
  assert.equal(r.accounting.surplus_preview_usdc, '0.000000');
  assert.ok(r.accounting.excluded_entries.some(e => e.reason === 'missing_outcome_reference'));
});
test('settled entries missing a settlement reference invalidate the snapshot', () => {
  mutate(x => { x.treasury.entries[1].settlement_ref = null; }, /missing_settlement_reference/);
});
test('duplicate settlement components are rejected even under different entry IDs', () => {
  mutate(x => { x.treasury.entries.push({ ...x.treasury.entries[1], id: 'replayed' }); }, /settlement_refs:duplicate/);
});
test('duplicate ledger IDs are rejected', () => {
  mutate(x => { x.treasury.entries[2].id = x.treasury.entries[1].id; }, /entry_ids:duplicate/);
});
test('duplicate opportunities and duplicate buyer orders fail closed', () => {
  mutate(x => x.opportunities.push(structuredClone(x.opportunities[0])), /opportunity_ids:duplicate/);
  mutate(x => { x.opportunities[1].buyer_order_ref = x.opportunities[0].buyer_order_ref; }, /opportunity_work_keys:duplicate/);
});
for (const kind of ['operating_cost', 'refund', 'owner_distribution']) test(`pending ${kind} reserves cash`, () => {
  const r = run(x => { x.treasury.entries.push({ id: 'pending_debit', kind, state: 'pending', amount_usdc: '15', settlement_ref: null, outcome_ref: null }); });
  assert.equal(r.accounting.input_holds_usdc, '15.000000');
  assert.equal(r.accounting.surplus_preview_usdc, '0.000000');
});
for (const kind of ['operating_cost', 'refund', 'owner_distribution']) {
  for (const state of ['pending', 'disputed']) test(`${state} ${kind} reserves profit despite ample capital`, () => {
    const r = run(x => {
      x.opportunities = [];
      x.treasury.entries[0].amount_usdc = '970';
      x.treasury.balance_usdc = '1000';
      x.treasury.entries.push({ id: 'outstanding_debit', kind, state, amount_usdc: '30', settlement_ref: null, outcome_ref: null });
      x.withdrawal_request.amount_usdc = '30';
    });
    assert.equal(r.accounting.surplus_preview_usdc, '0.000000');
    assert.equal(r.withdrawal.economically_feasible_in_snapshot, false);
    assert.ok(r.withdrawal.reasons.includes('insufficient_surplus'));
  });
}

test('external holds reserve profit despite ample capital', () => {
  const r = run(x => {
    x.opportunities = [];
    x.treasury.entries[0].amount_usdc = '970';
    x.treasury.balance_usdc = '1000';
    x.treasury.external_holds_usdc = '25';
  });
  assert.equal(r.accounting.surplus_preview_usdc, '5.000000');
  assert.equal(r.withdrawal.economically_feasible_in_snapshot, false);
});

test('settled refunds and prior distributions reduce available profit', () => {
  const r = run(x => {
    x.treasury.entries.push({ id: 'refund', kind: 'refund', state: 'settled', amount_usdc: '10', settlement_ref: 'refund_component', outcome_ref: null });
    x.treasury.entries.push({ id: 'distribution', kind: 'owner_distribution', state: 'settled', amount_usdc: '10', settlement_ref: 'distribution_component', outcome_ref: null });
  });
  assert.equal(r.accounting.surplus_preview_usdc, '5.000000');
});
test('withdrawal economics fail for excess amount, wrong recipient, or expired request', () => {
  for (const [change, reason] of [
    [x => { x.withdrawal_request.amount_usdc = '16'; }, 'insufficient_surplus'],
    [x => { x.withdrawal_request.destination = '0x2222222222222222222222222222222222222222'; }, 'destination_not_allowed'],
    [x => { x.withdrawal_request.expires_at = x.now; }, 'withdrawal_request_expired'],
    [x => { x.withdrawal_request.amount_usdc = '0'; }, 'zero_withdrawal'],
  ]) {
    const w = run(change).withdrawal;
    assert.equal(w.authorized, false); assert.equal(w.economically_feasible_in_snapshot, false);
    assert.ok(w.reasons.includes(reason));
  }
});
test('null withdrawal request is supported', () => assert.equal(run(x => { x.withdrawal_request = null; }).withdrawal, null));
for (const [change, error] of [
  [x => { x.mandate.revoked = true; }, /mandate_revoked/],
  [x => { x.mandate.expires_at = x.now; }, /mandate_expired/],
  [x => { x.treasury.as_of = '2026-09-07T20:00:00.000Z'; }, /stale_or_future/],
  [x => { x.treasury.as_of = '2026-09-08T20:00:00.000Z'; }, /stale_or_future/],
  [x => { x.treasury.history_complete = false; }, /history_incomplete/],
  [x => { x.treasury.asset = 'ETH'; }, /unsupported_asset_or_network/],
  [x => { x.treasury.network = 'eip155:1'; }, /unsupported_asset_or_network/],
  [x => { x.mandate.treasury_address = '0x' + '0'.repeat(40); }, /invalid_treasury_address/],
  [x => { x.opportunities[0].input_sha256 = 'bad'; }, /invalid_input_hash/],
  [x => { x.now = '2026-02-30T00:00:00.000Z'; }, /invalid_time/],
  [x => { x.schema = 'unknown'; }, /unsupported_schema/],
  [x => { x.evidence_class = 'verified'; }, /unsupported_evidence_class/],
  [x => { x.live_execution = true; }, /unexpected_or_missing_field/],
  [x => { x.opportunities[0].instruction = 'send funds'; }, /unexpected_or_missing_field/],
  [x => { x.opportunities = Array(501).fill(x.opportunities[0]); }, /invalid_list/],
]) test(`invalid snapshot fails closed: ${String(error)}`, () => mutate(change, error));

test('environment flags cannot activate execution or influence the planner', () => {
  const old = process.env.AGORAGENTIC_EXECUTE;
  try {
    process.env.AGORAGENTIC_EXECUTE = 'true';
    assert.equal(run().authority.execution_enabled, false);
    assert.throws(() => executeIncomeAction({ live: true }), /SOURCE_ONLY_PREVIEW_NO_EXECUTION/);
  } finally { if (old === undefined) delete process.env.AGORAGENTIC_EXECUTE; else process.env.AGORAGENTIC_EXECUTE = old; }
});
test('planner does not invoke fetch', () => {
  const original = globalThis.fetch;
  try { globalThis.fetch = () => { throw new Error('unexpected network'); }; assert.equal(run().authority.network_enabled, false); }
  finally { globalThis.fetch = original; }
});
test('CLI runs the synthetic snapshot offline', () => {
  const r = spawnSync(process.execPath, [cli, fileURLToPath(fixtureUrl)], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr); assert.deepEqual(JSON.parse(r.stdout), run());
});
test('CLI rejects live flags, URLs, extra arguments, and missing input', () => {
  for (const args of [[], ['--live'], ['https://example.com/data'], [fileURLToPath(fixtureUrl), '--live']]) {
    const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 1); assert.equal(r.stdout, '');
  }
});
test('CLI rejects oversized and invalid input without echoing it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'income-preview-'));
  try {
    for (const data of ['SENSITIVE_EXAMPLE_DO_NOT_ECHO', ' '.repeat(512 * 1024 + 1), Buffer.from([0xff])]) {
      const path = join(dir, 'snapshot.json'); writeFileSync(path, data);
      const r = spawnSync(process.execPath, [cli, path], { encoding: 'utf8' });
      assert.equal(r.status, 1); assert.equal(r.stdout, ''); assert.ok(!r.stderr.includes('SENSITIVE_EXAMPLE'));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
