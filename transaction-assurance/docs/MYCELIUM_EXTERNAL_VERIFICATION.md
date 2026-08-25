# Mycelium External Verification

This adapter treats Mycelium as an optional external evidence source. It does not make Mycelium, Argentum, a hosted provider, or an RPC endpoint part of Agoragentic's authority, payment, delivery, or reconciliation path.

```text
Mycelium action reference
  -> deterministic correlation value

AnchorRegistry event
  -> external timestamp and event-inclusion evidence

Agoragentic Transaction Assurance
  -> decides what that evidence means for a particular transaction
```

The implementation is local and no-network. It does not submit transactions, call a hosted Argentum API, contact an RPC endpoint, move money, execute providers, or mutate trust. A host may supply a separately reviewed synchronous verifier callback that fetches public chain facts. The adapter interprets those facts and retains only bounded references, hashes, timestamps, checks, and public event metadata.

## Exact source pins

### Action-reference profile

| Field | Pin |
| --- | --- |
| Agoragentic profile | `mycelium-action-ref-v1.0` |
| Mycelium derivation | v1, bare lowercase SHA-256 digest |
| Immutable revision | `giskard09/argentum-core@2935c328177dca9f042fa1b910f5237ffe71da9e` |
| Upstream tag containing the pinned v1 behavior and negative vectors | `action-ref-v2.0` |
| Spec SHA-256 | `c893d29e8d992e88442eccdde502e22edda0c20a580d391c56af988642452554` |
| Upstream positive-vector SHA-256 | `b6604d03c3f119224b594135d651eb74b205770cc276c46acd95dd800feb9050` |
| Upstream negative-vector SHA-256 | `eae765de97298e2d086c41867922b7a6fe14eee4fd7efa572257658ce6876de9` |
| Canonicalization | flat ASCII-string profile of JCS/RFC 8785 |
| Timestamp | `YYYY-MM-DDTHH:MM:SS.mmmZ` |
| Hash | SHA-256 over canonical UTF-8 bytes |
| Domain separation | none |

The revision is the additive v2 tag because it is the first immutable upstream revision containing the clarified v1 domain rules and executable positive and negative v1 vectors. This adapter implements only the v1 derivation. It rejects v2 values and every unqualified or unsupported profile.

The upstream guarantee-model document also contains an older concatenation plus integer-timestamp construction. That construction is not byte-compatible with the pinned JCS profile and is not accepted here.

The v1 derivation has no protocol domain tag. A matching v1 digest proves reproduction of the pinned four-field preimage recipe, not global uniqueness across unrelated protocols that deliberately hash the same bytes. `domain_separation: "none"` and `limitations: ["no_protocol_domain_separation"]` remain explicit in every normalized result.

### AnchorRegistry profile

| Field | Pin |
| --- | --- |
| Agoragentic profile | `mycelium-anchor-registry-v1` |
| Immutable revision | `giskard09/giskard-payments@cd8100e63d17882ba11843882acaf5b1e069fdce` |
| Source SHA-256 | `82437f6f5ba3952a2c7ac34700e82c03bc819662687a2d23f7cfce72aee903a0` |
| Chains | Base `8453`, Arbitrum One `42161`, Ink `57073` |
| Registry | `0x49fEcA52bC634a9Ab773226D16619deC547794aa` |
| Runtime-code SHA-256 | `e2f5675b490dbb4211cfbeb89a8e8913a2215843c91c33ced8f46935b83d82ed` |
| Call selector | `0xeecdf927` for `anchor(bytes32)` |
| Event topic | `0xfe2289542f7a0110ac112c3a4d712afdcaaf2900a1326f4e6f340b563a0e8734` for `Anchored(bytes32,address,uint256)` |
| Minimum finality policy | 12 confirmations |

The contract has no owner, funds, role, or privileged write path. Re-anchoring is allowed. A verified event therefore proves neither uniqueness nor single execution.

## Public API

```javascript
import {
  bindExternalVerification,
  normalizeAnchorEvidence,
  normalizeExternalActionReference,
  verifyAnchorEvidence,
  verifyExternalActionReferencePreimage,
} from '@agoragentic/transaction-assurance/external-verification-adapters';
```

### Recompute an action reference

```javascript
const normalized = normalizeExternalActionReference({
  profile: 'mycelium-action-ref-v1.0',
  value: 'f4ebda732e3c063bdd8547c734e4956f009bbed7f557cb949f7c8033e8c42d1d',
});

const checked = verifyExternalActionReferencePreimage(normalized, {
  agent_id: 'giskard-self',
  action_type: 'trail.anchor',
  scope: 'mycelium:baseline',
  timestamp: '2026-05-23T00:00:00.000Z',
});

// checked.recomputation === 'match'
```

