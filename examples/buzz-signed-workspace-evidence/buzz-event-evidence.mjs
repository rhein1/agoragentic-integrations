import { createHash } from 'node:crypto';

const EVENT_ID_PATTERN = /^[a-f0-9]{64}$/;
const PUBKEY_PATTERN = /^[a-f0-9]{64}$/;
const SIGNATURE_PATTERN = /^[a-f0-9]{128}$/;
const SHA256_REF_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_EVENTS = 256;
const MAX_EVENT_WIRE_BYTES = 65_536;
const MAX_CONTENT_BYTES = 60_000;
const MAX_TAGS = 256;
const MAX_TAG_ITEMS = 16;
const MAX_TAG_ITEM_BYTES = 4_096;
const MAX_BOUNDED_CONTENT_CHARS = 8_000;

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
  [/\b(?:api[_-]?key|private[_-]?key|password|secret)\s*[:=]\s*[^\s,;]{8,}/gi, '$1=[REDACTED]'],
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

function normalizeString(value, fallback = null, maxLength = 2_000) {
  if (value === undefined || value === null) return fallback;
  const normalized = String(value).trim();
  return normalized ? normalized.slice(0, maxLength) : fallback;
}

function assertHex(value, pattern, field) {
  const normalized = String(value || '').toLowerCase();
  if (!pattern.test(normalized)) {
    throw new BuzzEvidenceError('invalid_event', `${field} has an invalid shape.`);
  }
  return normalized;
}

function normalizeKind(value) {
  const kind = Number(value);
  if (!Number.isInteger(kind) || kind < 0 || kind > 0xffffffff) {
    throw new BuzzEvidenceError('invalid_event', 'kind must be an unsigned 32-bit integer.');
  }
  return kind;
}

function normalizeTimestamp(value) {
  const timestamp = Number(value);
  if (!Number.isInteger(timestamp) || timestamp < 0 || timestamp > Number.MAX_SAFE_INTEGER) {
    throw new BuzzEvidenceError('invalid_event', 'created_at must be a non-negative integer.');
  }
  return timestamp;
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

function redactContent(content) {
  let redacted = content;
  let count = 0;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, match => {
      count += 1;
      if (typeof replacement === 'function') return replacement(match);
      return replacement;
    });
  }
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
    };
  }
  if (policy !== 'bounded') {
    throw new BuzzEvidenceError(
      'invalid_option',
      'content_policy must be hash_only, none, or bounded.',
    );
  }
  const bounded = content.slice(0, MAX_BOUNDED_CONTENT_CHARS);
  const redacted = redactContent(bounded);
  return {
    policy: 'bounded_redacted',
    content_hash: contentHash,
    content_chars: content.length,
    bounded_content: redacted.content,
    truncated: bounded.length < content.length,
    redaction_count: redacted.redaction_count,
  };
}

function normalizeVerification(value) {
  if (!value || typeof value !== 'object') {
    return {
      status: 'not_verified',
      signature_valid: null,
      verifier: null,
      verifier_version: null,
      evidence_ref: null,
    };
  }
  if (value.signature_valid !== true && value.signature_valid !== false) {
    throw new BuzzEvidenceError(
      'invalid_verification',
      'signature verification evidence must set signature_valid to true or false.',
    );
  }
  const evidenceRef = value.evidence_ref === undefined || value.evidence_ref === null
    ? null
    : String(value.evidence_ref);
  if (evidenceRef && !SHA256_REF_PATTERN.test(evidenceRef)) {
    throw new BuzzEvidenceError(
      'invalid_verification',
      'signature verification evidence_ref must be a sha256 reference.',
    );
  }
  return {
    status: value.signature_valid ? 'verified' : 'invalid',
    signature_valid: value.signature_valid,
    verifier: normalizeString(value.verifier, null, 200),
    verifier_version: normalizeString(value.verifier_version, null, 100),
    evidence_ref: evidenceRef,
  };
}

function normalizePrincipalBinding(value, pubkey) {
  if (!value || typeof value !== 'object') {
    return {
      status: 'unbound',
      principal_ref: null,
      agent_ref: null,
      binding_evidence_ref: null,
    };
  }
  const evidenceRef = value.binding_evidence_ref === undefined || value.binding_evidence_ref === null
    ? null
    : String(value.binding_evidence_ref);
  if (evidenceRef && !SHA256_REF_PATTERN.test(evidenceRef)) {
    throw new BuzzEvidenceError(
      'invalid_principal_binding',
      `principal binding evidence for ${pubkey} must be a sha256 reference.`,
    );
  }
  const principalRef = normalizeString(value.principal_ref, null, 300);
  if (!principalRef) {
    throw new BuzzEvidenceError(
      'invalid_principal_binding',
      `principal binding for ${pubkey} requires principal_ref.`,
    );
  }
  return {
    status: 'bound_by_external_evidence',
    principal_ref: principalRef,
    agent_ref: normalizeString(value.agent_ref, `nostr:${pubkey}`, 300),
    binding_evidence_ref: evidenceRef,
  };
}

