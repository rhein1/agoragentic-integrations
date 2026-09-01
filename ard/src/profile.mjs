import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

export const LIMITS = Object.freeze({
  manifestBytes: 262_144,
  hostBytes: 16_384,
  entryBytes: 65_536,
  entries: 128,
  hostItems: 64,
  string: 2_048,
  query: 280,
});

export const CONTEXT_FILES = Object.freeze({
  'https://agenticresourcediscovery.org/context/v1': path.join(root, 'vendor', 'ard-v0.91', 'ard.context.jsonld'),
  'https://agoragentic.com/ns/ard/v1': path.join(root, 'context', 'agoragentic.v1.jsonld'),
});
const PROFILE_CONTEXTS = Object.freeze(Object.keys(CONTEXT_FILES));

export const AGORAGENTIC_ARD_NAMESPACE = 'https://agoragentic.com/ns/ard#';

export const AUTHORITY_FIELDS = Object.freeze({
  'ag:executionAuthorityGranted': false,
  'ag:paymentAuthorityGranted': false,
  'ag:trustPromotionAuthorized': false,
  'ag:publicationAuthorityGranted': false,
  'ag:networkDereferenceAllowed': false,
  'ag:liveExecutionAvailable': false,
  'ag:sourceOnly': true,
  'ag:defaultOff': true,
});

export const DISCOVERY_AUTHORITY_FIELDS = Object.freeze({
  'ag:routeEligibleFromDiscovery': false,
  'ag:rankingEligibleFromDiscovery': false,
  'ag:listingEligibleFromDiscovery': false,
  'ag:paymentEligibleFromDiscovery': false,
  'ag:settlementEligibleFromDiscovery': false,
  'ag:trustPromotedFromDiscovery': false,
  'ag:executionAuthorizedFromDiscovery': false,
  'ag:authenticationBypassGranted': false,
  'ag:publicationAuthorizedFromDiscovery': false,
  'ag:riskForkBypassGranted': false,
});

export const EXTENSION_DEFAULT_FIELDS = Object.freeze({
  'ag:trustState': 'unverified',
  'ag:riskLevel': 'unassessed',
  'ag:executionAuthorizationRequired': true,
  'ag:riskForkAvailable': true,
  'ag:riskForkRequired': false,
});

export const DESCRIPTIVE_EXTENSION_FIELDS = Object.freeze([
  ...Object.keys(EXTENSION_DEFAULT_FIELDS),
  'ag:transactionAssuranceAvailable',
  'ag:paymentRails',
  'ag:priceModel',
  'ag:receiptVerifier',
  'ag:providerQualification',
]);

export const LOCAL_PROFILE_FIELDS = Object.freeze([
  ...DESCRIPTIVE_EXTENSION_FIELDS,
  ...Object.keys(DISCOVERY_AUTHORITY_FIELDS),
  ...Object.keys(AUTHORITY_FIELDS),
]);

const LOCAL_PROFILE_POLICIES = new Map([
  ...DESCRIPTIVE_EXTENSION_FIELDS.map((canonical) => [
    `${AGORAGENTIC_ARD_NAMESPACE}${canonical.slice(3)}`,
    { canonical, errorCode: 'ard_extension_alias_conflict' },
  ]),
  ...Object.entries(AUTHORITY_FIELDS).map(([canonical, expected]) => [
    `${AGORAGENTIC_ARD_NAMESPACE}${canonical.slice(3)}`,
    { canonical, expected, errorCode: 'ard_authority_not_fail_closed' },
  ]),
  ...Object.entries(DISCOVERY_AUTHORITY_FIELDS).map(([canonical, expected]) => [
    `${AGORAGENTIC_ARD_NAMESPACE}${canonical.slice(3)}`,
    { canonical, expected, errorCode: 'ard_discovery_authority_not_fail_closed' },
  ]),
]);

