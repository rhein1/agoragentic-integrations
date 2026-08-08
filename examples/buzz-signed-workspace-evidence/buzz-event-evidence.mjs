import { createHash } from 'node:crypto';

const EVENT_ID_PATTERN = /^[a-f0-9]{64}$/;
const PUBKEY_PATTERN = /^[a-f0-9]{64}$/;
const SIGNATURE_PATTERN = /^[a-f0-9]{128}$/;
const SHA256_REF_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_NIP01_KIND = 65_535;
const MAX_EVENTS = 256;
const MAX_EVENT_WIRE_BYTES = 65_536;
const MAX_CONTENT_BYTES = 60_000;
const MAX_TAGS = 256;
const MAX_TAG_ITEMS = 16;
const MAX_TAG_ITEM_BYTES = 4_096;
const MAX_BOUNDED_CONTENT_CHARS = 8_000;
const BUNDLE_SCHEMA = 'agoragentic.buzz-evidence-bundle.v2';
const EVENT_ROOT_SCHEMA = 'agoragentic.buzz-evidence-root.v2';
const BUNDLE_ROOT_SCHEMA = 'agoragentic.buzz-evidence-bundle-root.v1';
const BUNDLE_VERIFICATION_SCHEMA = 'agoragentic.buzz-evidence-bundle-verification.v1';
const TRANSACTION_REFERENCE_SCHEMA = 'agoragentic.buzz-transaction-assurance-reference.v1';

// This deliberately contains only the subset this adapter classifies. The
// commit and source hash make the mapping reviewable without claiming live
// relay compatibility or tracking the upstream main branch implicitly.
export const BUZZ_UPSTREAM_PROVENANCE = Object.freeze({
  repository: 'https://github.com/block/buzz',
  commit: 'f029deafae6ad3b63e13c29104f3be76122cb1df',
  kind_registry_path: 'crates/buzz-core/src/kind.rs',
  kind_registry_sha256: 'sha256:74533cfc1ac016dcb1a83279c2b06f93807f29489604cdccefc46b645acfce97',
  nip01_repository: 'https://github.com/nostr-protocol/nips',
  nip01_commit: 'c53877571f96eb423661fc23c620d629d37b8f19',
  nip01_path: '01.md',
  nip01_sha256: 'sha256:afa8a4eeff70d47503f2acab03b29f4bf0ed90ac95a10d3fd07e4fecddc8ae20',
  provenance_file: 'upstream-provenance.json',
});

const BUZZ_KINDS = Object.freeze({
  0: 'profile',
  1: 'text_note',
  7: 'reaction',
  9: 'stream_message',
  10100: 'agent_profile',
  30174: 'agent_engram',
  30175: 'agent_persona',
  30179: 'private_managed_agent',
  40002: 'stream_message_v2',
  40003: 'stream_message_edit',
  43001: 'agent_job_request',
  45001: 'forum_post',
  45003: 'forum_comment',
  30617: 'git_repository_announcement',
  1617: 'git_patch',
  1618: 'git_pull_request',
});

const SECRET_PATTERNS = Object.freeze([
  [/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}\b/gi, 'Bearer [REDACTED]'],
  [/\bamk_[A-Za-z0-9_-]{8,}\b/g, 'amk_[REDACTED]'],
  [/\bnsec1[023456789acdefghjklmnpqrstuvwxyz]{20,}\b/gi, 'nsec1[REDACTED]'],
  [/\b(?:sk|sk-ant|sk-or)-[A-Za-z0-9_-]{12,}\b/g, 'sk-[REDACTED]'],
  [/\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g, '[GITHUB_TOKEN_REDACTED]'],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[AWS_ACCESS_KEY_REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, '[JWT_REDACTED]'],
  [
    /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi,
    (_match, scheme) => `${scheme}[URL_CREDENTIALS_REDACTED]@`,
  ],
  [
    /\b(api[_-]?key|private[_-]?key|password|secret)\s*[:=]\s*[^\s,;]{8,}/gi,
    (_match, label) => `${label}=[REDACTED]`,
  ],
]);

const BUNDLE_FIELDS = Object.freeze([
  'schema',
  'bundle_id',
  'source',
  'event_root',
  'event_commitments',
  'events',
  'relationships',
  'summary',
  'privacy',
  'transaction_assurance_readiness',
  'authority',
  'bundle_root',
]);

export class BuzzEvidenceError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'BuzzEvidenceError';
    this.code = code;
  }
}

function utf8Bytes(value) {
  return Buffer.byteLength(String(value), 'utf8');
}

function sha256(value) {
  const bytes = Buffer.isBuffer(value) || value instanceof Uint8Array
    ? Buffer.from(value)
    : Buffer.from(String(value), 'utf8');
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function sha256Hex(value) {
  return sha256(value).slice(7);
}

function assertHex(value, pattern, field) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new BuzzEvidenceError('invalid_event', `${field} must be lowercase hexadecimal with the required length.`);
  }
  return value;
}

function assertShaRef(value, field) {
  if (typeof value !== 'string' || !SHA256_REF_PATTERN.test(value)) {
    throw new BuzzEvidenceError('invalid_reference', `${field} must be a lowercase sha256 reference.`);
  }
  return value;
}

function requireString(value, field, maxLength) {
  if (typeof value !== 'string') {
    throw new BuzzEvidenceError('invalid_evidence', `${field} must be a string.`);
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new BuzzEvidenceError('invalid_evidence', `${field} must not be empty.`);
  }
  if (utf8Bytes(normalized) > maxLength) {
    throw new BuzzEvidenceError('evidence_too_large', `${field} exceeds ${maxLength} bytes.`);
  }
  return normalized;
}

function optionalString(value, field, maxLength) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new BuzzEvidenceError('invalid_input', `${field} must be a string when supplied.`);
  }
  if (!value.trim()) return null;
  if (utf8Bytes(value) > maxLength) {
    throw new BuzzEvidenceError('input_too_large', `${field} exceeds ${maxLength} bytes.`);
  }
  return value;
}

function normalizeKind(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_NIP01_KIND) {
    throw new BuzzEvidenceError(
      'invalid_event',
      `kind must be an unsigned NIP-01 integer between 0 and ${MAX_NIP01_KIND}.`,
    );
  }
  return value;
}

