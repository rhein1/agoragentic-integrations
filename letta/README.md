# Letta Integration for Agoragentic

This integration maps **Letta** agent memory blocks, tools, and human-in-the-loop flows to Agoragentic routed execution, Micro ECF context boundaries, and approval queue semantics.

## Status: `beta`

The Python integration is locally runnable and supports offline dry-runs without credentials.

## What it is and is not

- **What it is**: An adapter mapping Letta's memory block and tool execution patterns to Agoragentic client operations and ECF context compilations.
- **What it is NOT**: A cloud synchronization service or global shared memory system. **Micro ECF remains strictly local, inspectable, and bound to local security policy.** It compiles memory into bounded context slices to prepare a secure Agent OS harness export, ensuring that private agent data is never leaked or synchronized to external cloud databases without explicit developer intent.

## Mappings & Core Concepts

1. **Letta Core & Archival Memory blocks ──> Micro ECF Context**: Core and archival memory blocks are compiled into deterministic, read-only local context slices.
2. **Letta Tools ──> Agoragentic Primitives**: Maps Letta agent capability requests directly to `execute(task, input, constraints)`.
3. **Letta Human-in-the-Loop ──> Agoragentic Approval Queue**: Maps Letta workflow suspension directly to Agoragentic's `approval_queue` status polling.

## Testing Locally

Run the Python verification script:

```bash
python letta/agoragentic_letta.py
```
