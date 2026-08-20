import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { LocalReferenceRiskForkAdapter } from '../src/adapters/local-reference.mjs';
import { PostgresDistributedCommitAuthority } from '../src/adapters/postgres-authority.mjs';
import {
  createPostgresAuthorityPool,
  migratePostgresDistributedAuthority,
  quotePostgresAuthorityIdentifier,
} from '../src/adapters/postgres-authority-migrator.mjs';
import { sha256Ref } from '../src/canonical.mjs';
import { RiskForkController } from '../src/controller.mjs';

const ADMIN_URL = process.env.RISK_FORK_TEST_POSTGRES_TLS_URL ?? null;
const TLS_CA = process.env.RISK_FORK_TEST_POSTGRES_TLS_CA ?? null;

if (
  process.env.RISK_FORK_REQUIRE_POSTGRES_TLS_TESTS === '1'
  && (!ADMIN_URL || !TLS_CA)
) {
  throw new Error(
    'RISK_FORK_REQUIRE_POSTGRES_TLS_TESTS=1 requires both '
    + 'RISK_FORK_TEST_POSTGRES_TLS_URL and RISK_FORK_TEST_POSTGRES_TLS_CA',
  );
}

function roleConnectionString(adminUrl, databaseName, roleName, password) {
  const url = new URL(adminUrl);
  for (const parameter of [
    'options',
    'ssl',
    'sslcert',
    'sslkey',
    'sslmode',
    'sslnegotiation',
    'sslrootcert',
    'uselibpqcompat',
  ]) {
    url.searchParams.delete(parameter);
  }
  url.pathname = `/${databaseName}`;
  url.username = roleName;
  url.password = password;
  return url.toString();
}

function adminConnectionString(adminUrl, databaseName = null) {
  const url = new URL(adminUrl);
  for (const parameter of [
    'options',
    'ssl',
    'sslcert',
    'sslkey',
    'sslmode',
    'sslnegotiation',
    'sslrootcert',
    'uselibpqcompat',
  ]) {
    url.searchParams.delete(parameter);
  }
  if (databaseName) url.pathname = `/${databaseName}`;
  return url.toString();
}

function renderRoleTemplate(source, replacements) {
  let rendered = source;
  for (const [placeholder, value] of Object.entries(replacements)) {
    quotePostgresAuthorityIdentifier(value, placeholder);
    rendered = rendered.replaceAll(placeholder, value);
  }
  if (/__RISK_FORK_[A-Z_]+__/.test(rendered)) {
    throw new Error('PostgreSQL role template has an unresolved placeholder');
  }
  return rendered;
}

