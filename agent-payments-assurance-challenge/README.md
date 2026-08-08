# Autonomous Agent Payments Assurance Challenge

An unpublished, offline alpha conformance challenge for structured autonomous-agent payment-assurance run records.

The scorer checks whether a self-attested run record matches a fixed scenario contract. It does not execute or observe an agent, independently verify the submitted safety declarations or evidence labels, invoke Transaction Assurance, certify production readiness, or prove that an economic action was safe.

```text
versioned scenario contract
-> bounded self-attested run record
-> deterministic conformance score
-> challenge, run, and report hashes
```

## Safety boundary

The scorer and reference fixtures are local-only. They do not call a network, payment rail, provider, wallet, or marketplace; move or simulate real funds; read credentials; grant authority; deploy; publish; or mutate trust.

The input schemas do not support raw prompts, tool outputs, payment payloads, credentials, wallet material, or owner context. Observation fields contain bounded vocabulary labels only. This structural restriction is not a content classifier: identifiers, labels, and hashes can still be sensitive or identifying.

Every report therefore declares:

- `public_safe: false`;
- `publication_review_required: true`;
- `safety_declarations_independently_verified: false`;
- all spend, deploy, publish, and trust authority flags as `false`.

Do not publish a run or report without a separate privacy review and pseudonymous metadata.

## Tracks

1. Principal-authority adherence.
2. Quote and terms integrity.
3. Paid retry and idempotency safety.
4. Delivery verification.
5. Outcome-quality handling.
6. Refund and dispute reconciliation.
7. Cross-market evidence binding.
8. Declared secret, authority, and no-funds boundaries.

## Run locally

Node.js 20 or newer is required. No dependency install is needed.

```bash
npm run check
node --test test/scorer.test.mjs
npm run self-test
npm run pack:dry
```

Score another record against the packaged challenge:

```bash
node bin/score-run.mjs path/to/run.json
```

The CLI writes a JSON report to standard output. It exits `0` only for a structurally valid run whose scenarios all pass; a valid non-passing run exits `1`; usage errors exit `2`.

## Run contract

The run must validate against [`schema/run-record.v1.json`](./schema/run-record.v1.json) and contain exactly one result for every challenge scenario. Duplicate keys, duplicate or unknown scenario IDs, missing safety booleans, extra fields, malformed labels, stale challenge hashes, and JSON files larger than 1 MiB are rejected.

Each run includes bounded metadata for the agent, harness, model, and policy:

```json
{
  "id": "pseudonymous-component-id",
  "version": "1",
  "configuration_hash": "sha256:..."
}
```

Model metadata also requires a bounded `provider` token. Configuration hashes support comparison; they do not prove configuration provenance or authenticity.

The `signals`, `evidence`, and `next_safe_actions` arrays contain vocabulary labels, not evidence payloads. The three safety booleans are required declarations. Setting them to `false` means the submitter declared that boundary was preserved; the scorer cannot establish that the declaration is true.

## Integrity and verification

`challenge_manifest_hash` is the SHA-256 reference of canonical JSON for the complete challenge object. The scorer rejects a run whose declared challenge hash does not match. Reports include hashes of the complete validated challenge and run, then a hash over the complete report body.

Use the verifier to recompute the expected report and compare every field:

```js
import {
  readJson,
  scoreChallengeRun,
  verifyChallengeReport,
} from './src/scorer.mjs';

const challenge = await readJson('./scenarios/challenge-v1.json');
const run = await readJson('./path/to/run.json');
const report = scoreChallengeRun(challenge, run);
const verification = verifyChallengeReport(challenge, run, report);
```

`report_integrity_verified: true` establishes deterministic integrity against those supplied inputs. It is not a digital signature, principal attestation, independent execution observation, settlement proof, or grant of authority.

## Transaction Assurance relationship

The sibling `@agoragentic/transaction-assurance` alpha defines the actual envelope, blockers, and state vocabulary (`incomplete`, `authority_ready`, `payment_pending`, `payment_observed`, `execution_observed`, `outcome_verified`, `reconciled`, `failed`, `refunded`, and `disputed`).

This challenge's scenario signal and evidence labels are challenge-local test vocabulary. They are conceptually informed by those assurance boundaries but are not claimed to be exact Transaction Assurance outputs. The scorer does not import, execute, or verify a Transaction Assurance envelope, and every report sets `transaction_assurance_evaluated: false`.

## Claim boundary

A passing report means only that the supplied structured record conformed to this published answer contract and declared all three safety booleans `false`. Because the scenarios and reference answer are visible and the observations are self-attested, a pass is not evidence that an agent actually produced the record or behaved safely.

There is no leaderboard, certification, external harness evidence, publication approval, live-rail evidence, settlement proof, marketplace verification, universal-safety claim, or production dependency in this alpha.

## Machine contracts

- Challenge: [`schema/challenge.v1.json`](./schema/challenge.v1.json)
- Run record: [`schema/run-record.v1.json`](./schema/run-record.v1.json)
- Report: [`schema/report.v1.json`](./schema/report.v1.json)
- Scenario pack: [`scenarios/challenge-v1.json`](./scenarios/challenge-v1.json)
- Safe fixture: [`examples/reference-safe-run.json`](./examples/reference-safe-run.json)
- Non-passing fixture: [`examples/reference-unsafe-run.json`](./examples/reference-unsafe-run.json)

The package remains private and excluded from the canonical integration inventory under the time-bounded hold recorded in the repository root `integrations.json`.
