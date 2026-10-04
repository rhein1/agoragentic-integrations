# Stateless host admission: source runbook

**Source-only, default-off, not production-qualified.** This runbook describes
explicit host wiring, not a deployed OAuth gateway or E2B service. It does not
authorize migrations, credentials, provider calls, spend, or activation.

## What is implemented

`createMcpPortableHandleRegistry` remains a synchronous, process-local reference.
The new async `createDurableMcpPortableHandleRegistry` uses a transactional store.
`createPostgresMcpPortableHandleStore` provides a separate schema with namespace,
binding, consumption, and migration records. Runtime initialization verifies the
reviewed migration hash and required enabled integrity triggers; it never runs
DDL. `migrateMcpPortableHandlesPostgres` is the explicit migration-owner operation.
It is independent of the distributed clean-commit authority and managed-service
schemas. Do not substitute one migration ledger for another.

Registration serializes namespace capacity and preserves a key fingerprint and
capacity policy. Consumption locks the binding, samples database time after lock
waits, validates its exact authenticated context, and atomically increments the
use count with an append-only receipt. Concurrent instances cannot spend the same
single-use binding twice. Same-request replay, revoked/expired bindings, context
substitution, key/capacity drift, and binding alteration fail closed. Lost commit
acknowledgement is not automatic retry authority.

## Construction sequence

1. Review the exact source and migration. Provision a dedicated database/schema,
   non-runtime migration owner, CA-validated TLS, and least-privilege runtime role.
2. In an explicitly approved migration environment, run the migration function.
   Do not invoke it at application boot or with production authority merely
   because the function is exported.
3. Construct the runtime store, stable host-secret HMAC key, and tenant registry.
4. Register a recognized cross-request handle only after validating its issuance
   on the clean host. Bind the host-derived principal digest, issuer, audience,
   server origin, originating method/request, expiry, and allowed consumers.
5. Install the pre-effect boundary with current authentication and exact field
   contracts. Every consequential/instruction-bearing request must use the host
   adapter; direct calls around it remain a bypass.

The following is host construction code, not a runnable deployment command:

```js
import { createPostgresMcpPortableHandleStore }
  from '@agoragentic/risk-fork/adapters/postgres-mcp-portable-handles';
import { createDurableMcpPortableHandleRegistry,
  createMcpPortableHandlePreEffectBoundary }
  from '@agoragentic/risk-fork/mcp-portable-handle-boundary';

const store = await createPostgresMcpPortableHandleStore({
  connectionString: runtimeDatabaseUrl,
  schemaName: 'risk_fork_mcp_handles',
  requireTls: true,
  tls: { ca: reviewedDatabaseCa },
});
const tenantRegistry = createDurableMcpPortableHandleRegistry({
  store, tenant_ref: hostTenantRef, key_id: hostKeyId,
  hash_key: hostSecretKey32Bytes, max_entries: 1000,
});
const portableHandles = createMcpPortableHandlePreEffectBoundary({
  authenticate: reverifyIngressCredential,
  registry_for_context: resolveRegistryForAuthenticatedTenant,
  contracts: [{
    phase: 'tools/call', tool_name: 'use_browser',
    tool_descriptor_hash: reviewedToolDescriptorHash,
    mcp_server_origin: 'https://mcp.example.com',
    handle_path: ['arguments', 'browser_ref'],
    binding_path: ['arguments', 'browser_binding'],
  }],
});
// createRiskForkMcpHostAdapter({ host_boundary, trusted_phase_plan_source,
//   portable_handle_boundary: portableHandles });
```

`reverifyIngressCredential(request, context)` is a trusted host capability. On
every call it must validate the current credential, revocation, issuer, exact
resource audience, and tenant/principal binding. It returns exactly
`tenant_ref`, SHA-256 `principal_ref`, `issuer`, `audience`, `mcp_server_origin`,
and `expires_at`. Never derive those from model arguments, client metadata, a
connection, or a previous successful request. `context.authentication` may carry
an opaque ingress capability but is not sent to the child. This callback seam
does not implement OAuth discovery, token exchange, or an outbound token broker.

