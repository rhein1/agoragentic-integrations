import assert from 'node:assert/strict';
import test from 'node:test';
import { createTrustedOAuthAuthenticator, hashManagedApiKey } from '../src/auth.mjs';
import { createManagedRiskForkControlPlane } from '../src/control-plane.mjs';
import { createManagedServiceHttpHandler } from '../src/http-handler.mjs';
import { sha256Ref } from '../../src/canonical.mjs';
import { createFixture, invocationRequest, TEST_TOKEN } from './helpers.mjs';

const NOW = '2026-09-05T12:00:00.000Z';
const denied = (error) => ['AUTHENTICATION_REQUIRED', 'AUTHENTICATION_FAILED', 'AUTHORIZATION_DENIED'].includes(error.code);

test('execution credentials cannot claim or write cleanup/recovery authority', async () => {
  const f = await createFixture({ credentialScopes: [
    'invocations:write', 'worker:execution:claim', 'worker:execution:write',
  ], verifyResourceBinding: () => true });
  const { invocation } = await f.controlPlane.admitInvocation(f.principal, invocationRequest());
  const input = { invocation_ref: invocation.invocation_ref, worker_id: 'worker:scoped',
    lease_ms: 30_000, lease_token: f.nextLeaseToken() };
  for (const method of ['claimCleanup', 'claimRecovery', 'completeCleanup', 'completeRecoveryAbsence']) {
    await assert.rejects(f.controlPlane[method](f.principal, input), denied);
  }
  await f.controlPlane.claimExecution(f.principal, input);
  const resources = { invocation_ref: input.invocation_ref, lease_token: input.lease_token,
    savepoint_ref: 'savepoint:scoped', fork_ref: 'fork:scoped', expected_lease_kind: 'execution' };
  const response = await f.controlPlane.recordResources(f.principal, resources);
  await f.controlPlane.recordExecutionOutcome(f.principal, {
    invocation_ref: input.invocation_ref, lease_token: input.lease_token, outcome: 'succeeded',
    actual_cost_micros: 0, execution_evidence_hash: sha256Ref('scoped'), result_hash: sha256Ref('result'),
  });
  await f.controlPlane.claimCleanup(f.sameTenantPrincipal, { ...input, lease_token: f.nextLeaseToken() });
  assert.deepEqual(await f.controlPlane.recordResources(f.principal, resources), response,
    'historical receipt remains bound to original execution purpose, not current cleanup lease');
  await assert.rejects(f.controlPlane.recordResources(f.principal,
    { ...resources, expected_lease_kind: 'recovery' }), { code: 'LEASE_PREFLIGHT_FAILED' });
});

test('unbranded worker callers fail authentication before invocation or receipt reads', async () => {
  const f = await createFixture();
  let reads = 0;
  f.store.getInvocation = async () => { reads++; throw new Error('must not read'); };
  f.store.findResourceJournalReceipt = async () => { reads++; throw new Error('must not read'); };
  const forged = { key_id: f.principal.key_id, tenant_id: f.principal.tenant_id, scopes: f.principal.scopes };
  for (const method of ['renewLease', 'recordResources', 'recordExecutionOutcome', 'completeCleanup', 'completeRecoveryAbsence']) {
    await assert.rejects(f.controlPlane[method](forged, {}), denied);
  }
  assert.equal(reads, 0);
});

async function oauthFixture() {
  const f = await createFixture();
  let now = NOW;
  const verified = [];
  let identity = {
    key_hash: hashManagedApiKey(TEST_TOKEN), key_id: 'key_alpha', tenant_id: 'tenant_alpha',
    issuer: 'https://fixture.invalid/issuer', audience: 'risk-fork-fixture', subject: 'key_alpha',
    scopes: ['invocations:write'], not_before: NOW, expires_at: '2026-09-05T12:05:00.000Z',
  };
  const auth = createTrustedOAuthAuthenticator({ store: f.store, issuer: identity.issuer,
    audience: identity.audience, clock: () => new Date(now),
    verify: async (request) => { verified.push(request); return identity; } });
  const control = createManagedRiskForkControlPlane({ config: f.config, store: f.store,
    providerRegistry: f.providerRegistry, requirePrincipal: auth.requirePrincipal,
    clock: () => new Date(now) });
  return { ...f, auth, control, verified, get identity() { return identity; },
    setIdentity(next) { identity = next; }, setClock(next) { now = next; } };
}

