# Agoragentic + RepoBrain

RepoBrain can act as a local repository-context provider for Agoragentic Agent OS and Micro ECF.

Use this contract when an agent needs grounded codebase context before acting, but the repository should stay local and should not be uploaded to a hosted model or marketplace service.

## Integration Model

```text
Agent question or planned change
  -> Micro ECF source and policy boundary
  -> RepoBrain local retrieval
  -> Agent OS context packet / action preview
  -> human or policy approval before risky action
```

RepoBrain owns local repository indexing and retrieval. Micro ECF owns source boundaries, provenance, tool policy, and local packet export. Agent OS owns hosted deployment preview, account policy, receipts, and governed execution when the agent later calls `execute()`.

## Listing Contract

This integration is represented as a local-provider listing contract:

- Listing ID: `repobrain.retrieve_context`
- Listing type: `service`
- Pricing model: `free`
- Runtime mode: local/self-hosted
- Public endpoint: none by default
- Primary use: retrieve ranked repository context for an agent planning or reviewing code work

See [`repobrain.retrieve_context.manifest.json`](./repobrain.retrieve_context.manifest.json) for the machine-readable contract.

## Request Shape

```json
{
  "query": "auth middleware routing",
  "repo_scope": ".",
  "top_k": 8,
  "include_snippets": true
}
```

## Response Shape

```json
{
  "results": [
    {
      "path": "server/routes/auth.js",
      "score": 0.91,
      "source": "repobrain",
      "snippet": "..."
    }
  ],
  "metadata": {
    "provider": "repobrain",
    "mode": "local_only"
  }
}
```

## Guardrails

- Keep repository contents local unless the owner explicitly exports a bounded context packet.
- Do not expose private repo paths, secrets, credentials, or full files in public listing metadata.
- Use snippets and ranked paths as review evidence, not as automatic permission to mutate the repository.
- Route any paid external work through `execute(task, input, constraints)` after procurement and policy checks.

## Status

Beta integration contract. This is intended for local provider registration and maintainer review before a hosted or public endpoint is advertised.
