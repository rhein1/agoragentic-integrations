#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const RUNPAY_SERVICE_IMPORT_SCHEMA = 'agoragentic.interchange.runpay-service-import.v1';
export const RUNPAY_RECEIPT_OBSERVATION_SCHEMA = 'agoragentic.interchange.runpay-receipt-observation.v1';
export const RUNPAY_CATALOG_ENDPOINT = 'https://runpay-backend-visibility-production.up.railway.app/api/services/catalog';

const SERVICE_FIXTURE_SCHEMA = 'agoragentic.interchange.runpay-service-fixture.v1';
const RECEIPT_FIXTURE_SCHEMA = 'agoragentic.interchange.runpay-receipt-fixture.v1';
const MAX_FIXTURE_BYTES = 524_288;
const MAX_SCHEMA_BYTES = 262_144;
const MAX_TEXT_LENGTH = 8_192;
const MAX_DECIMAL_LENGTH = 128;

const FALSE_AUTHORITY_FLAGS = Object.freeze({
  eligible_for_execution: false,
  provider_identity_bound: false,
  live_catalog_polling_enabled: false,
  remote_invocation_enabled: false,
  payment_enabled: false,
  wallet_spend_enabled: false,
  trust_mutation_enabled: false,
  marketplace_publication_enabled: false,
  public_execute_enabled: false,
});

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  const out = Object.create(null);
  for (const key of Object.keys(value).sort()) {
    const child = value[key];
    if (child !== undefined) {
      Object.defineProperty(out, key, {
        value: canonicalize(child),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  return out;
}

export function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

export function hashRef(value) {
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

function assertJsonSize(value, maxBytes, code) {
  let serialized;
  try {
    serialized = stableStringify(value);
  } catch {
    throw new Error(`${code}_not_serializable`);
  }
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) throw new Error(code);
}

function boundedText(value, { code, maxLength = MAX_TEXT_LENGTH, allowEmpty = false } = {}) {
  if (typeof value !== 'string') throw new Error(code);
  const text = value.trim();
  if ((!allowEmpty && !text) || text.length > maxLength) throw new Error(code);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw new Error(`${code}_control_character`);
  }
  return text;
}

function validTimestamp(value, code) {
  const text = boundedText(value, { code, maxLength: 64 });
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(text)) throw new Error(code);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 19) !== text.slice(0, 19)) {
    throw new Error(code);
  }
  return text;
}

export function exactDecimal(value, { code = 'runpay_decimal_string_required', allowZero = true } = {}) {
  if (typeof value !== 'string' || value.length > MAX_DECIMAL_LENGTH) throw new Error(code);
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) throw new Error(code);
  if (!allowZero && /^0(?:\.0+)?$/.test(value)) throw new Error(code);
  return value;
}

function decimalParts(value) {
  const [whole, fraction = ''] = value.split('.');
  return { whole: BigInt(whole), fraction: fraction.replace(/0+$/, '') };
}

export function compareExactDecimals(left, right) {
  const a = decimalParts(exactDecimal(left));
  const b = decimalParts(exactDecimal(right));
  if (a.whole !== b.whole) return a.whole < b.whole ? -1 : 1;
  const width = Math.max(a.fraction.length, b.fraction.length);
  const aFraction = BigInt((a.fraction || '0').padEnd(width, '0'));
  const bFraction = BigInt((b.fraction || '0').padEnd(width, '0'));
  return aFraction === bFraction ? 0 : aFraction < bFraction ? -1 : 1;
}

function nonNegativeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(code);
  return value;
}

function boundedNumber(value, { code, minimum = 0, maximum = Number.MAX_VALUE }) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(code);
  }
  return value;
}

