#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { OFFLINE_KIT_BANNER, OFFLINE_KIT_TRUTH } from '../src/offline-kit.mjs';
import { getDefaultDemoRoot } from '../src/demo-engine.mjs';

const EXPECTED_TOOLS = Object.freeze([
  'risk_fork_demo_list_scenarios',
  'risk_fork_demo_plan',
  'risk_fork_demo_receipt',
  'risk_fork_demo_run',
]);

function assertTruth(value, label) {
  for (const [key, expected] of Object.entries(OFFLINE_KIT_TRUTH)) {
    if (value?.[key] !== expected) throw new Error(`${label} truth field ${key} is invalid`);
  }
}

function minimalEnvironment(temporary) {
  return Object.fromEntries(Object.entries({
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    ComSpec: process.env.ComSpec,
    TEMP: temporary,
    TMP: temporary,
    TMPDIR: temporary,
    AGORAGENTIC_NO_SPEND: '1',
    AGORAGENTIC_ALLOW_REAL_SPEND: '0',
    AGORAGENTIC_ALLOW_NETWORK_CANARIES: '0',
    RISK_FORK_DEMO_ALLOW_LOOPBACK: '0',
  }).filter(([, value]) => typeof value === 'string' && value.length > 0));
}

function waitForExit(child, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('MCP stdio process did not exit within the bounded timeout'));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function createLineClient(child) {
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const queue = [];
  let waiter = null;
  lines.on('line', (line) => {
    const parsed = JSON.parse(line);
    if (waiter) {
      const current = waiter;
      waiter = null;
      current.resolve(parsed);
    } else {
      queue.push(parsed);
    }
  });
  const next = () => {
    if (queue.length > 0) return Promise.resolve(queue.shift());
    if (waiter) throw new Error('MCP conformance probe attempted concurrent reads');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiter = null;
        reject(new Error('MCP response exceeded the bounded timeout'));
      }, 20_000);
      waiter = {
        resolve(value) {
          clearTimeout(timer);
          resolve(value);
        },
      };
    });
  };
  const send = async (value) => {
    child.stdin.write(`${JSON.stringify(value)}\n`);
    if (!Object.hasOwn(value, 'id')) return null;
    const result = await next();
    if (result.id !== value.id || result.jsonrpc !== '2.0' || result.error) {
      throw new Error(`MCP request ${value.id} failed protocol conformance`);
    }
    return result.result;
  };
  return { send, close: () => lines.close() };
}

async function runCleanup(entrypoint, environment) {
  const child = spawn(process.execPath, [entrypoint, 'cleanup'], {
    cwd: path.dirname(entrypoint),
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const exit = await waitForExit(child);
  if (exit.code !== 0 || stderr.length > 0) throw new Error('MCP probe cleanup failed closed');
  const result = JSON.parse(Buffer.concat(stdout).toString('utf8'));
  assertTruth(result, 'cleanup');
  if (result.cleanup?.status !== 'verified') throw new Error('MCP probe cleanup was not verified');
  return result;
}

export async function runMcpClientConformance({ entrypoint } = {}) {
  if (typeof entrypoint !== 'string' || !path.isAbsolute(entrypoint)) {
    throw new TypeError('entrypoint must be an explicit absolute path');
  }
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-mcp-client-'));
  const environment = minimalEnvironment(temporary);
  const child = spawn(process.execPath, [entrypoint, 'mcp'], {
    cwd: path.dirname(entrypoint),
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const stderr = [];
  child.stderr.on('data', (chunk) => {
    if (stderr.reduce((sum, item) => sum + item.length, 0) < 64 * 1024) stderr.push(chunk);
  });
  const client = createLineClient(child);
  let cleanup = null;
  try {
    const initialized = await client.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'risk-fork-release-conformance', version: '1' },
      },
    });
    if (initialized.protocolVersion !== '2025-06-18'
      || initialized.serverInfo?.name !== 'agoragentic-risk-fork-demo'
      || !initialized.instructions?.includes(OFFLINE_KIT_BANNER)) {
      throw new Error('MCP initialization contract drifted');
    }
    await client.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    const listed = await client.send({
      jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: { progressToken: 0 } },
    });
    const toolNames = listed.tools.map((tool) => tool.name).sort();
    if (JSON.stringify(toolNames) !== JSON.stringify(EXPECTED_TOOLS)) {
      throw new Error('MCP tool inventory drifted from the served demo surface');
    }
    const planned = await client.send({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: {
        _meta: { progressToken: 1 },
        name: 'risk_fork_demo_plan',
        arguments: { scenario: 'low-read-only' },
      },
    });
    assertTruth(planned.structuredContent, 'plan');
    if (planned.structuredContent.writes_performed !== false) throw new Error('MCP plan wrote state');
    const ran = await client.send({
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: {
        _meta: { progressToken: 2 },
        name: 'risk_fork_demo_run',
        arguments: { scenario: 'high-filesystem-write' },
      },
    });
    const run = ran.structuredContent;
    assertTruth(run, 'run');
    if (ran.isError === true
      || run.final_state !== 'prepared_not_committed'
      || run.core_receipt_verified !== true
      || run.clean_commit_performed !== false
      || run.cleanup?.status !== 'verified'
      || typeof run.run_id !== 'string') {
      throw new Error('MCP run did not preserve the synthetic prepare-only contract');
    }
    const receiptResult = await client.send({
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: {
        _meta: { progressToken: 3 },
        name: 'risk_fork_demo_receipt',
        arguments: { run_id: run.run_id },
      },
    });
    assertTruth(receiptResult.structuredContent, 'receipt');
    if (receiptResult.isError === true
      || receiptResult.structuredContent.found !== true
      || receiptResult.structuredContent.run_id !== run.run_id) {
      throw new Error('MCP receipt lookup failed');
    }
    child.stdin.end();
    const exit = await waitForExit(child);
    client.close();
    if (exit.code !== 0 || stderr.length > 0) throw new Error('MCP stdio server exited with diagnostics');
    cleanup = await runCleanup(entrypoint, environment);
    const entries = await readdir(temporary);
    const expectedRoot = path.basename(getDefaultDemoRoot());
    if (entries.length > 1 || (entries.length === 1 && entries[0] !== expectedRoot)) {
      throw new Error('MCP probe temporary parent contains unexpected entries');
    }
    await rm(temporary, { recursive: true, force: false, maxRetries: 0 });
    return Object.freeze({
      schema: 'agoragentic.risk-fork.mcp-client-conformance.v1',
      banner: OFFLINE_KIT_BANNER,
      ...OFFLINE_KIT_TRUTH,
      verified: true,
      transport: 'stdio_json_rpc',
      protocol_version: initialized.protocolVersion,
      client: 'minimal_protocol_conformance_probe',
      gui_client_status: 'unknown_not_tested',
      tools: toolNames,
      calls_verified: ['initialize', 'tools/list', 'risk_fork_demo_plan', 'risk_fork_demo_run', 'risk_fork_demo_receipt'],
      scenario: 'high-filesystem-write',
      final_state: run.final_state,
      clean_commit_performed: false,
      core_receipt_verified: true,
      receipt_verified: true,
      cleanup: cleanup.cleanup,
    });
  } catch (error) {
    child.kill();
    client.close();
    await runCleanup(entrypoint, environment).catch(() => {});
    await rm(temporary, { recursive: true, force: false, maxRetries: 0 }).catch(() => {});
    throw error;
  }
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(scriptPath)) {
  const candidate = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.resolve(path.dirname(scriptPath), '..', 'bin', 'risk-fork-demo.mjs');
  const result = await runMcpClientConformance({ entrypoint: candidate });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