function normalizeTimestamp(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new BuzzEvidenceError('invalid_event', 'created_at must be a non-negative integer Unix timestamp.');
  }
  return value;
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) {
    throw new BuzzEvidenceError('invalid_event', 'tags must be an array.');
  }
  if (tags.length > MAX_TAGS) {
    throw new BuzzEvidenceError('event_too_large', `tags exceeds the ${MAX_TAGS}-tag limit.`);
  }

  return tags.map((tag, tagIndex) => {
    if (!Array.isArray(tag) || tag.length === 0 || tag.length > MAX_TAG_ITEMS) {
      throw new BuzzEvidenceError(
        'invalid_event',
        `tags[${tagIndex}] must contain 1-${MAX_TAG_ITEMS} string items.`,
      );
    }
    return tag.map((item, itemIndex) => {
      if (typeof item !== 'string') {
        throw new BuzzEvidenceError(
          'invalid_event',
          `tags[${tagIndex}][${itemIndex}] must be a string.`,
        );
      }
      if (utf8Bytes(item) > MAX_TAG_ITEM_BYTES) {
        throw new BuzzEvidenceError(
          'event_too_large',
          `tags[${tagIndex}][${itemIndex}] exceeds ${MAX_TAG_ITEM_BYTES} bytes.`,
        );
      }
      return item;
    });
  });
}

function normalizeContent(value) {
  if (typeof value !== 'string') {
    throw new BuzzEvidenceError('invalid_event', 'content must be a string.');
  }
  if (utf8Bytes(value) > MAX_CONTENT_BYTES) {
    throw new BuzzEvidenceError(
      'event_too_large',
      `content exceeds the ${MAX_CONTENT_BYTES}-byte evidence limit.`,
    );
  }
  return value;
}

function eventSerialization({ pubkey, created_at, kind, tags, content }) {
  return JSON.stringify([0, pubkey, created_at, kind, tags, content]);
}

export function canonicalBuzzEventId(event = {}) {
  const pubkey = assertHex(event.pubkey, PUBKEY_PATTERN, 'pubkey');
  const created_at = normalizeTimestamp(event.created_at);
  const kind = normalizeKind(event.kind);
  const tags = normalizeTags(event.tags);
  const content = normalizeContent(event.content);
  return sha256Hex(eventSerialization({ pubkey, created_at, kind, tags, content }));
}

function classifyKind(kind) {
  if (kind >= 46001 && kind <= 46012) return 'workflow_event';
  if (kind >= 20000 && kind <= 29999) return 'ephemeral_event';
  return BUZZ_KINDS[kind] || 'other_event';
}

function tagsByName(tags, name, maximum = 100) {
  return tags
    .filter(tag => tag[0] === name && typeof tag[1] === 'string')
    .map(tag => tag[1])
    .slice(0, maximum);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function hashedReferences(values) {
  return values.map(value => sha256(value));
}

function isLuhnValid(value) {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19 || /^(\d)\1+$/.test(digits)) return false;
  let sum = 0;
  let doubleDigit = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

function redactContent(content) {
  let redacted = content;
  let count = 0;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (...args) => {
      count += 1;
      if (typeof replacement === 'function') return replacement(...args);
      return replacement;
    });
  }
  redacted = redacted.replace(/\b(?:\d[ -]?){12,18}\d\b/g, match => {
    if (!isLuhnValid(match)) return match;
    count += 1;
    return '[PAYMENT_CARD_REDACTED]';
  });
  return { content: redacted, redaction_count: count };
}

function contentEvidence(content, policy) {
  const contentHash = sha256(content);
  if (policy === 'none' || policy === 'hash_only') {
    return {
      policy: 'hash_only',
      content_hash: contentHash,
      content_chars: content.length,
      bounded_content: null,
      truncated: false,
      redaction_count: 0,
      raw_content_embedded: false,
      redaction_scope: 'not_applicable_no_raw_content',
      redaction_complete: null,
      safe_for_publication: false,
      requires_explicit_content_authority: false,
    };
  }
  if (policy !== 'bounded') {
    throw new BuzzEvidenceError(
      'invalid_option',
      'content_policy must be hash_only, none, or bounded.',
    );
  }
  const redacted = redactContent(content);
  const bounded = redacted.content.slice(0, MAX_BOUNDED_CONTENT_CHARS);
  return {
    policy: 'bounded_best_effort_redaction',
    content_hash: contentHash,
    content_chars: content.length,
    bounded_content: bounded,
    truncated: content.length > MAX_BOUNDED_CONTENT_CHARS,
    redaction_count: redacted.redaction_count,
    raw_content_embedded: true,
    redaction_scope: 'best_effort_known_patterns_only',
    redaction_complete: false,
    safe_for_publication: false,
    requires_explicit_content_authority: true,
  };
}

function normalizeEvidenceMap(value, field) {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BuzzEvidenceError('invalid_option', `${field} must be an object keyed by event ID.`);
  }
  return value;
}

function assertNoDeprecatedEvidenceOptions(options) {
  for (const field of ['signature_verifications', 'principal_bindings', 'audit_evidence']) {
    if (hasOwn(options, field) && options[field] !== undefined && options[field] !== null) {
      throw new BuzzEvidenceError(
        'deprecated_evidence_shape',
        `${field} is not accepted. Use typed event-bound attestations instead.`,
      );
    }
  }
}

function hasOwn(value, field) {
  return Object.prototype.hasOwnProperty.call(value, field);
}

function normalizeAttestationBinding(value, context, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BuzzEvidenceError('invalid_evidence', `${label} must be an object.`);
  }
  const eventId = assertHex(value.event_id, EVENT_ID_PATTERN, `${label}.event_id`);
  const pubkey = assertHex(value.pubkey, PUBKEY_PATTERN, `${label}.pubkey`);
  const signatureHash = assertShaRef(value.signature_hash, `${label}.signature_hash`);
  if (eventId !== context.event_id || pubkey !== context.pubkey || signatureHash !== context.signature_hash) {
    throw new BuzzEvidenceError(
      'attestation_binding_mismatch',
      `${label} must bind the exact event ID, pubkey, and signature hash.`,
    );
  }
  return {
    event_id: eventId,
    author_pubkey_hash: sha256(pubkey),
    signature_hash: signatureHash,
  };
}

