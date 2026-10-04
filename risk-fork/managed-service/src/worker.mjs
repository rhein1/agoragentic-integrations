import { randomBytes } from 'node:crypto';
import { sha256Ref } from '../../src/canonical.mjs';
import { RiskForkController } from '../../src/controller.mjs';
import { REQUIRED_PROVIDER_METHODS } from '../../src/provider.mjs';
import { verifyManagedCleanupPlan } from './control-plane.mjs';
import { assertManagedWorkerDeliveryJournal } from './worker-delivery.mjs';
import {
  assertAllowedKeys, cloneJson, deepFreeze, managedError, requireInteger,
  requireInvocationRef, requireOpaqueRef,
} from './validation.mjs';

// Host-owned, source-only driver. invokeProvider is the privileged provider
// broker: it must enforce the supplied absolute fence/deadline and bind resource
// creation to provider_recovery_key at birth. It must never pass worker tokens,
// principal objects, or provider credentials into the child. No SDK/listener is
// constructed here and the managed registry still admits local_test only.
export function createManagedRiskForkWorker(options = {}) {
  assertAllowedKeys(options, [
    'controlPlane', 'providerRegistry', 'executionPrincipal', 'cleanupPrincipal',
    'recoveryPrincipal', 'workerId', 'leaseMs', 'maxAttempts', 'clock',
    'loadPrepareInput', 'invokeProvider', 'lookupResources', 'measureCostMicros',
    'deliveryJournal',
  ], 'worker options');
  const control = options.controlPlane;
  if (control?.config?.environment !== 'local_test' || control.config.enabled !== true) {
    throw managedError('Worker source is restricted to enabled local_test control planes', 'WORKER_NOT_QUALIFIED', 503);
  }
  for (const name of ['claimExecution', 'claimCleanup', 'claimRecovery', 'renewLease',
    'recordResources', 'recordExecutionOutcome', 'completeCleanup', 'completeRecoveryAbsence']) {
    if (typeof control[name] !== 'function') throw new TypeError(`controlPlane.${name} is required`);
  }
  if (typeof options.providerRegistry?.requireBound !== 'function') throw new TypeError('providerRegistry is required');
  for (const name of ['loadPrepareInput', 'invokeProvider', 'lookupResources', 'measureCostMicros']) {
    if (typeof options[name] !== 'function') throw new TypeError(`${name} is required`);
  }
  const registry = options.providerRegistry;
  const loadPrepareInput = options.loadPrepareInput;
  const invokeProvider = options.invokeProvider;
  const lookupResources = options.lookupResources;
  const measureCost = options.measureCostMicros;
  const principals = Object.freeze({ execution: options.executionPrincipal,
    cleanup: options.cleanupPrincipal, recovery: options.recoveryPrincipal });
  if (Object.values(principals).some((principal) => !principal)) throw new TypeError('All worker principals are required');
  const workerId = requireOpaqueRef(options.workerId, 'workerId');
  const delivery = options.deliveryJournal == null ? null
    : assertManagedWorkerDeliveryJournal(options.deliveryJournal, control, workerId, principals);
  const leaseMs = requireInteger(options.leaseMs ?? 30_000, 'leaseMs',
    { min: control.config.limits.min_lease_ms, max: control.config.limits.max_lease_ms });
  const maxAttempts = requireInteger(options.maxAttempts ?? 1000, 'maxAttempts', { min: 1, max: 10_000 });
  const clock = options.clock ?? (() => new Date());
  if (typeof clock !== 'function') throw new TypeError('clock is required');
  const attempts = new Map();
  const shutdown = new AbortController();
  let closed = false;
  const assertOpen = () => {
    if (closed) throw managedError('Worker is closed; unfinished work requires recovery', 'WORKER_CLOSED', 503);
  };
  const token = () => randomBytes(32).toString('base64url');

  function once(kind, refValue, operation) {
    assertOpen();
    const ref = requireInvocationRef(refValue, 'invocation_ref');
    const key = `${kind}:${ref}`;
    if (attempts.has(key)) return attempts.get(key);
    if (attempts.size >= maxAttempts) throw managedError('Worker attempt capacity exhausted', 'WORKER_CAPACITY', 503);
    // Insert before any awaited work: duplicate/delayed callers converge on one
    // promise, including a failed/unknown attempt. Never retry a provider create.
    const promise = Promise.resolve().then(() => operation(ref));
    attempts.set(key, promise);
    return promise;
  }

  async function claim(kind, ref) {
    const leaseToken = token();
    const method = { execution: 'claimExecution', cleanup: 'claimCleanup', recovery: 'claimRecovery' }[kind];
    const input = {
      invocation_ref: ref, worker_id: workerId, lease_ms: leaseMs, lease_token: leaseToken,
    };
    const response = delivery ? await delivery.deliver(kind, method, input)
      : await control[method](principals[kind], input);
    // No automatic delivery retry. A lost acknowledgement is terminal for this
    // local attempt and is resolved by lease expiry/reaping and recovery.
    if (response.lease_token !== leaseToken || response.claim_replayed !== false
      || response.invocation.invocation_ref !== ref) {
      throw managedError('Unexpected claim replay or binding', 'WORKER_CLAIM_AMBIGUOUS', 409);
    }
    return { kind, leaseToken, invocation: response.invocation, uncertain: false };
  }

  async function fence(attempt) {
    assertOpen();
    if (attempt.uncertain) throw managedError('Provider or journal delivery is uncertain; recovery required', 'WORKER_RECOVERY_REQUIRED', 409);
    try {
      const invocation = await control.renewLease(principals[attempt.kind], {
        invocation_ref: attempt.invocation.invocation_ref, lease_token: attempt.leaseToken, lease_ms: leaseMs,
      });
      if (invocation.invocation_ref !== attempt.invocation.invocation_ref
        || invocation.provider_binding_hash !== attempt.invocation.provider_binding_hash
        || invocation.provider_recovery_key !== attempt.invocation.provider_recovery_key) {
        throw new Error('Lease renewal binding changed');
      }
      attempt.invocation = invocation;
      const provider = registry.requireBound(invocation.provider_id, invocation.tenant_id,
        invocation.provider_binding_hash, { allowDisabled: attempt.kind !== 'execution' });
      return { provider, context: deepFreeze({
        invocation_ref: invocation.invocation_ref, tenant_id: invocation.tenant_id,
        provider_binding_hash: invocation.provider_binding_hash,
        provider_recovery_key: invocation.provider_recovery_key,
        lease_kind: attempt.kind, lease_generation: invocation.lease_generation,
        lease_expires_at: invocation.lease_expires_at,
      }) };
    } catch {
      attempt.uncertain = true;
      throw managedError('Current worker lease or provider binding is unavailable', 'WORKER_FENCE_FAILED', 409);
    }
  }

  async function invoke(attempt, method, input) {
    const { provider, context } = await fence(attempt);
    const result = await invokeProvider({ provider, method, input, context, signal: shutdown.signal });
    // A delayed response does not preserve the lease or authority it started
    // with. The broker must still fence the effect itself at the provider edge.
    await fence(attempt);
    return result;
  }

  async function journal(attempt, references) {
    try {
      const input = {
        invocation_ref: attempt.invocation.invocation_ref, lease_token: attempt.leaseToken, ...references,
      };
      attempt.invocation = delivery ? await delivery.deliver(attempt.kind, 'recordResources', input)
        : await control.recordResources(principals[attempt.kind], input);
    } catch {
      attempt.uncertain = true;
      throw managedError('Resource journal acknowledgement is unavailable; no further effects allowed', 'WORKER_JOURNAL_AMBIGUOUS', 409);
    }
  }

  async function cleanup(ref, { verifyOnly = false } = {}) {
    const attempt = await claim('cleanup', ref);
    const evidence = [];
    for (const request of verifyManagedCleanupPlan(attempt.invocation)) {
      const fork = request.resource_kind === 'fork';
      const input = { [fork ? 'fork_ref' : 'savepoint_ref']: request.resource_ref, cleanup_request: request };
      // prepare already destroyed these resources. Collect fresh managed-plan
      // evidence without silently requiring a second destroy to be idempotent.
      // Recovery/public cleanup still owns destruction of uncertain resources.
      if (!verifyOnly) await invoke(attempt, fork ? 'destroyFork' : 'destroySavepoint', input);
      evidence.push(await invoke(attempt, fork ? 'verifyDestroyed' : 'verifySavepointDestroyed', input));
    }
    return control.completeCleanup(principals.cleanup, {
      invocation_ref: ref, lease_token: attempt.leaseToken, cleanup_evidence: evidence,
    });
  }

  async function execute(ref) {
    const attempt = await claim('execution', ref);
    const admission = attempt.invocation;
    const input = await loadPrepareInput(admission);
    if (!input || sha256Ref(input.operation) !== admission.operation_hash) {
      throw managedError('Host preparation changed the admitted operation', 'WORKER_OPERATION_MISMATCH', 409);
    }
    const { provider } = await fence(attempt);
    const facade = { id: provider.id, capabilities: provider.capabilities };
    for (const method of REQUIRED_PROVIDER_METHODS) {
      facade[method] = async (providerInput) => {
        if (method === 'executeInFork' && (!attempt.invocation.savepoint_ref || !attempt.invocation.fork_ref)) {
          throw managedError('Both resources must be durably journaled before execution', 'WORKER_RESOURCES_REQUIRED', 409);
        }
        let result;
        try { result = await invoke(attempt, method, providerInput); }
        catch (error) {
          if (['createSavepoint', 'createFork'].includes(method)) attempt.uncertain = true;
          throw error;
        }
        if (method === 'createSavepoint' || method === 'createFork') {
          try {
            const kind = method === 'createSavepoint' ? 'savepoint_ref' : 'fork_ref';
            const resourceRef = requireOpaqueRef(result?.[kind], kind);
            await journal(attempt, { [kind]: resourceRef });
          } catch (error) { attempt.uncertain = true; throw error; }
        }
        return result;
      };
    }
    const controller = new RiskForkController({ provider: Object.freeze(facade), mode: 'demonstration', clock });
    let prepared;
    try { prepared = await controller.prepare(input); }
    catch {
      // Even controller cleanup is not durable absence evidence for unknown
      // create/journal delivery. Recovery never replays the original operation.
      throw managedError('Preparation did not reach verified clean authority; reconcile the durable invocation', 'WORKER_PREPARATION_FAILED', 409);
    }
    if (attempt.uncertain || prepared.mode !== 'prepared_for_clean_commit') {
      throw managedError('Worker requires an actual cleaned, validated fork', 'WORKER_PREPARATION_FAILED', 409);
    }
    await fence(attempt);
    const actualCost = requireInteger(await measureCost(admission, prepared), 'actual_cost_micros',
      { min: 0, max: admission.estimated_cost_micros });
    await fence(attempt); // cost is pure host metering, but it can await
    await control.recordExecutionOutcome(principals.execution, {
      invocation_ref: ref, lease_token: attempt.leaseToken, outcome: 'succeeded',
      actual_cost_micros: actualCost, execution_evidence_hash: prepared.lifecycle.chain_head,
      result_hash: prepared.artifact.artifact_hash,
    });
    const terminal = await once('cleanup', ref, (invocationRef) => cleanup(invocationRef, { verifyOnly: true }));
    if (terminal.state !== 'completed') throw managedError('Managed cleanup did not complete', 'WORKER_CLEANUP_FAILED', 409);
    // Original process-local controller/receipt only. A serialized prepared
    // object still loses the core provenance brand and cannot be committed.
    return Object.freeze({ controller, prepared, invocation: terminal,
      production_qualified: false, live_traffic_protected: false });
  }

  async function recover(ref) {
    const attempt = await claim('recovery', ref);
    const { provider, context } = await fence(attempt);
    const found = cloneJson(await lookupResources({ provider, context,
      invocation: attempt.invocation, signal: shutdown.signal }), 'recovery lookup');
    assertAllowedKeys(found, ['savepoint_ref', 'fork_ref', 'absent_resource_kinds', 'absence_evidence'], 'recovery lookup');
    await fence(attempt); // lookup delay/revocation must not retain authority
    if (found.savepoint_ref == null && found.fork_ref == null) {
      return control.completeRecoveryAbsence(principals.recovery, {
        invocation_ref: ref, lease_token: attempt.leaseToken, recovery_evidence: found.absence_evidence,
      });
    }
    await journal(attempt, { savepoint_ref: found.savepoint_ref ?? null,
      fork_ref: found.fork_ref ?? null, absent_resource_kinds: found.absent_resource_kinds ?? [] });
    return once('cleanup', ref, cleanup);
  }

  return Object.freeze({
    execute: (ref) => once('execution', ref, execute),
    cleanup: (ref) => once('cleanup', ref, cleanup),
    recover: (ref) => once('recovery', ref, recover),
    close() { closed = true; shutdown.abort(); },
    production_qualified: false, live_traffic_protected: false,
  });
}
