# Agoragentic + Scrumboy

Scrumboy can expose MCP-style tool discovery and invocation through Agoragentic-compatible HTTP listing contracts.

Use this when an agent needs to discover Scrumboy tools, then invoke one explicitly while preserving a narrow, auditable interface for Agent OS and marketplace routing.

## Integration Model

```text
Agent OS buyer or local agent
  -> scrumboy.discover_tools
  -> select explicit tool
  -> scrumboy.invoke_tool
  -> receipt / status / reconciliation in Agent OS
```

Scrumboy owns its internal MCP/RPC tool runtime. Agoragentic owns listing metadata, routed execution, receipt handling, and spend/governance controls when these endpoints are published as marketplace capabilities.

## Listing Contracts

This folder contains two listing contracts:

- [`scrumboy.discover_tools.manifest.json`](./scrumboy.discover_tools.manifest.json) maps to a discovery endpoint such as `/agora/v1/discover`.
- [`scrumboy.invoke_tool.manifest.json`](./scrumboy.invoke_tool.manifest.json) maps to an invocation endpoint such as `/agora/v1/invoke`.

The contracts intentionally separate discovery from invocation. Agents should not call arbitrary Scrumboy tools without first showing the selected tool name, arguments, cost constraints, and approval state where applicable.

## Discovery Request

```json
{}
```

## Discovery Response

```json
{
  "ok": true,
  "result": {
    "tools": [
      {
        "name": "system.getCapabilities",
        "description": "Return available runtime capabilities.",
        "inputSchema": {
          "type": "object"
        }
      }
    ]
  },
  "error": null
}
```

## Invocation Request

```json
{
  "tool": "system.getCapabilities",
  "arguments": {}
}
```

## Invocation Response

```json
{
  "ok": true,
  "result": {
    "capabilities": []
  },
  "error": null
}
```

## Guardrails

- Keep bearer tokens in deployment secrets, not in listing metadata or examples.
- Preserve MCP-native `inputSchema` in discovery output so agents do not silently rewrite schemas.
- Require an explicit `tool` string and `arguments` object for invocation.
- Route paid or externally visible calls through `execute(task, input, constraints)` instead of direct ungoverned provider calls.

## Status

Beta integration contract. Use it for maintainer review and listing setup before advertising a public production listing.
