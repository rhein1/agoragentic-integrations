import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAuthorityRequest,
  classifyPrimeToolCall,
  createAgoragenticPrimeExtension,
  evaluatePrimeToolCall,
  sanitizeEvidence,
} from '../index.mjs';

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

test('classifies read-only work separately from spend', () => {
  assert.equal(classifyPrimeToolCall({ toolName: 'read', input: { path: 'README.md' } }).side_effect_class, 'read');
  assert.equal(classifyPrimeToolCall({ toolName: 'wallet_transfer', input: { amount: '1' } }).side_effect_class, 'spend');
});

test('allows read-only tools and denies spend without principal authority', () => {
  assert.equal(evaluatePrimeToolCall({ toolName: 'read', input: {} }).decision, 'allow');
  const payment = evaluatePrimeToolCall({ toolName: 'payment_execute', input: { amount: '1' } });
  assert.equal(payment.decision, 'deny');
  assert.match(payment.reason, /principal authority/i);
});

test('active exact authority can cover a declared payment capability', () => {
  const decision = evaluatePrimeToolCall(
    { toolName: 'payment_execute', input: { amount: '1' } },
    {
      authority: {
        status: 'active',
        expires_at: '2099-01-01T00:00:00.000Z',
        allowed_capabilities: ['payment.execute'],
      },
    },
  );
  assert.equal(decision.decision, 'allow');
  assert.equal(decision.authority_granted_by_decision, false);
});

test('authority request is proposal-only and cannot self-approve', () => {
  const request = buildAuthorityRequest({
    principal_ref: 'owner:1',
    agent_ref: 'agent:1',
    purpose: 'Buy bounded research',
    allowed_capabilities: ['payment.execute'],
  });
  assert.equal(request.status, 'pending_principal_approval');
  assert.equal(request.request_grants_authority, false);
  assert.equal(request.can_self_approve, false);
});

test('redacts common credential fields', () => {
  const safe = sanitizeEvidence({ apiKey: 'secret', nested: { Authorization: 'Bearer x' }, value: 'ok' });
  assert.equal(safe.apiKey, '[REDACTED]');
  assert.equal(safe.nested.Authorization, '[REDACTED]');
  assert.equal(safe.value, 'ok');
});

test('extension fails closed for headless writes and records a local receipt', async () => {
  const pi = fakePi();
  const installed = createAgoragenticPrimeExtension()(pi);
  assert.ok(pi.handlers.has('tool_call'));
  assert.ok(pi.commands.has('agora-status'));
  assert.ok(pi.tools.has('agoragentic_status'));

  await pi.handlers.get('session_start')({ sessionId: 'session-1', reason: 'startup' });
  const blocked = await pi.handlers.get('tool_call')(
    { toolName: 'write', input: { path: 'file.txt', content: 'hello' } },
    { hasUI: false },
  );
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /no interactive principal review/i);

  await pi.handlers.get('agent_end')({ reason: 'end_turn' });
  assert.equal(installed.state.latest_receipt.local_receipt_only, true);
  assert.equal(installed.state.latest_receipt.settlement_receipt, false);
  assert.ok(pi.entries.some((entry) => entry.type === 'agoragentic.receipt'));
});

test('interactive review can allow an ordinary write without granting durable authority', async () => {
  const pi = fakePi();
  const installed = createAgoragenticPrimeExtension()(pi);
  await pi.handlers.get('session_start')({ sessionId: 'session-2' });
  const result = await pi.handlers.get('tool_call')(
    { toolName: 'edit', input: { path: 'file.txt' } },
    { hasUI: true, ui: { confirm: async () => true } },
  );
  assert.equal(result, undefined);
  assert.equal(installed.state.authority, null);
  assert.equal(installed.state.latest_policy_decision.authority_granted_by_decision, false);
});
