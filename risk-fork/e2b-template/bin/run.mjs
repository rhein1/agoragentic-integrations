#!/usr/bin/env node
import { constants } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  validateChildOperation,
  validateLocalReferenceOperation,
} from '../../src/child-operation.mjs';
import {
  canonicalize,
  requireSha256Ref,
  sha256FileRef,
  sha256Ref,
} from '../lib/runtime-contract.mjs';

const WORKSPACE_ROOT = '/workspace/agoragentic-risk-fork-v1';
const RUNNER_ARTIFACT_PATH = '/opt/agoragentic/risk-fork/e2b-template/bin/run.mjs';
const MAX_JOB_BYTES = 1024 * 1024;
const JOB_KEYS = Object.freeze([
  'schema',
  'job_id',
  'capsule_hash',
  'identity_hash',
  'network_policy_hash',
  'operation_hash',
  'execution_mode',
  'expected_result_schema_hash',
  'operation',
  'result_path',
  'job_hash',
]);

function assertPlainObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${field} must be a plain object`);
  }
}

function assertAllowedKeys(value, allowed, field) {
  assertPlainObject(value, field);
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new TypeError(`${field} contains unsupported fields: ${unexpected.sort().join(', ')}`);
  }
}

function validateJob(value, resultPath) {
  assertAllowedKeys(value, JOB_KEYS, 'runner job');
  if (value.schema !== 'agoragentic.risk-fork.runner-job.v1') {
    throw new TypeError('runner job schema is invalid');
  }
  if (typeof value.job_id !== 'string' || !/^rfj_[a-f0-9]{16,64}$/.test(value.job_id)) {
    throw new TypeError('runner job id is invalid');
  }
  for (const field of [
    'capsule_hash',
    'identity_hash',
    'network_policy_hash',
    'operation_hash',
    'expected_result_schema_hash',
    'job_hash',
  ]) requireSha256Ref(value[field], `runner job.${field}`);
  if (!['prepare_only', 'isolated_execution'].includes(value.execution_mode)) {
    throw new TypeError('runner execution mode is invalid');
  }
  if (typeof value.result_path !== 'string'
    || value.result_path.length < 1
    || value.result_path.length > 4096
    || path.resolve(value.result_path) !== path.resolve(resultPath)) {
    throw new Error('runner result path binding mismatch');
  }
  const operation = validateLocalReferenceOperation(value.operation);
  if (sha256Ref(operation) !== value.operation_hash) {
    throw new Error('runner operation hash mismatch');
  }
  if (sha256Ref({ ...value, job_hash: null }) !== value.job_hash) {
    throw new Error('runner job hash mismatch');
  }
  if (!Object.hasOwn(operation, 'commit_candidate')) {
    throw new Error('runner operation requires a tainted commit candidate');
  }
  const commitCandidate = validateChildOperation(
    operation.commit_candidate,
    'runner commit candidate',
  );
  return { ...value, operation, commitCandidate };
}

async function requireWorkspaceRoot(workspaceRoot) {
  const root = path.resolve(workspaceRoot);
  const info = await lstat(root, { bigint: true });
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new TypeError('runner workspace root must be a real directory');
  }
  const resolved = await realpath(root);
  if (resolved !== root) throw new Error('runner workspace root must be canonical');
  return root;
}

function resolveBelow(root, relative) {
  const target = path.resolve(root, ...relative.split('/'));
  if (!target.startsWith(`${root}${path.sep}`)) {
    throw new Error('runner path is not below the workspace');
  }
  return target;
}

async function ensureSafeParents(root, target) {
  const relative = path.relative(root, path.dirname(target));
  let cursor = root;
  for (const segment of relative === '' ? [] : relative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    try {
      const info = await lstat(cursor, { bigint: true });
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error('runner parent path is not a real directory');
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await mkdir(cursor, { mode: 0o700 });
    }
    const resolved = await realpath(cursor);
    if (resolved !== cursor || !resolved.startsWith(`${root}${path.sep}`)) {
      throw new Error('runner parent directory escapes the workspace');
    }
  }
}

async function openNoFollow(target, flags, mode) {
  const noFollow = Number.isInteger(constants.O_NOFOLLOW) ? constants.O_NOFOLLOW : 0;
  return open(target, flags | noFollow, mode);
}

async function executeAction(root, action) {
  const target = resolveBelow(root, action.path);
  if (action.type === 'write') {
    await ensureSafeParents(root, target);
    const handle = await openNoFollow(
      target,
      constants.O_WRONLY | constants.O_CREAT,
      0o600,
    );
    try {
      const info = await handle.stat({ bigint: true });
      if (!info.isFile() || info.nlink > 1n) {
        throw new Error('runner refuses a non-regular or hard-linked write target');
      }
      await handle.truncate(0);
      await handle.writeFile(action.content, 'utf8');
      await handle.sync();
      await handle.chmod(0o600);
    } finally {
      await handle.close();
    }
    return;
  }
  const handle = await openNoFollow(target, constants.O_RDONLY);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink > 1n) {
      throw new Error('runner refuses a non-regular or hard-linked target');
    }
    if (action.type === 'read') {
      await handle.readFile();
      const after = await handle.stat({ bigint: true });
      if (String(before.dev) !== String(after.dev)
        || String(before.ino) !== String(after.ino)
        || String(before.size) !== String(after.size)) {
        throw new Error('runner read target changed during the operation');
      }
      return;
    }
  } finally {
    await handle.close();
  }
  if (action.type === 'delete') {
    await unlink(target);
    return;
  }
  throw new Error('runner operation type is unsupported');
}

async function writeAtomicExclusive(target, bytes, jobId) {
  const temporary = `${target}.${jobId}.tmp`;
  let temporaryCreated = false;
  try {
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o400,
    );
    temporaryCreated = true;
    try {
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.chmod(0o400);
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, target);
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw new Error('runner result already exists; the job/result pair is one-use');
      }
      throw error;
    }
  } finally {
    if (temporaryCreated) await unlink(temporary).catch(() => {});
  }
}

async function requireSafeResultParent(target) {
  const parent = path.dirname(path.resolve(target));
  const info = await lstat(parent, { bigint: true });
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new TypeError('runner result parent must be a real directory');
  }
  const resolved = await realpath(parent);
  if (resolved !== parent) throw new Error('runner result parent must be canonical');
}

export async function runRunnerJob(options = {}) {
  const resultPath = path.resolve(String(options.resultPath));
  const job = validateJob(options.job, resultPath);
  await requireSafeResultParent(resultPath);
  const runnerArtifactHash = await sha256FileRef(
    options.runnerArtifactPath ?? RUNNER_ARTIFACT_PATH,
  );
  const root = await requireWorkspaceRoot(options.workspaceRoot ?? WORKSPACE_ROOT);
  for (const action of job.operation.actions) await executeAction(root, action);
  const result = {
    schema: 'agoragentic.risk-fork.runner-result.v1',
    status: 'completed',
    job_id: job.job_id,
    job_hash: job.job_hash,
    capsule_hash: job.capsule_hash,
    identity_hash: job.identity_hash,
    network_policy_hash: job.network_policy_hash,
    operation_hash: job.operation_hash,
    execution_mode: job.execution_mode,
    trusted_runner_artifact_hash: runnerArtifactHash,
    expected_result_schema_hash: job.expected_result_schema_hash,
    commit_candidate: job.commitCandidate,
    commit_candidate_hash: sha256Ref(job.commitCandidate),
  };
  await writeAtomicExclusive(
    resultPath,
    Buffer.from(`${canonicalize(result)}\n`, 'utf8'),
    job.job_id,
  );
  return Object.freeze(result);
}

async function readJob(target) {
  const bytes = await readFile(target);
  if (bytes.byteLength > MAX_JOB_BYTES) throw new Error('runner job exceeds its byte bound');
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('runner job is invalid JSON');
  }
}

export function parseRunnerTransportPaths(argv = process.argv) {
  if (!Array.isArray(argv)
    || argv.length !== 6
    || argv[2] !== '--job'
    || argv[4] !== '--result') {
    throw new TypeError('runner requires exactly --job <path> --result <path>');
  }
  const jobPath = argv[3];
  const resultPath = argv[5];
  const jobMatch = /^\/tmp\/agoragentic-risk-fork-v1\.job\.(rfj_[a-f0-9]{16,64})\.json$/.exec(
    jobPath,
  );
  const resultMatch = /^\/tmp\/agoragentic-risk-fork-v1\.result\.(rfj_[a-f0-9]{16,64})\.json$/.exec(
    resultPath,
  );
  if (!jobMatch || !resultMatch) {
    throw new TypeError('runner paths are outside the fixed one-use transport namespace');
  }
  if (jobMatch[1] !== resultMatch[1]) {
    throw new Error('runner job/result transport pair is mismatched');
  }
  return { jobId: jobMatch[1], jobPath, resultPath };
}

async function main() {
  const { jobId, jobPath, resultPath } = parseRunnerTransportPaths();
  const job = await readJob(jobPath);
  if (job?.job_id !== jobId) throw new Error('runner transport path does not bind the job id');
  await runRunnerJob({
    job,
    resultPath,
  });
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch(() => {
    process.stderr.write('{"status":"failed","code":"E2B_RUNNER_REJECTED"}\n');
    process.exitCode = 1;
  });
}
