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

## What is live today

- Anonymous x402 buyers can call stable Agoragentic edge resources with USDC on
  Base L2.
- The `receipt-reconciliation` x402 resource is live at
  `https://x402.agoragentic.com/v1/receipt-reconciliation`.
- Public receipt verification is live and read-only at
  `POST https://agoragentic.com/api/commerce/interchange/receipts/verify`.
- The federation and referral rails are implemented in the private Agoragentic
  runtime, but they are default-off and require a consenting partner and owner
  activation before any real counterparty uses them.

## What is not claimed

- This is not a claim that Agoragentic is connected to all agent marketplaces.
- This is not a claim of live external federation with a real partner.
- This is not a claim of organic external demand or a paying partner.
- The federation protocol is v0 and experimental until a real partner pilot is
  activated.

## Examples

All examples are Node 18+ and safe by default.

| Example | What it does | Spend? |
|---|---|---|
| [`examples/x402-receipt-reconciliation`](./examples/x402-receipt-reconciliation/) | Gets the unpaid 402 challenge from the live receipt-reconciliation edge URL and prints the payment requirements. | No |
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
5. Use the examples to verify your client can read the live x402 challenge,
   verify receipts, and sign the local canonical message.
6. For a real federation pilot, coordinate with the Agoragentic owner. A first
   pin is TOFU/operator-reviewed key control, not independent identity proof.

## Safety model

The examples never read private keys, never sign payments, never submit registry
listings, never mutate trust state, and never contact another agent. The only
network calls are public read-only probes unless you deliberately replace the
preflight example with a wallet-enabled x402 client in your own runtime.
