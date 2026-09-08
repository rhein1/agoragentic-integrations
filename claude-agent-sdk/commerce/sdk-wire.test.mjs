// Real SDK public query API; inert in-memory CLI peer, no Claude process/model.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeAgentSdkGatingAdapter } from '../agoragentic_claude_agent.ts';

test('registered TypeScript SDK hook returns deny on the real control wire', { timeout: 15000 }, async () => {
  const peer = new EventEmitter();
  peer.stdout = new PassThrough();
  peer.killed = false;
  peer.exitCode = null;
  peer.kill = () => { peer.killed = true; peer.exitCode = 0; peer.stdout.end(); peer.emit('exit', 0, null); return true; };
  const send = frame => peer.stdout.write(JSON.stringify(frame) + '\n');
  let callbackId;
  const responses = [];
  const cases = [['agoragentic_execute', 'Approval_Required'], ['Bash', 'Unsupported_Tool'], ['agoragentic_match', null]];
  const invoke = () => send({ type: 'control_request', request_id: `fixture-${responses.length}`, request: {
    subtype: 'hook_callback', callback_id: callbackId, tool_use_id: 'fixture',
    input: { hook_event_name: 'PreToolUse', tool_name: cases[responses.length][0],
      tool_input: { constraints: { max_cost_usdc: '0.1' } } },
  } });
  let buffer = '';
  peer.stdin = new Writable({ write(chunk, encoding, done) {
    try {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const frame = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
        if (frame.type === 'control_request') {
          assert.equal(frame.request.subtype, 'initialize');
          const matchers = frame.request.hooks.PreToolUse;
          assert.equal(matchers.length, 1);
          assert.ok(matchers[0].matcher == null);
          [callbackId] = matchers[0].hookCallbackIds;
          assert.equal(typeof callbackId, 'string');
          send({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: {} } });
          invoke();
        } else if (frame.type === 'control_response') {
          const response = frame.response;
          assert.equal(response.subtype, 'success');
          assert.equal(response.request_id, `fixture-${responses.length}`);
          const reason = cases[responses.length][1];
          if (reason) assert.deepEqual(response.response.hookSpecificOutput, {
            hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason,
          });
          else assert.deepEqual(response.response, {});
          responses.push(response);
          if (responses.length < cases.length) invoke();
          else { send({ type: 'result', subtype: 'success', is_error: false, result: 'synthetic wire complete',
            session_id: 'fixture', uuid: 'fixture', duration_ms: 0, duration_api_ms: 0, num_turns: 0,
            total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [] });
            setImmediate(() => peer.kill());
          }
        }
      }
      done();
    } catch (error) { done(error); }
  } });
  let spawnCount = 0;
  const session = query({ prompt: 'inert transport fixture', options: {
    hooks: new ClaudeAgentSdkGatingAdapter().sdkHooks(), persistSession: false, settingSources: [], env: {},
    spawnClaudeCodeProcess: () => { spawnCount++; return peer; },
  } });
  try {
    const messages = [];
    for await (const message of session) messages.push(message);
    assert.equal(messages.at(-1).result, 'synthetic wire complete');
    assert.equal(spawnCount, 1);
    assert.equal(responses.length, 3);
  } finally { session.close(); peer.kill(); }
});
