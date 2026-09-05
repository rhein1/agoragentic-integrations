# Risk Fork MCP host adapter

> **SOURCE-ONLY / SYNTHETIC DEMONSTRATION — NOT A REMOTE MCP TRANSPORT — NOT AN
> ISOLATION BOUNDARY — NO LIVE TRAFFIC PROTECTION**

The MCP host adapter is a provider-neutral source contract for placing the existing
Risk Fork host boundary in front of an MCP session lifecycle. It matches the
`{ openSession, executeFallback, timeouts }` host-adapter shape consumed by the
Agoragentic MCP enforcement boundary. The adapter itself has no socket, HTTP
client, credential, provider handle, or direct fallback transport.

The implementation is Apache-2.0 licensed with the rest of this package. Package
publication, a hosted service, E2B qualification, deployment, activation, and live
traffic protection are separate gates; this source file establishes none of them.

## What it enforces

`createRiskForkMcpHostAdapter()` accepts only two factory-created opaque
capabilities:

1. a `createRiskForkHostBoundary()` result, which owns the controller and trusted
   risk-descriptor source; and
2. a `createTrustedRiskForkMcpPhasePlanSource()` result, which resolves a bounded,
   request-bound phase plan on the clean host.

The returned object exposes exactly `openSession`, `executeFallback`, and
`timeouts`. Controller, provider, descriptor source, phase-plan callback, session
state, and transport state remain in module-private `WeakMap` records.

The adapter then applies this sequence:

```text
MCP enforcement request
  -> canonical request/hash/target/tool-metadata validation
  -> opaque clean-host phase-plan capability
  -> exact request-bound Savepoint Capsule + closed child operation
  -> RiskForkHostBoundary.preEffect()
  -> RiskForkController.prepare()
  -> provider savepoint/fork/execute/taint validation/destruction verification
  -> exact prepared-result and risk-decision binding checks
  -> authority-free MCP clean-import envelope
```

The gate runs before `server/discover`, `tools/list`, `tools/call`,
`resources/list`, `resources/read`, `prompts/list`, and `prompts/get`. Unknown
methods, HTTP fallback, redirects, direct network permission, caller-supplied low
risk, request replay, concurrent requests within one session, target changes, and
session-binding changes fail closed.

Before that gate, the Agoragentic MCP host validates the complete raw parameter
object within its depth, node, and byte limits, then erases the standard opaque
`_meta` member. Opaque transport/client metadata therefore cannot influence tool
classification, request hashes, host dispatch, persistence, or remote forwarding.
The actual operation arguments remain bound and scanned normally.

Caller `risk_profile` data is a minimum, not trusted classification authority. A
successful typed import must contain a controller risk decision at least as strict
as that minimum, and its normalized phase, server, tool name, annotations, and
capabilities must match the bound MCP request. An `IRREVERSIBLE` or
`prepare_only:true` request is rejected with
`RISK_FORK_MCP_ACTION_PROPOSAL_REQUIRED`; this adapter never disguises an action
proposal as a normal MCP tool result.

## Integration shape

After constructing the provider, controller, host-owned descriptor source, and
host boundary described in [README.md](./README.md), create a trusted phase-plan
source:

```js
import {
  createRiskForkMcpChildOperation,
  createRiskForkMcpHostAdapter,
  createRiskForkMcpPhasePlan,
  createTrustedRiskForkMcpPhasePlanSource,
} from '@agoragentic/risk-fork/mcp-host-adapter';

const phasePlans = createTrustedRiskForkMcpPhasePlanSource(
  async (planRequest, { signal } = {}) => {
    // Clean-host policy code only. Do not fetch a remote MCP response here.
    const responseSchema = responseSchemaForPhase(planRequest.phase);
    // Build a fresh capsule whose proposed_interaction binds every request field.
    const capsule = await buildFreshCapsule({
      planRequest,
      responseSchema,
      targetRef: `mcp-request:${planRequest.mcp_request_hash.slice(7)}`,
      signal,
    });

    return createRiskForkMcpPhasePlan(planRequest, {
      descriptor_ref: registerTrustedDescriptor(planRequest),
      operation_input: {
        capsule,
        savepoint_input: authorityFreeSavepointInput,
        operation: createRiskForkMcpChildOperation(planRequest, {
          response_schema: responseSchema,
        }),
        effective_arguments: planRequest.params,
        expected_commit_type: 'TYPED_RESULT',
        commit_policy: {
          typed_result_schema_hash: capsule.authorized_result_schema_hash,
        },
        expected_binding: {},
        network_policy: {
          mode: 'allowlist',
          allowlist: [planRequest.mcp_server_ref],
        },
      },
    });
  },
);

const hostAdapter = createRiskForkMcpHostAdapter({
  host_boundary: riskForkHostBoundary,
  trusted_phase_plan_source: phasePlans,
  max_sessions: 16,
  max_requests_per_session: 100,
});

// In the separate Agoragentic MCP host package:
const enforcementBoundary = createMcpEnforcementBoundary(hostAdapter);
const session = await connectRemoteClient({
  remoteUrl,
  enforcementBoundary,
});
```

`buildFreshCapsule`, `responseSchemaForPhase`, and `registerTrustedDescriptor`
are deliberately host-owned policy functions, not callbacks the model or remote
server may supply. The descriptor's owner policy must independently authorize the
same exact endpoint in `allowed_egress`. The descriptor registered for a
`tools/call` must reproduce the exact bound tool annotations and normalized
capabilities supplied in `planRequest`; the adapter checks them again against the
controller decision before import.

