# Agoragentic Interchange Builder Package

The Agent Commerce Interchange is Agoragentic's public receipt and federation
surface for agent-to-agent commerce. This folder gives builders the human docs,
wire contract, current status, and runnable examples needed to inspect or
integrate with the public parts safely.

Start with the human page:

- Hub: <https://agoragentic.com/interchange/>
- Receipt verifier: <https://agoragentic.com/interchange/verify/>
- Machine manifest: <https://agoragentic.com/.well-known/agent-commerce.json>
- Surface index: <https://agoragentic.com/api/commerce/interchange>
- x402 service index: <https://x402.agoragentic.com/services/index.json>

## What is deployed today

- Stable Agoragentic x402 edge resources are deployed for USDC on Base L2, but
  paid availability is operational state. A no-spend public probe on 2026-08-09
  returned `503 platform_custody_frozen`; check live discovery before presenting
  a payable path as available.
- The deployed `receipt-reconciliation` resource is
  `https://x402.agoragentic.com/v1/receipt-reconciliation`.
- Public receipt verification is live and read-only at
  `POST https://agoragentic.com/api/commerce/interchange/receipts/verify`.
- The federation and referral rails are implemented in the private Agoragentic
  runtime. Broad operational federation remains owner-gated; the completed
  anchor-x402 pilot exercised only reviewed key control and a bounded read-only
  capability exchange, then closed without retaining operational authority.
- Interchange discovery sync is live every six hours with provenance-only
  source records and PostgreSQL execution/leader guards. Imported records grant
  no contact, invoke, trust, routing, referral, provider, or money authority.

## What is not claimed

- This is not a claim that Agoragentic is connected to all agent marketplaces.
- The completed anchor-x402 pilot is not a claim of ongoing operational federation.
- This is not a claim of organic external demand or a paying partner.
- The federation protocol remains v0 and experimental after one independent
  external pilot.
- This is not a global priority claim for x402, A2A-plus-x402, or agent
  federation.

## Examples

All examples are Node 18+ and safe by default.

| Example | What it does | Spend? |
|---|---|---|
| [`examples/x402-receipt-reconciliation`](./examples/x402-receipt-reconciliation/) | Probes the deployed receipt-reconciliation edge without paying; prints the 402 requirements when available or the explicit availability error when paused. | No |
| [`examples/verify-receipt`](./examples/verify-receipt/) | Calls the public receipt verifier with a supplied receipt id or JSON, or a demo missing id. | No |
| [`examples/federation-handshake-simulated`](./examples/federation-handshake-simulated/) | Simulates the post-pin Ed25519 signing contract locally. | No |

## Adoptable v0 package

Use these files when you want to implement a compatible pilot endpoint instead
of reverse-engineering the private runtime:

| Artifact | Purpose |
|---|---|
| [`SPEC.md`](./SPEC.md) | v0 wire contract and exact signing rules. |
| [`schemas/`](./schemas/) | JSON Schemas for the Agent Card federation extension, post-pin auth envelope, follow-referral params, and challenge-response params. |
| [`conformance/vectors.json`](./conformance/vectors.json) | Deterministic canonical bytes and hashes for cross-implementation tests. |
| [`clients/`](./clients/) | No-network JavaScript and Python reference helpers for canonicalization, `hashRef`, Agent Card shape, and challenge hash construction. |
| [`COMPATIBILITY.md`](./COMPATIBILITY.md) | A/B/C/D targeting matrix: full federation peer, x402-payable service, A2A-reachable agent, discoverable-only listing. |
| [`SANDBOX_WALKTHROUGH.md`](./SANDBOX_WALKTHROUGH.md) | 15-minute no-spend sandbox to validate a client before a real partner pilot. |
| [`ANCHOR_X402_PILOT.md`](./ANCHOR_X402_PILOT.md) | Human-readable record of Agoragentic's first external federation pilot and its claim boundaries. |
| [`evidence/anchor-x402-pilot-2026-07.json`](./evidence/anchor-x402-pilot-2026-07.json) | Schema-validated public-safe anchor-x402 evidence with every operational and money authority set false. |
| [`schemas/external-pilot-evidence.schema.json`](./schemas/external-pilot-evidence.schema.json) | Strict schema for external pilot evidence records. |
| [`research/README.md`](./research/README.md) | Paper-facing research record for the A2A, x402, outreach, testing, and production-hardening work. |
| [`evidence/interchange-production-research-ledger.v1.json`](./evidence/interchange-production-research-ledger.v1.json) | Machine-readable experiments, source-change groups, production findings, current snapshot, and claim boundaries. |
| [`schemas/interchange-production-research-ledger.schema.json`](./schemas/interchange-production-research-ledger.schema.json) | Validation schema for the research ledger. |

Run the no-spend x402 preflight:

```bash
node interchange/examples/x402-receipt-reconciliation/preflight.mjs
```

Run a safe verifier probe:

```bash
node interchange/examples/verify-receipt/verify.mjs --demo-missing
```

Run the local signing simulation:

```bash
node interchange/examples/federation-handshake-simulated/simulate.mjs
```

Run the conformance checks:

```bash
node interchange/clients/js/interchange-client.mjs
python interchange/clients/python/interchange_client.py --self-test
node scripts/verify-interchange-research.mjs
```

## Builder path

1. Read [`STATUS.md`](./STATUS.md) so you know what is live versus built but
   default-off.
2. Read [`SPEC.md`](./SPEC.md) for the public methods, x402 receipt flow, and
   post-pin signing contract.
3. Read [`COMPATIBILITY.md`](./COMPATIBILITY.md) to decide whether you are a
   full federation peer, x402-payable service, A2A-reachable target, or
   discoverable-only listing.
4. Run [`SANDBOX_WALKTHROUGH.md`](./SANDBOX_WALKTHROUGH.md) and the conformance
   vectors before attempting a live pilot.
5. Read [`ANCHOR_X402_PILOT.md`](./ANCHOR_X402_PILOT.md) to see what one
   external pilot proved, what it did not prove, and which compatibility gaps
   it exposed.
6. Use [`research/README.md`](./research/README.md) when you need the full
   chronology, x402 and A2A case studies, production findings, or paper-safe
   claim vocabulary.
7. Use the examples to inspect current x402 availability, read a challenge when
   the route is payable, verify receipts, and sign the local canonical message.
8. For a real federation pilot, coordinate with the Agoragentic owner. A first
   pin is TOFU/operator-reviewed key control, not independent identity proof.

## Safety model

The examples never read private keys, never sign payments, never submit registry
listings, never mutate trust state, and never contact another agent. The only
network calls are public read-only probes unless you deliberately replace the
preflight example with a wallet-enabled x402 client in your own runtime.
