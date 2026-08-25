# MatrAIx Cohort Assurance Adapter — Codex Work Pack

Status: draft implementation scaffold
Repository: `rhein1/agoragentic-integrations`
Branch: `codex/matraix-cohort-assurance-adapter`
Upstream project: `MatrAIx-ai/MatrAIx-Persona-8B`
Audited upstream pin: `68f5faf4eed9a4f48513ca3ea4f22ee0f6b14c82`
Public readiness: false
External compatibility claim: false

## Goal

Add an experimental, source-only adapter that runs bounded MatrAIx persona cohorts against an explicitly configured Agoragentic system under test and emits a deterministic, sanitized evidence packet.

The adapter must make it possible to answer:

> How did this exact agent or listing version behave across this exact synthetic cohort, task, model configuration, and seed?

This PR must not claim that simulated persona behavior is human validation, a population estimate, customer demand, certification, or proof of safety.

## Product position

Use the product name **Agoragentic Cohort Assurance**. MatrAIx is one external simulation provider behind the capability; do not make the public contract permanently MatrAIx-specific.

The adapter provides synthetic, model-mediated, hypothesis-generating evidence. Agent OS, ECF, Arbiter, receipts, and Transaction Assurance remain authoritative for permissions, payments, execution, and receipt correctness.

## Required implementation layout

Create a focused package at:

```text
matraix-cohort-assurance/
├── README.md
├── pyproject.toml
├── UPSTREAM_LOCK.json
├── NOTICE.md
├── src/
│   └── agoragentic_matraix_assurance/
│       ├── __init__.py
│       ├── cli.py
│       ├── contracts.py
│       ├── evidence.py
│       ├── manifest.py
│       ├── redaction.py
│       ├── runner.py
│       └── target.py
├── tasks/
│   └── resolution-desk-mcp-smoke/
│       ├── README.md
│       ├── task.toml
│       ├── instruction.md
│       ├── persona_strategy.json
│       ├── reporting.json
│       └── target_config.example.json
├── fixtures/
│   ├── sanitized_trials.json
│   ├── expected_run_manifest.json
│   └── expected_evidence.json
└── tests/
    ├── test_contracts.py
    ├── test_evidence.py
    ├── test_fixture_replay.py
    ├── test_redaction.py
    ├── test_target_policy.py
    └── test_upstream_lock.py
```

Add a package-local workflow only if it follows current repository CI conventions. Do not add live provider calls, model downloads, dataset downloads, or public endpoint calls to CI.

## Upstream lock

`UPSTREAM_LOCK.json` must record at least:

```json
{
  "schema": "agoragentic.external-source-lock.v1",
  "project": "MatrAIx-ai/MatrAIx-Persona-8B",
  "commit": "68f5faf4eed9a4f48513ca3ea4f22ee0f6b14c82",
  "license": "MIT",
  "audited_at": "2026-08-14",
  "compatibility_status": "source_reviewed_not_runtime_verified",
  "partnership_claimed": false
}
```

The exact file may add immutable hashes and source paths, but must not weaken these fields.

At runtime, fail closed when the checked-out upstream revision, task files, adapter source, or expected lock digest differs from the approved manifest. Never silently follow upstream `main`.

## Command contract

Expose a bounded CLI similar to:

```bash
python -m agoragentic_matraix_assurance run \
  --task tasks/resolution-desk-mcp-smoke \
  --cohort-manifest cohort.json \
  --target-config target.json \
  --output-dir out/run-001
```

Required subcommands:

- `verify-lock`: verify the upstream revision and lock inputs without network execution.
- `validate`: validate task, cohort, target, and limits.
- `replay`: regenerate evidence from committed sanitized fixtures without model or network calls.
- `run`: execute only after all live gates pass.

Do not accept API keys, bearer tokens, cookies, wallet material, or other secrets as CLI arguments or JSON configuration values.

## Input contract

A live run must bind at least:

- exact upstream project and commit;
- adapter version and source digest;
- task identifier, task version, and task-file digest;
- dataset identifier and version or immutable manifest digest;
- exact persona IDs or a canonical cohort query digest;
- fixed seed;
- replacement policy;
- sample size;
- persona-model provider and model identifier;
- system-under-test identifier, version, and deployment or listing digest;
- transport (`mcp` initially; REST may be added only with equivalent tests);
- target origin and allowlist decision;
- maximum trials, turns, input tokens, output tokens, wall time, and external cost;
- whether the persona model and system under test share the same model backbone.

Reject unknown top-level fields in security-relevant configuration documents.

## Target policy

The initial adapter must support a narrowly configured MCP target.

Requirements:

1. Default target policy is loopback-only.
2. A non-loopback target requires an explicit allowlist entry in an owner-controlled config.
3. Credentials come from the process environment or a host-owned credential broker, never from committed config.
4. The adapter must not discover or invoke arbitrary MCP servers.
5. The adapter must not inherit a general-purpose MCP client, shell, browser, filesystem, or wallet tool surface.
6. Before every routed invocation, verify the selected capability is free and bounded.
7. Abort on a payment challenge, a nonzero quote, ambiguous price state, or route drift.
8. Do not retry an ambiguous side effect automatically.
9. Record only public-safe target metadata and hashes in the output packet.

The initial task must exercise a no-spend Resolution Desk or support-resolution path. It must not use real customer data.

## Live execution gate

Live execution must be disabled unless all of the following are true:

- an explicit live flag is present;
- upstream lock verification passes;
- task and cohort manifests validate;
- target host is allowed;
- the target capability is free;
- sample size and run limits are within policy;
- required model credentials are available through the host environment;
- output directory is empty or the caller explicitly selects a new run ID;
- no wallet, payment, deployment, publication, or trust authority is present;
- the caller acknowledges the run may incur model-provider cost.