function normalizeSignatureAttestation(value, context) {
  if (value === undefined || value === null) {
    return {
      status: 'not_verified',
      signature_valid: null,
      verification_result_claimed: null,
      attestation_reference_verified: false,
      verifier: null,
      verifier_version: null,
      evidence_ref: null,
      claimed_binding: null,
    };
  }
  if (hasOwn(value, 'signature_valid')) {
    throw new BuzzEvidenceError(
      'invalid_evidence',
      'signature_valid is not evidence. Supply verification_result in an event-bound attestation.',
    );
  }
  const binding = normalizeAttestationBinding(value, context, 'signature attestation');
  if (value.verification_result !== 'valid' && value.verification_result !== 'invalid') {
    throw new BuzzEvidenceError('invalid_evidence', 'signature attestation verification_result must be valid or invalid.');
  }
  return {
    status: value.verification_result === 'valid'
      ? 'validity_claimed_by_unverified_attestation_reference'
      : 'invalidity_claimed_by_unverified_attestation_reference',
    signature_valid: null,
    verification_result_claimed: value.verification_result,
    attestation_reference_verified: false,
    verifier: requireString(value.verifier, 'signature attestation verifier', 200),
    verifier_version: requireString(value.verifier_version, 'signature attestation verifier_version', 100),
    evidence_ref: assertShaRef(value.attestation_ref, 'signature attestation attestation_ref'),
    claimed_binding: binding,
  };
}

function normalizePrincipalAttestation(value, context) {
  if (value === undefined || value === null) {
    return {
      status: 'unbound',
      binding_verified: false,
      principal_ref_hash: null,
      agent_ref_hash: null,
      evidence_ref: null,
      claimed_binding: null,
    };
  }
  const binding = normalizeAttestationBinding(value, context, 'principal attestation');
  return {
    status: 'binding_claimed_by_unverified_attestation_reference',
    binding_verified: false,
    principal_ref_hash: sha256(requireString(value.principal_ref, 'principal attestation principal_ref', 300)),
    agent_ref_hash: sha256(requireString(value.agent_ref, 'principal attestation agent_ref', 300)),
    evidence_ref: assertShaRef(value.attestation_ref, 'principal attestation attestation_ref'),
    claimed_binding: binding,
  };
}

function normalizeAuditAttestation(value, context) {
  if (value === undefined || value === null) {
    return {
      status: 'not_verified',
      persistence_status_claimed: null,
      attestation_reference_verified: false,
      audit_entry_ref: null,
      audit_head_ref: null,
      verifier: null,
      verifier_version: null,
      evidence_ref: null,
      claimed_binding: null,
    };
  }
  if (hasOwn(value, 'persisted')) {
    throw new BuzzEvidenceError(
      'invalid_evidence',
      'persisted is not evidence. Supply persistence_status in an event-bound attestation.',
    );
  }
  const binding = normalizeAttestationBinding(value, context, 'relay-audit attestation');
  if (!context.relay_url_hash) {
    throw new BuzzEvidenceError(
      'relay_binding_required',
      'A relay-audit attestation requires input.relay_url so its claim can bind the exact relay hash.',
    );
  }
  const relayUrlHash = assertShaRef(value.relay_url_hash, 'relay-audit attestation relay_url_hash');
  if (relayUrlHash !== context.relay_url_hash) {
    throw new BuzzEvidenceError(
      'attestation_binding_mismatch',
      'relay-audit attestation must bind the exact source relay hash.',
    );
  }
  if (value.persistence_status !== 'persisted' && value.persistence_status !== 'not_persisted') {
    throw new BuzzEvidenceError('invalid_evidence', 'relay-audit persistence_status must be persisted or not_persisted.');
  }
  const auditEntryRef = value.audit_entry_ref === undefined || value.audit_entry_ref === null
    ? null
    : assertShaRef(value.audit_entry_ref, 'relay-audit attestation audit_entry_ref');
  const auditHeadRef = value.audit_head_ref === undefined || value.audit_head_ref === null
    ? null
    : assertShaRef(value.audit_head_ref, 'relay-audit attestation audit_head_ref');
  if (value.persistence_status === 'persisted' && (!auditEntryRef || !auditHeadRef)) {
    throw new BuzzEvidenceError(
      'invalid_evidence',
      'a persisted relay-audit attestation requires audit_entry_ref and audit_head_ref.',
    );
  }
  return {
    status: value.persistence_status === 'persisted'
      ? 'persistence_claimed_by_unverified_attestation_reference'
      : 'non_persistence_claimed_by_unverified_attestation_reference',
    persistence_status_claimed: value.persistence_status,
    attestation_reference_verified: false,
    audit_entry_ref: auditEntryRef,
    audit_head_ref: auditHeadRef,
    verifier: requireString(value.verifier, 'relay-audit attestation verifier', 200),
    verifier_version: requireString(value.verifier_version, 'relay-audit attestation verifier_version', 100),
    evidence_ref: assertShaRef(value.attestation_ref, 'relay-audit attestation attestation_ref'),
    claimed_binding: {
      ...binding,
      relay_url_hash: relayUrlHash,
    },
  };
}

function buildEventAuthority() {
  return {
    workspace_membership_is_economic_authority: false,
    principal_mandate_verified: false,
    spend_allowed: false,
    wallet_access_allowed: false,
    deploy_allowed: false,
    publish_allowed: false,
    trust_mutation_allowed: false,
  };
}