function normalizeSchemaEvidence(schema, status, field) {
  if (!['declared', 'reconstructed', 'missing'].includes(status)) {
    throw new Error(`runpay_${field}_schema_status_invalid`);
  }
  if (status === 'missing') {
    if (schema !== null && schema !== undefined) throw new Error(`runpay_${field}_schema_must_be_absent`);
    return { status, schema: null, schema_hash: null };
  }
  if (!isRecord(schema)) throw new Error(`runpay_${field}_schema_required`);
  assertJsonSize(schema, MAX_SCHEMA_BYTES, `runpay_${field}_schema_too_large`);
  return { status, schema, schema_hash: hashRef(schema) };
}

function assertFixtureSource(source) {
  if (!isRecord(source)) throw new Error('runpay_fixture_source_required');
  if (source.catalog_endpoint !== RUNPAY_CATALOG_ENDPOINT) throw new Error('runpay_catalog_endpoint_mismatch');
  const issueUrl = boundedText(source.issue_url, { code: 'runpay_issue_url_required', maxLength: 512 });
  if (!/^https:\/\/github\.com\/rhein1\/agoragentic-integrations\/issues\/376#issuecomment-\d+$/.test(issueUrl)) {
    throw new Error('runpay_issue_url_invalid');
  }
  return { catalog_endpoint: RUNPAY_CATALOG_ENDPOINT, issue_url: issueUrl };
}

/**
 * Normalize one operator-reviewed run.pay service fixture without network I/O.
 * Money must arrive as an exact decimal string; JavaScript numbers are rejected.
 */
export function normalizeRunpayServiceFixture(fixture = {}) {
  if (!isRecord(fixture) || fixture.fixture_schema !== SERVICE_FIXTURE_SCHEMA) {
    throw new Error('runpay_service_fixture_required');
  }
  assertJsonSize(fixture, MAX_FIXTURE_BYTES, 'runpay_service_fixture_too_large');
  const source = assertFixtureSource(fixture.source);
  const generatedAt = validTimestamp(fixture.captured_at, 'runpay_captured_at_invalid');
  if (!isRecord(fixture.service)) throw new Error('runpay_service_required');
  if (!isRecord(fixture.schema_provenance)) throw new Error('runpay_schema_provenance_required');

  const service = fixture.service;
  const serviceId = boundedText(service.id, { code: 'runpay_service_id_required', maxLength: 64 });
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(serviceId)) {
    throw new Error('runpay_service_id_invalid');
  }
  const name = boundedText(service.name, { code: 'runpay_service_name_required', maxLength: 256 });
  const description = boundedText(service.description, { code: 'runpay_service_description_required' });
  const category = boundedText(service.category, { code: 'runpay_category_required', maxLength: 64 });
  if (!/^[A-Z][A-Z0-9_-]*$/.test(category)) throw new Error('runpay_category_invalid');
  const unitPrice = exactDecimal(service.price_per_call, {
    code: 'runpay_price_per_call_exact_decimal_string_required',
  });
  const currency = boundedText(service.currency, { code: 'runpay_currency_required', maxLength: 3 });
  if (currency !== 'USD') throw new Error('runpay_currency_must_be_usd');
  const vendorName = boundedText(service.vendor_name, { code: 'runpay_vendor_name_required', maxLength: 256 });
  const inputSchema = normalizeSchemaEvidence(
    service.schema_input,
    fixture.schema_provenance.input,
    'input',
  );
  const outputSchema = normalizeSchemaEvidence(
    service.schema_output,
    fixture.schema_provenance.output,
    'output',
  );

  return {
    schema: RUNPAY_SERVICE_IMPORT_SCHEMA,
    generated_at: generatedAt,
    source_kind: 'runpay_catalog_service',
    lifecycle_status: 'normalized',
    manifest_hash: hashRef(fixture),
    source: {
      provider: 'run.pay',
      attribution: 'run.pay',
      catalog_endpoint: source.catalog_endpoint,
      issue_evidence_ref: source.issue_url,
      service_id: serviceId,
      snapshot_only: true,
    },
    capability_card_input: {
      name,
      description,
      category: category.toLowerCase(),
      tags: ['runpay', 'external-catalog', 'unverified'],
      interface_kind: 'runpay_catalog_service',
      pricing: {
        pricing_model: 'per_call',
        currency,
        unit_price: unitPrice,
        exact_decimal_string: true,
      },
      input_schema: inputSchema,
      output_schema: outputSchema,
    },
    source_observations: {
      vendor_name: vendorName,
      trust_score: nonNegativeInteger(service.trust_score, 'runpay_trust_score_invalid'),
      total_calls: nonNegativeInteger(service.total_calls, 'runpay_total_calls_invalid'),
      average_latency_ms: boundedNumber(service.avg_ms, { code: 'runpay_average_latency_invalid' }),
      error_rate: boundedNumber(service.error_rate, {
        code: 'runpay_error_rate_invalid',
        minimum: 0,
        maximum: 1,
      }),
      metrics_are_source_reported: true,
      trust_score_verified: false,
      current_reachability_verified: false,
    },
    eligibility: {
      eligible: false,
      blockers: [
        'runpay_provider_account_binding_required',
        'runpay_catalog_snapshot_freshness_required',
        'runpay_trust_methodology_review_required',
        'commercial_terms_binding_required',
        'execution_and_payment_authorization_required',
        'outcome_validator_required',
      ],
    },
    authority_flags: { ...FALSE_AUTHORITY_FLAGS },
    safety: {
      metadata_only: true,
      offline_fixture_only: true,
      external_calls_made: false,
      provider_invoked: false,
      funds_moved: false,
      source_attribution_preserved: true,
      exact_money_strings_required: true,
    },
  };
}