test('TLS fresh-database provisioning, migrator, and least-privilege runtime are separated', {
  skip: ADMIN_URL && TLS_CA
    ? false
    : 'set local TLS PostgreSQL test URL and CA to run the role-separation test',
}, async (t) => {
  const suffix = `${process.pid}_${randomBytes(5).toString('hex')}`;
  const databaseName = `risk_fork_hardening_${suffix}`;
  const schemaName = `risk_fork_authority_${suffix}`;
  const malformedSchema = `risk_fork_malformed_${suffix}`;
  const migratorRole = `risk_fork_migrator_${suffix}`;
  const runtimeRole = `risk_fork_runtime_${suffix}`;
  const migratorPassword = randomBytes(24).toString('hex');
  const runtimePassword = randomBytes(24).toString('hex');
  const quotedDatabase = quotePostgresAuthorityIdentifier(databaseName, 'test database');
  const quotedSchema = quotePostgresAuthorityIdentifier(schemaName);
  const quotedMalformedSchema = quotePostgresAuthorityIdentifier(malformedSchema);
  const quotedMigratorRole = quotePostgresAuthorityIdentifier(migratorRole, 'migrator role');
  const quotedRuntimeRole = quotePostgresAuthorityIdentifier(runtimeRole, 'runtime role');
  const quotedInheritanceChild = quotePostgresAuthorityIdentifier(
    'authority_meta_shadow',
    'inheritance child table',
  );
  const ownerBootstrapTemplate = await readFile(
    new URL('../ops/postgres/owner-bootstrap.sql.template', import.meta.url),
    'utf8',
  );
  const postMigrationTemplate = await readFile(
    new URL('../ops/postgres/roles.sql.template', import.meta.url),
    'utf8',
  );
  const templateValues = {
    __RISK_FORK_DATABASE__: databaseName,
    __RISK_FORK_SCHEMA__: schemaName,
    __RISK_FORK_MIGRATOR_ROLE__: migratorRole,
    __RISK_FORK_RUNTIME_ROLE__: runtimeRole,
  };
  const ownerBootstrap = renderRoleTemplate(ownerBootstrapTemplate, templateValues);
  const postMigrationGrants = renderRoleTemplate(postMigrationTemplate, templateValues);

  const adminPool = await createPostgresAuthorityPool({
    connectionString: adminConnectionString(ADMIN_URL),
    requireTls: true,
    tls: { ca: TLS_CA },
    maxConnections: 2,
    applicationName: 'risk-fork-hardening-test-admin',
  });
  let databaseCreated = false;
  let migratorCreated = false;
  let runtimeCreated = false;
  let ownerPool = null;
  let migratorPool = null;
  let runtimePool = null;
  let authority = null;
  t.after(async () => {
    await authority?.close().catch(() => {});
    await runtimePool?.end().catch(() => {});
    await migratorPool?.end().catch(() => {});
    await ownerPool?.end().catch(() => {});
    if (databaseCreated) {
      await adminPool.query(
        `SELECT pg_terminate_backend(pid)
           FROM pg_catalog.pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [databaseName],
      ).catch(() => {});
      await adminPool.query(`DROP DATABASE IF EXISTS ${quotedDatabase}`).catch(() => {});
    }
    if (runtimeCreated) {
      await adminPool.query(`DROP ROLE IF EXISTS ${quotedRuntimeRole}`).catch(() => {});
    }
    if (migratorCreated) {
      await adminPool.query(`DROP ROLE IF EXISTS ${quotedMigratorRole}`).catch(() => {});
    }
    await adminPool.end().catch(() => {});
  });

  await adminPool.query(
    `CREATE ROLE ${quotedMigratorRole} NOINHERIT LOGIN PASSWORD '${migratorPassword}'`,
  );
  migratorCreated = true;
  await adminPool.query(
    `CREATE ROLE ${quotedRuntimeRole} NOINHERIT LOGIN PASSWORD '${runtimePassword}'`,
  );
  runtimeCreated = true;
  await adminPool.query(`CREATE DATABASE ${quotedDatabase}`);
  databaseCreated = true;

  ownerPool = await createPostgresAuthorityPool({
    connectionString: adminConnectionString(ADMIN_URL, databaseName),
    requireTls: true,
    tls: { ca: TLS_CA },
    maxConnections: 1,
    applicationName: 'risk-fork-hardening-test-owner',
  });
  await ownerPool.query(ownerBootstrap);

  const migratorUrl = roleConnectionString(
    ADMIN_URL,
    databaseName,
    migratorRole,
    migratorPassword,
  );
  await migratePostgresDistributedAuthority({
    connectionString: migratorUrl,
    schemaName,
    requireTls: true,
    tls: { ca: TLS_CA },
  });
  migratorPool = await createPostgresAuthorityPool({
    connectionString: migratorUrl,
    requireTls: true,
    tls: { ca: TLS_CA },
    maxConnections: 2,
    applicationName: 'risk-fork-hardening-test-migrator',
  });

  // Prove the post-migration template removes independently granted column ACLs.
  await migratorPool.query(
    `GRANT UPDATE (migration_hash)
       ON TABLE ${quotedSchema}.authority_schema_migrations
       TO ${quotedRuntimeRole}`,
  );
  await migratorPool.query(
    `GRANT UPDATE (event_type)
       ON TABLE ${quotedSchema}.audit_events
       TO ${quotedRuntimeRole}`,
  );
  await migratorPool.query(postMigrationGrants);

  const runtimeUrl = roleConnectionString(
    ADMIN_URL,
    databaseName,
    runtimeRole,
    runtimePassword,
  );
  async function assertProductionSchemaRejected(tag, scope) {
    const candidate = new PostgresDistributedCommitAuthority({
      connectionString: runtimeUrl,
      authorityId: `authority:${tag}:${suffix}`,
      schemaName,
      deploymentMode: 'production',
      migrationMode: 'verify-only',
      tls: { ca: TLS_CA },
    });
    try {
      await assert.rejects(
        candidate.initialize(),
        (error) => error.code === 'DISTRIBUTED_AUTHORITY_SCHEMA_INVALID'
          && error.evidence?.scope === scope,
      );
    } finally {
      await candidate.close().catch(() => {});
    }
  }
  let inheritedAuthority = null;
  await migratorPool.query(
    `CREATE TABLE ${quotedSchema}.${quotedInheritanceChild} ()
       INHERITS (${quotedSchema}.authority_meta)`,
  );
  await migratorPool.query(
    `INSERT INTO ${quotedSchema}.${quotedInheritanceChild} (authority_id)
     VALUES ('authority:forged-inheritance-child')`,
  );
  const inheritanceProbe = await createPostgresAuthorityPool({
    connectionString: runtimeUrl,
    requireTls: true,
    tls: { ca: TLS_CA },
    maxConnections: 1,
    applicationName: 'risk-fork-hardening-test-inheritance-probe',
  });
  try {
    const exposed = await inheritanceProbe.query(
      `SELECT authority_id
         FROM ${quotedSchema}.authority_meta
        WHERE authority_id = 'authority:forged-inheritance-child'`,
    );
    assert.equal(exposed.rowCount, 1);
    inheritedAuthority = new PostgresDistributedCommitAuthority({
      connectionString: runtimeUrl,
      authorityId: `authority:inheritance:${suffix}`,
      schemaName,
      deploymentMode: 'production',
      migrationMode: 'verify-only',
      tls: { ca: TLS_CA },
    });
    await assert.rejects(
      inheritedAuthority.initialize(),
      (error) => error.code === 'DISTRIBUTED_AUTHORITY_SCHEMA_INVALID'
        && error.evidence?.scope === 'inheritance',
    );
  } finally {
    await inheritedAuthority?.close().catch(() => {});
    await inheritanceProbe.end().catch(() => {});
    await migratorPool.query(
      `DROP TABLE IF EXISTS ${quotedSchema}.${quotedInheritanceChild}`,
    );
  }

  try {
    await migratorPool.query(
      `CREATE RULE suppress_audit_insert AS
         ON INSERT TO ${quotedSchema}.audit_events DO INSTEAD NOTHING`,
    );
    await assertProductionSchemaRejected('rewrite-rule', 'rewrite_rules');
  } finally {
    await migratorPool.query(
      `DROP RULE IF EXISTS suppress_audit_insert ON ${quotedSchema}.audit_events`,
    );
  }

  try {
    await migratorPool.query(
      `CREATE POLICY dormant_authority_policy
         ON ${quotedSchema}.authority_meta USING (true)`,
    );
    await assertProductionSchemaRejected('row-policy', 'row_security_policies');
  } finally {
    await migratorPool.query(
      `DROP POLICY IF EXISTS dormant_authority_policy ON ${quotedSchema}.authority_meta`,
    );
  }

  for (const [tag, enableSql, disableSql] of [
    [
      'row-security-enabled',
      `ALTER TABLE ${quotedSchema}.authority_meta ENABLE ROW LEVEL SECURITY`,
      `ALTER TABLE ${quotedSchema}.authority_meta DISABLE ROW LEVEL SECURITY`,
    ],
    [
      'row-security-forced',
      `ALTER TABLE ${quotedSchema}.authority_meta FORCE ROW LEVEL SECURITY`,
      `ALTER TABLE ${quotedSchema}.authority_meta NO FORCE ROW LEVEL SECURITY`,
    ],
  ]) {
    try {
      await migratorPool.query(enableSql);
      await assertProductionSchemaRejected(tag, 'relations_and_columns');
    } finally {
      await migratorPool.query(disableSql);
    }
  }

  try {
    await migratorPool.query(
      `ALTER TABLE ${quotedSchema}.authority_meta SET (fillfactor = 70)`,
    );
    await assertProductionSchemaRejected('relation-options', 'table_storage');
  } finally {
    await migratorPool.query(
      `ALTER TABLE ${quotedSchema}.authority_meta RESET (fillfactor)`,
    );
  }

  try {
    await migratorPool.query(
      `ALTER TABLE ${quotedSchema}.authority_meta
         ALTER COLUMN schema_version SET DEFAULT 2`,
    );
    await assertProductionSchemaRejected('column-default', 'relations_and_columns');
  } finally {
    await migratorPool.query(
      `ALTER TABLE ${quotedSchema}.authority_meta
         ALTER COLUMN schema_version SET DEFAULT 1`,
    );
  }

  try {
    await migratorPool.query(
      `ALTER TABLE ${quotedSchema}.audit_events
         ALTER COLUMN sequence ADD GENERATED ALWAYS AS IDENTITY`,
    );
    await assertProductionSchemaRejected('identity-column', 'generated_columns');
  } finally {
    await migratorPool.query(
      `ALTER TABLE ${quotedSchema}.audit_events
         ALTER COLUMN sequence DROP IDENTITY IF EXISTS`,
    );
  }

  try {
    await migratorPool.query(
      `ALTER TABLE ${quotedSchema}.operations
         ALTER COLUMN status TYPE text COLLATE "C" USING status`,
    );
    await assertProductionSchemaRejected('column-collation', 'column_collation');
  } finally {
    await migratorPool.query(
      `ALTER TABLE ${quotedSchema}.operations
         ALTER COLUMN status TYPE text COLLATE "default" USING status`,
    );
  }
  const authorityId = `authority:hardening:${suffix}`;
  const parentRef = `parent:hardening:${suffix}`;
  authority = new PostgresDistributedCommitAuthority({
    connectionString: runtimeUrl,
    authorityId,
    schemaName,
    deploymentMode: 'production',
    migrationMode: 'verify-only',
    tls: { ca: TLS_CA },
  });
  await authority.initialize();
  assert.ok(new RiskForkController({
    provider: new LocalReferenceRiskForkAdapter(),
    mode: 'production',
    distributedCommitAuthority: authority,
    distributedClaimantRef: `claimant:hardening:${suffix}`,
  }));
  const seeded = await authority.seedParentHead({
    parent_ref: parentRef,
    head_hash: sha256Ref(`head:${suffix}`),
  });
  assert.equal(seeded.status, 'active');

  const auditBeforeStatus = await migratorPool.query(
    `SELECT count(*)::integer AS count
       FROM ${quotedSchema}.audit_events
      WHERE authority_id = $1`,
    [authorityId],
  );
  const emptyStatus = await authority.getAuthorityStatus();
  const expectedMigrationHash = sha256Ref((await readFile(
    new URL('../migrations/001_distributed_authority.pg.sql', import.meta.url),
    'utf8',
  )).replace(/\r\n?/g, '\n'));
  assert.deepEqual(Object.keys(emptyStatus).sort(), [
    'database_clock',
    'pool',
    'schema',
    'schema_verification',
    'unresolved',
    'version',
  ]);
  assert.equal(emptyStatus.schema, 'agoragentic.risk-fork.postgres-authority-status.v1');
  assert.equal(emptyStatus.version, 1);
  assert.deepEqual(emptyStatus.schema_verification, {
    verified: true,
    schema_version: 1,
    migration_versions: [1],
    migration_hashes: [expectedMigrationHash],
  });
  assert.equal(emptyStatus.database_clock.reachable, true);
  assert.doesNotThrow(() => new Date(emptyStatus.database_clock.observed_at).toISOString());
  assert.deepEqual(emptyStatus.unresolved, {
    counts: { prepared: 0, effect_started: 0, ambiguous: 0 },
    oldest_updated_at: null,
    oldest_age_ms: null,
  });
  assert.deepEqual(Object.keys(emptyStatus.pool).sort(), [
    'idle_connections',
    'total_connections',
    'waiting_requests',
  ]);
  for (const value of Object.values(emptyStatus.pool)) {
    assert.equal(Number.isSafeInteger(value) && value >= 0, true);
  }
  assert.equal(Object.isFrozen(emptyStatus), true);
  assert.equal(Object.isFrozen(emptyStatus.schema_verification), true);
  assert.equal(Object.isFrozen(emptyStatus.schema_verification.migration_versions), true);
  assert.equal(Object.isFrozen(emptyStatus.unresolved.counts), true);
  assert.equal(Object.isFrozen(emptyStatus.pool), true);
  const auditAfterStatus = await migratorPool.query(
    `SELECT count(*)::integer AS count
       FROM ${quotedSchema}.audit_events
      WHERE authority_id = $1`,
    [authorityId],
  );
  assert.equal(auditAfterStatus.rows[0].count, auditBeforeStatus.rows[0].count);

  for (const [index, phase, ageSeconds] of [
    [0, 'prepared', 30],
    [1, 'effect_started', 60],
    [2, 'ambiguous', 90],
  ]) {
    const approvalKey = sha256Ref(`status-approval:${index}:${suffix}`);
    const artifactHash = sha256Ref(`status-artifact:${index}:${suffix}`);
    const capsuleHash = sha256Ref(`status-capsule:${index}:${suffix}`);
    const governanceHash = sha256Ref(`status-governance:${index}:${suffix}`);
    const evidenceHash = sha256Ref(`status-evidence:${index}:${suffix}`);
    await migratorPool.query(
      `INSERT INTO ${quotedSchema}.commit_approvals (
         authority_id, approval_key, parent_ref, status, artifact_hash,
         capsule_hash, parent_state_hash, commit_type, governance_hash,
         evidence_ref, evidence_hash, registered_at, updated_at
       ) VALUES (
         $1,$2,$3,'active',$4,$5,$6,'TYPED_RESULT',$7,$8,$9,
         clock_timestamp(),clock_timestamp()
       )`,
      [
        authorityId,
        approvalKey,
        parentRef,
        artifactHash,
        capsuleHash,
        seeded.head_hash,
        governanceHash,
        `evidence:status:${index}:${suffix}`,
        evidenceHash,
      ],
    );
    const effectKey = phase === 'prepared' ? null : `effect:status:${index}:${suffix}`;
    const effectTokenHash = phase === 'prepared'
      ? null
      : sha256Ref(`status-effect-token:${index}:${suffix}`);
    const claimantRef = phase === 'prepared' ? null : `claimant:status:${index}:${suffix}`;
    await migratorPool.query(
      `INSERT INTO ${quotedSchema}.operations (
         authority_id, operation_ref, request_hash, authority_request_hash,
         parent_ref, approval_key, status, commit_type, previous_head_hash,
         artifact_hash, capsule_hash, governance_hash,
         governance_evidence_hash, approval_evidence_ref,
         approval_evidence_hash, capsule_expires_at, effect_key,
         effect_token_hash, claimant_ref, effect_started_at,
         failure_code, failure_message, prepared_at, updated_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,'TYPED_RESULT',$8,$9,$10,$11,$12,$13,$14,
         clock_timestamp() + interval '1 hour',$15,$16,$17,
         CASE WHEN $7 = 'prepared' THEN NULL
              ELSE clock_timestamp() - ($18::integer * interval '1 second') END,
         CASE WHEN $7 = 'ambiguous' THEN 'STATUS_TEST' ELSE NULL END,
         CASE WHEN $7 = 'ambiguous' THEN 'status_test_redacted' ELSE NULL END,
         clock_timestamp() - ($18::integer * interval '1 second'),
         clock_timestamp() - ($18::integer * interval '1 second')
       )`,
      [
        authorityId,
        `operation:status:${index}:${suffix}`,
        sha256Ref(`status-request:${index}:${suffix}`),
        sha256Ref(`status-authority-request:${index}:${suffix}`),
        parentRef,
        approvalKey,
        phase,
        seeded.head_hash,
        artifactHash,
        capsuleHash,
        governanceHash,
        sha256Ref(`status-governance-evidence:${index}:${suffix}`),
        `evidence:status:${index}:${suffix}`,
        evidenceHash,
        effectKey,
        effectTokenHash,
        claimantRef,
        ageSeconds,
      ],
    );
  }

  const unresolvedStatus = await authority.getAuthorityStatus();
  assert.deepEqual(unresolvedStatus.unresolved.counts, {
    prepared: 1,
    effect_started: 1,
    ambiguous: 1,
  });
  assert.doesNotThrow(() => new Date(unresolvedStatus.unresolved.oldest_updated_at).toISOString());
  assert.equal(unresolvedStatus.unresolved.oldest_age_ms >= 85_000, true);
  const serializedStatus = JSON.stringify(unresolvedStatus);
  for (const forbidden of [
    runtimeUrl,
    TLS_CA,
    runtimeRole,
    migratorRole,
    runtimePassword,
    migratorPassword,
    schemaName,
    authorityId,
    parentRef,
    'status_test_redacted',
  ]) {
    assert.equal(serializedStatus.includes(forbidden), false);
  }

  runtimePool = await createPostgresAuthorityPool({
    connectionString: runtimeUrl,
    requireTls: true,
    tls: { ca: TLS_CA },
    maxConnections: 1,
    applicationName: 'risk-fork-hardening-test-runtime-inspection',
  });
  const tls = await runtimePool.query(
    `SELECT ssl
       FROM pg_catalog.pg_stat_ssl
      WHERE pid = pg_backend_pid()`,
  );
  assert.equal(tls.rows[0].ssl, true);
  await assert.rejects(
    runtimePool.query(`CREATE TABLE ${quotedSchema}.forbidden_runtime_ddl (id integer)`),
    (error) => error.code === '42501',
  );
  await assert.rejects(
    runtimePool.query(`UPDATE ${quotedSchema}.audit_events SET event_type = 'forbidden'`),
    (error) => error.code === '42501',
  );
  await assert.rejects(
    runtimePool.query(
      `UPDATE ${quotedSchema}.authority_schema_migrations
          SET migration_hash = migration_hash`,
    ),
    (error) => error.code === '42501',
  );
  const migrationCount = await runtimePool.query(
    `SELECT count(*)::integer AS count
       FROM ${quotedSchema}.authority_schema_migrations`,
  );
  assert.equal(migrationCount.rows[0].count, 1);

  // A pre-existing malformed relation must never be blessed with migration 001's hash.
  await migratorPool.query(`CREATE SCHEMA ${quotedMalformedSchema}`);
  await migratorPool.query(
    `CREATE TABLE ${quotedMalformedSchema}.authority_schema_migrations (
       version integer PRIMARY KEY,
       migration_hash text NOT NULL,
       applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
     )`,
  );
  await assert.rejects(
    migratePostgresDistributedAuthority({
      connectionString: migratorUrl,
      schemaName: malformedSchema,
      requireTls: true,
      tls: { ca: TLS_CA },
    }),
    (error) => error.code === 'DISTRIBUTED_AUTHORITY_SCHEMA_INVALID',
  );
  const malformedMigrations = await migratorPool.query(
    `SELECT count(*)::integer AS count
       FROM ${quotedMalformedSchema}.authority_schema_migrations`,
  );
  assert.equal(malformedMigrations.rows[0].count, 0);
  await migratorPool.query(`DROP SCHEMA ${quotedMalformedSchema} CASCADE`);

  await authority.close();
  authority = null;
  await runtimePool.end();
  runtimePool = null;
  await adminPool.query(`GRANT ${quotedMigratorRole} TO ${quotedRuntimeRole}`);
  const memberAuthority = new PostgresDistributedCommitAuthority({
    connectionString: runtimeUrl,
    authorityId: `authority:membership:${suffix}`,
    schemaName,
    deploymentMode: 'production',
    migrationMode: 'verify-only',
    tls: { ca: TLS_CA },
  });
  await assert.rejects(
    memberAuthority.initialize(),
    (error) => error.code === 'DISTRIBUTED_AUTHORITY_RUNTIME_PRIVILEGES_INVALID'
      && error.evidence?.scope === 'role_membership',
  );
  await memberAuthority.close();
  await adminPool.query(`REVOKE ${quotedMigratorRole} FROM ${quotedRuntimeRole}`);

  await migratorPool.query(
    `GRANT UPDATE (event_type)
       ON TABLE ${quotedSchema}.audit_events
       TO ${quotedRuntimeRole}`,
  );
  const columnAuthority = new PostgresDistributedCommitAuthority({
    connectionString: runtimeUrl,
    authorityId: `authority:column-acl:${suffix}`,
    schemaName,
    deploymentMode: 'production',
    migrationMode: 'verify-only',
    tls: { ca: TLS_CA },
  });
  await assert.rejects(
    columnAuthority.initialize(),
    (error) => error.code === 'DISTRIBUTED_AUTHORITY_RUNTIME_PRIVILEGES_INVALID'
      && error.evidence?.scope === 'column'
      && error.evidence?.relation === 'audit_events',
  );
  await columnAuthority.close();
  await migratorPool.query(
    `REVOKE UPDATE (event_type)
       ON TABLE ${quotedSchema}.audit_events
       FROM ${quotedRuntimeRole}`,
  );
});
