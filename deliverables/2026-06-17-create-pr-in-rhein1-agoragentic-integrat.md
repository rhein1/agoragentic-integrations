# LangGraph Adapter Patch Plan

## Goal

Upgrade the existing `langgraph/` integration from a thin HTTP wrapper into a runnable LangGraph adapter that:

- executes routed work through Agoragentic `execute()`
- exposes LangChain/LangGraph-compatible tools
- supports checkpoint-backed state persistence
- returns bounded, structured errors instead of raw `requests` exceptions
- includes a runnable example and a test proving execution, persistence, and failure handling

## Evidence from the current repo

- `AGENTS.md` requires adapter changes to stay aligned with `integrations.json`, preserve `agoragentic_*` naming, and update the per-framework `README.md`.
- `README.md` already marks LangGraph as `✅ Ready` and points at `langgraph/agoragentic_langgraph.py`.
- `integrations.json` already registers LangGraph at:
  - `id: "langgraph"`
  - `path: "langgraph/agoragentic_langgraph.py"`
  - `install: "pip install requests langgraph langchain-core"`
- The current `langgraph/agoragentic_langgraph.py` only:
  - wraps `match`, `execute`, `status`, and `receipt`
  - calls `response.raise_for_status()`
  - returns raw JSON
  - builds tools, but does not provide a LangGraph node, graph example, persistence example, or bounded error type
- The current `langgraph/README.md` documents the tools but does not show:
  - a runnable `StateGraph`
  - `thread_id` / checkpoint usage
  - how execution results are written back into graph state
  - test commands
- The repo already contains LangGraph-oriented examples under `examples/langgraph_pii_pipeline_guard/`, including a fallback pattern and pytest tests, so there is precedent for LangGraph examples and local tests.

## Current gap

The existing adapter is not enough to justify the `Ready` status for maintainers or users who want to actually run a stateful LangGraph workflow through Agoragentic.

Missing today:

- no state schema for a graph node
- no checkpoint/persistence path
- no runnable example that invokes `execute()`
- no test coverage
- no bounded Agoragentic-specific exception type
- no preservation of error details in graph state

## Files to update

### 1) Replace `langgraph/agoragentic_langgraph.py`

Turn the file into the real adapter, not just a tool factory.

### Required exports

- `class AgoragenticLangGraphError(Exception)`
- `class AgoragenticLangGraphClient`
- `def build_agoragentic_langgraph_tools(api_key: Optional[str] = None, client: Optional[AgoragenticLangGraphClient] = None) -> list`
- `def create_execute_node(client: AgoragenticLangGraphClient, *, task_key: str = "task", input_key: str = "input", constraints_key: str = "constraints")`
- `def build_example_graph(client: AgoragenticLangGraphClient, checkpointer: Any | None = None)`

### Adapter behavior

1. Add a private `_request()` helper in `AgoragenticLangGraphClient`
   - use a `requests.Session`
   - normalize:
     - connection errors
     - timeouts
     - non-2xx responses
     - invalid JSON responses
   - raise `AgoragenticLangGraphError` with:
     - `stage`
     - `message`
     - `status_code` when available
     - `response_text` truncated to a safe size when available

2. Keep the current public methods:
   - `match()`
   - `execute()`
   - `status()`
   - `receipt()`

3. Add a graph node factory:
   - `create_execute_node(...)`
   - node reads state keys:
     - `task`
     - `input`
     - `constraints`
     - `history` optional
   - node writes:
     - `agoragentic_result`
     - `invocation_id`
     - `receipt_id`
     - `last_error`
     - `history`

4. Error path must stay inside graph state
   - when `execute()` fails, node should not lose context
   - write:
     - `last_error = {"stage": ..., "message": ..., "status_code": ...}`
     - append a failure event to `history`

5. Persistence support
   - `build_example_graph()` should compile a `StateGraph`
   - if a checkpointer is passed, compile with it
   - README example should use `MemorySaver`
   - persistent runs should use `config={"configurable": {"thread_id": "demo-thread"}}`

### Suggested state shape

Use a small `TypedDict` so the adapter is easy to understand:

- `task: str`
- `input: dict`
- `constraints: dict`
- `agoragentic_result: dict`
- `invocation_id: str`
- `receipt_id: str`
- `last_error: dict | None`
- `history: list[dict]`

### Important implementation detail

Do not over-normalize the `execute()` response. Preserve the full raw response under something like:

- `agoragentic_result["raw_response"]`

Then add convenience extraction:

- `invocation_id`
- `receipt_id`

This avoids guessing too hard about every API payload variant.

## Files to add

### 2) Add `langgraph/example_usage.py`

Purpose:

- provide a runnable example maintainers can execute directly
- demonstrate the exact LangGraph persistence story
- prove the adapter is more than a tool wrapper

### Example flow

- import `MemorySaver`
- build client from `AGORAGENTIC_API_KEY`
- build graph with `build_example_graph(client, checkpointer=MemorySaver())`
- invoke graph twice with the same `thread_id`
- show that:
  - the second run still has prior `history`
  - execution result is stored in graph state
  - errors would appear under `last_error`

### Example command

- `python langgraph/example_usage.py`

### Example state behavior

First run:
- executes `summarize` task
- stores `invocation_id`, `receipt_id`, and a `history` entry

Second run with same `thread_id`:
- executes another task
- returns a longer `history`
- demonstrates checkpoint-backed continuity

## Files to update

### 3) Rewrite `langgraph/README.md`

Keep it short but make it operational.

### Required sections

- what the adapter does
- install
- files
- runnable example
- persistence with `MemorySaver`
- error handling
- testing

### README content should explicitly show

1. Install

```bash
pip install requests langgraph langchain-core pytest
export AGORAGENTIC_API_KEY="amk_your_key"
```

2. Tool usage

- `build_agoragentic_langgraph_tools()`

3. Graph usage

- `create_execute_node(...)`
- `build_example_graph(...)`

4. Persistence usage

- same `thread_id`
- `MemorySaver`

5. Test command

```bash
python -m pytest langgraph/test_agoragentic_langgraph.py
```

## Files to add

### 4) Add `langgraph/test_agoragentic_langgraph.py`

Purpose:

- prove execution through Agoragentic `execute()`
- prove bounded error handling
- prove LangGraph state persistence

### Test cases

#### `test_execute_tool_posts_to_agoragentic_execute_endpoint()`

Assert:

- `POST /api/execute` is called
- payload includes:
  - `task`
  - `input`
  - `constraints`
- returned `invocation_id` and `receipt_id` are surfaced correctly

Implementation approach:

- patch `requests.Session.request`
- return a fake JSON response object
- avoid network access

#### `test_execute_node_records_bounded_error_in_state()`

Assert:

- simulated timeout or HTTP 500 becomes `AgoragenticLangGraphError`
- graph node writes:
  - `last_error.stage`
  - `last_error.message`
- node appends a failure event to `history`

#### `test_graph_persists_history_with_memory_saver()`

Assert:

- compile graph with `MemorySaver`
- invoke twice with the same `thread_id`
- second run contains two history events
- first run state is preserved across invocations

### Test fixtures

Keep the tests local-only by mocking the client or HTTP transport. No hosted calls, no secrets, no `.env` reads.

## Optional cleanup

### 5) Update `pyproject.toml`

The repo currently advertises LangGraph in `integrations.json`, but `pyproject.toml` only defines `langchain` and `crewai` extras.

Add:

- `langgraph = ["langgraph>=0.2.0", "langchain-core>=0.1.0"]`

Update `all` to include `langgraph`.

This is not strictly required for the adapter file to work, but it removes a packaging mismatch.

## Acceptance criteria

This patch is done when all of the following are true:

- `langgraph/agoragentic_langgraph.py` exposes a real LangGraph node factory
- a user can run `python langgraph/example_usage.py`
- the example demonstrates checkpoint-backed persistence with `thread_id`
- failures are captured as bounded adapter errors, not raw transport traces
- `python -m pytest langgraph/test_agoragentic_langgraph.py` passes locally
- `langgraph/README.md` documents execution, persistence, and testing

## Likely implementation shape

The smallest maintainable patch is:

- keep the existing client class name
- add one custom exception type
- add one request wrapper
- add one execute-node factory
- add one example graph builder
- add one example script
- add one focused pytest file

That gives the repo a real LangGraph integration without introducing a large abstraction layer.

## Residual uncertainty

- The exact hosted `execute()` response shape may vary across environments, especially where `receipt_id` is nested or omitted until later workflow steps.
- Because of that, the adapter should preserve the raw response and only extract convenience keys opportunistically.
- If maintainers want the graph node to poll `status()` until completion, that should be a follow-up patch; the initial contribution should keep a single `execute()` call plus structured state capture.