function normalizeEvent(event, index, options) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new BuzzEvidenceError('invalid_event', `events[${index}] must be an object.`);
  }
  const id = assertHex(event.id, EVENT_ID_PATTERN, `events[${index}].id`);
  const pubkey = assertHex(event.pubkey, PUBKEY_PATTERN, `events[${index}].pubkey`);
  const sig = assertHex(event.sig, SIGNATURE_PATTERN, `events[${index}].sig`);
  const kind = normalizeKind(event.kind);
  const created_at = normalizeTimestamp(event.created_at);
  const tags = normalizeTags(event.tags);
  const content = normalizeContent(event.content);
  const wire = JSON.stringify({ id, pubkey, created_at, kind, tags, content, sig });
  if (utf8Bytes(wire) > MAX_EVENT_WIRE_BYTES) {
    throw new BuzzEvidenceError(
      'event_too_large',
      `events[${index}] exceeds the ${MAX_EVENT_WIRE_BYTES}-byte evidence limit.`,
    );
  }

  const computedId = sha256Hex(eventSerialization({ pubkey, created_at, kind, tags, content }));
  if (computedId !== id) {
    throw new BuzzEvidenceError(
      'event_id_mismatch',
      `events[${index}].id does not match the canonical NIP-01 event serialization.`,
    );
  }

  const context = {
    event_id: id,
    pubkey,
    signature_hash: sha256(sig),
    relay_url_hash: options.relay_url_hash,
  };
  const signature = normalizeSignatureAttestation(options.signature_attestations[id], context);
  const principalBinding = normalizePrincipalAttestation(options.principal_attestations[id], context);
  const auditEvidence = normalizeAuditAttestation(options.audit_attestations[id], context);
  const contentRecord = contentEvidence(content, options.content_policy);

  return {
    schema: 'agoragentic.buzz-event-evidence.v2',
    event_id: id,
    event_hash_ref: `sha256:${id}`,
    event_type: classifyKind(kind),
    kind,
    created_at,
    author_pubkey_hash: sha256(pubkey),
    signature: {
      signature_hash: context.signature_hash,
      ...signature,
    },
    principal_binding: principalBinding,
    source_integrity: {
      canonical_event_id_verified: true,
      raw_event_embedded: false,
      raw_signature_embedded: false,
      raw_workspace_metadata_embedded: contentRecord.raw_content_embedded,
      exact_content_embedded: contentRecord.policy === 'bounded_best_effort_redaction'
        && contentRecord.redaction_count === 0
        && contentRecord.truncated === false,
    },
    references: {
      channel_ref_hashes: hashedReferences(tagsByName(tags, 'h')),
      event_ref_hashes: hashedReferences(tagsByName(tags, 'e')),
      pubkey_ref_hashes: hashedReferences(tagsByName(tags, 'p')),
      address_ref_hashes: hashedReferences(tagsByName(tags, 'a')),
      repository_ref_hashes: hashedReferences(tagsByName(tags, 'r')),
      identifier_ref_hashes: hashedReferences(tagsByName(tags, 'd')),
    },
    content: contentRecord,
    relay_audit: auditEvidence,
    authority: buildEventAuthority(),
  };
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item)).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function buildSource(input) {
  const relayUrl = optionalString(input.relay_url, 'relay_url', 2_048);
  const communityRef = optionalString(input.community_ref, 'community_ref', 300);
  return {
    product: 'Block Buzz',
    repository: BUZZ_UPSTREAM_PROVENANCE.repository,
    upstream_revision: BUZZ_UPSTREAM_PROVENANCE.commit,
    kind_registry_ref: BUZZ_UPSTREAM_PROVENANCE.kind_registry_sha256,
    nip01_revision: BUZZ_UPSTREAM_PROVENANCE.nip01_commit,
    nip01_ref: BUZZ_UPSTREAM_PROVENANCE.nip01_sha256,
    provenance_file: BUZZ_UPSTREAM_PROVENANCE.provenance_file,
    metadata_policy: 'hash_only',
    relay_url_hash: relayUrl ? sha256(relayUrl) : null,
    community_ref_hash: communityRef ? sha256(communityRef) : null,
    raw_source_metadata_embedded: false,
    partnership_claimed: false,
    compatibility_verified_against_live_relay: false,
    attestation_references_independently_verified: false,
  };
}

function buildRelationships(events) {
  return {
    channel_ref_hashes: unique(events.flatMap(event => event.references.channel_ref_hashes)),
    event_ref_hashes: unique(events.flatMap(event => event.references.event_ref_hashes)),
    pubkey_ref_hashes: unique(events.flatMap(event => event.references.pubkey_ref_hashes)),
    author_pubkey_hashes: unique(events.map(event => event.author_pubkey_hash)),
  };
}

function buildSummary(events) {
  return {
    event_count: events.length,
    event_types: events.reduce((counts, event) => {
      counts[event.event_type] = (counts[event.event_type] || 0) + 1;
      return counts;
    }, {}),
    signature_validity_claims_by_unverified_attestation_reference: events.filter(
      event => event.signature.status === 'validity_claimed_by_unverified_attestation_reference',
    ).length,
    signature_invalidity_claims_by_unverified_attestation_reference: events.filter(
      event => event.signature.status === 'invalidity_claimed_by_unverified_attestation_reference',
    ).length,
    principal_binding_claims_by_unverified_attestation_reference: events.filter(
      event => event.principal_binding.status === 'binding_claimed_by_unverified_attestation_reference',
    ).length,
    relay_persistence_claims_by_unverified_attestation_reference: events.filter(
      event => event.relay_audit.status === 'persistence_claimed_by_unverified_attestation_reference',
    ).length,
    redactions: events.reduce((sum, event) => sum + event.content.redaction_count, 0),
  };
}

function buildPrivacy(events) {
  const boundedContentEventCount = events.filter(event => event.content.raw_content_embedded).length;
  return {
    raw_content_embedded: boundedContentEventCount > 0,
    bounded_content_event_count: boundedContentEventCount,
    redaction_assurance: boundedContentEventCount > 0
      ? 'best_effort_known_patterns_only'
      : 'not_applicable_no_raw_content',
    safe_for_publication: false,
    publication_review_required: true,
    blockers: boundedContentEventCount > 0
      ? ['bounded_content_requires_explicit_authority_private_handling_and_publication_review']
      : ['hash_references_may_be_correlatable_and_require_protected_handling'],
  };
}

function buildBlockers(events) {
  const blockers = ['workspace_membership_is_not_an_economic_mandate'];
  if (events.some(event => event.signature.status === 'not_verified')) {
    blockers.push('one_or_more_event_signatures_not_independently_verified');
  }
  if (events.some(event => event.signature.attestation_reference_verified === false && event.signature.evidence_ref)) {
    blockers.push('signature_attestation_references_not_independently_verified');
  }
  if (events.some(event => event.principal_binding.status === 'unbound')) {
    blockers.push('one_or_more_event_authors_not_bound_to_a_principal_by_independent_evidence');
  }
  if (events.some(event => event.principal_binding.binding_verified === false && event.principal_binding.evidence_ref)) {
    blockers.push('principal_binding_attestation_references_not_independently_verified');
  }
  if (events.some(event => event.relay_audit.status === 'not_verified')) {
    blockers.push('relay_audit_persistence_not_independently_verified_for_every_event');
  }
  if (events.some(event => event.relay_audit.attestation_reference_verified === false && event.relay_audit.evidence_ref)) {
    blockers.push('relay_audit_attestation_references_not_independently_verified');
  }
  if (events.some(event => event.content.raw_content_embedded)) {
    blockers.push('bounded_content_requires_explicit_authority_private_handling_and_publication_review');
  }
  blockers.push('principal_mandate_required_before_economic_action');
  blockers.push('independent_attestation_verifier_and_trust_policy_required');
  blockers.push('external_tool_and_payment_chokepoint_required');
  return blockers;
}

function buildTransactionAssuranceReadiness(events) {
  return {
    ready_for_economic_action: false,
    ready_for_payment: false,
    ready_for_settlement: false,
    ready_for_reconciliation: false,
    blockers: buildBlockers(events),
    next_safe_action: 'Use an independently verified attestation resolver with an explicit trust policy for signature, principal-binding, and relay-persistence evidence, then evaluate an explicit Agoragentic mandate before any external side effect or payment.',
  };
}

