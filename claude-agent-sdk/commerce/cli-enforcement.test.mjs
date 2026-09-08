/** Real CLI + SDK, deterministic loopback Messages fixture. No provider/model.
 * The control uses one inert Write into a fresh temporary directory. The adapter
 * must prevent that same write. Never run against a merchant or real credentials.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeAgentSdkGatingAdapter } from '../agoragentic_claude_agent.ts';

const sdkRoot = path.dirname(fileURLToPath(import.meta.resolve('@anthropic-ai/claude-agent-sdk')));
const manifest = JSON.parse(await readFile(path.join(sdkRoot, 'manifest.json'), 'utf8'));
const platform = `${process.platform}-${process.arch}`;
const binary = path.join(sdkRoot, '..', `claude-agent-sdk-${platform}`, manifest.platforms[platform].binary);
const bytes = await readFile(binary);
assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.platforms[platform].checksum);
assert.equal(manifest.version, '2.1.263');

function sse(response, block, stopReason) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const event = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  event('message_start', { message: { id: 'msg_fixture', type: 'message', role: 'assistant',
    model: 'claude-sonnet-4-5', content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 0 } } });
  event('content_block_start', { index: 0, content_block: block.type === 'tool_use'
    ? { ...block, input: {} } : { type: 'text', text: '' } });
  event('content_block_delta', { index: 0, delta: block.type === 'tool_use'
    ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) }
    : { type: 'text_delta', text: block.text } });
  event('content_block_stop', { index: 0 });
  event('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 1 } });
  event('message_stop', {});
  response.end();
}

async function exercise(deny) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'commerce-cli-enforcement-'));
  const marker = path.join(directory, 'effect.txt');
  const toolInput = { file_path: marker, content: 'synthetic fixture effect\n' };
  const requests = [];
  const hooks = [];
  const postHooks = [];
  const unexpectedRequests = [];
  let child;
  let exited;
  let stderr = '';
  let cli;
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (request.url?.startsWith('/v1/messages/count_tokens')) {
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"input_tokens":1}'); return;
    }
    if (!request.url?.startsWith('/v1/messages')) {
      unexpectedRequests.push('unexpected_http_route'); response.writeHead(404); response.end(); return;
    }
    assert.equal(request.headers['x-api-key'], 'fixture-not-a-provider-key');
    const body = JSON.parse(Buffer.concat(chunks));
    requests.push(body);
    if (requests.length > 2) { response.writeHead(429); response.end(); return; }
    if (requests.length === 1) {
      sse(response, { type: 'tool_use', id: 'toolu_fixture', name: 'Write', input: toolInput }, 'tool_use');
    } else sse(response, { type: 'text', text: 'Fixture complete.' }, 'end_turn');
  });
  server.on('connect', (_request, socket) => {
    unexpectedRequests.push('external_proxy_attempt'); socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'COMSPEC']
    .filter(key => process.env[key]).map(key => [key, process.env[key]]));
  Object.assign(env, { HOME: directory, USERPROFILE: directory, APPDATA: directory, LOCALAPPDATA: directory,
    CLAUDE_CONFIG_DIR: directory, ANTHROPIC_API_KEY: 'fixture-not-a-provider-key', ANTHROPIC_BASE_URL: base,
    HTTP_PROXY: base, HTTPS_PROXY: base, NO_PROXY: '127.0.0.1',
    DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
  const adapter = new ClaudeAgentSdkGatingAdapter();
  const registeredHook = adapter.sdkHooks().PreToolUse[0].hooks[0];
  const watchdog = setTimeout(() => { cli?.close(); child?.kill(); }, 30000);
  try {
    cli = query({ prompt: 'Run the single synthetic fixture write, then stop.', options: {
      cwd: directory, pathToClaudeCodeExecutable: binary, env,
      systemPrompt: 'Local deterministic test. Only the synthetic Write is available.',
      tools: ['Write'], settingSources: [], persistSession: false, maxTurns: 2,
      model: 'claude-sonnet-4-5', permissionMode: 'default',
      extraArgs: { 'strict-mcp-config': null, restricted: null },
      canUseTool: async (name, input) => name === 'Write' && JSON.stringify(input) === JSON.stringify(toolInput)
        ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'fixture scope only' },
      hooks: { PreToolUse: [{ hooks: [async (...args) => {
        const output = deny ? await registeredHook(...args) : {};
        hooks.push({ input: args[0], output }); return output;
      }] }], PostToolUse: [{ hooks: [async (input) => { postHooks.push(input.tool_name); return {}; }] }] },
      spawnClaudeCodeProcess: options => {
        child = spawn(options.command, options.args, { cwd: directory, env, windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'] });
        exited = new Promise(resolve => child.once('close', resolve));
        child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-2000); });
        return child;
      },
    } });
    const messages = [];
    try { for await (const message of cli) messages.push(message); }
    catch (error) { throw new Error(`${error.message}; CLI diagnostic: ${stderr}`); }
    assert.equal(requests.length, 2, 'real CLI must complete a tool round trip');
    assert.deepEqual(unexpectedRequests, []);
    assert.equal(hooks.length, 1, 'real CLI must invoke PreToolUse once');
    assert.equal(hooks[0].input.tool_name, 'Write');
    assert.equal(messages.at(-1).is_error, false, JSON.stringify(messages.at(-1)));
    const results = requests[1].messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
      .filter(block => block.type === 'tool_result' && block.tool_use_id === 'toolu_fixture');
    assert.equal(results.length, 1);
    if (deny) {
      await assert.rejects(readFile(marker), { code: 'ENOENT' });
      assert.equal(hooks[0].output.hookSpecificOutput.permissionDecision, 'deny');
      assert.equal(hooks[0].output.hookSpecificOutput.permissionDecisionReason, 'Unsupported_Tool');
      assert.equal(results[0].is_error, true);
      assert.deepEqual(postHooks, []);
    } else {
      assert.equal(await readFile(marker, 'utf8'), toolInput.content);
      assert.notEqual(results[0].is_error, true);
      assert.deepEqual(postHooks, ['Write']);
    }
    return { cli: manifest.version, sdk: '0.3.263', boundary: 'real CLI with synthetic Messages fixture',
      hook_calls: hooks.length, successful_post_tool_events: postHooks.length,
      fixture_effect_count: deny ? 0 : 1, provider_called: false };
  } finally {
    clearTimeout(watchdog); cli?.close(); child?.kill();
    if (exited) await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('commerce-cli-enforcement-'));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

test('real CLI control permits one inert write', { timeout: 40000 }, async () => console.log(await exercise(false)));
test('real CLI enforces adapter deny with zero inert writes', { timeout: 40000 }, async () => console.log(await exercise(true)));
