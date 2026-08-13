# Transaction Assurance Conformance Suite

The Transaction Assurance conformance suite is an offline, deterministic test contract for wallets, agents, payment rails, merchants, APIs, MCP servers, and marketplaces. It is source-only alpha infrastructure and does not require an Agoragentic account.

## What it evaluates

The language-neutral vector input records bounded booleans and states for authority, terms, limits, payment identity, settlement, execution, outcome validation, reconciliation, and privacy. It intentionally cannot carry prompts, tool output, credentials, private keys, payment payloads, or private owner data.

The manifest pins four existing protocol adapters:

| Adapter | Version | Source pin |
| --- | --- | --- |
| Google AP2 | `v0.2.0` | `b4587ac1d055888a73b4b21750973cffba961793` |
| Visa Trusted Agent Protocol | `commit-16d59bdf` | `16d59bdf3f8a542bc538d0962edbb80ea30a02af` |
| official OpenAI/Stripe Agentic Commerce Protocol | `2026-04-17` | `7fdd78df677a94dce04c770644b0fbbb1401272b` |
| x402 | `2.21.0` | `34cb6bd04c88f4333f56b9c778d3d35df997379c` |

These pins bind conformance vocabulary to the package adapters. The suite does not verify protocol signatures or claim provider endorsement.

## Target module contract

A target module exports one function:

```javascript
export async function evaluateTransactionAssuranceVector({ vector, input }) {
  return {
    decision: 'pass', // pass | deny | review
    code: 'complete_chain_verified',
  };
}
```

The runner rejects extra result fields. It compares the target's exact decision and code with each vector's expected result. Target code runs in the caller's Node process; the suite does not sandbox it or prove that it avoided network or secret access.

`pass` is a profile-scoped clean terminal decision, not a synonym for successful
delivery. Callers must inspect the result code. `complete_chain_verified` means
the paid execution and delivered outcome were verified;
`reconciled_refunded` means payment was cleanly reversed; and
`reconciled_dispute_resolved` means the dispute reached an explicit terminal
resolution. The latter two do not claim that the buyer received the originally
purchased outcome.

Reference modules are included for:

- an x402 resource server;
- an MCP paid tool;
- an agent wallet policy;
- a marketplace listing.

They demonstrate the interface only. Their passing results are not third-party evidence.

## External-adopter starter packs

The [`anchor-x402` starter pack](./examples/external-adopters/anchor-x402/README.md)
provides a clean-room normalized-policy target and an offline runner that binds
both the suite and target to exact Git commits. Agoragentic authored the starter;
it is not external evidence until the independent operator reviews and commits
the target in its own repository, runs it, and publishes the bounded artifacts
plus actionable observations. The pack makes no network, payment, signature,
live-settlement, or production-compatibility claim.

The first independent run is published in the
[`hypeprinter007-stack/anchor-x402-agoragentic-adopter`](https://github.com/hypeprinter007-stack/anchor-x402-agoragentic-adopter)
repository. Its signed target commit is
`13d6d70bb69cac2993753a22d423870bdfebe9a5`; artifacts are committed at
`49634dd327eed9d3e03b5a51f510d15f04794c8a`; and the artifacts bind suite commit
`607b3dddbc441fe52554b8842b9065e60131ae3b`. The run reports 42 passed and 0
failed, a publicly verifiable receipt, no suite network use, and no spend
authority. Its two actionable contract-clarity observations are recorded in
[PR #297](https://github.com/rhein1/agoragentic-integrations/pull/297#issuecomment-5270120165).

## Reports and receipts

The JSON report contains every bounded result and hashes of the manifest, vector set, and materialized inputs. JUnit output has stable names and zero timing noise. The receipt binds:

- suite and target versions;
- target commit;
- manifest and vector-set hashes;
- report hash;
- pass/fail counts;
- profiles and pinned adapters tested;
- per-test input, expected-result, and actual-result hashes;
- explicit exclusions and the claim boundary.

The public verifier recomputes the receipt from the local manifest, vectors, and report. It does not call Agoragentic or any protocol provider.

## Reusable GitHub workflow

Pin the workflow to a reviewed commit, never a floating branch:

```yaml
jobs:
  transaction-assurance:
    uses: rhein1/agoragentic-integrations/.github/workflows/transaction-assurance-conformance.yml@<SUITE_COMMIT>
    with:
      suite-ref: <SUITE_COMMIT>
      target-module: path/to/transaction-assurance-target.mjs
      target-name: my-target
      target-version: 1.0.0
      target-commit: ${{ github.sha }}
```

The called workflow checks out the caller repository and the pinned suite separately, grants only `contents: read`, runs with no secrets, and uploads the JSON, JUnit, and receipt artifacts. A green workflow proves only conformance to the pinned vectors.

## Allowed claim

> Passed Agoragentic Transaction Assurance Conformance Suite `<version>` for profile `<profile>` at commit `<sha>`.

It may not be described as certified safe, universally trusted, fraud-proof, legally comprehensive, endorsed by Agoragentic or a protocol provider, or proof of live settlement or production compatibility.

The independent run supplies the first external-adopter evidence required for
maintainer review of this offline alpha. It produced two actionable
contract-clarity findings but zero failed vectors; maintainers must decide
whether that satisfies issue #246's literal "actionable failures" wording. It
does not authorize package publication, public catalog inclusion, an
ecosystem-standard claim, or any live compatibility claim.
