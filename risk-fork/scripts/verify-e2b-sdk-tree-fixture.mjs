// Fixed, keyless synthetic fixture. Never a production SDK launcher.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { createE2BRuntimeSdkProcessBoundary } from '../src/e2b-sdk-process.mjs';

const [directory, artifact] = process.argv.slice(2);
assert.equal(process.argv.length, 4);
assert.equal(directory, '/fixtures');
assert.equal(artifact, '/source/risk-fork-hosted-mcp/dist/runtime/index.mjs');
assert.equal(process.getuid(), 65532);
assert.equal(process.env.E2B_API_KEY, undefined);
await assert.rejects(writeFile('/sys/fs/cgroup/cgroup.procs', String(process.pid)),
  (error) => ['EROFS', 'EACCES', 'EPERM'].includes(error.code));
await assert.rejects(writeFile('/sys/fs/cgroup/cgroup.subtree_control', '+pids'),
  (error) => ['EROFS', 'EACCES', 'EPERM'].includes(error.code));
const sha = async (file) => `sha256:${createHash('sha256').update(await readFile(file)).digest('hex')}`;
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const keepAlive = setInterval(() => {}, 1_000);
const ready = new Promise((resolve, reject) => {
  input.once('line', (line) => {
    try { assert.equal(line, '{"start":true}'); resolve(); }
    catch { reject(new Error('fixture handshake rejected')); }
  });
  input.once('close', () => reject(new Error('fixture handoff absent')));
});
process.stdout.write('{"phase":"pre_scope_ready","migration_denied":true}\n');
await ready;
const boundary = createE2BRuntimeSdkProcessBoundary({
  runtimeArtifactPath: artifact, runtimeArtifactHash: await sha(artifact),
  nodeArtifactHash: await sha(process.execPath),
  packageDirectory: path.join(directory, 'main/node_modules/e2b'),
  deadlineMs: 2_000, lifetimeMs: 30_000,
});
const binding = await boundary.inspect();
const { module: { Sandbox } } = await boundary.load(binding);
const sandbox = await Sandbox.create('normal', {});
const sdkPid = Number((await Sandbox.getInfo(sandbox.sandboxId)).metadata.pid);
const descendantPid = Number((await sandbox.commands.run('detached-descendant', { timeoutMs: 1_000 })).stdout);
assert.ok(Number.isSafeInteger(sdkPid) && sdkPid > 1);
assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 1 && descendantPid !== sdkPid);
process.stdout.write(`${JSON.stringify({ phase: 'descendant_ready', sdk_pid: sdkPid, descendant_pid: descendantPid })}\n`);
input.once('line', async (line) => {
  try {
    assert.equal(line, '{"close_sdk":true}');
    const cleanup = await boundary.close();
    assert.equal(cleanup.sdk_process_terminated, true);
    assert.equal(cleanup.sdk_process_tree_cleanup_verified, false);
    // Do not kill the detached descendant here. Only the outside host owns
    // whole-container teardown and independently observes its incarnation.
    process.kill(descendantPid, 0);
    process.stdout.write('{"phase":"sdk_root_closed","tree_cleanup_verified":false}\n');
  } catch { process.exitCode = 1; clearInterval(keepAlive); input.close(); }
});
