/**
 * Source-only income work-pack planner for the existing Agent OS integration.
 * Pure JSON-in/JSON-out: no model, network, signer, scheduler, or persistent store.
 * Supplied references are NOT independently verified payment/authority evidence.
 */
import { createHash } from 'node:crypto';

const SCALE = 1_000_000n;
const MAX_ITEMS = 500;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const DEBITS = new Set(['operating_cost', 'refund', 'owner_distribution']);
const KINDS = new Set(['capital', 'external_revenue', 'internal_transfer', 'test_revenue', ...DEBITS]);
const STATES = new Set(['settled', 'pending', 'failed', 'disputed']);
export const AUTHORITY = Object.freeze({
  source_only: true, execution_enabled: false, transfers_enabled: false,
  signing_enabled: false, network_enabled: false, evidence_verified: false,
});

function fail(code) { throw new Error(code); }
function shape(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) fail(`${label}:object_required`);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) fail(`${label}:unexpected_or_missing_field`);
}
function id(value, label) {
  if (typeof value !== 'string' || !ID.test(value)) fail(`${label}:invalid_id`);
  return value;
}
function list(value, label) {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) fail(`${label}:invalid_list`);
  return value;
}
function unique(values, label) {
  if (new Set(values).size !== values.length) fail(`${label}:duplicate`);
}
function integer(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${label}:invalid_integer`);
}
function time(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) fail(`${label}:invalid_time`);
  const n = Date.parse(value);
  if (!Number.isFinite(n) || new Date(n).toISOString() !== value) fail(`${label}:invalid_time`);
  return n;
}
function fresh(asOf, now, seconds, label) {
  const age = now - time(asOf, label);
  if (age < 0 || age > seconds * 1000) fail(`${label}:stale_or_future`);
}
function address(value) {
  if (typeof value !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(value) || /^0x0{40}$/.test(value)) fail('invalid_treasury_address');
  return value.toLowerCase(); // Equality only; not checksum or signer validation.
}
export function parseUsdc(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,11})(\.\d{1,6})?$/.test(value)) fail('invalid_usdc_decimal');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(6, '0'));
}
export function formatUsdc(value) {
  if (typeof value !== 'bigint') fail('bigint_required');
  const sign = value < 0n ? '-' : '';
  const magnitude = value < 0n ? -value : value;
  return `${sign}${magnitude / SCALE}.${String(magnitude % SCALE).padStart(6, '0')}`;
}
const max0 = n => n > 0n ? n : 0n;
const min = (a, b) => a < b ? a : b;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
function digest(value) { return createHash('sha256').update(canonical(value)).digest('hex'); }

function validateMandate(m, now) {
  shape(m, ['id', 'revision', 'revoked', 'expires_at', 'allowed_sources', 'allowed_capabilities',
    'max_opportunity_age_seconds', 'max_treasury_age_seconds', 'max_task_cost_usdc',
    'max_cycle_cost_usdc', 'min_expected_net_usdc', 'operating_reserve_usdc',
    'refund_reserve_usdc', 'principal_floor_usdc', 'treasury_address'], 'mandate');
  id(m.id, 'mandate.id');
  integer(m.revision, 1, 1_000_000, 'mandate.revision');
  if (typeof m.revoked !== 'boolean') fail('mandate.revoked:boolean_required');
  if (m.revoked) fail('mandate_revoked');
  if (time(m.expires_at, 'mandate.expires_at') <= now) fail('mandate_expired');
  for (const name of ['allowed_sources', 'allowed_capabilities']) {
    list(m[name], name).forEach(v => id(v, name));
    unique(m[name], name);
  }
  for (const name of ['max_opportunity_age_seconds', 'max_treasury_age_seconds']) integer(m[name], 1, 86400, name);
  for (const name of ['max_task_cost_usdc', 'max_cycle_cost_usdc', 'min_expected_net_usdc',
    'operating_reserve_usdc', 'refund_reserve_usdc', 'principal_floor_usdc']) parseUsdc(m[name]);
  address(m.treasury_address);
}

function treasuryProjection(t, m, now) {
  shape(t, ['as_of', 'asset', 'network', 'history_complete', 'balance_usdc', 'external_holds_usdc', 'entries'], 'treasury');
  if (t.asset !== 'USDC' || t.network !== 'eip155:8453') fail('unsupported_asset_or_network');
  if (t.history_complete !== true) fail('treasury_history_incomplete');
  fresh(t.as_of, now, m.max_treasury_age_seconds, 'treasury.as_of');
  const balance = parseUsdc(t.balance_usdc);
  let holds = parseUsdc(t.external_holds_usdc);
  let revenue = 0n, expenses = 0n, distributions = 0n;
  const entryIds = [], settlementRefs = [];
  const excluded = [];
  for (const e of list(t.entries, 'treasury.entries')) {
    shape(e, ['id', 'kind', 'state', 'amount_usdc', 'settlement_ref', 'outcome_ref'], 'entry');
    entryIds.push(id(e.id, 'entry.id'));
    if (!KINDS.has(e.kind) || !STATES.has(e.state)) fail('entry:unknown_kind_or_state');
    const amount = parseUsdc(e.amount_usdc);
    for (const key of ['settlement_ref', 'outcome_ref']) if (e[key] !== null) id(e[key], `entry.${key}`);
    // Conflicting/replayed settlement components must be reconciled by the host.
    if (e.settlement_ref !== null) settlementRefs.push(e.settlement_ref);
    if (e.state !== 'settled') {
      if (e.state !== 'failed' && DEBITS.has(e.kind)) holds += amount;
      excluded.push({ id: e.id, reason: e.state });
      continue;
    }
    if (e.settlement_ref === null) fail('settled_entry_missing_settlement_reference');
    if (e.kind === 'external_revenue') {
      if (e.outcome_ref === null) excluded.push({ id: e.id, reason: 'missing_outcome_reference' });
      else revenue += amount;
    } else if (e.kind === 'operating_cost' || e.kind === 'refund') expenses += amount;
    else if (e.kind === 'owner_distribution') distributions += amount;
    else excluded.push({ id: e.id, reason: 'not_external_earned_revenue' });
  }
  unique(entryIds, 'entry_ids');
  unique(settlementRefs, 'settlement_refs');
  const reserve = parseUsdc(m.operating_reserve_usdc) + parseUsdc(m.refund_reserve_usdc) + parseUsdc(m.principal_floor_usdc);
  return {
    cashCapacity: max0(balance - holds - reserve),
    // Outstanding obligations reserve earnings as well as posted cash. Otherwise
    // a large capital balance could mask a second allocation of the same profit.
    profitCapacity: max0(revenue - expenses - distributions - holds),
    revenue, expenses, distributions, holds, reserve, excluded,
  };
}

function candidate(o, m, now, seen) {
  shape(o, ['id', 'source_id', 'kind', 'capability_id', 'buyer_order_ref', 'scope_ref',
    'input_sha256', 'observed_at', 'expires_at', 'gross_revenue_usdc', 'success_probability_bps', 'costs'], 'opportunity');
  for (const key of ['id', 'source_id', 'kind', 'capability_id']) id(o[key], `opportunity.${key}`);
  for (const key of ['buyer_order_ref', 'scope_ref']) if (o[key] !== null) id(o[key], `opportunity.${key}`);
  if (typeof o.input_sha256 !== 'string' || !HASH.test(o.input_sha256)) fail('opportunity:invalid_input_hash');
  integer(o.success_probability_bps, 0, 10000, 'success_probability_bps');
  shape(o.costs, ['inference_usdc', 'tools_usdc', 'gas_usdc', 'platform_usdc', 'delivery_usdc', 'risk_allowance_usdc'], 'opportunity.costs');
  const cost = Object.values(o.costs).reduce((n, v) => n + parseUsdc(v), 0n);
  const gross = parseUsdc(o.gross_revenue_usdc);
  const expectedNet = gross * BigInt(o.success_probability_bps) / 10000n - cost;
  const observed = time(o.observed_at, 'opportunity.observed_at');
  const expiry = time(o.expires_at, 'opportunity.expires_at');
  // Stable work identity across repricing/input changes; not an authorization token.
  const workKey = digest({ mandate_id: m.id, source_id: o.source_id, order: o.buyer_order_ref || o.id });
  const reasons = [];
  if (o.kind !== 'service_order') reasons.push('unsupported_income_strategy');
  if (!m.allowed_sources.includes(o.source_id)) reasons.push('source_not_allowed');
  if (!m.allowed_capabilities.includes(o.capability_id)) reasons.push('capability_not_allowed');
  if (o.buyer_order_ref === null) reasons.push('missing_buyer_order');
  if (o.scope_ref === null) reasons.push('missing_scope_reference');
  if (observed > now || now - observed > m.max_opportunity_age_seconds * 1000) reasons.push('stale_or_future_opportunity');
  if (expiry <= now || expiry <= observed) reasons.push('opportunity_expired');
  if (cost > parseUsdc(m.max_task_cost_usdc)) reasons.push('task_cost_limit');
  if (expectedNet <= 0n || expectedNet < parseUsdc(m.min_expected_net_usdc)) reasons.push('insufficient_expected_net');
  if (seen.has(workKey)) reasons.push('already_seen_work');
  return { o, cost, expectedNet, workKey, reasons };
}

/**
 * Build a NON-EXECUTABLE review packet from normalized, untrusted snapshot data.
 * The host must verify evidence, authenticate the owner and atomically reserve
 * budgets/unique work keys before any future execution integration is considered.
 */
export function planIncomeCycle(input) {
  shape(input, ['schema', 'evidence_class', 'now', 'mandate', 'treasury', 'opportunities', 'seen_work_keys', 'withdrawal_request'], 'input');
  if (input.schema !== 'agoragentic.income-preview-input.v1') fail('unsupported_schema');
  if (!['synthetic_fixture', 'unverified_owner_export'].includes(input.evidence_class)) fail('unsupported_evidence_class');
  const now = time(input.now, 'now');
  const m = input.mandate;
  validateMandate(m, now);
  const t = treasuryProjection(input.treasury, m, now);
  const seenKeys = list(input.seen_work_keys, 'seen_work_keys');
  if (seenKeys.some(k => typeof k !== 'string' || !HASH.test(k))) fail('invalid_seen_work_key');
  unique(seenKeys, 'seen_work_keys');
  const candidates = list(input.opportunities, 'opportunities').map(o => candidate(o, m, now, new Set(seenKeys)));
  unique(candidates.map(c => digest([c.o.source_id, c.o.id])), 'opportunity_ids');
  unique(candidates.map(c => c.workKey), 'opportunity_work_keys');
  candidates.sort((a, b) => compare(b.expectedNet, a.expectedNet) || compare(a.workKey, b.workKey));

  const capacity = min(parseUsdc(m.max_cycle_cost_usdc), t.cashCapacity);
  let proposedCost = 0n, expectedNet = 0n;
  const proposals = [], rejected = [];
  for (const c of candidates) {
    if (c.reasons.length === 0 && proposedCost + c.cost > capacity) c.reasons.push('cycle_budget_or_reserve_limit');
    if (c.reasons.length) { rejected.push({ id: c.o.id, source_id: c.o.source_id, reasons: c.reasons }); continue; }
    proposedCost += c.cost;
    expectedNet += c.expectedNet;
    proposals.push({
      opportunity_id: c.o.id, source_id: c.o.source_id, capability_id: c.o.capability_id,
      work_key: c.workKey, terms_sha256: digest({ mandate: m, opportunity: c.o }),
      input_sha256: c.o.input_sha256, buyer_order_ref: c.o.buyer_order_ref, scope_ref: c.o.scope_ref,
      expires_at: c.o.expires_at, worst_case_cost_usdc: formatUsdc(c.cost),
      expected_net_usdc: formatUsdc(c.expectedNet), status: 'review_only', executable: false,
    });
  }
  // Reserve both cash and profit against proposed work before previewing a distribution.
  // No projected job proceeds or pending inflows are counted as withdrawable.
  const withdrawable = min(max0(t.cashCapacity - proposedCost), max0(t.profitCapacity - proposedCost));
  let withdrawal = null;
  if (input.withdrawal_request !== null) {
    const w = input.withdrawal_request;
    shape(w, ['id', 'amount_usdc', 'destination', 'expires_at'], 'withdrawal_request');
    id(w.id, 'withdrawal_request.id');
    const amount = parseUsdc(w.amount_usdc);
    const reasons = [];
    if (amount === 0n) reasons.push('zero_withdrawal');
    if (address(w.destination) !== address(m.treasury_address)) reasons.push('destination_not_allowed');
    if (time(w.expires_at, 'withdrawal_request.expires_at') <= now) reasons.push('withdrawal_request_expired');
    if (amount > withdrawable) reasons.push('insufficient_surplus');
    withdrawal = {
      request_id: w.id, status: 'review_only', authorized: false,
      requested_usdc: formatUsdc(amount), economically_feasible_in_snapshot: reasons.length === 0,
      reasons, transfer_enabled: false, transferred_usdc: '0.000000',
    };
  }
  return {
    schema: 'agoragentic.income-preview.v1', review_id: digest(input), as_of: input.now,
    evidence_class: input.evidence_class, authority: { ...AUTHORITY },
    warning: 'Unverified input projection, not revenue proof, spend authorization, or a withdrawal service.',
    accounting: {
      currency: 'USDC', unit_decimals: 6,
      input_external_earned_revenue_usdc: formatUsdc(t.revenue),
      input_expenses_usdc: formatUsdc(t.expenses), input_owner_distributions_usdc: formatUsdc(t.distributions),
      input_holds_usdc: formatUsdc(t.holds), policy_reserves_usdc: formatUsdc(t.reserve),
      proposed_cost_usdc: formatUsdc(proposedCost), expected_net_usdc: formatUsdc(expectedNet),
      surplus_preview_usdc: formatUsdc(withdrawable), actual_spend_usdc: '0.000000',
      actual_revenue_verified_usdc: null, excluded_entries: t.excluded,
    },
    proposals, rejected, withdrawal,
  };
}

export function executeIncomeAction() { fail('SOURCE_ONLY_PREVIEW_NO_EXECUTION'); }
