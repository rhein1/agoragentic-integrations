import { snapshotJson, digestJson, freezeDeep, NeverminedImportError, LIMITS } from './nevermined-json.mjs';
import { NEVERMINED_PROFILE, NEVERMINED_PROFILE_ID, NEVERMINED_PROFILE_DIGEST, NEVERMINED_REVISION } from './nevermined-profile.mjs';
export { NEVERMINED_PROFILE_ID, NEVERMINED_PROFILE_DIGEST, NEVERMINED_REVISION, NEVERMINED_PROFILE };
export { NeverminedImportError, parseNeverminedJson, canonicalNeverminedJson } from './nevermined-json.mjs';

const fail = (code) => { throw new NeverminedImportError(code); };
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const has = (value, key) => Object.hasOwn(value, key);
const text = (value) => typeof value === 'string' && value.length ? value : null;
const abbreviated = (value) => typeof value === 'string' && /…|\.\.\./u.test(value);
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const secretLike = (value) => typeof value === 'string' && /(?:\b(?:bearer|basic)\s+\S+|\b(?:amk_|sk_(?:live|test)_|sk-proj-|nvm_(?:live|sandbox)_)[A-Za-z0-9_-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/i.test(value);
const allKeys = (obj, allowed) => { if (Object.keys(obj).some((key) => !allowed.includes(key))) fail('invalid_envelope'); };

function validateEnvelope(input, allowArray = false) {
  if (!object(input)) fail('invalid_envelope');
  allKeys(input, ['schema', 'source', 'profile_id', 'profile_digest', 'record', 'history']);
  if (input.schema !== 'agoragentic.nevermined-import.v1' || !object(input.source) || !object(input.record)) fail('invalid_envelope');
  allKeys(input.source, ['provider', 'namespace', 'record_kind', 'schema_revision', 'captured_at', 'record_ref']);
  allKeys(input.record, ['raw']);
  if (input.source.provider !== 'nevermined' || input.source.record_kind !== 'merchant_payment_ledger') fail('invalid_envelope');
  for (const value of [input.source.namespace, input.source.schema_revision, input.profile_id]) {
    if (!text(value) || value.length > 256 || /[\x00-\x20\x7f]/.test(value) || secretLike(value)) fail('invalid_envelope');
  }
  for (const value of [input.source.record_ref, input.source.captured_at]) {
    if (value !== undefined && value !== null && (typeof value !== 'string' || value.length > 2048 || secretLike(value))) fail('invalid_envelope');
  }
  if (input.profile_digest !== undefined && (typeof input.profile_digest !== 'string' || !digestPattern.test(input.profile_digest))) fail('invalid_envelope');
  if (!object(input.record.raw) && !(allowArray && Array.isArray(input.record.raw))) fail('invalid_envelope');
  if (input.history !== undefined && !Array.isArray(input.history)) fail('invalid_history');
  if ((input.history?.length ?? 0) > LIMITS.records) fail('limit_exceeded');
}

/** Retain only declared scalar evidence; unknown and diagnostic fields never reach a digest. */
function redactedSource(raw) {
  if (!object(raw)) fail('invalid_record');
  const retained = Object.create(null);
  const warnings = [];
  for (const key of Object.keys(raw)) {
    if (!NEVERMINED_PROFILE.fields.includes(key) || NEVERMINED_PROFILE.redaction.dropped_fields.includes(key)) {
      warnings.push('source_fields_omitted'); continue;
    }
    const value = raw[key];
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) fail('invalid_record_field');
    if (key === 'resourceUrl') {
      if (typeof value !== 'string') { retained[key] = null; warnings.push('resource_url_omitted'); continue; }
      let url;
      try { url = new URL(value); } catch { warnings.push('resource_url_omitted'); continue; }
      if (!['https:', 'http:'].includes(url.protocol)) { warnings.push('resource_url_omitted'); continue; }
      url.username = ''; url.password = ''; url.search = ''; url.hash = '';
      if (secretLike(url.href) || /[\x00-\x1f\x7f]/.test(value)) fail('secret_in_evidence_field');
      retained[key] = url.href;
      if (retained[key] !== value) warnings.push('resource_url_redacted');
    } else {
      if (secretLike(value)) fail('secret_in_evidence_field');
      if (typeof value === 'string' && /[\x00-\x1f\x7f]/.test(value)) fail('invalid_record_field');
      retained[key] = value;
    }
  }
  return { retained, warnings };
}

function atomic(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  if (value.length > LIMITS.amountDigits) fail('limit_exceeded');
  return BigInt(value).toString();
}
function scale(value) { return Number.isInteger(value) && value >= 0 && value <= LIMITS.decimals ? value : null; }
function displayAmount(value, decimals) {
  if (value === null || decimals === null) return null;
  if (decimals === 0) return value;
  const digits = value.padStart(decimals + 1, '0');
  const fraction = digits.slice(-decimals).replace(/0+$/, '');
  return `${digits.slice(0, -decimals)}${fraction ? `.${fraction}` : ''}`;
}
function wallet(value) { return typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value) ? value.toLowerCase() : null; }
function reference(value) {
  const ref = text(value);
  if (!ref) return { value: null, kind: 'absent' };
  if (abbreviated(ref)) return { value: ref, kind: 'abbreviated' };
  return /^0x[a-fA-F0-9]{64}$/.test(ref) ? { value: ref.toLowerCase(), kind: 'evm_tx_hash' } : { value: ref, kind: 'opaque' };
}
const status = (value) => (has(NEVERMINED_PROFILE.merchant_statuses, value) ? NEVERMINED_PROFILE.merchant_statuses[value] : 'unknown');
const notChecked = () => ({
  independent_settlement: { provenance: 'reported_observation', chain_status: 'not_checked', matching_status: 'not_checked', evidence_ref: null },
  amount_reconciliation: { ledger_amount: 'not_checked', commercial_price: 'not_checked' },
  authority: 'not_checked', outcome: 'not_checked',
});

