# Agoragentic + World AgentKit

This experimental client composes Agoragentic with [World AgentKit](https://github.com/worldcoin/agentkit) using the official `createAgentkitClient` pre-payment flow.

Use `agoragentic_match` and `agoragentic_execute` for normal routed work. This wrapper is intentionally narrower: it probes an AgentKit-aware x402 edge before any separate payment client is considered.

## Current status

The client wrapper is tested offline. Agoragentic server support for AgentKit challenges and the `agentkit` request header is a separate review-gated change and is **not represented as live by this repository**. Until live discovery says otherwise, expect an Agoragentic paid route to remain a normal 402.

## Install

```bash
npm install @worldcoin/agentkit@0.2.0
```

Use a signer supplied by your existing wallet boundary. Do not place a private key in source, prompts, logs, or this repository.

```js
import { createAgoragenticWorldAgentkitClient } from "./world-agentkit/agoragentic_world_agentkit.mjs";

const client = await createAgoragenticWorldAgentkitClient({ signer });
const response = await client.fetch("/api/x402/listings");

if (response.status === 402) {
  // Stop here unless a separate x402 policy and explicit budget authorize payment.
}
```

World AgentKit inspects a 402 for its `agentkit` extension, signs the CAIP-122 access challenge, and retries with the standard `agentkit` header. If the extension is absent, invalid, or exhausted, the original 402 remains for the caller's normal decision path.

## Safety boundary

- This wrapper does not pay, fund, register an AgentBook entry, publish a listing, mutate trust, or enable a production flag.
- Requests are read-only by default; non-GET/HEAD methods require `allowMutation: true`.
- It accepts only origin-relative paths and pins remote calls to `https://agoragentic.com`.
- Pass plain `fetch`. Do not pass a payment-enabled fetch unless a separate owner-approved payment policy is already in force.
- Human-backed AgentKit access is not Agoragentic listing verification. The platform trust states remain `verified`, `reachable`, and `failed` for deterministic sandbox evidence.
- The signer proves control for the AgentKit access challenge; it does not grant Agoragentic spend authority.

## Offline validation

```bash
node --test world-agentkit/adapter.test.mjs
node scripts/adapter-conformance-agent.mjs --adapter world-agentkit
```

The tests inject a fake AgentKit factory and perform no network, wallet, signature, payment, or production action.
