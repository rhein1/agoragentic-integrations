# anchor-x402 External-Adopter Starter Pack

This directory is a clean-room, Apache-2.0 starter pack for an independently
operated `anchor-x402` run of the Agoragentic Transaction Assurance conformance
suite. Agoragentic authored the starter. It does not become external-adopter
evidence until the anchor-x402 operator reviews it, commits it in an
operator-controlled repository, runs it there against an immutable suite
commit, and publishes the bounded artifacts plus actionable observations.

No source was copied from `chico10117/basepay-readiness-service`; its public
repository exposed no license when this starter was authored on 2026-08-11.
This pack does not call that service or any anchor-x402 endpoint.

## What the target evaluates

`target.mjs` is a self-contained policy evaluator for the suite's normalized,
bounded evidence contract. It covers authority, commercial terms, limits,
payment identity, settlement, execution, outcome validation, reconciliation,
and privacy decisions. It intentionally does not:

- parse AP2, TAP, ACP, or x402 wire payloads;
- verify protocol or wallet signatures;
- make network requests;
- read environment variables or secrets;
- call providers or execute tools;
- authorize or move funds; or
- claim live or production compatibility.

The protocol IDs in the normalized inputs identify the suite's pinned source
vocabulary. Accepting those normalized inputs does not claim that anchor-x402
implements each wire protocol.

## Independent run

1. Copy this directory into an anchor-x402-controlled Git repository.
2. Review `profile.v1.json` and `target.mjs` against the operator's actual
   policy. Change them if needed; do not report an unreviewed starter as the
   operator's implementation.
3. Commit the reviewed files. The runner refuses dirty or untracked pack files.
4. Check out `rhein1/agoragentic-integrations` at the exact suite commit supplied
   by Agoragentic. Source retrieval is preparation; the conformance run itself
   is offline.
5. From the operator repository, run one command:

```text
node path/to/anchor-x402/run.mjs --suite-root path/to/agoragentic-integrations/transaction-assurance --suite-commit <40-character-suite-commit>
```

The runner derives the target commit from the operator repository, verifies the
suite checkout commit, checks that the pack is tracked and clean, confines its
output to the operator repository, and writes:

- `artifacts/agoragentic-transaction-assurance/report.json`
- `artifacts/agoragentic-transaction-assurance/junit.xml`
- `artifacts/agoragentic-transaction-assurance/receipt.json`
- `artifacts/agoragentic-transaction-assurance/adopter-context.json`

The operator should review the files for public safety, verify the receipt with
the public verifier, and publish the exact target commit, counts, report and
receipt hashes, and at least one actionable observation. A passing run is not
certification, endorsement, live-settlement proof, or production validation.

## Reusable workflow

After copying `target.mjs` into the operator repository, the existing reusable
workflow can run the same target without secrets:

```yaml
jobs:
  transaction-assurance:
    uses: rhein1/agoragentic-integrations/.github/workflows/transaction-assurance-conformance.yml@<SUITE_COMMIT>
    with:
      suite-ref: <SUITE_COMMIT>
      target-module: path/to/anchor-x402/target.mjs
      target-name: anchor-x402-normalized-policy-adapter
      target-version: 0.1.0
      target-commit: ${{ github.sha }}
```

The workflow and local runner execute the target in-process. They do not claim
to sandbox arbitrary target code; the reviewed target source is part of the
evidence boundary.