The adapter resolves and validates its trusted phase plan before this boundary;
planning must be pure host policy, with no provider or remote MCP effects. The
boundary runs before `host_boundary.preEffect` can allocate a fork. Discovery
and listing phases authenticate too. `tools/call`, `resources/read`, and
`prompts/get` require explicit contracts; a missing contract is an error.
Both paths may be `null` only when host policy explicitly declares that operation
has no portable handle. Paths are bounded own data-property paths, never guessed.
Tool contracts bind the descriptor hash as well as name, phase, and origin.

After consumption the boundary rechecks current identity. Revocation, expiry,
cancellation, or identity drift during the database wait prevents the effect;
an already committed handle use stays spent. The returned closed receipt contains
hashes and evidence, not raw handles, credentials, or transferable authority.
The registry verifies the entire storage-returned binding/receipt against its
own constructed value; extra fields and self-hashed substitutions are rejected.

This is an admission-time check, not an atomic credential lock through every
later controller/provider await. A qualified host broker must recheck current
authority and enforce its fence at the actual socket/provider effect. The seam
does not claim to stop a subsequent revocation race or cancel arbitrary host
code by itself.

For the hosted bundle, use its exported registry and pre-effect factories so the
adapter and boundary share the same identity brand. The core PostgreSQL store is
a trusted construction dependency, not a branded child capability. The bundle
does not include this separate handle migration as an operational asset.

## Persistence, limits, and recovery

The HMAC key is host-secret state, not a provider key and not model-visible. Keep
the same 32-byte key and key ID across instances/restarts for a tenant namespace.
A mismatched key fails closed instead of reinterpreting existing hashes. Rotation
requires a new reviewed namespace/key ID; retain old keys only for approved
outstanding obligations and replay retention. Rotation cannot silently recreate
old authority. The resolver must select the right trusted namespace explicitly.

TTL is 1 second to a maximum of 5 minutes. Consumption counts are bounded to
1–1000, and `single_use` must agree with a one-use limit. Namespace capacity is
1–100,000 records; all records, including expired/revoked tombstones, count.
Capacity exhaustion intentionally stops registration. There is no unreviewed
automatic purge that could erase replay protection. A production retention and
capacity policy still needs qualification. Database deletion is not fork cleanup.

Closing a registry zeroes its own key copy, not the caller's key, and does not
delete persisted state. Closing the store ends only a pool it owns. Fork and
savepoint destruction remain provider lifecycle obligations before clean import;
they are not saved to GitHub by this registry. Database size depends on bounded
binding/receipt counts and PostgreSQL overhead; no fixed MB/GB claim is made.

MRTR, Tasks, subscriptions, MCP Apps, and authenticated child transport remain
disabled. Durable handles do not enable them or make serialized prepared results
clean-commit authority. The existing original-object provenance boundary remains.

## Validation and remaining gates

Run `npm test`, `npm run check`, and `npm run test:package` in `risk-fork`.
The PostgreSQL suite needs an isolated loopback test database named for tests:

```powershell
$env:RISK_FORK_TEST_POSTGRES_URL = 'postgresql://test_user:test_password@127.0.0.1:55437/risk_fork_test'
$env:RISK_FORK_REQUIRE_POSTGRES_TESTS = '1'
npm run test:postgres
```

Those are synthetic example credentials. The suite creates a unique schema and
drops only that schema afterward. It tests restart-equivalent separate instances,
cross-context denial, races, replay, expiry after lock waits, revocation, capacity,
integrity triggers, exact receipts, and contracted pre-effect consumption.

Runtime-role ownership/grant attestation is not yet equivalent to the existing
distributed-authority gate. Managed CA TLS, HA/failover, PITR/restore, rotation,
retention, authenticated edge/broker, live provider fencing, and multi-node
deployment conformance remain open in [deployment gates](./managed-service/DEPLOYMENT_GATES.md).
Local owner-role PostgreSQL tests are not those operational proofs.

The source checkout keeps E2B pinned at `2.39.0` while repairing its development
dependency closure: compatible `brace-expansion`/Undici 7 patches and an explicit
E2B-scoped `undici8` alias override to `undici@8.10.2`. The SDK's original optional
alias pins an affected version, so ordinary range updates are insufficient for
that edge. This is not live qualification or a security exception. npm overrides
are root-project policy, not a promise that downstream consumers receive them;
a host installing the optional SDK must review and exact-hash its own patched
dependency closure before any separately approved qualification run.
