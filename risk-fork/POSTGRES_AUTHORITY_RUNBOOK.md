# PostgreSQL distributed authority operator runbook

This is a source-only runbook for the reviewed Risk Fork PostgreSQL authority. It is not deployment approval, a managed-service qualification, or permission to route production traffic. PR #298's source-only/default-off merge is gated separately by exact-head CI and genuine independent human approval. Production deployment and activation remain blocked until the managed PostgreSQL, hosted interception, and execution-provider gates documented in [SECURITY_MODEL.md](./SECURITY_MODEL.md) are independently closed.

Use this sequence only in an owner-approved environment with no production traffic until every deployment-specific drill and evidence item below has passed. Do not run the migration command as a routine health check.

## Non-negotiable boundaries

- Keep the database owner, migrator login, and runtime login separate.
- The production runtime must use `deploymentMode: 'production'`, `migrationMode: 'verify-only'`, and CA-authenticated TLS. It must never own or apply DDL.
- Never put passwords, connection URLs, private keys, provider tokens, or CA contents in this repository, rendered SQL, command history, tickets, screenshots, receipts, or logs.
- Never embed PostgreSQL `options`, `ssl`, `sslcert`, `sslkey`, `sslmode`, `sslnegotiation`, `sslrootcert`, or `uselibpqcompat` parameters in the connection URL. The URL host must match the server certificate; a separate TLS `servername` override is rejected.
- Never manually change authority rows to clear a reservation. Never update or delete audit events.
- `prepared` is the only unresolved state that can be recovered without claiming an external effect. `effect_started` and `ambiguous` must never be automatically retried or released.
- A hash, receipt, status record, operator statement, or CLI exit code is not proof that an external effect succeeded. Only an independent trusted verifier bound to the exact operation version, effect key, resolution, result hash, and evidence may establish exact success.

## Provisioning prerequisites

Choose a dedicated database and lowercase identifiers no longer than 63 characters. Use the same reviewed schema name everywhere; the default is `risk_fork_authority`.

Before applying either template, the database owner must create two distinct login roles through the managed credential workflow:

- migrator: `LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`;
- runtime: `LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`, with no direct or transitive role memberships.

Do not place role passwords in SQL. Prefer provider-managed identity or a secret manager with audited rotation. Verify role attributes and memberships as the database owner before continuing.

Create separate connection profiles for the owner, migrator, and runtime. Each network profile must use full certificate and hostname verification against the reviewed CA. Keep connection material in the approved secret store or a protected PostgreSQL service/password file, never in command arguments or checked-in files.

## Fresh provisioning order

### 1. Owner bootstrap

Render [ops/postgres/owner-bootstrap.sql.template](./ops/postgres/owner-bootstrap.sql.template) into an ephemeral file outside the repository. Replace every placeholder exactly once:

- `__RISK_FORK_DATABASE__`
- `__RISK_FORK_SCHEMA__`
- `__RISK_FORK_MIGRATOR_ROLE__`
- `__RISK_FORK_RUNTIME_ROLE__`

Reject the rendered file if any `__RISK_FORK_` placeholder remains. The rendered file must contain identifiers only—never passwords or connection URLs. Execute it as the database owner with stop-on-error behavior, for example through an owner-only PostgreSQL service profile:

```powershell
$env:PGSERVICEFILE = 'C:\protected\risk-fork-pg-service.conf'
$env:PGSERVICE = 'risk_fork_owner'
psql --set=ON_ERROR_STOP=on --file C:\protected\rendered\owner-bootstrap.sql
```

This step removes public database/schema access, gives the migrator the required create privileges, and gives the runtime only database connect and schema usage. Preserve a hash of the redacted rendered template and the database-owner execution record; do not preserve secrets.

### 2. Apply the reviewed migration as the migrator

Run migration 001 only through the separate migrator surface. Do not edit [migrations/001_distributed_authority.pg.sql](./migrations/001_distributed_authority.pg.sql), reimplement it in an operator script, or run production runtime in apply mode.

