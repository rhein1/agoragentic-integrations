import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { validateLocalReferenceOperation } from '../child-operation.mjs';

const workspace = path.resolve(process.argv[2] ?? '');
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_ACTIONS = 500;
const MAX_FILE_BYTES = 512 * 1024;

function safeRelativePath(value) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('action path is required');
  const normalized = value.trim().replaceAll('\\', '/');
  if (normalized.includes('\0')
    || normalized.includes(':')
    || normalized.startsWith('/')
    || normalized.split('/').includes('..')) {
    throw new Error('action path must be a safe relative path');
  }
  const clean = path.posix.normalize(normalized).replace(/^\.\//, '');
  if (!clean || clean === '.' || clean.startsWith('../')) throw new Error('action path is invalid');
  return clean;
}

function resolveBelowWorkspace(relative) {
  const absolute = path.resolve(workspace, ...relative.split('/'));
  const prefix = `${workspace}${path.sep}`;
  if (!absolute.startsWith(prefix)) throw new Error('action path escapes the fork workspace');
  return absolute;
}

async function assertNoSymlinkPath(target) {
  let cursor = path.dirname(target);
  while (cursor.startsWith(workspace) && cursor !== workspace) {
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) throw new Error('symlink traversal is forbidden');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    cursor = path.dirname(cursor);
  }
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new Error('symlink targets are forbidden');
    if (info.isFile() && info.nlink > 1) throw new Error('hard-linked files are forbidden');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function executeAction(action, index) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    throw new Error(`actions[${index}] must be an object`);
  }
  const allowed = new Set(['type', 'path', 'content']);
  const unexpected = Object.keys(action).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) throw new Error(`actions[${index}] has unsupported fields`);
  const relative = safeRelativePath(action.path);
  const target = resolveBelowWorkspace(relative);
  await assertNoSymlinkPath(target);
  if (action.type === 'read') {
    const content = await readFile(target, 'utf8');
    return { type: 'read', path: relative, bytes: Buffer.byteLength(content, 'utf8') };
  }
  if (action.type === 'write') {
    if (typeof action.content !== 'string') throw new Error(`actions[${index}].content must be text`);
    const bytes = Buffer.byteLength(action.content, 'utf8');
    if (bytes > MAX_FILE_BYTES) throw new Error(`actions[${index}] exceeds ${MAX_FILE_BYTES} bytes`);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, action.content, { encoding: 'utf8', mode: 0o600 });
    return { type: 'write', path: relative, bytes };
  }
  if (action.type === 'delete') {
    await rm(target, { force: true, recursive: false });
    return { type: 'delete', path: relative, bytes: 0 };
  }
  throw new Error(`Unsupported local reference action: ${String(action.type)}`);
}

async function main() {
  if (process.env.RISK_FORK_NETWORK !== 'blocked') {
    throw new Error('Local reference runner requires the blocked network contract');
  }
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input, 'utf8') > MAX_INPUT_BYTES) throw new Error('runner input is too large');
  }
  const request = validateLocalReferenceOperation(JSON.parse(input));
  if (request.actions.length > MAX_ACTIONS) throw new Error(`operation exceeds ${MAX_ACTIONS} actions`);
  const observations = [];
  for (const [index, action] of request.actions.entries()) {
    observations.push(await executeAction(action, index));
  }
  process.stdout.write(`${JSON.stringify({
    schema: 'agoragentic.risk-fork.local-runner-result.v1',
    status: 'completed',
    network_contract: 'blocked_by_closed_operation_set_not_kernel_firewall',
    observations,
    commit_candidate: request.commit_candidate ?? null,
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    status: 'failed',
    code: 'LOCAL_REFERENCE_OPERATION_REJECTED',
    message: String(error?.message ?? error).slice(0, 2000),
  })}\n`);
  process.exitCode = 1;
});