function baseRecord(input) {
  validateEnvelope(input);
  const { retained, warnings } = redactedSource(input.record.raw);
  const known = input.profile_id === NEVERMINED_PROFILE_ID && input.source.schema_revision === NEVERMINED_REVISION;
  if (known && input.profile_digest !== undefined && input.profile_digest !== NEVERMINED_PROFILE_DIGEST) fail('profile_digest_mismatch');
  const source = {
    provider: 'nevermined', namespace: input.source.namespace,
    record_kind: 'merchant_payment_ledger', schema_revision: input.source.schema_revision,
    provenance: 'caller_supplied',
    redacted_source_hash: digestJson(retained), hash_scope: 'redacted_bounded_source',
    canonicalization: 'rfc8785-jcs', redaction_profile: NEVERMINED_PROFILE.redaction.id,
    extraction_profile: { id: input.profile_id, version: known ? NEVERMINED_PROFILE.version : null, digest: known ? NEVERMINED_PROFILE_DIGEST : null },
    source_artifact_embedded: false,
  };
  const r = known ? retained : Object.create(null);
  if (!known) warnings.push('unsupported_profile');
  const amount = atomic(r.amount);
  const decimals = scale(r.assetDecimals);
  const settlement = reference(r.txHash);
  const paymentId = text(r.id);
  const stableId = paymentId && paymentId.length <= 256 && !/\s/u.test(paymentId) && !abbreviated(paymentId) ? paymentId : null;
  const network = text(r.network) ? (has(NEVERMINED_PROFILE.network_aliases, r.network) ? NEVERMINED_PROFILE.network_aliases[r.network] : r.network) : null;
  const asset = text(r.asset);
  const eligible = known && r.protocol === 'x402' && network === 'eip155:8453' && asset?.toUpperCase() === 'USDC' && decimals === 6;
  const merchant = {
    provider_status: text(r.status), status_family: status(r.status),
    protocol: text(r.protocol), network, asset,
    amount_atomic: amount, decimals, amount_display: displayAmount(amount, decimals),
    buyer_wallet: wallet(r.buyer), merchant_wallet: wallet(r.merchantAddress),
    settlement_ref: settlement.value, settlement_ref_kind: settlement.kind,
    resource_url: text(r.resourceUrl), created_at: text(r.createdAt),
  };
  const feeKeys = NEVERMINED_PROFILE.fields.filter((key) => key.startsWith('fee') && key !== 'feeFailureReason');
  const fees = known && feeKeys.some((key) => has(r, key)) ? [{
    leg: 'router_fee', provider_status: text(r.feeStatus),
    amount_atomic: atomic(r.feeAtomic), decimals, network, asset,
    rate_bps: Number.isSafeInteger(r.feeBps) && r.feeBps >= 0 ? r.feeBps : null,
    budget_cents: atomic(r.feeCents),
    settlement_ref: reference(r.feeTxHash).value, settlement_ref_kind: reference(r.feeTxHash).kind,
    authorization_nonce: text(r.feeNonce),
    reconciliation: 'not_checked',
  }] : [];
  if (known) {
    if (!stableId) warnings.push('payment_identity_unavailable');
    if (amount === null) warnings.push('amount_uncheckable');
    if (decimals === null) warnings.push('decimals_uncheckable');
    if (!wallet(r.merchantAddress)) warnings.push('merchant_wallet_unavailable');
    if (!wallet(r.buyer)) warnings.push('buyer_wallet_unavailable');
    if (settlement.kind !== 'evm_tx_hash') warnings.push('settlement_reference_unavailable');
    if (merchant.status_family === 'unknown') warnings.push('unknown_provider_status');
    if (!eligible) warnings.push('settlement_subset_unavailable');
    if (fees.some((fee) => !NEVERMINED_PROFILE.fee_statuses.includes(fee.provider_status))) warnings.push('unknown_fee_status');
    if (fees.some((fee) => fee.amount_atomic === null)) warnings.push('fee_amount_uncheckable');
    if (fees.some((fee) => fee.amount_atomic !== '0' && fee.budget_cents === '0')) warnings.push('atomic_fee_with_zero_budget_cents');
  }
  const paymentKey = known && stableId ? digestJson(['nevermined.payment.v1', 'nevermined', input.source.namespace, stableId]) : null;
  const observationKey = paymentKey ? digestJson(['nevermined.observation.v1', paymentKey, source.redacted_source_hash, source.extraction_profile.digest]) : null;
  const core = {
    source, identity: { payment_identity_key: paymentKey, observation_key: observationKey },
    identifiers: { payment_id: known ? paymentId : null, request_id: text(r.requestId) },
    authority_refs: { delegation_ref: text(r.delegationId), principal_ref: null, agent_ref: null },
    merchant_payment: merchant, fee_legs: fees,
    // This is only the redacted allowlisted projection, not the full source export.
    original: retained,
  };
  const unsupported = !known || (text(r.protocol) && r.protocol !== 'x402') || (network && network !== 'eip155:8453') || (asset && asset.toUpperCase() !== 'USDC');
  const incomplete = known && (!stableId || !text(r.protocol) || !network || !asset || amount === null || decimals === null || merchant.status_family === 'unknown' || settlement.kind !== 'evm_tx_hash' || !merchant.merchant_wallet || !merchant.buyer_wallet);
  return {
    schema: 'agoragentic.nevermined-evidence.v1', core,
    observation_context: { captured_at: input.source.captured_at ?? null, record_ref_hash: input.source.record_ref ? digestJson(input.source.record_ref) : null },
    assessment: {
      parse_status: incomplete ? 'incomplete' : 'accepted', import_disposition: 'new',
      prior_observation_keys: [], conflicts: [],
      support: { pinned_profile: known, base_usdc_candidate: eligible },
      ...notChecked(), overall_evidence_status: unsupported ? 'unsupported' : 'unresolved',
      warnings: [...new Set(warnings)].sort(),
    },
  };
}

