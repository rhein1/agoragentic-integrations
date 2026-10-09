import { canonicalize, sha256Ref } from '../../src/canonical.mjs';
import { assertAllowedKeys, assertDataArray, assertPlainRecord, managedError, requireInteger, requireSha256 } from './validation.mjs';
import { createManagedMetricAlert, matchingMetricRules, metricRulesHash, normalizeManagedMetricAlert } from './metric-event.mjs';
import { requireTelemetryRef } from './telemetry-event.mjs';
import { normalizeManagedTelemetryEvent } from './telemetry-event.mjs';
import { normalizeManagedLifecycleEvent } from './lifecycle-event.mjs';
import { DIAGNOSTIC_RULE_IDS, diagnosticRulesHash, normalizeDiagnosticSettings, normalizeManagedDiagnosticObservation } from './diagnostic-event.mjs';
import { WORKER_DIAGNOSTIC_RULE_IDS, workerDiagnosticRulesHash, normalizeWorkerDiagnosticSettings, normalizeManagedWorkerDiagnosticObservation } from './worker-diagnostic-event.mjs';

const WINDOW_FIELDS = ['tenant_hash','rule_id','window_start_ms','window_ms','count','last_alert_ref','last_alert_hash',
  'alert_acknowledged_ms','alert_acknowledgement_hash','rules_hash'];
