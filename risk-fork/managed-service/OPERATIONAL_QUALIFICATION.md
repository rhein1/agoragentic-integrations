# Operational qualification packet (not a pass receipt)

This is a source-only runbook. Nothing here provisions a database, creates an
E2B sandbox, installs credentials, deploys a gateway, or enables live traffic.
All production gates in [DEPLOYMENT_GATES.md](./DEPLOYMENT_GATES.md) remain open
until retained evidence from the exact hosted candidate establishes them.

## Production-entry gate: implementation and approval prerequisites

Before any production-entry request, record the concrete remaining source
gaps. The reviewed production qualification class is not implemented, the
managed-service production configuration/activation path remains fail-closed,
and provider qualification evidence is not interchangeable with local-test
evidence. Do not describe a source merge or passing local suite as completion
of these production requirements.

For any controlled qualification call, first bind the exact provider SDK,
runtime/template, adapter, account/project and approved qualification
environment. Before the first call, retain a current exact owner grant, an
owner-approved total ceiling and a hard enforceable cap covering lifetime,
concurrency, retries, teardown, delayed and finalized charges. Establish the
approved synthetic workload and independent privilege-separated pinned-observer
boundary. A payment card, alert, estimate or provider-free test is not cap proof.
If these pre-call prerequisites cannot be established, do not allocate.

The controlled run may produce provisional evidence: isolation, cleanup,
absence, latency and finalized provider cost are collected during or after
the run. Production qualification and live protection remain false until
that exact-bound per-run evidence is independently observed, signed and
verified. Unknown cleanup or unfinalized cost is not a successful qualification.

Use separate approvals and evidence packets for each operational step:

1. authorize the exact qualification run, environment, provider account,
   credential custody, roles, run limit, total ceiling and expiry;
2. qualify provider calls with the pinned adapter and independent observer,
   including isolation, TTL, teardown, verified absence, latency and finalized
   cost;
3. provision and qualify managed resources, migrations, TLS and secret-manager
   custody with separate owner, migrator, runtime, worker and observer roles;
4. approve publication of the exact versioned artifact, SBOM, signatures and
   provenance;
5. approve deployment to default-off staging with no live agent traffic and
   complete hosted multi-instance conformance;
6. approve a narrow enrolled-tenant canary with an immediate kill switch,
   out-of-band cleanup/absence verification, finalized cost and rollback
   evidence; and
7. conduct an independent activation review before any production enrollment
   or traffic expansion.

The historical card/$5 ceiling is context only. It is not a blanket grant for
the current run, provider account, credential, environment or expiry, and it
does not prove that the whole qualification sequence can be completed within
$5. A fresh approval must state the current enforceable ceiling and scope; do
not invent a pricing estimate or provider guarantee.

## Common evidence boundary

Record the commit/tree, locked dependency and runtime digests, provider adapter
digest, schema/migration hashes, environment identifier, test UTC timestamps,
operator authorization and observations. Keep private endpoints, account IDs,
tokens, connection strings, wallet material and keys in an access-controlled
operator evidence store, not this public repository. Public summaries use only
redacted labels and hashes. Local fixture attestations are not independently
signed provider evidence. Preserve failures and cleanup evidence, not only a
success summary.

The existing E2B qualification validator and trust-verifier entry points accept
only the current `expected` pin names: `templateId`, `templateHash`,
`bootstrapArtifactHash`, and `runnerArtifactHash`. This host-supplied policy must
be a non-Proxy plain object with own enumerable data properties; misspellings,
unknown fields, symbols, hidden fields and accessors fail closed before external
observation verification. Omitted, `null` and `undefined` pins retain their existing
unset meaning. Supplied values must be canonical. This check does not add an
adapter-digest binding, a production qualification class, provider authority or
an activation path; an opaque registry receipt hash is still not proof that
signed E2B evidence covers the exact managed adapter.

### Cleanup recovery is not current qualification

