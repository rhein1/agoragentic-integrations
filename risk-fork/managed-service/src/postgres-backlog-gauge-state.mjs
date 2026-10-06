import { canonicalize } from '../../src/canonical.mjs';
import { managedError, requireInteger } from './validation.mjs';
import { MANAGED_BACKLOG_COUNT_FIELDS } from './backlog-snapshot.mjs';
import { backlogGaugeHash, backlogSettingsHash, backlogTotalsHash, normalizeBacklogGauge, normalizeBacklogSettings, sameBacklogState } from './backlog-gauge.mjs';
const fail = (code = 'TELEMETRY_BACKLOG_DRIFT') => managedError('Backlog telemetry unavailable',code,503);

export async function verifyBacklogCustody(client, config) {
  if (![8,9,10].includes(config.metricVersion)) return;
  const s = config.quotedSchema;
  const settings = await client.query(`SELECT settings_hash,payload FROM ${s}.telemetry_backlog_settings WHERE singleton=true`);
  const bound = settings.rows[0];
  if (settings.rowCount !== 1 || bound.settings_hash !== backlogSettingsHash(config.backlogSettings)
    || canonicalize(normalizeBacklogSettings(bound.payload)) !== canonicalize(config.backlogSettings)
    || canonicalize(normalizeBacklogSettings(bound.payload)) !== canonicalize(bound.payload)) throw fail();
  const totals = await client.query(`SELECT tenant_count,state_hash FROM ${s}.telemetry_backlog_totals WHERE singleton=true`);
  const count = await client.query(`SELECT count(*)::integer AS n FROM ${s}.telemetry_backlog_state`);
  const n = count.rows[0]?.n, row = totals.rows[0];
  if (count.rowCount !== 1 || totals.rowCount !== 1 || !Number.isInteger(n) || n < 0 || n > config.backlogSettings.maxTenants
    || row.tenant_count !== n || row.state_hash !== backlogTotalsHash(n)) throw fail();
}

export async function readBacklogGauge(client, config, tenantHash) {
  const result = await client.query(`SELECT tenant_hash,payload,state_hash FROM ${config.quotedSchema}.telemetry_backlog_state WHERE tenant_hash=$1`,[tenantHash]);
  if (result.rowCount === 0) return null;
  if (result.rowCount !== 1) throw fail();
  return readBacklogGaugeRow(result.rows[0],config);
}
export function readBacklogGaugeRow(row, config) {
  const state = normalizeBacklogGauge(row.payload);
  if (!state || state.tenant_hash !== row.tenant_hash || state.settings_hash !== backlogSettingsHash(config.backlogSettings)
    || backlogGaugeHash(state) !== row.state_hash || canonicalize(state) !== canonicalize(row.payload)) throw fail();
  return state;
}

export async function appendBacklogGauge(client, config, input, now) {
  const { snapshot,tenantHash,observerHash,expected,settingsHash,batchHash } = input;
  const current = await readBacklogGauge(client,config,tenantHash), s = config.quotedSchema;
  // Only the exact latest committed request can confirm an unknown COMMIT.
  // A later sample does not establish whether an older request committed.
  if (current?.last_batch_hash === batchHash && current.generation === (expected?.generation ?? 0)+1) {
    return Object.freeze({ persisted: true,batch_hash: batchHash,state: current });
  }
  if (!sameBacklogState(current,expected)) throw fail('TELEMETRY_BACKLOG_CONFLICT');
  if (current) {
    const oldTime = Date.parse(current.source_snapshot_at), nextTime = Date.parse(snapshot.snapshot_at);
    if (nextTime < oldTime || (nextTime === oldTime && snapshot.snapshot_hash !== current.source_snapshot_hash)) throw fail('TELEMETRY_BACKLOG_STALE');
    // An identical source view is not another count, generation or freshness
    // claim. Preserve the original recorded time, even across observer IDs.
    if (snapshot.snapshot_hash === current.source_snapshot_hash) return Object.freeze({ persisted: true,batch_hash: batchHash,state: current });
  } else {
    const count = await client.query(`SELECT tenant_count FROM ${s}.telemetry_backlog_totals WHERE singleton=true`);
    if (count.rows[0].tenant_count >= config.backlogSettings.maxTenants) throw fail('TELEMETRY_CAPACITY');
  }
  const counts = Object.fromEntries(MANAGED_BACKLOG_COUNT_FIELDS.map((key) => [key,snapshot[key]]));
  const state = normalizeBacklogGauge({ schema: 'agoragentic.risk-fork.managed-backlog-gauge.v1',tenant_hash: tenantHash,observer_hash: observerHash,
    generation: requireInteger((current?.generation ?? 0)+1,'generation',{ min: 1 }),source_snapshot_at: snapshot.snapshot_at,
    source_snapshot_hash: snapshot.snapshot_hash,...counts,recorded_ms: now,settings_hash: settingsHash,last_batch_hash: batchHash,
    coverage: 'tenant_scoped_current_snapshot',evidence_class: 'control_plane_self_attested',production_qualified: false });
  if (current) await client.query(`UPDATE ${s}.telemetry_backlog_state SET payload=$2,state_hash=$3 WHERE tenant_hash=$1`,[tenantHash,state,backlogGaugeHash(state)]);
  else {
    await client.query(`INSERT INTO ${s}.telemetry_backlog_state VALUES ($1,$2,$3)`,[tenantHash,state,backlogGaugeHash(state)]);
    const count = await client.query(`SELECT count(*)::integer AS n FROM ${s}.telemetry_backlog_state`);
    const n = count.rows[0].n;
    await client.query(`UPDATE ${s}.telemetry_backlog_totals SET tenant_count=$1,state_hash=$2 WHERE singleton=true`,[n,backlogTotalsHash(n)]);
  }
  return Object.freeze({ persisted: true,batch_hash: batchHash,state });
}