The checked-in command requires process-scoped values supplied by the approved secret/trust workflow:

- `RISK_FORK_MIGRATION_DATABASE_URL`: migrator connection URL, without TLS or startup-option query parameters;
- `RISK_FORK_TLS_CA`: reviewed CA PEM contents;
- `RISK_FORK_SCHEMA_NAME`: optional reviewed lowercase schema identifier.

```powershell
cd risk-fork
npm run postgres:migrate
```

The migrator constructs its own CA-validating pool, forces safe startup and transaction durability settings, takes a transaction-scoped advisory lock, applies the exact reviewed migration, verifies the catalog before recording its reviewed hash, and rolls back on failure. Treat its sanitized result as migration evidence only. It does not prove deployment readiness, external-effect success, backup viability, or runtime activation.

Clear process-scoped migration variables after the command and follow the secret system's handling policy. Do not echo them or enable shell tracing.

### 3. Apply post-migration runtime grants as the migrator

Render [ops/postgres/roles.sql.template](./ops/postgres/roles.sql.template) into another ephemeral, identifier-only file. Execute it while authenticated as the same migrator that owns the migrated objects:

```powershell
$env:PGSERVICE = 'risk_fork_migrator'
psql --set=ON_ERROR_STOP=on --file C:\protected\rendered\runtime-grants.sql
```

This step removes public and column-level access, installs the reviewed table privileges, denies direct execution of the audit-mutation trigger function, and sets migrator-owned default privileges. A different login cannot safely substitute for the object-owning migrator.

Afterward, use the owner account only to confirm that the runtime role has no role memberships and no database `CREATE` or `TEMPORARY` privilege. Do not grant the runtime membership in the migrator or owner role, including `NOINHERIT` membership.

### 4. Start production in verify-only mode

The embedding application must inject the runtime URL and CA without logging either value:

```js
import { PostgresDistributedCommitAuthority } from '@agoragentic/risk-fork/adapters/postgres-authority';

const authority = new PostgresDistributedCommitAuthority({
  connectionString: runtimeConnectionString,
  tls: { ca: reviewedCaPem },
  authorityId: reviewedAuthorityId,
  schemaName: 'risk_fork_authority',
  deploymentMode: 'production',
  migrationMode: 'verify-only',
  verifyAuthorizationIntegrity,
  verifyReconciliation,
});

await authority.initialize();
```

Initialization fails closed unless TLS is active, `fsync=on`, `synchronous_commit=on`, `session_replication_role=origin`, the reviewed migration set and exact catalog fingerprints match, audit triggers are enabled and bound to the reviewed function, and the runtime role has the exact least-privilege posture. Production controller and public clean-commit construction also reject any authority that is not the exact module-branded production/verify-only/TLS instance.

Do not enable routing merely because initialization returned. Activation requires the deployment-specific approval and evidence checklist below.

## Read-only status and alerts

`getAuthorityStatus()` accepts no input and returns the closed `agoragentic.risk-fork.postgres-authority-status.v1` record. It runs in a bounded read-only transaction, re-verifies the reviewed schema and production privileges, uses database time, and exposes only:

- schema version plus reviewed migration versions and hashes;
- database-clock reachability and observation time;
- counts of `prepared`, `effect_started`, and `ambiguous` operations plus the oldest unresolved timestamp/age;
- pool total, idle, and waiting counts.

It deliberately omits connection strings, CA data, role/schema/authority names, operation IDs, parent IDs, failure messages, results, and evidence contents. Any internal failure collapses to `POSTGRES_AUTHORITY_STATUS_UNAVAILABLE`.

Send only this closed status record to the approved monitor. Alert policy is deployment-owned; the package does not define an operational SLA. At minimum:

