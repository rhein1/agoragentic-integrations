# Buzz Signed Workspace Evidence Bridge

> **Use Buzz as the signed human-agent workspace; use Agoragentic as the economic authority, policy, outcome-proof, and reconciliation layer.**

This experimental adapter normalizes exported [Block Buzz](https://github.com/block/buzz) / Nostr events into bounded Agoragentic evidence.

It does not connect to a relay, verify Schnorr signatures or attestation artifacts/verifier identities, post to Buzz, operate a wallet, pay, deploy, publish, or mutate trust.

It pins its classified kind subset to a reviewed upstream source revision rather than following Buzz `main` implicitly. See [`upstream-provenance.json`](upstream-provenance.json). The default packet is hash-only for workspace metadata as well as content: it never emits raw relay URLs, community references, channel names, repository references, identifiers, or pubkeys. Hash-only output is not a confidentiality boundary: low-entropy workspace references can still be guessed or correlated, so private exports still require authorization and protected storage.

## Product fit

Buzz is unusually valuable to Agoragentic because it already gives humans and agents one shared workspace substrate:

```text
people + agents + channels + workflows + git + media
                         ↓
                 signed Nostr events
                         ↓
               one searchable relay log
```

Agoragentic should not recreate that workspace. The complementary architecture is:

```text
Buzz signed event / mention / patch / workflow
                         ↓
      Agoragentic signed-workspace evidence bridge
                         ↓
principal and agent binding → mandate → policy → allow / ask / deny
                         ↓
approved external tool, provider, deployment, or payment chokepoint
                         ↓
outcome evaluation → Transaction Assurance receipt → reconciliation
                         ↓
optional owner-authorized receipt reference posted back to Buzz
```

The core distinction is:

```text
Buzz membership
≠ economic authority

signed workspace event
≠ payment authorization

relay acceptance
≠ guaranteed audit persistence

workflow approval
≠ complete payment mandate

hash-chain audit entry
≠ payment, delivery, or outcome receipt
```

## What this adapter does

It accepts ordinary NIP-01-shaped events:

```json
{
  "id": "<64 hex>",
  "pubkey": "<64 hex>",
  "created_at": 1786000000,
  "kind": 9,
  "tags": [["h", "channel-id"]],
  "content": "Release candidate ready for review.",
  "sig": "<128 hex>"
}
```

It then:

- verifies that `id` matches the canonical NIP-01 serialization;
- enforces event, content, and tag bounds;
- classifies common Buzz message, workflow, agent, forum, and Git event kinds;
- records deterministic hashes for channel, event, pubkey, address, repository, and identifier references;
- hashes the signature instead of embedding it;
- hashes content by default;
- optionally stores bounded, secret-redacted content;
- accepts only typed external attestation references bound to the exact event ID, pubkey, and signature hash;
- records those claims as unverified references; it never labels a signature, principal binding, or relay persistence as verified without a separate trusted resolver;
- commits source metadata and every normalized evidence field into a deterministic bundle root;
- keeps every financial, deployment, publication, memory, and trust authority flag false.

It also defines an unsigned, proposal-only reference that can later link:

```text
Buzz event
+ Buzz evidence root
+ Agoragentic mandate
+ Transaction Assurance receipt
```

No Nostr kind is assigned by this adapter. It cannot sign or publish that reference.

## Upstream provenance and compatibility boundary

The current mapping was reviewed against Block/Buzz commit [`f029deafae6ad3b63e13c29104f3be76122cb1df`](https://github.com/block/buzz/tree/f029deafae6ad3b63e13c29104f3be76122cb1df), specifically [`crates/buzz-core/src/kind.rs`](https://github.com/block/buzz/blob/f029deafae6ad3b63e13c29104f3be76122cb1df/crates/buzz-core/src/kind.rs). The NIP-01 wire checks are pinned to [`nostr-protocol/nips` `c53877571f96eb423661fc23c620d629d37b8f19`](https://github.com/nostr-protocol/nips/tree/c53877571f96eb423661fc23c620d629d37b8f19). The provenance record includes source hashes and the exact classified subset.

This is source-review evidence only. It does not establish live relay, CLI, ACP, private-channel, signature-verifier, or audit-export compatibility. Each needs a separately approved no-customer-data canary.

## Run

Prepare a JSON array of Buzz/Nostr events, then:

```bash
cd examples/buzz-signed-workspace-evidence
node cli.mjs ./events.json --out ./buzz-evidence.json
```

By default, event content is hash-only.

For an explicitly local, bounded preview:

```bash
node cli.mjs ./events.json \
  --content-policy bounded \
  --relay-url https://buzz.example.com \
  --community community:engineering \
  --out ./buzz-evidence.json
```

The bounded mode applies basic credential-pattern redaction and caps embedded content. It is not a full data-loss-prevention system.

## JavaScript API

```javascript
import {
  compileBuzzEvidenceBundle,
  buildBuzzTransactionAssuranceReference,
} from './buzz-event-evidence.mjs';

const bundle = compileBuzzEvidenceBundle({
  events,
  relay_url: 'https://buzz.example.com',
  community_ref: 'community:engineering',
}, {
  content_policy: 'hash_only',
  signature_attestations: {
    [events[0].id]: {
      event_id: events[0].id,
      pubkey: events[0].pubkey,
      signature_hash: 'sha256:<hash of this event signature>',
      verification_result: 'valid',
      verifier: 'your-nostr-verifier',
      verifier_version: '1.0.0',
      attestation_ref: 'sha256:<external verifier evidence>'
    }
  },
  principal_attestations: {
    [events[0].id]: {
      event_id: events[0].id,
      pubkey: events[0].pubkey,
      signature_hash: 'sha256:<hash of this event signature>',
      principal_ref: 'principal:org-123',
      agent_ref: 'agent:release-bot',
      attestation_ref: 'sha256:<principal binding evidence>'
    }
  },
  audit_attestations: {
    [events[0].id]: {
      event_id: events[0].id,
      pubkey: events[0].pubkey,
      signature_hash: 'sha256:<hash of this event signature>',
      persistence_status: 'persisted',
      audit_entry_ref: 'sha256:<audit entry>',
      audit_head_ref: 'sha256:<audit head>',
      verifier: 'buzz-audit-export',
      verifier_version: '1.0.0',
      attestation_ref: 'sha256:<persistence evidence>'
    }
  }
});
```

First create a hash-only packet to obtain the emitted `signature_hash`; an independent verifier or export process can then produce an attestation bound to that exact event. The compiler verifies only that the caller-supplied fields are structurally bound to the event. It does not fetch or authenticate the attestation artifact, validate the verifier identity, or turn a claim into verification. The compiler never accepts a naked `signature_valid`, `persisted`, or principal-binding boolean as verification evidence.

Even with typed signature, principal, and audit attestation references, the bundle remains blocked until an independently verifiable attestation artifact, trusted verifier policy, explicit Agoragentic mandate, and external enforcement chokepoint exist.

## Audit conclusions

### What Buzz does particularly well

- Agents are actual workspace members with their own signing keys and audit trails.
- The CLI is agent-first: JSON on stdout, structured errors on stderr.
- ACP agents can be connected to the relay through a harness, with owner-only inbound gating by default.
- Messages, reactions, workflows, Git activity, media, and agent work share one event substrate.
- The repository is unusually explicit about what works now, what is being wired, and what is still vision.
- Packaged desktop releases, one-click relay deployment, screenshots, onboarding, and high-volume dogfooding lower adoption friction.
- The repository demonstrates strong regression, live-receipt, and failure-characterization discipline.

### Boundaries Agoragentic must not blur

- Buzz documents channel membership as the primary access-control mechanism. That is appropriate for workspace participation, but it is not enough for budgets, merchants, payment rails, wallet authority, per-tool authority, or transaction limits.
- Buzz's shell and file-edit MCP tools run at the operator's trust level. Process, history, and output bounds are valuable, but they are not an OS security sandbox.
- Buzz's hash-chain audit is tamper-evident, not tamper-resistant against an attacker who can rewrite the database and recompute the chain.
- The relay event pipeline treats audit and workflow side effects as asynchronous. A successful event acceptance should not be treated as a complete financial receipt without separate persistence evidence.
- Workflow approvals are not a substitute for a typed principal mandate and payment/outcome reconciliation contract.
- The repository currently uses `rmcp 1.1.0`; this audit found no source evidence for MCP `2026-07-28`, `Mcp-Method`, or `Mcp-Name` parity. Exact support must be verified before making an MCP v2 claim.

## Commercial opportunities

The candidate products are defined in [`listing-candidates.json`](listing-candidates.json).

### Signed Release Evidence Compiler

Input:

- signed Buzz channel events;
- patches, repository announcements, workflow events, review messages, and release decisions;
- optional CI and external verification evidence.

Output:

- canonical event-integrity results;
- typed but unverified actor and principal-binding references;
- release evidence graph;
- missing-approval and missing-persistence findings;
- public-safe evidence bundle;
- local Agoragentic receipt.

This is more valuable than generic channel export because it answers:

> Which signed people and agents proposed, reviewed, approved, tested, and released this exact change—and what evidence is still missing?

### Incident Memory Evidence

Search and compile signed incident discussions, prior fixes, workflow runs, owners, and relevant evidence into a bounded response with event IDs and source hashes.

### Governed Buzz Agent Workspace

Connect an Agent OS deployment to Buzz through ACP or the JSON CLI while keeping filesystem, network, credentials, payments, deployment, and owner authority outside the model-controlled workspace process.

### Transaction Assurance Reference

After an externally enforced transaction completes, post an owner-authorized, signed reference back to Buzz so the channel can point to the mandate, evidence root, payment/outcome receipt, and reconciliation state without embedding private payment data.

## Recommended implementation order

1. Local signed-event evidence compiler — this PR.
2. Exact live Buzz relay and CLI compatibility canary.
3. Signed attestation artifact, trusted verifier policy, signature verification, and relay-audit export adapter.
4. Buzz ACP/CLI Harness Core bridge.
5. Signed Release Evidence Compiler free canary.
6. Agent OS workspace lane with hard external-action chokepoints.
7. Owner-authorized receipt-reference posting.
8. Only then evaluate a paid marketplace listing.

## Publication boundary

This package remains unpublished alpha. It does not claim:

- a Block or Buzz partnership;
- live Buzz compatibility;
- signature verification without independently validated verifier evidence and trust policy;
- audit persistence without independently validated audit evidence and trust policy;
- a principal binding merely from a pubkey;
- an economic mandate from channel membership;
- MCP v2 compatibility;
- a live Marketplace listing;
- x402 support;
- production dependency or certification.

## Validation

```bash
npm run check
npm test
npm run pack:dry
```

The dedicated workflow runs on Node 20, 22, and 24 with no credentials, network calls, relay writes, or funds. It verifies the packed local artifact can install and run the CLI offline, and that it includes this folder's Apache-2.0 [`LICENSE`](LICENSE) and upstream provenance record.

## License

This adapter is Apache-2.0. Buzz is also Apache-2.0. No Buzz implementation code is copied into this adapter; it consumes the documented NIP-01 event shape and records upstream attribution and source hashes.
