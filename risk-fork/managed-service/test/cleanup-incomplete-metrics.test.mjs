import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256Ref } from '../../src/canonical.mjs';
import { LIFECYCLE_SOURCE_EVENT_TYPES, projectManagedLifecycleEvent } from '../src/lifecycle-event.mjs';
import { createManagedMetricAlert, matchingMetricRules, metricRulesHash, normalizeManagedMetricAlert } from '../src/metric-event.mjs';
import { normalizeTelemetryOptions } from '../src/postgres-telemetry-config.mjs';
import { createFixture, invocationRequest } from './helpers.mjs';

const settings = { maxSources: 100, maxSourcesPerTenant: 100, maxWindows: 100, maxWindowsPerTenant: 100,
  maxAlerts: 100, maxAlertsPerTenant: 100, rules: [{ rule_id: 'cleanup_incomplete_observed', threshold: 1, window_ms: 60_000 }] };
const limits = { maxEvents: 100, maxEventsPerTenant: 100, leaseMs: 1000, retryMs: 200, retentionMs: 1000 };
const source = (event_type) => projectManagedLifecycleEvent({ tenant_id: 'tenant_alpha', invocation_ref: 'rfi_incomplete',
  sequence: 1, event_type, occurred_at: '2026-10-06T00:00:00.000Z', event_hash: sha256Ref(event_type),
  details: { error: 'PRIVATE', cost: 99, provider: 'PRIVATE' } });

test('incomplete-attempt rule requires explicit v7 and counts only the exact redacted lifecycle label', () => {
  const options = { lifecycle: true, metrics: true, metricSettings: settings, limits };
  for (const metricVersion of [undefined, 3, 4, 5, 6, 8, '7', true]) assert.throws(() => normalizeTelemetryOptions({ ...options, metricVersion }));
  assert.equal(normalizeTelemetryOptions({ ...options, metricVersion: 7 }).metricVersion, 7);
  assert.throws(() => normalizeTelemetryOptions({ ...options, metrics: false, metricVersion: 7 }));
  assert.throws(() => normalizeTelemetryOptions({ ...options, lifecycle: false, metricVersion: 7 }));
  for (const label of LIFECYCLE_SOURCE_EVENT_TYPES) {
    assert.deepEqual(matchingMetricRules(source(label), 'lifecycle', settings).map((rule) => rule.rule_id),
      label === 'cleanup_incomplete' ? ['cleanup_incomplete_observed'] : []);
  }
  for (const label of ['cleanup_failed', 'cleanup_incomplete_observed', 'cleanup_incomplete_extra', 'provider_error']) {
    assert.throws(() => source(label));
  }
  assert.throws(() => matchingMetricRules(source('cleanup_incomplete'), 'policy', settings));
  assert.equal(JSON.stringify(source('cleanup_incomplete')).includes('PRIVATE'), false);
  const alert = createManagedMetricAlert({ tenant_hash: source('cleanup_incomplete').tenant_hash, rule_id: 'cleanup_incomplete_observed',
    threshold: 1, window_ms: 60_000, window_start_ms: 0, rules_hash: metricRulesHash(settings) });
  assert.deepEqual(normalizeManagedMetricAlert(alert), alert);
  assert.equal(alert.source_kind, 'lifecycle'); assert.equal(alert.evidence_class, 'control_plane_self_attested');
  assert.equal(alert.coverage, 'ingested_observations_only'); assert.equal(alert.production_qualified, false);
  assert.throws(() => normalizeManagedMetricAlert({ ...alert, production_qualified: true }));
});

test('actual memory cleanup generations project once per attempt and never manufacture a terminal outcome', async () => {
  const f = await createFixture();
  const invocation = (await f.controlPlane.admitInvocation(f.principal, invocationRequest())).invocation;
  const ref = invocation.invocation_ref;
  const execution = await f.controlPlane.claimExecution(f.principal, { invocation_ref: ref,
    lease_token: f.nextLeaseToken(), worker_id: 'metric_worker', lease_ms: 30_000 });
  f.attestResourceBinding(invocation, { savepoint_ref: 'metric_savepoint', fork_ref: 'metric_fork' });
  await f.controlPlane.recordResources(f.principal, { invocation_ref: ref, lease_token: execution.lease_token,
    savepoint_ref: 'metric_savepoint', fork_ref: 'metric_fork' });
  await f.controlPlane.recordExecutionOutcome(f.principal, { invocation_ref: ref, lease_token: execution.lease_token,
    outcome: 'succeeded', actual_cost_micros: 0, execution_evidence_hash: sha256Ref('execution'), result_hash: sha256Ref('result') });
  const first = await f.controlPlane.claimCleanup(f.principal, { invocation_ref: ref,
    lease_token: f.nextLeaseToken(), worker_id: 'metric_worker', lease_ms: 5_000 });
  const input = { invocation_ref: ref, lease_token: first.lease_token, lease_generation: first.invocation.lease_generation };
  const a = await f.controlPlane.recordCleanupIncomplete(f.principal, input);
  assert.deepEqual(await f.controlPlane.recordCleanupIncomplete(f.principal, input), a);
  f.setNow('2026-09-05T12:00:06.000Z'); await f.controlPlane.sweepExpiredLeases();
  const second = await f.controlPlane.claimCleanup(f.principal, { invocation_ref: ref,
    lease_token: f.nextLeaseToken(), worker_id: 'metric_worker', lease_ms: 5_000 });
  const b = await f.controlPlane.recordCleanupIncomplete(f.principal, { invocation_ref: ref,
    lease_token: second.lease_token, lease_generation: second.invocation.lease_generation });
  assert.notEqual(a.event_ref, b.event_ref);
  const events = await f.controlPlane.listAuditEvents(f.principal, ref);
  const counted = events.filter((event) => matchingMetricRules(projectManagedLifecycleEvent(event), 'lifecycle', settings).length);
  assert.equal(counted.length, 2); assert.deepEqual(counted.map((event) => event.event_ref), [a.event_ref, b.event_ref]);
  assert.equal(events.some((event) => event.event_type === 'cleanup_verified'), false);
  assert.equal((await f.controlPlane.getInvocation(f.principal, ref)).state, 'cleanup_pending');
});
