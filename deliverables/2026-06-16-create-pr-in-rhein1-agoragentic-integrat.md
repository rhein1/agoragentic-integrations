# LangGraph Wegent Buyer Adapter Patch Plan

## Goal

Add a real Wegent-oriented LangGraph buyer example around the existing Agoragentic `execute()` adapter so maintainers ship three things together:

1. a reusable LangGraph buyer adapter that fits nontrivial graph state
2. a working Wegent integration script that can run locally
3. a concrete usage receipt example that shows budget, provider, invocation, and reconciliation fields

## Evidence from the current repo

- `langgraph/agoragentic_langgraph.py` already provides the core buyer rail:
  - `match()`
  - `execute()`
  - `status()`
  - `receipt()`
  - `build_execute_node()`
- The current LangGraph adapter already normalizes execution receipts with:
  - `invocation_id`
  - `receipt_id`
  - `provider`
  - `usage`
  - retry and recovery metadata
- `langgraph/test_agoragentic_langgraph.py` only proves retry recovery for `execute()`. It does not prove a compiled LangGraph workflow or a framework-style example.
- `langgraph/README.md` is minimal. It does not include:
  - a runnable integration script
  - a sample graph
  - a usage receipt example
  - a Wegent-specific state mapping
- `examples/langgraph_pii_pipeline_guard/` shows the repo already accepts richer, runnable LangGraph examples with:
  - a dedicated example directory
  - `requirements.txt`
  - tests
  - a documented receipt shape
- There are no existing `Wegent` references in the repo, so the contribution must define the sample use case clearly instead of assuming maintainers already know the runtime contract.

## Bounded diagnosis

The repository does not need a brand-new LangGraph buyer adapter from scratch. The core adapter already exists and is usable.

The missing pieces are:

1. state-mapping flexibility for a Wegent-shaped graph
2. a runnable end-to-end integration example
3. a receipt artifact that makes the commerce/governance value visible to users

That means the highest-value patch is an additive enhancement to the current LangGraph adapter plus a self-contained example, not a parallel second adapter.

## Files to update

### 1) `langgraph/agoragentic_langgraph.py`

Purpose:
- keep the current adapter as the canonical LangGraph buyer rail
- make it easier to plug into Wegent-style state without wrapper lambdas everywhere

Recommended changes:

#### A. Extend `build_execute_node()` with configurable state keys

Current behavior is hardcoded to:
- `task`
- `input`
- `constraints`
- `agoragentic_execute`
- `invocation_id`
- `receipt_id`
- `marketplace_output`
- `execution_status`

Add optional parameters so the same adapter can write into a Wegent-oriented state model:

- `task_key: str = "task"`
- `input_key: str = "input"`
- `constraints_key: str = "constraints"`
- `receipt_key: str = "agoragentic_execute"`
- `invocation_key: str = "invocation_id"`
- `receipt_id_key: str = "receipt_id"`
- `output_key: str = "marketplace_output"`
- `status_key: str = "execution_status"`

This keeps the existing default behavior fully backward-compatible while making the adapter genuinely reusable for a real buyer workflow.

#### B. Add a small helper for receipt hydration

Add a helper such as:

- `build_receipt_fetch_node(receipt_state_key: str = "receipt_id", output_key: str = "agoragentic_receipt")`

Behavior:
- read `receipt_id` from state
- if present, call `receipt()`
- write the fetched receipt into state
- if absent, leave state unchanged

This gives the example a clean way to prove reconciliation without hand-rolled boilerplate in every script.

#### C. Keep the existing normalized receipt contract

Do not change the existing `execute()` return shape except for additive fields if needed. The example and docs should rely on the current stable fields:

- `ok`
- `status`
- `task`
- `invocation_id`
- `receipt_id`
- `output`
- `provider`
- `attempts`
- `recovery`
- `usage`
- `error`
- `raw`
- `logs`

### 2) `langgraph/README.md`

Purpose:
- document the adapter as the canonical LangGraph buyer path
- show exactly how a Wegent-like graph uses it
- point to the example directory and receipt artifact

Add sections for:

- “Why this exists”
- “Wegent buyer example”
- “Run locally”
- “Receipt example”
- “State mapping”
- “Safety and budget boundaries”

Key points to add:

- LangGraph remains the orchestration layer
- Agoragentic is the routed execution and receipt rail
- use `match()` before spend when needed
- keep `constraints.max_cost` in graph state
- persist `invocation_id` and `receipt_id`
- use the example directory for a working Wegent-style flow

## Files to add

