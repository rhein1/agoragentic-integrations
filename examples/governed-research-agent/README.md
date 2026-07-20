# Governed Research Agent: Local No-Spend Proof

This runnable example shows a complete governed research loop without a network request, provider call, API key, wallet, payment, deployment, or publication:

```text
local policy and approved notes
  -> Micro ECF policy summary and context packet
  -> zero-cost local quote
  -> deterministic cited report
  -> local receipt
  -> reconciliation checks
```

Run it with Node.js 18 or later:

```bash
node examples/governed-research-agent/run.mjs
```

The command reuses the repository's Micro ECF policy validation, policy-summary, and context-packet builders. It writes six reviewable artifacts under `examples/governed-research-agent/out/`:

- `context-packet.json`: bounded source summaries, provenance, and citations
- `policy-summary.json`: allowed/denied tools, zero budget, and product boundary
- `quote.json`: route, zero price, and policy hash
- `research-report.json`: deterministic summary and source citations
- `receipt.json`: output hash, quote hash, cost, and non-settlement state
- `reconciliation.json`: pass/fail checks plus the authority boundary

Run the focused test:

```bash
node --test examples/governed-research-agent/test/*.test.mjs
```

## What To Inspect

1. [`policy.json`](./policy.json) allows one fixture and local tools, sets the daily budget to `0`, and denies web fetch, hosted/marketplace execution, x402, wallet settlement, and provisioning.
2. [`fixtures/research-notes.json`](./fixtures/research-notes.json) is the only research input.
3. [`run.mjs`](./run.mjs) builds the Micro ECF policy/context artifacts and hashes the policy, input, quote, and output so the receipt can be reconciled without trusting hidden state.
4. The test uses a temporary output directory and asserts the no-spend boundary.

This is an offline contract example, not proof of a live Router match, hosted provider execution, x402 payment, or production settlement. To move toward a live route, use `match()` or an x402 preview first, inspect price and authority, and keep paid `execute()` behind explicit owner approval.
