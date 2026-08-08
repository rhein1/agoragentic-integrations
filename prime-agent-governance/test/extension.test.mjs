import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_POLICY,
  buildAuthorityBinding,
  buildAuthorityRequest,
  classifyPrimeToolCall,
  createAgoragenticPrimeExtension,
  evaluatePrimeToolCall,
  sanitizeEvidence,
  validatePrincipalAuthority,
} from '../index.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(TEST_DIR, '..');
const UPSTREAM = JSON.parse(readFileSync(resolve(TEST_DIR, 'fixtures', 'prime-agent-v0.7.1.json'), 'utf8'));
const FIXED_NOW = '2026-08-08T12:00:00.000Z';

function fakePi() {
  const handlers = new Map();
  const commands = new Map();
  const tools = new Map();
  const entries = [];
  return {
    handlers,
    commands,
    tools,
    entries,
    on(name, handler) {
      handlers.set(name, handler);
    },
    registerCommand(name, value) {
      commands.set(name, value);
    },
    registerTool(value) {
      tools.set(value.name, value);
    },
    appendEntry(type, data) {
      entries.push({ type, data });
    },
  };
}

function authorizedCall(event, options = {}) {
  const principalRef = options.principalRef || 'owner:1';
  const agentRef = options.agentRef || 'agent:1';
  const sessionRef = options.sessionRef || 'session:1';
  const binding = buildAuthorityBinding(event, {
    principal_ref: principalRef,
    agent_ref: agentRef,
    session_ref: sessionRef,
  });
  const authority = {
    schema: 'agoragentic.prime-agent.authority-grant.v1',
    authority_id: 'pauth_test_1',
    status: 'active',
    issued_at: '2026-08-08T11:55:00.000Z',
    expires_at: '2026-08-08T12:10:00.000Z',
    principal_ref: principalRef,
    agent_ref: agentRef,
    session_ref: sessionRef,
    action_hash: binding.action_hash,
    allowed_capabilities: [binding.capability],
    proof: 'test-principal-signature',
    ...(options.authority || {}),
  };
  return {
    binding,
    authority,
    context: {
      authority,
      principal_ref: principalRef,
      agent_ref: agentRef,
      session_ref: sessionRef,
      now: FIXED_NOW,
      verifyAuthority: options.verifyAuthority || ((grant, candidate) => (
        grant.proof === 'test-principal-signature'
        && grant.action_hash === candidate.action_hash
      )),
      isAuthorityConsumed: options.isAuthorityConsumed || (() => false),
    },
  };
}

test('package follows the exact Prime Agent v0.7.1 discovery contract', () => {
  const packageJson = JSON.parse(readFileSync(resolve(PACKAGE_ROOT, 'package.json'), 'utf8'));
  assert.equal(UPSTREAM.tag, 'v0.7.1');
  assert.equal(UPSTREAM.commit, '95afd319a78ae017a41241d50b013d656a0685ce');
  assert.equal(packageJson.engines.node, UPSTREAM.node_engine);
  assert.ok(packageJson.keywords.includes(UPSTREAM.package_contract.discovery_keyword));
  assert.deepEqual(packageJson.pi.extensions, ['./index.mjs']);
  assert.ok(existsSync(resolve(PACKAGE_ROOT, packageJson.pi.extensions[0])));
});

test('classifies exact v0.7.1 IPython event shapes conservatively', () => {
  const events = UPSTREAM.events;
  assert.equal(classifyPrimeToolCall(events.ipython_read).side_effect_class, 'read');
  assert.equal(classifyPrimeToolCall(events.ipython_network).side_effect_class, 'network');
  assert.equal(classifyPrimeToolCall(events.ipython_write).side_effect_class, 'write');
  assert.equal(classifyPrimeToolCall(events.ipython_payment).side_effect_class, 'spend');
  assert.equal(classifyPrimeToolCall(events.ipython_unknown).side_effect_class, 'unknown');
  assert.equal(evaluatePrimeToolCall(events.ipython_unknown).decision, 'deny');
  assert.equal(classifyPrimeToolCall({
    ...events.ipython_read,
    input: { code: `${'1'.repeat(100_001)}\nwallet.transfer('merchant', 1)` },
  }).side_effect_class, 'unknown');
});

