# Syrin × Agoragentic: Proposed Upstream Direction

This note is a ready-to-post maintainer discussion draft for `syrin-python`.

## Draft Discussion

**Title:** Toward schema-native, self-hosted agent engineering workflows in Syrin

I have been upstreaming a small Agoragentic integration into `syrin-python` and wanted to share the broader direction I think is worth discussing after the example PRs settle.

Current contribution stack:

- `#3` — Agoragentic third-party marketplace example
- `#4` — Agoragentic third-party serving example
- `#5` — Agoragentic process-verification example

I kept those intentionally narrow because I think the right way to extend Syrin is to start from real workflows, not a big abstract refactor.

My thesis is that Syrin already has many of the runtime primitives that matter:

- model abstraction
- budgets and rate controls
- memory backends
- hooks and checkpoints
- serving
- multimodal support
- multi-agent patterns

So the highest-leverage next step is not "add multimodality" or "add deployment" in isolation. It is closing the loop between:

1. task specification
2. tool contracts
3. evals and process checkpoints
4. sandbox policy
5. deployment packaging

That would move Syrin toward a more schema-native agent engineering model rather than only a runtime with tools.

## Why The Current PR Stack Looks The Way It Does

The three Agoragentic PRs are meant to establish the sequence first:

1. show a safe-by-default third-party tool surface
2. show that the same tool surface can be served cleanly
3. show that the workflow can be process-verified with hooks, checkpoints, and traces

That sequence matters because it keeps the work concrete and lets any future eval/sandbox conversation build on examples that already exist inside the repo.

## Proposed Roadmap

### Phase 0: Small mergeable examples

Goal:
- land practical third-party examples that demonstrate real agent workflows

Scope:
- execute-first routing
- preview-first provider matching
- durable memory search and learning notes
- serving through `agent.serve()`
- trace- and checkpoint-based workflow verification

### Phase 1: Schema-native contracts

Goal:
- give agents, tooling, and evaluators explicit machine-readable contracts

Potential primitives:
- `TaskSpec`
- `ToolSpec`
- `EvalSpec`
- `SandboxPolicy`
- `DeploySpec`

These could be Pydantic- or JSON-Schema-first, with a clean Python layer on top.

### Phase 2: Self-hosted eval and sandbox surface

Goal:
- make sandboxed verification and process-level testing first-class workflows

Possible direction:
- `syrin eval`
- `syrin sandbox`
- local Docker-based or self-hosted runner support
- artifact capture for traces, outputs, failures, and checkpoints
- replayable eval packs

Why this matters:
- final-answer scoring is not enough for agent systems
- the execution path and failure modes need explicit inspection
- self-hosted workflows matter for teams that cannot ship agent traces or test inputs to third-party infrastructure

### Phase 3: Deployment packaging

Goal:
- make "serve locally" naturally lead into "deploy safely"

Potential artifacts:
- container packaging
- health and readiness conventions
- secret mounts
- checkpoint volumes
- sandbox profiles
- deployment manifests

## Smallest Useful Follow-Up RFC

If maintainers think the direction is interesting, the smallest useful follow-up after the example PRs would not be "full deployment" or "full multimodal platforming."

It would be a narrow eval/sandbox RFC around:

- a minimal `EvalSpec`
- expected-vs-observed tool usage
- checkpoint assertions
- trace artifact capture
- a simple self-hosted runner contract

That seems like the most defensible bridge between the current Syrin runtime and a more complete agent engineering loop.

## Why This Direction Feels Timely

Three recent threads all point the same way:

- Agentic-MME argues that multimodal agents need process-aware evaluation, not just end-result scoring.
- Recent "AI Agent Traps" research highlights why adversarial environments and sandbox policy cannot stay implicit.
- AutoAgent-style harnesses show the value of tight loops between mutation, benchmarking, and selection.

Taken together, they suggest a framework should not stop at inference orchestration. It should help structure the full authoring, evaluation, and deployment loop.

## Immediate Contribution I Can Continue With

After the example PRs settle, I would be interested in helping with one or both of:

- a focused RFC for schema-native eval + sandbox contracts
- a small reference implementation for process verification with self-hosted artifact capture

I would explicitly keep that incremental and avoid trying to force a large platform rewrite through examples.

## Reference Links

- Agentic-MME: https://arxiv.org/abs/2604.03016
- AutoAgent: https://github.com/kevinrgu/autoagent
- Syrin: https://github.com/syrin-labs/syrin-python
