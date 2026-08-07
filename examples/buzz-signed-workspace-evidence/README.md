# Buzz Signed Workspace Evidence Bridge

> **Use Buzz as the signed human-agent workspace; use Agoragentic as the economic authority, policy, outcome-proof, and reconciliation layer.**

This experimental adapter normalizes signed [Block Buzz](https://github.com/block/buzz) / Nostr events into bounded Agoragentic evidence.

It does not connect to a relay, verify Schnorr signatures by itself, post to Buzz, operate a wallet, pay, deploy, publish, or mutate trust.

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
- extracts channel, event, pubkey, address, repository, and identifier references;
- hashes the signature instead of embedding it;
- hashes content by default;
- optionally stores bounded, secret-redacted content;
- accepts explicit external signature-verification evidence;
- accepts explicit principal-to-agent binding evidence;
- accepts explicit relay-audit persistence evidence;
- creates a deterministic bundle root;
- keeps every financial, deployment, publication, memory, and trust authority flag false.

It also defines an unsigned, proposal-only reference that can later link:

```text
Buzz event
+ Buzz evidence root
+ Agoragentic mandate
+ Transaction Assurance receipt
```

No Nostr kind is assigned by this adapter. It cannot sign or publish that reference.

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
  signature_verifications: {
    [events[0].id]: {
      signature_valid: true,
      verifier: 'your-nostr-verifier',
      verifier_version: '1.0.0',
      evidence_ref: 'sha256:...'
    }
  },
  principal_bindings: {
    [events[0].pubkey]: {
      principal_ref: 'principal:org-123',
      agent_ref: 'agent:release-bot',
      binding_evidence_ref: 'sha256:...'
    }
  }
});
```

Even with signature, principal, and audit evidence, the bundle remains blocked for economic action until an explicit Agoragentic mandate and external enforcement chokepoint exist.

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
- actor and principal bindings;
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
3. Signature verification and relay-audit export adapter.
4. Buzz ACP/CLI Harness Core bridge.
5. Signed Release Evidence Compiler free canary.
6. Agent OS workspace lane with hard external-action chokepoints.
7. Owner-authorized receipt-reference posting.
8. Only then evaluate a paid marketplace listing.

## Publication boundary

This package remains private alpha. It does not claim:

- a Block or Buzz partnership;
- live Buzz compatibility;
- signature verification without supplied verifier evidence;
- audit persistence without supplied audit evidence;
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

The dedicated workflow runs on Node 20, 22, and 24 with no credentials, network calls, relay writes, or funds.

## License

This adapter is Apache-2.0. Buzz is also Apache-2.0. No Buzz implementation code is copied into this adapter; it consumes the documented NIP-01 event shape and records upstream attribution.
