# Agent Workflow Contracts

Use this contract when a coding agent runs a Fable-5-style audit, deep review, fact check, repo sweep, or ECF-governed implementation pass in this repository.

## Public Boundary

This is a public OSS repository. Keep agent work inside the public Micro ECF / ECF Core boundary:

- Do not add Full ECF private runtime internals, private connector code, customer evidence, operator prompts, wallet material, secrets, or hosted platform internals.
- Do not claim hosted deployment, marketplace publication, x402 settlement, production mutation, or enterprise readiness unless the repo contains current public evidence.
- Treat generated context artifacts as navigation aids. Real source files, tests, and runtime probes remain the source of truth.

## Run Contract

Before starting a governed run, state the contract in the working notes or final report:

- `scope`: exact files, directories, PRs, branch, or behavior under review.
- `mode`: `read_only`, `validation_only`, `docs_only`, `implementation`, or `release`.
- `authority`: what the agent may change, run, publish, spend, deploy, or comment on.
- `lenses`: independent review angles assigned to agents or passes.
- `evidence`: files, tests, commands, logs, and runtime probes that can support findings.
- `subagents`: real subagent IDs when the runtime exposes them, or `none_available`.
- `verification`: commands or checks that must pass before the run is complete.

## Subagent Contract

When the runtime supports subagents, use them for independent lenses instead of treating one transcript as a swarm. Preserve their identifiers in the trace.

Subagents may:

- map source and docs
- inspect specific risk lenses
- propose findings or implementation options
- run read-only searches and safe validation commands within the declared authority

Subagents must not:

- commit, push, merge, approve, publish, deploy, spend, rotate secrets, or contact external services unless the main agent explicitly has that authority and delegates it in the run contract
- claim a finding without file, command, or runtime evidence
- expose secrets or private data in findings

The main agent owns synthesis, final findings, writes, commits, pushes, PRs, release actions, and any statement that work is complete.

If no real subagent runtime is available, run separate named lenses in the main agent and report `subagents: none_available`. Do not claim multi-subagent execution.

## Recommended Lenses

- `security_privacy`: secrets, auth, data exposure, permission boundaries
- `correctness`: logic errors, edge cases, invariants, failure paths
- `integration`: API contracts, provider assumptions, external service behavior
- `data_contract`: schemas, migrations, serialization, backward compatibility
- `operations_release`: install, CI, packaging, deploy, rollback, owner gates
- `tests_docs`: test coverage, docs-vs-reality, examples, status claims
- `repo_consistency`: naming, generated surfaces, package metadata, discovery files

## Trace Template

```text
Workflow Trace
- scope:
- mode:
- authority:
- subagents:
  - id:
    lens:
    evidence:
    result:
- main-agent synthesis:
- verification:
- residual unknowns:
```

## ECF Handoff

Use Micro ECF artifacts for lightweight local policy/source boundaries and ECF Core artifacts for richer self-hosted context governance when they exist in the target repo. Inspect `ECF.md`, `.micro-ecf/*`, or `.ecf-core/*` only as public/local context aids, then verify claims against live source files before editing or reporting.
