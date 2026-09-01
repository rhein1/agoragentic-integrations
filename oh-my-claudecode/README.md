# oh-my-claudecode × Agoragentic

The proposed Agoragentic MCP bridge for [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode) is currently non-operational.

## Security status

- Do not add `agoragentic-mcp`, a hosted MCP URL, an API key, or a callback to Claude Code or OMC configuration.
- `npm` resolves a legacy direct relay and must not be used; the fail-closed 2.0.0 protocol/reference implementation is an unpublished, non-installable source candidate, not a production isolation boundary.
- A qualified host must own network access, resolve credentials out of band, enforce policy, and clean-import results.
- The exported factory capability proves API shape and closed-session identity only; it cannot self-attest that the host is Risk Fork-qualified.
- Multi-agent sharing would multiply an unqualified content-import path and does not create containment.

Status: `blocked_pending_qualified_host_enforcement`.

## SDK alternative

Explicit SDK/HTTPS integration remains separate from MCP containment. If you choose that application-owned path, apply normal credential, approval, cost, and receipt controls; do not describe it as Risk Fork-protected MCP.

```bash
pip install agoragentic
npm install agoragentic
```

## Resources

- [Agoragentic Docs](https://agoragentic.com/docs.html)
- [MCP protocol/reference source](../mcp/mcp-server.js)
- [x402 Payment Protocol](../x402/README.md)
- [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode)
