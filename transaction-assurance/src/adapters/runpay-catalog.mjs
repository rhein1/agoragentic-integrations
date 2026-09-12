import { snapshotJson, digestJson, freezeDeep, RunpayImportError, LIMITS } from './runpay-json.mjs';
import { RUNPAY_PROFILE, RUNPAY_PROFILE_ID, RUNPAY_PROFILE_DIGEST } from './runpay-profile.mjs';
export { RUNPAY_PROFILE_ID, RUNPAY_PROFILE_DIGEST, RUNPAY_PROFILE, RUNPAY_ISSUE_URL } from './runpay-profile.mjs';
export { RunpayImportError, parseRunpayJson, canonicalRunpayJson } from './runpay-json.mjs';

const fail = (code) => { throw new RunpayImportError(code); };
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const has = (value, key) => Object.hasOwn(value, key);
const text = (value) => typeof value === 'string' && value.length ? value : null;
const abbreviated = (value) => typeof value === 'string' && /…|\.\.\./u.test(value);
const redactedMarker = (value) => typeof value === 'string' && value.includes('[redacted]');
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const secretLike = (value) => typeof value === 'string' && /(?:\b(?:bearer|basic)\s+\S+|\b(?:amk_|sk_(?:live|test)_|sk-proj-|nvm_(?:live|sandbox)_)[A-Za-z0-9_-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/i.test(value);
const allKeys = (obj, allowed) => { if (Object.keys(obj).some((key) => !allowed.includes(key))) fail('invalid_envelope'); };

const RECORD_KINDS = ['catalog_service', 'observability_record'];

function validateEnvelope(input, allowArray = false) {
  if (!object(input)) fail('invalid_envelope');
  allKeys(input, ['schema', 'source', 'profile_id', 'profile_digest', 'record', 'history']);
  if (input.schema !== 'agoragentic.runpay-catalog.v1' || !object(input.source) || !object(input.record)) fail('invalid_envelope');
  allKeys(input.source, ['provider', 'namespace', 'record_kind', 'schema_revision', 'captured_at', 'record_ref']);
  allKeys(input.record, ['raw']);
  if (input.source.provider !== 'runpay' || !RECORD_KINDS.includes(input.source.record_kind)) fail('invalid_envelope');
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

/**
 * Exact decimal price. JSON numbers only: a string price is non-numeric and
 * rejected. The canonical form is the shortest round-trip decimal of the
 * parsed double; exponent forms are rejected so the stored value is always a
 * plain decimal string. 0.015 USD is never converted to integer cents.
 */
export function canonicalPrice(value) {
  if (typeof value !== 'number') fail('invalid_price');
  if (!Number.isFinite(value)) fail('unsafe_number');
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) fail('unsafe_number');
  if (value < 0) fail('invalid_price');
  const canonical = String(value);
  if (/[eE]/.test(canonical)) fail('invalid_price');
  return canonical;
}

/**
 * Settlement reference classification. A redacted or abbreviated reference
 * is recorded as-is with its kind; it is never usable as settlement proof
 * (see assertRunpaySettlementEvidence).
 */
export function validateRunpaySettlementRef(value) {
  const ref = text(value);
  if (!ref) return { value: null, kind: 'absent' };
  if (redactedMarker(ref)) return { value: ref, kind: 'redacted' };
  if (abbreviated(ref)) return { value: ref, kind: 'abbreviated' };
  if (/^0x[0-9a-fA-F]{64}$/.test(ref)) return { value: ref.toLowerCase(), kind: 'evm_tx_hash' };
  return { value: ref, kind: 'opaque' };
}

/** Throw unless the record carries a full, unredacted settlement reference. */
export function assertRunpaySettlementEvidence(record) {
  const kind = record?.core?.observability?.settlement_ref_kind;
  if (kind !== 'evm_tx_hash') fail('invalid_settlement_evidence');
  return record.core.observability.settlement_ref;
}

function checkFieldString(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') fail('invalid_record_field');
  if (/[\x00-\x1f\x7f]/.test(value)) fail('invalid_record_field');
  if (secretLike(value)) fail('secret_in_evidence_field');
  return value.length ? value : null;
}
function checkNumber(value, field, { integer = false } = {}) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail('invalid_record_field');
  if (integer && (!Number.isInteger(value) || !Number.isSafeInteger(value))) fail('invalid_record_field');
  return value;
}

/** Retain only profile-allowlisted fields; unknown fields are dropped before hashing. */
function redactedRecord(raw, kind, dropped) {
  if (!object(raw)) fail('invalid_record');
  const allowed = kind === 'catalog_service' ? RUNPAY_PROFILE.service_fields : RUNPAY_PROFILE.observability_fields;
  const retained = Object.create(null);
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) { dropped.push(key); continue; }
    const value = raw[key];
    if (key === 'schema_input' || key === 'schema_output') {
      if (value !== null && !object(value)) fail('invalid_record_field');
      retained[key] = value === null ? null : value;
    } else if (key === 'chain') {
      if (!object(value)) fail('invalid_record_field');
      retained[key] = redactChain(value, dropped);
    } else if (key === 'price_per_call') {
      // Exactness is validated by canonicalPrice; strings are non-numeric prices.
      if (value !== null && typeof value !== 'number') fail('invalid_price');
      retained[key] = value;
    } else if (['trust_score', 'total_calls', 'avg_ms', 'error_rate'].includes(key)) {
      if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) fail('invalid_record_field');
      retained[key] = value;
    } else {
      retained[key] = checkFieldString(value, key);
    }
  }
  return retained;
}

