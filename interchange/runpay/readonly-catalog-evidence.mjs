#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  canonicalRunpayJson,
  parseRunpayJson,
} from '../../transaction-assurance/src/adapters/runpay-json.mjs';
import { RUNPAY_PROFILE } from '../../transaction-assurance/src/adapters/runpay-profile.mjs';
import { exactDecimal, hashRef } from './normalize.mjs';

export const RUNPAY_READONLY_EVIDENCE_SCHEMA = 'agoragentic.interchange.runpay-readonly-catalog-evidence.v1';
export const RUNPAY_ISSUE_395 = 'https://github.com/rhein1/agoragentic-integrations/issues/395';
export const RUNPAY_AUTHORIZATION_REF = `${RUNPAY_ISSUE_395}#issuecomment-5667477524`;

const AUTHORIZED_ENDPOINT = 'https://runpay-backend-visibility-production.up.railway.app/api/services/catalog';
const AUTHORIZED_AFTER = Date.parse('2026-09-14T16:46:41Z');
const AUTHORIZED_BEFORE = Date.parse('2026-09-28T16:46:41Z');
const MAX_REQUESTS = 3;
const MAX_RESPONSE_BYTES = 262_144;
const MAX_PAGE_SIZE = 20;
const KNOWN_FIXTURES = Object.freeze({
  consensus_aggregator: 'da3ddf15-34fa-4d1e-a5cb-a7d50a08f0fc',
  phone_validator: 'd5ff985c-e50a-431a-84f1-b339ae0700b8',
});

const fail = (code) => { throw new Error(code); };
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256Bytes = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sortedUnique = (values) => [...new Set(values)].sort();

function boundedText(value, code, maxLength = 2_048) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength) fail(code);
  if (/[\u0000-\u001f\u007f]/u.test(value)) fail(code);
  return value;
}

function exactTimestamp(value, code) {
  const text = boundedText(value, code, 64);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/u.exec(text);
  const timestamp = Date.parse(text);
  if (!match || !Number.isFinite(timestamp)) fail(code);
  const parsed = new Date(timestamp);
  const components = [
    parsed.getUTCFullYear(),
    parsed.getUTCMonth() + 1,
    parsed.getUTCDate(),
    parsed.getUTCHours(),
    parsed.getUTCMinutes(),
    parsed.getUTCSeconds(),
  ];
  if (components.some((component, index) => component !== Number(match[index + 1]))) fail(code);
  return { text, timestamp };
}

function validateUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { fail('runpay_capture_url_invalid'); }
  if (`${parsed.origin}${parsed.pathname}` !== AUTHORIZED_ENDPOINT || parsed.username || parsed.password || parsed.hash) {
    fail('runpay_capture_url_not_authorized');
  }
  for (const key of parsed.searchParams.keys()) {
    if (!RUNPAY_PROFILE.catalog_endpoint.query_params.includes(key)) fail('runpay_capture_query_not_authorized');
  }
  const limitText = parsed.searchParams.get('limit');
  const offsetText = parsed.searchParams.get('offset');
  if (!limitText || !/^\d+$/u.test(limitText) || Number(limitText) < 1 || Number(limitText) > MAX_PAGE_SIZE) {
    fail('runpay_capture_limit_invalid');
  }
  if (!offsetText || !/^\d+$/u.test(offsetText) || !Number.isSafeInteger(Number(offsetText))) {
    fail('runpay_capture_offset_invalid');
  }
  return { value: parsed.toString(), limit: Number(limitText), offset: Number(offsetText) };
}

function validateManifest(manifest, captureBuffers) {
  if (!isRecord(manifest) || manifest.issue !== RUNPAY_ISSUE_395 || manifest.authorization !== RUNPAY_AUTHORIZATION_REF) {
    fail('runpay_capture_manifest_invalid');
  }
  if (!Number.isSafeInteger(manifest.request_count) || manifest.request_count < 1 || manifest.request_count > MAX_REQUESTS) {
    fail('runpay_capture_request_count_invalid');
  }
  if (!Array.isArray(manifest.captures) || manifest.captures.length !== manifest.request_count || captureBuffers.length !== manifest.request_count) {
    fail('runpay_capture_count_mismatch');
  }
  const transport = manifest.transport;
  if (!isRecord(transport)
      || transport.method !== 'GET'
      || transport.authentication !== 'none'
      || transport.credentials_supplied !== false
      || transport.redirect_followed !== false
      || transport.max_response_bytes !== MAX_RESPONSE_BYTES) {
    fail('runpay_capture_transport_invalid');
  }

  let previousCompletedAt = null;
  return manifest.captures.map((capture, index) => {
    if (!isRecord(capture) || capture.request !== index + 1 || capture.http_status !== 200) fail('runpay_capture_metadata_invalid');
    if (typeof capture.content_type !== 'string' || !capture.content_type.toLowerCase().startsWith('application/json')) {
      fail('runpay_capture_content_type_invalid');
    }
    const started = exactTimestamp(capture.started_at, 'runpay_capture_timestamp_invalid');
    const completed = exactTimestamp(capture.completed_at, 'runpay_capture_timestamp_invalid');
    if (completed.timestamp < started.timestamp || started.timestamp < AUTHORIZED_AFTER || completed.timestamp > AUTHORIZED_BEFORE) {
      fail('runpay_capture_timestamp_not_authorized');
    }
    if (previousCompletedAt !== null && started.timestamp < previousCompletedAt) fail('runpay_capture_timestamp_out_of_order');
    previousCompletedAt = completed.timestamp;
    const buffer = captureBuffers[index];
    if (!Buffer.isBuffer(buffer) || buffer.length < 1 || buffer.length > MAX_RESPONSE_BYTES) fail('runpay_capture_size_invalid');
    if (capture.bytes !== buffer.length || capture.sha256 !== sha256Bytes(buffer)) fail('runpay_capture_digest_mismatch');
    return {
      request: capture.request,
      started_at: started.text,
      completed_at: completed.text,
      url: validateUrl(capture.url),
      http_status: capture.http_status,
      content_type: capture.content_type,
      bytes: capture.bytes,
      sha256: capture.sha256,
    };
  });
}

