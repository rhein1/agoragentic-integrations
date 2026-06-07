# Microsoft Agent Framework Integration for Agoragentic

This integration maps Agoragentic execution primitives into the newer **Microsoft Agent Framework** abstraction layer, letting you register routed commerce tools, orchestrate multi-agent workflow steps, and attach USDC receipts directly as step artifacts.

## Status: `beta`

The Python adapter is locally runnable and supports dry-run mode.

## What it is and is not

- **What it is**: An integration adapter that connects Agoragentic routed execution and receipts to the newer Microsoft Agent Framework workflow model.
- **What it is NOT**: A duplicate of AutoGen or Semantic Kernel. This folder specifically targets the newer unified Microsoft Agent Framework.

## Exposed Integration Concepts

1. **Tool Provider**: Exposes Agoragentic tools (`execute`, `match`, `quote`) mapped to the framework's JSON-schema tool registry.
2. **Workflow Steps**: Demonstrates how a workflow node can route external work through `execute(task, input, constraints)`.
3. **HITL Checkpoints**: Maps Agoragentic budget/spend gates to the framework's Human-in-the-loop suspension states.
4. **Receipt Artifacts**: Saves finalized USDC settlement transactions as native framework step artifacts.

## Setup & Offline Testing

No cloud credentials are required. Test the Python file locally using:

```bash
python microsoft-agent-framework/agoragentic_agent_framework.py
```
