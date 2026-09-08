# Managed Risk Fork deployment gates

This checklist separates source completion from a real hosted protection service. Every gate below is still open for this tranche unless a later immutable evidence packet says otherwise.

## 1. Independent source and threat review

- review tenant isolation, bearer handling, body bounds, idempotency, budget arithmetic, state transitions, lease theft, claim-delivery replay, historical-token reuse, reaper races, and cleanup evidence;
- fuzz hostile JSON descriptors, deep/sparse objects, duplicate headers, malformed routes, and PostgreSQL values;
- add static analysis, dependency review, secret scanning, and exact-source provenance;
- adversarially review MCP 2026-07-28 per-request metadata, header/body binding,
  portable-handle ownership, MRTR/task rejection, cache metadata, and MCP Apps
  active-content rejection;
- resolve every material review finding on the exact candidate commit.

## 2. Worker/enforcement bridge

- implement a host-owned worker that generates and durably retains a fresh 32–512-byte URL-safe CSPRNG `lease_token` before each logical claim, retries that exact token only after an unknown delivery result, and renews the resulting lease;
- make one token map to one local logical work attempt so concurrent, delayed, or `claim_replayed: true` responses cannot start duplicate execution, cleanup, recovery lookup, or provider effects;
- prohibit worker logs, traces, metrics, crash reports, and audit submissions from containing raw bearer or lease tokens;
- bind it to the existing `RiskForkController`, host boundary, and a qualified `RiskForkProvider`;
- journal each savepoint/fork reference independently immediately after creation, and retry only the exact same canonical journal request so its durable response receipt resolves ambiguous delivery without another control-plane mutation;
- pass the immutable invocation `provider_recovery_key` into provider-side idempotency/tags and implement lookup for both-resource, partial found/absent, and total verified-absence recovery;
- ensure no parent credentials, bearer values, wallet material, deployment authority, or unrelated workspace state enters the child;
- prove every risky tool call is intercepted before effect, not merely logged afterward;
- prove result validation and clean commit happen only after verified destruction.
- integrate explicit portable-handle registration and authorization into the
  pre-effect bridge using the currently authenticated principal; replace the
  process-local reference registry with durable, transactional, tenant-scoped
  state for multi-instance, restart, MRTR, or Task workflows;
- never infer a handle from arbitrary argument names, conversation content, or
  model output; each supported tool contract must identify its exact handle
  field and allowed consuming methods.

## 3. Provider qualification

- select an exact provider SDK and runtime/template digest;
- use a separately provisioned provider credential only inside an approved qualification environment;
- set an explicit hard spend ceiling before the first paid call;
- prove network policy, credential absence, filesystem/process isolation, TTL behavior, teardown, verified absence, latency, and cost;
- sign and independently verify the qualification receipt;
- bind admissions and all later execution/cleanup/recovery work to the exact adapter digest, capabilities, qualification receipt, provider account/template identity, and verifier keys;
- retain every historical exact binding and original tenant mapping in cleanup/recovery-only mode until all persisted nonterminal obligations for it drain;
- impose hard deadlines, concurrency bounds, and circuit breakers on resource, cleanup, and recovery verifier callbacks;
- prove every verifier callback is observational, read-only, retry-safe, and incapable of creating, changing, or deleting provider resources when simultaneous journal deliveries both reach verification;
- add a reviewed production qualification class. The current registry accepts `local_test` only.

## 4. Managed PostgreSQL qualification

- run migrations with a non-runtime owner identity and attest the exact migration hash;
- create separate migrator, API, worker, and read-only observer roles with least privilege;
- require CA-validated TLS and rotation-ready credentials from a secret manager;
- verify serialized admission, idempotency replay across provider-binding rotation and tighter restart policy, budget reservations, UTC-midnight authority cutoffs, stale-admission denial, unswept-expiry/recovery admission and readiness fences, database-clock lease races, exact sequential and concurrent immediate-post-claim replay, lost-response and ambiguous-commit recovery, denial after claim progress or expiry, tenant-wide cross-invocation denial for durable historical-token tombstones, sequential and concurrent resource-journal receipt convergence after partial, complete, recovery, and lease-releasing transitions, exact persisted response hashes, one audit mutation per logical journal, evidence-freshness deadlines after lock waits, audit-time regression rollback, reaper races, clock-skew rejection, append-only audit triggers, catalog drift, and crash recovery against real PostgreSQL;
- qualify high availability, failover, point-in-time recovery, backup restore, retention, monitoring, capacity, and credential rotation;
- add exact catalog and privilege attestation equivalent to the existing distributed-authority gate.

## 5. Service and edge operations

- build a real HTTP runtime around the handler with bounded headers, body streaming, deadlines, connection limits, structured redacted logs that cannot emit bearer or lease tokens, and graceful shutdown;
- keep internal worker routes on a separate authenticated network surface;
- split execution, cleanup, and recovery into distinct least-privilege credentials and route authorization scopes;
- add an identity-aware MCP gateway that validates OAuth issuer and exact
  resource audience on every request and never derives authority from client
  metadata, connection identity, a legacy session, or a portable handle alone;
- keep MCP Apps/active HTML disabled until a separately qualified renderer has
  an allowlisted origin policy, restrictive CSP and iframe sandbox, bounded
  resource fetching, content integrity, and a closed host-message bridge;
- add per-key and per-tenant admission-rate limits in addition to cost/concurrency bounds;
- provision metrics and alerts for admission rejection, budget pressure, lease expiry, cleanup backlog, cleanup failure, audit-chain failure, provider error, and database health;
- define key issuance, expiry, revocation, rotation, tenant suspension, incident response, and emergency disable procedures;
- test overload, dependency loss, clock skew, retry storms, and regional failure.

## 6. Release, deployment, canary, and activation

- decide the independently reviewable distribution artifact and publish provenance/SBOM/signatures;
- deploy to a non-production environment with no live agent traffic;
- run exact-client conformance, claim-response-loss/retry-storm tests, duplicate-work detection, and malicious MCP scenarios against the hosted candidate;
- run hosted MCP 2026-07-28 stateless conformance across multiple server
  instances, including planted/cross-principal handles, issuer/audience mix-up,
  replay, expiry, malicious Apps markup, cache poisoning, MRTR/task fail-closed
  behavior, and header/body substitution;
- run a bounded canary only after credentials and a hard spend cap are separately authorized;
- verify cleanup and absence out of band, then review evidence;
- deploy production default-off;
- enable only explicitly enrolled canary tenants and retain an immediate kill switch;
- expand traffic only after error, latency, cost, abuse, and cleanup objectives hold.

## Required truth labels until all gates pass

```text
source scaffold:                  true
local deterministic tests:       true when the checked tests pass
published package:               false
managed PostgreSQL qualified:    false
provider qualified for service:  false
host worker wired:               false
deployed:                        false
production activated:            false
live agent traffic protected:    false
```
