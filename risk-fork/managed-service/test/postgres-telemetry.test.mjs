import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { rootCertificates } from 'node:tls';
import pg from 'pg';
import { createManagedTelemetryEvent } from '../src/telemetry-event.mjs';
import { createManagedTelemetryDrainer } from '../src/telemetry-drainer.mjs';
import { createPostgresManagedTelemetryStore } from '../src/postgres-telemetry-store.mjs';
import { migratePostgresManagedTelemetry } from '../src/postgres-telemetry-migrator.mjs';
import { prunePostgresManagedTelemetry } from '../src/postgres-telemetry-maintenance.mjs';
import { verifyPostgresManagedTelemetryAttestation } from '../src/postgres-telemetry-attestation.mjs';

const connectionString = process.env.RISK_FORK_MANAGED_TEST_POSTGRES_URL;
if (!connectionString && process.env.RISK_FORK_MANAGED_REQUIRE_POSTGRES_TESTS === '1') throw new Error('Mandatory disposable PostgreSQL telemetry tests require a database');
const skip = !connectionString;
if (connectionString) {
  const url = new URL(connectionString);
  if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.pathname !== '/risk_fork_managed_test'
    || process.env.RISK_FORK_MANAGED_TEST_CONFIRM_DISPOSABLE !== 'YES_DELETE_DATA') throw new Error('Telemetry tests require the explicit disposable loopback database');
}
const qid = (s) => { assert.match(s,/^[a-z_][a-z0-9_]*$/); return `"${s}"`; };
const token = () => randomBytes(32).toString('base64url');
const limits = Object.freeze({ maxEvents: 50,maxEventsPerTenant: 30,leaseMs: 10_000,retryMs: 200,retentionMs: 1000 });
const event = (tenant = 'a') => createManagedTelemetryEvent({ event: 'rate_denied',route_class: 'admission',status: 429,outcome: 'rate_limited',
  duration_ms: 8,tenant_hash: `sha256:${tenant.repeat(64)}`,key_hash: `sha256:${'b'.repeat(64)}` });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve,ms));
