import { AsyncLocalStorage } from 'node:async_hooks';

const LOOPBACK_SCOPE = new AsyncLocalStorage();
const LOOPBACK_PERMISSION = Symbol('agoragentic.risk-fork.demo.literal-loopback');

export function isRiskForkDemoLoopbackAllowed() {
  return LOOPBACK_SCOPE.getStore() === LOOPBACK_PERMISSION;
}

export function runWithRiskForkDemoLoopback(callback) {
  if (typeof callback !== 'function') {
    throw new TypeError('Risk Fork demo loopback scope requires a callback');
  }
  return LOOPBACK_SCOPE.run(LOOPBACK_PERMISSION, callback);
}
