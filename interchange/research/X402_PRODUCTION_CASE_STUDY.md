# x402 Production Case Study

## Question

Can an agent transaction remain governed from intent through receipt while the
buyer pays per request with USDC on Base through x402, and can the system keep
agent identity, payer wallet, settlement proof, and principal authority
distinct?

The production work answered the mechanism question positively under recruited
and first-party tests. It did not establish organic demand, repeat purchasing,
or retained external revenue.

## Architecture under test

The Interchange combines:

- a capability card and quote;
- a mandate and explicit payment method;
- the 12-state plan lifecycle from `DISCOVERED` to `RECONCILED`;
- x402 challenge, signed retry, and facilitator settlement;
- Arbiter review before or around the paid execution path;
- binding of buyer agent, payer wallet, capability, amount, network, transaction,
  invocation, and receipt; and
- a signed, tamper-evident receipt plus reconciliation evidence.

The payment rail is not allowed to become the authority model. An authenticated
agent remains the buyer principal; the x402 wallet is recorded as the payment
source.

## Experiment 1: outbound x402 rail to an external seller

On 2026-06-14, an Agoragentic-controlled canary wallet paid a real external x402
seller on Base mainnet:

- transaction:
  [`0x9b01...7d44`](https://basescan.org/tx/0x9b01b4b465e1a764182f796095923fb341608175b01752d6b80631b779bb7d44);
- block: `47332693`;
- timestamp: `2026-06-14T16:32:13Z`;
- asset: Base USDC at `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`;
- buyer: `0xdfEef7b41F2F677122899F55Df45a6D708386C8A`;
- external seller: `0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea`;
- amount: `5000` atomic units, or `0.005 USDC`; and
- receipt: `areceipt2_cda8e8e43db65a3975d3d597`.

The Base receipt has status `0x1`, and the USDC `Transfer` log contains the
buyer, external seller, and `0x1388` amount. [PR #672](https://github.com/rhein1/agent-marketplace/pull/672)
records the implementation and contemporaneous scope.

### Honest result

This proved that the outbound external-seller rail could settle. It did not
prove external buyer demand because Agoragentic controlled the buyer wallet.
The Interchange receipt was unsigned because the out-of-process canary lacked
the dedicated receipt-signing key. The hardened verifier therefore rejected the
receipt, correctly leaving the immutable chain transaction as the durable proof
for that run. Later code refused to spend when a canary would mint an unsigned
receipt.

## Experiment 2: recruited buyer, owner-seeded internal balance

A separately operated external agent completed the full governed lifecycle with
a first-party capability using an owner-seeded internal balance. The resulting
receipt was signed, recomputed, and verified through `RECONCILED`.

The run found two payment-path bugs:

1. payment preparation required an internal balance even when the declared
   method was x402-per-request; and
2. an authenticated x402 invocation was attributed to a provisional wallet
   identity rather than the mandate's buyer agent.

[PR #991](https://github.com/rhein1/agent-marketplace/pull/991) deferred the
balance check for x402-per-request until actual charge time while retaining the
internal-balance gate for internal-balance plans. [PR #996](https://github.com/rhein1/agent-marketplace/pull/996)
kept the authenticated agent as `buyer_id` and recorded the wallet separately as
`payer_wallet`.

### Honest result

This was external interoperability and a complete governed lifecycle, but not
external money or revenue. The owner seeded the balance, the counterparty was
recruited, and the first-party seller meant the economic loop returned to the
platform.

## Experiment 3: recruited buyer's own wallet and modern CAIP-2 client

The original stable x402 edge emitted the historical `base` network token. A
current EVM x402 client expected the CAIP-2 network identifier `eip155:8453`.
Mixing both dialects in one `accepts[]` array risked breaking one client family,
so the platform shipped two isolated endpoints:

- `/v1/{slug}`: exactly one `accepts[]` entry using `base`; and
- `/v1-caip2/{slug}`: exactly one entry using `eip155:8453`.

The CAIP-2 path was initially gated, then wired through the same Arbiter and CORS
policy before being advertised. A recruited independent buyer then used an
unmodified modern EVM client and its own wallet.

### Immutable settlement evidence

- transaction:
  [`0x705c...6e95`](https://basescan.org/tx/0x705c7a146774289c9e26aea991eac31c82bede037f497b4994bf3d32bbcc6e95);
- block: `48548710`;
- timestamp: `2026-07-12T20:06:07Z`;
- transaction status: `0x1`;
- USDC contract: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`;
- buyer wallet: `0x7818cB9cEad1E13E64A259F0867089dB75E374c5`;
- platform settlement wallet at the time:
  `0xadB33740Ac38c8F6721100Ff813ab91d958670BC`;
- amount: `10000` atomic units, or `0.01 USDC`;
- facilitator/relayer transaction sender:
  `0x4c934c63c786157fefd990945b25ea60a0fb0205`; and
- transaction input selector: `0xe3ee160e`, consistent with the EIP-3009
  authorization flow used by the facilitator.

The USDC `Transfer` event, not the relayer's transaction sender, identifies the
economic source and destination. A Base JSON-RPC recheck on 2026-08-14 reproduced
the status, block, timestamp, wallet topics, and `0x2710` amount.

### Honest result

This proves that a recruited external operator's current, unmodified EVM x402
client could complete the CAIP-2 payment and move its own USDC on-chain. The
governed plan reached reconciliation with signed receipt evidence according to
the production operator record. It remains a recruited pilot, not organic
demand. Test funds were subsequently handled as pilot funds rather than counted
as revenue; the public research package does not assert retained revenue from
this transaction.

## Money-safety failures found during production work

### Challenge and schema compatibility

- early A2A and x402 discovery documents were not valid for standard clients;
- the x402 challenge shape was corrected to canonical `PaymentRequirements`;
- CAIP-2 and historical Base dialects required isolated endpoints; and
- the CAIP-2 route initially bypassed Arbiter/CORS wiring.

### Receipt and settlement evidence

- an unsigned out-of-process receipt had been described too strongly;
- the verifier needed a dedicated signing-key source and reject-on-missing
  signature behavior;
- settlement transaction hashes were absent from public receipt payloads;
- external settlement uniqueness needed the on-chain transaction hash; and
- application-level `settlement_final` was not sufficient without independent
  chain verification.

### Idempotency and charge safety

- seller payout retry behavior could duplicate or orphan effects;
- invoke retry behavior could charge more than once;
- PostgreSQL execution errors needed to fail closed; and
- eligibility claims needed an atomic reservation.

### Identity and authority

- payment preparation conflated internal-balance funding with x402-per-request;
- the paying wallet temporarily replaced authenticated agent identity;
- reserved-wallet use lacked a principal authority grant; and
- authenticated x402 settlement required explicit principal-bound authority.

### Secrets and custody

- onboarding responses duplicated a live API key inside innocent-looking command
  and SDK example fields;
- the configured AWS private key derived to a different, empty wallet than the
  wallet holding settlement funds;
- contract ownership and runtime RPC assumptions had drifted; and
- paid discovery remained visible when custody was intentionally frozen.

The response was fail-closed: add signer address equality, an authoritative
custody freeze, a managed CDP signer, explicit contract ownership, a bounded
control canary, and discovery behavior that returns
`platform_custody_frozen` without issuing a challenge.

## Current availability snapshot

At `2026-08-14T20:00Z`:

- platform custody was authoritatively frozen;
- outbound money was disabled;
- the CDP signer was ready and its derived address matched the declared V2
  treasury;
- both `/v1/text-summarizer` and `/v1-caip2/text-summarizer` returned
  `503 platform_custody_frozen`;
- neither probe issued a payment challenge or settled a payment; and
- read-only receipt verification and Interchange discovery remained available.

Therefore the defensible status is: **historically settled and externally
interoperable; currently unavailable for new paid execution under the custody
freeze.**

## Reproduce the immutable evidence

Use any Base mainnet JSON-RPC provider:

```json
{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionReceipt","params":["0x705c7a146774289c9e26aea991eac31c82bede037f497b4994bf3d32bbcc6e95"]}
```

Check:

1. `status == 0x1`;
2. `blockNumber == 0x2e4cb66`;
3. a log from the Base USDC contract with the ERC-20 `Transfer` topic;
4. indexed `from` and `to` topics matching the buyer and settlement wallets; and
5. data ending in `2710`, or 10,000 atomic USDC units.

The chain receipt proves transfer and final inclusion. It does not, by itself,
prove the buyer's application identity, mandate, policy, or receipt signature;
those require the separately bound Interchange evidence.