| Observation | Required response |
| --- | --- |
| `POSTGRES_AUTHORITY_STATUS_UNAVAILABLE` | Stop or keep routing disabled; investigate TLS, database reachability, schema, privilege, and failover state without logging raw credentials or driver errors |
| Any `effect_started` or `ambiguous` count | Page the reconciliation owner; prohibit automatic replay and reservation release |
| Any `prepared` count | Open an operator review; recover only an exact still-`prepared` version after confirming the durable audit history |
| Oldest unresolved age exceeds the owner-approved response objective | Escalate; age never turns uncertainty into failure or permission to retry |
| Sustained nonzero `waiting_requests` or exhausted idle capacity | Investigate bounded pool/database saturation; do not raise limits without load and failover review |
| Migration/schema verification stops succeeding | Keep startup and routing failed closed; compare against the reviewed migration and provisioning evidence |

`listUnresolved()`, `getOperation()`, and `getAuditTrail()` are read-only operator surfaces but contain identifiers, hashes, results, or detailed evidence. Keep them out of broad telemetry. Restrict their output to the incident record, apply access controls and retention, and never attach raw downstream payloads or secrets.

## Recovery decision table

| Durable state | What it proves | Permitted action |
| --- | --- | --- |
| `prepared` | The authority reserved the graph but did not durably claim or invoke the effect through `runCommit()` | Exact-version prepared recovery may abort and release the reservation after reviewed recovery evidence |
| `effect_started` | The effect was durably claimed and may be running, completed, or awaiting acknowledgement | Disable affected routing; investigate by `effect_key`; never auto-retry or release |
| `ambiguous` | Effect or durable finalization outcome is unresolved | Keep every reservation unavailable; independently reconcile; never auto-retry or release |
| `committed` | The exact result was durably finalized | Return the stored result for exact replay; do not invoke the effect again |
| `aborted` | An exact pre-effect prepared operation was recovered | Retain recovery/audit evidence; any later attempt must pass a new current clean gate |

### Recover an exact prepared operation

1. Disable routing for the affected parent/authority scope.
2. Read the operation with `getOperation(operation_ref)` and verify its exact current `status === 'prepared'` and `version`.
3. Verify the audit chain with `getAuditTrail()` and confirm there is no `effect_started` event for that operation.
4. Store an owner-reviewed recovery artifact outside the database. It must reference the exact operation/version and the reason the pre-effect reservation is being abandoned. Record only its opaque reference and `sha256:` hash in the call.
5. Call `recoverPreparedOperation({ operation_ref, expected_version, recovery_evidence_ref, recovery_evidence_hash })`.
6. Re-read the operation and audit chain. Expect `aborted` and `prepared_operation_recovered`.

The exact-version transaction fails if the state changed. Do not catch that conflict and force recovery with SQL.

### Reconcile effect-started or ambiguous work

Disable affected routing first. Query the authoritative downstream system by the exact `effect_key` and operation bindings. Evidence must come from a system independent of the requesting operator and must bind the exact operation reference, version, effect key, resolution, result hash, and evidence hash.

`reconcileOperation()` requires the authority's trusted `verifyReconciliation` callback. There is intentionally no success/reconciliation CLI. Do not add a callback that simply echoes `verified`, and do not generate “success” from operator input, a database row, a receipt self-hash, HTTP 200, point-in-time absence, or a failed lookup.

- Only independently proven `effect_succeeded` with the exact result may finalize the operation and consume its reservations.
- `effect_absent` and `effect_failed_terminal` observations remain point-in-time evidence. The implementation retains or moves the operation to `ambiguous` and keeps the parent, approval, and one-use authorization unavailable because the original claimant may still complete.
- If exact success cannot be proven, leave the operation ambiguous. Unavailability is safer than a duplicate irreversible effect.

## Rollback and incident containment

Rollback means disable or drain Risk Fork routing and revert the embedding application/configuration. It does not mean releasing uncertain reservations, deleting authority rows, rewriting the audit chain, applying an unreviewed down migration, restoring an older database over live state, or retrying an external effect.

Before any application rollback or database failover:

1. stop new clean commits;
2. capture the sanitized status and restricted unresolved/audit inventory;
3. preserve downstream fencing/idempotency records;
4. complete the database operation;
5. restart only with production/verify-only/TLS initialization;
6. reconcile every pre-existing `effect_started` or `ambiguous` operation before re-enabling the affected route.

