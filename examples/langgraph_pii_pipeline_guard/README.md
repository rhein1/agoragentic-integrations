# LangGraph PII Pipeline Guard Demo

This demo proves that Agoragentic can wrap an existing LangGraph-style data pipeline with privacy, policy, approval gates, and run receipts without forcing a stack migration.

Do not rebuild your graph. Wrap it with Agoragentic.

## What This Demo Proves

- LangGraph can stay responsible for orchestration.
- A local Agoragentic-style guard runs before simulated model and tool calls.
- Direct identifiers are masked before model input.
- Capability policy decides which tools can run.
- Raw export is denied.
- External send requires approval and does not execute automatically.
- Every run emits a public-safe JSON receipt.

The demo is local-only. It does not call Agoragentic hosted APIs, external email, Slack, export services, model providers, wallets, x402 rails, or marketplace publication endpoints.

## Why This Is Not A LangGraph Replacement

LangGraph remains the workflow layer: graph state, node sequence, branches, checkpoints, and supervisor logic still belong there. Agoragentic is demonstrated here as the control layer around the run: policy contracts, PII masking, capability permissions, approval gates, and receipts.

If your graph already works, the hard part may be governance around the run rather than orchestration. This example keeps that boundary clear.

## Architecture

```text
customer CSV row
  -> classify_record node
     -> guard_model_input masks PII before simulated model input
  -> summarize_record node
     -> simulated model sees masked state only
  -> route_action node
     -> guard_tool_call checks capability policy before mock tool execution
  -> receipt.json
     -> redacted evidence of masking, decisions, approvals, and denied actions
```

`src/pipeline.py` uses LangGraph when the `langgraph` package is installed. If it is not installed, the same three logical nodes run through a deterministic fallback so tests remain local and dependency-light.

## Policy File

`policies/pipeline_policy.yaml` defines:

- `pii_masking_required: true`
- `raw_pii_export_allowed: false`
- `summarize_ticket`, `classify_risk`, and `escalate_to_manager` as allowed after masking
- `send_email_to_customer` as `approval_required`
- `export_raw_rows` as denied
- receipt fields that must be emitted

## PII Masking

The guard masks:

- email -> `[EMAIL_REDACTED]`
- phone -> `[PHONE_REDACTED]`
- account ID -> `[ACCOUNT_ID_REDACTED]`
- customer ID -> `[CUSTOMER_ID_REDACTED]`
- name -> `[NAME_REDACTED]`

Tests prove raw identifiers do not appear in guarded model inputs, summaries, tool payloads, or receipts.

## Run Locally

```bash
cd examples/langgraph_pii_pipeline_guard
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
python src/pipeline.py
```

On Windows PowerShell:

```powershell
cd examples/langgraph_pii_pipeline_guard
python -m venv .venv
.\\.venv\\Scripts\\Activate.ps1
pip install -r requirements.txt
python src\\pipeline.py
```

The run writes:

```text
out/receipt.json
```

## Test Locally

```bash
cd examples/langgraph_pii_pipeline_guard
pytest tests
```

From the repository root:

```bash
python -m pytest examples/langgraph_pii_pipeline_guard/tests
```

## Receipt Example

The exact counts depend on the sample records, but the receipt shape is stable:

```json
{
  "pipeline_name": "langgraph_customer_ticket_guard_demo",
  "run_id": "example_run_id",
  "policy_version": "local_demo_v1",
  "records_processed": 10,
  "pii_detected": true,
  "redactions_applied": {
    "account_id": 10,
    "customer_id": 10,
    "email": 10,
    "name": 10,
    "phone": 10
  },
  "model_calls_guarded": 20,
  "approval_required": true,
  "denied_actions": 2,
  "external_services_called": false,
  "raw_pii_exported": false,
  "receipt_hash": "sha256:..."
}
```

The receipt intentionally excludes raw customer records, raw model prompts, raw tool outputs, provider credentials, account data, payment payloads, wallet-private fields, and private platform internals.

## Product Positioning

This demo answers a practical developer question: if LangGraph or CrewAI is already mostly working, should you migrate just to get guardrails?

The safer first test is to keep your graph and wrap the run. Agoragentic is positioned here as a framework-agnostic control layer around agent and pipeline execution, where every run can produce evidence of what data was touched, what was masked, what tools were allowed, what tools were denied, and what required approval.