function redactChain(chain, dropped) {
  const retained = Object.create(null);
  for (const key of Object.keys(chain)) {
    if (!RUNPAY_PROFILE.chain_fields.includes(key)) { dropped.push(`chain.${key}`); continue; }
    const value = chain[key];
    if (key === 'declared_intent') {
      if (value === null || value === undefined) { retained[key] = null; continue; }
      if (!object(value)) fail('invalid_record_field');
      const intent = Object.create(null);
      for (const ikey of Object.keys(value)) {
        if (!RUNPAY_PROFILE.declared_intent_fields.includes(ikey)) { dropped.push(`chain.declared_intent.${ikey}`); continue; }
        intent[ikey] = ikey === 'max_expected_amount' ? value[ikey] : checkFieldString(value[ikey], ikey);
      }
      retained[key] = intent;
    } else if (key === 'price_usd') {
      // Exactness is validated by canonicalPrice; strings are non-numeric prices.
      if (value !== null && typeof value !== 'number') fail('invalid_price');
      retained[key] = value;
    } else {
      retained[key] = checkFieldString(value, key);
    }
  }
  return retained;
}

const notChecked = () => ({
  independent_settlement: { provenance: 'reported_observation', chain_status: 'not_checked', matching_status: 'not_checked', evidence_ref: null },
  commercial_price: 'not_checked',
  authority: 'not_checked',
  outcome: 'not_checked',
});

function declarationStatus(serviceId) {
  const declared = RUNPAY_PROFILE.schema_declarations[serviceId];
  return declared ? { input: declared.input, output: declared.output } : { input: 'undeclared', output: 'undeclared' };
}