function normalizeIntent(intent, { price, category }) {
  if (intent === null || intent === undefined) {
    return {
      status: 'absent',
      authorization_verified: false,
      price_within_declared_max: null,
      intent_ref: null,
      description: null,
      expected_category: null,
      max_expected_amount: null,
    };
  }
  if (!isRecord(intent)) throw new Error('runpay_declared_intent_invalid');
  const intentId = boundedText(intent.intent_id, { code: 'runpay_intent_id_required', maxLength: 256 });
  const description = boundedText(intent.description, { code: 'runpay_intent_description_required' });
  const expectedCategory = boundedText(intent.expected_category, {
    code: 'runpay_intent_category_required',
    maxLength: 64,
  });
  if (expectedCategory !== category) throw new Error('runpay_intent_category_mismatch');
  const maxExpectedAmount = exactDecimal(intent.max_expected_amount, {
    code: 'runpay_intent_max_exact_decimal_string_required',
  });
  if (compareExactDecimals(price, maxExpectedAmount) > 0) throw new Error('runpay_price_exceeds_declared_intent_max');
  return {
    status: 'source_reported_present',
    authorization_verified: false,
    price_within_declared_max: true,
    intent_ref: hashRef({ intent_id: intentId }),
    description,
    expected_category: expectedCategory,
    max_expected_amount: maxExpectedAmount,
  };
}

/**
 * Normalize a redacted run.pay observability record. The source-reported
 * payment status never becomes verified settlement or execution evidence.
 */
