# Risk Fork managed-service source scaffold

This directory contains a **source-only, default-off control-plane scaffold** for a future managed Risk Fork service. It is locally testable. It is not published, hosted, deployed, provider-qualified, production-qualified, or authorized to protect live agent traffic.

The package is deliberately marked `private: true`. No listener, deployment manifest, cloud account, database, provider credential, or production activation path is included. `MANAGED_SERVICE_PRODUCTION_QUALIFIED` is a hard-coded `false`; configuration cannot turn this source tranche into a production service.

## What this tranche implements

- tenant identity derived from a verified API-key record rather than request body input;
- one-way, domain-separated API-key hashes, bounded bearer parsing, expiry, revocation, and scoped permissions rechecked on every programmatic call;
- authority-free operation validation using the parent Risk Fork `validateChildOperation` boundary;
- tenant-scoped idempotency with same-key/different-request rejection and exact replay across provider-binding rotation or tighter restart policy;
- hard per-invocation cost, UTC-day budget, and concurrent-invocation admission limits;
- versioned, locally qualified provider bindings keyed by an immutable capability snapshot, exact adapter digest, qualification-receipt hash, and canonical tenant allowlist, with source-adapter drift rechecked before use;
- execution, cleanup, and recovery leases that require a caller-generated URL-safe CSPRNG token, persist only its domain-separated hash in a tenant-wide uniqueness tombstone, and support tightly bounded delivery replays;
- an explicit invocation state machine with fail-closed accounting and a blocking recovery path for untracked resources;
- independent savepoint/fork journaling with durable exact-response receipts, partial-resource recovery, and verified cleanup of every recorded resource before a terminal transition;
- hash-chained, append-only control-plane audit receipts that are clearly labeled self-attested;
- a memory store for deterministic local tests and a PostgreSQL store/migration source path;
- host-neutral JSON request handling for health, readiness, tenant, worker, and audit routes.

## Architecture

```text
agent or framework
        |
        | bearer token (never persisted raw)
        v
HTTP adapter -> authenticator -> tenant-bound control plane
                                   |              |
                                   |              +-> exact-bound local-test provider registry
                                   v
                         memory or PostgreSQL store
                                   |
                                   +-> admission reservation + idempotency
                                   +-> leases + lifecycle state
                                   +-> resource-journal replay receipts
                                   +-> append-only hash-chain audit
                                   |
                            worker claims one item
                                   |
              host-owned RiskForkController/provider/recovery bridge
                                   |
                 destroy fork + savepoint and verify absence
                                   |
                  terminal completion or failed-closed state
```

The host-owned worker bridge in the diagram is an explicit remaining integration boundary. A qualified implementation must wrap the existing `RiskForkController` and `RiskForkProvider` calls, pass `provider_recovery_key` as an immutable provider idempotency/tagging identity, journal each savepoint/fork reference independently as soon as it exists, renew its lease, and submit the existing cleanup-verification evidence. The scaffold never creates, executes, destroys, or searches for provider resources by itself.

Each provider binding supplies exact adapter and qualification hashes plus three server-owned verifier callbacks: `verify_resource_binding`, `verify_cleanup_evidence`, and `verify_recovery_absence`. Registration descriptor-screens and snapshots the provider capability surface and method identities, exposes an immutable provider facade, and fails readiness or later use if the source adapter drifts from that binding. The callbacks receive the normalized tenant and must verify provider-authenticated evidence for the exact tenant, adapter binding, immutable recovery key, resource kinds, and resource references. They are invoked only after an active lease preflight and must fail closed. Verifiers are observational checks, not mutation hooks: they must be read-only, retry-safe, and free of provider effects because two genuinely simultaneous resource-journal deliveries can both reach verification before one serializable store transaction wins. Historical disabled bindings and their original tenant mapping remain cleanup/recovery-only and must stay registered until all exact-bound nonterminal invocations drain. Readiness requires an enabled exact binding for `admitted`, `execution_leased`, and `running` work, while `cleanup_pending` and `recovery_required` may drain through the disabled historical binding. The local fixtures use in-process allowlists only; they are not production proof.

An idempotency retry is normalized under immutable protocol ceilings, then matched against a hash of only the client-controlled request (`provider_id`, operation, and estimated cost) before applying current runtime admission limits or selecting a currently enabled provider binding. An exact retry therefore returns the original invocation, binding, and recovery key after a restart, binding rotation, or tighter configured request/cost/idempotency limit; only a genuinely new idempotency key is subject to current limits and provider eligibility. The store repeats the same comparison inside its atomic admission transaction to close concurrent-create races.

## Claim delivery and replay contract

