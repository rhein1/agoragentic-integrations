// Linux host-side LOCAL LAB only. No provider, credential or production API.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, readdir, statfs } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const IMAGE = 'sha256:be23f54a88d34e8824c741b19b91064094f92c1c97b194144bfc8b50d67258e2';
const LABEL = 'agoragentic.risk-fork.sdk-tree-lab';
const CGROUP_ROOT = '/sys/fs/cgroup';
const DOCKER = '/usr/bin/docker';
const DOCKER_ARGS = ['--host', 'unix:///var/run/docker.sock'];
const ENV = Object.freeze({ PATH: '/usr/bin:/bin', LANG: 'C' });
const HASH = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function parseProcStat(text) {
  const end = text.lastIndexOf(')');
  assert.ok(end > 1 && /^\d+ \(/.test(text));
  const fields = text.slice(end + 2).trim().split(/\s+/);
  assert.ok(fields.length >= 20);
  const result = { state: fields[0], parent: Number(fields[1]), session: Number(fields[3]), start: fields[19] };
  assert.match(result.start, /^\d+$/);
  assert.ok(Number.isSafeInteger(result.session) && result.session > 0);
  return result;
}

export function parseCgroup(text) {
  const lines = text.trim().split('\n');
  assert.equal(lines.length, 1, 'cgroup v2 required');
  assert.ok(lines[0].startsWith('0::/'));
  const value = lines[0].slice(3);
  assert.ok(!value.includes('\0') && path.posix.normalize(value) === value && value !== '/');
  return value;
}

export function parsePids(text) {
  if (!text.trim()) return [];
  const result = text.trim().split('\n').map((value) => {
    assert.match(value, /^[1-9]\d*$/);
    const pid = Number(value); assert.ok(Number.isSafeInteger(pid) && pid > 1); return pid;
  });
  assert.ok(result.length <= 128, 'lab PID bound');
  return [...new Set(result)];
}

export function parseEvents(text) {
  const entries = text.trim().split('\n').map((line) => line.split(' '));
  assert.ok(entries.every((entry) => entry.length === 2 && /^[a-z_]+$/.test(entry[0]) && /^[01]$/.test(entry[1])));
  assert.equal(entries.filter(([key]) => key === 'populated').length, 1);
  return entries.find(([key]) => key === 'populated')[1] === '1';
}

export function cleanupStatus({ bound, readonly, killed, empty, removed, absent, uncertain }) {
  return bound === true && readonly === true && killed === true && empty === true
    && removed === true && absent === true && uncertain === false ? 'verified' : 'unknown';
}

export function workloadStatus({ completed, uncertain, cleanup }) {
  const workload_completed = completed === true;
  return { workload_completed, workload_passed: workload_completed && uncertain === false && cleanup === 'verified' };
}

export function assertKeylessImageEnvironment(entries) {
  assert.ok(Array.isArray(entries) && entries.length === 3);
  assert.ok(entries.every((entry) => typeof entry === 'string' && entry.length <= 4_096
    && entry.includes('=') && !/[\0\r\n]/.test(entry)));
  assert.equal(entries.some((entry) => entry.startsWith('E2B_API_KEY=')), false);
  assert.deepEqual(entries.map((entry) => entry.split('=')[0]).sort(), ['NODE_VERSION', 'PATH', 'YARN_VERSION']);
}

async function docker(args) {
  // Fixed local socket and fresh minimal environment: no shared CLI context,
  // remote endpoint, shell expansion or ambient provider credentials.
  const { stdout } = await exec(DOCKER, [...DOCKER_ARGS, ...args], {
    env: ENV, timeout: 10_000, maxBuffer: 1024 * 1024, encoding: 'utf8',
  });
  return stdout.trim();
}

async function inspect(id) {
  assert.match(id, /^[a-f0-9]{64}$/);
  const values = JSON.parse(await docker(['container', 'inspect', id]));
  assert.equal(values.length, 1); assert.equal(values[0].Id, id);
  return values[0];
}

function identity(value, id, nonce, sourceRoot, fixtureRoot) {
  assert.equal(value.Id, id); assert.equal(value.Image, IMAGE);
  assert.equal(value.Config.Labels?.[LABEL], nonce);
  assert.equal(value.HostConfig.RestartPolicy.Name, 'no');
  assert.equal(value.HostConfig.Privileged, false);
  assert.equal(value.Config.User, '65532:65532');
  assert.equal(value.HostConfig.ReadonlyRootfs, true);
  assert.equal(value.HostConfig.NetworkMode, 'none');
  assert.equal(value.HostConfig.CgroupnsMode, 'private');
  assert.deepEqual(value.HostConfig.CapDrop, ['ALL']);
  assert.ok(value.HostConfig.SecurityOpt.includes('no-new-privileges'));
  assert.equal(value.HostConfig.PidsLimit, 128);
  assert.equal(value.HostConfig.Memory, 1024 * 1024 * 1024);
  assert.equal(value.HostConfig.NanoCpus, 2_000_000_000);
  assert.equal(value.HostConfig.AutoRemove, false);
  assert.equal(value.State.OOMKilled, false);
  assertKeylessImageEnvironment(value.Config.Env);
  assert.deepEqual(value.Mounts.map(({ Type, Source, Destination, RW }) => ({ Type, Source, Destination, RW })).sort((a, b) => a.Destination.localeCompare(b.Destination)), [
    { Type: 'bind', Source: fixtureRoot, Destination: '/fixtures', RW: false },
    { Type: 'bind', Source: sourceRoot, Destination: '/source', RW: false },
  ]);
}

async function proc(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  const base = `/proc/${pid}`;
  const before = parseProcStat(await readFile(`${base}/stat`, 'utf8'));
  const status = await readFile(`${base}/status`, 'utf8');
  const cgroup = parseCgroup(await readFile(`${base}/cgroup`, 'utf8'));
  const after = parseProcStat(await readFile(`${base}/stat`, 'utf8'));
  assert.equal(before.start, after.start, 'PID incarnation drift');
  const nspid = /^NSpid:\s+([\d\s]+)$/m.exec(status)?.[1].trim().split(/\s+/).map(Number);
  assert.ok(nspid?.length >= 2 && nspid[0] === pid);
  assert.match(status, /^Uid:\s+65532\s+65532\s+65532\s+65532$/m);
  assert.match(status, /^CapEff:\s+0+$/m); assert.match(status, /^NoNewPrivs:\s+1$/m);
  assert.match(status, /^Seccomp:\s+2$/m);
  const mounts = (await readFile(`${base}/mountinfo`, 'utf8')).trim().split('\n').map((line) => line.split(' '));
  const cgroupMount = mounts.filter((fields) => fields[4] === '/sys/fs/cgroup');
  assert.equal(cgroupMount.length, 1);
  const fields = cgroupMount[0], separator = fields.indexOf('-');
  assert.equal(fields[separator + 1], 'cgroup2');
  assert.ok(fields[5].split(',').includes('ro'), 'worker cgroup mount must be read-only');
  assert.notEqual(await readFile(`${base}/cgroup`, 'utf8'), await readFile('/proc/self/cgroup', 'utf8'));
  assert.equal(parseProcStat(await readFile(`${base}/stat`, 'utf8')).start, before.start, 'PID drift during profile observation');
  return { pid, start: after.start, session: after.session, innerPid: nspid.at(-1), cgroup };
}

async function incarnationGone(value) {
  try { return parseProcStat(await readFile(`/proc/${value.pid}/stat`, 'utf8')).start !== value.start; }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}

async function bindScope(initPid, id) {
  assert.equal((await statfs(CGROUP_ROOT)).type, 0x63677270, 'genuine cgroup v2 mount required');
  assert.equal(await realpath(CGROUP_ROOT), CGROUP_ROOT);
  const initial = await proc(initPid);
  // This laboratory is intentionally limited to the observed local systemd
  // Docker driver; it is not a caller-controlled cgroup/PID kill interface.
  assert.equal(initial.cgroup, `/system.slice/docker-${id}.scope`);
  const directory = path.join(CGROUP_ROOT, initial.cgroup);
  assert.equal(await realpath(directory), directory);
  const inode = await lstat(directory);
  const parent = await lstat(path.dirname(directory));
  assert.ok(inode.isDirectory() && !inode.isSymbolicLink());
  assert.ok((await readdir(directory, { withFileTypes: true })).every((entry) => !entry.isDirectory()), 'no delegated child hierarchy');
  for (const file of ['cgroup.procs', 'cgroup.threads', 'cgroup.subtree_control']) {
    const control = await lstat(path.join(directory, file));
    assert.equal(control.uid, 0); assert.equal(control.gid, 0);
    assert.equal(control.mode & 0o022, 0, 'non-root worker must not receive host migration/delegation authority');
  }
  const scope = { directory, inode: `${inode.dev}:${inode.ino}`, parent: `${parent.dev}:${parent.ino}`, initial, readonly: true };
  const snapshot = await observeScope(scope);
  assert.ok(snapshot.populated && snapshot.pids.includes(initPid));
  return scope;
}

async function observeScope(scope) {
  const info = await lstat(scope.directory);
  assert.equal(`${info.dev}:${info.ino}`, scope.inode, 'scope incarnation drift');
  assert.ok((await readdir(scope.directory, { withFileTypes: true })).every((entry) => !entry.isDirectory()));
  const populated = parseEvents(await readFile(path.join(scope.directory, 'cgroup.events'), 'utf8'));
  const pids = parsePids(await readFile(path.join(scope.directory, 'cgroup.procs'), 'utf8'));
  const after = await lstat(scope.directory);
  assert.equal(`${after.dev}:${after.ino}`, scope.inode);
  return { populated, pids };
}

async function emptyScope(scope, processes) {
  assert.equal(scope.readonly, true, 'no-cgroup-migration custody is required');
  try {
    const observed = await observeScope(scope);
    return !observed.populated && observed.pids.length === 0 && (await Promise.all(processes.map(incarnationGone))).every(Boolean)
      ? 'empty_observed' : null;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // runc/systemd can remove the leaf on stop, before docker rm. A missing
    // file inside a still-present scope is NOT empty-scope proof.
    try { await lstat(scope.directory); return null; }
    catch (missing) { if (missing.code !== 'ENOENT') throw missing; }
    const parent = await lstat(path.dirname(scope.directory));
    assert.equal(`${parent.dev}:${parent.ino}`, scope.parent);
    assert.equal((await statfs(CGROUP_ROOT)).type, 0x63677270);
    // Kernel cgroup removal requires an empty tree. Pair exact prior binding
    // with process-incarnation absence, not Docker JSON or PID self-report.
    return (await Promise.all(processes.map(incarnationGone))).every(Boolean) ? 'kernel_scope_removed' : null;
  }
}

async function confirmEmptyScope(scope, processes) {
  const first = await emptyScope(scope, processes);
  if (!first || first === 'kernel_scope_removed') return first;
  await pause(25);
  return await emptyScope(scope, processes);
}

function attach(id) {
  const child = spawn(DOCKER, [...DOCKER_ARGS, 'start', '--attach', '--interactive', id], {
    env: ENV, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const frames = []; const waiters = []; let tail = ''; let bytes = 0; let failed;
  const reject = () => { failed = new Error('bounded fixture channel unavailable'); while (waiters.length) waiters.shift().reject(failed); };
  child.once('error', reject); child.once('close', reject); child.stdin.on('error', reject);
  child.stderr.on('data', (chunk) => { bytes += chunk.length; if (bytes > 16_384) reject(); });
  child.stdout.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > 16_384) return reject();
    tail += chunk.toString('utf8');
    try {
      while (tail.includes('\n')) {
        const end = tail.indexOf('\n'); const frame = JSON.parse(tail.slice(0, end)); tail = tail.slice(end + 1);
        if (waiters.length) waiters.shift().resolve(frame); else { assert.ok(frames.length < 4); frames.push(frame); }
      }
    } catch { reject(); }
  });
  return { child, send(value) { child.stdin.write(`${JSON.stringify(value)}\n`); },
    next() {
      if (failed) return Promise.reject(failed);
      if (frames.length) return Promise.resolve(frames.shift());
      return new Promise((resolve, rejectFrame) => {
        const entry = { resolve, reject: rejectFrame }; waiters.push(entry);
        const timer = setTimeout(() => { const index = waiters.indexOf(entry); if (index >= 0) waiters.splice(index, 1); rejectFrame(new Error('fixture deadline')); }, 10_000);
        entry.resolve = (value) => { clearTimeout(timer); resolve(value); };
        entry.reject = (error) => { clearTimeout(timer); rejectFrame(error); };
      });
    } };
}

