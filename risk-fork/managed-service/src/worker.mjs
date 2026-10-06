import { randomBytes } from 'node:crypto';
import { sha256Ref } from '../../src/canonical.mjs';
import { RiskForkController } from '../../src/controller.mjs';
import { REQUIRED_PROVIDER_METHODS } from '../../src/provider.mjs';
import { verifyManagedCleanupPlan } from './control-plane.mjs';
import { assertManagedWorkerDeliveryJournal } from './worker-delivery.mjs';
import { assertManagedRequestPolicy } from './request-policy.mjs';
import {
  assertAllowedKeys, assertManagedWorkerPrincipals, cloneJson, deepFreeze, managedError, requireInteger,
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
    'deliveryJournal', 'requestPolicy', 'requestPolicyTimeoutMs', 'cancellationPollMs',
  ], 'worker options');
  const control = options.controlPlane;
  if (control?.config?.environment !== 'local_test' || control.config.enabled !== true) {
    throw managedError('Worker source is restricted to enabled local_test control planes', 'WORKER_NOT_QUALIFIED', 503);
  }
  for (const name of ['claimExecution', 'claimCleanup', 'claimRecovery', 'renewLease',
    'recordResources', 'recordExecutionOutcome', 'completeCleanup', 'recordCleanupIncomplete', 'completeRecoveryAbsence',
    'observeExecutionCancellation']) {
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
  const requestPolicy = options.requestPolicy === undefined ? null : assertManagedRequestPolicy(options.requestPolicy);
  const policyTimeoutMs = requireInteger(options.requestPolicyTimeoutMs ?? 30_000, 'requestPolicyTimeoutMs', { min: 100, max: 30_000 });
  const principals = assertManagedWorkerPrincipals({ execution: options.executionPrincipal,
    cleanup: options.cleanupPrincipal, recovery: options.recoveryPrincipal });
  const workerId = requireOpaqueRef(options.workerId, 'workerId');
  const delivery = options.deliveryJournal == null ? null
    : assertManagedWorkerDeliveryJournal(options.deliveryJournal, control, workerId, principals);
  const leaseMs = requireInteger(options.leaseMs ?? 30_000, 'leaseMs',
    { min: control.config.limits.min_lease_ms, max: control.config.limits.max_lease_ms });
  const maxAttempts = requireInteger(options.maxAttempts ?? 1000, 'maxAttempts', { min: 1, max: 10_000 });
  const cancellationPollMs = requireInteger(options.cancellationPollMs ?? 100, 'cancellationPollMs', { min: 20, max: 5000 });
  const clock = options.clock ?? (() => new Date());
  if (typeof clock !== 'function') throw new TypeError('clock is required');
  const attempts = new Map();
  const preEffectDenials = new WeakSet();
  const brokerFenceErrors = new WeakSet();
  const shutdown = new AbortController();
  const activeAttempts = new Set();
  const pendingAttempts = new Set();
  const pendingProviderCalls = new Set();
  let closed = false;
  let executionStopped = false;
  const assertOpen = (kind) => {
    if (closed) throw managedError('Worker is closed; unfinished work requires recovery', 'WORKER_CLOSED', 503);
    if (kind === 'execution' && executionStopped) {
      throw managedError('Worker execution is stopped; cleanup and recovery remain available', 'WORKER_EXECUTION_STOPPED', 503);
    }
  };
  const token = () => randomBytes(32).toString('base64url');

  function once(kind, refValue, operation) {
    assertOpen(kind);
    const ref = requireInvocationRef(refValue, 'invocation_ref');
    const key = `${kind}:${ref}`;
    if (attempts.has(key)) return attempts.get(key);
    if (attempts.size >= maxAttempts) throw managedError('Worker attempt capacity exhausted', 'WORKER_CAPACITY', 503);
    // Insert before any awaited work: duplicate/delayed callers converge on one
    // promise, including a failed/unknown attempt. Never retry a provider create.
    const promise = Promise.resolve().then(() => operation(ref));
    pendingAttempts.add(key);
    promise.then(() => pendingAttempts.delete(key), () => pendingAttempts.delete(key));
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
    const abort = new AbortController();
    const onShutdown = () => abort.abort();
    shutdown.signal.addEventListener('abort', onShutdown, { once: true });
    if (shutdown.signal.aborted || (kind === 'execution' && executionStopped)) abort.abort();
    const attempt = { kind, leaseToken, invocation: response.invocation, uncertain: false,
      claimGeneration: requireInteger(response.invocation.lease_generation, 'claim generation', { min: 1, max: 2_147_483_647 }),
      watchingCancellation: false,
      abort, done: false, timer: null, onShutdown, providerCalls: new Set() };
    activeAttempts.add(attempt);
    return attempt;
  }

  function releaseAttemptLinkage(attempt) {
    if (!attempt.done || attempt.providerCalls.size !== 0) return;
    shutdown.signal.removeEventListener('abort', attempt.onShutdown);
    activeAttempts.delete(attempt);
  }

  function finishAttempt(attempt) {
    if (!attempt.done) {
      attempt.done = true;
      attempt.watchingCancellation = false;
      clearTimeout(attempt.timer);
      // Logical retirement is not provider settlement. Signal a dropped call
      // immediately, and retain shutdown linkage until every actual call settles.
      // A provider that ignores abort remains counted and requires recovery.
      if (attempt.providerCalls.size !== 0) attempt.abort.abort();
    }
    releaseAttemptLinkage(attempt);
  }

  function watchCancellation(attempt) {
    attempt.watchingCancellation = true;
    const observe = async () => {
      if (attempt.done || !attempt.watchingCancellation || closed || attempt.abort.signal.aborted) return;
      try {
        const current = await control.observeExecutionCancellation(principals.execution, {
          invocation_ref: attempt.invocation.invocation_ref, lease_token: attempt.leaseToken,
          lease_generation: attempt.claimGeneration,
        });
        if (attempt.done || !attempt.watchingCancellation) return;
        if (current.tenant_id !== attempt.invocation.tenant_id
          || current.invocation_ref !== attempt.invocation.invocation_ref
          || current.provider_binding_hash !== attempt.invocation.provider_binding_hash
          || current.provider_recovery_key !== attempt.invocation.provider_recovery_key
          || current.lease_generation !== attempt.claimGeneration
          || typeof current.cancel_requested !== 'boolean') throw new Error('Cancellation observation binding changed');
        if (current.cancel_requested) attempt.abort.abort();
      } catch {
        if (attempt.done || !attempt.watchingCancellation) return;
        // Dependency/authentication loss is not a cancellation acknowledgement.
        // Signal the callback to stop, retain the promise and durable recovery.
        attempt.uncertain = true;
        attempt.abort.abort();
      }
      if (!attempt.done && attempt.watchingCancellation && !closed && !attempt.abort.signal.aborted) schedule();
    };
    const schedule = () => {
      attempt.timer = setTimeout(observe, cancellationPollMs);
      attempt.timer.unref?.();
    };
    schedule();
  }

  function assertAttemptOpen(attempt) {
    assertOpen(attempt.kind);
    if (attempt.abort.signal.aborted) {
      throw managedError('Worker attempt was interrupted; resource disposition requires reconciliation', 'WORKER_ATTEMPT_ABORTED', 409);
    }
  }

  async function fence(attempt) {
    assertAttemptOpen(attempt);
    if (attempt.uncertain) throw managedError('Provider or journal delivery is uncertain; recovery required', 'WORKER_RECOVERY_REQUIRED', 409);
    try {
      const invocation = await control.renewLease(principals[attempt.kind], {
        invocation_ref: attempt.invocation.invocation_ref, lease_token: attempt.leaseToken, lease_ms: leaseMs,
      });
      assertAttemptOpen(attempt); // Cancellation/shutdown while renewal waited cannot authorize dispatch.
      if (invocation.invocation_ref !== attempt.invocation.invocation_ref
        || invocation.lease_generation !== attempt.claimGeneration
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

  async function effectPreflight(attempt, method) {
    const { provider, context } = await fence(attempt);
    if (attempt.policyFence && ['createSavepoint', 'createFork', 'executeInFork'].includes(method)) {
      try {
        await attempt.policyFence({ invocationRef: context.invocation_ref, signal: attempt.abort.signal });
      } catch (error) {
        // This host-owned check rejected before the provider effect. Unlike an
        // unknown create acknowledgement, it must not disable known-resource cleanup.
        preEffectDenials.add(error);
        throw error;
      }
    }
    assertAttemptOpen(attempt); // The await continuation is a separate interruption checkpoint.
    return { provider, context };
  }

  async function invoke(attempt, method, input) {
    const { provider, context } = await effectPreflight(attempt, method);
    assertAttemptOpen(attempt);
    const boundInput = deepFreeze(cloneJson(input, 'bound provider operation'));
    const inputHash = sha256Ref(boundInput);
    let used = false; let authorized = false; let finished = false;
    const invalidFence = () => {
      const error = managedError('Broker effect fence is no longer usable', 'WORKER_BROKER_FENCE_INVALID', 409);
      brokerFenceErrors.add(error);
      return error;
    };
    const effectFence = async () => {
      if (used || finished) throw invalidFence();
      used = true;
      const fresh = await effectPreflight(attempt, method);
      if (finished) throw invalidFence();
      assertAttemptOpen(attempt);
      authorized = true;
      return fresh.context;
    };
    // Never hand the callback a usable raw provider. The single allowed method
    // re-fences after any callback wait, binds the exact closed input, and is
    // permanently retired after one dispatch or callback completion.
    let dispatched = false; let settled = false; let actualResult; let actualHash;
    const boundProvider = Object.freeze(Object.assign(Object.create(null), {
      id: provider.id, capabilities: provider.capabilities,
      [method]: (suppliedInput) => {
        const call = (async () => {
          if (!authorized || dispatched || finished || sha256Ref(cloneJson(suppliedInput, 'broker operation')) !== inputHash) {
            throw invalidFence();
          }
          dispatched = true;
          let fresh;
          try { fresh = await effectPreflight(attempt, method); }
          catch (error) {
            // Retirement can also abort a suspended renewal. Classify the
            // retired capability using private state, not the provider's code.
            if (finished) throw invalidFence();
            throw error;
          }
          if (finished) throw invalidFence();
          assertAttemptOpen(attempt);
          const returned = await fresh.provider[method](boundInput, fresh.context);
          actualResult = returned === undefined ? undefined : deepFreeze(cloneJson(returned, 'provider result'));
          actualHash = actualResult === undefined ? null : sha256Ref(actualResult);
          settled = true;
          return actualResult;
        })();
        // Even a broker that drops this promise cannot manufacture settlement
        // or turn the rejected callback into an unhandled background rejection.
        pendingProviderCalls.add(call);
        attempt.providerCalls.add(call);
        const releaseCall = () => {
          pendingProviderCalls.delete(call);
          attempt.providerCalls.delete(call);
          releaseAttemptLinkage(attempt);
        };
        call.then(releaseCall, releaseCall);
        return call;
      },
    }));
    let result;
    try {
      result = await invokeProvider({ provider: boundProvider, method, input: boundInput, context, effectFence, signal: attempt.abort.signal });
      if (!authorized || !dispatched || !settled
        || (result === undefined ? null : sha256Ref(cloneJson(result, 'broker result'))) !== actualHash) {
        attempt.uncertain = true;
        throw managedError('Broker did not await its effect fence; recovery is required', 'WORKER_BROKER_FENCE_REQUIRED', 409);
      }
    } catch (error) {
      // Only driver-private state/identity classifies a broker violation. An
      // arbitrary provider error.code is not authority, nor does a caught
      // duplicate-capability denial invalidate the first successful fence.
      if (!authorized || brokerFenceErrors.has(error) || (dispatched && !settled)) attempt.uncertain = true;
      throw error;
    } finally { finished = true; }
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
    try {
    const evidence = [];
    let failed = false;
    const incomplete = () => managedError('Cleanup is incomplete; retained work requires recovery', 'WORKER_CLEANUP_FAILED', 409);
    for (const request of verifyManagedCleanupPlan(attempt.invocation)) {
      const fork = request.resource_kind === 'fork';
      const input = { [fork ? 'fork_ref' : 'savepoint_ref']: request.resource_ref, cleanup_request: request };
      // prepare already destroyed these resources. Collect fresh managed-plan
      // evidence without silently requiring a second destroy to be idempotent.
      // Recovery/public cleanup still owns destruction of uncertain resources.
      try {
        if (!verifyOnly) await invoke(attempt, fork ? 'destroyFork' : 'destroySavepoint', input);
        evidence.push(await invoke(attempt, fork ? 'verifyDestroyed' : 'verifySavepointDestroyed', input));
      } catch {
        assertAttemptOpen(attempt);
        if (attempt.uncertain) throw incomplete();
        // A resource-local failure does not authorize absence or a replay. The
        // next independent resource gets its own current-authority preflight;
        // a lease/credential/binding/broker failure stops further callbacks.
        failed = true;
      }
    }
    if (failed) throw incomplete();
    await fence(attempt);
    return await control.completeCleanup(principals.cleanup, {
      invocation_ref: ref, lease_token: attempt.leaseToken, cleanup_evidence: evidence,
    });
    } catch (error) {
      // No callback retry and no provider/root-cause claim. Unknown completion
      // may already have committed: the store rejects terminal/stale authority.
      // Abort/close alone is not an incomplete-observation classification.
      if (!closed && !attempt.abort.signal.aborted) {
        try {
          await control.recordCleanupIncomplete(principals.cleanup, {
            invocation_ref: ref, lease_token: attempt.leaseToken, lease_generation: attempt.claimGeneration,
          });
        } catch { /* Preserve the original failure and the cleanup obligation. */ }
      }
      throw error;
    } finally { finishAttempt(attempt); }
  }

  async function execute(ref, policyFence) {
    const attempt = await claim('execution', ref);
    watchCancellation(attempt);
    try {
    // Claim acknowledgement can arrive after stop/close. No host preparation
    // callback may start merely because the durable claim once succeeded.
    assertAttemptOpen(attempt);
    attempt.policyFence = policyFence;
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
          if (['createSavepoint', 'createFork'].includes(method) && !preEffectDenials.has(error)) attempt.uncertain = true;
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
    // Normal outcome handoff retires the execution lease. A pending observer
    // snapshot must not mistake cleanup's new generation for execution failure.
    // Cancellation after handoff remains enforced by completeCleanup/import.
    attempt.watchingCancellation = false;
    clearTimeout(attempt.timer);
    const terminal = await once('cleanup', ref, (invocationRef) => cleanup(invocationRef, { verifyOnly: true }));
    assertAttemptOpen(attempt);
    if (terminal.state !== 'completed') throw managedError('Managed cleanup did not complete', 'WORKER_CLEANUP_FAILED', 409);
    // Original process-local controller/receipt only. A serialized prepared
    // object still loses the core provenance brand and cannot be committed.
    return Object.freeze({ controller, prepared, invocation: terminal,
      production_qualified: false, live_traffic_protected: false });
    } finally { finishAttempt(attempt); }
  }

  async function recover(ref) {
    const attempt = await claim('recovery', ref);
    try {
    const { provider, context } = await fence(attempt);
    assertAttemptOpen(attempt);
    const found = cloneJson(await lookupResources({ provider, context,
      invocation: attempt.invocation, signal: attempt.abort.signal }), 'recovery lookup');
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
    } finally { finishAttempt(attempt); }
  }

  return Object.freeze({
    execute(ref, decision) {
      assertOpen('execution');
      const invocationRef = requireInvocationRef(ref, 'invocation_ref');
      const policyFence = requestPolicy ? requestPolicy.createDispatchFence(decision, {
        principal: principals.execution, invocationRef, timeoutMs: policyTimeoutMs,
      }) : undefined;
      if (!requestPolicy && decision !== undefined) throw new TypeError('A policy decision requires its original worker policy');
      return once('execution', invocationRef, (value) => execute(value, policyFence));
    },
    cleanup: (ref) => once('cleanup', ref, cleanup),
    recover: (ref) => once('recovery', ref, recover),
    stopExecution() {
      executionStopped = true;
      for (const attempt of activeAttempts) if (attempt.kind === 'execution') attempt.abort.abort();
      return Object.freeze({ execution_stopped: true, pending_attempts: pendingAttempts.size,
        pending_provider_callbacks: pendingProviderCalls.size,
        termination_proven: false, cleanup_recovery_available: !closed });
    },
    status: () => Object.freeze({ closed, execution_stopped: executionStopped,
      pending_attempts: pendingAttempts.size, pending_provider_callbacks: pendingProviderCalls.size,
      retained_attempts: attempts.size, termination_proven: false }),
    close() {
      closed = true; shutdown.abort();
      for (const attempt of activeAttempts) clearTimeout(attempt.timer);
      return Object.freeze({ closed: true, pending_attempts: pendingAttempts.size,
        pending_provider_callbacks: pendingProviderCalls.size,
        termination_proven: false, recovery_requires_fresh_worker: true });
    },
    production_qualified: false, live_traffic_protected: false,
  });
}
