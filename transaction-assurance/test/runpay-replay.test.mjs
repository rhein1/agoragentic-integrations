import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  normalizeRunpayRecord, normalizeRunpayBatch,
  RUNPAY_PROFILE_ID, RUNPAY_PROFILE_DIGEST,
} from '../src/adapters/runpay-catalog.mjs';
import { digestJson } from '../src/adapters/runpay-json.mjs';
import { runpayExitCode } from '../src/adapters/runpay-cli.mjs';

const base = path.dirname(fileURLToPath(import.meta.url));
const example = path.join(base, '../examples/runpay/2026-09-09');
const servicesRaw = () => fs.readFileSync(path.join(example, 'service-fixtures.json'), 'utf8');
const observabilityRaw = () => fs.readFileSync(path.join(example, 'observability-record.json'), 'utf8');
const servicesArray = () => JSON.parse(servicesRaw()).services;
const observabilityObj = () => JSON.parse(observabilityRaw());
const envelope = (raw, kind) => ({
  schema: 'agoragentic.runpay-catalog.v1',
  source: { provider: 'runpay', namespace: 'sandbox:runpay-issue-376', record_kind: kind, schema_revision: '2026-09-09' },
  profile_id: RUNPAY_PROFILE_ID, profile_digest: RUNPAY_PROFILE_DIGEST,
  record: { raw },
});

test('same input produces byte-identical output and digests across runs', () => {
  const first = JSON.stringify(normalizeRunpayBatch(envelope(servicesArray(), 'catalog_service')));
  const second = JSON.stringify(normalizeRunpayBatch(envelope(servicesArray(), 'catalog_service')));
  assert.equal(first, second);
  const obs1 = JSON.stringify(normalizeRunpayRecord(envelope(observabilityObj(), 'observability_record')));
  const obs2 = JSON.stringify(normalizeRunpayRecord(envelope(observabilityObj(), 'observability_record')));
  assert.equal(obs1, obs2);
  const digests = (json) => JSON.parse(json).records.map((r) => r.core.source.source_core_digest);
  assert.deepEqual(digests(first), digests(second));
});

test('key order does not change digests', () => {
  const parsed = servicesArray();
  const reversed = parsed.map((s) => Object.fromEntries(Object.entries(s).reverse()));
  const a = normalizeRunpayBatch(envelope(parsed, 'catalog_service'));
  const b = normalizeRunpayBatch(envelope(reversed, 'catalog_service'));
  const digests = (batch) => batch.records.map((r) => [r.core.source.redacted_source_hash, r.core.source.source_core_digest, r.core.identity.service_key]);
  assert.deepEqual(digests(a), digests(b));
  assert.equal(digestJson(JSON.parse(JSON.stringify(a))), digestJson(JSON.parse(JSON.stringify(b))));
});

test('exit codes follow evidence status', () => {
  const records = normalizeRunpayBatch(envelope(servicesArray(), 'catalog_service')).records;
  assert.equal(runpayExitCode(records, []), 0);
  assert.equal(runpayExitCode(records, ['unresolved']), 2);
  assert.equal(runpayExitCode(records, ['contradicted']), 0);
});

test('actual CLI import is deterministic with network and DNS disabled before imports', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'runpay-offline-'));
  try {
    const cli = path.join(base, '../bin/agora-assure.mjs');
    const loader = path.join(base, 'fixtures/runpay-no-network-preload.mjs');
    const fixture = path.join(example, 'service-fixtures.json');
    const importOnce = (out) => {
      const args = ['--import', loader, cli, 'runpay', 'import', fixture, '--out', out, '--namespace', 'sandbox:runpay-issue-376'];
      return spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, RUNPAY_API_KEY: 'RUNPAY_ENV_SECRET_CANARY' }, timeout: 15000 });
    };
    const first = importOnce(path.join(temp, 'a'));
    assert.equal(first.status, 0, first.stderr);
    const second = importOnce(path.join(temp, 'b'));
    assert.equal(second.status, 0, second.stderr);
    for (const dir of ['a', 'b']) {
      const recordsPath = path.join(temp, dir, 'runpay-records.json');
      const digestPath = path.join(temp, dir, 'runpay-records.sha256');
      assert(fs.existsSync(recordsPath) && fs.existsSync(digestPath));
      const bytes = fs.readFileSync(recordsPath);
      const expected = `sha256:${createHash('sha256').update(bytes).digest('hex')}\n`;
      assert.equal(fs.readFileSync(digestPath, 'utf8'), expected);
    }
    const aBytes = fs.readFileSync(path.join(temp, 'a', 'runpay-records.json'), 'utf8');
    const bBytes = fs.readFileSync(path.join(temp, 'b', 'runpay-records.json'), 'utf8');
    assert.equal(aBytes, bBytes);
    const batch = JSON.parse(aBytes);
    assert.equal(batch.schema, 'agoragentic.runpay-evidence-batch.v1');
    assert.equal(batch.records.length, 2);
    assert(!aBytes.includes('RUNPAY_ENV_SECRET_CANARY'));
    assert(!first.stderr.includes('RUNPAY_ENV_SECRET_CANARY'));
    // Never clobber a prior report.
    assert.equal(importOnce(path.join(temp, 'a')).status, 64);
    // --fail-on unresolved exits 2 for vendor-supplied evidence.
    const failOn = spawnSync(process.execPath,
      ['--import', loader, cli, 'runpay', 'import', fixture, '--out', path.join(temp, 'c'), '--namespace', 'sandbox:runpay-issue-376', '--fail-on', 'unresolved'],
      { encoding: 'utf8', timeout: 15000 });
    assert.equal(failOn.status, 2);
    // The catalog endpoint is provenance only: nothing in the CLI output may claim a fetch.
    assert(!aBytes.includes('railway.app'));
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