function buildBundleAuthority() {
  return {
    grants_spend: false,
    grants_wallet_access: false,
    grants_deployment: false,
    grants_publication: false,
    grants_memory_write: false,
    grants_trust: false,
    posts_to_buzz: false,
  };
}

function buildEventCommitments(events) {
  return events.map(event => ({
    event_id: event.event_id,
    commitment_ref: sha256(stableStringify(event)),
  }));
}

function buildEventRoot(source, relationships, eventCommitments) {
  return sha256(stableStringify({
    schema: EVENT_ROOT_SCHEMA,
    source,
    relationships,
    event_commitments: eventCommitments,
  }));
}

function buildBundleRootEnvelope(bundle) {
  return {
    schema: BUNDLE_ROOT_SCHEMA,
    bundle_schema: bundle.schema,
    source: bundle.source,
    event_root: bundle.event_root,
    event_commitments: bundle.event_commitments,
    events: bundle.events,
    relationships: bundle.relationships,
    summary: bundle.summary,
    privacy: bundle.privacy,
    transaction_assurance_readiness: bundle.transaction_assurance_readiness,
    authority: bundle.authority,
  };
}

function stableEqual(left, right) {
  return stableStringify(left) === stableStringify(right);
}

function hasExactFields(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return stableEqual(Object.keys(value).sort(), [...fields].sort());
}

