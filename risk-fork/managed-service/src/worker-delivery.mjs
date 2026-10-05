import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { canonicalize, sha256Ref } from '../../src/canonical.mjs';
import {
  assertAllowedKeys, assertDataArray, assertPlainRecord, cloneJson, deepFreeze, managedError,
  requireEnum, requireInteger, requireInvocationRef, requireOpaqueRef,
} from './validation.mjs';

const journals = new WeakMap();
const METHODS = Object.freeze({ execution: 'claimExecution', cleanup: 'claimCleanup', recovery: 'claimRecovery' });
const SCHEMA = 'agoragentic.risk-fork.worker-delivery.v1';
const failure = () => managedError('Worker delivery evidence is unavailable or invalid', 'WORKER_DELIVERY_INVALID', 409);

// A trusted host supplies a durable ciphertext-only store. This capability may
// retry claim/journal DELIVERY, never allocation, execution, destruction, or
// prepared-object authority. Store acknowledgements are not provider evidence.
export function createManagedWorkerDeliveryJournal(options = {}) {
  assertPlainRecord(options, 'delivery options');
  assertAllowedKeys(options, ['store', 'encryptionKey', 'keyId', 'retiredDecryptionKeys', 'namespace', 'workerId',
    'controlPlane', 'executionPrincipal', 'cleanupPrincipal', 'recoveryPrincipal', 'maxAttempts'], 'delivery options');
  const { store, controlPlane: control } = options;
  for (const method of ['insert', 'get', 'acknowledge', 'listPending']) {
    if (typeof store?.[method] !== 'function') throw new TypeError(`delivery store.${method} is required`);
  }
  if (control?.config?.environment !== 'local_test' || control.config.enabled !== true) {
    throw managedError('Delivery source is local_test only', 'WORKER_NOT_QUALIFIED', 503);
  }
  const keyId = requireOpaqueRef(options.keyId, 'keyId');
  const requireKey = (value) => {
    if (isProxy(value) || !Buffer.isBuffer(value) || value.length !== 32) {
      throw new TypeError('A host-owned 32-byte encryption key is required');
    }
    return value;
  };
  const keyInputs = new Map([[keyId, requireKey(options.encryptionKey)]]);
  const retired = options.retiredDecryptionKeys === undefined ? [] : options.retiredDecryptionKeys;
  assertDataArray(retired, 'retiredDecryptionKeys', { maxLength: 8 });
  for (const entry of retired) {
    assertPlainRecord(entry, 'retired decryption key');
    assertAllowedKeys(entry, ['keyId', 'encryptionKey'], 'retired decryption key');
    const retiredId = requireOpaqueRef(entry.keyId, 'retired keyId');
    if (keyInputs.has(retiredId)) throw new TypeError('Delivery key IDs must be unique');
    keyInputs.set(retiredId, requireKey(entry.encryptionKey));
  }
  const namespace = requireOpaqueRef(options.namespace, 'namespace');
  const workerId = requireOpaqueRef(options.workerId, 'workerId');
  const maxAttempts = requireInteger(options.maxAttempts ?? 1000, 'maxAttempts', { min: 1, max: 10_000 });
  const principals = Object.freeze({ execution: options.executionPrincipal,
    cleanup: options.cleanupPrincipal, recovery: options.recoveryPrincipal });
  for (const principal of Object.values(principals)) {
    requireOpaqueRef(principal?.key_id, 'principal.key_id');
    requireOpaqueRef(principal?.tenant_id, 'principal.tenant_id');
  }
  // Snapshot host key custody only after validating the complete construction.
  // Retired keys decrypt exact retained v1 records; they never seal new packets.
  const decryptionKeys = new Map([...keyInputs].map(([id, value]) => [id, Buffer.from(value)]));
  keyInputs.clear();
  const key = decryptionKeys.get(keyId);
  let closed = false;
  const running = new Map();
  const assertOpen = () => { if (closed) throw failure(); };
  const aad = (ref, recordKeyId = keyId) => Buffer.from(canonicalize({ schema: SCHEMA, namespace, worker_id: workerId, key_id: recordKeyId, attempt_ref: ref }));

  function validatePacket(value) {
    const packet = cloneJson(value, 'delivery packet');
    assertPlainRecord(packet, 'delivery packet');
    assertAllowedKeys(packet, ['kind', 'method', 'principal_key_id', 'tenant_id', 'input'], 'delivery packet');
    requireEnum(packet.kind, Object.keys(METHODS), 'delivery kind');
    if (packet.method !== METHODS[packet.kind]
      && !(packet.method === 'recordResources' && ['execution', 'recovery'].includes(packet.kind))) throw failure();
    const principal = principals[packet.kind];
    if (packet.principal_key_id !== principal.key_id || packet.tenant_id !== principal.tenant_id) throw failure();
    assertPlainRecord(packet.input, 'delivery input');
    const claim = packet.method !== 'recordResources';
    assertAllowedKeys(packet.input, claim
      ? ['invocation_ref', 'worker_id', 'lease_ms', 'lease_token']
      : ['invocation_ref', 'lease_token', 'savepoint_ref', 'fork_ref', 'absent_resource_kinds'], 'delivery input');
    requireInvocationRef(packet.input.invocation_ref);
    if (claim && packet.input.worker_id !== workerId) throw failure();
    if (typeof packet.input.lease_token !== 'string' || !/^[A-Za-z0-9._~-]{32,512}$/.test(packet.input.lease_token)) throw failure();
    return packet;
  }

  function seal(ref, packet) {
    const bytes = Buffer.from(canonicalize(packet));
    if (bytes.length > 65_536) throw failure();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad(ref));
    const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
    bytes.fill(0);
    return deepFreeze({ schema: SCHEMA, namespace, attempt_ref: ref, key_id: keyId,
      iv: iv.toString('base64url'), ciphertext: ciphertext.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url') });
  }

  function unseal(ref, value) {
    assertOpen();
    try {
      const record = cloneJson(value, 'delivery record');
      assertPlainRecord(record, 'delivery record');
      assertAllowedKeys(record, ['schema', 'namespace', 'attempt_ref', 'key_id', 'iv', 'ciphertext', 'tag'], 'delivery record');
      if (record.schema !== SCHEMA || record.namespace !== namespace || record.attempt_ref !== ref) throw failure();
      const recordKey = decryptionKeys.get(record.key_id);
      if (!recordKey) throw failure(); // no trial-decrypt, external key fetch, or fallback
      const decode = (text, max) => {
        if (typeof text !== 'string' || text.length > max || !/^[A-Za-z0-9_-]+$/.test(text)) throw failure();
        const bytes = Buffer.from(text, 'base64url');
        if (bytes.toString('base64url') !== text) throw failure();
        return bytes;
      };
      const iv = decode(record.iv, 16), tag = decode(record.tag, 22), ciphertext = decode(record.ciphertext, 87_384);
      if (iv.length !== 12 || tag.length !== 16 || ciphertext.length > 65_536) throw failure();
      const decipher = createDecipheriv('aes-256-gcm', recordKey, iv);
      decipher.setAAD(aad(ref, record.key_id)); decipher.setAuthTag(tag);
      const bytes = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      try { return validatePacket(JSON.parse(bytes.toString('utf8'))); }
      finally { bytes.fill(0); }
    } catch { throw failure(); }
  }

  async function send(ref, packet) {
    assertOpen();
    // The control plane rechecks the current branded principal, stored lease
    // purpose and credential row. Retaining ciphertext cannot retain authority.
    const input = packet.method === 'recordResources'
      ? { ...packet.input, expected_lease_kind: packet.kind } : packet.input;
    const response = await control[packet.method](principals[packet.kind], input);
    assertOpen();
    await store.acknowledge(namespace, ref, sha256Ref(response));
    assertOpen();
    return response;
  }

  const journal = Object.freeze({
    async deliver(kind, method, input) {
      assertOpen();
      const principal = principals[kind];
      const packet = validatePacket({ kind, method, input, principal_key_id: principal?.key_id, tenant_id: principal?.tenant_id });
      // One worker identity/ref/purpose owns one logical claim. Resource packets
      // are keyed by exact canonical input. A fresh post-reaping logical attempt
      // needs a fresh worker identity; old records/tombstones are never erased.
      const ref = sha256Ref({ namespace, worker_id: workerId, kind, invocation_ref: input.invocation_ref,
        stage: method === 'recordResources' ? sha256Ref(packet) : 'claim' });
      if (!await store.insert(seal(ref, packet), maxAttempts)) {
        throw managedError('Delivery already recorded; use delivery-only recovery', 'WORKER_DELIVERY_ALREADY_RECORDED', 409);
      }
      return send(ref, packet);
    },
    resumeDelivery(ref) {
      assertOpen();
      if (typeof ref !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(ref)) throw failure();
      if (running.has(ref)) return running.get(ref);
      if (running.size >= maxAttempts) throw managedError('Recovery capacity exhausted', 'WORKER_CAPACITY', 503);
      const promise = Promise.resolve().then(async () => {
        const row = await store.get(namespace, ref);
        assertOpen();
        if (!row) throw failure();
        const packet = unseal(ref, row.record);
        if (!row.acknowledged) await send(ref, packet);
        return Object.freeze({ attempt_ref: ref, method: packet.method, delivery_acknowledged: true,
          original_operation_resumed: false, production_qualified: false });
      });
      const tracked = promise.finally(() => running.delete(ref));
      running.set(ref, tracked); // retries require a new explicit resume call
      return tracked;
    },
    async listPending(limit = 100) {
      assertOpen(); requireInteger(limit, 'limit', { min: 1, max: 1000 });
      const refs = cloneJson(await store.listPending(namespace, limit));
      if (!Array.isArray(refs) || refs.length > limit || new Set(refs).size !== refs.length
        || refs.some((ref) => typeof ref !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(ref))) throw failure();
      return deepFreeze(refs);
    },
    close() { closed = true; for (const value of decryptionKeys.values()) value.fill(0); decryptionKeys.clear(); },
    production_qualified: false,
  });
  journals.set(journal, { control, workerId, principals });
  return journal;
}

export function assertManagedWorkerDeliveryJournal(value, control, workerId, principals) {
  const binding = journals.get(value);
  if (!binding || binding.control !== control || binding.workerId !== workerId
    || Object.keys(binding.principals).some((kind) => binding.principals[kind] !== principals[kind])) {
    throw new TypeError('Delivery journal must be factory-bound to this worker and current principals');
  }
  return value;
}
