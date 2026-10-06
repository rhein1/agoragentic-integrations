import { canonicalize, sha256Ref } from '../../src/canonical.mjs';
import { managedError, requireInteger } from './validation.mjs';
import { telemetryDbInteger } from './postgres-telemetry-config.mjs';
import { readBacklogGauge, readBacklogGaugeRow } from './postgres-backlog-gauge-state.mjs';
import { backlogGaugeHash } from './backlog-gauge.mjs';
import { advanceBacklogAlertState, backlogAlertSettingsHash, backlogAlertStateHash, backlogAlertTotalsHash,
  baselineBacklogAlertState, normalizeBacklogAlertSettings, normalizeBacklogAlertState, normalizeManagedBacklogAlert } from './backlog-alert.mjs';

const fail = (code = 'TELEMETRY_BACKLOG_ALERT_DRIFT') => managedError('Backlog alert custody unavailable',code,503);
export function readBacklogAlert(row, settings) {
  const event = normalizeManagedBacklogAlert(row.payload), configured = normalizeBacklogAlertSettings(settings);
  const rule = configured.rules.find((value) => value.rule_id === event.rule_id);
  if (!rule || event.threshold !== rule.threshold || event.settings_hash !== backlogAlertSettingsHash(configured)
    || row.event_ref !== event.event_ref || row.event_hash !== sha256Ref(event) || row.tenant_hash !== event.tenant_hash
    || row.rule_id !== event.rule_id || telemetryDbInteger(row.episode) !== event.episode || telemetryDbInteger(row.transition) !== event.transition
    || telemetryDbInteger(row.created_ms) !== event.recorded_ms || canonicalize(row.payload) !== canonicalize(event)) throw fail();
  if (row.state === 'acked' && (row.acknowledgement_hash !== sha256Ref({ event_ref: event.event_ref,delivered: true })
    || telemetryDbInteger(row.acknowledged_ms) < event.recorded_ms)) throw fail();
  return event;
}
export async function verifyBacklogAlertCustody(client, config) {
  if (config.metricVersion !== 9) return;
  const s = config.quotedSchema, settings = config.backlogAlertSettings;
  const bound = await client.query(`SELECT settings_hash,payload FROM ${s}.telemetry_backlog_alert_settings WHERE singleton=true`);
  if (bound.rowCount !== 1 || bound.rows[0].settings_hash !== backlogAlertSettingsHash(settings)
    || canonicalize(bound.rows[0].payload) !== canonicalize(settings)) throw fail();
  const totals = await client.query(`SELECT alert_count,state_hash FROM ${s}.telemetry_backlog_alert_totals WHERE singleton=true`);
  const count = await client.query(`SELECT count(*)::integer AS n FROM ${s}.telemetry_backlog_alerts`);
  const n = count.rows[0]?.n, total = totals.rows[0];
  if (count.rowCount !== 1 || totals.rowCount !== 1 || !Number.isInteger(n) || n < 0 || n > settings.maxAlerts
    || total.alert_count !== n || total.state_hash !== backlogAlertTotalsHash(n)) throw fail();
  const mismatch = await client.query(`SELECT 1 FROM ${s}.telemetry_backlog_state g FULL JOIN ${s}.telemetry_backlog_alert_state t USING (tenant_hash)
    WHERE g.tenant_hash IS NULL OR t.tenant_hash IS NULL LIMIT 1`);
  const orphan = await client.query(`SELECT 1 FROM ${s}.telemetry_backlog_alerts a LEFT JOIN ${s}.telemetry_backlog_alert_state t USING (tenant_hash)
    WHERE t.tenant_hash IS NULL LIMIT 1`);
  const overflow = await client.query(`SELECT 1 FROM ${s}.telemetry_backlog_alerts GROUP BY tenant_hash HAVING count(*)>$1 LIMIT 1`,[settings.maxAlertsPerTenant]);
  if (mismatch.rowCount || orphan.rowCount || overflow.rowCount) throw fail();
}
export async function readBacklogAlertState(client, config, tenantHash) {
  const s = config.quotedSchema, gauge = await readBacklogGauge(client,config,tenantHash);
  const result = await client.query(`SELECT tenant_hash,payload,state_hash FROM ${s}.telemetry_backlog_alert_state WHERE tenant_hash=$1`,[tenantHash]);
  if (!gauge) { if (result.rowCount) throw fail(); return null; }
  if (result.rowCount !== 1) throw fail();
  const row = result.rows[0], state = normalizeBacklogAlertState(row.payload,config.backlogAlertSettings);
  if (row.tenant_hash !== tenantHash || state.tenant_hash !== tenantHash || state.gauge_generation !== gauge.generation
    || state.gauge_hash !== backlogGaugeHash(gauge) || row.state_hash !== backlogAlertStateHash(state)
    || canonicalize(row.payload) !== canonicalize(state)) throw fail();
  const rows = await client.query(`SELECT * FROM ${s}.telemetry_backlog_alerts WHERE tenant_hash=$1 ORDER BY rule_id COLLATE "C",transition`,[tenantHash]);
  if (rows.rowCount > config.backlogAlertSettings.maxAlertsPerTenant) throw fail();
  let consumed = 0;
  for (const rule of state.rules) {
    let transition = rule.pruned_through, hash = rule.pruned_hash, lastGeneration = rule.pruned_generation;
    for (const retained of rows.rows.filter((entry) => entry.rule_id === rule.rule_id)) {
      const event = readBacklogAlert(retained,config.backlogAlertSettings); consumed += 1;
      if (event.transition !== transition+1 || event.previous_alert_hash !== hash || event.gauge_generation <= lastGeneration
        || event.gauge_generation > gauge.generation) throw fail();
      transition = event.transition; hash = retained.event_hash; lastGeneration = event.gauge_generation;
    }
    if (transition !== rule.transition || hash !== rule.emitted_hash || (rule.active !== null && rule.active !== (gauge[rule.rule_id] >= rule.threshold))) throw fail();
  }
  if (consumed !== rows.rowCount) throw fail();
  return state;
}
async function writeState(client, config, state, exists) {
  const s = config.quotedSchema;
  const result = exists ? await client.query(`UPDATE ${s}.telemetry_backlog_alert_state SET payload=$2,state_hash=$3 WHERE tenant_hash=$1`,
    [state.tenant_hash,state,backlogAlertStateHash(state)]) : await client.query(`INSERT INTO ${s}.telemetry_backlog_alert_state VALUES ($1,$2,$3)`,
    [state.tenant_hash,state,backlogAlertStateHash(state)]);
  if (result.rowCount !== 1) throw fail();
}
async function writeTotals(client, config) {
  const count = await client.query(`SELECT count(*)::integer AS n FROM ${config.quotedSchema}.telemetry_backlog_alerts`);
  const n = requireInteger(count.rows[0]?.n,'alert_count',{ max: config.backlogAlertSettings.maxAlerts });
  const result = await client.query(`UPDATE ${config.quotedSchema}.telemetry_backlog_alert_totals SET alert_count=$1,state_hash=$2 WHERE singleton=true`,[n,backlogAlertTotalsHash(n)]);
  if (count.rowCount !== 1 || result.rowCount !== 1) throw fail();
}
export async function baselineBacklogAlerts(client, config) {
  const gauges = await client.query(`SELECT tenant_hash,payload,state_hash FROM ${config.quotedSchema}.telemetry_backlog_state ORDER BY tenant_hash COLLATE "C"`);
  if (gauges.rowCount > config.backlogSettings.maxTenants) throw fail();
  // At most 10,000 rows and 64 bounded payloads per insert, in this same tx.
  // Validate every original gauge; do not rewrite its frozen v8 byte meaning.
  for (let offset = 0; offset < gauges.rowCount; offset += 64) {
    const values = gauges.rows.slice(offset,offset+64).map((row) => {
      const state = baselineBacklogAlertState(readBacklogGaugeRow(row,config),config.backlogAlertSettings);
      return { tenant_hash: state.tenant_hash,payload: state,state_hash: backlogAlertStateHash(state) };
    });
    const inserted = await client.query(`INSERT INTO ${config.quotedSchema}.telemetry_backlog_alert_state
      SELECT tenant_hash,payload,state_hash FROM jsonb_to_recordset($1::jsonb) AS r(tenant_hash text,payload jsonb,state_hash text)`,[JSON.stringify(values)]);
    if (inserted.rowCount !== values.length) throw fail();
  }
}
export async function recordBacklogAlerts(client, config, previous, gauge) {
  const transition = advanceBacklogAlertState(previous,gauge,config.backlogAlertSettings);
  if (canonicalize(previous) === canonicalize(transition.state)) return;
  const s = config.quotedSchema, counts = await client.query(`SELECT count(*)::integer AS total,count(*) FILTER (WHERE tenant_hash=$1)::integer AS tenant
    FROM ${s}.telemetry_backlog_alerts`,[gauge.tenant_hash]), count = counts.rows[0], settings = config.backlogAlertSettings;
  if (counts.rowCount !== 1 || !Number.isInteger(count.total) || !Number.isInteger(count.tenant)
    || count.total+transition.alerts.length > settings.maxAlerts || count.tenant+transition.alerts.length > settings.maxAlertsPerTenant) throw fail('TELEMETRY_CAPACITY');
  for (const event of transition.alerts) await client.query(`INSERT INTO ${s}.telemetry_backlog_alerts
    (event_ref,event_hash,tenant_hash,rule_id,episode,transition,payload,created_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [event.event_ref,sha256Ref(event),event.tenant_hash,event.rule_id,event.episode,event.transition,event,event.recorded_ms]);
  await writeState(client,config,transition.state,previous !== null);
  await writeTotals(client,config);
}
// Owner-only caller already holds the shared clock and attests the schema.
// Compact only contiguous ACK-expired prefixes; unresolved earlier transitions
// prevent pruning later ones. Fixed hash/ACK checkpoints retain replay custody.
export async function pruneBacklogAlerts(client, config, now, maxDelete) {
  let removed = 0;
  while (removed < maxDelete) {
    const selected = await client.query(`SELECT a.* FROM ${config.quotedSchema}.telemetry_backlog_alerts a
      JOIN ${config.quotedSchema}.telemetry_backlog_alert_state t USING (tenant_hash)
      CROSS JOIN LATERAL jsonb_array_elements(t.payload->'rules') r
      WHERE a.state='acked' AND a.acknowledged_ms<=$1 AND a.rule_id=r->>'rule_id'
        AND a.transition=(r->>'pruned_through')::bigint+1 ORDER BY a.acknowledged_ms,a.event_ref LIMIT 1 FOR UPDATE OF a`,[now-config.limits.retentionMs]);
    if (!selected.rowCount) break;
    const row = selected.rows[0], state = await readBacklogAlertState(client,config,row.tenant_hash), event = readBacklogAlert(row,config.backlogAlertSettings);
    const rules = state.rules.map((rule) => rule.rule_id !== event.rule_id ? rule : { ...rule,pruned_through: event.transition,pruned_generation: event.gauge_generation,pruned_hash: row.event_hash,
      ack_checkpoint_hash: sha256Ref({ domain: 'risk-fork-backlog-alert-ack-checkpoint-v1',prior: rule.ack_checkpoint_hash,
        event_ref: event.event_ref,event_hash: row.event_hash,transition: event.transition,gauge_generation: event.gauge_generation,
        acknowledgement_hash: row.acknowledgement_hash,acknowledged_ms: telemetryDbInteger(row.acknowledged_ms) }) });
    const next = normalizeBacklogAlertState({ ...state,rules },config.backlogAlertSettings);
    if ((await client.query(`DELETE FROM ${config.quotedSchema}.telemetry_backlog_alerts WHERE event_ref=$1 AND state='acked'`,[event.event_ref])).rowCount !== 1) throw fail();
    await writeState(client,config,next,true); await writeTotals(client,config); removed += 1;
  }
  return removed;
}