function validateSecurityInvariants(bundle, fail) {
  const source = bundle.source;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    fail('invalid_source');
  } else {
    const fixedSourcePolicy = {
      product: 'Block Buzz',
      repository: BUZZ_UPSTREAM_PROVENANCE.repository,
      upstream_revision: BUZZ_UPSTREAM_PROVENANCE.commit,
      kind_registry_ref: BUZZ_UPSTREAM_PROVENANCE.kind_registry_sha256,
      nip01_revision: BUZZ_UPSTREAM_PROVENANCE.nip01_commit,
      nip01_ref: BUZZ_UPSTREAM_PROVENANCE.nip01_sha256,
      provenance_file: BUZZ_UPSTREAM_PROVENANCE.provenance_file,
      metadata_policy: 'hash_only',
      raw_source_metadata_embedded: false,
      partnership_claimed: false,
      compatibility_verified_against_live_relay: false,
      attestation_references_independently_verified: false,
    };
    if (!hasExactFields(source, [...Object.keys(fixedSourcePolicy), 'relay_url_hash', 'community_ref_hash'])) {
      fail('invalid_source');
    }
    for (const [field, expected] of Object.entries(fixedSourcePolicy)) {
      if (source[field] !== expected) fail('source_policy_mismatch');
    }
    for (const field of ['relay_url_hash', 'community_ref_hash']) {
      if (source[field] !== null && (typeof source[field] !== 'string' || !SHA256_REF_PATTERN.test(source[field]))) {
        fail('invalid_source_reference');
      }
    }
  }

  if (!Array.isArray(bundle.events) || bundle.events.length === 0 || bundle.events.length > MAX_EVENTS) {
    fail('invalid_event_evidence');
    return;
  }
  const eventIds = new Set();
  let previousEvent = null;
  for (const event of bundle.events) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      fail('invalid_event_evidence');
      continue;
    }
    if (!hasExactFields(event, [
      'schema',
      'event_id',
      'event_hash_ref',
      'event_type',
      'kind',
      'created_at',
      'author_pubkey_hash',
      'signature',
      'principal_binding',
      'source_integrity',
      'references',
      'content',
      'relay_audit',
      'authority',
    ])
      || event.schema !== 'agoragentic.buzz-event-evidence.v2'
      || typeof event.event_id !== 'string'
      || !EVENT_ID_PATTERN.test(event.event_id)
      || event.event_hash_ref !== `sha256:${event.event_id}`
      || typeof event.kind !== 'number'
      || !Number.isInteger(event.kind)
      || event.kind < 0
      || event.kind > MAX_NIP01_KIND
      || event.event_type !== classifyKind(event.kind)
      || typeof event.created_at !== 'number'
      || !Number.isSafeInteger(event.created_at)
      || event.created_at < 0
      || typeof event.author_pubkey_hash !== 'string'
      || !SHA256_REF_PATTERN.test(event.author_pubkey_hash)) {
      fail('invalid_event_evidence');
    }
    if (eventIds.has(event.event_id)) fail('duplicate_event_evidence');
    eventIds.add(event.event_id);
    if (previousEvent && (
      previousEvent.created_at > event.created_at
      || (previousEvent.created_at === event.created_at
        && previousEvent.event_id.localeCompare(event.event_id) > 0)
    )) {
      fail('event_order_mismatch');
    }
    previousEvent = event;

    if (!stableEqual(event.authority, buildEventAuthority())) fail('event_authority_mismatch');
    if (!hasExactFields(event.source_integrity, [
      'canonical_event_id_verified',
      'raw_event_embedded',
      'raw_signature_embedded',
      'raw_workspace_metadata_embedded',
      'exact_content_embedded',
    ])
      || !event.source_integrity
      || event.source_integrity.canonical_event_id_verified !== true
      || event.source_integrity.raw_event_embedded !== false
      || event.source_integrity.raw_signature_embedded !== false) {
      fail('event_source_integrity_mismatch');
    }
    if (!hasExactFields(event.content, [
      'policy',
      'content_hash',
      'content_chars',
      'bounded_content',
      'truncated',
      'redaction_count',
      'raw_content_embedded',
      'redaction_scope',
      'redaction_complete',
      'safe_for_publication',
      'requires_explicit_content_authority',
    ])
      || !event.content
      || typeof event.content.content_hash !== 'string'
      || !SHA256_REF_PATTERN.test(event.content.content_hash)
      || typeof event.content.content_chars !== 'number'
      || !Number.isSafeInteger(event.content.content_chars)
      || event.content.content_chars < 0
      || typeof event.content.truncated !== 'boolean'
      || typeof event.content.redaction_count !== 'number'
      || !Number.isSafeInteger(event.content.redaction_count)
      || event.content.redaction_count < 0
      || event.content.safe_for_publication !== false) {
      fail('event_privacy_mismatch');
    } else if (event.content.policy === 'hash_only') {
      if (event.content.bounded_content !== null
        || event.content.raw_content_embedded !== false
        || event.content.redaction_scope !== 'not_applicable_no_raw_content'
        || event.content.redaction_complete !== null
        || event.content.requires_explicit_content_authority !== false) {
        fail('event_privacy_mismatch');
      }
    } else if (event.content.policy === 'bounded_best_effort_redaction') {
      if (typeof event.content.bounded_content !== 'string'
        || event.content.bounded_content.length > MAX_BOUNDED_CONTENT_CHARS
        || event.content.raw_content_embedded !== true
        || event.content.redaction_scope !== 'best_effort_known_patterns_only'
        || event.content.redaction_complete !== false
        || event.content.requires_explicit_content_authority !== true) {
        fail('event_privacy_mismatch');
      }
    } else {
      fail('event_privacy_mismatch');
    }
    const referenceFields = [
      'channel_ref_hashes',
      'event_ref_hashes',
      'pubkey_ref_hashes',
      'address_ref_hashes',
      'repository_ref_hashes',
      'identifier_ref_hashes',
    ];
    if (!hasExactFields(event.references, referenceFields)
      || referenceFields.some(field => !Array.isArray(event.references?.[field])
        || event.references[field].some(reference => (
          typeof reference !== 'string' || !SHA256_REF_PATTERN.test(reference)
        )))) {
      fail('event_reference_privacy_mismatch');
    }
    if (event.source_integrity
      && event.source_integrity.raw_workspace_metadata_embedded !== event.content?.raw_content_embedded) {
      fail('event_source_integrity_mismatch');
    }
    if (event.source_integrity
      && (typeof event.source_integrity.exact_content_embedded !== 'boolean'
        || (event.source_integrity.exact_content_embedded
          && (event.content?.policy !== 'bounded_best_effort_redaction'
            || event.content?.redaction_count !== 0
            || event.content?.truncated !== false)))) {
      fail('event_source_integrity_mismatch');
    }

    if (!hasExactFields(event.signature, [
      'signature_hash',
      'status',
      'signature_valid',
      'verification_result_claimed',
      'attestation_reference_verified',
      'verifier',
      'verifier_version',
      'evidence_ref',
      'claimed_binding',
    ])
      || !event.signature
      || event.signature.signature_valid !== null
      || event.signature.attestation_reference_verified !== false
      || typeof event.signature.signature_hash !== 'string'
      || !SHA256_REF_PATTERN.test(event.signature.signature_hash)) {
      fail('signature_evidence_boundary_mismatch');
    }
    if (!hasExactFields(event.principal_binding, [
      'status',
      'binding_verified',
      'principal_ref_hash',
      'agent_ref_hash',
      'evidence_ref',
      'claimed_binding',
    ])
      || !event.principal_binding
      || event.principal_binding.binding_verified !== false) {
      fail('principal_evidence_boundary_mismatch');
    }
    if (!hasExactFields(event.relay_audit, [
      'status',
      'persistence_status_claimed',
      'attestation_reference_verified',
      'audit_entry_ref',
      'audit_head_ref',
      'verifier',
      'verifier_version',
      'evidence_ref',
      'claimed_binding',
    ])
      || !event.relay_audit
      || event.relay_audit.attestation_reference_verified !== false) {
      fail('relay_evidence_boundary_mismatch');
    }

    const signatureClaimStatuses = new Set([
      'validity_claimed_by_unverified_attestation_reference',
      'invalidity_claimed_by_unverified_attestation_reference',
    ]);
    if (event.signature?.status !== 'not_verified' && !signatureClaimStatuses.has(event.signature?.status)) {
      fail('signature_evidence_boundary_mismatch');
    } else if (signatureClaimStatuses.has(event.signature?.status)) {
      if (!event.signature.claimed_binding
        || typeof event.signature.evidence_ref !== 'string'
        || !SHA256_REF_PATTERN.test(event.signature.evidence_ref)
        || typeof event.signature.verifier !== 'string'
        || !event.signature.verifier
        || typeof event.signature.verifier_version !== 'string'
        || !event.signature.verifier_version
        || (event.signature.status === 'validity_claimed_by_unverified_attestation_reference'
          && event.signature.verification_result_claimed !== 'valid')
        || (event.signature.status === 'invalidity_claimed_by_unverified_attestation_reference'
          && event.signature.verification_result_claimed !== 'invalid')) {
        fail('signature_evidence_boundary_mismatch');
      }
    } else if (event.signature?.claimed_binding !== null
      || event.signature?.evidence_ref !== null
      || event.signature?.verification_result_claimed !== null
      || event.signature?.verifier !== null
      || event.signature?.verifier_version !== null) {
      fail('signature_evidence_boundary_mismatch');
    }

    if (event.principal_binding?.status !== 'unbound'
      && event.principal_binding?.status !== 'binding_claimed_by_unverified_attestation_reference') {
      fail('principal_evidence_boundary_mismatch');
    } else if (event.principal_binding?.status === 'binding_claimed_by_unverified_attestation_reference') {
      if (!event.principal_binding.claimed_binding
        || typeof event.principal_binding.evidence_ref !== 'string'
        || !SHA256_REF_PATTERN.test(event.principal_binding.evidence_ref)
        || typeof event.principal_binding.principal_ref_hash !== 'string'
        || !SHA256_REF_PATTERN.test(event.principal_binding.principal_ref_hash)
        || typeof event.principal_binding.agent_ref_hash !== 'string'
        || !SHA256_REF_PATTERN.test(event.principal_binding.agent_ref_hash)) {
        fail('principal_evidence_boundary_mismatch');
      }
    } else if (event.principal_binding?.claimed_binding !== null
      || event.principal_binding?.evidence_ref !== null
      || event.principal_binding?.principal_ref_hash !== null
      || event.principal_binding?.agent_ref_hash !== null) {
      fail('principal_evidence_boundary_mismatch');
    }

    const relayClaimStatuses = new Set([
      'persistence_claimed_by_unverified_attestation_reference',
      'non_persistence_claimed_by_unverified_attestation_reference',
    ]);
    if (event.relay_audit?.status !== 'not_verified' && !relayClaimStatuses.has(event.relay_audit?.status)) {
      fail('relay_evidence_boundary_mismatch');
    } else if (relayClaimStatuses.has(event.relay_audit?.status)) {
      if (!event.relay_audit.claimed_binding
        || typeof event.relay_audit.evidence_ref !== 'string'
        || !SHA256_REF_PATTERN.test(event.relay_audit.evidence_ref)
        || !source?.relay_url_hash
        || typeof event.relay_audit.verifier !== 'string'
        || !event.relay_audit.verifier
        || typeof event.relay_audit.verifier_version !== 'string'
        || !event.relay_audit.verifier_version
        || (event.relay_audit.status === 'persistence_claimed_by_unverified_attestation_reference'
          && (event.relay_audit.persistence_status_claimed !== 'persisted'
            || typeof event.relay_audit.audit_entry_ref !== 'string'
            || !SHA256_REF_PATTERN.test(event.relay_audit.audit_entry_ref)
            || typeof event.relay_audit.audit_head_ref !== 'string'
            || !SHA256_REF_PATTERN.test(event.relay_audit.audit_head_ref)))
        || (event.relay_audit.status === 'non_persistence_claimed_by_unverified_attestation_reference'
          && event.relay_audit.persistence_status_claimed !== 'not_persisted')) {
        fail('relay_evidence_boundary_mismatch');
      }
    } else if (event.relay_audit?.claimed_binding !== null
      || event.relay_audit?.evidence_ref !== null
      || event.relay_audit?.persistence_status_claimed !== null
      || event.relay_audit?.audit_entry_ref !== null
      || event.relay_audit?.audit_head_ref !== null
      || event.relay_audit?.verifier !== null
      || event.relay_audit?.verifier_version !== null) {
      fail('relay_evidence_boundary_mismatch');
    }

    for (const [label, evidence] of [
      ['signature', event.signature],
      ['principal', event.principal_binding],
      ['relay', event.relay_audit],
    ]) {
      if (!evidence?.claimed_binding) continue;
      const bindingFields = label === 'relay'
        ? ['event_id', 'author_pubkey_hash', 'signature_hash', 'relay_url_hash']
        : ['event_id', 'author_pubkey_hash', 'signature_hash'];
      if (!hasExactFields(evidence.claimed_binding, bindingFields)
        || evidence.claimed_binding.event_id !== event.event_id
        || evidence.claimed_binding.author_pubkey_hash !== event.author_pubkey_hash
        || evidence.claimed_binding.signature_hash !== event.signature?.signature_hash) {
        fail(`${label}_attestation_binding_mismatch`);
      }
    }
    if (event.relay_audit?.claimed_binding
      && event.relay_audit.claimed_binding.relay_url_hash !== source?.relay_url_hash) {
      fail('relay_attestation_binding_mismatch');
    }
  }
}