function normalizeService(service) {
  if (!isRecord(service)) fail('runpay_capture_service_invalid');
  const id = boundedText(service.id, 'runpay_capture_service_id_invalid', 256);
  const category = boundedText(service.category, 'runpay_capture_category_invalid', 64);
  const price = exactDecimal(service.price_per_call, { code: 'runpay_capture_price_invalid' });
  const vendorName = boundedText(service.vendor_name, 'runpay_capture_vendor_invalid', 256);
  return {
    service_ref: hashRef(['runpay.catalog.service.v1', id]),
    fixture_service: Object.values(KNOWN_FIXTURES).includes(id),
    category,
    price_exact: price,
    vendor_ref: hashRef(['runpay.catalog.vendor.v1', vendorName]),
    input_schema_present: isRecord(service.schema_input),
    output_schema_present: isRecord(service.schema_output),
  };
}

function normalizePage(document, capture) {
  if (!isRecord(document) || !Array.isArray(document.services) || !Array.isArray(document.categories)) {
    fail('runpay_capture_response_shape_invalid');
  }
  if (!Number.isSafeInteger(document.total) || document.total < 0 || typeof document.has_more !== 'boolean') {
    fail('runpay_capture_response_shape_invalid');
  }
  if (document.services.length > capture.url.limit) fail('runpay_capture_page_size_invalid');
  const categories = document.categories.map((value) => boundedText(value, 'runpay_capture_category_invalid', 64));
  const services = document.services.map(normalizeService);
  const serviceFieldSets = document.services.map((service) => Object.keys(service).sort());
  const fieldUnion = sortedUnique(serviceFieldSets.flat());
  const fieldIntersection = serviceFieldSets.length
    ? serviceFieldSets[0].filter((field) => serviceFieldSets.every((fields) => fields.includes(field)))
    : [];
  const projection = {
    request: capture.request,
    offset: capture.url.offset,
    limit: capture.url.limit,
    total: document.total,
    has_more: document.has_more,
    top_level_fields: Object.keys(document).sort(),
    service_field_union: fieldUnion,
    service_field_intersection: fieldIntersection,
    categories_observed: sortedUnique(categories),
    services,
  };
  const { request: _requestNumber, ...contentProjection } = projection;
  return {
    ...projection,
    raw_response: {
      sha256: `sha256:${capture.sha256}`,
      bytes: capture.bytes,
      embedded: false,
    },
    redacted_projection_sha256: `sha256:${sha256Bytes(Buffer.from(canonicalRunpayJson(contentProjection), 'utf8'))}`,
  };
}

function fixtureSchemaPresence(documents) {
  const services = documents.flatMap((document) => document.services);
  return Object.fromEntries(Object.entries(KNOWN_FIXTURES).map(([name, id]) => {
    const matches = services.filter((service) => service.id === id);
    return [name, {
      service_ref: hashRef(['runpay.catalog.service.v1', id]),
      observations: matches.length,
      input_schema_present: matches.some((service) => isRecord(service.schema_input)),
      output_schema_present: matches.some((service) => isRecord(service.schema_output)),
    }];
  }));
}