The E2B adapter can recover already-journaled local export obligations after an
authentic observation receipt expires. Its cleanup-only provenance helper
(`verifyE2BCleanupQualificationProvenance`, reachable through the existing
`e2b-qualification` module subpath) preserves canonical evidence reconstruction,
caller-pinned independent observer/trust keys, both signatures, audience, exact
template/runtime pins, receipt ordering, maximum lifetime and rejection of future
issue time. It omits only the not-expired-now condition. This helper grants no
new effects or activation; it is not a production qualification receipt. New
savepoints, allocation, execution and lease renewal keep current verification.
An adapter constructed from expired evidence is permanently cleanup-only; a
backward clock or mutable status property cannot restore new-effect authority.
An adapter constructed while current also latches cleanup-only on its first
explicit expiry rejection; a later clock rollback cannot undo that decision.
The adapter captures qualification policy privately rather than trusting mutable
public status properties for cleanup authority.

Local-only restart reconciliation does not need an SDK. Real E2B provider I/O is
still source-disabled, including provider cleanup; such obligations remain
unresolved. The existing mock-only conformance seam cannot carry qualification
evidence. Before a mock provider kill, source checks the journal provider/template,
the requested persisted or exact-list identity, and exact returned sandbox ID,
template, profile, cleanup reference and metadata hash. It rechecks the persisted
binding after lookup and records cleanup intent before kill. Unknown/mismatched
observations or failed journal writes never establish absence. An already-absent
resource is verified separately and is not reported as an observed kill.

These are source/local-test controls, not multi-process journal locking or
managed operational qualification. The filesystem journal has an unkeyed
self-hash, not an authenticity signature; protected host ownership/ACL custody
and a qualified single-writer recovery boundary remain prerequisites before
real provider cleanup can be enabled. No live cleanup metrics or alert drill is
established by synthetic reconciled/unresolved record IDs. Preserve the separate
request-bound cleanup evidence contract and qualify the managed metrics/alerts
against actual recoveries before closing a production gate.

## 1. Source, CI and protected merge

Run both package checks/tests, the mandatory disposable PostgreSQL tests,
packed-consumer tests, documentation checks and scoped secret/private-material
inspection. Review the exact tested commit. Respect repository approval/status
requirements and retain the actual eligible review evidence. Record the
merge SHA separately from candidate/source proof. This gate enables no service.

## 2. Managed PostgreSQL roles and locking

Use a dedicated non-production PostgreSQL 16 database and separately provisioned
owner/migrator/runtime identities with validated TLS and secret-manager custody.
As database owner, apply the dedicated
[control-plane database bootstrap](./ops/postgres/control-plane-owner-bootstrap.sql.template)
before migration 001. It removes PUBLIC database CONNECT/CREATE/TEMPORARY,
grants CONNECT/CREATE to the migrator and CONNECT only to the runtime. The
disposable runtime-role test exercises this exact artifact. Then apply
immutable control-plane migrations 001–003 as the migration owner, then
the dedicated control-plane role template. Worker delivery uses its own schema,
ledger and role template; never combine their migration numbering. Both grant
templates remove the dedicated migrator's global PUBLIC function-EXECUTE default
within this database. Do not run them as a shared migrator.

Construct stores with `expectedOwner`; retain catalog and role reports. Prove
runtime API-key/tenant UPDATE, DDL, grants, memberships, DELETE/TRUNCATE, ledger
mutation and trigger-function execution are denied. Prove tenant suspension,
key revocation/scope/expiry changes serialize with mutation authority checks,
including clock/lease expiry after lock waits. Drift must deny work without
automatic repair. A catalog-only `initialize()` is not role qualification.

## 3. Edge identity, quotas, shutdown and alerts

Provision a real issuer and pinned public keys through an approved secret/key
rotation workflow. The offline verifier supports the dedicated Risk Fork JWT
profile only; bind it through `createTrustedOAuthAuthenticator` to persisted
credential truth. RSA keys must use public exponent 65537; token and persisted
credential windows are strict with no skew allowance. Test valid signatures,
exponent-one forgery rejection and wrong signature/kid/algorithm,
issuer/audience substitution, malformed/duplicate claims, expiration, withdrawn
scope, key revocation and cross-tenant identity. Require public TLS; keep worker
routes on a distinct authenticated network surface.