function baseRecord(input) {
  validateEnvelope(input);
  const kind = input.source.record_kind;
  const dropped = [];
  const retained = redactedRecord(input.record.raw, kind, dropped);
  const droppedFields = [...new Set(dropped)].sort();
  const warnings = [];
  if (droppedFields.length) warnings.push('source_fields_omitted');
  const known = input.profile_id === RUNPAY_PROFILE_ID && input.source.schema_revision === RUNPAY_PROFILE.revision;
  if (known && input.profile_digest !== undefined && input.profile_digest !== RUNPAY_PROFILE_DIGEST) fail('profile_digest_mismatch');
  const source = {
    provider: 'runpay', namespace: input.source.namespace,
    record_kind: kind, schema_revision: input.source.schema_revision,
    provenance: 'vendor_supplied_fixture',
    attribution: 'run.pay',
    fetched_live: false,
    redacted_source_hash: digestJson(retained), hash_scope: 'redacted_bounded_source',
    canonicalization: 'rfc8785-jcs', redaction_profile: RUNPAY_PROFILE.redaction.id,
    extraction_profile: { id: input.profile_id, version: known ? RUNPAY_PROFILE.version : null, digest: known ? RUNPAY_PROFILE_DIGEST : null },
    source_artifact_embedded: false,
  };
  const r = known ? retained : Object.create(null);
  if (!known) warnings.push('unsupported_profile');

  let identity, body, immutable;
  if (kind === 'catalog_service') {
    const serviceId = text(r.id);
    if (known && (!serviceId || serviceId.length > 256 || /\s/u.test(serviceId) || abbreviated(serviceId))) fail('invalid_record');
    const price = has(r, 'price_per_call') && r.price_per_call !== null ? canonicalPrice(r.price_per_call) : null;
    if (known && has(r, 'price_per_call') && r.price_per_call !== null && price === null) fail('invalid_price');
    const schemaDeclaration = known ? declarationStatus(serviceId) : { input: 'undeclared', output: 'undeclared' };
    if (known && !RUNPAY_PROFILE.schema_declarations[serviceId]) warnings.push('schema_declaration_unknown');
    const service = {
      service_id: known ? serviceId : null,
      name: text(r.name), description: text(r.description), category: text(r.category),
      vendor_name: text(r.vendor_name),
      price_exact: price, price_currency: text(r.currency),
      price_precision: RUNPAY_PROFILE.price_precision,
      schema_declaration: schemaDeclaration,
      input_schema_digest: object(r.schema_input) ? digestJson(r.schema_input) : null,
      output_schema_digest: object(r.schema_output) ? digestJson(r.schema_output) : null,
      // Vendor-reported catalog stats: never verified, never a trust signal.
      vendor_reported: {
        trust_score: checkNumber(r.trust_score), total_calls: checkNumber(r.total_calls, null, { integer: true }),
        avg_ms: checkNumber(r.avg_ms), error_rate: checkNumber(r.error_rate),
      },
    };
    if (known) {
      if (!text(r.name)) warnings.push('service_name_unavailable');
      if (!text(r.category)) warnings.push('service_category_unavailable');
      if (price === null) warnings.push('price_uncheckable');
      if (!text(r.currency)) warnings.push('price_currency_unavailable');
      if (schemaDeclaration.output === 'undeclared') warnings.push('output_schema_undeclared');
    }
    const serviceKey = known && serviceId ? digestJson(['runpay.service.v1', 'runpay', input.source.namespace, serviceId]) : null;
    identity = { service_key: serviceKey, observation_key: null };
    body = { service };
    immutable = {
      service_id: service.service_id, category: service.category,
      price_exact: service.price_exact, price_currency: service.price_currency,
      vendor_name: service.vendor_name, schema_declaration: service.schema_declaration,
    };
  } else {
    const chain = object(r.chain) ? r.chain : Object.create(null);
    const intent = object(chain.declared_intent) ? chain.declared_intent : null;
    const declaredIntent = intent ? {
      intent_id: text(intent.intent_id), description: text(intent.description),
      expected_category: text(intent.expected_category),
      max_expected_amount_exact: intent.max_expected_amount === undefined || intent.max_expected_amount === null ? null : canonicalPrice(intent.max_expected_amount),
    } : null;
    const price = chain.price_usd === undefined || chain.price_usd === null ? null : canonicalPrice(chain.price_usd);
    const settlement = validateRunpaySettlementRef(chain.transaction_id);
    const observability = {
      service_selected: text(chain.service_selected), category: text(chain.category),
      vendor_selected: text(chain.vendor_selected),
      price_exact: price, price_currency: 'USD',
      price_precision: RUNPAY_PROFILE.price_precision,
      declared_intent: declaredIntent,
      payment_status: text(chain.payment_status),
      execution_status: null,
      settlement_ref: settlement.value, settlement_ref_kind: settlement.kind,
      settlement_usable_as_evidence: false,
      timestamp: text(chain.timestamp),
    };
    if (known) {
      if (!declaredIntent) warnings.push('declared_intent_absent');
      if (!text(chain.service_selected)) warnings.push('service_selection_unavailable');
      if (price === null) warnings.push('price_uncheckable');
      if (!text(chain.payment_status)) warnings.push('payment_status_unavailable');
      warnings.push('execution_evidence_absent');
      if (settlement.kind !== 'evm_tx_hash') warnings.push('settlement_reference_unavailable');
      if (settlement.kind === 'redacted') warnings.push('settlement_reference_redacted');
    }
    const observationKey = known ? digestJson(['runpay.observation.v1', 'runpay', input.source.namespace, source.redacted_source_hash]) : null;
    identity = { service_key: null, observation_key: observationKey };
    body = { observability };
    immutable = {
      service_selected: observability.service_selected, category: observability.category,
      price_exact: observability.price_exact, price_currency: observability.price_currency,
      vendor_name: observability.vendor_selected, declared_intent: observability.declared_intent,
      payment_status: observability.payment_status,
    };
  }
  source.source_core_digest = digestJson({ record_kind: kind, ...immutable });
  const INCOMPLETE_WARNINGS = [
    'service_name_unavailable', 'service_category_unavailable',
    'price_uncheckable', 'price_currency_unavailable',
    'service_selection_unavailable', 'payment_status_unavailable',
  ];
  const incomplete = known && warnings.some((w) => INCOMPLETE_WARNINGS.includes(w));
  const record = {
    schema: 'agoragentic.runpay-evidence.v1',
    core: {
      source,
      identity,
      authority_refs: { mandate_ref: null, principal_ref: null, agent_ref: null },
      service: kind === 'catalog_service' ? body.service : null,
      observability: kind === 'observability_record' ? body.observability : null,
      // This is only the redacted allowlisted projection, not the full source export.
      original: retained,
    },
    observation_context: { captured_at: input.source.captured_at ?? null, record_ref_hash: input.source.record_ref ? digestJson(input.source.record_ref) : null },
    assessment: {
      parse_status: incomplete ? 'incomplete' : 'accepted',
      import_disposition: 'new',
      prior_observation_keys: [],
      conflicts: [],
      support: { pinned_profile: known },
      ...notChecked(),
      overall_evidence_status: known ? 'unresolved' : 'unsupported',
      warnings: [...new Set(warnings)].sort(),
      dropped_fields: droppedFields,
    },
  };
  return record;
}