function facts(core) {
  return { ...core.identifiers, delegation_ref: core.authority_refs.delegation_ref, ...core.merchant_payment };
}
function compare(current, previous) {
  const a = facts(current.core); const b = facts(previous.core);
  const conflicts = NEVERMINED_PROFILE.immutable_fields.filter((key) => a[key] !== null && b[key] !== null && a[key] !== b[key]);
  if (NEVERMINED_PROFILE.merchant_incompatible_pairs.some(([x, y]) => [x, y].includes(a.status_family) && [x, y].includes(b.status_family) && a.status_family !== b.status_family)) conflicts.push('provider_status');
  const af = current.core.fee_legs[0]; const bf = previous.core.fee_legs[0];
  if (af && bf) {
    for (const key of ['amount_atomic', 'rate_bps', 'settlement_ref', 'authorization_nonce']) {
      if (af[key] !== null && bf[key] !== null && af[key] !== bf[key]) conflicts.push(`fee.${key}`);
    }
    if (NEVERMINED_PROFILE.fee_incompatible_pairs.some(([x, y]) => [x, y].includes(af.provider_status) && [x, y].includes(bf.provider_status) && af.provider_status !== bf.provider_status)) conflicts.push('fee.provider_status');
  }
  return conflicts;
}

function assessHistory(record, history) {
  const key = record.core.identity.payment_identity_key;
  if (!key) return freezeDeep(record);
  const peers = history.filter((p) => p.core.identity.payment_identity_key === key && p.core.source.extraction_profile.digest === record.core.source.extraction_profile.digest);
  const refs = peers.map((p) => p.core.identity.observation_key).filter(Boolean);
  record.assessment.prior_observation_keys = [...new Set(refs)].sort();
  const conflicts = [...new Set(peers.flatMap((p) => compare(record, p)))].sort();
  record.assessment.conflicts = conflicts;
  // Contradictory supplied assertions are not independently established chain facts.
  // Missing delivery or an exact duplicate must never erase an existing conflict.
  if (conflicts.length) {
    record.assessment.import_disposition = 'conflict';
    record.assessment.overall_evidence_status = 'contradicted';
  } else if (refs.includes(record.core.identity.observation_key)) record.assessment.import_disposition = 'duplicate';
  else if (peers.length) record.assessment.import_disposition = 'update';
  return freezeDeep(record);
}