async function fixture(run, override = {}) {
  const schemaName = `telemetry_${randomUUID().replaceAll('-','')}`, s = qid(schemaName);
  const pool = new pg.Pool({ connectionString,max: 6 }); const stores = [];
  const options = { pool,schemaName,limits: { ...limits,...override },requireTls: false,disposableDb: true };
  try {
    const migrated = await migratePostgresManagedTelemetry(options);
    const a = await createPostgresManagedTelemetryStore(options), b = await createPostgresManagedTelemetryStore(options); stores.push(a,b);
    await run({ pool,s,options,a,b,stores,migrated });
  } finally {
    const errors = [], cleanup = async (operation) => { try { await operation(); } catch (error) { errors.push(error); } };
    for (const store of stores) await cleanup(() => store.close());
    await cleanup(() => pool.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`));
    await cleanup(async () => assert.equal((await pool.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[schemaName])).rowCount,0));
    await cleanup(() => pool.end());
    if (errors.length) throw new AggregateError(errors,'Disposable telemetry schema cleanup failed');
  }
}
function wrapper(pool, intercept) { return { async connect() {
  const client = await pool.connect(); return { release: () => client.release(),query: (sql,params) => intercept(client,sql,params) };
} }; }

test('telemetry source rejects production, ambiguous TLS provenance and ignored runtime options before I/O', async () => {
  const pool = { async connect() { throw new Error('must not connect'); } };
  await assert.rejects(migratePostgresManagedTelemetry({ pool,limits,requireTls: false,disposableDb: true,expectedOwner: 'owner' }),/runtime-only/);
  await assert.rejects(createPostgresManagedTelemetryStore({ pool,limits,requireTls: true }),/Injected pools/);
  await assert.rejects(createPostgresManagedTelemetryStore({ pool,limits,requireTls: false }),/disposableDb/);
  await assert.rejects(createPostgresManagedTelemetryStore({ pool,limits,requireTls: false,disposableDb: true,deploymentMode: 'production' }),{ code: 'TELEMETRY_NOT_QUALIFIED' });
});

test('telemetry PostgreSQL duplicate-first capacity is atomic across two instances', { skip,timeout: 60_000 }, async () => {
  await fixture(async ({ a,b,pool,s }) => {
    const events = Array.from({ length: 8 },(_,i) => event(i < 4 ? 'a' : 'c'));
    const results = await Promise.allSettled(events.map((e,i) => (i % 2 ? a : b).append(e)));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length,3);
    assert.equal(results.filter((r) => r.status === 'rejected' && r.reason.code === 'TELEMETRY_CAPACITY').length,5);
    const counts = (await pool.query(`SELECT tenant_hash,count(*)::integer AS count FROM ${s}.telemetry_events GROUP BY tenant_hash`)).rows;
    assert.equal(counts.reduce((n,r) => n+r.count,0),3); assert.equal(counts.every((r) => r.count <= 2),true);
    const index = results.findIndex((r) => r.status === 'fulfilled'), kept = events[index];
    await Promise.all(Array.from({ length: 6 },(_,i) => (i % 2 ? a : b).append(kept)));
    assert.equal((await a.stats()).pending,3);
    await assert.rejects(a.append({ ...kept,duration_ms: 9 }),{ code: 'TELEMETRY_EVENT_CONFLICT' });
    assert.equal((await b.stats()).pending,3);
  },{ maxEvents: 3,maxEventsPerTenant: 2 });
});

test('unknown append commit returns no success; exact event replay after restart converges', { skip,timeout: 60_000 }, async () => {
  await fixture(async ({ a,pool,s,options,stores }) => {
    let armed = false;
    const unreliable = wrapper(pool,async (client,sql,params) => {
      const result = await client.query(sql,params);
      if (armed && sql === 'COMMIT') { armed = false; throw new Error('synthetic lost commit reply SECRET-DSN'); }
      return result;
    });
    const store = await createPostgresManagedTelemetryStore({ ...options,pool: unreliable }); stores.push(store);
    const packet = event(); armed = true;
    await assert.rejects(store.append(packet),{ code: 'TELEMETRY_UNAVAILABLE' });
    assert.equal((await pool.query(`SELECT event_ref FROM ${s}.telemetry_events`)).rowCount,1);
    await store.close(); const restarted = await createPostgresManagedTelemetryStore(options); stores.push(restarted);
    assert.deepEqual(await restarted.append(packet),{ event_ref: packet.event_ref,persisted: true });
    assert.equal((await a.stats()).pending,1);
  });
});

test('claims replay exactly; takeover fences stale acknowledgements and lost ack converges', { skip,timeout: 60_000 }, async () => {
  await fixture(async ({ a,b,pool,s,options,stores }) => {
    const e = event(), firstToken = token(), nextToken = token(); await a.append(e);
    const first = await a.claim({ claimToken: firstToken });
    assert.deepEqual(await b.claim({ claimToken: firstToken }),first);
    assert.equal(await b.claim({ claimToken: token() }),null);
    await pool.query(`UPDATE ${s}.telemetry_events SET lease_expires_ms=floor(extract(epoch FROM clock_timestamp())*1000)::bigint-1 WHERE event_ref=$1`,[e.event_ref]);
    await assert.rejects(a.claim({ claimToken: firstToken }),{ code: 'TELEMETRY_CLAIM_EXPIRED' });
    const next = await b.claim({ claimToken: nextToken }); assert.equal(next.generation,first.generation+1);
    const ack = { event_ref: e.event_ref,delivered: true };
    await assert.rejects(a.acknowledge({ event_ref: e.event_ref,generation: first.generation,claimToken: firstToken,acknowledgement: ack }),{ code: 'TELEMETRY_STALE_CLAIM' });
    let armed = false;
    const unreliable = wrapper(pool,async (client,sql,params) => {
      const result = await client.query(sql,params); if (armed && sql === 'COMMIT') { armed = false; throw new Error('lost ack commit'); } return result;
    });
    const c = await createPostgresManagedTelemetryStore({ ...options,pool: unreliable }); stores.push(c); armed = true;
    const input = { event_ref: e.event_ref,generation: next.generation,claimToken: nextToken,acknowledgement: ack };
    await assert.rejects(c.acknowledge(input),{ code: 'TELEMETRY_UNAVAILABLE' });
    assert.deepEqual(await b.acknowledge(input),{ event_ref: e.event_ref,acknowledged: true });
    assert.equal(await a.claim({ claimToken: nextToken }),null); assert.equal((await a.stats()).acked,1);
    const raw = JSON.stringify((await pool.query(`SELECT * FROM ${s}.telemetry_events`)).rows);
    assert.equal(raw.includes(firstToken),false); assert.equal(raw.includes(nextToken),false);
  });
});

test('offline delivery retry/restart/backoff preserves event reference and exhausted obligations', { skip,timeout: 60_000 }, async () => {
  await fixture(async ({ a,b,pool,s }) => {
    const e = event(); await a.append(e); const seen = new Set(); let failure = true;
    const deliver = async (packet) => { if (failure) throw new Error('SECRET-ERROR'); seen.add(packet.event_ref); return { event_ref: packet.event_ref,delivered: true }; };
    const first = createManagedTelemetryDrainer({ store: a,deliver,maxBatch: 1 });
    assert.equal((await first.runOnce()).failed,1); assert.equal((await a.stats()).pending,1); await first.close();
    assert.equal(await b.claim({ claimToken: token() }),null);
    await pool.query(`UPDATE ${s}.telemetry_events SET next_attempt_ms=0 WHERE event_ref=$1`,[e.event_ref]);
    failure = false; const second = createManagedTelemetryDrainer({ store: b,deliver,maxBatch: 1 });
    assert.equal((await second.runOnce()).delivered,1); await second.close(); assert.deepEqual([...seen],[e.event_ref]);
    const exhausted = event(); await a.append(exhausted);
    await pool.query(`UPDATE ${s}.telemetry_events SET attempts=1000000 WHERE event_ref=$1`,[exhausted.event_ref]);
    const healthy = event(); await a.append(healthy);
    const claim = await b.claim({ claimToken: token() }); assert.equal(claim.event.event_ref,healthy.event_ref);
    assert.equal((await a.stats()).exhausted,1); assert.equal((await pool.query(`SELECT state FROM ${s}.telemetry_events WHERE event_ref=$1`,[exhausted.event_ref])).rows[0].state,'pending');
  });
});

test('DB-time lease expiry permits one new generation and fences the old sink acknowledgement and retry', { skip,timeout: 60_000 }, async () => {
  await fixture(async ({ a,b,pool,s }) => {
    const packet = event(), oldToken = token(), seen = new Set(); let calls = 0, applied = 0;
    const deliver = async (value) => {
      calls += 1; if (!seen.has(value.event_ref)) { seen.add(value.event_ref); applied += 1; }
      return { event_ref: value.event_ref,delivered: true };
    };
    await a.append(packet); const old = await a.claim({ claimToken: oldToken });
    const oldAck = await deliver(old.event); // The first observer exits after delivery, before acknowledgement.
    assert.equal(await b.claim({ claimToken: token() }),null);
    const remaining = Number((await pool.query(`SELECT lease_expires_ms-floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS remaining FROM ${s}.telemetry_events WHERE event_ref=$1`,[packet.event_ref])).rows[0].remaining);
    if (remaining > 0) await pause(remaining+25);
    assert.equal((await pool.query(`SELECT lease_expires_ms <= floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS expired FROM ${s}.telemetry_events WHERE event_ref=$1`,[packet.event_ref])).rows[0].expired,true);
    const next = createManagedTelemetryDrainer({ store: b,deliver,maxBatch: 1 });
    try { assert.equal((await next.runOnce()).delivered,1); } finally { await next.close(); }
    assert.equal(calls,2); assert.equal(applied,1); assert.deepEqual([...seen],[packet.event_ref]);
    const row = (await pool.query(`SELECT state,generation,attempts FROM ${s}.telemetry_events WHERE event_ref=$1`,[packet.event_ref])).rows[0];
    assert.equal(row.state,'acked'); assert.equal(Number(row.generation),old.generation+1); assert.equal(row.attempts,2);
    await assert.rejects(a.acknowledge({ event_ref: packet.event_ref,generation: old.generation,claimToken: oldToken,acknowledgement: oldAck }),{ code: 'TELEMETRY_STALE_CLAIM' });
    await assert.rejects(a.retry({ event_ref: packet.event_ref,generation: old.generation,claimToken: oldToken,errorCode: 'SINK_UNAVAILABLE' }),{ code: 'TELEMETRY_STALE_CLAIM' });
    assert.equal((await b.stats()).acked,1);
  },{ leaseMs: 3000 });
});

for (const phase of ['claim','acknowledge','retry']) {
  test(`bounded drainer preserves an unknown PostgreSQL ${phase} commit for independent recovery`, { skip,timeout: 60_000 }, async () => {
    await fixture(async ({ a,b,pool,s,options,stores }) => {
      const packet = event(), seen = new Set(), calls = { claim: 0,acknowledge: 0,retry: 0,deliver: 0 };
      let armed = false, entered, release, phaseWork, originalToken, originalRequest;
      const ready = new Promise((resolve) => { entered = resolve; });
      const gate = new Promise((resolve) => { release = resolve; });
      const delayed = wrapper(pool,async (client,sql,params) => {
        const result = await client.query(sql,params);
        if (armed && sql === 'COMMIT') { armed = false; entered(); await gate; }
        return result;
      });
      const store = await createPostgresManagedTelemetryStore({ ...options,pool: delayed }); stores.push(store);
      await a.append(packet);
      const methods = Object.fromEntries(['claim','acknowledge','retry'].map((method) => [method,(request) => {
        calls[method] += 1;
        if (method === 'claim') originalToken = request.claimToken;
        if (method === phase) { armed = true; originalRequest = request; }
        const work = store[method](request);
        if (method === phase) phaseWork = work;
        return work;
      }]));
      const deliver = async (value) => {
        calls.deliver += 1;
        if (phase === 'retry' && calls.deliver === 1) throw new Error('SECRET-SINK');
        seen.add(value.event_ref); return { event_ref: value.event_ref,delivered: true };
      };
      const first = createManagedTelemetryDrainer({ store: methods,deliver,storeTimeoutMs: 1000,maxBatch: 1 });
      let next;
      try {
        const pending = first.runOnce();
        await Promise.race([ready,pending.then(() => { throw new Error('Store failed before the synthetic lost commit response'); })]);
        const result = await pending;
        assert.equal(result.store_timed_out,1); assert.equal(result.store_in_flight,true);
        assert.equal(result.failed,1); assert.equal(result.delivered,0); assert.equal(result.timed_out,0);
        assert.equal(originalRequest.signal.aborted,true);
        const before = { ...calls };
        assert.equal((await first.runOnce()).processed,0); assert.deepEqual(calls,before);
        assert.equal((await first.close({ timeoutMs: 50 })).settled,false);
        const committed = (await pool.query(`SELECT state,generation,attempts,lease_expires_ms,next_attempt_ms FROM ${s}.telemetry_events WHERE event_ref=$1`,[packet.event_ref])).rows[0];
        assert.equal(committed.state,phase === 'claim' ? 'claimed' : phase === 'acknowledge' ? 'acked' : 'pending');
        assert.equal(Number(committed.generation),1); assert.equal(committed.attempts,1);
        release(); await Promise.allSettled([phaseWork]); await pause(0);
        assert.equal(first.health().store_in_flight,false); assert.equal(first.health().delivered,0);
        assert.deepEqual(calls,before); assert.equal((await first.close()).settled,true);
        next = createManagedTelemetryDrainer({ store: b,deliver,maxBatch: 1 });
        if (phase === 'acknowledge') {
          assert.equal((await next.runOnce()).processed,0); assert.equal(calls.deliver,1);
          const { signal,...exactAck } = originalRequest;
          assert.deepEqual(await b.acknowledge(exactAck),{ event_ref: packet.event_ref,acknowledged: true });
        } else {
          const due = phase === 'claim' ? 'lease_expires_ms' : 'next_attempt_ms';
          const remaining = Number((await pool.query(`SELECT ${due}-floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS remaining FROM ${s}.telemetry_events WHERE event_ref=$1`,[packet.event_ref])).rows[0].remaining);
          if (remaining > 0) await pause(remaining+25);
          assert.equal((await next.runOnce()).delivered,1);
          const after = (await pool.query(`SELECT state,generation,attempts FROM ${s}.telemetry_events WHERE event_ref=$1`,[packet.event_ref])).rows[0];
          assert.equal(after.state,'acked'); assert.equal(Number(after.generation),2); assert.equal(after.attempts,2);
          const stale = { event_ref: packet.event_ref,generation: 1,claimToken: originalToken };
          await assert.rejects(a.acknowledge({ ...stale,acknowledgement: { event_ref: packet.event_ref,delivered: true } }),{ code: 'TELEMETRY_STALE_CLAIM' });
          await assert.rejects(a.retry({ ...stale,errorCode: 'SINK_UNAVAILABLE' }),{ code: 'TELEMETRY_STALE_CLAIM' });
          assert.equal(calls.deliver,phase === 'claim' ? 1 : 2);
        }
        assert.deepEqual([...seen],[packet.event_ref]); assert.equal((await a.stats()).acked,1);
        assert.equal(JSON.stringify(result).includes('SECRET'),false);
      } finally {
        release(); if (phaseWork) await Promise.allSettled([phaseWork]);
        await first.close(); await next?.close();
      }
    },{ leaseMs: 3000 });
  });
}

test('corrupt payload hash fails duplicate replay and drainer claim without self-repair', { skip,timeout: 60_000 }, async () => {
  await fixture(async ({ a,b,pool,s }) => {
    const packet = event(); await a.append(packet);
    await pool.query(`UPDATE ${s}.telemetry_events SET duration_ms=duration_ms+1 WHERE event_ref=$1`,[packet.event_ref]);
    const before = JSON.stringify((await pool.query(`SELECT * FROM ${s}.telemetry_events WHERE event_ref=$1`,[packet.event_ref])).rows);
    await assert.rejects(a.append(packet),{ code: 'TELEMETRY_UNAVAILABLE' });
    await assert.rejects(b.claim({ claimToken: token() }),{ code: 'TELEMETRY_UNAVAILABLE' });
    let sent = 0;
    const drainer = createManagedTelemetryDrainer({ store: b,deliver: async () => { sent += 1; throw new Error('must not deliver corrupt data'); } });
    try { const result = await drainer.runOnce(); assert.equal(result.failed,1); assert.equal(result.delivered,0); }
    finally { await drainer.close(); }
    assert.equal(sent,0); assert.equal((await a.stats()).pending,1);
    assert.equal(JSON.stringify((await pool.query(`SELECT * FROM ${s}.telemetry_events WHERE event_ref=$1`,[packet.event_ref])).rows),before);
  });
});

test('clock/config/ledger/catalog drift fails closed without touching payloads or self-repair', { skip,timeout: 60_000 }, async () => {
  await fixture(async ({ a,b,pool,s,options,migrated }) => {
    const e = event(); await a.append(e);
    for (const [change,restore] of [
      [`UPDATE ${s}.telemetry_clock SET last_seen_ms=9007199254740991`,`UPDATE ${s}.telemetry_clock SET last_seen_ms=0`],
      [`UPDATE ${s}.telemetry_settings SET max_events=max_events+1`,`UPDATE ${s}.telemetry_settings SET max_events=max_events-1`],
      [`UPDATE ${s}.telemetry_schema_migrations SET migration_hash='sha256:${'0'.repeat(64)}'`,`UPDATE ${s}.telemetry_schema_migrations SET migration_hash='${migrated.migration_hash}'`],
      [`CREATE INDEX telemetry_extra ON ${s}.telemetry_events (attempts)`,`DROP INDEX ${s}.telemetry_extra`],
      [`ALTER TABLE ${s}.telemetry_events ALTER state SET DEFAULT 'claimed'`,`ALTER TABLE ${s}.telemetry_events ALTER state SET DEFAULT 'pending'`],
      [`ALTER TABLE ${s}.telemetry_events ENABLE ROW LEVEL SECURITY`,`ALTER TABLE ${s}.telemetry_events DISABLE ROW LEVEL SECURITY`],
      [`CREATE DOMAIN ${s}.extra_type AS text`,`DROP DOMAIN ${s}.extra_type`],
    ]) {
      const before = JSON.stringify((await pool.query(`SELECT * FROM ${s}.telemetry_events`)).rows);
      await pool.query(change);
      try {
        await assert.rejects(a.append(event()),{ code: 'TELEMETRY_UNAVAILABLE' },change);
        await assert.rejects(b.claim({ claimToken: token() }),{ code: 'TELEMETRY_UNAVAILABLE' },change);
        await assert.rejects(createPostgresManagedTelemetryStore(options),{ code: 'TELEMETRY_UNAVAILABLE' },change);
        assert.equal(JSON.stringify((await pool.query(`SELECT * FROM ${s}.telemetry_events`)).rows),before);
      } finally { await pool.query(restore); }
    }
    await a.initialize();
  });
});

test('aborted lock wait/late commit never reports append success and failed SQL rolls back', { skip,timeout: 60_000 }, async () => {
  await fixture(async ({ a,pool,s,options,stores }) => {
    const blocker = await pool.connect(); const abort = new AbortController(); let waited, waitingEnabled = false;
    const ready = new Promise((resolve) => { waited = resolve; });
    const waiting = wrapper(pool,async (client,sql,params) => { if (waitingEnabled && sql.includes('telemetry_clock WHERE singleton=true FOR UPDATE')) waited(); return client.query(sql,params); });
    const store = await createPostgresManagedTelemetryStore({ ...options,pool: waiting }); stores.push(store);
    try {
      await blocker.query('BEGIN'); await blocker.query(`SELECT * FROM ${s}.telemetry_clock FOR UPDATE`);
      waitingEnabled = true;
      const packet = event(), pending = store.append(packet,{ signal: abort.signal }); const rejection = assert.rejects(pending,{ code: 'REQUEST_TIMEOUT' });
      await ready; abort.abort(); await blocker.query('ROLLBACK'); await rejection;
      assert.equal((await a.stats()).pending,0);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); }
    const packet = event(); const lateAbort = new AbortController(); let armed = false;
    const late = wrapper(pool,async (client,sql,params) => { const result = await client.query(sql,params); if (armed && sql === 'COMMIT') { armed = false; lateAbort.abort(); } return result; });
    const lateStore = await createPostgresManagedTelemetryStore({ ...options,pool: late }); stores.push(lateStore); armed = true;
    await assert.rejects(lateStore.append(packet,{ signal: lateAbort.signal }),{ code: 'REQUEST_TIMEOUT' });
    assert.equal((await a.stats()).pending,1); assert.deepEqual(await a.append(packet),{ event_ref: packet.event_ref,persisted: true });
    const broken = wrapper(pool,async (client,sql,params) => sql.startsWith(`INSERT INTO ${s}.telemetry_events`) ? client.query('SELECT 1/0') : client.query(sql,params));
    const brokenStore = await createPostgresManagedTelemetryStore({ ...options,pool: broken }); stores.push(brokenStore);
    await assert.rejects(brokenStore.append(event()),{ code: 'TELEMETRY_UNAVAILABLE' }); assert.equal((await a.stats()).pending,1);
  });
});

test('telemetry CA TLS factory is verified; wrong CA and supplied pool cannot launder provenance', { skip,timeout: 60_000 }, async () => {
  const ca = process.env.RISK_FORK_TEST_POSTGRES_TLS_CA;
  assert.equal(typeof ca,'string','mandatory telemetry lab must provide CA TLS coverage');
  await fixture(async ({ options,a }) => {
    const tlsStore = await createPostgresManagedTelemetryStore({ connectionString,schemaName: options.schemaName,limits,requireTls: true,tls: { ca } });
    try { assert.equal((await tlsStore.initialize()).exact_catalog_verified,true); await tlsStore.append(event()); assert.equal((await a.stats()).pending,1); }
    finally { await tlsStore.close(); }
    assert.match(rootCertificates[0],/BEGIN CERTIFICATE/);
    await assert.rejects(createPostgresManagedTelemetryStore({ connectionString,schemaName: options.schemaName,limits,requireTls: true,
      tls: { ca: rootCertificates[0] } }),{ code: 'TELEMETRY_UNAVAILABLE' });
    await assert.rejects(createPostgresManagedTelemetryStore({ connectionString,schemaName: options.schemaName,limits,requireTls: true,
      tls: { ca,servername: 'localhost' } }),{ code: 'POSTGRES_AUTHORITY_TLS_SERVERNAME_OVERRIDE_FORBIDDEN' });
  });
});

test('dedicated runtime has immutable payloads and exact grants; retention is separate owner-only', { skip,timeout: 90_000 }, async () => {
  const suffix = randomUUID().replaceAll('-','').slice(0,16), db = `telemetry_role_${suffix}`, owner = `telemetry_owner_${suffix}`, runtime = `telemetry_runtime_${suffix}`, schemaName = `telemetry_${suffix}`;
  const root = new pg.Pool({ connectionString }), url = new URL(connectionString); url.pathname = `/${db}`;
  const admin = new pg.Pool({ connectionString: url.toString() }); let created = false, ownerPool, runtimePool, store;
  const password = `disposable-${randomUUID()}`;
  try {
    await root.query(`CREATE DATABASE ${qid(db)}`); created = true;
    await admin.query(`CREATE ROLE ${qid(owner)} LOGIN NOINHERIT PASSWORD '${password}'`);
    await admin.query(`CREATE ROLE ${qid(runtime)} LOGIN NOINHERIT PASSWORD '${password}'`);
    const source = await readFile(new URL('../ops/postgres/telemetry-roles.sql.template',import.meta.url),'utf8');
    const template = source.replaceAll('__TELEMETRY_DATABASE__',qid(db)).replaceAll('__TELEMETRY_SCHEMA__',qid(schemaName))
      .replaceAll('__TELEMETRY_MIGRATOR__',qid(owner)).replaceAll('__TELEMETRY_RUNTIME__',qid(runtime));
    const [bootstrap,grants] = template.split('-- Dedicated migrator AFTER migratePostgresManagedTelemetry:'); assert.equal(typeof grants,'string');
    await admin.query(bootstrap); url.username = owner; url.password = password; ownerPool = new pg.Pool({ connectionString: url.toString() });
    const base = { schemaName,limits,requireTls: false,disposableDb: true };
    await migratePostgresManagedTelemetry({ ...base,pool: ownerPool }); await ownerPool.query(grants);
    url.username = runtime; runtimePool = new pg.Pool({ connectionString: url.toString() });
    store = await createPostgresManagedTelemetryStore({ ...base,pool: runtimePool,expectedOwner: owner });
    assert.equal((await store.initialize()).runtime_privileges_verified,true);
    const s = qid(schemaName), r = qid(runtime); const e = event(); await store.append(e);
    for (const sql of [`UPDATE ${s}.telemetry_events SET event='policy_error'`,`DELETE FROM ${s}.telemetry_events`,
      `UPDATE ${s}.telemetry_settings SET max_events=100`,`DELETE FROM ${s}.telemetry_schema_migrations`,
      `TRUNCATE ${s}.telemetry_events`,`CREATE TABLE ${s}.forbidden (id integer)`]) await assert.rejects(runtimePool.query(sql),{ code: '42501' });
    const claimedToken = token(), c = await store.claim({ claimToken: claimedToken });
    await store.acknowledge({ event_ref: e.event_ref,generation: c.generation,claimToken: claimedToken,acknowledgement: { event_ref: e.event_ref,delivered: true } });
    const pending = event(); await store.append(pending);
    const claimed = event(); await store.append(claimed); await store.claim({ claimToken: token() });
    await ownerPool.query(`UPDATE ${s}.telemetry_events SET acknowledged_ms=0 WHERE state='acked'`);
    await assert.rejects(prunePostgresManagedTelemetry({ ...base,pool: runtimePool,expectedOwner: owner }),{ code: 'TELEMETRY_RETENTION_FAILED' });
    assert.equal((await prunePostgresManagedTelemetry({ ...base,pool: ownerPool,expectedOwner: owner,maxDelete: 1 })).removed,1);
    const retained = (await ownerPool.query(`SELECT state FROM ${s}.telemetry_events ORDER BY state`)).rows;
    assert.deepEqual(retained.map((row) => row.state),['claimed','pending']);
    for (const [change,restore] of [
      [`GRANT UPDATE (event_hash) ON ${s}.telemetry_events TO ${r}`,`REVOKE UPDATE (event_hash) ON ${s}.telemetry_events FROM ${r}`],
      [`GRANT INSERT ON ${s}.telemetry_events TO ${r}`,`REVOKE INSERT ON ${s}.telemetry_events FROM ${r}`],
      [`GRANT SELECT ON ${s}.telemetry_events TO PUBLIC`,`REVOKE SELECT ON ${s}.telemetry_events FROM PUBLIC`],
      [`GRANT TEMPORARY ON DATABASE ${qid(db)} TO ${r}`,`REVOKE TEMPORARY ON DATABASE ${qid(db)} FROM ${r}`],
      [`ALTER ROLE ${r} INHERIT`,`ALTER ROLE ${r} NOINHERIT`],
      [`ALTER DEFAULT PRIVILEGES FOR ROLE ${qid(owner)} GRANT EXECUTE ON FUNCTIONS TO PUBLIC`,`ALTER DEFAULT PRIVILEGES FOR ROLE ${qid(owner)} REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`],
    ]) {
      const before = JSON.stringify((await ownerPool.query(`SELECT * FROM ${s}.telemetry_events ORDER BY event_ref`)).rows);
      await admin.query(change);
      try { await assert.rejects(store.append(event()),{ code: 'TELEMETRY_UNAVAILABLE' }); assert.equal(JSON.stringify((await ownerPool.query(`SELECT * FROM ${s}.telemetry_events ORDER BY event_ref`)).rows),before); }
      finally { await admin.query(restore); await ownerPool.query(grants); }
      await store.initialize();
    }
    const client = await runtimePool.connect();
    try { await assert.rejects(verifyPostgresManagedTelemetryAttestation(client,{ schemaName,expectedOwner: runtime }),{ code: 'TELEMETRY_POSTGRES_ATTESTATION_FAILED' }); }
    finally { client.release(); }
  } finally {
    const errors = [], cleanup = async (operation) => { try { await operation(); } catch (error) { errors.push(error); } };
    await cleanup(() => store?.close()); await cleanup(() => runtimePool?.end());
    await cleanup(() => ownerPool?.end()); await cleanup(() => admin.end());
    if (created) {
      await cleanup(async () => {
        let drained = false;
        for (let i = 0; i < 100; i += 1) { if ((await root.query('SELECT count(*)::integer AS count FROM pg_stat_activity WHERE datname=$1',[db])).rows[0].count === 0) { drained = true; break; } await pause(25); }
        assert.equal(drained,true); await root.query(`DROP DATABASE ${qid(db)}`);
      });
    }
    await cleanup(() => root.query(`DROP ROLE IF EXISTS ${qid(runtime)}`)); await cleanup(() => root.query(`DROP ROLE IF EXISTS ${qid(owner)}`));
    await cleanup(async () => assert.equal((await root.query('SELECT 1 FROM pg_database WHERE datname=$1',[db])).rowCount,0));
    await cleanup(async () => assert.equal((await root.query('SELECT 1 FROM pg_roles WHERE rolname=ANY($1::text[])',[[owner,runtime]])).rowCount,0));
    await cleanup(() => root.end());
    if (errors.length) throw new AggregateError(errors,'Disposable telemetry database/role cleanup failed');
  }
});
