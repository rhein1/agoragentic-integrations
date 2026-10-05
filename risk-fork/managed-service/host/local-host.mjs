import {
  assertAllowedKeys,
  assertPlainRecord,
  managedError,
  requireInteger,
  requireOpaqueRef,
} from '../src/validation.mjs';
import {
  createManagedServiceHttpHandler,
  createManagedWorkerHttpHandler,
} from '../src/http-handler.mjs';
import { createManagedLoopbackServer } from './loopback-server.mjs';
import { createManagedWorkerDeliveryJournal } from '../src/worker-delivery.mjs';
import { createManagedRiskForkReaper } from '../src/reaper.mjs';
import { createManagedRiskForkWorker } from '../src/worker.mjs';

const WORKER_OPTIONS = [
  'leaseMs', 'maxAttempts', 'clock', 'loadPrepareInput', 'invokeProvider',
  'lookupResources', 'measureCostMicros',
];
const REAPER_OPTIONS = ['batchSize', 'intervalMs'];

function disabledHost() {
  return Object.freeze({
    enabled: false,
    production_qualified: false,
    async start() {
      throw managedError('Local host is disabled; explicit enabled:true is required', 'HOST_DISABLED', 503);
    },
    async close() {},
    health() {
      return Object.freeze({ enabled: false, started: false, production_qualified: false });
    },
  });
}

