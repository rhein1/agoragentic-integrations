# Durable request-policy source backend

`createPostgresManagedRequestPolicyStore` implements the `readControl` and
`consumeRateLimit` trusted-host callbacks consumed by `createManagedRequestPolicy`.
This is optional, source-only, unpublished and `local_test` only. Production mode
is rejected. No listener, provider credential, database provisioning, deployment,
paid call or live traffic is enabled by constructing it or changing its control.

## Integration

Use an independently provisioned, dedicated policy database/schema/identities.
Do not mix these grants with either the exact-attested control-plane database
or ciphertext delivery database. The initial source file
`migrations/004_request_policy.pg.sql` is **version 1 of an independent ledger**,
not a fourth managed control-plane migration. The existing migrators and
attestors deliberately do not discover it.

An owner runs `migratePostgresManagedRequestPolicy` once with an explicit quota
map. It initializes `enabled: false, epoch: 0`. Repeated migration verifies the
exact source/configuration hashes without changing limits or re-enabling the
service. A partial existing schema fails rather than being automatically repaired.
The runtime is verify-only and executes no DDL. All five routes require explicit
limits; there are no permissive defaults.

```js
import {
  createManagedRequestPolicy,
  createPostgresManagedRequestPolicyStore,
} from './src/index.mjs';

// Example limits, not qualified production sizing. Supply connection/TLS and
// redacted telemetry through the trusted host's existing secret/custody system.
const quotas = {
  admission: { windowMs: 60_000, perKey: 10, perTenant: 30, maxSubjects: 1000 },
  execution: { windowMs: 60_000, perKey: 10, perTenant: 30, maxSubjects: 1000 },
  cleanup: { windowMs: 60_000, perKey: 30, perTenant: 100, maxSubjects: 1000 },
  recovery: { windowMs: 60_000, perKey: 30, perTenant: 100, maxSubjects: 1000 },
  read: { windowMs: 60_000, perKey: 30, perTenant: 100, maxSubjects: 1000 },
};
const store = await createPostgresManagedRequestPolicyStore({
  connectionString: hostPolicyConnectionString,
  tls: { ca: hostPolicyCa },
  schemaName: 'risk_fork_request_policy',
  quotas,
});
const requestPolicy = createManagedRequestPolicy({
  readControl: (signal) => store.readControl(signal),
  consumeRateLimit: (request) => store.consumeRateLimit(request),
  emitTelemetry: hostRedactedTelemetry,
});
// Supply requestPolicy to both HTTP factories and the explicit local host.
// Shut ingress before awaiting store.close(); never expose these callbacks as
// public routes or pass body/model-owned tenant/key identifiers to them.
```

Factory-owned pools require CA-validated TLS by default. Injected pools are
accepted only for explicit `requireTls: false, disposableDb: true` local tests.
`deploymentMode: 'production'` is rejected regardless of transport. The factory
preserves its TLS requirement at later client checkout and closes only its own
pool. PostgreSQL 16, fsync, synchronous commits and normal trigger mode are
required. Each transaction rechecks the exact migration and quota binding.

## Atomicity, clock and capacity

Every policy operation locks one shared clock row first. Database time is
sampled after the lock and configuration checks, compared against its durable
high-water mark and committed with the decision. Clock regression denies
control reads and every route until independently reconciled; there is no
application-clock fallback. This conservative singleton serialization is not a
qualified throughput or availability guarantee.

Consumption uses UTC-epoch-aligned fixed windows. It checks both tenant and
tenant-bound key counters before charging either, in one transaction. A denied
request consumes no active quota slot. The route's `maxSubjects` counts both
tenant and key rows. Old windows are reclaimed under the same lock before
capacity checks; active counters are never evicted to make room for a new key.
Hashes are domain-separated and tenant-bound; raw identity/bearer values are
not stored. Admission/execution cannot consume cleanup/recovery/read counters
or their row capacity. Shared database overload can still delay all routes;
out-of-band emergency cleanup and capacity/load qualification remain host duties.

`windowMs` is 1,000–3,600,000; each quota is 1–1,000,000; `maxSubjects` is
2–1,000,000 per route. Fixed-window limits are not a rolling token bucket: two
adjacent windows can permit twice the configured quota across their boundary.
Denials return a bounded 1–3,600-second retry interval. Retrying does not promise
capacity before the current window expires. No automatic SQL or provider retry
occurs. An ambiguous/late commit may conservatively consume quota, but never
returns an allow; a client retry is a new rate attempt, not an exact-once receipt.

Statements, locks and idle transactions are bounded (default 5 seconds, maximum
30 seconds). Abort is checked before and after waits and before/after commit.
The backend waits for in-flight SQL to settle before rollback/release; it cannot
undo an already committed decision. The outer policy may reject waiting earlier
on its AbortSignal. Backend errors are redacted and fail closed. A stalled
injected test pool is not evidence of bounded factory-owned transport behavior.

## Operator controls and remaining boundaries

The [role template](./ops/postgres/request-policy-roles.sql.template) gives the
trusted runtime SELECT, clock-column UPDATE and quota-table INSERT/UPDATE/DELETE.
DELETE is needed only for expired-window reclamation. Runtime control/config/
ledger changes, TRUNCATE and DDL are denied in disposable separate-role tests.
This trusts the host runtime: a stolen runtime DB credential can alter quota
usage. It is not protection against a compromised host or a privilege attestation.

Only the owner performs a prepared disable/enable update with the expected epoch:
`SET enabled=$1, epoch=epoch+1 WHERE singleton=true AND epoch=$2 RETURNING ...`.
Require exactly one result. A trigger requires each control update to advance
the epoch once and forbids changing its singleton/configuration hash. Changing
quota configuration requires draining the backend and a separately reviewed new
schema/binding; no live limit migration, admin endpoint or auto-repair is supplied.
Owner fixture/maintenance changes must acquire the clock lock first. Disable
blocks admission/execution through the wrapper but leaves bounded cleanup,
recovery and reads available. It does **not** terminate in-flight provider work.

`initialize()` explicitly reports `configuration_verified: true`,
`exact_catalog_verified: false`, `runtime_privileges_verified: false`,
`production_qualified: false`, and `live_traffic_protected: false`. A migration
hash/configuration check does not attest every SQL constraint, trigger or ACL.
Exact policy catalog/role attestation, hosted TLS/key custody/rotation, restore/
HA/failover, durable alert delivery, overload SLOs and an atomic effect-time
broker fence/cancellation remain separate qualification work. This backend is
not coupled atomically to an execution ledger or provider call.

## Verification

`test/postgres-request-policy.test.mjs` includes deterministic config/error/
late-commit tests plus guarded real PostgreSQL two-instance, restart, all-or-none
quota, capacity reclamation, disable/epoch, clock rollback, lock timeout/abort,
backend loss, configuration drift and separate-runtime role tests. The existing
mandatory managed PostgreSQL CI job runs it on Node 20/22/24. A supplied local
lab CA additionally exercises the factory's real TLS success/wrong-CA rejection;
ordinary CI PostgreSQL without that CA is not TLS evidence for this backend.
Only disposable loopback databases named `risk_fork_managed_test` with the
explicit delete-data confirmation may run these integration tests. Unique child
schemas/databases/roles are removed and their absence verified. No provider or
production test is included.