const PAYMENT_RAILS = new Set(['internal_usdc_wallet', 'x402']);
const PRICE_MODELS = new Set(['separate_execution_contract', 'tool_specific', 'capability_specific', 'none']);
const PROVIDER_QUALIFICATIONS = new Set(['snapshot_unverified', 'source_only_not_live_qualified']);
const RECEIPT_VERIFIER = 'https://agoragentic.com/api/commerce/interchange/receipts/verify';
const ROOT_FIELDS = new Set(['specVersion', 'host', 'entries']);
const HOST_FIELDS = new Set(['displayName', 'identifier', 'documentationUrl', 'logoUrl', 'trustManifest']);
const HOST_TRUST_FIELDS = new Set(['identity', 'identityType', 'trustSchema', 'attestations', 'provenance', 'signature']);
const HOST_TRUST_SCHEMA_FIELDS = new Set(['identifier', 'version', 'governanceUri', 'verificationMethods']);
const HOST_ATTESTATION_FIELDS = new Set(['type', 'uri', 'mediaType', 'digest']);
const HOST_PROVENANCE_FIELDS = new Set(['relation', 'sourceId', 'sourceDigest']);
const HOST_IDENTITY_TYPES = new Set(['spiffe', 'did', 'https', 'other']);
const HOST_PROVENANCE_RELATIONS = new Set(['derivedFrom', 'publishedFrom', 'copiedFrom']);
const RFC3339_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const FQDN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const URN_SEGMENT = /^[A-Za-z0-9._-]+$/;

export class ArdProfileError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ArdProfileError';
    this.code = code;
  }
}

