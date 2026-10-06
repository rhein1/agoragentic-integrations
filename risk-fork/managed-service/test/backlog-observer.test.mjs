import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { sha256Ref } from '../../src/canonical.mjs';
import { createManagedBacklogObserver } from '../src/backlog-observer.mjs';
import { backlogGaugeInput, normalizeBacklogGauge } from '../src/backlog-gauge.mjs';
import { MANAGED_BACKLOG_COUNT_FIELDS } from '../src/backlog-snapshot.mjs';
import { createFixture } from './helpers.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));
function observerStore() {
  const rows = new Map(); let writes = 0;
  const store = { async readBacklogGauge({ tenant_hash }) { return rows.get(tenant_hash) ?? null; },async appendBacklogSnapshot(packet) {
    const input = backlogGaugeInput(packet,{ maxTenants: 2 }), source = packet.snapshot;
    const state = normalizeBacklogGauge({ schema: 'agoragentic.risk-fork.managed-backlog-gauge.v1',tenant_hash: input.tenantHash,
      observer_hash: input.observerHash,generation: (packet.expected_state?.generation ?? 0)+1,source_snapshot_at: source.snapshot_at,
      source_snapshot_hash: source.snapshot_hash,...Object.fromEntries(MANAGED_BACKLOG_COUNT_FIELDS.map((key) => [key,source[key]])),recorded_ms: 1,
      settings_hash: input.settingsHash,last_batch_hash: input.batchHash,coverage: 'tenant_scoped_current_snapshot',evidence_class: 'control_plane_self_attested',production_qualified: false });
    rows.set(input.tenantHash,state); writes += 1; return { persisted: true,batch_hash: input.batchHash,state };
  } };
  return { store,rows,writes: () => writes };
}
test('observer uses actual authenticated source and captures original bound methods/options', async () => {
  const f = await createFixture(), s = observerStore(), originals = [f.principal];
  const options = { controlPlane: f.controlPlane,store: s.store,auditPrincipals: originals,observerId: 'backlog-observer' };
  const observer = createManagedBacklogObserver(options);
  originals[0] = f.otherPrincipal; options.controlPlane = {}; options.store = {};
  assert.throws(() => { f.controlPlane.readCleanupRecoveryBacklog = () => { throw new Error('replacement invoked'); }; });
  // Store methods remain captured with their original receiver.
  s.store.readBacklogGauge = () => { throw new Error('replacement invoked'); };
  try { const result = await observer.runOnce(); assert.equal(result.sampled,1); assert.equal(result.failed,0); assert.equal(s.writes(),1); }
  finally { await observer.close(); }
});
test('failed or forged source reads never append synthetic zero', async () => {
  for (const behavior of ['forged','expiry','wrong_scope','lost','wrong_tenant']) {
    const f = await createFixture(), s = observerStore(); let source = f.controlPlane, principal = f.principal;
    if (behavior === 'forged') principal = Object.freeze({ ...principal });
    if (behavior === 'wrong_scope') principal = f.recoveryPrincipal;
    if (behavior === 'expiry') f.setNow('2026-09-06T00:00:00.000Z');
    if (behavior === 'lost') source = { async readCleanupRecoveryBacklog() { throw new Error('source unavailable'); } };
    if (behavior === 'wrong_tenant') source = { readCleanupRecoveryBacklog: () => f.controlPlane.readCleanupRecoveryBacklog(f.otherPrincipal) };
    if (behavior === 'wrong_scope') { assert.throws(() => createManagedBacklogObserver({ controlPlane: source,store: s.store,auditPrincipals: [principal],observerId: behavior })); continue; }
    const observer = createManagedBacklogObserver({ controlPlane: source,store: s.store,auditPrincipals: [principal],observerId: behavior });
    try { assert.equal((await observer.runOnce()).failed,1); assert.equal(s.writes(),0); }
    finally { await observer.close(); }
  }
});
test('timeout retains actual tenant slot, permits another tenant and rejects late append', async () => {
  const f = await createFixture(), s = observerStore(); let release;
  const source = { readCleanupRecoveryBacklog(principal) { return principal === f.principal ? new Promise((resolve) => { release = resolve; }) : f.controlPlane.readCleanupRecoveryBacklog(principal); } };
  const observer = createManagedBacklogObserver({ controlPlane: source,store: s.store,auditPrincipals: [f.principal,f.otherPrincipal],observerId: 'hung',timeoutMs: 50,maxTenantsPerTick: 1 });
  try {
    const first = observer.runOnce(); assert.equal(observer.runOnce(),first);
    assert.equal((await first).timed_out,1); assert.equal(observer.health().in_flight,1);
    assert.equal((await observer.runOnce()).sampled,1); assert.equal(s.writes(),1);
    release(await f.controlPlane.readCleanupRecoveryBacklog(f.principal)); await tick(); await tick();
    assert.equal(observer.health().in_flight,0); assert.equal(s.writes(),1); assert.equal(observer.health().sampled,1);
  } finally { await observer.close(); }
});
test('shutdown aborts a pending read and never appends its late result', async () => {
  const f = await createFixture(), s = observerStore(); let release;
  const observer = createManagedBacklogObserver({ controlPlane: { readCleanupRecoveryBacklog: () => new Promise((resolve) => { release = resolve; }) },
    store: s.store,auditPrincipals: [f.principal],observerId: 'close',timeoutMs: 50 });
  const pending = observer.runOnce(); await tick();
  assert.equal((await observer.close({ timeoutMs: 50 })).settled,false);
  release(await f.controlPlane.readCleanupRecoveryBacklog(f.principal)); await pending; await tick();
  assert.equal(s.writes(),0); assert.equal((await observer.close()).settled,true);
  assert.throws(() => observer.start()); assert.equal((await observer.runOnce()).closed,true);
});
test('observer rejects false persistence acknowledgement and wrong tenant custody', async () => {
  const f = await createFixture();
  for (const stage of ['read','append','count','batch','generation']) {
    const s = observerStore();
    if (stage === 'read') s.store.readBacklogGauge = () => ({ invalid: true });
    else if (stage === 'append') s.store.appendBacklogSnapshot = () => ({ persisted: false,batch_hash: sha256Ref('not-confirmed'),state: null });
    else {
      const append = s.store.appendBacklogSnapshot.bind(s.store);
      s.store.appendBacklogSnapshot = async (packet) => {
        const result = await append(packet);
        if (stage === 'batch') return { ...result,batch_hash: sha256Ref('wrong batch') };
        return { ...result,state: { ...result.state,...(stage === 'count' ? { cleanup_pending_count: 99 } : { generation: 2 }) } };
      };
    }
    const observer = createManagedBacklogObserver({ controlPlane: f.controlPlane,store: s.store,auditPrincipals: [f.principal],observerId: stage });
    try { assert.equal((await observer.runOnce()).failed,1); assert.equal(observer.health().sampled,0); }
    finally { await observer.close(); }
  }
});
test('awaited source timeout owns a timer and idle polling does not hold a process open', () => {
  const observerUrl = new URL('../src/backlog-observer.mjs',import.meta.url).href;
  const code = `import { createManagedBacklogObserver } from ${JSON.stringify(observerUrl)};
    const o=createManagedBacklogObserver({controlPlane:{readCleanupRecoveryBacklog:()=>new Promise(()=>{})},
      store:{readBacklogGauge:async()=>null,appendBacklogSnapshot:async()=>{throw Error('late');}},
      auditPrincipals:[Object.freeze({tenant_id:'tenant_alpha',scopes:Object.freeze(['audit:read'])})],observerId:'process',timeoutMs:50});
    const h=await o.runOnce(); if(h.timed_out!==1)process.exit(2);o.start();`;
  const result = spawnSync(process.execPath,['--input-type=module','-e',code],{ encoding: 'utf8',timeout: 5000,windowsHide: true });
  assert.equal(result.status,0,result.stderr); assert.equal(result.error,undefined);
});