export async function runSdkTreeLab(sourceRoot, fixtureRoot, scenario = 'detached') {
  assert.equal(process.platform, 'linux');
  assert.ok(['detached', 'cancel_before_handoff'].includes(scenario));
  for (const value of [sourceRoot, fixtureRoot]) {
    assert.ok(path.isAbsolute(value) && await realpath(value) === value && !/[\0\r\n,]/.test(value));
    assert.notEqual(value, '/');
  }
  assert.match(fixtureRoot, /^\/tmp\/risk-fork-sdk-process\.[A-Za-z0-9]{8}\/fixtures$/);
  assert.ok((await lstat(path.join(fixtureRoot, 'main/node_modules/e2b/package.json'))).isFile());
  assert.equal(JSON.parse(await docker(['image', 'inspect', IMAGE]))[0].Id, IMAGE);
  const nonce = randomUUID(); const labId = path.basename(path.dirname(fixtureRoot)); const name = `${labId}-tree`;
  const metrics = { scope_binding: 'not_run', descendant_same_scope: 'not_run',
    sdk_root_exit_observed: 'not_run', detached_survived_sdk_exit: 'not_run',
    kill_requested: 'not_run', scope_empty_before_remove: 'not_run', container_absent_after_remove: 'not_run',
    cleanup_status: 'unknown', containers_created_observed: 0, containers_removed_observed: 0,
    process_incarnations_observed: 0, credential_released: false, provider_calls: 0,
    provider_cleanup_verified: false, provider_billing_observed: false, production_qualified: false };
  let id; let scope; let channel; let processes = []; let removed = false; let uncertain = false; let workloadOk = false;
  let interrupted = false;
  const interrupt = () => { interrupted = true; channel?.child.stdin.destroy(); channel?.child.kill('SIGKILL'); };
  // Allow finally to perform bounded exact-ID cleanup, including cancellation
  // before credentials/import. SIGKILL/power loss still cannot prove cleanup.
  process.once('SIGTERM', interrupt); process.once('SIGINT', interrupt);
  const watchdog = setTimeout(interrupt, 30_000);
  const started = performance.now();
  try {
    id = await docker(['create', '--pull', 'never', '--name', name, '--label', `${LABEL}=${nonce}`,
      '--label', `agoragentic.risk-fork.sdk-process-lab=${labId}`,
      '--network', 'none', '--user', '65532:65532', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--cpus', '2', '--memory', '1g', '--pids-limit', '128',
      '--cgroupns', 'private', '--restart', 'no', '--interactive',
      '--tmpfs', '/tmp:rw,nosuid,nodev,mode=1777,size=128m',
      '--mount', `type=bind,src=${sourceRoot},dst=/source,readonly`,
      '--mount', `type=bind,src=${fixtureRoot},dst=/fixtures,readonly`,
      IMAGE, 'node', '/source/risk-fork/scripts/verify-e2b-sdk-tree-fixture.mjs', '/fixtures', '/source/risk-fork-hosted-mcp/dist/runtime/index.mjs']);
    assert.match(id, /^[a-f0-9]{64}$/); identity(await inspect(id), id, nonce, sourceRoot, fixtureRoot);
    metrics.containers_created_observed = 1;
    assert.equal(interrupted, false);
    channel = attach(id);
    assert.deepEqual(await channel.next(), { phase: 'pre_scope_ready', migration_denied: true });
    const running = await inspect(id); identity(running, id, nonce, sourceRoot, fixtureRoot); assert.equal(running.State.Running, true);
    scope = await bindScope(running.State.Pid, id); processes = [scope.initial]; metrics.scope_binding = 'verified';
    metrics.process_incarnations_observed = 1;
    assert.equal(interrupted, false);
    if (scenario === 'cancel_before_handoff') {
      workloadOk = true;
      metrics.cancel_before_sdk_import = 'verified';
    } else {
    channel.send({ start: true }); // No SDK import/effect before host scope observation.
    const ready = await channel.next();
    assert.deepEqual(Object.keys(ready).sort(), ['descendant_pid', 'phase', 'sdk_pid']); assert.equal(ready.phase, 'descendant_ready');
    const snapshot = await observeScope(scope);
    const members = await Promise.all(snapshot.pids.map(proc));
    assert.ok(members.every((value) => value.cgroup === scope.initial.cgroup));
    const worker = members.filter((value) => value.innerPid === ready.sdk_pid);
    const descendant = members.filter((value) => value.innerPid === ready.descendant_pid);
    assert.equal(worker.length, 1); assert.equal(descendant.length, 1);
    assert.equal(descendant[0].session, descendant[0].pid, 'actual detached session required');
    assert.notEqual(worker[0].session, descendant[0].session);
    processes = members; metrics.process_incarnations_observed = members.length; metrics.descendant_same_scope = 'verified';
    channel.send({ close_sdk: true });
    assert.deepEqual(await channel.next(), { phase: 'sdk_root_closed', tree_cleanup_verified: false });
    assert.equal(await incarnationGone(worker[0]), true); metrics.sdk_root_exit_observed = 'verified';
    assert.equal(await incarnationGone(descendant[0]), false); metrics.detached_survived_sdk_exit = 'verified';
    assert.ok((await observeScope(scope)).pids.includes(descendant[0].pid)); workloadOk = true;
    }
  } catch { uncertain = true; }
  finally {
    const teardown = performance.now();
    if (!id || !/^[a-f0-9]{64}$/.test(id)) {
      // Recover only this fixed, unique creation name and nonce-bound profile
      // after a lost CLI response. Never prune/search labels or accept a name
      // collision as cleanup authority. Ambiguous creation still stays unknown.
      try {
        const candidates = JSON.parse(await docker(['container', 'inspect', name]));
        assert.equal(candidates.length, 1);
        const recovered = candidates[0]; assert.match(recovered.Id, /^[a-f0-9]{64}$/);
        identity(recovered, recovered.Id, nonce, sourceRoot, fixtureRoot);
        id = recovered.Id; metrics.create_result_recovered = true;
      } catch { uncertain = true; }
    }
    if (id && /^[a-f0-9]{64}$/.test(id)) {
      try {
        const current = await inspect(id); identity(current, id, nonce, sourceRoot, fixtureRoot);
        if (current.State.Running) {
          if (scope) assert.equal((await proc(current.State.Pid)).start, scope.initial.start);
          await docker(['kill', '--signal', 'KILL', id]); metrics.kill_requested = 'observed';
        }
        if (scope) {
          const deadline = performance.now() + 5_000; let empty;
          do { empty = await confirmEmptyScope(scope, processes); if (!empty) await pause(25); } while (!empty && performance.now() < deadline);
          assert.ok(empty); metrics.scope_empty_before_remove = empty;
        }
        const stopped = await inspect(id); identity(stopped, id, nonce, sourceRoot, fixtureRoot); assert.equal(stopped.State.Running, false);
        assert.equal(stopped.State.Pid, 0);
        if (scope) assert.ok(await confirmEmptyScope(scope, processes), 'repeat kernel proof immediately before removal');
        await docker(['rm', id]); removed = true; metrics.containers_removed_observed = 1;
        const all = await docker(['ps', '--all', '--quiet', '--no-trunc']);
        assert.ok(all.split('\n').every((value) => value === '' || /^[a-f0-9]{64}$/.test(value)));
        assert.equal(all.split('\n').includes(id), false); metrics.container_absent_after_remove = 'verified';
      } catch { uncertain = true; }
    } else uncertain = true; // Lost create result is unresolved, never wildcard cleanup.
    if (channel) { channel.child.stdin.destroy(); channel.child.kill('SIGKILL'); }
    clearTimeout(watchdog); process.removeListener('SIGTERM', interrupt); process.removeListener('SIGINT', interrupt);
    if (interrupted) uncertain = true;
    metrics.teardown_duration_ms = Math.ceil(performance.now() - teardown);
    metrics.total_duration_ms = Math.ceil(performance.now() - started);
    metrics.cleanup_status = cleanupStatus({ bound: Boolean(scope), readonly: scope?.readonly === true, killed: metrics.kill_requested === 'observed',
      empty: ['empty_observed', 'kernel_scope_removed'].includes(metrics.scope_empty_before_remove),
      removed, absent: metrics.container_absent_after_remove === 'verified', uncertain });
    metrics.container_ref = id ? HASH(id) : null;
    if (id && !removed) metrics.unresolved_container_ref = HASH(id);
  }
  return Object.freeze({ ...metrics, scenario,
    ...workloadStatus({ completed: workloadOk, uncertain, cleanup: metrics.cleanup_status }) });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.ok([4, 5].includes(process.argv.length));
    const result = await runSdkTreeLab(...process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.workload_passed || result.cleanup_status !== 'verified') process.exitCode = 1;
  } catch {
    process.stdout.write('{"workload_completed":false,"workload_passed":false,"cleanup_status":"unknown","provider_calls":0,"credential_released":false,"production_qualified":false}\n');
    process.exitCode = 1;
  }
}
