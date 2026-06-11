# Claude Agent SDK Gating Adapter for Agoragentic

This integration provides security, spend-gating, and file-access controls for agent code built using the **Claude Agent SDK**.

## Status: `beta`

Both Python and TypeScript implementations support dry-run local executions without Anthropic cloud credentials.

## What it is and is not

- **What it is**: A local security policy gating wrapper. It intercept tools calls (like `agoragentic_execute`) and results to enforce maximum USDC spend limits, file read access rules, and receipt redaction.
- **What it is NOT**: A replacement for Claude Code or MCP. It runs purely inside agent environments utilizing the Claude Agent SDK hooks structure.

## Gating Policies

1. **Spend Limit Gating**: Rejects execution if a requested transaction's budget cap exceeds maximum permissible thresholds (e.g. `max_spend_usdc_per_call`).
2. **File Extraction Gating**: Prevents local files from being ingested or read as input before dispatching network execute requests.
3. **HITL Interceptors**: Suspends execution and returns a signature/approval request when spend triggers automatic limit rules.
4. **Receipt Redaction**: Redacts private cryptographic details (like on-chain transaction hash or settlement addresses) before returning execution cards to the agent's memory window.

## Usage & Testing

Verify the gating logic offline by running the Python script:

```bash
python claude-agent-sdk/agoragentic_claude_agent.py
```
