# Quality and security evaluation adapters

Harness Core can normalize external design and security findings into the optional `evaluations` section of an `agoragentic.harness.local-receipt.v1` receipt.

Supported inputs:

- Impeccable `3.5.0` JSON findings at source revision `5d10bc842cbccd2ae7d3a88296d87d3be0b125b3`;
- SARIF `2.1.0` reports from tools that identify their name and version in `tool.driver`.

The adapter code is original Agoragentic code. It does not copy Impeccable skill text, detector code, or scanner output. Impeccable is Apache-2.0 licensed at the pinned source revision. SARIF is an OASIS standard. No Impeccable, Trail of Bits, scanner-vendor, or OASIS endorsement is claimed.

## Run the external tool separately

The parser never installs or invokes a scanner. Produce the report with the external tool under its own documented policy, then pass the JSON into Harness Core. For the pinned Impeccable CLI shape:

```bash
npx --package impeccable@3.5.0 impeccable detect --json src > impeccable-findings.json
```

Impeccable omits inline-ignored findings from its normal JSON output. A wrapper that audits suppressions may provide those original finding records under `suppressed_findings`; Harness retains them with `status: "suppressed"`. It never invents suppressed findings that were not supplied.

## Normalize and attach

```js
import { readFile } from 'node:fs/promises';
import {
  attachEvaluationEvidenceToReceipt,
  normalizeImpeccableFindings,
} from 'agoragentic-harness-core/evaluations';

const report = JSON.parse(await readFile('impeccable-findings.json', 'utf8'));
const receipt = JSON.parse(await readFile('.agoragentic/local-receipt.json', 'utf8'));

const evaluation = normalizeImpeccableFindings(report, {
  producer_version: '3.5.0',
  source_revision: '5d10bc842cbccd2ae7d3a88296d87d3be0b125b3',
  analyzed_revision: '0123456789abcdef0123456789abcdef01234567',
  source_ref: 'impeccable-findings.json',
  gate: {
    block_severities: ['critical', 'high'],
    review_severities: ['medium'],
    fail_on_advisory: false,
  },
});

const updated = attachEvaluationEvidenceToReceipt(receipt, evaluation);
```

Use `normalizeSarifReport(report, options)` for SARIF. Unsupported Impeccable revisions and unsupported SARIF versions fail closed.

## Evidence and privacy boundary

The normalized record retains:

- producer and adapter version;
- analyzed revision;
- hashes of the source reference and complete input report;
- finding rule, severity, advisory/suppression state, hashed location reference, and hashed message;
- configured gate, deterministic result, counts, and evidence hash.

It deliberately excludes raw source paths, messages, snippets, prompts, tool output, credentials, and scanner-private payloads. Suppressed findings remain countable and reviewable through their rule, severity, status, and hashes.

A `pass` means only that the supplied report did not cross the configured gate. It does not mean the scanner ran correctly, the findings are accurate, the analyzed revision is complete, vulnerabilities are absent, or the artifact is certified. A `fail` blocks the local receipt and therefore the existing Harness listing-readiness proposal. It does not deploy, publish, spend, call a provider, mutate trust, or bypass owner review.
