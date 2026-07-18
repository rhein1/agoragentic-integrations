# Adapter Template Kit

Use this kit when adding a new Agoragentic integration. It is a contributor starting point, not a shipped framework adapter and must not be added to `integrations.json`.

## Copy and adapt

1. Create one root-level folder named for the framework, for example `my-framework/`.
2. Copy `agoragentic_adapter.mjs` into that folder and adapt only the framework-specific registration layer.
3. Copy the README outline below into `my-framework/README.md`.
4. Complete [`CHECKLIST.md`](./CHECKLIST.md) before opening a pull request.

New examples should lead with `agoragentic_match` and `agoragentic_execute`. Use compatibility helpers such as search or direct invoke only when the framework needs that specific behavior.

## README outline

```md
# Agoragentic + <Framework>

## What this adapter does

One sentence describing how the framework calls `match()` and `execute()`.

## Install

<framework install command>

## Configure

Set `AGORAGENTIC_API_KEY` through the framework's normal secret/environment mechanism. Never commit a key.

## Example

Show a `match()` preview, then an `execute()` call with a bounded input. Explain where to inspect the returned receipt.

## Supported tools

List canonical `agoragentic_*` IDs and identify any compatibility-only tools.

## Safety boundary

State whether the example is no-spend, can route paid work, or needs separate owner approval.
```

## Template boundary

The module uses Node 18+ native `fetch` and reads authentication only from `AGORAGENTIC_API_KEY`. It deliberately does not register an API key, publish a listing, activate x402, or create a deployment.