test('shell orchestration cannot downgrade deploy, publish, trust, or unknown effects to ordinary writes', () => {
  const shellEvent = (toolCallId, command) => ({
    type: 'tool_call',
    toolCallId,
    toolName: 'bash',
    input: { command },
  });
  assert.equal(classifyPrimeToolCall(shellEvent('call-deploy', 'kubectl apply -f service.yml')).side_effect_class, 'deploy');
  assert.equal(classifyPrimeToolCall(shellEvent('call-publish', 'git push origin main')).side_effect_class, 'publish');
  assert.equal(classifyPrimeToolCall(shellEvent('call-trust', 'gh pr merge 258')).side_effect_class, 'trust');
  const unknown = shellEvent('call-unknown', 'echo hello');
  assert.equal(classifyPrimeToolCall(unknown).side_effect_class, 'unknown');
  assert.equal(evaluatePrimeToolCall(unknown).decision, 'deny');
});

test('unverified custom tools cannot gain read-only authority from their names', () => {
  const customRead = {
    type: 'tool_call',
    toolCallId: 'call-custom-read',
    toolName: 'read',
    input: { resource: 'arbitrary-provider' },
  };
  assert.equal(classifyPrimeToolCall(customRead).side_effect_class, 'unknown');
  assert.equal(evaluatePrimeToolCall(customRead).decision, 'deny');
  assert.equal(classifyPrimeToolCall({
    type: 'tool_call',
    toolCallId: 'call-status',
    toolName: 'agoragentic_status',
    input: {},
  }).side_effect_class, 'read');
});

test('action bindings cover principal, agent, session, tool call, and complete input', () => {
  const event = UPSTREAM.events.ipython_payment;
  const first = buildAuthorityBinding(event, {
    principal_ref: 'owner:1',
    agent_ref: 'agent:1',
    session_ref: 'session:1',
  });
  const changedSession = buildAuthorityBinding(event, {
    principal_ref: 'owner:1',
    agent_ref: 'agent:1',
    session_ref: 'session:2',
  });
  const changedPrincipal = buildAuthorityBinding(event, {
    principal_ref: 'owner:2',
    agent_ref: 'agent:1',
    session_ref: 'session:1',
  });
  const changedAgent = buildAuthorityBinding(event, {
    principal_ref: 'owner:1',
    agent_ref: 'agent:2',
    session_ref: 'session:1',
  });
  const changedToolCall = buildAuthorityBinding({ ...event, toolCallId: 'call-ipython-payment-2' }, {
    principal_ref: 'owner:1',
    agent_ref: 'agent:1',
    session_ref: 'session:1',
  });
  const changedInput = buildAuthorityBinding({
    ...event,
    input: { code: `${'1'.repeat(2500)} + 2` },
  }, {
    principal_ref: 'owner:1',
    agent_ref: 'agent:1',
    session_ref: 'session:1',
  });
  const otherChangedInput = buildAuthorityBinding({
    ...event,
    input: { code: `${'1'.repeat(2500)} + 3` },
  }, {
    principal_ref: 'owner:1',
    agent_ref: 'agent:1',
    session_ref: 'session:1',
  });
  assert.notEqual(first.action_hash, changedPrincipal.action_hash);
  assert.notEqual(first.action_hash, changedAgent.action_hash);
  assert.notEqual(first.action_hash, changedSession.action_hash);
  assert.notEqual(first.action_hash, changedToolCall.action_hash);
  assert.notEqual(changedInput.action_hash, otherChangedInput.action_hash);
});

test('local policy cannot bypass principal authority for high-impact actions', () => {
  const policy = {
    ...DEFAULT_POLICY,
    require_principal_authority_for: [],
    denied_capabilities: [],
    allowed_capabilities: ['payment.execute'],
  };
  const decision = evaluatePrimeToolCall(UPSTREAM.events.ipython_payment, {}, policy);
  assert.equal(decision.decision, 'deny');
  assert.match(decision.reason, /principal authority is missing/i);
});