A suggested explicit flag is `AGORAGENTIC_MATRAIX_LIVE=1`. Do not use that flag alone as authority; all other checks remain mandatory.

## Evidence output

Produce a closed packet with schema name:

```text
agoragentic.synthetic-cohort-run.v1
```

The packet must include:

- run ID and timestamps;
- exact subject/listing/deployment version binding;
- upstream, adapter, task, cohort, dataset, model, verifier, and target digests;
- fixed seed and replacement policy;
- requested, started, completed, failed, timed-out, and abandoned trial counts;
- aggregate metrics;
- model-sensitivity fields, including mandatory `same_backbone`;
- sanitized artifact digests;
- explicit limitations;
- all-false authority flags;
- no certification, human-validation, representativeness, partnership, or trust-tier claim.

Required limitations:

```json
[
  "synthetic_model_mediated_evidence",
  "not_human_validation",
  "not_population_prevalence_estimate",
  "not_customer_demand_validation",
  "not_safety_certification"
]
```

Evidence IDs and digests must be calculated from canonical serialized inputs. Do not trust IDs, metrics, pass/fail fields, or evidence hashes supplied by the persona agent or system under test.

## Metrics

Support at least:

- functional task completion rate;
- mandate-violation count and rate;
- approval correctness rate;
- unsupported-claim count and rate;
- privacy-boundary violation count and rate;
- abandonment count and rate;
- median and p95 turns;
- median and p95 latency;
- receipt-present rate;
- receipt-correctness rate;
- invalid or unverifiable trial count;
- persona-model sensitivity when multiple model backbones are compared.

Never reduce these to a single unexplained trust score.

## Privacy and redaction

The committed and public-safe packet must not contain:

- raw persona records;
- direct identifiers;
- raw sensitive attributes;
- API keys, cookies, authorization headers, or provider responses;
- full unredacted transcripts;
- customer PII;
- private ECF internals;
- wallet, quote, payment, or settlement secrets.

Private local run artifacts may contain bounded transcripts only when the operator explicitly enables them and the output location is excluded from Git. Public-safe artifacts must contain hashes, aggregate metrics, and short redacted excerpts only when necessary.

Reuse repository secret-shape detection where possible. Add adversarial tests for bearer tokens, common API-key formats, connection strings, embedded JSON secrets, and URL query credentials.

## Dataset and licensing boundary

The adapter must not bundle or redistribute the Persona 1M dataset or any other large persona source.

Requirements:

- record dataset identity, revision, source, and license/terms metadata;
- require the operator to obtain datasets from the official source;
- support an in-repo synthetic fixture cohort for CI only;
- do not claim that MIT licensing of the code overrides source-specific dataset terms;
- do not expose inferred sensitive attributes as verified facts;
- document that commercial hosted use requires source-by-source terms review.

## Tests

Required negative tests:

- upstream commit mismatch;
- missing or changed lock digest;
- changed task manifest;
- dataset-manifest mismatch;
- seed or replacement-policy drift;
- sample size above policy;
- target host not allowlisted;
- payment challenge or nonzero quote;
- missing target receipt;
- target version changed during a run;
- unknown security-relevant fields;
- caller-supplied evidence hash or metric override;
- malformed or duplicate trial IDs;
- raw transcript included in public packet;
- secret-shaped material in any public artifact;
- missing `same_backbone` field;
- missing required limitations;
- attempt to claim human validation, representativeness, certification, or partnership.

Required positive tests:

- deterministic fixture replay produces byte-identical canonical evidence;
- valid no-network fixture cohort produces the expected metrics;
- redaction preserves useful public-safe summaries while removing secrets;
- all authority flags remain false;
- package can be built and dry-packed without the upstream repository or dataset.

## Repository inventory boundary

Do not add the adapter to the public integration inventory as a verified or ready integration.

Follow the repository's current centrally owned inventory-hold mechanism. The package-local README or metadata must not grant, extend, or remove a public readiness hold. Public discovery requires a later reviewed decision after the reproducible proof PR.

## Non-goals

This PR does not:

- train or fine-tune a model;
- ship a custom Agoragentic persona model;
- host MatrAIx as a managed service;
- download models or datasets automatically;
- run external providers in CI;
- enable payments or x402;
- expose production customer data;
- mutate ranking, trust, or certification;
- publish a marketplace listing;
- claim a MatrAIx partnership;
- prove human behavior or commercial demand.

## Validation commands

Codex should add exact commands to the package README and PR body. At minimum, validation must include:

```bash
python -m pytest matraix-cohort-assurance/tests -q
python -m agoragentic_matraix_assurance verify-lock --offline-fixture
python -m agoragentic_matraix_assurance replay --fixture sanitized_trials.json
node scripts/verify-integrations-json.js
node scripts/adapter-conformance-agent.mjs --adapter matraix-cohort-assurance
```

Adapt paths to the implemented package, but preserve offline, no-network, no-spend validation.

## Merge gates

This draft is ready for review only when:

- the package and all tests exist;
- fixture replay is deterministic;
- upstream and dataset boundaries are documented;
- all negative tests pass;
- the adapter remains absent from verified public discovery;
- no live provider call, customer-data access, payment, deployment, publication, or trust mutation occurred;
- the PR body reports exact test counts and exact head SHA;
- an independent reviewer confirms the evidence packet cannot be confused with human validation.

The later reproducible-proof PR, not this adapter PR, is responsible for an owner-authorized external run.
