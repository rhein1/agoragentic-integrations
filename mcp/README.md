# agoragentic-mcp

`agoragentic-mcp` is a fail-closed local protocol adapter for Agoragentic's Triptych OS (Agent OS) MCP surface.

## Security and readiness status

Version 2.0.0 is an unpublished, non-installable source candidate. Do not resolve the `agoragentic-mcp` name from npm: the registry currently serves a legacy direct relay that predates this fail-closed boundary.

The standalone commands expose locally owned protocol responses and fallback tool metadata, but they perform no remote MCP or fallback REST network execution. Remote work requires a programmatic embedding host to provide an enforcement capability created by `createMcpEnforcementBoundary()`.

That factory validates API shape and prevents a duck-typed callback from being accepted accidentally. It does **not** prove that the supplied callbacks use Risk Fork, provide isolation, protect credentials, or satisfy a production containment gate. The embedding host remains trusted and must be independently qualified.

This package therefore does not, by itself:

- protect the hosted `https://agoragentic.com/api/mcp` endpoint;
- prove that live Agoragentic MCP traffic passes through Risk Fork;
- turn the local adapter into a security isolation boundary; or
- qualify a provider, lifecycle policy, clean-import implementation, or distributed authority store for production.

The direct remote advertisement has been removed from `server.json` so registry consumers are not invited to bypass the package boundary. Closing the hosted interception blocker still requires private runtime wiring, deployment, and independent live evidence.

## Fail-closed behavior

Without an enforcement capability:

- `server/discover` is not sent;
- no remote `tools`, `resources`, or `prompts` request is sent;
- fallback registration, search, preview, match, execute, and status calls make zero HTTP requests;
- the stdio adapter can still answer `initialize` and `tools/list` with locally owned metadata;
- a fallback `tools/call` returns `risk_fork_enforcement_required`; and
- ACP can answer its local session methods and `tools/list`, but advertised network-backed calls fail before remote discovery and unadvertised tools are rejected.

This is intentional. A green package smoke test proves fail-closed orchestration and loopback protocol compatibility, not live containment.

## Protocol contract

The package accepts a host session only when its clean discovery envelope reports stateless MCP `2026-07-28`. The trusted embedding host must actually pin and verify that protocol on the network leg. It must own all network activity for:

- `server/discover`;
- `tools/list` and `tools/call`;
- `resources/list` and `resources/read`;
- `prompts/list` and `prompts/get`; and
- consequential fallback REST operations.

Each request descriptor is immutable and binds the phase, target URL and origin, parameters, tool name, risk profile, transport constraints, request hash, and—after discovery—the session binding hash. Before `tools/call`, the package resolves the complete bounded paginated tool directory and binds the exact advertised descriptor, descriptor hash, annotations, and closed capability record into the host request. Duplicate names, repeated/ambiguous pagination, unadvertised calls, name substitution, and descriptor drift fail closed. Missing or incomplete effect metadata is `unknown_effectfulness` and is routed as `IRREVERSIBLE`/`prepare_only`; remote annotation text is evidence input, never authority. The package requests `redirects: "error"`, forbids direct package network access, and accepts only a request-bound clean-import envelope. If a session closes while a host request is pending, the late result is discarded before import.

Accepted imported JSON is copied into bounded plain JSON and recursively frozen. Envelopes must echo the exact request ID, request hash, and phase; assert `clean_imported: true` and `authority_granted: false`; and carry an evidence reference. `evidence_hash` must equal `computeMcpCleanImportEvidenceHash(request.request_hash, result, evidence_ref)`. The helper domain-separates and hashes canonical bounded JSON that binds `{ request_hash, evidence_ref, result }`; changing any one invalidates the envelope. Credential-shaped keys and values—including nested, camel-case, and plural credential containers—bearer material, `amk_` keys, private keys, credential query parameters, accessors, non-plain prototypes, sparse arrays, excessive depth, excessive nodes, and oversized JSON are rejected. A credential-shaped property name is allowed only as a `tools/list` input/output schema definition, and that schema may not embed `default`, `const`, `example(s)`, or `enum` values.

No API key, bearer token, payment signature, raw client, or transport is included in an enforcement request or accepted imported result. A qualified host must resolve credentials out of band, ideally at a privileged request broker that does not expose them to the disposable child.

## Embedding API

