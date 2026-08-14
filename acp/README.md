# Agoragentic Agent OS - Agent Client Protocol Adapter

This adapter lets Agent Client Protocol (ACP) clients exercise the local Agoragentic protocol surface through stdio. It is deliberately fail closed for network-backed tool calls unless an embedding host supplies a separately qualified enforcement implementation.

Agoragentic is Triptych OS (Agent OS) for deployed agents and swarms. This public adapter does not by itself protect or enable live hosted MCP traffic.

## Registry installation unavailable

The fail-closed 2.0.0 candidate is unpublished and non-installable from a registry. Do not resolve `agoragentic-mcp` from npm; the current registry release is a legacy direct relay.

For a repository-owned local protocol smoke, build and run the source checkout:

```bash
git clone --depth 1 https://github.com/rhein1/agoragentic-integrations.git
cd agoragentic-integrations
npm --prefix mcp ci
npm --prefix mcp run build
node mcp/dist/mcp-server.cjs --acp
```

The final command starts only a local protocol/reference process. Supplying `AGORAGENTIC_API_KEY` does not unlock remote transport and is not a substitute for host enforcement. Credentials must be resolved out of band by the qualified host and must never appear in request descriptors or clean-imported envelopes.

## Agent Registry File

The Agent Client Protocol registry entry is [`agent.json`](./agent.json). It points Agent Client Protocol clients to:

```json
{
  "command": null,
  "args": [],
  "source_checkout": {
    "command": "node",
    "args": ["mcp/dist/mcp-server.cjs", "--acp"]
  }
}
```

`command: null` prevents registry consumers from resolving or auto-launching the legacy npm package. The source-checkout metadata is informational and requires the explicit build steps above.

## Tool status

`tools/list` returns a compatibility inventory whose descriptions state the enforcement requirement. The registry recommends no executable tools while the adapter is blocked. Every advertised network-backed `tools/call` fails with `MCP_RISK_FORK_ENFORCEMENT_REQUIRED` unless an embedding host supplies the factory-created capability. That capability proves only API shape and closed-session identity; it does not self-attest that the host is Risk Fork-qualified. Arbitrary unadvertised tool names are rejected before a remote session can be opened.

Local `initialize`, `session/new`, `session/prompt`, `session/cancel`, and `shutdown` responses remain available because they do not perform remote I/O.

## Local Verification

```bash
node scripts/verify-acp.js
```

The verifier checks the disabled registry launch fields, source-checkout metadata, icon, JSON-RPC notification behavior, local handshake, advertised inventory, arbitrary-tool rejection, and the zero-I/O enforcement failure for an advertised tool call.
