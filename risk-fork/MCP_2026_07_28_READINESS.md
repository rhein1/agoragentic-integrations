# Risk Fork and MCP 2026-07-28 readiness

> **SOURCE-ONLY / DEFAULT OFF — NOT DEPLOYED — NO LIVE TRAFFIC PROTECTION**

Risk Fork targets the stateless MCP revision dated `2026-07-28`. This document
defines what the public source supports, how it treats the new attack surface,
and which production gates remain open. It is not a production qualification
record.

## Security objective

The stateless protocol removes connection-scoped sessions. Every request must
carry its protocol version and client capabilities, and any state that crosses
requests travels as an explicit value such as an application handle or MRTR
`requestState`. That makes ordinary arguments security-relevant: a handle
planted in untrusted content must not acquire the identity, credentials, or
authority of the agent that later presents it.

Risk Fork therefore applies these rules:

1. authenticate and authorize each request independently at the clean host;
2. bind every accepted portable handle to a hashed principal reference, exact
   issuer, exact MCP origin as audience, originating request digest, and a
   short expiry;
3. never treat client or server identity metadata as authorization evidence;
4. reject unknown, expired, cross-principal, cross-origin, cross-request, or
   already-consumed one-use handles before an effect;
5. keep bearer tokens and provider credentials out of handles, fork inputs,
   results, evidence, logs, and source-controlled files;
6. reject MCP Apps and active HTML by default until a separately qualified
   renderer, CSP/domain policy, and message boundary exist; and
7. require a new JSON-RPC request ID for any retry and never infer authority
   from a connection, process, prior request, or legacy session header.

The portable-handle API is explicit. Risk Fork does not guess that arbitrary
fields named `id`, `token`, or `handle` are safe or unsafe. A trusted host must
identify the exact value and bind or verify it at the mandatory pre-effect
boundary. Unbound values receive no handle-derived authority.

## Protocol support matrix

| MCP 2026-07-28 surface | Public source status | Production posture |
| --- | --- | --- |
| Client-facing stdio | SDK v2 dual-era server implemented | Modern clients may begin with `server/discover`; every later modern request is self-describing. Legacy initialization remains a compatibility lane, not modern-session authority |
| Per-request protocol version, client capabilities, and client info | Implemented for the child HTTP phase | Host-owned fixed metadata; caller `_meta` is not authority |
| `server/discover` | Implemented for the child HTTP phase | Clean output requires the exact `{ tools, resources, prompts }` boolean subset and binds it to the host session |
| `Mcp-Method`, `Mcp-Name`, and `x-mcp-header` | Implemented for the child HTTP phase | Derived from the same exact-bound operation and schema |
| Protocol sessions / `Mcp-Session-Id` | Rejected | No connection-scoped authority |
| Complete results and cache metadata | Validated and recorded as transport evidence | Application projection remains closed and authority-free |
| MRTR `input_required` / `requestState` / `inputResponses` | Not enabled | Exact-bound runner/adapter rejection carries only a typed code and hashes; no automatic retry or state echo |
| Tasks extension | Not advertised | Requires durable task ownership, expiry, cancellation, and per-request authorization |
| `subscriptions/listen` | Not advertised | Requires request-scoped streaming, cancellation, and bounded notification handling |
| MCP Apps / active HTML | Not advertised and rejected by the local relay | Requires a separately reviewed sandboxed renderer and content/message policy |
| Authenticated remote MCP | Not enabled in the child transport | Requires an out-of-band clean-host credential broker with exact issuer and audience validation |
| Legacy `initialize` stdio compatibility | Present only on the local adapter compatibility surface | Not evidence of end-to-end 2026-07-28 conformance |

MRTR, Tasks, subscriptions, Apps, and authenticated remote servers are useful
features, but merely accepting their fields would widen authority. They remain
disabled until their ownership and replay contracts are implemented and
adversarially qualified.

## Stateless request checklist

A production host must perform all of these checks on every request, including
retries:

- reject `Mcp-Session-Id`, cookies, redirects, ambient proxy use, and connection
  identity as state;
- require exact `2026-07-28` per-request metadata;
- verify `Mcp-Method` and `Mcp-Name` against the JSON-RPC body;
- derive the tenant and principal from current authentication, never from the
  request body or self-reported client information;
- validate the target origin and OAuth audience/issuer before attaching an
  access token at the privileged socket boundary;
- classify every explicit cross-request handle before it can influence resource
  access or a consequential tool call;
- use a fresh request ID on retry and bind any retry state to the original
  method and salient-parameter digest;
- recheck expiry, revocation, one-use state, budget, policy, and provider binding
  immediately before the effect; and
- import only an exact request-bound, authority-free result after verified
  cleanup.

## Production work, gates 1-6

1. **Independent source and threat review:** review the exact candidate, run
   dependency/secret/static checks, fuzz the stateless and handle boundaries,
   and resolve every material finding.
2. **Worker and enforcement bridge:** connect the managed control plane to the
   host boundary/controller/provider; drive CSPRNG leases, journal each provider
   resource immediately, renew leases, recover ambiguity, and prove
   destroy-before-clean-import ordering.
3. **Provider qualification:** qualify the exact E2B SDK/template/adapter under
   a separately approved credential and hard spend ceiling, including isolation,
   egress, TTL, cleanup, absence, latency, and cost evidence.
4. **Managed PostgreSQL qualification:** deploy the reviewed migration with
   split roles and CA TLS; qualify HA, failover, PITR, backup restore, retention,
   monitoring, capacity, and credential rotation.
5. **Service and edge operations:** add bounded public and private-worker HTTP
   runtimes, split least-privilege worker credentials, rate limits, WAF/DDoS
   controls, redacted telemetry, alerts, graceful shutdown, and an incident
   kill switch.
6. **Release, deployment, canary, and activation:** publish exact provenance,
   SBOM, and signatures; stage with no live traffic; run hosted malicious-MCP
   conformance; then use a separately authorized capped canary before any
   default-off production enrollment.

Source or CI completion in one gate does not complete a later gate. In
particular, no repository change can substitute for live provider, managed
database, deployed-edge, traffic-bound, or external-observer evidence.

## Current truth

```text
MCP 2026-07-28 child HTTP contract:  source available
client-facing stateless stdio:        source available with legacy compatibility
stateless handle binding primitive:  source available; process-local only
MCP Apps active-content posture:      source default deny at local relay import
MRTR / Tasks / subscriptions:         disabled, fail closed; MRTR/task rejection is hash-only
authenticated remote MCP:             disabled
host worker wired:                    false
provider qualified for service:       false
managed PostgreSQL qualified:         false
deployed:                             false
production activated:                 false
live agent traffic protected:         false
```

The detailed service checklist remains in
[`managed-service/DEPLOYMENT_GATES.md`](./managed-service/DEPLOYMENT_GATES.md).
The host boundary is described in [`MCP_HOST_ADAPTER.md`](./MCP_HOST_ADAPTER.md),
and client review packets are described in
[`CLIENT_ADOPTION.md`](./CLIENT_ADOPTION.md).

Protocol references: the official
[`2026-07-28` release announcement](https://blog.modelcontextprotocol.io/posts/2026-07-28/),
the official [specification changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog),
and the threat report that motivated the planted-handle and Apps review,
[“MCP's new spec turns a planted prompt into a stolen credential”](https://venturebeat.com/security/mcps-new-spec-turns-a-planted-prompt-into-a-stolen-credential).