test('local policy cannot remove absolute authority boundaries or extend authority lifetime', () => {
  const fundEvent = {
    ...UPSTREAM.events.ipython_payment,
    toolCallId: 'call-wallet-fund',
    input: { code: "wallet.fund('agent', 1)" },
  };
  const fundCall = authorizedCall(fundEvent);
  const fundDecision = evaluatePrimeToolCall(fundEvent, fundCall.context, {
    ...DEFAULT_POLICY,
    denied_capabilities: [],
  });
  assert.equal(fundDecision.decision, 'deny');
  assert.match(fundDecision.reason, /denied by policy/);

  const paymentCall = authorizedCall(UPSTREAM.events.ipython_payment, {
    authority: {
      issued_at: '2026-08-08T11:50:00.000Z',
      expires_at: '2026-08-08T12:10:00.000Z',
    },
  });
  const paymentDecision = evaluatePrimeToolCall(UPSTREAM.events.ipython_payment, paymentCall.context, {
    ...DEFAULT_POLICY,
    max_authority_ttl_ms: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(paymentDecision.decision, 'deny');
  assert.match(paymentDecision.reason, /lifetime limit/);
});

test('valid exact principal authority permits only its bound payment action', () => {
  const event = UPSTREAM.events.ipython_payment;
  const { context, binding } = authorizedCall(event);
  const decision = evaluatePrimeToolCall(event, context);
  assert.equal(decision.decision, 'allow');
  assert.equal(decision.authority_binding.action_hash, binding.action_hash);
  assert.equal(decision.authority_validation.authority_id, 'pauth_test_1');
  assert.equal(decision.authority_granted_by_decision, false);
});

test('principal authority fails closed for malformed, stale, or mismatched grants', async (t) => {
  const event = UPSTREAM.events.ipython_payment;
  const cases = [
    ['missing expiry', { expires_at: undefined }, /expires_at is invalid/],
    ['invalid expiry', { expires_at: 'not-a-date' }, /expires_at is invalid/],
    ['expired', { expires_at: '2026-08-08T11:59:59.000Z' }, /expired/],
    ['future issuance', { issued_at: '2026-08-08T12:01:00.000Z' }, /not active yet/],
    ['overlong lifetime', { issued_at: '2026-08-08T11:50:00.000Z', expires_at: '2026-08-08T12:10:00.000Z' }, /lifetime limit/],
    ['wrong principal', { principal_ref: 'owner:other' }, /principal_ref does not match/],
    ['wrong agent', { agent_ref: 'agent:other' }, /agent_ref does not match/],
    ['wrong session', { session_ref: 'session:other' }, /session_ref does not match/],
    ['wrong action', { action_hash: `sha256:${'0'.repeat(64)}` }, /action_hash does not match/],
    ['wrong capability', { allowed_capabilities: ['deployment.execute'] }, /exact capability/],
  ];

  for (const [name, authority, reason] of cases) {
    await t.test(name, () => {
      const call = authorizedCall(event, { authority });
      const decision = evaluatePrimeToolCall(event, call.context);
      assert.equal(decision.decision, 'deny');
      assert.match(decision.reason, reason);
    });
  }
});

test('authority data cannot authorize without trusted integrity and replay guards', () => {
  const event = UPSTREAM.events.ipython_payment;
  const call = authorizedCall(event);
  delete call.context.verifyAuthority;
  assert.match(evaluatePrimeToolCall(event, call.context).reason, /verifier is required/);

  const rejected = authorizedCall(event, { verifyAuthority: () => false });
  assert.match(evaluatePrimeToolCall(event, rejected.context).reason, /integrity verification failed/);

  const noReplayGuard = authorizedCall(event);
  delete noReplayGuard.context.isAuthorityConsumed;
  assert.match(evaluatePrimeToolCall(event, noReplayGuard.context).reason, /replay guard is required/);

  const consumed = authorizedCall(event, { isAuthorityConsumed: () => true });
  assert.match(evaluatePrimeToolCall(event, consumed.context).reason, /already consumed/);
});

test('authority request is exact, bounded, proposal-only, and cannot self-approve', () => {
  const event = UPSTREAM.events.ipython_payment;
  const binding = buildAuthorityBinding(event, {
    principal_ref: 'owner:1',
    agent_ref: 'agent:1',
    session_ref: 'session:1',
  });
  const request = buildAuthorityRequest({
    principal_ref: 'owner:1',
    agent_ref: 'agent:1',
    session_ref: 'session:1',
    action_hash: binding.action_hash,
    purpose: 'Buy bounded research',
    allowed_capabilities: ['payment.execute'],
    created_at: '2026-08-08T12:00:00.000Z',
    expires_at: '2026-08-08T12:10:00.000Z',
  });
  assert.equal(request.status, 'pending_principal_approval');
  assert.equal(request.session_ref, 'session:1');
  assert.equal(request.action_hash, binding.action_hash);
  assert.equal(request.request_grants_authority, false);
  assert.equal(request.can_self_approve, false);
});

test('authority validator rejects a binding without upstream toolCallId', () => {
  const event = { toolName: 'payment_execute', input: { amount: '1' } };
  const call = authorizedCall(event);
  const validation = validatePrincipalAuthority(call.authority, call.binding, {
    now: FIXED_NOW,
    verifyAuthority: call.context.verifyAuthority,
    isAuthorityConsumed: call.context.isAuthorityConsumed,
  });
  assert.equal(validation.valid, false);
  assert.match(validation.reason, /tool_call_id is required/);
});

test('redacts common credential fields', () => {
  const safe = sanitizeEvidence({ apiKey: 'secret', nested: { Authorization: 'Bearer x' }, value: 'ok' });
  assert.equal(safe.apiKey, '[REDACTED]');
  assert.equal(safe.nested.Authorization, '[REDACTED]');
  assert.equal(safe.value, 'ok');
});

test('extension resolves and verifies exact per-action authority through the v0.7.1 host shape', async () => {
  const pi = fakePi();
  const installed = createAgoragenticPrimeExtension({
    principalRef: 'owner:1',
    agentRef: 'agent:1',
    sessionRef: 'session:1',
    resolveAuthority: async ({ binding }) => {
      const issuedAt = new Date(Date.now() - 1000);
      const expiresAt = new Date(issuedAt.getTime() + 5 * 60 * 1000);
      return {
        schema: 'agoragentic.prime-agent.authority-grant.v1',
        authority_id: 'pauth_runtime_1',
        status: 'active',
        issued_at: issuedAt.toISOString(),
        expires_at: expiresAt.toISOString(),
        principal_ref: binding.principal_ref,
        agent_ref: binding.agent_ref,
        session_ref: binding.session_ref,
        action_hash: binding.action_hash,
        allowed_capabilities: [binding.capability],
        proof: 'runtime-principal-signature',
      };
    },
    verifyAuthority: (grant, binding) => (
      grant.proof === 'runtime-principal-signature'
      && grant.action_hash === binding.action_hash
    ),
  })(pi);

  await pi.handlers.get('session_start')(UPSTREAM.events.session_start);
  const result = await pi.handlers.get('tool_call')(UPSTREAM.events.ipython_payment, { hasUI: false });
  assert.equal(result, undefined);
  assert.equal(installed.state.session_id, 'session:1');
  assert.equal(installed.state.latest_authority_status, 'verified');
  assert.equal(installed.state.latest_authority_id, 'pauth_runtime_1');

  const replayed = await pi.handlers.get('tool_call')(UPSTREAM.events.ipython_payment, { hasUI: false });
  assert.equal(replayed.block, true);
  assert.match(replayed.reason, /already consumed/);
});

test('extension fails closed for headless writes and records a local receipt', async () => {
  const pi = fakePi();
  const installed = createAgoragenticPrimeExtension()(pi);
  assert.ok(pi.handlers.has('tool_call'));
  assert.ok(pi.commands.has('agora-status'));
  assert.ok(pi.tools.has('agoragentic_status'));

  await pi.handlers.get('session_start')(UPSTREAM.events.session_start);
  const blocked = await pi.handlers.get('tool_call')(UPSTREAM.events.ipython_write, { hasUI: false });
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /no interactive principal review/i);

  await pi.handlers.get('agent_end')({ type: 'agent_end', messages: [] });
  assert.equal(installed.state.latest_receipt.local_receipt_only, true);
  assert.equal(installed.state.latest_receipt.settlement_receipt, false);
  assert.ok(pi.entries.some((entry) => entry.type === 'agoragentic.receipt'));
});

test('interactive review can allow an ordinary write without granting durable authority', async () => {
  const pi = fakePi();
  const installed = createAgoragenticPrimeExtension()(pi);
  await pi.handlers.get('session_start')(UPSTREAM.events.session_start);
  const result = await pi.handlers.get('tool_call')(
    UPSTREAM.events.ipython_write,
    { hasUI: true, ui: { confirm: async () => true } },
  );
  assert.equal(result, undefined);
  assert.equal(installed.state.authority, null);
  assert.equal(installed.state.latest_policy_decision.authority_granted_by_decision, false);
});
