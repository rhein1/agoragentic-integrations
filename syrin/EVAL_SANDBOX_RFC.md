# Syrin Eval / Sandbox RFC Draft

This is a narrow proposal for the first framework-level step after the Agoragentic example PRs.

The point is not to redesign Syrin. The point is to give Syrin a first-class way to define, run, and inspect process-aware evaluations in self-hosted environments.

## Problem

Current agent examples can show:

- tool usage
- checkpoints
- traces
- serving

What they do not yet give a user is a standard contract for saying:

- what workflow is expected
- which tools must or must not run
- what checkpoints should exist
- what artifacts should be captured
- what environment policy should constrain the run

That gap is where ad hoc harnesses start proliferating.

## Design Goal

Add a narrow, inspectable eval surface that:

- is process-aware, not only final-answer-aware
- is self-hostable
- composes with existing Syrin tools, hooks, checkpoints, and serving
- can be adopted incrementally

## Proposed Surfaces

### `EvalSpec`

The top-level contract for a scenario:

```python
from dataclasses import dataclass, field
from typing import Any


@dataclass
class EvalSpec:
    name: str
    prompt: str
    input_data: dict[str, Any] = field(default_factory=dict)
    expected_tools: list[str] = field(default_factory=list)
    forbidden_tools: list[str] = field(default_factory=list)
    trace_expectations: list["TraceExpectation"] = field(default_factory=list)
    checkpoint_assertions: list["CheckpointAssertion"] = field(default_factory=list)
    sandbox_policy: "SandboxPolicy | None" = None
```

### `TraceExpectation`

Assertions about process, not just content:

```python
@dataclass
class TraceExpectation:
    step_type: str | None = None
    tool_name: str | None = None
    min_count: int = 0
    max_count: int | None = None
```

Examples:

- `tool_name="agoragentic_match", min_count=1`
- `tool_name="agoragentic_execute", max_count=0`
- `step_type="tool", min_count=2`

### `CheckpointAssertion`

Assertions over checkpoint behavior:

```python
@dataclass
class CheckpointAssertion:
    label_contains: str | None = None
    min_count: int = 0
```

Examples:

- at least one baseline checkpoint
- at least one post-run checkpoint
- at least one checkpoint after a tool event

### `SandboxPolicy`

The minimal self-hosted environment contract:

```python
@dataclass
class SandboxPolicy:
    network_mode: str = "default"
    allow_hosts: list[str] = field(default_factory=list)
    deny_hosts: list[str] = field(default_factory=list)
    filesystem_mode: str = "workspace"
    allow_env: list[str] = field(default_factory=list)
    timeout_seconds: int = 120
```

This can stay intentionally small at first. The initial win is having a standard shape, not an exhaustive policy engine.

## Minimal Runner Shape

The first implementation does not need a large new runtime. It can be a thin orchestration helper over existing Syrin primitives.

```python
result = agent.run_eval(
    EvalSpec(
        name="paper-summary-preview-only",
        prompt=(
            "Use agoragentic_match to preview a provider for summarizing a paper under "
            "$0.25, then search marketplace memory. Do not execute paid actions."
        ),
        expected_tools=["agoragentic_match", "agoragentic_memory_search"],
        forbidden_tools=["agoragentic_execute", "agoragentic_save_learning_note"],
        trace_expectations=[
            TraceExpectation(tool_name="agoragentic_match", min_count=1),
            TraceExpectation(tool_name="agoragentic_memory_search", min_count=1),
        ],
        checkpoint_assertions=[
            CheckpointAssertion(label_contains="before", min_count=1),
            CheckpointAssertion(label_contains="after", min_count=1),
        ],
        sandbox_policy=SandboxPolicy(
            network_mode="restricted",
            allow_hosts=["agoragentic.com"],
            allow_env=["OPENAI_API_KEY", "AGORAGENTIC_API_KEY"],
            timeout_seconds=90,
        ),
    )
)
```

## Proposed Result Shape

```python
@dataclass
class EvalResult:
    success: bool
    output_text: str
    observed_tools: list[str]
    missing_tools: list[str]
    forbidden_tools_used: list[str]
    trace_summary: list[dict[str, Any]]
    checkpoints: list[dict[str, Any]]
    artifacts_dir: str | None = None
```

The goal is not a clever score. The goal is inspectable evidence.

## Artifact Bundle

If an eval runs with artifact capture enabled, the runner should write:

- `trace.json`
- `checkpoints.json`
- `result.json`
- optional raw output files

This is the bridge to self-hosted harnessing. Teams can archive, diff, and replay evals without depending on a hosted external platform.

## CLI Direction

Not required immediately, but this is the natural path once the Python surface exists:

```bash
syrin eval examples/thirdparty/agroagentic/agoragentic_marketplace_process_verification.py
syrin sandbox run config/evals/paper-summary.yaml
```

The CLI should remain a thin wrapper around the Python contracts, not a separate hidden system.

## Why This Is A Good First RFC

- it builds directly on existing Syrin features
- it stays small enough to discuss concretely
- it gives maintainers a path toward process verification without demanding a big architecture rewrite
- it creates a clean bridge from examples to self-hosted eval harnesses

## Non-Goals

- full deployment platform
- full container orchestration system
- large hosted eval service
- replacing external benchmarking suites

The first win is a standard process-aware contract and a local runner story.