Back `consumeRateLimit` and `readControl` with an atomic durable service shared
by every instance. The optional [PostgreSQL backend](./REQUEST_POLICY.md) supplies
source/local-test evidence only. Use a dedicated policy database and roles;
never add its tables or grants to an already-attested control-plane or delivery
database. Construct its runtime with `expectedOwner`; source verifies its
independent frozen migration, exact PG16 catalog (including internal FK triggers)
and dedicated least-privilege runtime on every transaction. Retain current
deployed-role/catalog evidence; the local pass is not hosted qualification.
Drain the backend before owner DDL/ACL maintenance. Hosted TLS/rotation/HA,
capacity, retention and load qualification remain open. Fixed windows permit up to two
window quotas across a boundary; choose/review limits for that burst model.
Test combined per-key/per-tenant burst exhaustion across two
instances, fail-closed backend loss, bounded 429 retry, deadlines and retry
storms. Reserve cleanup/recovery capacity. Test disable changes while requests
wait; prove an effect-time broker fence rejects late execution and can stop
in-flight work. The source policy's pre-call decision cannot prove that last
property. Optional [durable policy telemetry](./TELEMETRY.md) now has a source-only
PostgreSQL observer outbox, bounded recording and lease-fenced delivery. This is
not an authority audit or provisioned alert delivery system. Qualify the exact
dedicated telemetry roles/TLS, sink custody, capacity/retention, recovery and
observed operator response; preserve failed/hung/unknown outcomes. Connect
durable redacted metrics/alerts for budget pressure, lease
expiry, provider errors, cleanup backlog/failure, audit failures and DB health,
and retain an observed alert/response drill without raw tokens or arguments.

## 4. Restore, failover, rotation and E2B

Database: restore an isolated backup/PITR target without overwriting the source;
compare migration/catalog hashes, immutable provider bindings, tenant budget
reservations, historical token tombstones, exact journal/delivery response
hashes and audit-chain anchors. Exercise approved failover/unknown-commit loss
against two instances: exact idempotency retries converge, only one logical
provider effect occurs, and resources reconcile before terminal completion.
Rotate DB credentials and delivery encryption keys while obligations remain;
old obligations must remain recoverable under the documented retention/key
policy. Retain timestamps, RPO/RTO, monitoring observations and verified cleanup
of disposable restore resources. Local Docker restart tests do not establish
managed high availability or point-in-time recovery.

Delivery source now supports one active encryption key plus at most eight
explicit retired decrypt-only keys, preserving immutable v1 ciphertext and
current worker authorization across restart. See [WORKER.md](./WORKER.md).
Retain keys for the full approved recovery/backup retention horizon; an empty
pending list is not a safe-retirement proof. Local in-memory and disposable
PostgreSQL rotation tests are not secret-manager, database credential rotation,
backup/PITR, or managed-service qualification evidence.

E2B: before the first paid allocation, establish the authorized total ceiling
and a hard enforceable bound including sandbox lifetime, concurrent allocation,
retries, teardown and delayed/finalized charges. Credit-card setup or a budget
alert alone is not proof of a hard cap. Pin account/template/runtime/SDK/adapter
and require provider-authenticated isolation evidence: no inherited parent
credentials, blocked first-instruction IPv4/IPv6/DNS egress where required,
filesystem/process boundaries, TTL, recovery-key lookup and independent final
absence verification for both resources. Verify costs after billing finalizes;
unresolved cleanup/cost keeps the qualification false. Do not promote fake-SDK
or provider-free test evidence into a live qualification receipt. If a cap or
isolation property cannot be established, allocate nothing and retain that gap.

## 5. Default-off staging and bounded canary

Only after the preceding evidence is reviewed, deploy the exact artifact to
non-production default-off, with no live agent traffic. Verify owner installation
and two-instance/restart conformance using real clients: principal/handle
substitution, lease/journal replay and response loss, wrong issuer/audience,
expired handles, MCP per-request metadata/header-body binding, malicious MCP
structured results, Apps active-content denial, cache poisoning, and disabled
MRTR/Tasks. Qualify a narrow enrolled-tenant canary separately with concurrency,
TTL, spend, expiry and kill-switch limits; no public allocation endpoint.
Retain out-of-band cleanup/absence and finalized cost before deciding whether
to activate. Keep deployment, provider qualification and live protection as
separate truth labels. No canary is authorized by this runbook itself.
