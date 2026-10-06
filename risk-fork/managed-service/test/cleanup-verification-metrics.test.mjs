import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256Ref } from '../../src/canonical.mjs';
import { createCleanupVerificationEvidence } from '../../src/provider.mjs';
import { projectManagedLifecycleEvent } from '../src/lifecycle-event.mjs';
import { matchingMetricRules, metricRulesHash } from '../src/metric-event.mjs';
import { normalizeTelemetryOptions } from '../src/postgres-telemetry-config.mjs';
import { createFixture, invocationRequest } from './helpers.mjs';

const settings = {
  maxSources: 100, maxSourcesPerTenant: 100, maxWindows: 100, maxWindowsPerTenant: 100,
  maxAlerts: 100, maxAlertsPerTenant: 100,
  rules: [
    { rule_id: 'cleanup_verified', threshold: 1, window_ms: 60_000 },
    { rule_id: 'recovery_absence_verified', threshold: 1, window_ms: 60_000 },
  ],
};
const limits = { maxEvents: 100, maxEventsPerTenant: 100, leaseMs: 1000, retryMs: 200, retentionMs: 1000 };

test('v6 cleanup and recovery labels are exact lifecycle rules and remain self-attested', () => {
  const options = { lifecycle: true, metrics: true, metricSettings: settings, limits, metricVersion: 6 };
  assert.equal(normalizeTelemetryOptions(options).metricVersion, 6);
  for (const version of [undefined, 3, 4, 5]) assert.throws(() => normalizeTelemetryOptions({ ...options, metricVersion: version }));
  const source = (event_type) => projectManagedLifecycleEvent({
    tenant_id: 'tenant_alpha', invocation_ref: 'rfi_metric_v6', sequence: 1, event_type,
    occurred_at: '2026-10-06T00:00:00.000Z', event_hash: sha256Ref(event_type),
    details: { provider_token: 'PRIVATE', evidence_ref: 'PRIVATE' },
  });
  for (const label of ['cleanup_verified', 'recovery_absence_verified']) {
    const event = source(label);
    assert.equal(matchingMetricRules(event, 'lifecycle', settings)[0].rule_id, label);
    assert.equal(matchingMetricRules(event, 'lifecycle', settings)[0].window_ms, 60_000);
    assert.equal(JSON.stringify(event).includes('PRIVATE'), false);
  }
  for (const label of ['execution_outcome_recorded', 'execution_failure_observed', 'cancellation_requested', 'execution_lease_expired']) {
    assert.deepEqual(matchingMetricRules(source(label), 'lifecycle', settings), []);
  }
  assert.match(metricRulesHash(settings), /^sha256:[a-f0-9]{64}$/);
});

async function settleForCleanup(fixture, outcome = 'succeeded') {
  const admitted = await fixture.controlPlane.admitInvocation(fixture.principal, invocationRequest());
  const execution = await fixture.controlPlane.claimExecution(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref, lease_token: fixture.nextLeaseToken(),
    worker_id: 'metric_cleanup_worker', lease_ms: 30_000,
  });
  fixture.attestResourceBinding(admitted.invocation, { savepoint_ref: 'metric_savepoint', fork_ref: 'metric_fork' });
  await fixture.controlPlane.recordResources(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref, lease_token: execution.lease_token,
    savepoint_ref: 'metric_savepoint', fork_ref: 'metric_fork',
  });
  await fixture.controlPlane.recordExecutionOutcome(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref, lease_token: execution.lease_token,
    outcome, actual_cost_micros: 0, execution_evidence_hash: sha256Ref('execution'), result_hash: sha256Ref('result'),
  });
  const cleanup = await fixture.controlPlane.claimCleanup(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref, lease_token: fixture.nextLeaseToken(),
    worker_id: 'metric_cleanup_worker', lease_ms: 30_000,
  });
  return { admitted, cleanup };
}

