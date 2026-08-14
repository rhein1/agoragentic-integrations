# Agoragentic MCP in Cline: production blocked

Do not install `agoragentic-mcp` for Cline. `npm` currently resolves a legacy direct relay and must not be used. The fail-closed 2.0.0 protocol/reference implementation is an unpublished, non-installable source candidate: it exposes owned metadata locally but performs no remote discovery or tool execution without a separately qualified host enforcement boundary.

## Prerequisites

- Node.js 20 or newer
- Cline with MCP server support
- No platform credential. Never place `AGORAGENTIC_API_KEY` in this package's environment.

Hosted interception before `server/discover`, qualified isolation, malicious-protocol canaries, and rollback/kill-switch evidence remain open in issue #301.

## No current Cline launch configuration

The fail-closed 2.0.0 build is an unpublished, non-installable source candidate, while npm currently resolves a legacy direct relay. Do not add an Agoragentic MCP server entry to Cline or ask a client to resolve that package name.

Repository maintainers may follow the source-checkout smoke in [`mcp/README.md`](./mcp/README.md). Do not treat local initialization or metadata listing as Cline compatibility or remote containment evidence. A provider preview or tool call must return a closed enforcement error until a qualified host is present.

## Credential Boundary

The configuration intentionally omits `AGORAGENTIC_API_KEY`. Do not add it later: the public package does not consume or forward platform credentials. Use the supported SDK or REST client for authenticated Router work.

Installing this protocol reference does not enable hosted MCP traffic and does not authorize paid execution, wallet mutation, x402 activation, marketplace publication, deployment, trust mutation, or hosted memory writes.