An exact `prepared` record may use the prepared recovery procedure. Nothing after a durable effect claim has a safe authority-release path without exact independently verified success.

## Managed-service drills still required

The disposable local TLS tests do not qualify a production service. Before activation, run owner-approved drills in the intended managed environment with synthetic operations and no production effects.

### Backup and PITR

- Enable encrypted backups and continuous WAL/PITR with reviewed retention, RPO, and RTO.
- Prove backups include the entire authority database and audit chain at a consistent point.
- Restore into an isolated database with routing disabled.
- Run production/verify-only initialization against the restore, verify the audit chain, and inventory every unresolved operation.
- Demonstrate that restore procedures do not silently drop post-backup effects or release unresolved reservations. Any gap remains an incident requiring downstream reconciliation.

### HA and failover

- Prove CA/hostname verification against every failover endpoint; do not use `sslmode` URL shortcuts or a server-name override.
- Verify `fsync=on`, `synchronous_commit=on`, `session_replication_role=origin`, reviewed schema hashes, audit triggers, and runtime privileges after failover.
- Inject failover before `prepared`, between `prepared` and `effect_started`, during the downstream effect, and during finalization.
- Prove exact committed replay, exact prepared recovery, and permanent no-auto-retry behavior for `effect_started`/`ambiguous` outcomes.
- Confirm the managed topology cannot expose simultaneous writable primaries or stale reads as authoritative reconciliation evidence.

### Restore and reconciliation

- Keep routing disabled throughout restore validation.
- Compare the restored audit head, migration hashes, unresolved inventory, and downstream `effect_key` records with independently retained evidence.
- Reconcile only exact proven successes. A missing restored row or downstream lookup is not proof that an effect never occurred.
- Require a second reviewer before any routing reactivation.

### Credential and CA rotation

- Rotate owner, migrator, and runtime credentials independently; never grant role membership to make rotation easier.
- Keep the migrator credential unavailable to runtime processes.
- Stage the new CA/credential through the approved secret workflow, restart a verify-only runtime, and require a clean status result before revoking the old credential.
- Test fail-closed behavior for expired, wrong-host, untrusted, and revoked certificates.
- Record secret identifiers/versions and certificate fingerprints only. Never retain credential or CA contents in evidence.

### Reconciliation drill

- Use a synthetic downstream service that records the exact `effect_key`, request binding, result, and durable acknowledgement.
- Exercise exact success, point-in-time absence, terminal-failure observation, verifier outage, version conflict, and delayed completion.
- Prove only exact independently verified success commits and that every other post-effect outcome keeps reservations unavailable.
- Verify the audit chain after each drill and test the on-call escalation path.

## Activation evidence checklist

Record immutable references/hashes, timestamps, reviewers, and explicit `verified`, `failed`, or `unknown` outcomes for:

- exact repository commit, package version, Node/`pg` versions, and unchanged migration 001;
- redacted rendered owner-bootstrap and post-migration template hashes;
- database service/topology, region, version, HA mode, parameter group, maintenance, retention, RPO, and RTO evidence;
- role attributes, absence of runtime memberships, database/schema/table/column/function privilege verification;
- CA/certificate fingerprints, hostname coverage, expiry, rotation owner, and failed-certificate tests;
- migration output, reviewed migration hashes, exact catalog/trigger verification, and production verify-only initialization;
- sanitized `getAuthorityStatus()` output and restricted audit-chain verification;
- backup creation, isolated PITR/restore result, restore-point gap analysis, and routing-disabled proof;
- failover phase, database timeline, unresolved inventory before/after, and downstream fencing records;
- each prepared recovery artifact and each reconciliation verification request/evidence hash;
- monitor/alert delivery, on-call acknowledgement, incident owner, and routing-disable/reactivation approvals;
- confirmation that no secrets, raw payloads, private paths, or self-asserted success claims entered logs or evidence.

Any missing, stale, self-authored, or unverifiable item remains `unknown`. Keep production blocked until the intended deployment and its operator procedures are independently reviewed.
