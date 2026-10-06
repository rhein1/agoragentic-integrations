# Risk Fork managed-service source scaffold

This directory contains a **source-only, default-off control-plane scaffold** for a future managed Risk Fork service. It is locally testable. It is not published, hosted, deployed, provider-qualified, production-qualified, or authorized to protect live agent traffic.

The package is deliberately marked `private: true`. An explicit, default-off local host can bind two loopback listeners; no public listener, deployment manifest, cloud account, provisioned database, provider credential, or production activation path is included. `MANAGED_SERVICE_PRODUCTION_QUALIFIED` is a hard-coded `false`; configuration cannot turn this source tranche into a production service.

## What this tranche implements

- tenant identity derived from a verified API-key record rather than request body input;
- one-way, domain-separated API-key hashes, bounded bearer parsing, expiry, revocation, and scoped permissions rechecked on every programmatic call;
- authority-free operation validation using the parent Risk Fork `validateChildOperation` boundary;
- tenant-scoped idempotency with same-key/different-request rejection and exact replay across provider-binding rotation or tighter restart policy;
- hard per-invocation cost, UTC-day budget, and concurrent-invocation admission limits;
- permanent owner-key cancellation on the original invocation, exact request replay, conservative in-flight accounting, and lease-generation-bound worker observation;
- versioned, locally qualified provider bindings keyed by an immutable capability snapshot, exact adapter digest, qualification-receipt hash, and canonical tenant allowlist, with source-adapter drift rechecked before use;
- execution, cleanup, and recovery leases that require a caller-generated URL-safe CSPRNG token, persist only its domain-separated hash in a tenant-wide uniqueness tombstone, and support tightly bounded delivery replays;
- an explicit invocation state machine with fail-closed accounting and a blocking recovery path for untracked resources;
- independent savepoint/fork journaling with durable exact-response receipts, partial-resource recovery, and verified cleanup of every recorded resource before a terminal transition;
- hash-chained, append-only control-plane audit receipts that are clearly labeled self-attested;
- a memory store for deterministic local tests and a PostgreSQL store/migration source path;
- host-neutral JSON request handling for health, readiness, tenant, worker, and audit routes.
- a host-owned local-test worker driver that wraps the actual controller, journals each created resource, rechecks leases before and after provider callbacks, and reconciles verified cleanup before returning the original process-local prepared receipt.
- optional AES-256-GCM delivery retention with an independent PostgreSQL ciphertext store, exact claim/resource-packet redelivery, and no provider or original-operation retry;
- purpose-specific execution, cleanup, and recovery claim/write scopes, separate public/worker handlers, a trusted OAuth verification seam, bounded loopback ingress, and scheduled local reaping.
- an offline pinned-key JWT verifier and optional host-owned rate/disable policy with bounded redacted policy telemetry;
- exact PostgreSQL 16 control-plane catalog attestation and a separate-runtime locking interface that grants no tenant/API-key table UPDATE;
- an opt-in asynchronous lifecycle observer with deterministic redacted events, permanent per-invocation prefix checkpoints and finite cyclic tenant sweeps in the separate telemetry schema; see [TELEMETRY.md](./TELEMETRY.md).
- opt-in v3 committed-observation metric counts, permanent exact-source/alert-ACK custody and a bounded threshold alert outbox, using the existing telemetry drainer and explicit `alertDrainer` local-host composition. Lifetime caps, legacy uncounted upgrade, partial coverage and missing operational qualification are explicit in [TELEMETRY.md](./TELEMETRY.md#opt-in-metric-counts-and-threshold-alert-outbox).

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

The local-test worker bridge is now implemented in `src/worker.mjs`; its
construction and failure contracts are in [WORKER.md](./WORKER.md). It invokes
only trusted host callbacks and constructs no SDK, listener, or credentials.
The provider broker remains an explicit qualification boundary: it must enforce
the absolute lease fence at the effect, attach `provider_recovery_key` at birth,
and independently attest resource lookup and absence. This driver is restricted
to enabled `local_test`; it cannot activate a production provider. Optional
`createManagedWorkerDeliveryJournal` retains encrypted claim/resource packets
before sending them. Explicit `resumeDelivery` resolves delivery only; it never
resumes controller execution, provider effects, or prepared-object provenance.
Operational qualification remains open. Prepared-object provenance is
intentionally process-local.

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

## Cancellation of the original invocation

`requestCancellation(principal, { invocation_ref, idempotency_key, reason_hash })`
requires the current original admitted key and `invocations:cancel`. The public
`POST /v1/invocations/:ref/cancel` body contains only `idempotency_key` and a
canonical SHA-256 `reason_hash`; the URL owns the target. No body-supplied tenant,
provider/resource reference, lease or approval field is accepted. The worker
HTTP surface exposes no cancellation endpoint. With request policy configured,
this operation uses bounded recovery quota and remains available when new
execution is disabled; it does not bypass authentication or quota.

Cancellation is a permanent marker on the original invocation, not a new state,
receipt or authorization capability. The transaction rechecks request/operation/
provider/recovery bindings, locks the original credential, and rechecks its scope
and database-clock expiry after budget waits. A pre-effect admitted item becomes
`failed_closed` and releases its reservation without a spend. Execution-leased
or running work records `ambiguous`, settles the reservation at its conservative
estimate, clears the execution lease and retains `recovery_required` for unknown
resources or `cleanup_pending` for two known resources. This accounting bound is
not an observed provider charge. An existing cleanup/recovery lease and already
settled cost/outcome remain intact. Exact cancellation replay returns current
state without another audit or budget movement; a different permanent request
fails with `CANCELLATION_CONFLICT`. Terminal uncanceled work cannot be canceled
retroactively. Canceled work can never enter `completed`; verified exact cleanup
or recovery absence instead ends in `failed_closed`.

The host worker observes cancellation with its current execution principal,
raw claim token and original generation, checked against the live lease or the
original cancellation audit digest. Takeover retires this observation. The
token never appears in the response/audit. This is observation, not a locked
dispatch fence or independently signed provider evidence. Abort acknowledgement,
timeout, and terminal bookkeeping do not prove an in-flight callback stopped or
undo an external effect. See [WORKER.md](./WORKER.md).

## Authentication and tenant boundary

`createManagedAuthenticator()` looks up a domain-separated SHA-256 key hash. PostgreSQL stores `key_hash`, never a raw bearer token, and filters not-before, expiry, and revocation using its own clock before returning a record; the application check remains an additional fail-closed check. Each principal and verifier are bound to that exact authenticator/store instance; another authenticator's principal and caller-created verifier functions are rejected. Every control-plane call re-resolves the key record and rechecks its hash, expiry, revocation, tenant, key id, and requested scope. Every tenant-visible invocation and audit query includes both `tenant_id` and `invocation_ref`.

The store repeats `worker:<purpose>:claim` authorization for every lease claim and claim replay, and `worker:<purpose>:write` authorization for lease preflight, renewal, resource journaling/replay, execution settlement, and cleanup/recovery completion, where purpose is execution, cleanup, or recovery. An authenticated principal or retained lease token cannot preserve a removed scope. PostgreSQL checks scope alongside credential identity, tenant, revocation, and database-clock validity; it holds a shared credential-row lock through the mutation transaction so credential edits serialize with the authority decision. Final write statements also recheck scope and expiry. Credential validity is evaluated after the row lock is acquired, and claim replays sample the database clock after that check so lock waits cannot extend credential or lease lifetime. Journal receipts retain their original execution/recovery purpose; replay checks that purpose rather than a later mutable cleanup lease. Authentication precedes invocation/receipt reads. Rejected writes leave invocation state, budget, receipts, and audit history unchanged.

The legacy `worker:claim` and `worker:write` scopes are not accepted. Operators
must explicitly reissue least-privilege credentials; there is no automatic
expansion into all six new permissions. Distinct principal slots and route
scopes do not qualify deployed roles or a live provider broker. Worker, delivery
journal and enabled local-host construction now require immutable original
principals with pairwise distinct stable key IDs, one tenant and the appropriate
claim/write scopes. Re-authenticating a shared key cannot satisfy separation;
caller clones still fail the existing control-plane authenticator brand checks.
The local host retains the validated assignments rather than reading mutable
options at dispatch. This is composition enforcement, not global least-privilege
credential provisioning: broad credentials and separately configured processes
still need a qualified deployment policy.

The current source scopes separate tenant APIs, worker mutation, and audit reads:

- `invocations:write`
- `invocations:read`
- `invocations:cancel`
- `worker:execution:claim`, `worker:execution:write`
- `worker:cleanup:claim`, `worker:cleanup:write`
- `worker:recovery:claim`, `worker:recovery:write`
- `audit:read`

Tenant and API-key provisioning are administrator operations and are not exposed as network routes in this tranche.
Payload minimization ensures cleanup and recovery claims do not return the original operation arguments. `createTrustedOAuthAuthenticator` is an optional trusted-host seam: its injected verifier must perform actual token signature/JWKS, issuer, audience, and OAuth policy verification on every HTTP request. The returned closed identity is bound to the current persisted key, tenant, subject, scopes, and validity window. This seam performs no discovery, token exchange, JWKS fetch, or outbound token brokerage itself.

`createOfflineOAuthVerifier({ issuer, audience, jwks })` supplies a concrete
offline verification callback for that seam. It snapshots host-provisioned
public JWKs (RSA RS256, 2048–8192 bits with public exponent 65537; EC ES256,
P-256), accepts only
`typ: at+jwt`, checks signatures, exact issuer/single audience and bounded
`iat`/`nbf`/`exp`, and rejects duplicate JSON members, noncanonical encoding,
unknown headers/claims and ambiguous scopes. This is a **dedicated Risk Fork
access-token profile**, not a generic OAuth broker or complete RFC 9068
implementation. Required custom identity claims are `key_id`, `key_hash` and
`tenant_id`, with `sub === key_id`; scopes use either `scope` or `scopes`, never
both. Always wrap it in `createTrustedOAuthAuthenticator` so the current
persisted credential is the authority for identity, scope and revocation.
Token and persisted-credential validity windows are strict; no clock-skew
option is supported. Synchronize issuer/host clocks rather than extending
expired or not-yet-valid authority.
Keys are static: the host must supply a separately reviewed issuer/token
broker, key rotation and public TLS. The verifier performs no discovery or
JWKS fetch, and cannot mint tokens.

The durable `lease_owner` is the authenticated API-key `key_id`, not the caller-supplied `worker_id`. Every lease preflight, renewal, resource journal, lifecycle transition, outcome settlement, cleanup completion, and recovery completion requires that exact API-key identity to remain active; another worker key from the same tenant cannot continue the lease even if it obtains the raw lease token. PostgreSQL repeats the owner and active-credential predicates in each decisive mutation. The caller-supplied `worker_id` is retained only in the hashed audit detail as `worker_instance_ref` and is explicitly self-asserted metadata; it cannot impersonate another credential in state or audit attribution.

The API-key bearer token and the per-claim `lease_token` serve different purposes. The bearer authenticates and scopes the worker; the lease token correlates one logical claim attempt and is accepted only with the same authenticated lease owner. Possession of a lease token alone grants no authority.

## Admission and abuse bounds

The control plane reserves integer `estimated_cost_micros` before accepting work. Deployers must define what that unit prices and bind it to a qualified provider quote before production use. The reservation is constrained by the lower of global and tenant-specific per-invocation, UTC-day, and concurrency limits. Actual cost may not exceed the reservation. Settlement and the transition to cleanup are one store transaction. PostgreSQL validates application-clock skew at transaction entry, then refreshes its authoritative clock after lock waits for budget days, leases, transitions, evidence deadlines, and audit timestamps. A real worker must stop effects when its lease ends; the control-plane lease is authority, not a mechanism that can terminate an unimplemented external worker.

These controls bound admitted work but are not a complete public-edge abuse defense. Production still needs authenticated key issuance, per-key request-rate limits at the edge, payload and connection timeouts, WAF/DDoS controls, monitoring, alerting, and an incident-disable path.

An optional `createManagedRequestPolicy` accepts three trusted host callbacks:
`readControl(signal)` returns exactly `{ enabled, epoch }`,
`consumeRateLimit({ tenant_id, key_id, route_class, signal })` returns exactly
`{ allowed, retry_after_seconds }`, and `emitTelemetry(event)` receives only
fixed policy labels, bounded duration and domain-separated identity hashes.
Supply this policy as `requestPolicy` to both HTTP factories or the local host.
Authenticated routes check it before control-plane access; local host
`execute`/`cleanup`/`recover` also check it. Rate denial returns HTTP 429 with a
bounded `Retry-After`. Callback failure is redacted and fails closed. Control
is read again after the rate await; disabling blocks admission/execution but
does not by itself block cleanup/recovery/reads. Telemetry is best-effort with
a bounded FIFO behind one pending sink, explicit failure/overflow counters and
no silent overlap drop; it is not a durable audit or alert service. Alternatively,
`recordTelemetry(event, { signal })` requires a durable append acknowledgement
for admission/execution candidates, then rechecks enable/epoch after that wait.
Cleanup/recovery/reads and denials never await telemetry. The separate
[observer outbox](./TELEMETRY.md) supplies source-only PostgreSQL retention and
lease-fenced at-least-once delivery. It does not provision a hosted alert service.
AbortSignal rejects waiting policy checks; it does not cancel committed work.
Direct local-host policy waits use the host's `deadlineMs` (default 30 seconds).

The local host retains the original execution policy decision and binds it to
the worker's invocation. New savepoint/fork creation and execution recheck the
durable enabled/epoch state after preparation and lease waits without consuming
quota again. The trusted provider broker must also await its one-use
`effectFence()` immediately before the API call after any broker-owned wait.
Every worker requires that fence and an awaited exact bound provider call,
whether optional request policy is configured or not. The callback receives a
one-method frozen facade, not the usable raw provider. Missing/unfinished fencing
or a fabricated result fails as an unknown outcome, not proof of no effect.
Destruction/verification and durable recovery
bookkeeping remain available when execution is disabled. These separate reads
are not atomic with external effects or termination proof; see
[WORKER.md](./WORKER.md) for the exact capability and ambiguity contract.

An optional [PostgreSQL request-policy backend](./REQUEST_POLICY.md) now supplies
these two callbacks with shared transactional per-key/per-tenant fixed-window
quotas, independent route capacity, a durable disable epoch and database-clock
rollback rejection. It uses its own migration ledger and dedicated database,
not the execution or worker-delivery schemas. The source is restricted to
`local_test`; configuration/migration hashes and the exact source-owned PG16
catalog are checked every transaction. Optional `expectedOwner` also verifies
distinct runtime identity, ownership, exact ACLs and privilege defaults. These
are local source checks, not hosted-role qualification. Hosts still own authenticated
identity, edge protection, durable alerts and deployed qualification.
Omitting the optional policy preserves local-test behavior, not production
qualification. A policy decision is not
atomic with database writes or provider effects: an immediate effect-time
fence and cancellation of in-flight provider work remain broker/host duties.

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

The default test run is provider-free and makes no live database or external network calls. It uses the in-memory store, no-I/O provider fixtures, injected PostgreSQL contract doubles, and temporary loopback listeners. It does not contact E2B, GitHub, Agoragentic, or any other remote service, and it does not spend money. The syntax check rejects network/process runtime imports, provider SDK imports, browser-style outbound APIs, and listeners from `src/`; the separate `host/` entrypoints receive syntax checks and must be explicitly enabled.

Opt-in PostgreSQL integration tests also exist. They run only when `RISK_FORK_MANAGED_TEST_POSTGRES_URL` points to the loopback database named exactly `risk_fork_managed_test` **and** `RISK_FORK_MANAGED_TEST_CONFIRM_DISPOSABLE=YES_DELETE_DATA` is set. Each run creates a unique validated schema and drops that exact schema in `finally`. The normal test command skips them; CI uses an ephemeral PostgreSQL service, and an operator must never point it at a shared or production database. The `managed-service` job in `.github/workflows/risk-fork.yml` is selected whenever `risk-fork/**` or that workflow changes, installs both package roots from their committed lockfiles, and runs the syntax and full disposable-PostgreSQL test suite on Node.js 20, 22, and 24. CI also sets `RISK_FORK_MANAGED_REQUIRE_POSTGRES_TESTS=1`, so missing or malformed database configuration fails instead of silently turning the integration test into a skip.

Legacy PostgreSQL tests use the migration owner. Separate-runtime tests now
exercise owner-executed lock helpers because direct `FOR SHARE` requires an
`UPDATE` privilege on at least one locked-table column
([PostgreSQL 16 SELECT](https://www.postgresql.org/docs/16/sql-select.html)).
The runtime receives helper EXECUTE, never API-key/tenant table UPDATE. Tenant
suspension and credential edits serialize behind the helper locks. Hosted
owner/migrator/runtime qualification remains Gate 4; local role tests do not
complete that gate.

## PostgreSQL source path

The worker-delivery and control-plane role tests create uniquely named disposable
child database and roles, then removes those exact objects. It requires the
explicit disposable administrator to have database/role creation authority.
Database ACL mutations stay inside that child database, not the shared test
database. This is local separate-role evidence, not managed hosting proof.

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

Migration `001` is preserved. Explicit versioned migration `002_journal_purpose`
backfills receipt purpose from its exact recorded audit-head event and aborts
the transaction if any legacy receipt cannot be attested. Never infer purpose
from an invocation's current lease or patch the frozen initial migration.

Explicit migration `003_control_plane_lock_helpers` adds three bounded
`SECURITY DEFINER` helpers with `search_path=pg_catalog`, schema-qualified
tables, and PUBLIC EXECUTE revoked. Before migration `001`, run the dedicated
[control-plane owner bootstrap](./ops/postgres/control-plane-owner-bootstrap.sql.template)
as the database owner for separately provisioned migrator/runtime roles. It
revokes PUBLIC database CONNECT/CREATE/TEMPORARY, grants migrator CONNECT/CREATE,
and grants runtime CONNECT only. Apply the separate
[control-plane grants](./ops/postgres/control-plane-roles.sql.template) using
the dedicated migration owner after all four control-plane migrations.
It is not the worker-delivery schema/template. Runtime SELECT covers all eight
tables; INSERT covers usage, invocations, lease tombstones, journal receipts
and audits; UPDATE covers usage/invocations only; helper EXECUTE covers only
the three locking functions. Tenant/key provisioning and credential changes
remain administrator duties.

Explicit `008_managed_cancellation.pg.sql` is logical version **4** of this
control-plane ledger: four nullable marker columns, a closed consistency CHECK,
and a no-rearm trigger whose direct PUBLIC EXECUTE is revoked. The earlier
`001`/`002`/`003` sources and v1 catalog remain unchanged. The v2 catalog is
captured from a disposable PG16 schema and binds this exact four-file set;
`004` through `007` remain independent request-policy/telemetry migrations,
not automatic control-plane versions. The new trigger prevents changing an
already-written marker. Existing runtime table UPDATE on invocations remains:
catalog attestation and the app transaction do not establish protection against
a compromised privileged host forging an initial marker directly in SQL.

`test/postgres-cancellation.test.mjs` uses real disposable transactions, exact
COMMIT-then-lost-reply injection, concurrent replay, credential/budget row-lock
expiry, restart/recovery, interrupted-token observation, immutable markers and
audit anchors. Its provider callbacks are explicit fixtures, not live isolation
or destruction proof. It obeys the same mandatory database guard as the other
control-plane integration tests.

`verifyPostgresControlPlaneAttestation` compares complete relation, column,
constraint, index, trigger, function, type, policy, rule and inheritance
catalogs against the source-owned PostgreSQL 16 manifest, and binds all four
migration hashes. Other PostgreSQL majors fail closed until independently
reviewed. The factory verifies the catalog before returning; a direct store
must call `initialize()`. Set `expectedOwner` to additionally attest a distinct
LOGIN/NOINHERIT runtime, no memberships, exact ownership/ACLs, no PUBLIC or
unrelated grants, no credential-column UPDATE and no grant/DDL authority.
Strict stores repeat full attestation at every client checkout and inside
mutation transactions. Omitting `expectedOwner` is catalog-only local testing;
legacy directly constructed stores without initialization are not evidence of
exact catalog validation. No automatic DDL repair runs.
Health reports `catalog_verification_scope` and separate
`exact_catalog_verified`/`runtime_privileges_verified` flags: the legacy
`catalog_verified` inventory flag alone is not exact catalog/role proof.

`migratePostgresWorkerDelivery` and `createPostgresWorkerDeliveryStore` use a
different schema (default `risk_fork_worker_delivery`) and independent version-1
ledger. They store ciphertext plus bounded metadata, not cleartext packets or
tokens. Capacity policy and attempt records are immutable except acknowledgement;
tombstones count toward capacity. This local-test store is not a replacement for
the managed control-plane or portable-handle ledger. Supply host-owned key custody,
retention and cleanup policy; managed-role/HA/restore qualification remains open.

The delivery factory accepts only PostgreSQL 16 and verifies the exact reviewed
catalog and version-1 migration hash before returning a store; every operation repeats that check
inside its transaction. Constraints, indexes, trigger definitions and function
bodies are checked, not only names. `initialize()` exposes the same check for a
directly constructed store. Catalog or migration drift fails closed without DDL
or automatic repair.

Supply `expectedOwner` to additionally require a distinct LOGIN/NOINHERIT runtime
identity, no role memberships, exact schema/object ownership, database CONNECT
and schema USAGE without creation or grant authority, ledger SELECT only,
namespace SELECT/INSERT only, and attempts SELECT/INSERT plus column-only
UPDATE of `acknowledged`, `response_hash`, and `acknowledged_at`. Destructive
privileges and direct trigger-function execution are denied. Omitting
`expectedOwner` is catalog-only local testing, not runtime-role qualification.

[Owner bootstrap](./ops/postgres/owner-bootstrap.sql.template) and
[post-migration grants](./ops/postgres/worker-delivery-roles.sql.template) are
reviewable templates for a dedicated disposable database with separately
provisioned roles. Run only worker-delivery migration `002_worker_delivery.pg.sql`
in this independent schema, not control-plane migration `001`. No template
contains credentials or provisions a hosted database. The role templates
require a dedicated migrator: removing PostgreSQL's global
PUBLIC function-EXECUTE default affects that migrator's future functions across
this database, not just this schema. A schema-scoped revoke cannot override the
global default; do not apply this template using a shared migrator identity.
Both the store and
attestor remain source-only; even a successful strict attestation reports
`production_qualified: false`. Production TLS/key custody, deployed control-plane
roles, HA/failover/PITR/restore, rotation, retention and monitoring remain Gate 4.
See the [operational qualification packet](./OPERATIONAL_QUALIFICATION.md) for
the evidence still required before any live canary.

## HTTP adapter surface

Both handler factories return functions; neither opens a socket.
`createManagedServiceHttpHandler` exposes public routes only and cannot be
configured to enable worker routes. `createManagedWorkerHttpHandler` requires
a separately supplied worker authenticator and exposes internal routes only.

| Method | Path | Scope | Purpose |
|---|---|---|---|
| `GET` | `/healthz` | none | process liveness only; always reports deployed/live protection false |
| `GET` | `/readyz` | none | local-test readiness, never production readiness |
| `POST` | `/v1/invocations` | `invocations:write` | tenant-bound admission |
| `POST` | `/v1/invocations/:ref/cancel` | `invocations:cancel` | permanent original-owner cancellation; not termination proof |
| `GET` | `/v1/invocations/:ref` | `invocations:read` | same-tenant state |
| `GET` | `/v1/invocations/:ref/audit` | `audit:read` | same-tenant self-attested audit chain |
| `POST` | `/internal/v1/invocations/:ref/claim-execution` | `worker:execution:claim` | claim execution lease |
| `POST` | `/internal/v1/invocations/:ref/resources-execution` | `worker:execution:write` | journal created resources |
| `POST` | `/internal/v1/invocations/:ref/outcome` | `worker:execution:write` | record bounded outcome and cost |
| `POST` | `/internal/v1/invocations/:ref/claim-cleanup` | `worker:cleanup:claim` | claim cleanup lease |
| `POST` | `/internal/v1/invocations/:ref/cleanup` | `worker:cleanup:write` | verify cleanup and enter a terminal state |
| `POST` | `/internal/v1/invocations/:ref/claim-recovery` | `worker:recovery:claim` | claim resource recovery lease |
| `POST` | `/internal/v1/invocations/:ref/resources-recovery` | `worker:recovery:write` | journal attested recovery resources |
| `POST` | `/internal/v1/invocations/:ref/recovery-absent` | `worker:recovery:write` | submit provider absence attestation |
| `POST` | `/internal/v1/invocations/:ref/renew-execution` | `worker:execution:write` | renew execution lease |
| `POST` | `/internal/v1/invocations/:ref/renew-cleanup` | `worker:cleanup:write` | renew cleanup lease |
| `POST` | `/internal/v1/invocations/:ref/renew-recovery` | `worker:recovery:write` | renew recovery lease |

Legacy `renew` and `resources` path aliases are execution-only, never inferred
from a mutable lease. Internal routes must be isolated from the public edge in
any future deployment. Scope checks are defense in depth, not a reason to expose
worker routes publicly. The invocation target and expected purpose come from
the URL; body-owned `invocation_ref` or `expected_lease_kind` is rejected.

`createManagedRiskForkLocalHost` in `host/local-host.mjs` is explicit local-test
composition, default-off, with all credentials, provider callbacks, stores, and
encryption keys supplied by the host. It binds separate public/worker listeners
to `127.0.0.1` only, bounds headers/body/connections/deadlines, serves JSON with
`no-store`, and starts a bounded non-overlapping reaper. Shutdown closes ingress
before worker/journal capabilities. Request deadlines reject late authentication
and responses; they do not cancel an already committed mutation or prove provider
cleanup. `execute`, `cleanup`, `recover`, and delivery recovery remain clean-host
capabilities, never HTTP routes. No public demo or hosted protection is activated.

## Evidence truth

### Bounded observer audit reads

Trusted checkout-only callers with a current `audit:read` principal can use
`controlPlane.listAuditInvocations(principal, { after_ref, upper_ref, limit })`
and `controlPlane.readAuditWindow(principal, invocationRef,
{ after_sequence, prior_event_hash, limit })`. These add no HTTP route, provider
callback, writer lock, migration, authority or receipt schema. Limits are 1–64.
Stores without the new methods remain constructible; attempting these reads
fails with `AUDIT_PROJECTION_UNSUPPORTED`, never an unbounded fallback.

An initial invocation page pins the tenant's current highest ASCII invocation
reference and rejects a caller-supplied `upper_ref`. The trusted observer must
retain that returned `upper_ref` independently across continuations; SQL uses
`COLLATE "C"`, matching the memory fixture's byte order. Pages return only
invocation references and audit count/head anchors, not operations, resource
references, credentials or payloads. A cursor is **sweep-local**, not a permanent
watermark. After a finite sweep completes, start again with no cursor: a new
invocation or append behind the previous cursor is found on a later sweep.
These are tenant-authenticated reads; there is no cross-tenant discovery API.
There is no signed cursor or server-side sweep state in this reader dependency.
`complete` covers only the interval supplied in that request, not proof that a
prior sweep was completed. Changing either cursor field can skip source rows.
Never accept cursor fields from a model or untrusted request, or advance a
durable observer checkpoint based on a caller-altered interval. The opt-in
[lifecycle observer](./TELEMETRY.md#opt-in-lifecycle-observer) enforces separate
durable sweep/prefix custody and compares the returned bound with its retained
original bound. Query validation alone does not do
that, just as audit-prefix validation does not prove historical delivery.

Audit windows read the invocation anchor, checkpoint row and at most 64 following
events in one read-only repeatable-read snapshot. Genesis requires sequence zero
and a null hash. Cursor sequences are limited to 2,147,483,647, matching the
frozen PostgreSQL `integer` column; larger values fail before store access on
both backends. An in-range checkpoint ahead of the source fails verification.
A continuation requires the exact previously verified event
hash; gaps, crossing, altered hashes, time regression, ahead checkpoints and
truncated windows fail. `complete` is relative to that snapshot only, and its
tail must equal the invocation count/head. A later append remains discoverable.
A later window validates extension of a known prefix, not all historical rows
before that checkpoint. Re-verify from genesis if the checkpoint is not trusted.
The unchanged full-chain reader remains available.

Each bounded PostgreSQL read sets a transaction-local five-second statement
timeout; it changes no server/pool-wide policy. Result size is bounded, but
collated scan cost, connection acquisition, sweep cadence and historical audit
retention still require host capacity/deadline policy and operational testing.
These reader APIs alone enable no projector, checkpoint or sink. Explicit
`createManagedLifecycleObserver` composition adds bounded asynchronous source
observation with atomic append-before-checkpoint persistence and fair cyclic
coverage. Cleanup/recovery never await it. It is source/local-test only, not a
hosted alert service or independent provider evidence; full historical metrics
and deployed alert/response qualification remain open.

The audit reader takes the invocation anchor and event list from one atomic store snapshot, then rejects empty/truncated chains by comparing the count and tail hash. Every mutation also rejects an audit timestamp earlier than the prior event before committing; PostgreSQL performs the predecessor/hash/time predicate in the decisive insert so a failed append rolls back the surrounding state change. The chain still proves only that one control-plane store produced a consistent sequence of hashes. It is `control_plane_self_attested`; it is not an independent signature, isolation proof, deployment receipt, or live-traffic proof. Every invocation read recomputes the tenant/idempotency/provider-binding recovery key. Before execution, the control plane also recomputes the stored operation and client-request hashes. Before cleanup, it requires the cleanup plan to be an exact bijection with the recorded resources. Terminal cleanup additionally requires an immutable normalized snapshot of the existing Risk Fork cleanup-evidence contract and the exact provider binding's verifier callback. Its absolute freshness deadline is enforced again inside the store transaction against the authoritative store clock, including after PostgreSQL lock waits. In this source tranche those callbacks are demonstrated only by local fixtures, so they are not qualified external provider observations.