function normalizeAuditEvidence(value) {
  if (!value || typeof value !== 'object') {
    return {
      status: 'not_verified',
      audit_entry_ref: null,
      audit_head_ref: null,
      verifier: null,
    };
  }
  for (const field of ['audit_entry_ref', 'audit_head_ref']) {
    if (value[field] && !SHA256_REF_PATTERN.test(String(value[field]))) {
      throw new BuzzEvidenceError(
        'invalid_audit_evidence',
        `${field} must be a sha256 reference.`,
      );
    }
  }
  return {
    status: value.persisted === true ? 'externally_verified' : 'not_verified',
    audit_entry_ref: value.audit_entry_ref ? String(value.audit_entry_ref) : null,
    audit_head_ref: value.audit_head_ref ? String(value.audit_head_ref) : null,
    verifier: normalizeString(value.verifier, null, 200),
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

  const verification = normalizeVerification(options.signature_verifications?.[id]);
  const principalBinding = normalizePrincipalBinding(options.principal_bindings?.[pubkey], pubkey);
  const auditEvidence = normalizeAuditEvidence(options.audit_evidence?.[id]);
  const contentRecord = contentEvidence(content, options.content_policy);
  const channelRefs = tagsByName(tags, 'h');
  const eventRefs = tagsByName(tags, 'e');
  const pubkeyRefs = tagsByName(tags, 'p');

  return {
    schema: 'agoragentic.buzz-event-evidence.v1',
    event_id: id,
    event_hash_ref: `sha256:${id}`,
    event_type: classifyKind(kind),
    kind,
    created_at,
    author_pubkey: pubkey,
    signature: {
      signature_hash: sha256(sig),
      ...verification,
    },
    principal_binding: principalBinding,
    source_integrity: {
      canonical_event_id_verified: true,
      raw_event_embedded: false,
      raw_signature_embedded: false,
      exact_content_embedded: contentRecord.policy === 'bounded_redacted' && contentRecord.redaction_count === 0 && contentRecord.truncated === false,
    },
    references: {
      channel_refs: channelRefs,
      event_refs: eventRefs,
      pubkey_refs: pubkeyRefs,
      address_refs: tagsByName(tags, 'a'),
      repository_refs: tagsByName(tags, 'r'),
      identifier_refs: tagsByName(tags, 'd'),
    },
    content: contentRecord,
    relay_audit: auditEvidence,
    authority: {
      workspace_membership_is_economic_authority: false,
      principal_mandate_verified: false,
      spend_allowed: false,
      wallet_access_allowed: false,
      deploy_allowed: false,
      publish_allowed: false,
      trust_mutation_allowed: false,
    },
  };
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function buildBlockers(events) {
  const blockers = ['workspace_membership_is_not_an_economic_mandate'];
  if (events.some(event => event.signature.status === 'not_verified')) {
    blockers.push('one_or_more_event_signatures_not_verified');
  }
  if (events.some(event => event.signature.status === 'invalid')) {
    blockers.push('one_or_more_event_signatures_invalid');
  }
  if (events.some(event => event.principal_binding.status === 'unbound')) {
    blockers.push('one_or_more_event_authors_not_bound_to_a_principal');
  }
  if (events.some(event => event.relay_audit.status !== 'externally_verified')) {
    blockers.push('relay_audit_persistence_not_verified_for_every_event');
  }
  blockers.push('principal_mandate_required_before_economic_action');
  blockers.push('external_tool_and_payment_chokepoint_required');
  return blockers;
}

export function compileBuzzEvidenceBundle(input = {}, options = {}) {
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

  const normalizedOptions = {
    content_policy: options.content_policy || 'hash_only',
    signature_verifications: options.signature_verifications || {},
    principal_bindings: options.principal_bindings || {},
    audit_evidence: options.audit_evidence || {},
  };
  const normalized = events.map((event, index) => normalizeEvent(event, index, normalizedOptions));
  const ids = normalized.map(event => event.event_id);
  if (new Set(ids).size !== ids.length) {
    throw new BuzzEvidenceError('duplicate_event', 'The evidence bundle contains duplicate event IDs.');
  }
  normalized.sort((left, right) => (
    left.created_at - right.created_at || left.event_id.localeCompare(right.event_id)
  ));

  const eventRootInput = normalized.map(event => ({
    event_id: event.event_id,
    signature_status: event.signature.status,
    content_hash: event.content.content_hash,
    audit_status: event.relay_audit.status,
  }));
  const evidenceRoot = sha256(JSON.stringify(eventRootInput));
  const blockers = buildBlockers(normalized);

  return {
    schema: 'agoragentic.buzz-evidence-bundle.v1',
    bundle_id: `buzz_bundle_${evidenceRoot.slice(7, 19)}`,
    source: {
      product: 'Block Buzz',
      repository: 'https://github.com/block/buzz',
      relay_url: normalizeString(input.relay_url, null, 2_048),
      community_ref: normalizeString(input.community_ref, null, 300),
      partnership_claimed: false,
      compatibility_verified_against_live_relay: options.live_compatibility_verified === true,
    },
    event_root: evidenceRoot,
    events: normalized,
    relationships: {
      channel_refs: unique(normalized.flatMap(event => event.references.channel_refs)),
      event_refs: unique(normalized.flatMap(event => event.references.event_refs)),
      pubkey_refs: unique(normalized.flatMap(event => event.references.pubkey_refs)),
      authors: unique(normalized.map(event => event.author_pubkey)),
    },
    summary: {
      event_count: normalized.length,
      event_types: normalized.reduce((counts, event) => {
        counts[event.event_type] = (counts[event.event_type] || 0) + 1;
        return counts;
      }, {}),
      signatures_verified: normalized.filter(event => event.signature.status === 'verified').length,
      signatures_invalid: normalized.filter(event => event.signature.status === 'invalid').length,
      principals_bound: normalized.filter(event => event.principal_binding.status !== 'unbound').length,
      audit_entries_verified: normalized.filter(event => event.relay_audit.status === 'externally_verified').length,
      redactions: normalized.reduce((sum, event) => sum + event.content.redaction_count, 0),
    },
    transaction_assurance_readiness: {
      ready_for_economic_action: false,
      ready_for_payment: false,
      ready_for_settlement: false,
      ready_for_reconciliation: false,
      blockers,
      next_safe_action: 'Verify signatures and relay persistence, bind each agent key to a principal, then evaluate an explicit Agoragentic mandate before any external side effect or payment.',
    },
    authority: {
      grants_spend: false,
      grants_wallet_access: false,
      grants_deployment: false,
      grants_publication: false,
      grants_memory_write: false,
      grants_trust: false,
      posts_to_buzz: false,
    },
    created_at: new Date().toISOString(),
  };
}

function assertShaRef(value, field) {
  if (!SHA256_REF_PATTERN.test(String(value || ''))) {
    throw new BuzzEvidenceError('invalid_reference', `${field} must be a sha256 reference.`);
  }
  return String(value);
}

export function buildBuzzTransactionAssuranceReference(input = {}) {
  const evidenceRoot = assertShaRef(input.evidence_root, 'evidence_root');
  const receiptRef = assertShaRef(input.transaction_assurance_receipt_ref, 'transaction_assurance_receipt_ref');
  const mandateRef = assertShaRef(input.mandate_ref, 'mandate_ref');
  const reference = {
    schema: 'agoragentic.buzz-transaction-assurance-reference.v1',
    transaction_id: normalizeString(input.transaction_id, null, 300),
    buzz_event_id: input.buzz_event_id
      ? assertHex(input.buzz_event_id, EVENT_ID_PATTERN, 'buzz_event_id')
      : null,
    evidence_root: evidenceRoot,
    mandate_ref: mandateRef,
    transaction_assurance_receipt_ref: receiptRef,
    states: {
      authority: normalizeString(input.states?.authority, 'unknown', 50),
      payment: normalizeString(input.states?.payment, 'unknown', 50),
      execution: normalizeString(input.states?.execution, 'unknown', 50),
      delivery: normalizeString(input.states?.delivery, 'unknown', 50),
      outcome: normalizeString(input.states?.outcome, 'unknown', 50),
      reconciliation: normalizeString(input.states?.reconciliation, 'unknown', 50),
    },
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
    reference_hash: sha256(JSON.stringify(reference)),
  };
}

export const BUZZ_EVIDENCE_CONSTANTS = Object.freeze({
  MAX_EVENTS,
  MAX_EVENT_WIRE_BYTES,
  MAX_CONTENT_BYTES,
  MAX_TAGS,
  MAX_TAG_ITEMS,
  MAX_TAG_ITEM_BYTES,
  MAX_BOUNDED_CONTENT_CHARS,
  BUZZ_KINDS,
});
