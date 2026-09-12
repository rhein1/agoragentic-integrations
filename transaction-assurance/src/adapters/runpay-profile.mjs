import { digestJson, freezeDeep, LIMITS } from './runpay-json.mjs';

/**
 * Pinned extraction profile for the run.pay offline evidence importer.
 *
 * Basis: vendor-supplied fixtures from PalabreX in
 * https://github.com/rhein1/agoragentic-integrations/issues/376
 * (2026-09-08/09). This is experimental compatibility work: the catalog
 * endpoint below is recorded as provenance only and is NEVER fetched by the
 * importer. No invocation, payment, settlement, or production-readiness claim
 * is established by anything this profile imports.
 */
export const RUNPAY_PROFILE_ID = 'runpay.catalog.2026-09-09';
export const RUNPAY_ISSUE_URL = 'https://github.com/rhein1/agoragentic-integrations/issues/376';
export const RUNPAY_PROFILE = freezeDeep({
  id: RUNPAY_PROFILE_ID,
  version: '1.0.0',
  revision: '2026-09-09',
  basis: 'vendor_supplied_fixture',
  issue: RUNPAY_ISSUE_URL,
  vendor: 'run.pay',
  catalog_endpoint: {
    method: 'GET',
    url: 'https://runpay-backend-visibility-production.up.railway.app/api/services/catalog',
    query_params: ['category', 'sort', 'limit', 'offset', 'max_price', 'min_price'],
    sort_values: ['trust', 'calls', 'price_asc', 'price_desc', 'newest'],
    limit_max: 200,
    pricing_unit: 'USD decimal per call, no hidden units or credits',
    fetched_live: false,
    never_fetch: true,
    note: 'Recorded as provenance only. The importer never performs network calls.',
  },
  limits: LIMITS,
  service_fields: [
    'id', 'name', 'description', 'category', 'price_per_call', 'currency',
    'vendor_name', 'trust_score', 'total_calls', 'avg_ms', 'error_rate',
    'schema_input', 'schema_output',
  ],
  observability_fields: ['chain'],
  chain_fields: [
    'declared_intent', 'vendor_selected', 'service_selected', 'category',
    'price_usd', 'payment_status', 'transaction_id', 'timestamp',
  ],
  declared_intent_fields: ['intent_id', 'description', 'expected_category', 'max_expected_amount'],
  immutable_fields: [
    'service_id', 'service_selected', 'category', 'price_exact', 'price_currency',
    'vendor_name', 'declared_intent', 'payment_status', 'schema_declaration',
  ],
  price_precision: 'arbitrary_numeric_no_rounding_rule',
  price_precision_note: 'Vendor confirmed price_per_call is unqualified numeric at the storage layer; no rounding or rejection rule exists. The importer preserves the exact decimal as a string; 0.015 USD is never converted to integer cents.',
  schema_declarations: {
    // Per-service declaration status as of the 2026-09-09 issue exchange.
    // Only 2 of 206 catalog services had declared schemas; the rest remain
    // undeclared until vendors self-declare. Unknown service ids import with
    // both statuses 'undeclared' and a warning.
    'da3ddf15-34fa-4d1e-a5cb-a7d50a08f0fc': { name: 'Consensus Aggregator', input: 'declared', output: 'undeclared' },
    'd5ff985c-e50a-431a-84f1-b339ae0700b8': { name: 'Phone Validator', input: 'declared', output: 'declared' },
  },
  redaction: {
    id: 'agoragentic.runpay-allowlist-redaction.v1',
    unknown_fields: 'drop_before_hash_and_output',
    vendor_redaction_markers: 'preserve_verbatim',
    secret_like_values: 'reject_without_echo',
  },
});
export const RUNPAY_PROFILE_DIGEST = digestJson(RUNPAY_PROFILE);
