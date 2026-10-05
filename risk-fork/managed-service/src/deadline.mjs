import { assertAllowedKeys, assertPlainRecord, requireInteger } from './validation.mjs';

// Internal host-owned wait lifetime, not an authority token or termination
// guarantee. Awaited deadlines retain Node until settlement/timeout; optional
// nonblocking observations may opt out of retaining the process.
export function createManagedDeadline(timeoutMs, options = {}) {
  requireInteger(timeoutMs, 'deadline timeoutMs', { min: 50, max: 30_000 });
  assertPlainRecord(options, 'deadline options');
  assertAllowedKeys(options, ['signal', 'referenced'], 'deadline options');
  const { signal: parent, referenced = true } = options;
  if (parent !== undefined && !(parent instanceof AbortSignal)) throw new TypeError('deadline signal is invalid');
  if (typeof referenced !== 'boolean') throw new TypeError('deadline referenced must be boolean');
  const controller = new AbortController();
  let timer, onParentAbort, resolveAborted;
  const aborted = new Promise((resolve) => { resolveAborted = resolve; });
  function dispose() {
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
    if (onParentAbort !== undefined) { parent.removeEventListener('abort', onParentAbort); onParentAbort = undefined; }
  }
  function abort(reason) {
    dispose();
    resolveAborted(null);
    controller.abort(reason);
  }
  if (parent?.aborted) abort(parent.reason);
  else {
    timer = setTimeout(() => abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), timeoutMs);
    if (!referenced) timer.unref();
    if (parent !== undefined) {
      onParentAbort = () => abort(parent.reason);
      parent.addEventListener('abort', onParentAbort, { once: true });
    }
  }
  return Object.freeze({ signal: controller.signal, aborted, dispose });
}