function facts(core) {
  if (core.service) {
    const s = core.service;
    return { service_id: s.service_id, name: s.name, category: s.category, price_exact: s.price_exact, price_currency: s.price_currency, vendor_name: s.vendor_name, schema_declaration: s.schema_declaration };
  }
  const o = core.observability;
  return { service_selected: o.service_selected, category: o.category, price_exact: o.price_exact, payment_status: o.payment_status, settlement_ref: o.settlement_ref, declared_intent: o.declared_intent };
}
function compare(current, previous) {
  const a = facts(current.core); const b = facts(previous.core);
  return RUNPAY_PROFILE.immutable_fields.filter((key) =>
    !['schema_declaration', 'declared_intent'].includes(key) &&
    a[key] !== undefined && b[key] !== undefined && a[key] !== null && b[key] !== null &&
    digestJson(a[key]) !== digestJson(b[key]));
}

function assessHistory(record, history) {
  const key = record.core.identity.service_key ?? record.core.identity.observation_key;
  if (!key) return freezeDeep(record);
  const peers = history.filter((p) =>
    (p.core.identity.service_key ?? p.core.identity.observation_key) === key &&
    p.core.source.extraction_profile.digest === record.core.source.extraction_profile.digest);
  const refs = peers.map((p) => p.core.identity.service_key ?? p.core.identity.observation_key).filter(Boolean);
  record.assessment.prior_observation_keys = [...new Set(refs)].sort();
  const conflicts = [...new Set(peers.flatMap((p) => compare(record, p)))].sort();
  record.assessment.conflicts = conflicts;
  // Contradictory supplied assertions are not independently established chain facts.
  // Missing delivery or an exact duplicate must never erase an existing conflict.
  if (conflicts.length) {
    record.assessment.import_disposition = 'conflict';
    record.assessment.overall_evidence_status = 'contradicted';
  } else if (refs.includes(key)) record.assessment.import_disposition = 'duplicate';
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
export function normalizeRunpayRecord(input, options = {}) {
  const data = snapshotJson(input); const opts = snapshotJson(options);
  if (Buffer.byteLength(JSON.stringify(data)) + Buffer.byteLength(JSON.stringify(opts)) > LIMITS.bytes) fail('input_too_large');
  if (!object(opts) || !object(data)) fail('invalid_envelope');
  allKeys(opts, ['profileId', 'history']);
  if (opts.profileId !== undefined && opts.profileId !== data.profile_id) fail('profile_id_mismatch');
  const record = baseRecord(data);
  return assessHistory(record, historyRecords(data, opts));
}

/** Bounded batch import. Every row is compared to the entire batch; no last-write-wins selection. */
export function normalizeRunpayBatch(input) {
  const data = snapshotJson(input);
  validateEnvelope(data, true);
  const rows = Array.isArray(data.record.raw) ? data.record.raw : [data.record.raw];
  if (rows.length > LIMITS.records) fail('limit_exceeded');
  const prior = historyRecords(data, {});
  if (rows.length + prior.length > LIMITS.records) fail('limit_exceeded');
  const records = rows.map((raw) => baseRecord({ ...data, record: { raw }, history: [] }));
  // Earlier duplicates get 'new'; contradictions anywhere in a batch affect both observations.
  return freezeDeep({
    schema: 'agoragentic.runpay-evidence-batch.v1',
    records: records.map((record, index) => {
      const peers = [...prior, ...records.filter((other, i) => i !== index && (i < index || (other.core.identity.service_key ?? other.core.identity.observation_key) !== (record.core.identity.service_key ?? record.core.identity.observation_key)))];
      return assessHistory(record, peers);
    }),
  });
}

/** No settlement verifier exists; redacted or abbreviated references are never evidence. */
export function renderRunpayReport(record) {
  const c = record.core; const a = record.assessment;
  const quote = (value) => JSON.stringify(value ?? null);
  const lines = [
    'RUNPAY EVIDENCE — OFFLINE (VENDOR-SUPPLIED, UNVERIFIED)',
    `Profile: ${RUNPAY_PROFILE_ID}; basis: vendor-supplied fixtures from ${RUNPAY_PROFILE.issue}.`,
  ];
  if (c.service) {
    lines.push(`Service: ${quote(c.service.name)} (${quote(c.service.service_id)}); vendor ${quote(c.service.vendor_name)}.`);
    lines.push(`Price: ${quote(c.service.price_exact)} ${quote(c.service.price_currency)} exact decimal; never integer cents.`);
    lines.push(`Schema declarations: input ${c.service.schema_declaration.input}, output ${c.service.schema_declaration.output}.`);
    lines.push('Catalog stats are vendor-reported, not verified and not a trust signal.');
  }
  if (c.observability) {
    const o = c.observability;
    lines.push(`Observed call: ${quote(o.service_selected)}; provider-reported payment status ${quote(o.payment_status)}.`);
    lines.push(`Declared intent: ${o.declared_intent ? 'present (opt-in)' : 'absent (opt-in, not supplied)'}; execution evidence: not reported.`);
    lines.push(`Settlement reference: ${quote(o.settlement_ref_kind)}; usable as settlement evidence: no.`);
  }
  lines.push(
    'Independently checked: nothing. Settlement, authority, commercial price, and outcome remain not_checked.',
    `Import: ${a.import_disposition}; overall evidence: ${a.overall_evidence_status}.`,
    `Warnings: ${a.warnings.join(', ') || 'none'}.`,
    `Dropped fields: ${a.dropped_fields.join(', ') || 'none'}.`,
    `Conflicting supplied fields: ${a.conflicts.join(', ') || 'none'}.`,
    'Next safe step: inspect the report and supply missing evidence locally. No purchase or automatic retry.',
  );
  return lines.join('\n') + '\n';
}
