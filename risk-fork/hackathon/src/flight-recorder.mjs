import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

import {
  RISK_FORK_DEMO_BANNER,
  RISK_FORK_DEMO_LIMITS,
  assertDemoSecretFree,
  inspectOwnedDemoTree,
  redactDemoValue,
  removeOwnedDemoEntry,
  resolveOwnedDemoPath,
} from './security.mjs';
import { verifyDemoEnvelope } from './demo-engine.mjs';

const RECORDS_DIRECTORY = 'records';
const MAX_RECORDS = 10;
const RECORDER_WRITE_LOCK = `${RECORDS_DIRECTORY}/.recorder-write.lock`;
const RECORDER_TEMP_PREFIX = `${RECORDS_DIRECTORY}/.recorder-write-`;
const recorderWriteQueues = new Map();
const staticRoot = fileURLToPath(new URL('../recorder/', import.meta.url));
const [HTML, CSS, JS] = await Promise.all([
  readFile(`${staticRoot}/index.html`, 'utf8'),
  readFile(`${staticRoot}/styles.css`, 'utf8'),
  readFile(`${staticRoot}/app.js`, 'utf8'),
]);
if (!HTML.includes(RISK_FORK_DEMO_BANNER)) {
  throw new Error('Flight Recorder static HTML is missing the exact demo banner');
}

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

function tokenMatches(expected, supplied) {
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(supplied, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function send(response, status, contentType, body, extraHeaders = {}) {
  response.writeHead(status, {
    'cache-control': 'no-store, max-age=0',
    'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'none'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'content-type': contentType,
    ...extraHeaders,
  });
  response.end(body);
}

function safeRequestPath(request) {
  try {
    return new URL(request.url, 'http://127.0.0.1').pathname;
  } catch {
    return null;
  }
}

function recorderError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safeRecorderError(error) {
  if (String(error?.code ?? '').startsWith('DEMO_RECORDER_')) return error;
  return recorderError('DEMO_RECORDER_PERSISTENCE_FAILED', 'Recorder persistence failed safely');
}

function verifiedReplayRecord(value) {
  const sanitized = redactDemoValue(value);
  assertDemoSecretFree(sanitized, 'Flight Recorder record');
  if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized)) {
    throw recorderError('DEMO_RECORDER_RECEIPT_INVALID', 'Recorder receipt verification failed safely');
  }
  try {
    verifyDemoEnvelope(sanitized.demo_receipt);
  } catch {
    throw recorderError('DEMO_RECORDER_RECEIPT_INVALID', 'Recorder receipt verification failed safely');
  }
  const receipt = sanitized.demo_receipt;
  const lifecycleChainHead = sanitized.lifecycle?.chain_head ?? null;
  if (
    receipt.run_id !== sanitized.run_id
    || receipt.final_state !== sanitized.final_state
    || receipt.exit_code !== sanitized.exit_code
    || receipt.lifecycle_chain_head !== lifecycleChainHead
  ) {
    throw recorderError('DEMO_RECORDER_RECEIPT_BINDING_INVALID', 'Recorder receipt binding verification failed safely');
  }
  return Object.freeze({
    ...sanitized,
    receipt_hash_verified: true,
    receipt_binding_verified: true,
  });
}

async function inRecorderWriteQueue(rootHandle, callback) {
  const key = `${rootHandle.root_id}:${rootHandle.marker_hash}`;
  const previous = recorderWriteQueues.get(key) ?? Promise.resolve();
  let release;
  const turn = new Promise((resolve) => { release = resolve; });
  const tail = previous.then(() => turn);
  recorderWriteQueues.set(key, tail);
  await previous;
  try {
    return await callback();
  } finally {
    release();
    if (recorderWriteQueues.get(key) === tail) recorderWriteQueues.delete(key);
  }
}