function reject(code, message) {
  throw new ArdProfileError(code, message);
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertBoundedString(value, label, limit = LIMITS.string) {
  if (typeof value !== 'string' || value.length < 1 || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    reject('ard_invalid_string', `${label} must be a non-empty bounded string without control characters`);
  }
}

function rejectUnknownFields(value, allowed, label) {
  const unknown = Object.keys(value).find((field) => !allowed.has(field));
  if (unknown) reject('ard_host_property', `${label} contains unsupported field: ${unknown}`);
}

function assertAbsoluteUri(value, label) {
  assertBoundedString(value, label);
  try {
    const parsed = new URL(value);
    if (!parsed.protocol) reject('ard_host_uri', `${label} must be an absolute URI`);
  } catch {
    reject('ard_host_uri', `${label} must be an absolute URI`);
  }
}

function validateHostTrustManifest(trustManifest) {
  if (!isRecord(trustManifest)) reject('ard_host_trust_manifest_shape', 'host.trustManifest must be an object');
  rejectUnknownFields(trustManifest, HOST_TRUST_FIELDS, 'host.trustManifest');
  assertBoundedString(trustManifest.identity, 'host.trustManifest.identity');
  if (own(trustManifest, 'identityType') && !HOST_IDENTITY_TYPES.has(trustManifest.identityType)) {
    reject('ard_host_trust_manifest_shape', 'host.trustManifest.identityType is not supported by the predecessor schema');
  }
  if (own(trustManifest, 'trustSchema')) {
    const trustSchema = trustManifest.trustSchema;
    if (!isRecord(trustSchema)) reject('ard_host_trust_manifest_shape', 'host.trustManifest.trustSchema must be an object');
    rejectUnknownFields(trustSchema, HOST_TRUST_SCHEMA_FIELDS, 'host.trustManifest.trustSchema');
    assertBoundedString(trustSchema.identifier, 'host.trustManifest.trustSchema.identifier');
    assertBoundedString(trustSchema.version, 'host.trustManifest.trustSchema.version');
    if (own(trustSchema, 'governanceUri')) assertAbsoluteUri(trustSchema.governanceUri, 'host.trustManifest.trustSchema.governanceUri');
    if (own(trustSchema, 'verificationMethods')) {
      const methods = trustSchema.verificationMethods;
      if (!Array.isArray(methods) || methods.length > LIMITS.hostItems) {
        reject('ard_host_trust_manifest_shape', 'host.trustManifest.trustSchema.verificationMethods must be a bounded array');
      }
      for (const method of methods) assertBoundedString(method, 'host.trustManifest.trustSchema.verificationMethods[]');
    }
  }
  if (own(trustManifest, 'attestations')) {
    const attestations = trustManifest.attestations;
    if (!Array.isArray(attestations) || attestations.length > LIMITS.hostItems) {
      reject('ard_host_trust_manifest_shape', 'host.trustManifest.attestations must be a bounded array');
    }
    for (const attestation of attestations) {
      if (!isRecord(attestation)) reject('ard_host_trust_manifest_shape', 'host.trustManifest.attestations[] must be an object');
      rejectUnknownFields(attestation, HOST_ATTESTATION_FIELDS, 'host.trustManifest.attestations[]');
      assertBoundedString(attestation.type, 'host.trustManifest.attestations[].type');
      assertAbsoluteUri(attestation.uri, 'host.trustManifest.attestations[].uri');
      assertBoundedString(attestation.mediaType, 'host.trustManifest.attestations[].mediaType');
      if (own(attestation, 'digest')) assertBoundedString(attestation.digest, 'host.trustManifest.attestations[].digest');
    }
  }
  if (own(trustManifest, 'provenance')) {
    const provenance = trustManifest.provenance;
    if (!Array.isArray(provenance) || provenance.length > LIMITS.hostItems) {
      reject('ard_host_trust_manifest_shape', 'host.trustManifest.provenance must be a bounded array');
    }
    for (const record of provenance) {
      if (!isRecord(record)) reject('ard_host_trust_manifest_shape', 'host.trustManifest.provenance[] must be an object');
      rejectUnknownFields(record, HOST_PROVENANCE_FIELDS, 'host.trustManifest.provenance[]');
      if (!HOST_PROVENANCE_RELATIONS.has(record.relation)) {
        reject('ard_host_trust_manifest_shape', 'host.trustManifest.provenance[].relation is not supported by the predecessor schema');
      }
      assertBoundedString(record.sourceId, 'host.trustManifest.provenance[].sourceId');
      if (own(record, 'sourceDigest')) assertBoundedString(record.sourceDigest, 'host.trustManifest.provenance[].sourceDigest');
    }
  }
  if (own(trustManifest, 'signature')) assertBoundedString(trustManifest.signature, 'host.trustManifest.signature');
}

function validateHost(host) {
  if (!isRecord(host)) reject('ard_host_shape', 'host must be an object');
  if (Buffer.byteLength(JSON.stringify(host), 'utf8') > LIMITS.hostBytes) reject('ard_host_oversize', 'host exceeds the byte limit');
  rejectUnknownFields(host, HOST_FIELDS, 'host');
  assertBoundedString(host.displayName, 'host.displayName', 160);
  if (own(host, 'identifier')) assertBoundedString(host.identifier, 'host.identifier');
  if (own(host, 'documentationUrl')) assertAbsoluteUri(host.documentationUrl, 'host.documentationUrl');
  if (own(host, 'logoUrl')) assertAbsoluteUri(host.logoUrl, 'host.logoUrl');
  if (own(host, 'trustManifest')) validateHostTrustManifest(host.trustManifest);
  return host;
}

function parseInput(input) {
  if (Buffer.isBuffer(input)) {
    if (input.byteLength > LIMITS.manifestBytes) reject('ard_manifest_oversize', 'ARD manifest exceeds the byte limit');
    input = input.toString('utf8');
  }
  if (typeof input === 'string') {
    if (Buffer.byteLength(input, 'utf8') > LIMITS.manifestBytes) reject('ard_manifest_oversize', 'ARD manifest exceeds the byte limit');
    let parsed;
    try {
      parsed = JSON.parse(input);
    } catch {
      reject('ard_malformed_json', 'ARD manifest is not valid JSON');
    }
    if (!isRecord(parsed)) reject('ard_manifest_shape', 'ARD manifest JSON must decode to an object');
    return parsed;
  }
  if (!isRecord(input)) reject('ard_manifest_shape', 'ARD manifest must be an object or JSON text');
  let encoded;
  try {
    encoded = JSON.stringify(input);
  } catch {
    reject('ard_malformed_object', 'ARD manifest must be JSON serializable');
  }
  if (typeof encoded !== 'string') reject('ard_malformed_object', 'ARD manifest must serialize to a JSON object');
  if (Buffer.byteLength(encoded, 'utf8') > LIMITS.manifestBytes) reject('ard_manifest_oversize', 'ARD manifest exceeds the byte limit');
  const parsed = JSON.parse(encoded);
  if (!isRecord(parsed)) reject('ard_manifest_shape', 'ARD manifest must serialize to a JSON object');
  return parsed;
}

export function parseIdentifier(identifier) {
  assertBoundedString(identifier, 'identifier');
  const segments = identifier.split(':');
  if (segments[0] !== 'urn' || segments[1] !== 'air' || segments.length < 5) {
    reject('ard_identifier_shape', 'identifier must be urn:air:<fqdn>:<namespace>:<name>');
  }
  const publisher = segments[2];
  const resourceSegments = segments.slice(3);
  if (publisher !== publisher.toLowerCase() || !FQDN.test(publisher)) {
    reject('ard_identifier_publisher', 'identifier publisher must be a lower-case valid FQDN');
  }
  if (resourceSegments.length < 2 || resourceSegments.some((segment) => !URN_SEGMENT.test(segment))) {
    reject('ard_identifier_segments', 'identifier must contain at least namespace and terminal-name segments');
  }
  return { publisher, resourceSegments };
}

export function loadPinnedContext(uri) {
  const file = CONTEXT_FILES[uri];
  if (!file) reject('ard_context_not_allowlisted', `JSON-LD context is not pinned locally: ${uri}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function validateContexts(context) {
  const values = typeof context === 'string' ? [context] : context;
  if (!Array.isArray(values) || values.length < 1 || values.some((item) => typeof item !== 'string')) {
    reject('ard_context_shape', '@context must contain only pinned context URI strings');
  }
  if (new Set(values).size !== values.length) reject('ard_context_duplicate', '@context must not repeat a context URI');
  for (const uri of values) loadPinnedContext(uri);
  if (values.length !== PROFILE_CONTEXTS.length || values.some((uri, index) => uri !== PROFILE_CONTEXTS[index])) {
    reject('ard_context_profile', '@context must contain the pinned upstream and Agoragentic contexts in profile order');
  }
}

let pinnedContextResolution;

function getPinnedContextResolution() {
  if (pinnedContextResolution) return pinnedContextResolution;
  const definitions = new Map();
  let vocab = null;
  for (const uri of PROFILE_CONTEXTS) {
    const document = loadPinnedContext(uri);
    const context = document?.['@context'];
    if (!isRecord(context)) reject('ard_context_shape', `pinned context ${uri} must contain an object @context`);
    for (const [term, definition] of Object.entries(context)) {
      if (term === '@vocab') {
        if (typeof definition === 'string' && definition) vocab = definition;
        continue;
      }
      if (term.startsWith('@')) continue;
      const target = typeof definition === 'string'
        ? definition
        : (isRecord(definition) ? definition['@id'] : null);
      if (typeof target === 'string' && target && !target.startsWith('@')) definitions.set(term, target);
    }
  }
  pinnedContextResolution = { definitions, vocab };
  return pinnedContextResolution;
}

function expandPinnedContextKey(key) {
  const { definitions, vocab } = getPinnedContextResolution();
  const resolve = (value, seen = new Set()) => {
    const expanded = new Set();
    if (typeof value !== 'string' || !value || seen.has(value) || seen.size > 32) return expanded;
    const nextSeen = new Set(seen).add(value);
    if (value.startsWith('https://') || value.startsWith('http://')) {
      expanded.add(value);
      return expanded;
    }
    const separator = value.indexOf(':');
    if (separator > 0) {
      const prefix = value.slice(0, separator);
      const suffix = value.slice(separator + 1);
      const target = definitions.get(prefix);
      if (!target) return expanded;
      for (const base of resolve(target, nextSeen)) expanded.add(`${base}${suffix}`);
      return expanded;
    }
    const target = definitions.get(value);
    if (target) return resolve(target, nextSeen);
    if (vocab) {
      for (const base of resolve(vocab, nextSeen)) expanded.add(`${base}${value}`);
    }
    return expanded;
  };
  return resolve(key);
}

function profileValuesEqual(left, right) {
  if (Object.is(left, right)) return true;
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => Object.is(value, right[index]));
}

function canonicalizeLocalProfileFields(entry, index) {
  const equivalents = new Map();
  for (const key of Object.keys(entry)) {
    for (const iri of expandPinnedContextKey(key)) {
      const policy = LOCAL_PROFILE_POLICIES.get(iri);
      if (!policy) continue;
      if (!equivalents.has(policy.canonical)) equivalents.set(policy.canonical, { policy, occurrences: [] });
      equivalents.get(policy.canonical).occurrences.push({ key, value: entry[key] });
    }
  }
  for (const { policy, occurrences } of equivalents.values()) {
    const baseline = occurrences[0];
    const conflict = occurrences.find((occurrence) => !profileValuesEqual(occurrence.value, baseline.value));
    if (conflict) {
      reject(
        policy.canonical.startsWith('ag:') && DESCRIPTIVE_EXTENSION_FIELDS.includes(policy.canonical)
          ? policy.errorCode
          : 'ard_authority_alias_conflict',
        `entries[${index}] contains conflicting JSON-LD equivalents for ${policy.canonical}`,
      );
    }
    entry[policy.canonical] = baseline.value;
    for (const occurrence of occurrences) {
      if (occurrence.key !== policy.canonical) delete entry[occurrence.key];
    }
  }
}

function trustDomain(identity) {
  if (identity.startsWith('did:web:')) return identity.slice('did:web:'.length).split(':')[0].toLowerCase();
  try {
    const parsed = new URL(identity);
    if (parsed.protocol === 'https:' || parsed.protocol === 'spiffe:') return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
  return null;
}

function validateTrust(entry, publisher) {
  if (own(entry, 'TrustManifest')) reject('ard_trust_manifest_capitalization', 'Use lower-case trustManifest; the pinned capitalized schema property is a draft defect');
  if (!own(entry, 'trustManifest')) return;
  if (!isRecord(entry.trustManifest)) reject('ard_trust_manifest_shape', 'trustManifest must be an object');
  assertBoundedString(entry.trustManifest.identity, 'trustManifest.identity');
  const domain = trustDomain(entry.trustManifest.identity);
  if (!domain || domain !== publisher) reject('ard_trust_domain_mismatch', 'trustManifest identity must align with the URN publisher');
}

function validateStringArray(entry, key, { warningRange = false } = {}) {
  if (!own(entry, key)) return [];
  const values = entry[key];
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || value.length < 1 || value.length > (key === 'representativeQueries' ? LIMITS.query : LIMITS.string))) {
    reject('ard_array_shape', `${key} must be an array of bounded non-empty strings`);
  }
  if (new Set(values).size !== values.length) reject('ard_array_duplicate', `${key} must not contain duplicates`);
  if (warningRange && (values.length < 2 || values.length > 5)) return ['ard_representative_queries_count'];
  return [];
}

function validateMetadata(metadata) {
  if (!own(metadata, 'metadata')) return;
  if (!isRecord(metadata.metadata)) reject('ard_metadata_shape', 'metadata must be an object');
  for (const value of Object.values(metadata.metadata)) {
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
      reject('ard_metadata_value', 'metadata values must be primitive');
    }
  }
}

function validateExtensionContract(entry) {
  for (const [field, expected] of Object.entries(EXTENSION_DEFAULT_FIELDS)) {
    if (entry[field] !== expected) reject('ard_extension_contract', `${field} must be ${expected}`);
  }
  if (typeof entry['ag:transactionAssuranceAvailable'] !== 'boolean') {
    reject('ard_extension_contract', 'ag:transactionAssuranceAvailable must be boolean');
  }
  const rails = entry['ag:paymentRails'];
  if (!Array.isArray(rails) || rails.length > PAYMENT_RAILS.size || new Set(rails).size !== rails.length
    || rails.some((rail) => !PAYMENT_RAILS.has(rail))) {
    reject('ard_extension_contract', 'ag:paymentRails must be a unique bounded array of known descriptive rails');
  }
  const priceModel = entry['ag:priceModel'];
  if (!PRICE_MODELS.has(priceModel)) reject('ard_extension_contract', 'ag:priceModel is not a known descriptive model');
  const receiptVerifier = entry['ag:receiptVerifier'];
  if (entry['ag:transactionAssuranceAvailable']) {
    if (rails.length < 1 || priceModel === 'none' || receiptVerifier !== RECEIPT_VERIFIER) {
      reject('ard_extension_contract', 'transaction-assurance metadata must include rails, a price model, and the pinned verifier reference');
    }
  } else if (rails.length !== 0 || priceModel !== 'none' || receiptVerifier !== null) {
    reject('ard_extension_contract', 'disabled transaction-assurance metadata must use empty rails, priceModel none, and null verifier');
  }
  if (!PROVIDER_QUALIFICATIONS.has(entry['ag:providerQualification'])) {
    reject('ard_extension_contract', 'ag:providerQualification must remain explicitly unverified or not-live-qualified');
  }
}

function validateEntry(entry, index) {
  if (!isRecord(entry)) reject('ard_entry_shape', `entries[${index}] must be an object`);
  if (Buffer.byteLength(JSON.stringify(entry), 'utf8') > LIMITS.entryBytes) reject('ard_entry_oversize', `entries[${index}] exceeds the byte limit`);
  const { publisher } = parseIdentifier(entry.identifier);
  assertBoundedString(entry.displayName, 'displayName', 160);
  assertBoundedString(entry.type, 'type', 160);
  if (entry['@id'] !== entry.identifier) reject('ard_id_mismatch', '@id must equal identifier in the local profile');
  validateContexts(entry['@context']);
  canonicalizeLocalProfileFields(entry, index);

  const hasUrl = own(entry, 'url');
  const hasData = own(entry, 'data');
  if (hasUrl === hasData) reject('ard_url_data_xor', 'entry must contain exactly one of url or data');
  if (hasUrl) {
    assertBoundedString(entry.url, 'url');
    if (!entry.url.startsWith('https://')) reject('ard_url_scheme', 'url must use a literal HTTPS URL in the local profile');
    let parsed;
    try {
      parsed = new URL(entry.url);
    } catch {
      reject('ard_url_invalid', 'url must be an absolute URL');
    }
    if (parsed.protocol !== 'https:') reject('ard_url_scheme', 'url must use HTTPS in the local profile');
  }
  if (hasData && !isRecord(entry.data)) reject('ard_data_shape', 'data must be an object');

  const warnings = [];
  if (!own(entry, 'representativeQueries')) warnings.push('ard_representative_queries_missing');
  warnings.push(...validateStringArray(entry, 'representativeQueries', { warningRange: true }));
  validateStringArray(entry, 'capabilities');
  validateStringArray(entry, 'tags');
  if (own(entry, 'description')) assertBoundedString(entry.description, 'description');
  if (own(entry, 'version')) assertBoundedString(entry.version, 'version');
  if (own(entry, 'updatedAt')) {
    assertBoundedString(entry.updatedAt, 'updatedAt');
    if (!RFC3339_DATE_TIME.test(entry.updatedAt) || Number.isNaN(Date.parse(entry.updatedAt))) {
      reject('ard_updated_at', 'updatedAt must be an RFC 3339 date-time');
    }
  }
  validateMetadata(entry);
  validateTrust(entry, publisher);

  for (const [field, expected] of Object.entries(AUTHORITY_FIELDS)) {
    if (entry[field] !== expected) reject('ard_authority_not_fail_closed', `${field} must be ${expected}`);
  }
  for (const [field, expected] of Object.entries(DISCOVERY_AUTHORITY_FIELDS)) {
    if (entry[field] !== expected) reject('ard_discovery_authority_not_fail_closed', `${field} must be ${expected}`);
  }
  validateExtensionContract(entry);
  return warnings;
}

export function normalizeManifest(input) {
  const manifest = parseInput(input);
  const sourceCanonical = JSON.stringify(manifest);
  const unknownRootFields = Object.keys(manifest).filter((field) => !ROOT_FIELDS.has(field));
  if (unknownRootFields.length > 0) reject('ard_manifest_root_property', `unsupported manifest root field: ${unknownRootFields[0]}`);
  if (!Array.isArray(manifest.entries) || manifest.entries.length < 1 || manifest.entries.length > LIMITS.entries) {
    reject('ard_entries_shape', `entries must contain between 1 and ${LIMITS.entries} entries`);
  }
  if (manifest.specVersion !== '1.0') reject('ard_spec_version', 'compatibility specVersion is required and must be 1.0');
  const host = own(manifest, 'host') ? validateHost(manifest.host) : undefined;
  const seen = new Set();
  const entries = manifest.entries.map((entry, index) => {
    const warnings = validateEntry(entry, index);
    if (seen.has(entry.identifier)) reject('ard_identifier_duplicate', `duplicate identifier: ${entry.identifier}`);
    seen.add(entry.identifier);
    return {
      entry,
      warnings,
      eligible: false,
      trustVerified: false,
    };
  });
  return {
    schema: 'agoragentic.ard-normalized.v1',
    sourceSha256: createHash('sha256').update(sourceCanonical).digest('hex'),
    ...(host ? { host } : {}),
    entries,
    authority: {
      networkFetch: false,
      execution: false,
      payment: false,
      trustPromotion: false,
      publication: false,
      routeEligibleFromDiscovery: false,
      rankingEligibleFromDiscovery: false,
      listingEligibleFromDiscovery: false,
      paymentEligibleFromDiscovery: false,
      settlementEligibleFromDiscovery: false,
      trustPromotedFromDiscovery: false,
      executionAuthorizedFromDiscovery: false,
      authenticationBypassGranted: false,
      publicationAuthorizedFromDiscovery: false,
      riskForkBypassGranted: false,
    },
  };
}

export function validateManifest(input) {
  const normalized = normalizeManifest(input);
  return {
    valid: true,
    warningCount: normalized.entries.reduce((sum, item) => sum + item.warnings.length, 0),
    warnings: normalized.entries.flatMap((item) => item.warnings.map((code) => ({ identifier: item.entry.identifier, code }))),
  };
}
