# Syrin × Agoragentic Roadmap

This file is the working roadmap behind the upstream `syrin-python` contribution sequence.

It is not a maintainer pitch. It is the concrete internal plan for what we are trying to build, why the work is ordered this way, and what should happen after the current example PRs.

## Current Upstream Stack

Open PRs in `syrin-labs/syrin-python`:

- `#3` — Agoragentic third-party marketplace example
- `#4` — Agoragentic third-party serving example
- `#5` — Agoragentic process-verification example

Why this order:

1. establish a real third-party tool surface
2. prove that the same tool surface serves cleanly
3. prove that the workflow can be process-verified

That sequence creates a concrete foundation before proposing any larger framework changes.

## Design Direction

The long-term direction is:

- schema-native agent development
- multimodal workflows
- aggressive schematic integration
- internally hosted sandbox testing
- process-aware evaluation
- self-deployment

Translated into maintainer-friendly terms, the actual Syrin roadmap is:

- schema-native agent engineering
- self-hosted evals and sandboxing
- deployable agent runtimes

## What We Think Syrin Already Has

Syrin already covers much of the runtime layer:

- model abstraction
- budgets
- memory
- tools
- hooks
- checkpoints
- serving
- multimodal support
- multi-agent patterns

Because of that, the highest-leverage contribution is not another generic example or another standalone runtime primitive. It is closing the loop between authoring, verification, sandboxing, and deployment.

## Phase Plan

### Phase 0 — Examples First

Goal:
- land small, mergeable PRs that show real workflows

Deliverables:
- marketplace example
- serving example
- process-verification example

Success criteria:
- examples are accepted into `examples/thirdparty/agroagentic/`
- maintainers are comfortable with third-party example structure
- process verification is accepted as an example-worthy concept, not just external theory

### Phase 1 — Eval And Process Verification RFC

Goal:
- introduce a narrow RFC for process-aware evaluation

Target scope:
- expected-vs-observed tool usage
- trace artifact capture
- checkpoint assertions
- replayable eval inputs

Potential API shape:
- `EvalSpec`
- `TraceExpectation`
- `CheckpointAssertion`

Success criteria:
- maintainers agree that process-level verification belongs in the framework surface
- at least one lightweight implementation path is accepted

### Phase 2 — Sandbox Contract

Goal:
- make self-hosted sandboxing a first-class concept

Target scope:
- `SandboxPolicy`
- local or Docker-backed runner contract
- artifact bundle for traces, outputs, and failures
- environment-level safety boundaries

Success criteria:
- clear distinction between agent runtime and sandbox runtime
- self-hosted eval workflows become possible without ad hoc scripts

### Phase 3 — Schema-Native Agent Specs

Goal:
- make contracts explicit and machine-readable

Candidate types:
- `TaskSpec`
- `ToolSpec`
- `EvalSpec`
- `SandboxPolicy`
- `DeploySpec`

Success criteria:
- framework workflows can be described, inspected, and validated without relying on implicit conventions alone

### Phase 4 — Deploy Surface

Goal:
- let `agent.serve()` lead naturally into deployment

Target scope:
- deployment manifests
- health and readiness conventions
- secret mounts
- checkpoint volumes
- sandbox profiles

Success criteria:
- a user can go from local serve to a policy-shaped deployment story without inventing the entire deployment surface themselves

## Research Alignment

Three references are shaping this roadmap:

- Agentic-MME
- AI Agent Traps
- AutoAgent

Takeaways we are using:

- process-level verification matters
- environment traps and sandbox policy matter
- iterative harness-driven development matters

## Guardrails

- keep PRs small and mergeable
- do not jump straight to a large architectural refactor
- build from examples toward contracts, not the reverse
- prefer self-hosted and inspectable workflows over magic hosted abstractions
- keep execution honest: preview first, execute second, mutate only behind explicit gates

## Next Actions

1. Get `#3` merged.
2. Rebase `#4` and `#5` once `#3` lands.
3. Open a maintainer discussion using `UPSTREAM_DISCUSSION.md`.
4. Draft a narrow eval/sandbox RFC instead of a broad platform manifesto.