The `mcp_http_phase` object returned by `createRiskForkMcpChildOperation()` is a
closed, authority-free provider contract. It carries the exact request binding,
redirect rejection, response schema, byte bound, and timeout, but it does not
implement HTTP. A provider runner must explicitly support that operation and
enforce the allowlist inside its disposable child. No bundled runner does so yet.

The destination contract accepts only HTTPS URLs with public DNS names. It rejects
IP literals and local/special-use names, requires the child to resolve A, AAAA, and
CNAME records immediately before every connection attempt, permits only public
unicast answers, pins the selected address while retaining the original TLS SNI
and HTTP Host, disables environment proxies, and rejects redirects. The child must
return a closed, hash-bound transport-evidence wrapper; clean import rechecks the
requested/final URL, CNAME chain, resolved and selected addresses, TLS name, Host,
proxy status, redirect count, and evidence hash before exposing the MCP result.

That wrapper is a contract, not independent network proof. A production claim
requires a qualified executor to originate the observations at the actual socket
boundary and a trusted clean-side observer to corroborate them. A custom or test
provider can fabricate child-reported evidence, so the current source and tests do
not establish DNS-rebinding containment or live transport protection.

## Run the contained example

From this package directory:

```sh
node examples/mcp-host-adapter.mjs
node --test test/mcp-host-adapter.test.mjs
```

The example uses `LocalReferenceRiskForkAdapter`, a real `RiskForkController`, an
empty authority-free workspace, and real savepoint/fork/destruction lifecycle
calls. Its MCP responses are synthetic, predeclared typed-result fixtures. It does
not contact `mcp.agoragentic.com` or any other remote server. The JSON result states
`demo_only:true`, `isolation_boundary:false`, and `live_protection:false` and
verifies that both local savepoints and forks were destroyed.
The explicit `synthetic_demo_mode:true` option is required for that shortcut; the
adapter's default rejects predeclared results before provider allocation.

## Storage, deletion, and bounds

With the local reference provider, savepoints and disposable fork workspaces live
under that provider's configured `baseDirectory`; if none is supplied, the
provider creates an operating-system temporary directory. They are local files,
not GitHub, AWS, E2B, a VM, or an Agoragentic hosted service. Each phase destroys
its fork and savepoint and verifies absence before the adapter can return a clean
typed result. `LocalReferenceRiskForkAdapter.dispose()` remains the final owner
cleanup hook.

The default host bounds are 16 sessions, 100 requests per session, and 1 MiB per
request/plan. Request hashes are one-use within a session, and one request may be
in flight per session. A closing session retains its capacity reservation until
its underlying phase becomes terminal; a timed-out phase cannot be used to open
unbounded replacement sessions.

`open_session_ms` and `request_ms` are enforced inside this adapter as result
deadlines and are also consumed by the outer MCP host contract. The adapter passes
an abort signal to the trusted phase-plan resolver. The present
`RiskForkHostBoundary`/controller API does not accept a generic abort signal for
every provider stage, so a resolver or provider that ignores cancellation may
continue cleanup after the caller deadline. Capacity remains reserved until that
underlying work actually settles. A callback that never settles therefore causes
intentional fail-closed capacity exhaustion and requires host/operator recovery;
the source does not pretend it can kill arbitrary host code. `close_ms` is an
outer-host deadline, while this adapter's `close()` waits for terminal cleanup.

## Current limits blocking live use

- The live-default adapter accepts only an `mcp_http_phase` operation whose closed
  schema and bindings exactly match those emitted by
  `createRiskForkMcpChildOperation()`, plus an exact one-endpoint allowlist. The
  operation deliberately contains no predeclared response.
- There is no executor for `mcp_http_phase` in the current Local or E2B provider
  runners. Their implemented operation surface remains a closed
  `bounded_file_batch`; Local remains network-blocked and E2B live execution is
  hard-disabled.
- A phase-plan callback **must not fetch remote MCP content**. Doing so would put
  the risky network interaction on the clean host, outside the disposable fork.
- Predeclared `bounded_file_batch.commit_candidate` plans are rejected unless the
  host explicitly selects `synthetic_demo_mode:true`. That option exists only for
  the contained example/tests and is not a live fallback.
- A real provider still needs a separately reviewed `mcp_http_phase` executor,
  independently observed DNS/address enforcement, redirect rejection, bounded
  response import, and an explicit credential model.
- Current taint policy rejects authority/capability-shaped fields in child
  artifacts. Consequently, a fork-produced `tools/list` result cannot currently
  carry the complete `capabilities` declaration needed to classify a discovered
  tool as explicitly read-only. The MCP host correctly treats missing capability
  metadata as unknown/irreversible, and this adapter rejects the call rather than
  lowering its risk.
- This adapter imports a validated typed result; it does not call
  `commitPrepared()` and does not mutate parent state.
- The local reference provider is a protocol simulator, never a production
  isolation boundary. E2B remains non-live-qualified unless the separate
  credentialed qualification contract passes; this adapter does not relax that
  hard-false gate.
- The source has no automatic global agent discovery or activation. Each MCP host
  must explicitly construct the opaque capabilities and install this adapter at
  its mandatory network/session boundary.

Until those gaps are implemented and independently qualified, present this as a
source-complete host-boundary coordinator and honest local demonstration—not as a
universal MCP gateway or live Risk Fork protection.
