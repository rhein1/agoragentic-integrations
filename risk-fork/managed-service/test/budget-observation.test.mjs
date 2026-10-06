import test from 'node:test';
import assert from 'node:assert/strict';
import { createManagedRequestPolicy } from '../src/request-policy.mjs';
import { createManagedServiceHttpHandler } from '../src/http-handler.mjs';
import { createManagedServiceConfig } from '../src/config.mjs';
import { createManagedRiskForkControlPlane } from '../src/control-plane.mjs';
import { createManagedTelemetryEvent, normalizeManagedTelemetryEvent } from '../src/telemetry-event.mjs';
import { matchingMetricRules } from '../src/metric-event.mjs';
import { normalizeTelemetryOptions } from '../src/postgres-telemetry-config.mjs';
import { managedError } from '../src/validation.mjs';
import { createFixture, invocationRequest, TEST_TOKEN } from './helpers.mjs';

const metricSettings = { maxSources: 100, maxSourcesPerTenant: 100, maxWindows: 100, maxWindowsPerTenant: 100,
  maxAlerts: 100, maxAlertsPerTenant: 100, rules: [{ rule_id: 'budget_denied', threshold: 1, window_ms: 60000 }] };
const limits = { maxEvents: 100, maxEventsPerTenant: 100, leaseMs: 1000, retryMs: 200, retentionMs: 1000 };
const request = (body = invocationRequest()) => ({ method: 'POST', path: '/v1/invocations',
  headers: { authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
function policy(events, extra = {}) {
  return createManagedRequestPolicy({ readControl: async () => ({ enabled: true, epoch: 0 }),
    consumeRateLimit: async () => ({ allowed: true, retry_after_seconds: 0 }),
    emitTelemetry: (event) => events.push(event), observeBudgetDenials: true, ...extra });
}
const denied = (events) => events.filter((event) => event.outcome === 'budget_limited');

for (const [kind, code] of [['invocation', 'INVOCATION_BUDGET_EXCEEDED'], ['daily', 'DAILY_BUDGET_EXCEEDED']]) {
  test(`authenticated HTTP ${kind} budget denial preserves response and does not reserve work`, async () => {
    const f = await createFixture({ invocationBudget: 50000, dailyBudget: 75000 });
    const controlPlane = createManagedRiskForkControlPlane({ store: f.store, providerRegistry: f.providerRegistry,
      requirePrincipal: f.authenticator.requirePrincipal, clock: () => new Date('2026-09-05T12:00:00Z'),
      config: createManagedServiceConfig({ enabled: true, environment: 'local_test',
        limits: { max_invocation_cost_micros: 500000, daily_budget_micros: 1000000 } }) });
    if (kind === 'daily') await controlPlane.admitInvocation(f.principal, invocationRequest({ estimated_cost_micros: 50000 }));
    const before = await controlPlane.listAuditInvocations(f.principal, { limit: 1 });
    const events = [], p = policy(events);
    const handler = createManagedServiceHttpHandler({ controlPlane, authenticator: f.authenticator, requestPolicy: p });
    const result = await handler(request(invocationRequest({ idempotency_key: 'budget-denial-request-00002',
      estimated_cost_micros: kind === 'invocation' ? 100000 : 50000 })));
    // The daily case must pass the invocation cap and fail only the daily cap.
    assert.equal(result.status, 429); assert.equal(result.body.error.code, code);
    await p.flushTelemetry();
    assert.equal(denied(events).length, 1);
    assert.equal(denied(events)[0].event, `${kind}_budget_denied`);
    assert.equal(denied(events)[0].route_class, 'admission');
    assert.deepEqual(await controlPlane.listAuditInvocations(f.principal, { limit: 1 }), before);
    const serialized = JSON.stringify(denied(events));
    for (const secret of [TEST_TOKEN, 'tenant_alpha', 'key_alpha', 'estimated_cost_micros', 'provider_id', 'idempotency']) {
      assert.equal(serialized.includes(secret), false);
    }
  });
}

test('budget observation requires an original single-use admission decision and exact typed 429', async () => {
  const events = [], p = policy(events), f = await createFixture();
  const decision = await p.beforeMutation({ principal: f.principal, routeClass: 'admission' });
  const error = managedError('not retained', 'DAILY_BUDGET_EXCEEDED', 429);
  assert.equal(p.observeAdmissionDenial({ ...decision }, error), false);
  assert.equal(p.observeAdmissionDenial(decision, error), true);
  assert.equal(p.observeAdmissionDenial(decision, error), false);
  for (const [code, status] of [['RATE_LIMITED', 429], ['CONCURRENCY_QUOTA_EXCEEDED', 429],
    ['DAILY_BUDGET_EXCEEDED', 503], ['TENANT_RECOVERY_REQUIRED', 503]]) {
    const ticket = await p.beforeMutation({ principal: f.principal, routeClass: 'admission' });
    assert.equal(p.observeAdmissionDenial(ticket, managedError('not retained', code, status)), false);
  }
  const execution = await p.beforeMutation({ principal: f.principal, routeClass: 'execution' });
  assert.equal(p.observeAdmissionDenial(execution, error), false);
  await p.flushTelemetry(); assert.equal(denied(events).length, 1);
});

test('budget observations are default-off and direct programmatic admissions remain unobserved', async () => {
  const events = [], p = policy(events, { observeBudgetDenials: false }), f = await createFixture({ invocationBudget: 50000, dailyBudget: 75000 });
  const decision = await p.beforeMutation({ principal: f.principal, routeClass: 'admission' });
  assert.equal(p.observeAdmissionDenial(decision, managedError('x', 'DAILY_BUDGET_EXCEEDED', 429)), false);
  await f.controlPlane.admitInvocation(f.principal, invocationRequest({ estimated_cost_micros: 50000 }));
  await assert.rejects(f.controlPlane.admitInvocation(f.principal, invocationRequest({ idempotency_key: 'direct-budget-denial-00002',
    estimated_cost_micros: 50000 })), { code: 'DAILY_BUDGET_EXCEEDED' });
  await p.flushTelemetry(); assert.equal(denied(events).length, 0);
});

test('budget vocabulary has closed route/status/outcome and explicit v5 rule selection', () => {
  const event = createManagedTelemetryEvent({ event: 'daily_budget_denied', route_class: 'admission', status: 429,
    outcome: 'budget_limited', duration_ms: 0, tenant_hash: `sha256:${'a'.repeat(64)}`, key_hash: `sha256:${'b'.repeat(64)}` });
  assert.equal(matchingMetricRules(event, 'policy', metricSettings)[0].rule_id, 'budget_denied');
  for (const change of [{ route_class: 'execution' }, { status: 503 }, { outcome: 'rate_limited' }, { amount: 1 }]) {
    assert.throws(() => normalizeManagedTelemetryEvent({ ...event, ...change }));
  }
  for (const metricVersion of [undefined, 3, 4]) assert.throws(() => normalizeTelemetryOptions({ limits,
    lifecycle: true, metrics: true, metricSettings, metricVersion }));
  assert.equal(normalizeTelemetryOptions({ limits, lifecycle: true, metrics: true, metricSettings, metricVersion: 5 }).metricVersion, 5);
});

test('successful/replayed, concurrency, auth, malformed and policy-denied HTTP requests are not budget observations', async () => {
  const f = await createFixture({ concurrency: 1 }), events = [], p = policy(events);
  const handler = createManagedServiceHttpHandler({ controlPlane: f.controlPlane, authenticator: f.authenticator, requestPolicy: p });
  assert.equal((await handler(request())).status, 201);
  assert.equal((await handler(request())).status, 200);
  const concurrency = await handler(request(invocationRequest({ idempotency_key: 'another-request-000002' })));
  assert.equal(concurrency.body.error.code, 'CONCURRENCY_QUOTA_EXCEEDED');
  const conflict = await handler(request(invocationRequest({ estimated_cost_micros: 1 })));
  assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal((await handler({ ...request(), body: '{' })).status, 400);
  assert.equal((await handler({ ...request(), headers: { 'content-type': 'application/json' } })).status, 401);
  assert.equal((await handler({ ...request(), body: JSON.stringify({ ...invocationRequest(), error: { code: 'DAILY_BUDGET_EXCEEDED' } }) })).status, 400);
  const rate = policy(events, { consumeRateLimit: async () => ({ allowed: false, retry_after_seconds: 2 }) });
  const limited = await createManagedServiceHttpHandler({ controlPlane: f.controlPlane, authenticator: f.authenticator, requestPolicy: rate })(request());
  assert.equal(limited.body.error.code, 'RATE_LIMITED'); assert.equal(limited.headers['retry-after'], '2');
  const disabled = policy(events, { readControl: async () => ({ enabled: false, epoch: 1 }) });
  assert.equal((await createManagedServiceHttpHandler({ controlPlane: f.controlPlane, authenticator: f.authenticator, requestPolicy: disabled })(request())).status, 503);
  await Promise.all([p.flushTelemetry(), rate.flushTelemetry(), disabled.flushTelemetry()]);
  assert.equal(denied(events).length, 0); assert.equal(events.filter((event) => event.event === 'rate_denied').length, 1);
});

for (const failure of ['throw','unknown','hang']) test(`budget telemetry ${failure} cannot replace or delay the denial response`, async () => {
  const f = await createFixture({ invocationBudget: 50000, dailyBudget: 75000 });
  const controlPlane = createManagedRiskForkControlPlane({ store: f.store, providerRegistry: f.providerRegistry,
    requirePrincipal: f.authenticator.requirePrincipal, clock: () => new Date('2026-09-05T12:00:00Z'),
    config: createManagedServiceConfig({ enabled: true, environment: 'local_test' }) });
  let resolveHung;
  const p = createManagedRequestPolicy({ readControl: async () => ({ enabled: true, epoch: 0 }),
    consumeRateLimit: async () => ({ allowed: true, retry_after_seconds: 0 }), observeBudgetDenials: true, telemetryTimeoutMs: 100,
    recordTelemetry: (event) => {
      if (event.outcome !== 'budget_limited') return { event_ref: event.event_ref, persisted: true };
      if (failure === 'throw') throw new Error('PRIVATE provider message');
      if (failure === 'unknown') return { event_ref: event.event_ref, persisted: false };
      return new Promise((resolve) => { resolveHung = () => resolve({ event_ref: event.event_ref, persisted: true }); });
    } });
  const response = await createManagedServiceHttpHandler({ controlPlane, authenticator: f.authenticator, requestPolicy: p })(request());
  assert.equal(response.status, 429); assert.equal(response.body.error.code, 'INVOCATION_BUDGET_EXCEEDED');
  assert.equal(JSON.stringify(response).includes('PRIVATE'), false);
  if (failure === 'hang') {
    assert.equal((await p.flushTelemetry({ timeoutMs: 100 })).settled, false);
    assert.equal(p.telemetryHealth().in_flight, 1);
    resolveHung();
  }
  assert.equal((await p.flushTelemetry()).settled, true);
  assert.equal(p.telemetryHealth().failed, failure === 'hang' ? 0 : 1);
});

test('unbranded admission observer and invalid opt-in cannot be installed as a host capability', () => {
  assert.throws(() => policy([], { observeBudgetDenials: 'true' }));
  assert.throws(() => createManagedServiceHttpHandler({ controlPlane: { health() {} }, authenticator: { authenticate() {} },
    requestPolicy: { beforeMutation() {}, observeAdmissionDenial() {} } }));
});
