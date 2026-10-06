import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256Ref } from '../../src/canonical.mjs';
import { projectManagedLifecycleEvent } from '../src/lifecycle-event.mjs';
import { createManagedMetricAlert, matchingMetricRules, metricRulesHash } from '../src/metric-event.mjs';
import { normalizeTelemetryOptions } from '../src/postgres-telemetry-config.mjs';
import { createFixture, invocationRequest } from './helpers.mjs';

export const executionMetricSettings = {
  maxSources: 100, maxSourcesPerTenant: 100, maxWindows: 100, maxWindowsPerTenant: 100,
  maxAlerts: 100, maxAlertsPerTenant: 100,
  rules: [{ rule_id: 'execution_failure_observed', threshold: 1, window_ms: 60_000 }],
};
const limits = { maxEvents: 100, maxEventsPerTenant: 100, leaseMs: 1000, retryMs: 200, retentionMs: 1000 };

test('new execution failure rule requires explicit v4 and counts only its exact redacted source label', () => {
  const options = { lifecycle: true, metrics: true, metricSettings: executionMetricSettings, limits };
  assert.throws(() => normalizeTelemetryOptions(options));
  assert.throws(() => normalizeTelemetryOptions({ ...options, metricVersion: 3 }));
  assert.equal(normalizeTelemetryOptions({ ...options, metricVersion: 4 }).metricVersion, 4);
  assert.equal(normalizeTelemetryOptions({ ...options, metricVersion: 5 }).metricVersion, 5);
  assert.equal(normalizeTelemetryOptions({ ...options, metricVersion: 6 }).metricVersion, 6);
  assert.equal(normalizeTelemetryOptions({ ...options, metricVersion: 7 }).metricVersion, 7);
  for (const version of [0, 2, 8, '4', true]) assert.throws(() => normalizeTelemetryOptions({ ...options, metricVersion: version }));
  assert.throws(() => normalizeTelemetryOptions({ limits, metricVersion: 4 }));
  const source = (event_type) => projectManagedLifecycleEvent({ tenant_id: 'tenant_alpha', invocation_ref: 'rfi_metric',
    sequence: 1, event_type, occurred_at: '2026-10-06T00:00:00.000Z', event_hash: sha256Ref(event_type),
    details: { provider_token: 'PRIVATE', error: 'PRIVATE', actual_cost_micros: 99 } });
  const failed = source('execution_failure_observed');
  assert.deepEqual(matchingMetricRules(failed, 'lifecycle', executionMetricSettings).map((r) => r.rule_id), ['execution_failure_observed']);
  for (const label of ['execution_outcome_recorded', 'cleanup_verified', 'cancellation_requested', 'execution_lease_expired']) {
    assert.deepEqual(matchingMetricRules(source(label), 'lifecycle', executionMetricSettings), []);
  }
  assert.equal(JSON.stringify(failed).includes('PRIVATE'), false);
  const alert = createManagedMetricAlert({ tenant_hash: failed.tenant_hash, rule_id: 'execution_failure_observed',
    threshold: 1, window_ms: 60_000, window_start_ms: 0, rules_hash: metricRulesHash(executionMetricSettings) });
  assert.equal(alert.source_kind, 'lifecycle');
  assert.equal(alert.evidence_class, 'control_plane_self_attested');
  assert.equal(alert.coverage, 'ingested_observations_only');
  assert.equal(alert.production_qualified, false);
});

for (const outcome of ['failed', 'succeeded']) {
  test(`actual memory outcome producer labels ${outcome} without changing cleanup obligation`, async () => {
    const f = await createFixture();
    const { invocation } = await f.controlPlane.admitInvocation(f.principal, invocationRequest());
    const lease = await f.controlPlane.claimExecution(f.principal, { invocation_ref: invocation.invocation_ref,
      lease_token: f.nextLeaseToken(), worker_id: 'metric_worker', lease_ms: 30_000 });
    f.attestResourceBinding(invocation, { savepoint_ref: 'metric_savepoint', fork_ref: 'metric_fork' });
    await f.controlPlane.recordResources(f.principal, { invocation_ref: invocation.invocation_ref, lease_token: lease.lease_token,
      savepoint_ref: 'metric_savepoint', fork_ref: 'metric_fork' });
    const packet = { invocation_ref: invocation.invocation_ref, lease_token: lease.lease_token, outcome,
      actual_cost_micros: 0, execution_evidence_hash: sha256Ref('synthetic execution'), result_hash: sha256Ref('synthetic result') };
    const settled = await f.controlPlane.recordExecutionOutcome(f.principal, packet);
    assert.equal(settled.state, 'cleanup_pending');
    assert.equal(settled.execution_outcome, outcome);
    const events = await f.controlPlane.listAuditEvents(f.principal, invocation.invocation_ref);
    assert.equal(events.at(-1).event_type, outcome === 'failed' ? 'execution_failure_observed' : 'execution_outcome_recorded');
    assert.equal(events.filter((e) => e.event_type === 'execution_failure_observed').length, outcome === 'failed' ? 1 : 0);
    await assert.rejects(f.controlPlane.recordExecutionOutcome(f.principal, packet));
    assert.deepEqual(await f.controlPlane.listAuditEvents(f.principal, invocation.invocation_ref), events);
  });
}