function historyRecords(input, options) {
  if (options.history !== undefined && input.history !== undefined) fail('ambiguous_history');
  const history = options.history ?? input.history ?? [];
  if (!Array.isArray(history) || history.length > LIMITS.records) fail('invalid_history');
  return history.map((entry) => {
    if (!object(entry) || (entry.history?.length ?? 0) > 0) fail('invalid_history');
    return baseRecord(entry);
  });
}

/** Local only. History consists of raw import envelopes, re-normalized rather than trusting supplied assessments. */
export function normalizeNeverminedLedger(input, options = {}) {
  const data = snapshotJson(input); const opts = snapshotJson(options);
  if (Buffer.byteLength(JSON.stringify(data)) + Buffer.byteLength(JSON.stringify(opts)) > LIMITS.bytes) fail('input_too_large');
  if (!object(opts) || !object(data)) fail('invalid_envelope');
  allKeys(opts, ['profileId', 'history']);
  if (opts.profileId !== undefined && opts.profileId !== data.profile_id) fail('profile_id_mismatch');
  const record = baseRecord(data);
  return assessHistory(record, historyRecords(data, opts));
}

/** Bounded export. Every row is compared to the entire batch; no last-write-wins selection. */
export function normalizeNeverminedExport(input) {
  const data = snapshotJson(input);
  validateEnvelope(data, true);
  const rows = Array.isArray(data.record.raw) ? data.record.raw : [data.record.raw];
  if (rows.length > LIMITS.records) fail('limit_exceeded');
  const prior = historyRecords(data, {});
  if (rows.length + prior.length > LIMITS.records) fail('limit_exceeded');
  const records = rows.map((raw) => baseRecord({ ...data, record: { raw }, history: [] }));
  // Earlier duplicates get 'new'; contradictions anywhere in a batch affect both observations.
  return freezeDeep({
    schema: 'agoragentic.nevermined-evidence-batch.v1',
    records: records.map((record, index) => {
      const peers = [...prior, ...records.filter((other, i) => i !== index && (i < index || other.core.identity.observation_key !== record.core.identity.observation_key))];
      return assessHistory(record, peers);
    }),
  });
}

/** No invocation of a verifier exists in Stage A. */
export function renderNeverminedReport(record) {
  const c = record.core; const a = record.assessment;
  const quote = (value) => JSON.stringify(value ?? null);
  return [
    'NEVERMINED EVIDENCE — STAGE A (OFFLINE)',
    `Provider reported: ${quote(c.merchant_payment.provider_status)}; payment ${quote(c.identifiers.payment_id)}.`,
    `Merchant amount: ${quote(c.merchant_payment.amount_atomic)} atomic units; scale ${quote(c.merchant_payment.decimals)}.`,
    `Router fee records: ${c.fee_legs.length}; kept separate from the merchant payment.`,
    'Independently checked: nothing. Settlement, authority, commercial price, and outcome remain not_checked.',
    `Import: ${a.import_disposition}; overall evidence: ${a.overall_evidence_status}.`,
    `Warnings: ${a.warnings.join(', ') || 'none'}.`,
    `Conflicting supplied fields: ${a.conflicts.join(', ') || 'none'}.`,
    'Next safe step: inspect the report and supply missing evidence locally. No purchase or automatic retry.',
  ].join('\n') + '\n';
}