test('trusted OAuth verifies every HTTP request and binds closed issuer/audience/subject/key/time/scopes', async () => {
  const f = await oauthFixture();
  const handler = createManagedServiceHttpHandler({ controlPlane: f.control, authenticator: f.auth });
  const request = { method: 'POST', path: '/v1/invocations',
    headers: { Authorization: 'Bearer ' + 'synthetic_token_'.repeat(5), 'Content-Type': 'application/json' },
    body: JSON.stringify(invocationRequest()) };
  const first = await handler(request), second = await handler(request);
  assert.equal(first.status, 201); assert.equal(second.status, 200);
  assert.equal(f.verified.length, 2);
  assert.deepEqual(f.verified[0].request, { method: 'POST', path: '/v1/invocations' });
  assert.equal(Object.isFrozen(f.verified[0].request), true);
  const principal = await f.auth.authenticate(request.headers.Authorization, 'invocations:write');
  await assert.rejects(f.auth.requirePrincipal(principal, 'worker:execution:claim'), { code: 'AUTHORIZATION_DENIED' });
  await assert.rejects(f.auth.requirePrincipal({ ...principal }, 'invocations:write'), denied);
  f.setClock('2026-09-05T12:05:00.000Z');
  await assert.rejects(f.auth.requirePrincipal(principal, 'invocations:write'), { code: 'AUTHENTICATION_FAILED' });
});

test('OAuth rejects identity substitution, unknown fields, invalid windows and current credential drift', async () => {
  const f = await oauthFixture();
  const token = 'Bearer ' + 'synthetic_token_'.repeat(5);
  const valid = f.identity;
  for (const change of [
    { issuer: 'https://other.invalid' }, { audience: 'other' }, { subject: 'key_other' },
    { tenant_id: 'tenant_other' }, { key_hash: 'sha256:' + 'a'.repeat(64) },
    { expires_at: '2026-09-07T00:00:00.000Z' }, { not_before: '2026-09-05T13:00:00.000Z' },
    { scopes: ['worker:write'] }, { authority: true },
  ]) {
    f.setIdentity({ ...valid, ...change });
    await assert.rejects(f.auth.authenticate(token, 'invocations:write'), denied);
  }
  f.setIdentity(valid);
  const principal = await f.auth.authenticate(token, 'invocations:write');
  const resolve = f.store.resolveCredential.bind(f.store);
  f.store.resolveCredential = async (hash) => ({ ...await resolve(hash), key_hash: 'sha256:' + 'b'.repeat(64) });
  await assert.rejects(f.auth.requirePrincipal(principal, 'invocations:write'), denied);
});

test('public handler cannot be configured to expose worker routes and deadline blocks delayed auth', async () => {
  const f = await createFixture();
  assert.throws(() => createManagedServiceHttpHandler({ controlPlane: f.controlPlane,
    authenticator: f.authenticator, allowWorkerRoutes: true }), /unsupported field/);
  const abort = new AbortController();
  let admissions = 0;
  const handler = createManagedServiceHttpHandler({ controlPlane: { ...f.controlPlane,
    admitInvocation(...args) { admissions++; return f.controlPlane.admitInvocation(...args); } },
    authenticator: { async authenticate(...args) {
      const principal = await f.authenticator.authenticate(...args); abort.abort(); return principal;
    } } });
  const response = await handler({ method: 'POST', path: '/v1/invocations', signal: abort.signal,
    headers: { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(invocationRequest()) });
  assert.equal(response.status, 408);
  assert.equal(admissions, 0);
});
