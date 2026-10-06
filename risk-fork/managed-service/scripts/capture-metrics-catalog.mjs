// Explicit source-tooling capture from the selected reviewed DDL sources in a
// fresh disposable transaction; never runtime inference of expected structure.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { backlogAlertsMigration, backlogGaugesMigration, budgetMetricsMigration, cleanupIncompleteMetricsMigration, cleanupMetricsMigration, diagnosticMetricsMigration, executionMetricsMigration, lifecycleMigration, metricsMigration, telemetryMigration } from '../src/postgres-telemetry-config.mjs';
import { readManagedTelemetryPostgresCatalog } from '../src/postgres-telemetry-attestation.mjs';

const connectionString = process.env.RISK_FORK_MANAGED_TEST_POSTGRES_URL;
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && !['--v4','--v5','--v6','--v7','--v8','--v9','--v10'].includes(args[0]))) throw new Error('Only explicit --v4/--v5/--v6/--v7/--v8/--v9/--v10 capture is supported');
const v10 = args[0] === '--v10', v9 = v10 || args[0] === '--v9', v8 = v9 || args[0] === '--v8', v7 = v8 || args[0] === '--v7', v6 = v7 || args[0] === '--v6', v5 = v6 || args[0] === '--v5', v4 = v5 || args[0] === '--v4';
const url = new URL(connectionString);
if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.pathname !== '/risk_fork_managed_test'
  || process.env.RISK_FORK_MANAGED_TEST_CONFIRM_DISPOSABLE !== 'YES_DELETE_DATA') throw new Error('Catalog capture needs the explicit disposable loopback lab');
const schemaName = 'metric_catalog_'+randomUUID().replaceAll('-',''), pool = new pg.Pool({ connectionString,max: 1 });
const client = await pool.connect();
try {
  const a = await telemetryMigration(schemaName), b = await lifecycleMigration(schemaName), c = await metricsMigration(schemaName);
  await client.query('BEGIN');
  await client.query('SET LOCAL synchronous_commit=on');
  await client.query(`CREATE SCHEMA "${schemaName}"`);
  await client.query(a.sql); await client.query(b.sql); await client.query(c.sql);
  const d = v4 ? await executionMetricsMigration(schemaName) : null;
  if (d) await client.query(d.sql);
  const e = v5 ? await budgetMetricsMigration(schemaName) : null;
  if (e) await client.query(e.sql);
  const f = v6 ? await cleanupMetricsMigration(schemaName) : null;
  if (f) await client.query(f.sql);
  const g = v7 ? await cleanupIncompleteMetricsMigration(schemaName) : null;
  if (g) await client.query(g.sql);
  const h = v8 ? await backlogGaugesMigration(schemaName) : null;
  if (h) await client.query(h.sql);
  const i = v9 ? await backlogAlertsMigration(schemaName) : null;
  if (i) await client.query(i.sql);
  const j = v10 ? await diagnosticMetricsMigration(schemaName) : null;
  if (j) await client.query(j.sql);
  const version = await client.query("SELECT current_setting('server_version_num')::integer AS version");
  if (version.rows[0].version < 160000 || version.rows[0].version >= 170000) throw new Error('PG16 catalog required');
  const manifest = { schema: `agoragentic.risk-fork.telemetry-postgres-catalog.v${v10 ? 10 : v9 ? 9 : v8 ? 8 : v7 ? 7 : v6 ? 6 : v5 ? 5 : v4 ? 4 : 3}`,postgres_major: 16,
    migration_hash: a.hash,lifecycle_migration_hash: b.hash,metrics_migration_hash: c.hash,
    ...(d ? { execution_metrics_migration_hash: d.hash } : {}),
    ...(e ? { budget_metrics_migration_hash: e.hash } : {}),
    ...(f ? { cleanup_metrics_migration_hash: f.hash } : {}),
    ...(g ? { cleanup_incomplete_metrics_migration_hash: g.hash } : {}),
    ...(h ? { backlog_gauges_migration_hash: h.hash } : {}),
    ...(i ? { backlog_alerts_migration_hash: i.hash } : {}),
    ...(j ? { diagnostic_metrics_migration_hash: j.hash } : {}),
    catalog: await readManagedTelemetryPostgresCatalog(client,schemaName) };
  await client.query('ROLLBACK');
  if ((await client.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[schemaName])).rowCount !== 0) throw new Error('Catalog capture cleanup failed');
  process.stdout.write('RISK_FORK_METRIC_CATALOG='+JSON.stringify(manifest)+'\n');
} finally { await client.query('ROLLBACK').catch(() => {}); client.release(); await pool.end(); }
