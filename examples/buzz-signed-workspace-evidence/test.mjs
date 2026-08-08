import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BuzzEvidenceError,
  buildBuzzTransactionAssuranceReference,
  canonicalBuzzEventId,
  compileBuzzEvidenceBundle,
} from './buzz-event-evidence.mjs';

const PUBKEY_A = '1'.repeat(64);
const PUBKEY_B = '2'.repeat(64);
const SIGNATURE = '3'.repeat(128);

function event(overrides = {}) {
  const value = {
    pubkey: overrides.pubkey || PUBKEY_A,
    created_at: overrides.created_at ?? 1_786_000_000,
    kind: overrides.kind ?? 9,
    tags: overrides.tags || [['h', 'channel-1'], ['p', PUBKEY_B]],
    content: overrides.content || 'Release candidate is ready for review.',
    sig: overrides.sig || SIGNATURE,
  };
  return {
    ...value,
    id: overrides.id || canonicalBuzzEventId(value),
  };
}

test('compiles canonical Buzz events without inventing economic authority', () => {
  const message = event();
  const bundle = compileBuzzEvidenceBundle({
    events: [message],
    relay_url: 'https://buzz.example.test',
    community_ref: 'community:test',
  });

  assert.equal(bundle.schema, 'agoragentic.buzz-evidence-bundle.v1');
  assert.equal(bundle.events.length, 1);
  assert.equal(bundle.events[0].event_type, 'stream_message');
  assert.equal(bundle.events[0].source_integrity.canonical_event_id_verified, true);
  assert.equal(bundle.events[0].signature.status, 'not_verified');
  assert.equal(bundle.events[0].content.policy, 'hash_only');
  assert.equal(bundle.events[0].content.bounded_content, null);
  assert.deepEqual(bundle.relationships.channel_refs, ['channel-1']);
  assert.equal(bundle.transaction_assurance_readiness.ready_for_economic_action, false);
  assert(bundle.transaction_assurance_readiness.blockers.includes('workspace_membership_is_not_an_economic_mandate'));
  assert.equal(bundle.authority.posts_to_buzz, false);
});

test('bounded content is redacted and never represented as exact after redaction', () => {
  const message = event({
    content: 'Deploy with Authorization: Bearer abcdefghijklmnop and api_key=secret-value-123.',
  });
  const bundle = compileBuzzEvidenceBundle({ events: [message] }, {
    content_policy: 'bounded',
  });
  const evidence = bundle.events[0];

  assert.match(evidence.content.bounded_content, /\[REDACTED\]/);
  assert(evidence.content.redaction_count >= 1);
  assert.equal(evidence.source_integrity.exact_content_embedded, false);
});

test('external signature, principal, and audit evidence remain scoped', () => {
  const message = event();
  const signatureRef = `sha256:${'4'.repeat(64)}`;
  const bindingRef = `sha256:${'5'.repeat(64)}`;
  const auditRef = `sha256:${'6'.repeat(64)}`;
  const bundle = compileBuzzEvidenceBundle({ events: [message] }, {
    signature_verifications: {
      [message.id]: {
        signature_valid: true,
        verifier: 'nostr-verifier',
        verifier_version: '1.0.0',
        evidence_ref: signatureRef,
      },
    },
    principal_bindings: {
      [message.pubkey]: {
        principal_ref: 'principal:owner-1',
        agent_ref: 'agent:buzz-1',
        binding_evidence_ref: bindingRef,
      },
    },
    audit_evidence: {
      [message.id]: {
        persisted: true,
        audit_entry_ref: auditRef,
        audit_head_ref: auditRef,
        verifier: 'buzz-audit-export',
      },
    },
  });

  assert.equal(bundle.summary.signatures_verified, 1);
  assert.equal(bundle.summary.principals_bound, 1);
  assert.equal(bundle.summary.audit_entries_verified, 1);
  assert.equal(bundle.events[0].principal_binding.status, 'bound_by_external_evidence');
  assert.equal(bundle.events[0].authority.principal_mandate_verified, false);
  assert.equal(bundle.transaction_assurance_readiness.ready_for_payment, false);
  assert(bundle.transaction_assurance_readiness.blockers.includes('principal_mandate_required_before_economic_action'));
});

test('rejects a tampered event ID', () => {
  const message = event();
  message.content = 'tampered';
  assert.throws(
    () => compileBuzzEvidenceBundle({ events: [message] }),
    error => error instanceof BuzzEvidenceError && error.code === 'event_id_mismatch',
  );
});

test('rejects duplicate event IDs', () => {
  const message = event();
  assert.throws(
    () => compileBuzzEvidenceBundle({ events: [message, message] }),
    error => error instanceof BuzzEvidenceError && error.code === 'duplicate_event',
  );
});

test('classifies workflow and git evidence while preserving order deterministically', () => {
  const workflow = event({ kind: 46004, created_at: 20, content: 'approval requested' });
  const patch = event({ kind: 1617, created_at: 10, content: 'patch body' });
  const bundle = compileBuzzEvidenceBundle({ events: [workflow, patch] });

  assert.equal(bundle.events[0].event_type, 'git_patch');
  assert.equal(bundle.events[1].event_type, 'workflow_event');
  assert.equal(bundle.summary.event_types.git_patch, 1);
  assert.equal(bundle.summary.event_types.workflow_event, 1);
});

test('builds an unsigned proposal-only Transaction Assurance reference', () => {
  const reference = buildBuzzTransactionAssuranceReference({
    transaction_id: 'txn_123',
    buzz_event_id: event().id,
    evidence_root: `sha256:${'7'.repeat(64)}`,
    mandate_ref: `sha256:${'8'.repeat(64)}`,
    transaction_assurance_receipt_ref: `sha256:${'9'.repeat(64)}`,
    states: {
      authority: 'verified',
      payment: 'final',
      execution: 'completed',
      delivery: 'verified',
      outcome: 'pass',
      reconciliation: 'complete',
    },
  });

  assert.equal(reference.schema, 'agoragentic.buzz-transaction-assurance-reference.v1');
  assert.equal(reference.publication.event_kind_assigned, false);
  assert.equal(reference.publication.signed, false);
  assert.equal(reference.publication.posted, false);
  assert.equal(reference.authority.grants_publication, false);
  assert.match(reference.reference_hash, /^sha256:[a-f0-9]{64}$/);
});