The output retains a preimage hash, not the raw preimage. Wrong timestamp precision, non-ASCII fields, extra preimage keys, uppercase digest encoding, an unsupported profile, or a mismatched canonical digest fails closed or returns `recomputation: "mismatch"`. A matching result also carries a process-local recomputation marker; serialized caller JSON cannot recreate it.

### Verify an external anchor

First normalize the expected public evidence reference:

```javascript
const evidence = normalizeAnchorEvidence({
  profile: 'mycelium-anchor-registry-v1',
  action_reference_profile: 'mycelium-action-ref-v1.0',
  action_reference: 'd0f0a32e5290e0e71efc9265d86fe517db80f1c209ddff5106b9f69ba3c181db',
  chain_id: 'eip155:8453',
  registry_address: '0x49fEcA52bC634a9Ab773226D16619deC547794aa',
  transaction_hash: '0xf00a5317e47d4f4d581eb16bf08b64dde45944706c615299c334f8082562f184',
  block_number: '48936665',
  log_index: 71,
});
```

Then pass a host-controlled synchronous verifier. Its callback returns raw public observation facts, not pass/fail booleans. The adapter independently checks:

```text
allowlisted chain
+ allowlisted registry
+ pinned runtime-code hash
+ successful receipt
+ exact target contract
+ exact anchor(bytes32) selector and calldata reference
+ exact Anchored event topic and reference
+ selected transaction, block, block hash, and log index
+ non-removed event
+ event timestamp equal to the observed block timestamp
+ at least 12 confirmations
```

The callback result schema is `agoragentic.external-anchor-verifier-observation.v1`. It contains the observed chain, registry, runtime bytecode, transaction status/target/input, block facts, a bounded event array, current head block, verifier/evidence references, and checked timestamp. The callback object itself never enters a portable envelope. Unknown callback fields, a Promise result, a mismatched verifier ID, or caller-supplied portable verifier JSON is rejected.

Every checked result is process-bound through a non-serializable trust marker. Serializing and parsing it preserves useful evidence but cannot preserve the trusted callback boundary required to bind it into an assurance envelope. Objects labeled as already normalized are revalidated against the pinned source revision, chain, and registry allowlists rather than trusted by schema tag.

## Binding to Transaction Assurance

```javascript
const bound = bindExternalVerification(envelope, anchorResult, {
  actionReference: checked,
});
```

Binding adds the sibling `external_action_refs` array and the separate `external_verification` state. It does not reinterpret, replace, or remove an existing `authenticated_action_ref` field.

A `checked_match` binding requires both:

1. an action reference whose pinned preimage recomputation is `match` and still carries its live process-local recomputation binding; and
2. an anchor result that still carries its live process-local verifier binding.

The operation recomputes the transaction-assurance envelope hash and preserves any existing trusted authority binding. It does not change:

- principal or agent authority;
- payment or settlement status;
- execution status;
- delivery or outcome verification;
- reconciliation, refund, or dispute state;
- `complete_chain_verified`;
- spend, execution, deployment, publication, or trust authority.

An anchor result reports only:

```json
{
  "proves": [
    "reference_anchored",
    "public_block_timestamp",
    "event_inclusion"
  ],
  "does_not_prove": [
    "principal_authority",
    "execution_correctness",
    "delivery",
    "settlement",
    "single_execution"
  ]
}
```

Delivery can verify with external anchoring still `not_checked`. An anchor can verify while delivery remains unobserved. Those states are intentionally independent.

## Fixture claim boundary

`mycelium-action-ref-v1.vectors.json` reproduces one upstream v1 vector and adds adversarial profile, encoding, timestamp, and domain cases.

`mycelium-anchor-registry-v1.vectors.json` contains:

- public facts independently refetched for the cited Base transaction `0xf00a5317...f184`;
- a clearly labeled synthetic event used only to test binding the known v1 action-reference fixture;
- mutations for wrong chain, registry, code, receipt status, call data, event, block/log, and finality.

The cited real Base transaction publishes reference `d0f0a32e...181db`, but the reviewed public source does not publish its four-field action-reference preimage. The real transaction fixture therefore proves only the AnchorRegistry verification path. It is not represented as a verified Mycelium preimage binding.

## Later phases deliberately excluded

No write-side anchor client is included. A future writer would require separate review, owner authorization, privacy analysis, idempotency, selective or Merkle-batched anchoring, custody policy, gas budgeting, and a real external adopter need.

This adapter does not support Argentum karma, ARGT, Lightning attestations, genesis-attestor trust, hosted Mycelium accounts, or hosted verification APIs.

## Attribution

The action-reference concept and conformance values are derived from `giskard09/argentum-core` under Apache-2.0. The AnchorRegistry source is from `giskard09/giskard-payments` and declares MIT licensing. Agoragentic's implementation is independent and pins the exact upstream revisions and hashes above.