export function buildReadonlyCatalogEvidence({ manifest, captureBuffers }) {
  const captures = validateManifest(manifest, captureBuffers);
  const documents = captureBuffers.map((buffer) => parseRunpayJson(buffer));
  const pages = documents.map((document, index) => normalizePage(document, captures[index]));
  const fixtureSchemas = fixtureSchemaPresence(documents);
  const pageServiceRefs = pages.map((page) => page.services.map((service) => service.service_ref));
  const repeatedPageEqual = captures.length >= 2
    && captures[0].url.value === captures[1].url.value
    && captures[0].sha256 === captures[1].sha256;
  const firstPageRefs = new Set(pageServiceRefs[0] ?? []);
  const paginationOverlap = (pageServiceRefs[2] ?? []).filter((ref) => firstPageRefs.has(ref)).length;
  const totals = pages.map((page) => page.total);
  const categoryDigests = pages.map((page) => hashRef(page.categories_observed));
  const observedFields = sortedUnique(pages.flatMap((page) => page.service_field_union));
  const unknownProfileFields = observedFields.filter((field) => !RUNPAY_PROFILE.service_fields.includes(field));
  const allPrices = pages.flatMap((page) => page.services.map((service) => service.price_exact));
  const observedTotal = totals[0] ?? null;
  const affectedFixtureServices = Object.values(fixtureSchemas).filter(
    (value) => value.observations > 0 && (!value.input_schema_present || !value.output_schema_present),
  ).map((value) => value.service_ref);
  const categoriesConsistent = categoryDigests.every((digest) => digest === categoryDigests[0]);
  const findings = [];
  if (observedTotal !== 206) findings.push({ code: 'catalog_total_changed', expected: 206, observed: observedTotal });
  if (pages.some((page) => page.top_level_fields.includes('has_more'))) {
    findings.push({
      code: 'top_level_field_added',
      field: 'has_more',
      observed_on_all_pages: pages.every((page) => page.top_level_fields.includes('has_more')),
    });
  }
  if (affectedFixtureServices.length) {
    findings.push({ code: 'fixture_schema_fields_absent', affected_fixture_services: affectedFixtureServices });
  }
  if (!categoriesConsistent) findings.push({ code: 'categories_page_dependent', observed: true });
  if (unknownProfileFields.length) findings.push({ code: 'service_fields_outside_offline_profile', fields: unknownProfileFields });

  const packet = {
    schema: RUNPAY_READONLY_EVIDENCE_SCHEMA,
    recorded_at: captures.at(-1).completed_at,
    provenance: {
      issue: RUNPAY_ISSUE_395,
      authorization_ref: RUNPAY_AUTHORIZATION_REF,
      endpoint: AUTHORIZED_ENDPOINT,
      capture_kind: 'authorized_public_readonly_catalog',
      raw_capture_storage: 'operator_local_only',
      raw_capture_embedded: false,
    },
    trial: {
      request_count: captures.length,
      maximum_authorized_requests: MAX_REQUESTS,
      method: 'GET',
      authentication: 'none',
      credentials_supplied: false,
      redirect_followed: false,
      provider_invoked: false,
      payment_attempted: false,
      wallet_action_attempted: false,
      funds_moved: false,
    },
    normalization: {
      transaction_assurance_parser: 'transaction-assurance/src/adapters/runpay-json.mjs',
      transaction_assurance_profile: RUNPAY_PROFILE.id,
      interchange_decimal_contract: 'interchange/runpay/normalize.mjs#exactDecimal',
      exact_decimal_source_tokens_preserved: allPrices.every((price) => typeof price === 'string'),
      deterministic_redacted_projection: true,
      raw_service_names_retained: false,
      raw_vendor_names_retained: false,
      raw_service_endpoints_retained: false,
    },
    observations: {
      reported_service_total: observedTotal,
      total_consistent_across_pages: totals.every((total) => total === observedTotal),
      page_service_counts: pages.map((page) => page.services.length),
      unique_service_count: new Set(pageServiceRefs.flat()).size,
      repeated_first_page_byte_identical: repeatedPageEqual,
      first_and_next_page_overlap_count: paginationOverlap,
      categories_consistent_across_pages: categoriesConsistent,
      known_fixture_schema_presence: fixtureSchemas,
      pages,
    },
    contract_drift: {
      detected: findings.length > 0,
      findings,
      automatic_profile_update_allowed: false,
      automatic_listing_import_allowed: false,
    },
    authority: {
      provider_identity_verified: false,
      vendor_identity_verified: false,
      trust_score_verified: false,
      reachability_verified_beyond_catalog_get: false,
      eligible_for_execution: false,
      invocation_authorized: false,
      payment_authorized: false,
      settlement_confirmed: false,
      trust_mutation_authorized: false,
      listing_publication_authorized: false,
      deployment_authorized: false,
      production_activation_authorized: false,
    },
  };
  return { ...packet, evidence_sha256: hashRef(packet) };
}

function parseArgs(argv) {
  const result = { captures: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--manifest') result.manifest = argv[++index];
    else if (arg === '--capture') result.captures.push(argv[++index]);
    else if (arg === '--out') result.out = argv[++index];
    else if (arg === '--help' || arg === '-h') result.help = true;
    else fail('runpay_capture_argument_invalid');
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node readonly-catalog-evidence.mjs --manifest capture-manifest.json --capture response-1.json [--capture response-2.json ...] [--out evidence.json]');
    return;
  }
  if (!args.manifest || !args.captures.length) fail('runpay_capture_arguments_required');
  const manifest = JSON.parse(await readFile(args.manifest, 'utf8'));
  const captureBuffers = await Promise.all(args.captures.map((capture) => readFile(capture)));
  const evidence = buildReadonlyCatalogEvidence({ manifest, captureBuffers });
  const output = `${JSON.stringify(evidence, null, 2)}\n`;
  if (args.out) await writeFile(args.out, output, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  else process.stdout.write(output);
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isEntrypoint) {
  main().catch((error) => {
    console.error(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  });
}