test('memory producers emit one exact cleanup and recovery observation only after verification', async () => {
  const fixture = await createFixture();
  const { admitted, cleanup } = await settleForCleanup(fixture);
  const evidence = cleanup.invocation.cleanup_requests.map((request, index) => createCleanupVerificationEvidence(request, {
    status: 'verified', observed_at: '2026-09-05T12:00:00.000Z', evidence_ref: `metric_cleanup_${index}`,
    observation_hash: sha256Ref({ metric_cleanup: index }),
  }));
  for (const item of evidence) fixture.attestCleanupEvidence(item);
  const completed = await fixture.controlPlane.completeCleanup(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref, lease_token: cleanup.lease_token, cleanup_evidence: evidence,
  });
  assert.equal(completed.state, 'completed');
  let events = await fixture.controlPlane.listAuditEvents(fixture.principal, admitted.invocation.invocation_ref);
  assert.equal(events.filter((event) => event.event_type === 'cleanup_verified').length, 1);

  const recoveryFixture = await createFixture();
  const recoveryAdmitted = await recoveryFixture.controlPlane.admitInvocation(recoveryFixture.principal, invocationRequest({ idempotency_key: 'recovery-v6-00000001' }));
  await recoveryFixture.controlPlane.claimExecution(recoveryFixture.principal, {
    invocation_ref: recoveryAdmitted.invocation.invocation_ref, lease_token: recoveryFixture.nextLeaseToken(),
    worker_id: 'metric_recovery_worker', lease_ms: 5_000,
  });
  recoveryFixture.setNow('2026-09-05T12:00:06.000Z');
  await recoveryFixture.controlPlane.sweepExpiredLeases();
  const recovery = await recoveryFixture.controlPlane.claimRecovery(recoveryFixture.principal, {
    invocation_ref: recoveryAdmitted.invocation.invocation_ref, lease_token: recoveryFixture.nextLeaseToken(),
    worker_id: 'metric_recovery_worker', lease_ms: 30_000,
  });
  const recoveryEvidence = {
    schema: 'agoragentic.risk-fork.recovery-absence-evidence.v1',
    provider_recovery_key: recoveryAdmitted.invocation.provider_recovery_key,
    observed_at: '2026-09-05T12:00:06.000Z', evidence_ref: 'metric_recovery_absence',
    observation_hash: sha256Ref({ metric_recovery: true }),
  };
  recoveryFixture.attestRecoveryAbsence(recoveryEvidence);
  const recovered = await recoveryFixture.controlPlane.completeRecoveryAbsence(recoveryFixture.principal, {
    invocation_ref: recoveryAdmitted.invocation.invocation_ref, lease_token: recovery.lease_token,
    recovery_evidence: recoveryEvidence,
  });
  assert.equal(recovered.state, 'failed_closed');
  events = await recoveryFixture.controlPlane.listAuditEvents(recoveryFixture.principal, recoveryAdmitted.invocation.invocation_ref);
  assert.equal(events.filter((event) => event.event_type === 'recovery_absence_verified').length, 1);
});

test('failed, incomplete, stale, or unattested evidence emits no v6 verification label', async () => {
  const fixture = await createFixture();
  const { admitted, cleanup } = await settleForCleanup(fixture);
  const incomplete = createCleanupVerificationEvidence(cleanup.invocation.cleanup_requests[0], {
    status: 'verified', observed_at: '2026-09-05T12:00:00.000Z', evidence_ref: 'incomplete', observation_hash: sha256Ref('incomplete'),
  });
  await assert.rejects(fixture.controlPlane.completeCleanup(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref, lease_token: cleanup.lease_token, cleanup_evidence: [incomplete],
  }), { code: 'CLEANUP_EVIDENCE_INCOMPLETE' });
  assert.equal((await fixture.controlPlane.listAuditEvents(fixture.principal, admitted.invocation.invocation_ref))
    .some((event) => event.event_type === 'cleanup_verified'), false);

  const recoveryFixture = await createFixture();
  const recoveryAdmitted = await recoveryFixture.controlPlane.admitInvocation(recoveryFixture.principal, invocationRequest({ idempotency_key: 'stale-recovery-v6-00000001' }));
  await recoveryFixture.controlPlane.claimExecution(recoveryFixture.principal, {
    invocation_ref: recoveryAdmitted.invocation.invocation_ref, lease_token: recoveryFixture.nextLeaseToken(), worker_id: 'stale_recovery', lease_ms: 5_000,
  });
  recoveryFixture.setNow('2026-09-05T12:00:06.000Z'); await recoveryFixture.controlPlane.sweepExpiredLeases();
  const recovery = await recoveryFixture.controlPlane.claimRecovery(recoveryFixture.principal, {
    invocation_ref: recoveryAdmitted.invocation.invocation_ref, lease_token: recoveryFixture.nextLeaseToken(), worker_id: 'stale_recovery', lease_ms: 30_000,
  });
  const stale = { schema: 'agoragentic.risk-fork.recovery-absence-evidence.v1', provider_recovery_key: recoveryAdmitted.invocation.provider_recovery_key,
    observed_at: '2026-09-05T11:00:00.000Z', evidence_ref: 'stale', observation_hash: sha256Ref('stale') };
  await assert.rejects(recoveryFixture.controlPlane.completeRecoveryAbsence(recoveryFixture.principal, {
    invocation_ref: recoveryAdmitted.invocation.invocation_ref, lease_token: recovery.lease_token, recovery_evidence: stale,
  }), { code: 'RECOVERY_EVIDENCE_STALE' });
  assert.equal((await recoveryFixture.controlPlane.listAuditEvents(recoveryFixture.principal, recoveryAdmitted.invocation.invocation_ref))
    .some((event) => event.event_type === 'recovery_absence_verified'), false);
});

