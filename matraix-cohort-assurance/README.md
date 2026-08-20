# Agoragentic Cohort Assurance: MatrAIx source adapter

Agoragentic Cohort Assurance tests how an exact system behaves under bounded
model-generated interactions. Synthetic personas do not speak for, represent,
or replace real people or affected communities.

This package is an **unpublished compatibility alpha**. It implements the
source lock, intended-use contract, representation boundary, target policy,
redaction, deterministic fixture replay, and public-safe evidence schema for a
future MatrAIx-backed adapter. It does not contain a live MatrAIx runner.

## Current proof

- The upstream source lock identifies
  `MatrAIx-ai/MatrAIx-Persona-8B@68f5faf4eed9a4f48513ca3ea4f22ee0f6b14c82`.
- Four package-local synthetic records replay without network, models,
  credentials, datasets, customer data, or spend.
- Evidence is evaluator-derived and canonically serialized as
  `agoragentic.synthetic-cohort-run.v1`.
- Target validation is loopback-only by default, HTTPS allowlist-only when
  remote, and free-only. A 402, nonzero price, missing receipt, route drift, or
  version drift fails closed.
- Wallet, payment, execution, deployment, publication, trust mutation, and
  marketplace listing authority remain false.

The package does not prove live MatrAIx compatibility, human validity,
population representativeness, customer demand, safety certification,
partnership, marketplace readiness, or production adoption.

## Closed intended uses

Only these purposes are accepted:

- agent behavior QA;
- workflow stress testing;
- failure discovery;
- mandate compliance testing;
- model sensitivity analysis;
- UX hypothesis generation;
- accessibility hypothesis generation.

Tasks about what customers want, whether people would buy, community voice,
consent, lived experience, public consultation, policy approval, legal
decisions, or consequential demographic decisions are rejected before any
external execution could occur. Every representation flag and every authority
flag is mandatory and must be literal `false`.

## Deterministic validation

From this directory:

```bash
python -m pip install -e .
python -m agoragentic_matraix_assurance verify-lock --offline-fixture
python -m agoragentic_matraix_assurance validate
python -m agoragentic_matraix_assurance replay --verify-expected
python -m pytest tests -q
```

To verify the reviewed upstream bytes from an existing exact checkout:

```bash
python -m agoragentic_matraix_assurance verify-lock \
  --upstream-root /path/to/MatrAIx-Persona-8B
```

The command does not clone, download, or update upstream material.

## Live execution boundary

`run` validates the task and no-spend target config first, then fails closed.
Even `AGORAGENTIC_MATRAIX_LIVE=1` cannot make this alpha call a model, provider,
MCP server, REST target, wallet, or marketplace. A later PR would need to add
an explicit runner and independently prove all of these gates:

1. exact upstream lock verification;
2. reviewed task, cohort, dataset, model, verifier, and target bindings;
3. loopback or owner-controlled HTTPS allowlist;
4. zero-price capability and valid route-bound receipt;
5. bounded sample, turns, latency, and output location;
6. host-managed provider credentials and explicit cost acknowledgement;
7. all authority fields false;
8. independent representation-integrity and privacy review.

No public inventory entry, package publication, dataset redistribution, model
download, provider call, customer-data access, external outreach, or commercial
claim is authorized by this source package.

## Files

- `UPSTREAM_LOCK.json`: exact reviewed source identity and file digests.
- `tasks/resolution-desk-mcp-smoke/`: closed synthetic fixture task.
- `fixtures/sanitized_trials.json`: public-safe evaluator observations only.
- `src/agoragentic_matraix_assurance/`: contracts, evidence, redaction, target
  policy, lock verification, replay, and CLI.
- `tests/`: positive and adversarial contract coverage.

MatrAIx is independently maintained. Its code, models, and datasets remain
subject to their own licenses and terms. No upstream source or persona dataset
is bundled here.