async function ensureRecordsDirectory(rootHandle) {
  const directory = await resolveOwnedDemoPath(rootHandle, RECORDS_DIRECTORY);
  if (!directory.exists) {
    try {
      await mkdir(directory.absolute_path, { recursive: false, mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  return resolveOwnedDemoPath(rootHandle, RECORDS_DIRECTORY, {
    mustExist: true,
    expectedType: 'directory',
  });
}

async function recorderInventory(rootHandle, { allowedTemp = null } = {}) {
  const inventory = await inspectOwnedDemoTree(rootHandle, {
    subpath: RECORDS_DIRECTORY,
    maxFiles: MAX_RECORDS + 2,
    maxBytes: RISK_FORK_DEMO_LIMITS.max_root_bytes,
  });
  let recordCount = 0;
  let recordBytes = 0;
  let tempBytes = null;
  for (const entry of inventory.entries) {
    if (entry.type !== 'file') {
      throw recorderError('DEMO_RECORDER_LAYOUT_INVALID', 'Recorder storage layout is invalid');
    }
    if (/^records\/[A-Za-z0-9_-]{8,100}\.json$/.test(entry.path)) {
      recordCount += 1;
      recordBytes += entry.bytes;
      continue;
    }
    if (entry.path === RECORDER_WRITE_LOCK) continue;
    if (allowedTemp !== null && entry.path === allowedTemp) {
      tempBytes = entry.bytes;
      continue;
    }
    throw recorderError('DEMO_RECORDER_LAYOUT_INVALID', 'Recorder storage contains an unexpected entry');
  }
  return Object.freeze({ record_count: recordCount, record_bytes: recordBytes, temp_bytes: tempBytes });
}

async function acquireRecorderWriteLock(rootHandle) {
  const resolved = await resolveOwnedDemoPath(rootHandle, RECORDER_WRITE_LOCK);
  let handle;
  let created = false;
  try {
    handle = await open(resolved.absolute_path, 'wx', 0o600);
    created = true;
    await handle.writeFile('risk-fork-demo-recorder-write-lock\n', 'utf8');
    return handle;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (created) await removeOwnedDemoEntry(rootHandle, RECORDER_WRITE_LOCK).catch(() => {});
    if (error?.code === 'EEXIST') {
      throw recorderError('DEMO_RECORDER_BUSY', 'Recorder persistence is already active');
    }
    throw error;
  }
}

async function releaseRecorderWriteLock(rootHandle, handle) {
  await handle.close();
  await removeOwnedDemoEntry(rootHandle, RECORDER_WRITE_LOCK);
}

export async function writeRecorderRecord(rootHandle, result) {
  try {
    const sanitized = redactDemoValue(result);
    assertDemoSecretFree(sanitized, 'recorder record');
    const serialized = `${JSON.stringify(sanitized, null, 2)}\n`;
    const serializedBytes = Buffer.byteLength(serialized, 'utf8');
    if (serializedBytes > RISK_FORK_DEMO_LIMITS.max_recorder_bytes) {
      throw recorderError('DEMO_RECORDER_BYTE_LIMIT', 'Sanitized recorder record exceeds the recorder limit');
    }
    const id = String(sanitized.run_id ?? sha256Bytes(serialized).slice(0, 24));
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(id)) {
      throw recorderError('DEMO_RECORDER_ID_INVALID', 'Recorder run id is invalid');
    }
    return await inRecorderWriteQueue(rootHandle, async () => {
      await ensureRecordsDirectory(rootHandle);
      const lockHandle = await acquireRecorderWriteLock(rootHandle);
      const targetPath = `${RECORDS_DIRECTORY}/${id}.json`;
      const tempPath = `${RECORDER_TEMP_PREFIX}${randomBytes(16).toString('hex')}.tmp`;
      let tempCreated = false;
      let targetCreated = false;
      let operationError = null;
      try {
        const target = await resolveOwnedDemoPath(rootHandle, targetPath);
        if (target.exists) {
          throw recorderError('DEMO_RECORDER_EXISTS', 'Recorder record already exists');
        }
        const before = await recorderInventory(rootHandle);
        if (before.record_count >= MAX_RECORDS) {
          throw recorderError('DEMO_RECORDER_FILE_LIMIT', 'Recorder history reached its record limit');
        }
        if (before.record_bytes + serializedBytes > RISK_FORK_DEMO_LIMITS.max_recorder_bytes) {
          throw recorderError('DEMO_RECORDER_BYTE_LIMIT', 'Recorder history would exceed its byte limit');
        }

        const temporary = await resolveOwnedDemoPath(rootHandle, tempPath);
        const temporaryHandle = await open(temporary.absolute_path, 'wx', 0o600);
        tempCreated = true;
        try {
          await temporaryHandle.writeFile(serialized, 'utf8');
        } finally {
          await temporaryHandle.close();
        }
        const staged = await recorderInventory(rootHandle, { allowedTemp: tempPath });
        if (
          staged.record_count !== before.record_count
          || staged.record_bytes !== before.record_bytes
          || staged.temp_bytes !== serializedBytes
          || staged.record_bytes + staged.temp_bytes > RISK_FORK_DEMO_LIMITS.max_recorder_bytes
        ) {
          throw recorderError('DEMO_RECORDER_EVIDENCE_MISMATCH', 'Recorder persistence evidence changed unexpectedly');
        }

        await rename(temporary.absolute_path, target.absolute_path);
        tempCreated = false;
        targetCreated = true;
        const after = await recorderInventory(rootHandle);
        if (
          after.record_count !== before.record_count + 1
          || after.record_bytes !== before.record_bytes + serializedBytes
        ) {
          throw recorderError('DEMO_RECORDER_EVIDENCE_MISMATCH', 'Recorder persistence evidence did not verify');
        }
        return Object.freeze({
          record_ref: `record:${sha256Bytes(serialized)}`,
          bytes: serializedBytes,
          cumulative_bytes: after.record_bytes,
          relative_path: target.relative_path,
        });
      } catch (error) {
        operationError = error;
        if (tempCreated) {
          await removeOwnedDemoEntry(rootHandle, tempPath).catch(() => {
            operationError = recorderError('DEMO_RECORDER_CLEANUP_FAILED', 'Recorder temporary artifact cleanup failed');
          });
        }
        if (targetCreated) {
          await removeOwnedDemoEntry(rootHandle, targetPath).catch(() => {
            operationError = recorderError('DEMO_RECORDER_CLEANUP_FAILED', 'Recorder record rollback failed');
          });
        }
        throw operationError;
      } finally {
        await releaseRecorderWriteLock(rootHandle, lockHandle);
      }
    });
  } catch (error) {
    throw safeRecorderError(error);
  }
}

export async function loadRecorderRecords(rootHandle) {
  const directory = await resolveOwnedDemoPath(rootHandle, RECORDS_DIRECTORY);
  if (!directory.exists) return [];
  const inventory = await inspectOwnedDemoTree(rootHandle, {
    subpath: RECORDS_DIRECTORY,
    maxFiles: MAX_RECORDS,
    maxBytes: RISK_FORK_DEMO_LIMITS.max_recorder_bytes,
  });
  const files = inventory.entries
    .filter((entry) => entry.type === 'file' && entry.path.endsWith('.json'))
    .sort((left, right) => left.path.localeCompare(right.path))
    .slice(-MAX_RECORDS);
  const records = [];
  let totalBytes = 0;
  for (const file of files) {
    const resolved = await resolveOwnedDemoPath(rootHandle, file.path, {
      mustExist: true,
      expectedType: 'file',
    });
    const bytes = await readFile(resolved.absolute_path);
    totalBytes += bytes.length;
    if (totalBytes > RISK_FORK_DEMO_LIMITS.max_recorder_bytes) {
      throw new Error('Recorder store exceeds the configured byte limit');
    }
    const value = JSON.parse(bytes.toString('utf8'));
    assertDemoSecretFree(value, 'recorder store');
    records.push(verifiedReplayRecord(value));
  }
  return records;
}

export async function createFlightRecorderServer({ records }) {
  if (!Array.isArray(records)) throw new TypeError('records must be an array');
  const sanitized = redactDemoValue(records)
    .slice(-MAX_RECORDS)
    .map((record) => verifiedReplayRecord(record));
  assertDemoSecretFree(sanitized, 'Flight Recorder records');
  const payload = JSON.stringify({
    schema: 'agoragentic.risk-fork.flight-recorder-replay.v1',
    mode: 'REPLAY',
    banner: RISK_FORK_DEMO_BANNER,
    records: sanitized,
  });
  if (Buffer.byteLength(payload, 'utf8') > RISK_FORK_DEMO_LIMITS.max_recorder_bytes) {
    throw new Error('Flight Recorder payload exceeds the configured byte limit');
  }
  const token = randomBytes(32).toString('base64url');
  let expectedHost = null;
  const server = http.createServer((request, response) => {
    const host = String(request.headers.host ?? '');
    const origin = request.headers.origin;
    if (host !== expectedHost || (origin !== undefined && origin !== `http://${expectedHost}`)) {
      send(response, 403, 'text/plain; charset=utf-8', 'Forbidden\n');
      return;
    }
    if (request.method !== 'GET') {
      send(response, 405, 'text/plain; charset=utf-8', 'Method not allowed\n', { allow: 'GET' });
      return;
    }
    const pathname = safeRequestPath(request);
    if (pathname === '/') {
      send(response, 200, 'text/html; charset=utf-8', HTML);
      return;
    }
    if (pathname === '/styles.css') {
      send(response, 200, 'text/css; charset=utf-8', CSS);
      return;
    }
    if (pathname === '/app.js') {
      send(response, 200, 'text/javascript; charset=utf-8', JS);
      return;
    }
    if (pathname === '/api/records') {
      const authorization = String(request.headers.authorization ?? '');
      const supplied = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
      if (!tokenMatches(token, supplied)) {
        send(response, 401, 'application/json; charset=utf-8', '{"error":"unauthorized"}\n');
        return;
      }
      send(response, 200, 'application/json; charset=utf-8', `${payload}\n`);
      return;
    }
    send(response, 404, 'text/plain; charset=utf-8', 'Not found\n');
  });
  server.on('clientError', (error, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string' || address.address !== '127.0.0.1') {
    await new Promise((resolve) => server.close(resolve));
    throw new Error('Flight Recorder did not bind to the required loopback address');
  }
  expectedHost = `127.0.0.1:${address.port}`;
  let closed = false;
  return Object.freeze({
    port: address.port,
    origin: `http://${expectedHost}`,
    launch_url: `http://${expectedHost}/#token=${encodeURIComponent(token)}`,
    token,
    mode: 'REPLAY',
    async close() {
      if (closed) return;
      closed = true;
      await new Promise((resolve, reject) => server.close((error) => (
        error ? reject(error) : resolve()
      )));
    },
  });
}

export const FLIGHT_RECORDER_STATIC_ASSETS = Object.freeze({ HTML, CSS, JS });
