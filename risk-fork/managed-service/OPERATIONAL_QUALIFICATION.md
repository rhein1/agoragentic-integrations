# Operational qualification packet (not a pass receipt)

This is a source-only runbook. Nothing here provisions a database, creates an
E2B sandbox, installs credentials, deploys a gateway, or enables live traffic.
All production gates in [DEPLOYMENT_GATES.md](./DEPLOYMENT_GATES.md) remain open
until retained evidence from the exact hosted candidate establishes them.

## Common evidence boundary

Record the commit/tree, locked dependency and runtime digests, provider adapter
digest, schema/migration hashes, environment identifier, test UTC timestamps,
operator authorization and observations. Keep private endpoints, account IDs,
tokens, connection strings, wallet material and keys in an access-controlled
operator evidence store, not this public repository. Public summaries use only
redacted labels and hashes. Local fixture attestations are not independently
signed provider evidence. Preserve failures and cleanup evidence, not only a
success summary.

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
database. Its exact catalog/ACL attestation, hosted TLS/rotation/HA, capacity,
retention and load qualification remain open. Fixed windows permit up to two
window quotas across a boundary; choose/review limits for that burst model.
Test combined per-key/per-tenant burst exhaustion across two
instances, fail-closed backend loss, bounded 429 retry, deadlines and retry
storms. Reserve cleanup/recovery capacity. Test disable changes while requests
wait; prove an effect-time broker fence rejects late execution and can stop
in-flight work. The source policy's pre-call decision cannot prove that last
property. Bounded policy telemetry is not a durable audit or alert delivery
system. Connect durable redacted metrics/alerts for budget pressure, lease
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