### 3) `examples/wegent_langgraph_buyer/README.md`

Purpose:
- document the sample use case as a real, runnable Wegent-style buyer workflow

Recommended structure:

#### Title
`# Wegent LangGraph Buyer Example`

#### What the example proves
- a Wegent-style graph can keep its own planner/orchestrator logic
- Agoragentic handles routed execution
- the run stays budget-bounded
- every execution yields provider and receipt metadata
- no provider IDs are hardcoded

#### Example flow
Use a simple but credible buyer flow:

1. prepare a research request
2. optionally preview providers with `match()`
3. execute through `POST /api/execute`
4. store `invocation_id` and `receipt_id`
5. fetch the receipt for audit/reconciliation
6. return a final Wegent-friendly result object

#### Files table
- `run.py` — runnable LangGraph integration script
- `requirements.txt` — Python dependencies
- `fixtures/usage-receipt.example.json` — example normalized receipt
- `tests/test_run.py` — offline tests

#### Run locally
Document commands like:

- create venv
- install requirements
- export `AGORAGENTIC_API_KEY`
- run `python run.py`

#### Output contract
Document the final state keys the script prints, for example:

- `buyer_request`
- `provider_preview`
- `execution_result`
- `invocation_id`
- `receipt_id`
- `usage_receipt`
- `final_answer`

#### Boundary
State clearly:
- buyer-only example
- no listing publication
- no deployment
- no direct provider hardcoding
- no wallet internals
- no secret access

### 4) `examples/wegent_langgraph_buyer/run.py`

Purpose:
- be the actual working integration script

Recommended script shape:

#### State
Define a typed dict or plain dict state with keys such as:

- `buyer_request`
- `task`
- `input`
- `constraints`
- `provider_preview`
- `execution_result`
- `invocation_id`
- `receipt_id`
- `usage_receipt`
- `final_answer`

#### Nodes

##### `prepare_request_node`
- convert a Wegent-style natural language request into:
  - `task`
  - `input`
  - `constraints`
- example:
  - `task`: `research competitor pricing and summarize buyer-relevant findings`
  - `input`: request topic, target market, output format
  - `constraints.max_cost`: from env or default

##### `preview_providers_node`
- call `adapter.match()`
- write preview results into `provider_preview`
- this proves the no-spend preview path

##### `execute_buyer_node`
- use the adapter’s configurable `build_execute_node()`
- map its outputs into:
  - `execution_result`
  - `invocation_id`
  - `receipt_id`
  - `final_answer`

##### `fetch_receipt_node`
- call `adapter.receipt()` via the new helper or directly
- write result to `usage_receipt`

##### `finalize_node`
- shape the final response for Wegent consumption:
  - answer text
  - provider summary
  - cost/usage
  - receipt references

#### Graph
Compile a simple `StateGraph`:

- `prepare_request`
- `preview_providers`
- `execute_buyer`
- `fetch_receipt`
- `finalize`

The script should also support a fallback sequential path if `langgraph` is unavailable, matching the pattern used in `examples/langgraph_pii_pipeline_guard/src/pipeline.py`.

#### CLI behavior
Read inputs from environment variables so the example is actually runnable:

- `WEGENT_REQUEST`
- `WEGENT_MAX_COST_USDC`
- `WEGENT_CATEGORY`
- `AGORAGENTIC_API_KEY`

Print final state JSON to stdout.

### 5) `examples/wegent_langgraph_buyer/requirements.txt`

Purpose:
- make the example installable without guessing

Contents should include:

- `requests`
- `langgraph`
- `langchain-core`

No extra dependencies unless the script truly needs them.

### 6) `examples/wegent_langgraph_buyer/fixtures/usage-receipt.example.json`

Purpose:
- show maintainers and users exactly what the Wegent example emits after a successful routed execution

Recommended example shape:

```json
{
  "receipt_id": "rcpt_wegent_example_001",
  "invocation_id": "inv_wegent_example_001",
  "status": "completed",
  "task": "research competitor pricing and summarize buyer-relevant findings",
  "provider": {
    "id": "provider_market_research_alpha",
    "name": "Market Research Alpha"
  },
  "usage": {
    "cost_usdc": 0.08,
    "attempts": 1,
    "recovery_used": false
  },
  "recovery": {
    "used": false,
    "retry_policy": {
      "max_attempts": 3,
      "backoff_seconds": 0.5,
      "backoff_multiplier": 2.0,
      "max_backoff_seconds": 8.0
    },
    "transient_failures": 0
  },
  "output": {
    "summary": "Competitors cluster into low-cost self-serve, managed mid-market, and premium enterprise tiers.",
    "buyer_actions": [
      "test self-serve providers under a 0.10 USDC cap",
      "compare receipt completeness before production rollout"
    ]
  }
}
```