export function compileBuzzEvidenceBundle(input = {}, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new BuzzEvidenceError('invalid_input', 'input must be an object containing events.');
  }
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new BuzzEvidenceError('invalid_option', 'options must be an object.');
  }
  assertNoDeprecatedEvidenceOptions(options);
  const events = Array.isArray(input.events) ? input.events : [];
  const maxEvents = Number.isInteger(options.max_events) ? options.max_events : MAX_EVENTS;
  if (maxEvents < 1 || maxEvents > MAX_EVENTS) {
    throw new BuzzEvidenceError('invalid_option', `max_events must be between 1 and ${MAX_EVENTS}.`);
  }
  if (events.length === 0) {
    throw new BuzzEvidenceError('events_required', 'At least one Buzz/Nostr event is required.');
  }
  if (events.length > maxEvents) {
    throw new BuzzEvidenceError(
      'too_many_events',
      `The bundle contains ${events.length} events; the limit is ${maxEvents}.`,
    );
  }

  const source = buildSource(input);
  const normalizedOptions = {
    content_policy: options.content_policy || 'hash_only',
    signature_attestations: normalizeEvidenceMap(options.signature_attestations, 'signature_attestations'),
    principal_attestations: normalizeEvidenceMap(options.principal_attestations, 'principal_attestations'),
    audit_attestations: normalizeEvidenceMap(options.audit_attestations, 'audit_attestations'),
    relay_url_hash: source.relay_url_hash,
  };
  const normalized = events.map((event, index) => normalizeEvent(event, index, normalizedOptions));
  const ids = normalized.map(event => event.event_id);
  if (new Set(ids).size !== ids.length) {
    throw new BuzzEvidenceError('duplicate_event', 'The evidence bundle contains duplicate event IDs.');
  }
  normalized.sort((left, right) => (
    left.created_at - right.created_at || left.event_id.localeCompare(right.event_id)
  ));

  const relationships = buildRelationships(normalized);
  const eventCommitments = buildEventCommitments(normalized);
  const eventRoot = buildEventRoot(source, relationships, eventCommitments);
  const summary = buildSummary(normalized);
  const privacy = buildPrivacy(normalized);
  const transactionAssuranceReadiness = buildTransactionAssuranceReadiness(normalized);
  const authority = buildBundleAuthority();
  const committedBundle = {
    schema: BUNDLE_SCHEMA,
    source,
    event_root: eventRoot,
    event_commitments: eventCommitments,
    events: normalized,
    relationships,
    summary,
    privacy,
    transaction_assurance_readiness: transactionAssuranceReadiness,
    authority,
  };
  const bundleRoot = sha256(stableStringify(buildBundleRootEnvelope(committedBundle)));
  return {
    schema: BUNDLE_SCHEMA,
    bundle_id: `buzz_bundle_${bundleRoot.slice(7, 19)}`,
    ...committedBundle,
    bundle_root: bundleRoot,
  };
}