for (const status of ['failed', 'unknown']) test(`${status} cleanup evidence retains the obligation and emits no verification event`, async () => {
  const fixture = await createFixture();
  const { admitted, cleanup } = await settleForCleanup(fixture);
  const evidence = cleanup.invocation.cleanup_requests.map((request, index) => createCleanupVerificationEvidence(request, {
    status, observed_at: '2026-09-05T12:00:00.000Z', evidence_ref: `${status}_cleanup_${index}`,
    observation_hash: sha256Ref({ status, index }),
  }));
  await assert.rejects(fixture.controlPlane.completeCleanup(fixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref, lease_token: cleanup.lease_token, cleanup_evidence: evidence,
  }), { code: 'CLEANUP_NOT_VERIFIED' });
  const current = await fixture.controlPlane.getInvocation(fixture.principal, admitted.invocation.invocation_ref);
  assert.equal(current.state, 'cleanup_pending');
  assert.equal(current.cleanup_requests.length, cleanup.invocation.cleanup_requests.length);
  assert.equal((await fixture.controlPlane.listAuditEvents(fixture.principal, admitted.invocation.invocation_ref))
    .some((event) => event.event_type === 'cleanup_verified'), false);
});

test('provider rejection and binding mismatch emit no cleanup or recovery verification event', async () => {
  const cleanupFixture = await createFixture({ verifyCleanupEvidence: async () => false });
  const { admitted, cleanup } = await settleForCleanup(cleanupFixture);
  const evidence = cleanup.invocation.cleanup_requests.map((request, index) => createCleanupVerificationEvidence(request, {
    status: 'verified', observed_at: '2026-09-05T12:00:00.000Z', evidence_ref: `rejected_cleanup_${index}`,
    observation_hash: sha256Ref({ rejected_cleanup: index }),
  }));
  await assert.rejects(cleanupFixture.controlPlane.completeCleanup(cleanupFixture.principal, {
    invocation_ref: admitted.invocation.invocation_ref, lease_token: cleanup.lease_token, cleanup_evidence: evidence,
  }), { code: 'CLEANUP_PROVIDER_ATTESTATION_FAILED' });
  assert.equal((await cleanupFixture.controlPlane.listAuditEvents(cleanupFixture.principal, admitted.invocation.invocation_ref))
    .some((event) => event.event_type === 'cleanup_verified'), false);

  const recoveryFixture = await createFixture({ verifyRecoveryAbsence: async () => false });
  const recoveryAdmitted = await recoveryFixture.controlPlane.admitInvocation(recoveryFixture.principal, invocationRequest({ idempotency_key: 'rejected-recovery-v6-00000001' }));
  await recoveryFixture.controlPlane.claimExecution(recoveryFixture.principal, {
    invocation_ref: recoveryAdmitted.invocation.invocation_ref, lease_token: recoveryFixture.nextLeaseToken(), worker_id: 'rejected_recovery', lease_ms: 5_000,
  });
  recoveryFixture.setNow('2026-09-05T12:00:06.000Z'); await recoveryFixture.controlPlane.sweepExpiredLeases();
  const recovery = await recoveryFixture.controlPlane.claimRecovery(recoveryFixture.principal, {
    invocation_ref: recoveryAdmitted.invocation.invocation_ref, lease_token: recoveryFixture.nextLeaseToken(), worker_id: 'rejected_recovery', lease_ms: 30_000,
  });
  const mismatched = { schema: 'agoragentic.risk-fork.recovery-absence-evidence.v1',
    provider_recovery_key: sha256Ref('another-invocation'), observed_at: '2026-09-05T12:00:06.000Z',
    evidence_ref: 'mismatched-recovery', observation_hash: sha256Ref('mismatched') };
  await assert.rejects(recoveryFixture.controlPlane.completeRecoveryAbsence(recoveryFixture.principal, {
    invocation_ref: recoveryAdmitted.invocation.invocation_ref, lease_token: recovery.lease_token, recovery_evidence: mismatched,
  }), { code: 'RECOVERY_EVIDENCE_MISMATCH' });
  const valid = { ...mismatched, provider_recovery_key: recoveryAdmitted.invocation.provider_recovery_key, evidence_ref: 'rejected-recovery' };
  await assert.rejects(recoveryFixture.controlPlane.completeRecoveryAbsence(recoveryFixture.principal, {
    invocation_ref: recoveryAdmitted.invocation.invocation_ref, lease_token: recovery.lease_token, recovery_evidence: valid,
  }), { code: 'RECOVERY_ABSENCE_ATTESTATION_FAILED' });
  assert.equal((await recoveryFixture.controlPlane.listAuditEvents(recoveryFixture.principal, recoveryAdmitted.invocation.invocation_ref))
    .some((event) => event.event_type === 'recovery_absence_verified'), false);
});
