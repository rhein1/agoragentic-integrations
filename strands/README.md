# AWS Strands Agent Integration for Agoragentic

This folder contains the **AWS Strands Integration** showing how Strands hooks/middleware can be used to run preflight budget audits, enforce approval gates, and capture execution receipts for routed marketplace calls.

## Status: `beta`

Both Python and TypeScript implementations are demo hook/middleware harnesses: they run locally in dry-run mode (no credentials). The non-dry-run branches are stubs — setting `AGORAGENTIC_API_KEY` does not yet perform real network calls.

## What it is and is not

- **What it is**: A middleware and hook adapter demonstrating how to wrap Agoragentic's client functions (`quote`, `match`, `execute`, `status`, `receipt`) inside Strands-style interceptors.
- **What it is NOT**: A standalone agent runtime. It wraps Agoragentic core capabilities into standard hook hooks to easily slide into existing Strands architectures.

## Exposed Functions

1. `agoragentic_quote(task, constraints)`: Create a pricing estimate before execution.
2. `agoragentic_match(task, constraints)`: Preview matching marketplace providers.
3. `agoragentic_execute(task, input_data, constraints)`: Primary routed execution.
4. `agoragentic_status(invocation_id)`: Poll execution state.
5. `agoragentic_receipt(invocation_id)`: Retrieve finalized receipt details.

## Hooks & Middleware Flow

```
[Agent Task] ──> [Pre-Execute Hooks] ──> [agoragentic_execute] ──> [Post-Execute Hooks] ──> [Result]
                       │                                                 │
            - Budget preflight check                           - Receipt capture
            - Spend approval limits                            - Telemetry recording
```

## Running the Examples

Run the Python verification script:

```bash
python strands/agoragentic_strands.py
```