Every new logical execution, cleanup, or recovery claim must include a fresh `lease_token` generated by the worker with a cryptographically secure random-number generator before it sends the request; delivery retries must reuse that exact token. The token must be 32–512 ASCII bytes and match the URL-safe alphabet `[A-Za-z0-9._~-]`; generating 32 random bytes and encoding them as unpadded base64url is the recommended minimum. The worker must retain that raw token in its own secret-bearing attempt state. The control plane stores only a domain-separated SHA-256 hash. Raw lease tokens must never be persisted by the service or written to audit details, metrics, traces, or logs.

The first successful claim returns `claim_replayed: false`. If its response is lost, an exact immediate-post-claim retry by the same authenticated key, for the same tenant, invocation, purpose, and token, returns `claim_replayed: true` and the same work item. Repeated identical delivery retries may return that same result only while this narrow replay window remains open. A replay is delivery recovery only: it does not extend the lease, advance its generation, change its owner or worker metadata, append another audit event, or grant any additional authority. An execution replay returns the original validated operation; cleanup and recovery replays never expose it.

Replay is allowed only while the original lease is active and the claim remains the invocation's latest committed action. Any renewal, partial or complete resource journal, lifecycle transition, outcome, cleanup, recovery update, expiry, or reaping closes the replay window. An expired lease must be reaped before another claim, and a durable hash-only tombstone prevents a historical token from ever acquiring any later lease for the same tenant, including a lease on a different invocation. A mismatched token, owner, purpose, tenant, or invocation does not replay the claim.

Workers must treat one lease token as one logical work attempt. They may repeat the same claim request only to resolve an unknown delivery result; concurrent or delayed successful responses for that token must converge on the same local attempt and must never start a second execution, cleanup, recovery search, or provider effect. A fresh logical attempt after expiry or reaping requires a newly generated token.

Resource-journal delivery has a separate durable replay contract. The service hashes the canonical request, including tenant, invocation, authenticated claimant, lease-token hash, both resource references, and the sorted provider-attested absence kinds. The first committed journal transition stores that hash, the claimant and token hashes, and the exact public response plus its integrity hash in the same transaction as the state and audit mutation. An exact retry first checks the receipt before reading mutable invocation state or calling the provider verifier; the store rechecks the receipt while holding the invocation lock so concurrent, post-completion, and recovery retries converge on the winner's exact response. Every replay still requires the original claimant credential to be active. A changed reference, absence set, claimant, or token is a different request and receives no replay authority. At most one state transition, audit event, and receipt commit for a canonical journal request; simultaneous callers may both perform the explicitly read-only verifier check before the transaction converges.

## Invocation lifecycle

```text
admitted
  -> execution_leased
     -> execution_leased (savepoint or fork independently journaled)
  -> running
  -> cleanup_pending
  -> completed       (execution succeeded and every recorded-resource cleanup verifies)
  -> failed_closed   (execution failed/ambiguous and every recorded-resource cleanup verifies)

execution_leased expires before both resource refs are recorded
  -> recovery_required
  -> recovery lease + provider lookup by provider_recovery_key
     -> both refs found -> cleanup_pending -> verified cleanup -> failed_closed
     -> one ref found + other kind attested absent -> cleanup_pending -> verified cleanup -> failed_closed
     -> no refs found -> provider-attested absence -> failed_closed
```

An expired running lease with both resource references moves to `cleanup_pending`. If an execution lease expires before both references were recorded, it moves to `recovery_required` while preserving every independently journaled reference and cleanup request. Both cases record an `ambiguous` outcome and consume the full reserved cost as a worst-case accounting bound. `recovery_required` makes readiness false and blocks every new admission and every queued execution claim for that tenant, even for zero-cost requests, until a recovery worker accounts for both resource kinds: both found, one found plus one provider-attested absent, or both provider-attested absent. An expired execution lease that the reaper has not processed yet also makes readiness false and blocks admission and queued execution claims inside the same store transaction, so scheduler delay cannot open new execution authority. Cleanup is required only for resources proven to exist. Recovery work is excluded from ordinary concurrency accounting only because admission and new execution are blocked more strictly.

Expired cleanup and recovery leases are reaped and remain retryable in their existing states. The reaper changes durable control-plane state only: it does **not** claim that a cloud resource was deleted or absent. Cleanup/recovery workers must obtain the provider evidence, and the configured exact-bound verifier must attest it before a terminal transition.

