import {
  assertAllowedKeys,
  assertManagedWorkerPrincipals,
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
import { isManagedTelemetryDrainer } from '../src/telemetry-drainer.mjs';
import { isManagedLifecycleObserver } from '../src/lifecycle-observer.mjs';
import { createManagedDeadline } from '../src/deadline.mjs';

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
    'maxBodyBytes', 'maxConnections', 'deadlineMs', 'requestPolicy', 'telemetryDrainer','lifecycleObserver','lifecycleDrainer','alertDrainer',
  ], 'local host options');
  if (options.enabled !== undefined && typeof options.enabled !== 'boolean') {
    throw new TypeError('enabled must be boolean');
  }
  if (options.enabled !== true) return disabledHost();
  const requestPolicy = options.requestPolicy, telemetryDrainer = options.telemetryDrainer;
  const lifecycleObserver = options.lifecycleObserver, lifecycleDrainer = options.lifecycleDrainer;
  const alertDrainer = options.alertDrainer;
  if (alertDrainer !== undefined && !isManagedTelemetryDrainer(alertDrainer)) throw new TypeError('An original managed alert drainer is required');
  if (lifecycleObserver !== undefined && !isManagedLifecycleObserver(lifecycleObserver)) throw new TypeError('An original managed lifecycle observer is required');
  if (lifecycleDrainer !== undefined && !isManagedTelemetryDrainer(lifecycleDrainer)) throw new TypeError('An original managed lifecycle drainer is required');
  const requestPolicyTimeoutMs = options.deadlineMs;
  if (telemetryDrainer !== undefined && !isManagedTelemetryDrainer(telemetryDrainer)) {
    throw new TypeError('An original managed telemetry drainer is required');
  }
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
  const principals = assertManagedWorkerPrincipals({ execution: options.executionPrincipal,
    cleanup: options.cleanupPrincipal, recovery: options.recoveryPrincipal });

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
      executionPrincipal: principals.execution,
      cleanupPrincipal: principals.cleanup,
      recoveryPrincipal: principals.recovery,
      maxAttempts: options.workerOptions?.maxAttempts,
    });
    worker = createManagedRiskForkWorker({
      ...(options.workerOptions ?? {}),
      controlPlane: options.controlPlane,
      providerRegistry: options.providerRegistry,
      executionPrincipal: principals.execution,
      cleanupPrincipal: principals.cleanup,
      recoveryPrincipal: principals.recovery,
      workerId,
      deliveryJournal: delivery,
      requestPolicy,
      requestPolicyTimeoutMs,
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
        requestPolicy,
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
        requestPolicy,
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
  let telemetryClose;
  function active() {
    if (!started || closed) throw managedError('Local host is not active', 'HOST_DISABLED', 503);
  }
  function runWorker(principal, routeClass, operation) {
    active();
    if (requestPolicy === undefined) return operation();
    return (async () => {
      const deadline = createManagedDeadline(requestPolicyTimeoutMs ?? 30_000);
      let decision;
      try { decision = await requestPolicy.beforeMutation({ principal, routeClass, signal: deadline.signal }); }
      finally { deadline.dispose(); }
      active();
      return operation(decision);
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
      // Revoke effect capabilities before waiting on observational callbacks.
      // Store lifetime remains owned by the caller. Settled:false is preserved,
      // never reported as callback termination or durable delivery proof.
      let recording, observer, lifecycle, lifecycleDelivery, alertDelivery;
      try { lifecycle = await lifecycleObserver?.close({ timeoutMs: 1000 }); } catch (error) { errors.push(error); }
      try { recording = await requestPolicy?.flushTelemetry({ timeoutMs: 1000 }); } catch (error) { errors.push(error); }
      try { observer = await telemetryDrainer?.close({ timeoutMs: 1000 }); } catch (error) { errors.push(error); }
      try { lifecycleDelivery = await lifecycleDrainer?.close({ timeoutMs: 1000 }); } catch (error) { errors.push(error); }
      try { alertDelivery = await alertDrainer?.close({ timeoutMs: 1000 }); } catch (error) { errors.push(error); }
      telemetryClose = Object.freeze({ recording,observer,lifecycle,lifecycle_delivery: lifecycleDelivery,alert_delivery: alertDelivery });
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
        telemetryDrainer?.start();
        lifecycleDrainer?.start();
        alertDrainer?.start();
        lifecycleObserver?.start();
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
    execute(ref) { active(); return runWorker(principals.execution, 'execution', (decision) => worker.execute(ref, decision)); },
    cleanup(ref) { active(); return runWorker(principals.cleanup, 'cleanup', () => worker.cleanup(ref)); },
    recover(ref) { active(); return runWorker(principals.recovery, 'recovery', () => worker.recover(ref)); },
    listPendingDeliveries(limit) { active(); return delivery.listPending(limit); },
    resumeDelivery(ref) { active(); return delivery.resumeDelivery(ref); },
    health() {
      return Object.freeze({
        enabled: true,
        started,
        closed,
        reaper: reaper.health(),
        telemetry: requestPolicy?.telemetryHealth(),
        telemetry_delivery: telemetryDrainer?.health(),
        lifecycle_observer: lifecycleObserver?.health(),
        lifecycle_delivery: lifecycleDrainer?.health(),
        alert_delivery: alertDrainer?.health(),
        telemetry_close: telemetryClose,
        production_qualified: false,
        live_traffic_protected: false,
      });
    },
  });
}