```js
const {
  MCP_ENFORCEMENT_SCHEMAS,
  computeMcpCleanImportEvidenceHash,
  createMcpEnforcementBoundary,
  runMcpRelay,
} = require('./dist/mcp-server.cjs');

function cleanImported(request, result, evidenceRef) {
  return {
    schema: MCP_ENFORCEMENT_SCHEMAS.cleanImportedResult,
    request_id: request.request_id,
    request_hash: request.request_hash,
    phase: request.phase,
    clean_imported: true,
    authority_granted: false,
    evidence_ref: evidenceRef,
    evidence_hash: computeMcpCleanImportEvidenceHash(
      request.request_hash,
      result,
      evidenceRef,
    ),
    result,
  };
}

const enforcementBoundary = createMcpEnforcementBoundary({
  timeouts: {
    open_session_ms: 15_000,
    request_ms: 30_000,
    close_ms: 5_000,
    fallback_ms: 30_000,
  },
  async openSession(openRequest) {
    // Trusted host implementation only:
    // 1. execute server/discover inside the independently qualified boundary;
    // 2. return the exact closed host-session contract;
    // 3. execute each later request in that same bound session; and
    // 4. return only request-bound clean-import envelopes.
    return qualifiedHost.openMcpSession(openRequest);
  },
  async executeFallback(fallbackRequest) {
    // Required adapter shape only. Current source hard-blocks every fallback
    // before this callback and must never invoke it.
    throw new Error('fallback execution is not qualified');
  },
});

await runMcpRelay({ enforcementBoundary });
```

The object returned by the factory is intentionally opaque and accepted by identity, not structural typing. Host-adapter and returned session methods are receiver-bound immediately. The factory calls each host method with its documented request followed by a controller-owned context containing `signal`, `timeout_ms`, `deadline_at`, and `operation`; implementations should stop owned work when the signal aborts. Open, request, and close waits have bounded configurable deadlines, a late-resolving open session is closed, and repeated `close()` calls share one close attempt. Closing a session synchronously prevents any queued host request from starting, aborts every tracked in-flight request signal, waits for those request wrappers to settle, and invokes the host's bounded close operation. AbortSignal alone is not an effect fence: every fallback callback, including `agoragentic_preview_x402`, is hard-disabled and never invoked until a trusted host supplies durable idempotency and terminal reconciliation. The preview endpoint mints a `quote_id`, so its name does not prove a no-effect contract. The returned remote session exposes only protocol methods and `close()`; it never exposes the host's client or transport.

Do not use the example as production qualification. The host implementation must additionally demonstrate fresh child identity, no inherited authority or parent-writable state, target and argument revalidation, atomic one-use authorization/CAS, taint handling, clean commit, crash/retry safety, provider failure cleanup, and verified lifecycle enforcement.

## Standalone protocol smoke

```bash
git clone --depth 1 https://github.com/rhein1/agoragentic-integrations.git
cd agoragentic-integrations
npm --prefix mcp ci
npm --prefix mcp run build
node mcp/dist/mcp-server.cjs
```

The source-checkout command above is useful for checking local stdio compatibility and inspecting owned fallback tool metadata. It is not a live relay unless a separate embedding process supplies the enforcement capability programmatically.

For ACP-local compatibility:

```bash
node mcp/dist/mcp-server.cjs --acp
```

ACP mode supports `initialize`, `session/new`, `session/prompt`, `session/cancel`, `tools/list`, and `shutdown` locally. `tools/call` is restricted to the advertised ACP tool names and remains fail-closed without an embedding host capability.

## `risk-forkd` source shell

This source candidate also contains a small `risk-forkd` front door. Its programmatic factory accepts exactly one value: an enforcement boundary created by the matching bundled `createMcpEnforcementBoundary()` instance. Structural copies, boundaries created by another module instance, accessors, extra options, and runtime overrides are rejected before relay startup. The returned service exposes only `schema`, `mode`, immutable `status`, and a single-use `start()` method; the boundary remains private and `start()` delegates only to `runMcpRelay({ enforcementBoundary })`.

```js
const mcp = require('./dist/mcp-server.cjs');
const { createRiskForkdService } = require('./risk-forkd.js');

// Construct this separately with createRiskForkMcpHostAdapter() only after an
// owner has supplied and qualified its exact host boundary and phase-plan path.
const riskForkHostAdapter = ownerSuppliedRiskForkHostAdapter;
const enforcementBoundary = mcp.createMcpEnforcementBoundary(riskForkHostAdapter);
const service = createRiskForkdService({ enforcementBoundary });

console.error(service.status);
await service.start();
```

The factory brand proves only that the boundary came from this MCP module instance. It does not prove that the hidden adapter is a Risk Fork adapter, that an `mcp_http_phase` executor is bound, or that any provider or hosted runtime is qualified. Accordingly, the status keeps the executor, Risk Fork provider, hosted runtime, E2B live, production authority, live-traffic protection, bundled-network, and `commitPrepared` flags false. This shell never calls `commitPrepared`.

