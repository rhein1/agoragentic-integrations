import assert from 'node:assert/strict';
import test from 'node:test';
import { createManagedServiceHttpHandler, createManagedWorkerHttpHandler } from '../src/http-handler.mjs';
import { createManagedRequestPolicy } from '../src/request-policy.mjs';

function fixture({ enabled = true, allowed = true } = {}) {
  const calls = [];
  const principal = Object.freeze({ key_id: 'key_1', tenant_id: 'tenant_1', scopes: [
    'invocations:write', 'invocations:read', 'audit:read', 'worker:execution:claim',
    'worker:execution:write', 'worker:cleanup:claim', 'worker:cleanup:write',
    'worker:recovery:claim', 'worker:recovery:write',
  ] });
  const authenticator = { async authenticate(_authorization, scope) { calls.push(['auth', scope]); return principal; } };
  const controlPlane = { async health() { return { ready: true, readiness_scope: 'local_test' }; } };
  for (const name of ['admitInvocation', 'getInvocation', 'listAuditEvents', 'claimExecution',
    'claimCleanup', 'claimRecovery', 'renewLease', 'recordResources', 'recordExecutionOutcome',
    'completeCleanup', 'completeRecoveryAbsence']) {
    controlPlane[name] = async () => { calls.push(['effect', name]); return name === 'admitInvocation' ? { created: true } : {}; };
  }
  const requestPolicy = createManagedRequestPolicy({
    readControl: async () => ({ enabled, epoch: 1 }),
    consumeRateLimit: async ({ route_class }) => {
      calls.push(['rate', route_class]); return { allowed, retry_after_seconds: 9 };
    },
    emitTelemetry: async () => {},
  });
  return { calls, controlPlane, authenticator, requestPolicy,
    publicHandler: createManagedServiceHttpHandler({ controlPlane, authenticator, requestPolicy }),
    workerHandler: createManagedWorkerHttpHandler({ controlPlane, workerAuthenticator: authenticator, requestPolicy }),
  };
}
function request(path, method = 'POST', signal) {
  return { method, path, headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' }, body: '{}', signal };
}

test('disabled policy denies admission and execution without control-plane effects', async () => {
  const f = fixture({ enabled: false });
  assert.equal((await f.publicHandler(request('/v1/invocations'))).body.error.code, 'MANAGED_SERVICE_DISABLED');
  assert.equal((await f.workerHandler(request('/internal/v1/invocations/item_1/claim-execution'))).body.error.code, 'MANAGED_SERVICE_DISABLED');
  assert.equal(f.calls.some(([kind]) => kind === 'effect'), false);
});

test('rate denial returns bounded Retry-After and never performs admission', async () => {
  const f = fixture({ allowed: false });
  const result = await f.publicHandler(request('/v1/invocations'));
  assert.equal(result.status, 429); assert.equal(result.headers['retry-after'], '9');
  assert.equal(result.body.error.code, 'RATE_LIMITED');
  assert.equal(f.calls.some(([kind]) => kind === 'effect'), false);
});

test('disabled policy still permits cleanup/recovery and same-tenant reads', async () => {
  const f = fixture({ enabled: false });
  for (const action of ['claim-cleanup', 'renew-cleanup', 'cleanup', 'claim-recovery', 'resources-recovery', 'recovery-absent']) {
    assert.equal((await f.workerHandler(request(`/internal/v1/invocations/item_1/${action}`))).status, 200);
  }
  assert.equal((await f.publicHandler(request('/v1/invocations/item_1', 'GET'))).status, 200);
  assert.deepEqual(f.calls.filter(([kind]) => kind === 'rate').map(([, kind]) => kind),
    ['cleanup', 'cleanup', 'cleanup', 'recovery', 'recovery', 'recovery', 'read']);
});

test('public worker-route exclusion cannot invoke policy or worker effects', async () => {
  const f = fixture();
  assert.equal((await f.publicHandler(request('/internal/v1/invocations/item_1/claim-execution'))).status, 404);
  assert.deepEqual(f.calls, []);
});

test('authentication failure and aborted authentication never reach policy or effects', async () => {
  const f = fixture();
  const abort = new AbortController();
  const handler = createManagedServiceHttpHandler({ controlPlane: f.controlPlane, requestPolicy: f.requestPolicy,
    authenticator: { async authenticate() { abort.abort(); return { key_id: 'key_1', tenant_id: 'tenant_1', scopes: ['invocations:write'] }; } },
  });
  assert.equal((await handler(request('/v1/invocations', 'POST', abort.signal))).status, 408);
  const rejected = createManagedServiceHttpHandler({ controlPlane: f.controlPlane, requestPolicy: f.requestPolicy,
    authenticator: { async authenticate() { throw new Error('private credential detail'); } },
  });
  const result = await rejected(request('/v1/invocations'));
  assert.equal(result.status, 500); assert.equal(JSON.stringify(result).includes('private credential detail'), false);
  assert.deepEqual(f.calls, []);
});

test('policy callback failures redact private details and health routes bypass identity policy', async () => {
  const f = fixture();
  const requestPolicy = createManagedRequestPolicy({
    readControl: async () => { throw new Error('private policy detail'); },
    consumeRateLimit: async () => { throw new Error('private rate detail'); }, emitTelemetry: async () => {},
  });
  const handler = createManagedServiceHttpHandler({ controlPlane: f.controlPlane, authenticator: f.authenticator, requestPolicy });
  const result = await handler(request('/v1/invocations'));
  assert.equal(result.status, 503); assert.equal(JSON.stringify(result).includes('private policy detail'), false);
  for (const path of ['/healthz', '/readyz']) assert.equal((await handler(request(path, 'GET'))).status, 200);
});

test('policy option is explicit and rejects malformed adapters', () => {
  const f = fixture();
  for (const requestPolicy of [null, {}, { beforeMutation: true }]) {
    assert.throws(() => createManagedServiceHttpHandler({ controlPlane: f.controlPlane, authenticator: f.authenticator, requestPolicy }));
  }
});