const SOURCE_FIELDS = ['source_kind','event_ref','event_hash','tenant_hash','recorded_ms','legacy_uncounted','contributions'];
const fail = (code = 'TELEMETRY_METRIC_DRIFT') => managedError('Telemetry metric operation unavailable',code,503);
const windowHash = (value) => sha256Ref({ domain: 'risk-fork-metric-window-v1',value });
const custodyHash = (value) => sha256Ref({ domain: 'risk-fork-metric-custody-v1',value });
export const metricTotalsHash = (source_count,window_count) => sha256Ref({ domain: 'risk-fork-metric-totals-v1',source_count,window_count });
async function actualTotals(client,s) {
  const result = await client.query(`SELECT (SELECT count(*)::integer FROM ${s}.telemetry_metric_sources) AS source_count,
    (SELECT count(*)::integer FROM ${s}.telemetry_metric_windows) AS window_count`);
  if (result.rowCount !== 1) throw fail();
  const row = result.rows[0];
  requireInteger(row.source_count,'source_count',{ max: 1_000_000 }); requireInteger(row.window_count,'window_count',{ max: 1_000_000 });
  return row;
}
export async function verifyMetricTotals(client,config) {
  if (!config.metrics) return;
  const s = config.quotedSchema, result = await client.query(`SELECT source_count,window_count,state_hash FROM ${s}.telemetry_metric_totals WHERE singleton=true`);
  if (result.rowCount !== 1) throw fail();
  const row = result.rows[0], actual = await actualTotals(client,s);
  if (row.source_count !== actual.source_count || row.window_count !== actual.window_count
    || row.state_hash !== metricTotalsHash(actual.source_count,actual.window_count)) throw fail();
  // Existing permanent windows retain delivery obligations. Missing rows are
  // legitimate only after an exact ACK was committed atomically into the window.
  // Derive templates from the closed JS contract, not another SQL vocabulary.
  const configured = [{ rules: config.metricSettings.rules,hash: metricRulesHash(config.metricSettings) },
    ...(config.metricVersion >= 10 ? [{ rules: config.diagnosticSettings.rules,hash: diagnosticRulesHash(config.diagnosticSettings) }] : []),
    ...(config.metricVersion === 11 ? [{ rules: config.workerDiagnosticSettings.rules,hash: workerDiagnosticRulesHash(config.workerDiagnosticSettings) }] : [])];
  const templates = configured.flatMap(({ rules,hash: rules_hash }) => rules.map((rule) => {
    const { event_ref,tenant_hash,window_start_ms,...template } = createManagedMetricAlert({ ...rule,
      tenant_hash: sha256Ref('metric template only'),window_start_ms: 0,rules_hash });
    return { rule_id: rule.rule_id,template };
  }));
  const drift = await client.query(`SELECT 1 FROM ${s}.telemetry_metric_windows w
    LEFT JOIN LATERAL (SELECT rule->'template' AS template FROM jsonb_array_elements($1::jsonb) rule
      WHERE rule->>'rule_id'=w.rule_id) r ON true
    LEFT JOIN ${s}.telemetry_metric_alerts a ON a.event_ref=w.payload->>'last_alert_ref'
    WHERE r.template IS NULL
      OR (((w.payload->>'count')::integer >= (r.template->>'threshold')::integer)
        IS DISTINCT FROM (w.payload->>'last_alert_ref' IS NOT NULL))
      OR (w.payload->>'last_alert_ref' IS NULL AND (w.payload->>'last_alert_hash' IS NOT NULL
        OR w.payload->>'alert_acknowledged_ms' IS NOT NULL OR w.payload->>'alert_acknowledgement_hash' IS NOT NULL))
      OR (w.payload->>'last_alert_ref' IS NOT NULL AND (
        (a.event_ref IS NULL AND w.payload->>'alert_acknowledgement_hash' IS NULL)
        OR (a.event_ref IS NOT NULL AND (a.event_hash IS DISTINCT FROM w.payload->>'last_alert_hash'
          OR a.tenant_hash IS DISTINCT FROM w.tenant_hash
          OR a.payload IS DISTINCT FROM (r.template || jsonb_build_object('event_ref',w.payload->'last_alert_ref',
            'tenant_hash',w.payload->'tenant_hash','window_start_ms',w.payload->'window_start_ms'))
          OR (a.state='acked' IS DISTINCT FROM (w.payload->>'alert_acknowledgement_hash' IS NOT NULL))
          OR (a.state='acked' AND (a.acknowledgement_hash IS DISTINCT FROM w.payload->>'alert_acknowledgement_hash'
            OR a.acknowledged_ms IS DISTINCT FROM (w.payload->>'alert_acknowledged_ms')::bigint)))))) LIMIT 1`,[JSON.stringify(templates)]);
  const orphan = await client.query(`SELECT 1 FROM ${s}.telemetry_metric_alerts a
    WHERE NOT EXISTS (SELECT 1 FROM ${s}.telemetry_metric_windows w
      WHERE w.tenant_hash=a.tenant_hash AND w.payload->>'last_alert_ref'=a.event_ref) LIMIT 1`);
  if (drift.rowCount || orphan.rowCount) throw fail();
}
function closed(value,fields,label) {
  assertPlainRecord(value,label); assertAllowedKeys(value,fields,label);
  if (fields.some((key) => !Object.hasOwn(value,key))) throw new TypeError(label+' requires own fields');
}
function ruleFor(settings,id,diagnosticSettings,workerDiagnosticSettings) {
  if (WORKER_DIAGNOSTIC_RULE_IDS.includes(id)) {
    if (workerDiagnosticSettings === undefined) throw fail();
    const configured = normalizeWorkerDiagnosticSettings(workerDiagnosticSettings), rule = configured.rules.find((value) => value.rule_id === id);
    if (!rule) throw fail();
    return { rule,rulesHash: workerDiagnosticRulesHash(configured) };
  }
  const diagnostic = DIAGNOSTIC_RULE_IDS.includes(id);
  if (diagnostic && diagnosticSettings === undefined) throw fail();
  const configured = diagnostic ? normalizeDiagnosticSettings(diagnosticSettings) : settings;
  const rule = configured.rules.find((value) => value.rule_id === id);
  if (!rule) throw fail();
  return { rule,rulesHash: diagnostic ? diagnosticRulesHash(configured) : metricRulesHash(settings) };
}
function expectedAlert(value,settings,diagnosticSettings,workerDiagnosticSettings) {
  const { rule,rulesHash } = ruleFor(settings,value.rule_id,diagnosticSettings,workerDiagnosticSettings);
  return createManagedMetricAlert({ tenant_hash: value.tenant_hash,rule_id: rule.rule_id,window_start_ms: value.window_start_ms,
    window_ms: rule.window_ms,threshold: rule.threshold,rules_hash: rulesHash });
}
export function readMetricWindow(row,settings,diagnosticSettings,workerDiagnosticSettings) {
  const value = row.payload; closed(value,WINDOW_FIELDS,'metric window');
  const { rule,rulesHash } = ruleFor(settings,value.rule_id,diagnosticSettings,workerDiagnosticSettings);
  requireSha256(value.tenant_hash,'tenant_hash'); requireInteger(value.window_start_ms,'window_start_ms');
  const count = requireInteger(value.count,'metric count',{ min: 1,max: 1_000_000 });
  const alert = expectedAlert(value,settings,diagnosticSettings,workerDiagnosticSettings);
  if (row.tenant_hash !== value.tenant_hash || row.rule_id !== value.rule_id || Number(row.window_start_ms) !== value.window_start_ms
    || value.window_ms !== rule.window_ms || value.rules_hash !== rulesHash
    || value.window_start_ms % value.window_ms !== 0 || windowHash(value) !== row.state_hash) throw fail();
  const ref = count >= rule.threshold ? alert.event_ref : null, hash = count >= rule.threshold ? sha256Ref(alert) : null;
  if (value.last_alert_ref !== ref || value.last_alert_hash !== hash) throw fail();
  if (value.alert_acknowledgement_hash === null) {
    if (value.alert_acknowledged_ms !== null) throw fail();
  } else {
    requireInteger(value.alert_acknowledged_ms,'alert_acknowledged_ms');
    if (ref === null || value.alert_acknowledgement_hash !== sha256Ref({ event_ref: ref,delivered: true })) throw fail();
  }
  return Object.freeze({ ...value });
}
async function windowRow(client,s,tenant,rule,start) {
  const result = await client.query(`SELECT tenant_hash,rule_id,window_start_ms,payload,state_hash FROM ${s}.telemetry_metric_windows
    WHERE tenant_hash=$1 AND rule_id=$2 AND window_start_ms=$3`,[tenant,rule,start]);
  if (result.rowCount > 1) throw fail(); return result.rows[0];
}
export async function assertMetricCapacity(client,s,table,tenant,totalMax,tenantMax) {
  if (!['telemetry_metric_sources','telemetry_metric_windows','telemetry_metric_alerts'].includes(table)) throw new TypeError('Unknown metric table');
  const result = await client.query(`SELECT count(*)::integer AS total,count(*) FILTER (WHERE tenant_hash=$1)::integer AS tenant FROM ${s}.${table}`,[tenant]);
  const row = result.rows[0];
  if (result.rowCount !== 1 || !Number.isInteger(row?.total) || !Number.isInteger(row?.tenant) || row.total < 0 || row.tenant < 0) throw fail();
  if (row.total >= totalMax || row.tenant >= tenantMax) throw fail('TELEMETRY_CAPACITY');
}
// Called only inside the existing clock-serialized observer transaction. The
// permanent exact source packet, not a mutable snapshot hash, is replay custody.
export async function replayMetricSource(client,config,event,kind) {
  if (!config.metrics) return false;
  const s = config.quotedSchema, settings = config.metricSettings;
  const result = await client.query(`SELECT source_kind,event_ref,event_hash,tenant_hash,payload,state_hash FROM ${s}.telemetry_metric_sources
    WHERE source_kind=$1 AND event_ref=$2`,[kind,event.event_ref]);
  if (result.rowCount === 0) return false; if (result.rowCount !== 1) throw fail();
  const row = result.rows[0], value = row.payload;
  closed(value,kind === 'worker_diagnostic' ? [...SOURCE_FIELDS,'worker_diagnostic_event'] : kind === 'diagnostic' ? [...SOURCE_FIELDS,'diagnostic_event'] : SOURCE_FIELDS,'metric custody');
  if (kind === 'diagnostic' && (config.metricVersion < 10 || value.legacy_uncounted !== false
    || canonicalize(normalizeManagedDiagnosticObservation(value.diagnostic_event,config.diagnosticSettings)) !== canonicalize(event))) throw fail();
  if (kind === 'worker_diagnostic' && (config.metricVersion !== 11 || value.legacy_uncounted !== false
    || canonicalize(normalizeManagedWorkerDiagnosticObservation(value.worker_diagnostic_event,config.workerDiagnosticSettings)) !== canonicalize(event))) throw fail();
  requireInteger(value.recorded_ms,'metric recorded_ms');
  if (value.source_kind !== kind || value.event_ref !== event.event_ref || value.event_hash !== sha256Ref(event)
    || value.tenant_hash !== event.tenant_hash || row.source_kind !== kind || row.event_ref !== value.event_ref
    || row.event_hash !== value.event_hash || row.tenant_hash !== value.tenant_hash || custodyHash(value) !== row.state_hash) throw fail('TELEMETRY_EVENT_CONFLICT');
  if (typeof value.legacy_uncounted !== 'boolean') throw fail();
  const rules = value.legacy_uncounted ? [] : sourceRules(event,kind,config);
  const parts = assertDataArray(value.contributions,'metric contributions',{ maxLength: kind === 'worker_diagnostic' ? config.workerDiagnosticSettings.rules.length : kind === 'diagnostic' ? config.diagnosticSettings.rules.length : settings.rules.length });
  if (parts.length !== rules.length) throw fail();
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index], rule = rules[index]; closed(part,['rule_id','window_start_ms','count_after'],'metric contribution');
    const start = Math.floor(value.recorded_ms/rule.window_ms)*rule.window_ms;
    if (part.rule_id !== rule.rule_id || part.window_start_ms !== start) throw fail();
    requireInteger(part.count_after,'count_after',{ min: 1,max: 1_000_000 });
    const kept = await windowRow(client,s,event.tenant_hash,rule.rule_id,start);
    if (!kept || readMetricWindow(kept,settings,config.diagnosticSettings,config.workerDiagnosticSettings).count < part.count_after) throw fail();
  }
  return true;
}
function sourceRules(event,kind,config) {
  if (kind === 'worker_diagnostic') {
    if (config.metricVersion !== 11) throw fail();
    const normalized = normalizeManagedWorkerDiagnosticObservation(event,config.workerDiagnosticSettings);
    return config.workerDiagnosticSettings.rules.filter((rule) => rule.rule_id === 'worker_'+normalized.boundary+'_unconfirmed');
  }
  if (kind !== 'diagnostic') return matchingMetricRules(event,kind,config.metricSettings);
  if (config.metricVersion < 10) throw fail();
  const normalized = normalizeManagedDiagnosticObservation(event,config.diagnosticSettings);
  return config.diagnosticSettings.rules.filter((rule) => rule.rule_id === 'observer_'+normalized.boundary+'_unconfirmed');
}
export async function recordMetricSource(client,config,event,kind,now,{ legacy = false } = {}) {
  if (!config.metrics) return;
  if (await replayMetricSource(client,config,event,kind)) return;
  const s = config.quotedSchema, settings = config.metricSettings, contributions = [];
  await assertMetricCapacity(client,s,'telemetry_metric_sources',event.tenant_hash,settings.maxSources,settings.maxSourcesPerTenant);
  if (['diagnostic','worker_diagnostic'].includes(kind) && legacy) throw fail();
  for (const rule of legacy ? [] : sourceRules(event,kind,config)) {
    const start = Math.floor(now/rule.window_ms)*rule.window_ms;
    const row = await windowRow(client,s,event.tenant_hash,rule.rule_id,start), old = row ? readMetricWindow(row,settings,config.diagnosticSettings,config.workerDiagnosticSettings) : null;
    if (!old) await assertMetricCapacity(client,s,'telemetry_metric_windows',event.tenant_hash,settings.maxWindows,settings.maxWindowsPerTenant);
    const count = requireInteger((old?.count ?? 0)+1,'metric count',{ min: 1,max: 1_000_000 });
    const next = { tenant_hash: event.tenant_hash,rule_id: rule.rule_id,window_start_ms: start,window_ms: rule.window_ms,count,
      last_alert_ref: old?.last_alert_ref ?? null,last_alert_hash: old?.last_alert_hash ?? null,
      alert_acknowledged_ms: old?.alert_acknowledged_ms ?? null,alert_acknowledgement_hash: old?.alert_acknowledgement_hash ?? null,
      rules_hash: ruleFor(settings,rule.rule_id,config.diagnosticSettings,config.workerDiagnosticSettings).rulesHash };
    if (count === rule.threshold) {
      const alert = expectedAlert(next,settings,config.diagnosticSettings,config.workerDiagnosticSettings);
      await assertMetricCapacity(client,s,'telemetry_metric_alerts',event.tenant_hash,settings.maxAlerts,settings.maxAlertsPerTenant);
      await client.query(`INSERT INTO ${s}.telemetry_metric_alerts (event_ref,event_hash,tenant_hash,payload,created_ms) VALUES ($1,$2,$3,$4,$5)`,
        [alert.event_ref,sha256Ref(alert),alert.tenant_hash,alert,now]);
      next.last_alert_ref = alert.event_ref; next.last_alert_hash = sha256Ref(alert);
    }
    if (old) await client.query(`UPDATE ${s}.telemetry_metric_windows SET payload=$4,state_hash=$5 WHERE tenant_hash=$1 AND rule_id=$2 AND window_start_ms=$3`,
      [event.tenant_hash,rule.rule_id,start,next,windowHash(next)]);
    else await client.query(`INSERT INTO ${s}.telemetry_metric_windows (tenant_hash,rule_id,window_start_ms,payload,state_hash) VALUES ($1,$2,$3,$4,$5)`,
      [event.tenant_hash,rule.rule_id,start,next,windowHash(next)]);
    contributions.push({ rule_id: rule.rule_id,window_start_ms: start,count_after: count });
  }
  const payload = { source_kind: kind,event_ref: requireTelemetryRef(event.event_ref),event_hash: sha256Ref(event),tenant_hash: event.tenant_hash,
    recorded_ms: requireInteger(now,'recorded_ms'),legacy_uncounted: legacy,contributions,
    ...(kind === 'diagnostic' ? { diagnostic_event: normalizeManagedDiagnosticObservation(event,config.diagnosticSettings) } : {}),
    ...(kind === 'worker_diagnostic' ? { worker_diagnostic_event: normalizeManagedWorkerDiagnosticObservation(event,config.workerDiagnosticSettings) } : {}) };
  await client.query(`INSERT INTO ${s}.telemetry_metric_sources (source_kind,event_ref,event_hash,tenant_hash,payload,state_hash) VALUES ($1,$2,$3,$4,$5,$6)`,
    [kind,event.event_ref,payload.event_hash,event.tenant_hash,payload,custodyHash(payload)]);
  const totals = await actualTotals(client,s);
  await client.query(`UPDATE ${s}.telemetry_metric_totals SET source_count=$1,window_count=$2,state_hash=$3 WHERE singleton=true`,
    [totals.source_count,totals.window_count,metricTotalsHash(totals.source_count,totals.window_count)]);
}
// Explicit migration baseline preserves existing outboxes without inventing
// historical counter windows or alerts. Already-pruned history is unavailable.
export async function baselineMetricSources(client,config,now) {
  const s = config.quotedSchema;
  for (const kind of ['policy','lifecycle']) {
    const table = kind === 'policy' ? 'telemetry_events' : 'telemetry_lifecycle_events';
    let after = '';
    while (true) {
      const rows = await client.query(`SELECT * FROM ${s}.${table} WHERE event_ref COLLATE "C" > $1 COLLATE "C" ORDER BY event_ref COLLATE "C" LIMIT 64`,[after]);
      for (const row of rows.rows) {
        const event = kind === 'lifecycle' ? normalizeManagedLifecycleEvent(row.payload) : normalizeManagedTelemetryEvent(Object.fromEntries(
          ['event_ref','event','route_class','status','outcome','duration_ms','tenant_hash','key_hash'].map((key) => [key,row[key]])));
        if (row.event_ref !== event.event_ref || row.tenant_hash !== event.tenant_hash || sha256Ref(event) !== row.event_hash
          || (kind === 'lifecycle' && (row.invocation_hash !== event.invocation_hash || row.source_sequence !== event.source_sequence))) throw fail();
        requireInteger(Number(row.created_ms),'legacy created_ms');
        await recordMetricSource(client,config,event,kind,now,{ legacy: true });
        after = row.event_ref;
      }
      if (rows.rows.length < 64) break;
    }
  }
}
export function readMetricAlert(row,settings,diagnosticSettings,workerDiagnosticSettings) {
  const event = normalizeManagedMetricAlert(row.payload);
  if (event.event_ref !== row.event_ref || event.tenant_hash !== row.tenant_hash || sha256Ref(event) !== row.event_hash
    || canonicalize(expectedAlert(event,settings,diagnosticSettings,workerDiagnosticSettings)) !== canonicalize(event)) throw fail();
  return event;
}
export async function acknowledgeMetricAlert(client,config,row,now) {
  const event = readMetricAlert(row,config.metricSettings,config.diagnosticSettings,config.workerDiagnosticSettings), s = config.quotedSchema;
  const kept = await windowRow(client,s,event.tenant_hash,event.rule_id,event.window_start_ms);
  if (!kept) throw fail();
  const previous = readMetricWindow(kept,config.metricSettings,config.diagnosticSettings,config.workerDiagnosticSettings);
  if (previous.last_alert_ref !== event.event_ref || previous.last_alert_hash !== row.event_hash
    || previous.alert_acknowledgement_hash !== null) throw fail();
  const value = { ...previous,alert_acknowledged_ms: requireInteger(now,'alert_acknowledged_ms'),
    alert_acknowledgement_hash: sha256Ref({ event_ref: event.event_ref,delivered: true }) };
  const changed = await client.query(`UPDATE ${s}.telemetry_metric_windows SET payload=$4,state_hash=$5
    WHERE tenant_hash=$1 AND rule_id=$2 AND window_start_ms=$3`,[event.tenant_hash,event.rule_id,event.window_start_ms,value,windowHash(value)]);
  if (changed.rowCount !== 1) throw fail();
}
