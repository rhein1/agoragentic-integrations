import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createFlightRecorderServer,
  loadRecorderRecords,
  writeRecorderRecord,
} from '../src/flight-recorder.mjs';
import { createDemoEngine } from '../src/demo-engine.mjs';
import {
  initializeOwnedDemoRoot,
  redactDemoValue,
  scanDemoSecrets,
} from '../src/security.mjs';

function replayRecords(server) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: server.port,
      path: '/api/records',
      method: 'GET',
      headers: { authorization: `Bearer ${server.token}` },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        try {
          assert.equal(response.statusCode, 200);
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')).records);
        } catch (error) {
          reject(error);
        }
      });
    });
    request.once('error', reject);
    request.end();
  });
}

test('private absolute paths in values and object keys are rejected and cannot persist or replay', async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-private-key-recorder-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const handle = await initializeOwnedDemoRoot(path.join(parent, 'owned'));
  const engine = createDemoEngine({ rootDirectory: handle.root_path });
  const privatePaths = [
    String.raw`C:\Users\Alice\private.txt`,
    '/home/alice/private.txt',
    '/tmp/private-demo/private.txt',
    '/opt/private-demo/private.txt',
    String.raw`\\server\share\private.txt`,
    'file:///C:/Users/Alice/private.txt',
  ];
  const runIds = [];

  for (const [index, privatePath] of privatePaths.entries()) {
    const baseResult = await engine.run('low-read-only');
    const runId = baseResult.run_id;
    runIds.push(runId);
    const input = {
      ...baseResult,
      safe_relative_key: 'preserved',
      private_location: privatePath,
      '[REDACTED_FIELD_1]': 'ordinary-key-preserved',
      [privatePath]: 'private-key-associated-value',
    };
    const scan = scanDemoSecrets(input);
    assert.equal(scan.safe, false);
    assert.ok(scan.findings.some((finding) => (
      finding.code === 'private_absolute_path'
      && finding.path === '$.<redacted-key>'
    )));
    assert.equal(JSON.stringify(scan).includes(privatePath), false);

    const redacted = redactDemoValue(input);
    assert.equal(Object.hasOwn(redacted, privatePath), false);
    assert.equal(redacted.safe_relative_key, 'preserved');
    assert.equal(redacted.private_location, '[REDACTED_PRIVATE_PATH]');
    assert.equal(redacted['[REDACTED_FIELD_1]'], 'ordinary-key-preserved');
    assert.equal(Object.values(redacted).includes('[REDACTED_SECRET]'), true);
    assert.equal(Object.keys(redacted).length, Object.keys(input).length);

    const persisted = await writeRecorderRecord(handle, input);
    const raw = await readFile(path.join(handle.root_path, ...persisted.relative_path.split('/')), 'utf8');
    assert.equal(raw.includes(JSON.stringify(privatePath).slice(1, -1)), false);
    const parsed = JSON.parse(raw);
    assert.equal(Object.hasOwn(parsed, privatePath), false);
    assert.equal(parsed.safe_relative_key, 'preserved');
    assert.equal(parsed.private_location, '[REDACTED_PRIVATE_PATH]');
    assert.equal(parsed['[REDACTED_FIELD_1]'], 'ordinary-key-preserved');
  }

  const loaded = await loadRecorderRecords(handle);
  const server = await createFlightRecorderServer({ records: loaded });
  t.after(() => server.close());
  const replayed = await replayRecords(server);
  assert.equal(replayed.length, privatePaths.length);
  for (const [index, privatePath] of privatePaths.entries()) {
    const record = replayed.find((value) => value.run_id === runIds[index]);
    assert.ok(record);
    assert.equal(Object.hasOwn(record, privatePath), false);
    assert.equal(record.safe_relative_key, 'preserved');
    assert.equal(record.private_location, '[REDACTED_PRIVATE_PATH]');
    assert.equal(record['[REDACTED_FIELD_1]'], 'ordinary-key-preserved');
  }
});

test('punctuation-embedded POSIX paths are redacted before recorder persistence and replay', async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-embedded-posix-recorder-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const handle = await initializeOwnedDemoRoot(path.join(parent, 'owned'));
  const engine = createDemoEngine({ rootDirectory: handle.root_path });
  const syntheticPosixPath = '/synthetic/private/demo.txt';
  const values = [
    `[${syntheticPosixPath}]`,
    `path:${syntheticPosixPath}`,
    `path|${syntheticPosixPath}|`,
  ];
  const runIds = [];

  for (const embedded of values) {
    const result = await engine.run('low-read-only');
    runIds.push(result.run_id);
    const persisted = await writeRecorderRecord(handle, { ...result, embedded_private_path: embedded });
    const raw = await readFile(path.join(handle.root_path, ...persisted.relative_path.split('/')), 'utf8');
    assert.equal(raw.includes(syntheticPosixPath), false);
    assert.match(raw, /REDACTED_PRIVATE_PATH/);
  }

  const loaded = await loadRecorderRecords(handle);
  const server = await createFlightRecorderServer({ records: loaded });
  t.after(() => server.close());
  const replayed = await replayRecords(server);
  for (const runId of runIds) {
    const record = replayed.find((value) => value.run_id === runId);
    assert.ok(record);
    assert.equal(record.embedded_private_path.includes(syntheticPosixPath), false);
    assert.match(record.embedded_private_path, /REDACTED_PRIVATE_PATH/);
  }
});