// Source-only local composition. The host must supply every secret, credential,
// provider registry, broker callback, and durable store; this module creates no
// defaults and has no production/TLS/JWKS/provider-network path.
export function createManagedRiskForkLocalHost(options = {}) {
  assertPlainRecord(options, 'local host options');
  assertAllowedKeys(options, [
    'enabled', 'controlPlane', 'publicAuthenticator', 'workerAuthenticator',
    'providerRegistry', 'executionPrincipal', 'cleanupPrincipal', 'recoveryPrincipal',
    'workerId', 'deliveryStore', 'deliveryEncryptionKey', 'deliveryKeyId', 'deliveryRetiredDecryptionKeys',
    'deliveryNamespace', 'workerOptions', 'reaperOptions', 'publicPort', 'workerPort',
    'maxBodyBytes', 'maxConnections', 'deadlineMs', 'requestPolicy',
  ], 'local host options');
  if (options.enabled !== undefined && typeof options.enabled !== 'boolean') {
    throw new TypeError('enabled must be boolean');
  }
  if (options.enabled !== true) return disabledHost();
  if (!options.controlPlane || !options.publicAuthenticator || !options.workerAuthenticator
    || !options.providerRegistry || !options.deliveryStore) {
    throw new TypeError('local host dependencies are required');
  }
  assertPlainRecord(options.workerOptions ?? {}, 'worker options');
  assertAllowedKeys(options.workerOptions ?? {}, WORKER_OPTIONS, 'worker options');
  assertPlainRecord(options.reaperOptions ?? {}, 'reaper options');
  assertAllowedKeys(options.reaperOptions ?? {}, REAPER_OPTIONS, 'reaper options');
  const workerId = requireOpaqueRef(options.workerId, 'workerId');
  requireInteger(options.publicPort ?? 0, 'publicPort', { min: 0, max: 65535 });
  requireInteger(options.workerPort ?? 0, 'workerPort', { min: 0, max: 65535 });

  let delivery;
  let worker;
  let reaper;
  try {
    delivery = createManagedWorkerDeliveryJournal({
      store: options.deliveryStore,
      encryptionKey: options.deliveryEncryptionKey,
      keyId: options.deliveryKeyId,
      retiredDecryptionKeys: options.deliveryRetiredDecryptionKeys,
      namespace: options.deliveryNamespace,
      workerId,
      controlPlane: options.controlPlane,
      executionPrincipal: options.executionPrincipal,
      cleanupPrincipal: options.cleanupPrincipal,
      recoveryPrincipal: options.recoveryPrincipal,
      maxAttempts: options.workerOptions?.maxAttempts,
    });
    worker = createManagedRiskForkWorker({
      ...(options.workerOptions ?? {}),
      controlPlane: options.controlPlane,
      providerRegistry: options.providerRegistry,
      executionPrincipal: options.executionPrincipal,
      cleanupPrincipal: options.cleanupPrincipal,
      recoveryPrincipal: options.recoveryPrincipal,
      workerId,
      deliveryJournal: delivery,
    });
    reaper = createManagedRiskForkReaper({
      controlPlane: options.controlPlane,
      ...(options.reaperOptions ?? {}),
    });
  } catch (error) {
    reaper?.stop();
    worker?.close();
    delivery?.close();
    throw error;
  }

  let publicServer;
  let workerServer;
  try {
    publicServer = createManagedLoopbackServer({
      enabled: true,
      port: options.publicPort ?? 0,
      maxBodyBytes: options.maxBodyBytes,
      maxConnections: options.maxConnections,
      deadlineMs: options.deadlineMs,
      handler: createManagedServiceHttpHandler({
        controlPlane: options.controlPlane,
        authenticator: options.publicAuthenticator,
        requestPolicy: options.requestPolicy,
      }),
    });
    workerServer = createManagedLoopbackServer({
      enabled: true,
      port: options.workerPort ?? 0,
      maxBodyBytes: options.maxBodyBytes,
      maxConnections: options.maxConnections,
      deadlineMs: options.deadlineMs,
      handler: createManagedWorkerHttpHandler({
        controlPlane: options.controlPlane,
        workerAuthenticator: options.workerAuthenticator,
        requestPolicy: options.requestPolicy,
      }),
    });
  } catch (error) {
    publicServer?.close().catch(() => {});
    workerServer?.close().catch(() => {});
    reaper.stop();
    worker.close();
    delivery.close();
    throw error;
  }

  let started = false;
  let starting = false;
  let closed = false;
  let closePromise = null;
  function active() {
    if (!started || closed) throw managedError('Local host is not active', 'HOST_DISABLED', 503);
  }
  function runWorker(principal, routeClass, operation) {
    active();
    if (options.requestPolicy === undefined) return operation();
    return (async () => {
      await options.requestPolicy.beforeMutation({ principal, routeClass,
        signal: AbortSignal.timeout(options.deadlineMs ?? 30_000) });
      active();
      return operation();
    })();
  }
  function close() {
    if (closePromise) return closePromise;
    closed = true;
    closePromise = (async () => {
      const errors = [];
      // Stop ingress before revoking worker capabilities or closing the journal.
      for (const server of [publicServer, workerServer]) {
        try { await server.close(); } catch (error) { errors.push(error); }
      }
      reaper.stop();
      worker.close();
      delivery.close();
      if (errors.length) throw errors[0];
    })();
    return closePromise;
  }

  return Object.freeze({
    enabled: true,
    production_qualified: false,
    async start() {
      if (closed || started || starting) throw new TypeError('Local host cannot be started again');
      starting = true;
      try {
        const [publicListener, workerListener] = await Promise.all([
          publicServer.start(), workerServer.start(),
        ]);
        if (closed) {
          throw managedError('Local host closed during startup', 'HOST_CLOSED', 503);
        }
        reaper.start();
        started = true;
        return Object.freeze({
          public: publicListener,
          worker: workerListener,
          production_qualified: false,
          live_traffic_protected: false,
        });
      } catch (error) {
        await close().catch(() => {});
        throw error;
      } finally { starting = false; }
    },
    close,
    // Clean-host capabilities only; never added to either HTTP surface.
    execute(ref) { active(); return runWorker(options.executionPrincipal, 'execution', () => worker.execute(ref)); },
    cleanup(ref) { active(); return runWorker(options.cleanupPrincipal, 'cleanup', () => worker.cleanup(ref)); },
    recover(ref) { active(); return runWorker(options.recoveryPrincipal, 'recovery', () => worker.recover(ref)); },
    listPendingDeliveries(limit) { active(); return delivery.listPending(limit); },
    resumeDelivery(ref) { active(); return delivery.resumeDelivery(ref); },
    health() {
      return Object.freeze({
        enabled: true,
        started,
        closed,
        reaper: reaper.health(),
        production_qualified: false,
        live_traffic_protected: false,
      });
    },
  });
}