export function verifyBuzzEvidenceBundle(bundle = {}, options = {}) {
  const failures = [];
  let recomputedEventRoot = null;
  let recomputedBundleRoot = null;
  const fail = code => {
    if (!failures.includes(code)) failures.push(code);
  };

  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
    return {
      schema: BUNDLE_VERIFICATION_SCHEMA,
      valid: false,
      bundle_root: null,
      recomputed_bundle_root: null,
      expected_bundle_root: null,
      failures: ['invalid_bundle'],
    };
  }
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    return {
      schema: BUNDLE_VERIFICATION_SCHEMA,
      valid: false,
      bundle_root: typeof bundle.bundle_root === 'string' ? bundle.bundle_root : null,
      recomputed_bundle_root: null,
      expected_bundle_root: null,
      failures: ['invalid_verification_options'],
    };
  }

  if (bundle.schema !== BUNDLE_SCHEMA) fail('bundle_schema_mismatch');
  const suppliedFields = Object.keys(bundle);
  for (const field of BUNDLE_FIELDS) {
    if (!hasOwn(bundle, field)) fail(`missing_field:${field}`);
  }
  for (const field of suppliedFields) {
    if (!BUNDLE_FIELDS.includes(field)) fail(`unexpected_field:${field}`);
  }

  let expectedBundleRoot = null;
  if (options.expected_bundle_root !== undefined && options.expected_bundle_root !== null) {
    if (typeof options.expected_bundle_root !== 'string' || !SHA256_REF_PATTERN.test(options.expected_bundle_root)) {
      fail('invalid_expected_bundle_root');
    } else {
      expectedBundleRoot = options.expected_bundle_root;
      if (bundle.bundle_root !== expectedBundleRoot) fail('expected_bundle_root_mismatch');
    }
  }

  try {
    validateSecurityInvariants(bundle, fail);
    const derivedEventCommitments = buildEventCommitments(bundle.events);
    if (!stableEqual(bundle.event_commitments, derivedEventCommitments)) {
      fail('event_commitments_mismatch');
    }
    const derivedRelationships = buildRelationships(bundle.events);
    if (!stableEqual(bundle.relationships, derivedRelationships)) fail('relationships_mismatch');
    recomputedEventRoot = buildEventRoot(bundle.source, derivedRelationships, derivedEventCommitments);
    if (bundle.event_root !== recomputedEventRoot) fail('event_root_mismatch');

    const derivedSummary = buildSummary(bundle.events);
    if (!stableEqual(bundle.summary, derivedSummary)) fail('summary_mismatch');
    const derivedPrivacy = buildPrivacy(bundle.events);
    if (!stableEqual(bundle.privacy, derivedPrivacy)) fail('privacy_mismatch');
    const derivedReadiness = buildTransactionAssuranceReadiness(bundle.events);
    if (!stableEqual(bundle.transaction_assurance_readiness, derivedReadiness)) {
      fail('transaction_assurance_readiness_mismatch');
    }
    const derivedAuthority = buildBundleAuthority();
    if (!stableEqual(bundle.authority, derivedAuthority)) fail('authority_mismatch');

    recomputedBundleRoot = sha256(stableStringify(buildBundleRootEnvelope(bundle)));
    if (typeof bundle.bundle_root !== 'string' || !SHA256_REF_PATTERN.test(bundle.bundle_root)) {
      fail('invalid_bundle_root');
    } else if (bundle.bundle_root !== recomputedBundleRoot) {
      fail('bundle_root_mismatch');
    }
    if (bundle.bundle_id !== `buzz_bundle_${recomputedBundleRoot.slice(7, 19)}`) {
      fail('bundle_id_mismatch');
    }
  } catch {
    fail('invalid_bundle_structure');
  }

  return {
    schema: BUNDLE_VERIFICATION_SCHEMA,
    valid: failures.length === 0,
    bundle_root: typeof bundle.bundle_root === 'string' ? bundle.bundle_root : null,
    recomputed_bundle_root: recomputedBundleRoot,
    expected_bundle_root: expectedBundleRoot,
    recomputed_event_root: recomputedEventRoot,
    failures,
  };
}

function normalizeClaimedState(value, field, fallback) {
  if (value === undefined || value === null) return fallback;
  return requireString(value, field, 50);
}

export function buildBuzzTransactionAssuranceReference(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new BuzzEvidenceError('invalid_input', 'input must be an object.');
  }
  if (hasOwn(input, 'states')) {
    throw new BuzzEvidenceError(
      'deprecated_transaction_state_shape',
      'states is not accepted because it can imply verification. Use claimed_states instead.',
    );
  }
  if (hasOwn(input, 'evidence_root')) {
    throw new BuzzEvidenceError(
      'deprecated_evidence_root_shape',
      'evidence_root is ambiguous. Use evidence_bundle_root with the compiled bundle_root.',
    );
  }
  const evidenceBundleRoot = assertShaRef(input.evidence_bundle_root, 'evidence_bundle_root');
  const receiptRef = assertShaRef(input.transaction_assurance_receipt_ref, 'transaction_assurance_receipt_ref');
  const mandateRef = assertShaRef(input.mandate_ref, 'mandate_ref');
  const reference = {
    schema: TRANSACTION_REFERENCE_SCHEMA,
    transaction_id: optionalString(input.transaction_id, 'transaction_id', 300),
    buzz_event_id: input.buzz_event_id === undefined || input.buzz_event_id === null
      ? null
      : assertHex(input.buzz_event_id, EVENT_ID_PATTERN, 'buzz_event_id'),
    evidence_bundle_root: evidenceBundleRoot,
    mandate_ref: mandateRef,
    transaction_assurance_receipt_ref: receiptRef,
    claimed_states: {
      authority: normalizeClaimedState(input.claimed_states?.authority, 'claimed_states.authority', 'unknown'),
      payment: normalizeClaimedState(input.claimed_states?.payment, 'claimed_states.payment', 'unknown'),
      execution: normalizeClaimedState(input.claimed_states?.execution, 'claimed_states.execution', 'unknown'),
      delivery: normalizeClaimedState(input.claimed_states?.delivery, 'claimed_states.delivery', 'unknown'),
      outcome: normalizeClaimedState(input.claimed_states?.outcome, 'claimed_states.outcome', 'unknown'),
      reconciliation: normalizeClaimedState(input.claimed_states?.reconciliation, 'claimed_states.reconciliation', 'unknown'),
    },
    state_claims_verified: false,
    publication: {
      event_kind_assigned: false,
      signed: false,
      posted: false,
      requires_explicit_principal_authority: true,
      requires_buzz_signing_key_outside_this_adapter: true,
    },
    non_claims: [
      'This reference does not verify the Buzz event signature.',
      'This reference does not grant payment or publication authority.',
      'Transaction Assurance state labels are caller-supplied claims and are not independently verified by this adapter.',
      'A Buzz channel membership is not an Agoragentic economic mandate.',
      'A relay event is not by itself proof of payment, delivery, or reconciliation.',
    ],
    authority: {
      grants_spend: false,
      grants_wallet_access: false,
      grants_publication: false,
      grants_trust: false,
    },
  };
  return {
    ...reference,
    reference_hash: sha256(stableStringify(reference)),
  };
}

export const BUZZ_EVIDENCE_CONSTANTS = Object.freeze({
  MAX_NIP01_KIND,
  MAX_EVENTS,
  MAX_EVENT_WIRE_BYTES,
  MAX_CONTENT_BYTES,
  MAX_TAGS,
  MAX_TAG_ITEMS,
  MAX_TAG_ITEM_BYTES,
  MAX_BOUNDED_CONTENT_CHARS,
  BUNDLE_SCHEMA,
  EVENT_ROOT_SCHEMA,
  BUNDLE_ROOT_SCHEMA,
  BUNDLE_VERIFICATION_SCHEMA,
  TRANSACTION_REFERENCE_SCHEMA,
  BUZZ_KINDS,
  BUZZ_UPSTREAM_PROVENANCE,
});