An admitted item that is never claimed expires to `failed_closed` after the configured maximum age and releases its unused reservation. The execution-claim transaction independently enforces the same age boundary, so a delayed sweeper cannot revive stale authority. Execution authority is also tied to the invocation's admission UTC budget day: a claim on a later day fails, and an execution claim or renewal cannot extend past the next UTC midnight. At that boundary the expired execution fence requires reconciliation before new authority can overlap it. This prevents abandoned admissions from executing late, carrying prior-day reserved authority into a fresh daily allowance, or consuming tenant concurrency and budget forever.

## Authentication and tenant boundary

`createManagedAuthenticator()` looks up a domain-separated SHA-256 key hash. PostgreSQL stores `key_hash`, never a raw bearer token, and filters not-before, expiry, and revocation using its own clock before returning a record; the application check remains an additional fail-closed check. Each principal and verifier are bound to that exact authenticator/store instance; another authenticator's principal and caller-created verifier functions are rejected. Every control-plane call re-resolves the key record and rechecks its hash, expiry, revocation, tenant, key id, and requested scope. Every tenant-visible invocation and audit query includes both `tenant_id` and `invocation_ref`.

The current source scopes separate tenant APIs, worker mutation, and audit reads:

- `invocations:write`
- `invocations:read`
- `worker:claim`
- `worker:write`
- `audit:read`

Tenant and API-key provisioning are administrator operations and are not exposed as network routes in this tranche.
Execution, cleanup, and recovery workers still share the two worker scopes in this scaffold. A hosted service must split those roles into distinct credentials/routes before qualification; payload minimization already ensures cleanup and recovery claims do not return the original operation arguments.

The durable `lease_owner` is the authenticated API-key `key_id`, not the caller-supplied `worker_id`. Every lease preflight, renewal, resource journal, lifecycle transition, outcome settlement, cleanup completion, and recovery completion requires that exact API-key identity to remain active; another worker key from the same tenant cannot continue the lease even if it obtains the raw lease token. PostgreSQL repeats the owner and active-credential predicates in each decisive mutation. The caller-supplied `worker_id` is retained only in the hashed audit detail as `worker_instance_ref` and is explicitly self-asserted metadata; it cannot impersonate another credential in state or audit attribution.

The API-key bearer token and the per-claim `lease_token` serve different purposes. The bearer authenticates and scopes the worker; the lease token correlates one logical claim attempt and is accepted only with the same authenticated lease owner. Possession of a lease token alone grants no authority.

## Admission and abuse bounds

The control plane reserves integer `estimated_cost_micros` before accepting work. Deployers must define what that unit prices and bind it to a qualified provider quote before production use. The reservation is constrained by the lower of global and tenant-specific per-invocation, UTC-day, and concurrency limits. Actual cost may not exceed the reservation. Settlement and the transition to cleanup are one store transaction. PostgreSQL validates application-clock skew at transaction entry, then refreshes its authoritative clock after lock waits for budget days, leases, transitions, evidence deadlines, and audit timestamps. A real worker must stop effects when its lease ends; the control-plane lease is authority, not a mechanism that can terminate an unimplemented external worker.

These controls bound admitted work but are not a complete public-edge abuse defense. Production still needs authenticated key issuance, per-key request-rate limits at the edge, payload and connection timeouts, WAF/DDoS controls, monitoring, alerting, and an incident-disable path.

## Local tests

From a clean repository checkout, install both locked package roots because this scaffold deliberately reuses the parent Risk Fork source and its PostgreSQL adapter dependency:

```powershell
npm --prefix risk-fork ci --ignore-scripts --no-audit --no-fund
npm --prefix risk-fork/managed-service ci --ignore-scripts --no-audit --no-fund
```

Then, from this directory:

```powershell
npm test
npm run check
```

The default test run is provider-free and makes no live database or external network calls. It uses the in-memory store, no-I/O provider fixtures, and injected PostgreSQL contract doubles. It does not contact E2B, GitHub, Agoragentic, or any other remote service, and it does not spend money. The syntax check also rejects network/process runtime imports, provider SDK imports, browser-style outbound APIs, and listeners from the managed-service runtime source.

An opt-in PostgreSQL integration test also exists. It runs only when `RISK_FORK_MANAGED_TEST_POSTGRES_URL` points to the loopback database named exactly `risk_fork_managed_test` **and** `RISK_FORK_MANAGED_TEST_CONFIRM_DISPOSABLE=YES_DELETE_DATA` is set. Each run creates a unique validated schema and drops that exact schema in `finally`. The normal test command skips it; CI uses an ephemeral PostgreSQL service, and an operator must never point it at a shared or production database. The `managed-service` job in `.github/workflows/risk-fork.yml` is selected whenever `risk-fork/**` or that workflow changes, installs both package roots from their committed lockfiles, and runs the syntax and full disposable-PostgreSQL test suite on Node.js 20, 22, and 24. CI also sets `RISK_FORK_MANAGED_REQUIRE_POSTGRES_TESTS=1`, so missing or malformed database configuration fails instead of silently turning the integration test into a skip.

