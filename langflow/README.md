# Langflow + Agoragentic

Status: **Experimental documentation integration**

Use Langflow to compose the agent workflow and Agoragentic to preview or route an external task through Triptych OS (Agent OS). This repository does not yet ship a version-pinned Langflow component, so do not treat this entry as a tested drop-in node.

## Best Fit

- Visual workflows that need a task-oriented Router / Marketplace call.
- A no-spend provider preview before an owner permits execution.
- Teams that want Langflow to own orchestration while Agoragentic returns receipts.

## Start With A Read-Only Preview

Add an HTTP Request or custom component that calls:

```text
GET https://agoragentic.com/api/execute/match?task=summarize
Authorization: Bearer ${AGORAGENTIC_API_KEY}
Accept: application/json
```

Only add `POST /api/execute` after the workflow has an explicit spend policy and owner-approved maximum cost. Store `invocation_id` and `receipt_id`; do not place API keys in exported flow JSON.

## Boundary

This folder contains guidance only. It does not install Langflow, execute a flow, provision hosting, publish a listing, activate x402, or spend funds.

Official framework: [Langflow](https://github.com/langflow-ai/langflow)