export function normalizeRunpayReceiptFixture({ receiptFixture, serviceFixture } = {}) {
  if (!isRecord(receiptFixture) || receiptFixture.fixture_schema !== RECEIPT_FIXTURE_SCHEMA) {
    throw new Error('runpay_receipt_fixture_required');
  }
  assertJsonSize(receiptFixture, MAX_FIXTURE_BYTES, 'runpay_receipt_fixture_too_large');
  const source = assertFixtureSource(receiptFixture.source);
  if (!isRecord(receiptFixture.chain)) throw new Error('runpay_receipt_chain_required');
  const servicePacket = normalizeRunpayServiceFixture(serviceFixture);
  const chain = receiptFixture.chain;
  const serviceName = boundedText(chain.service_selected, {
    code: 'runpay_receipt_service_name_required',
    maxLength: 256,
  });
  if (serviceName !== servicePacket.capability_card_input.name) throw new Error('runpay_receipt_service_mismatch');
  const category = boundedText(chain.category, { code: 'runpay_receipt_category_required', maxLength: 64 });
  if (category.toLowerCase() !== servicePacket.capability_card_input.category) {
    throw new Error('runpay_receipt_category_mismatch');
  }
  const price = exactDecimal(chain.price_usd, {
    code: 'runpay_receipt_price_exact_decimal_string_required',
  });
  if (compareExactDecimals(price, servicePacket.capability_card_input.pricing.unit_price) !== 0) {
    throw new Error('runpay_receipt_price_mismatch');
  }
  const observedAt = validTimestamp(chain.timestamp, 'runpay_receipt_timestamp_invalid');
  const paymentStatus = boundedText(chain.payment_status, {
    code: 'runpay_payment_status_required',
    maxLength: 64,
  });
  const transactionId = boundedText(chain.transaction_id, {
    code: 'runpay_transaction_id_required',
    maxLength: 512,
  });
  const vendorSelected = boundedText(chain.vendor_selected, {
    code: 'runpay_vendor_selected_required',
    maxLength: 256,
  });

  return {
    schema: RUNPAY_RECEIPT_OBSERVATION_SCHEMA,
    generated_at: observedAt,
    source_kind: 'runpay_observability_record',
    lifecycle_status: 'normalized',
    observation_hash: hashRef(receiptFixture),
    source: {
      provider: 'run.pay',
      attribution: 'run.pay',
      catalog_endpoint: source.catalog_endpoint,
      issue_evidence_ref: source.issue_url,
      source_record_redacted: true,
    },
    service_binding: {
      service_id: servicePacket.source.service_id,
      source_service_name: serviceName,
      vendor_selected: vendorSelected,
      binding_method: 'offline_fixture_name_match',
      source_record_included_service_id: false,
      provider_identity_verified: false,
    },
    declared_intent: normalizeIntent(chain.declared_intent, { price, category }),
    execution: {
      status: 'unknown',
      outcome_present: false,
      outcome_verified: false,
    },
    payment: {
      source_reported_status: paymentStatus,
      amount: price,
      currency: 'USD',
      transaction_ref: hashRef({ transaction_id: transactionId }),
      raw_transaction_id_retained: false,
    },
    settlement: {
      status: 'unverified_source_report',
      confirmed: false,
      verification_performed: false,
      chain_receipt_observed: false,
    },
    authority_flags: { ...FALSE_AUTHORITY_FLAGS },
    safety: {
      offline_fixture_only: true,
      external_calls_made: false,
      provider_invoked: false,
      funds_moved_by_adapter: false,
      credentials_read: false,
      raw_transaction_id_public: false,
      source_payment_status_not_promoted: true,
    },
  };
}

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--service') out.servicePath = argv[++index];
    else if (arg === '--receipt') out.receiptPath = argv[++index];
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`unknown_argument:${arg}`);
  }
  return out;
}

function helpText() {
  return `Usage:
  node interchange/runpay/normalize.mjs --service <service-fixture.json>
  node interchange/runpay/normalize.mjs --service <service-fixture.json> --receipt <receipt-fixture.json>

Inputs must be offline compatibility fixtures with money represented as exact
decimal strings. The normalizer performs no network, provider, wallet, payment,
trust, publication, or execution action.`;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(helpText());
    return;
  }
  if (!args.servicePath) throw new Error('runpay_service_path_required');
  const serviceFixture = await readJson(args.servicePath);
  const output = args.receiptPath
    ? normalizeRunpayReceiptFixture({
      receiptFixture: await readJson(args.receiptPath),
      serviceFixture,
    })
    : normalizeRunpayServiceFixture(serviceFixture);
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isEntrypoint) {
  main().catch((error) => {
    console.error(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  });
}