The exact numbers can stay illustrative, but the field names should match the adapter’s real normalized contract.

### 7) `examples/wegent_langgraph_buyer/tests/test_run.py`

Purpose:
- prove the example works offline and actually composes the graph

Recommended test cases:

#### `test_prepare_request_builds_bounded_execute_payload`
Verify:
- the Wegent request becomes a real `task`
- `constraints.max_cost` is populated
- the example never hardcodes a provider ID

#### `test_graph_writes_execution_and_receipt_fields`
Using a fake session or fake adapter, verify the compiled graph writes:

- `provider_preview`
- `execution_result`
- `invocation_id`
- `receipt_id`
- `usage_receipt`
- `final_answer`

#### `test_receipt_fetch_node_is_noop_without_receipt_id`
Verify the receipt step is safe when execution did not return a receipt.

#### `test_example_runs_without_langgraph_using_fallback`
Match the existing repo pattern:
- if `langgraph` import fails, the example still runs sequentially
- this keeps tests local and dependency-light

## Optional file to add

### 8) `examples/wegent_langgraph_buyer/.gitignore`

Purpose:
- ignore `.venv/`, `__pycache__/`, and local output artifacts if the example writes any

This is optional if the example does not create files locally.

## Implementation details that matter

### The Wegent sample should stay buyer-side

Do not turn this contribution into a seller or deployment example. The task is specifically a buyer adapter and usage proof.

That means the example should only demonstrate:

- provider preview
- routed execute
- receipt fetch
- final answer shaping

Not:

- listing creation
- marketplace publication
- Agent OS deploy
- x402 settlement flow
- trust state changes

### The adapter enhancement should be additive

The current `langgraph/agoragentic_langgraph.py` is already useful and has tests. The patch should not replace or rename the existing public API.

Safe additive change:
- extend `build_execute_node()`
- add a receipt-fetch helper
- preserve defaults

### The example should prove “governed runtime with budget and receipts”

The most important thing the Wegent team needs to see is not just “LangGraph can call execute()”.

They need proof that the graph can carry:

- a budget cap
- a routed execution result
- provider metadata
- a usage receipt
- reconciliation identifiers

The example state and printed output should make those fields explicit.

### The script should use repo-established conventions

Follow the existing repo style:

- keep `agoragentic_*` naming for tool-facing helpers
- use `constraints.max_cost`
- keep `invocation_id` and `receipt_id`
- do not hardcode provider IDs
- keep examples runnable with standard Python and local mocks in tests

## Test command matrix

These commands should pass after the patch:

```bash
python -m unittest langgraph/test_agoragentic_langgraph.py
python -m unittest examples/wegent_langgraph_buyer/tests/test_run.py
```

If the example uses `pytest` instead of `unittest`, then document:

```bash
python -m pytest examples/wegent_langgraph_buyer/tests
```

Also validate the example script itself:

```bash
python -m py_compile langgraph/agoragentic_langgraph.py
python -m py_compile examples/wegent_langgraph_buyer/run.py
```

## Likely fix path

1. extend the existing LangGraph adapter with configurable state-key mapping
2. add a small receipt-fetch node helper
3. build a new `examples/wegent_langgraph_buyer/` runnable demo
4. add offline tests with a fake session
5. expand `langgraph/README.md` to point to the example and receipt artifact

## Residual uncertainty

1. There is no Wegent-specific runtime contract in this repo.
   - Mitigation: define the example as a Wegent-style buyer graph rather than claiming native Wegent internals.

2. It is not clear whether maintainers prefer `unittest` or `pytest` for new Python example tests.
   - Mitigation: match the nearest local pattern for the target directory; keep the tests dependency-light.

3. The current adapter already returns normalized execute receipts, so the exact receipt-fetch helper may be optional.
   - Mitigation: only add the helper if it clearly reduces example boilerplate; otherwise fetch the receipt directly inside the example script.

## Acceptance criteria

This patch is complete when:

- `langgraph/agoragentic_langgraph.py` supports flexible graph state mapping for buyer execution
- the repo contains a runnable Wegent LangGraph buyer example
- the example demonstrates budgeted `execute()` plus receipt retrieval
- the example includes a usage receipt artifact
- offline tests prove the graph writes the expected execution and receipt fields
- `langgraph/README.md` documents the sample use case and how to run it