## PostgreSQL source path

The PostgreSQL layer includes:

- composite tenant/invocation keys and tenant-scoped idempotency;
- serialized tenant admission through a locked tenant row;
- locked UTC-day usage buckets for atomic budget reservations;
- lease state, tenant-wide hash-only historical token-use tombstones, resource references, cleanup requests, and result/evidence hashes;
- durable resource-journal receipts containing canonical request, claimant/token, exact-response, and response-integrity hashes;
- immutable provider binding, qualification, adapter, and recovery-key hashes per invocation;
- append-only audit rows protected from update and delete by triggers;
- database-clock lease/budget decisions and bounded caller-clock skew;
- readiness checks for all required tables, both append-only triggers, exactly the reviewed migration set/hash, safe durability settings, zero recovery backlog, zero unswept expired execution leases, and retained exact provider bindings for every nonterminal invocation;
- CA-pinned TLS pool construction through `createPostgresManagedServiceStore()`; a caller-supplied pool is rejected whenever TLS is required, and factory-owned pools have an idempotent `close()` path.

`migrateManagedServicePostgres()` is a source API only. It has not been run against a managed database in this tranche. It does not provision tenants, keys, roles, backup policy, monitoring, or high availability. See [DEPLOYMENT_GATES.md](DEPLOYMENT_GATES.md).

## HTTP adapter surface

`createManagedServiceHttpHandler()` returns a function; it does not open a socket.

| Method | Path | Scope | Purpose |
|---|---|---|---|
| `GET` | `/healthz` | none | process liveness only; always reports deployed/live protection false |
| `GET` | `/readyz` | none | local-test readiness, never production readiness |
| `POST` | `/v1/invocations` | `invocations:write` | tenant-bound admission |
| `GET` | `/v1/invocations/:ref` | `invocations:read` | same-tenant state |
| `GET` | `/v1/invocations/:ref/audit` | `audit:read` | same-tenant self-attested audit chain |
| `POST` | `/internal/v1/invocations/:ref/claim-execution` | `worker:claim` | claim execution lease using a fresh caller-held `lease_token` |
| `POST` | `/internal/v1/invocations/:ref/resources` | `worker:write` | bind newly created or recovery-discovered savepoint/fork refs |
| `POST` | `/internal/v1/invocations/:ref/outcome` | `worker:write` | record bounded outcome and cost |
| `POST` | `/internal/v1/invocations/:ref/claim-cleanup` | `worker:claim` | claim cleanup lease using a fresh caller-held `lease_token` |
| `POST` | `/internal/v1/invocations/:ref/cleanup` | `worker:write` | verify cleanup and enter a terminal state |
| `POST` | `/internal/v1/invocations/:ref/claim-recovery` | `worker:claim` | claim untracked-resource recovery lease using a fresh caller-held `lease_token` |
| `POST` | `/internal/v1/invocations/:ref/recovery-absent` | `worker:write` | submit exact-bound provider absence attestation |
| `POST` | `/internal/v1/invocations/:ref/renew` | `worker:write` | renew the current lease |

Internal routes must be isolated from the public edge in any future deployment. Scope checks are defense in depth, not a reason to expose worker routes publicly. The invocation target on every internal route comes only from the URL path; a body-owned `invocation_ref`, even if equal, is rejected rather than silently overwritten.

## Evidence truth

The audit reader takes the invocation anchor and event list from one atomic store snapshot, then rejects empty/truncated chains by comparing the count and tail hash. Every mutation also rejects an audit timestamp earlier than the prior event before committing; PostgreSQL performs the predecessor/hash/time predicate in the decisive insert so a failed append rolls back the surrounding state change. The chain still proves only that one control-plane store produced a consistent sequence of hashes. It is `control_plane_self_attested`; it is not an independent signature, isolation proof, deployment receipt, or live-traffic proof. Every invocation read recomputes the tenant/idempotency/provider-binding recovery key. Before execution, the control plane also recomputes the stored operation and client-request hashes. Before cleanup, it requires the cleanup plan to be an exact bijection with the recorded resources. Terminal cleanup additionally requires an immutable normalized snapshot of the existing Risk Fork cleanup-evidence contract and the exact provider binding's verifier callback. Its absolute freshness deadline is enforced again inside the store transaction against the authoritative store clock, including after PostgreSQL lock waits. In this source tranche those callbacks are demonstrated only by local fixtures, so they are not qualified external provider observations.