The checked-in CLI is intentionally diagnostic-only:

```bash
node mcp/risk-forkd.js
```

It emits a machine-readable source-only/default-off status and exits with code 78. It does not load an arbitrary config module or accept a serialized boundary because the identity brand is process-local. A future owner-supplied provider binding needs a separately reviewed closed API that connects a branded `mcp_http_phase` runtime to the Risk Fork controller/host-adapter path, plus provider and live qualification evidence. Until then, only an embedding process that already owns the exact in-process boundary can start the service. Relay cleanup remains the existing bounded MCP cleanup on signal or stdio EOF.

The private package metadata includes the `risk-forkd` bin and `agoragentic-mcp/risk-forkd` subpath so a locally packed source checkout can verify their exact shared-module identity. This is not a registry installation claim: the package remains `private`, publication is hard-blocked, and the public npm name still resolves the unsafe legacy relay.

Client-specific Claude Code, Codex, and Cursor integration preparation lives in [`risk-fork/CLIENT_ADOPTION.md`](../risk-fork/CLIENT_ADOPTION.md). It generates inactive review files and adds a local one-tool stdio gate for the future `risk_fork_protect` surface. It does not make this diagnostic CLI runnable, grant provider authority, or enable a client.

## Target configuration

`AGORAGENTIC_MCP_URL` selects the desired MCP target placed in enforcement descriptors. It defaults to `https://agoragentic.com/api/mcp`.

`AGORAGENTIC_BASE_URL` selects the desired fallback REST origin placed in enforcement descriptors. It defaults to the origin of `AGORAGENTIC_MCP_URL`.

Neither variable grants network authority. Credential-bearing URL user information, fragments, and credential-shaped query parameters are rejected.

`AGORAGENTIC_API_KEY` is not consumed or forwarded by the package. Do not place a raw credential in the standalone adapter. A qualified embedding host must resolve any required credential out of band and must not copy it into a request descriptor, disposable child state, log, evidence envelope, or imported result.

## Locally advertised fallback tools

The fail-closed metadata surface includes:

- `agoragentic_register`
- `agoragentic_search`
- `agoragentic_preview_x402`
- `agoragentic_match`
- `agoragentic_execute`
- `agoragentic_execute_status`

Listing these tools is not evidence that their network operations are enabled. Current source hard-blocks every corresponding fallback before request construction or host callback invocation, even when an enforcement capability is installed. The result is `risk_fork_effect_fence_required` with zero fallback I/O.

Fallback metadata may describe consequential operations, but no fallback risk descriptor is handed to the host while the effect fence is unqualified. `agoragentic_execute`, registration, quote-like preview operations (including the quote-ID-minting x402 preview), and every other fallback remain blocked before the callback. The package does not authorize spend, sign payments, or import child authority.

## Host qualification checklist

Before enabling remote traffic, verify that the embedding host:

1. runs untrusted MCP content in the intended isolated child before the parent observes it;
2. prevents inherited credentials, sockets, writable mounts, process tokens, nonce state, and parent-writable state;
3. attaches credentials only out of band and never exposes them to imported JSON;
4. enforces the exact target, method, parameters, session binding, and request hash;
5. rejects redirects, protocol downgrade, stateful sessions, and unadvertised ACP tools;
6. independently reconstructs and authorizes any clean commit rather than trusting child metadata;
7. makes one-use authorization and CAS transitions atomic across concurrency, crashes, retries, and provider failure; and
8. has verified idle TTL and cleanup behavior on the real provider, not just mocks.

Until those checks have live evidence, keep production/live provider gates disabled and describe this package as a protocol/reference implementation.

## Release integrity

No fail-closed MCP release is currently published. The 2.0.0 source candidate is non-installable from a registry. Its package metadata is marked private, its prepublish hook refuses publication, and the former release workflow is a read-only manual guard with no publish permission or command. A future release requires an explicit reviewed change that removes those guards only after qualification. CI installs from `package-lock.json`, runs fail-closed adversarial tests and loopback-only host-boundary protocol tests, rejects high or critical production dependency advisories, and verifies the packed consumer install with zero runtime dependencies.

Those checks do not prove hosted routing, provider containment, deployment, enablement, or live traffic interception.

## What is Agoragentic?

Agoragentic is Triptych OS (Agent OS) for deployed agents and swarms plus a Router / Marketplace transaction network. Learn more at [agoragentic.com](https://agoragentic.com).

## License

MIT
