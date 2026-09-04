import dgram from 'node:dgram';
import dns from 'node:dns';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';

import { isRiskForkDemoLoopbackAllowed } from './network-scope.mjs';

const INSTALL_MARKER = Symbol.for('agoragentic.risk-fork.demo.network-guard.v1');
const originalFetch = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null;
const require = createRequire(import.meta.url);
const DNS_RESOLUTION_METHODS = Object.freeze([
  'resolve',
  'resolve4',
  'resolve6',
  'resolveAny',
  'resolveCaa',
  'resolveCname',
  'resolveMx',
  'resolveNaptr',
  'resolveNs',
  'resolvePtr',
  'resolveSoa',
  'resolveSrv',
  'resolveTlsa',
  'resolveTxt',
  'reverse',
]);

export const NETWORK_GUARD_BANNER =
  'DEMO ONLY — LOCAL PROTOCOL SIMULATOR — NOT AN ISOLATION BOUNDARY — NO LIVE PROTECTION';

export class RiskForkDemoNetworkBlockedError extends Error {
  constructor(transport, host = null) {
    super(`Risk Fork demo network guard blocked ${transport}${host ? ` to ${host}` : ''}`);
    this.name = 'RiskForkDemoNetworkBlockedError';
    this.code = 'RISK_FORK_DEMO_NETWORK_BLOCKED';
    this.transport = transport;
    this.host = host;
  }
}

export function isLoopbackHost(value, { allowUrlBrackets = false } = {}) {
  if (typeof value !== 'string') return false;
  const host = value.toLowerCase();
  return host === '127.0.0.1'
    || host === '::1'
    || (allowUrlBrackets && host === '[::1]');
}

function inspectLoopbackUrl(input) {
  const raw = typeof input === 'string' ? input : null;
  let url;
  try {
    if (raw !== null && raw !== raw.trim()) {
      return { allowed: false, host: 'non-literal-url' };
    }
    url = input instanceof URL ? input : new URL(input);
  } catch {
    return { allowed: false, host: 'invalid-or-relative-url' };
  }
  const host = url.hostname;
  if (url.username || url.password || !isLoopbackHost(host, { allowUrlBrackets: true })) {
    return { allowed: false, host };
  }
  if (raw !== null) {
    const authority = /^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i.exec(raw)?.[1] ?? null;
    const exactAuthority = host === '127.0.0.1'
      ? /^127\.0\.0\.1(?::\d+)?$/.test(authority ?? '')
      : /^\[::1\](?::\d+)?$/.test(authority ?? '');
    if (!exactAuthority) return { allowed: false, host };
  }
  return { allowed: true, host };
}

function loopbackAllowed() {
  return isRiskForkDemoLoopbackAllowed();
}

function hostFromConnectArguments(args) {
  const first = args[0];
  if (Array.isArray(first)) return hostFromConnectArguments(first);
  if (first && typeof first === 'object') {
    if (typeof first.path === 'string') return { host: first.path, isPipe: true };
    return { host: typeof first.host === 'string' ? first.host : 'localhost', isPipe: false };
  }
  if (typeof first === 'string' && !/^\d+$/.test(first)) {
    return { host: first, isPipe: true };
  }
  return {
    host: typeof args[1] === 'string' ? args[1] : 'localhost',
    isPipe: false,
  };
}

function assertSocketAllowed(transport, args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first && typeof first === 'object' && typeof first.lookup === 'function') {
    throw new RiskForkDemoNetworkBlockedError(transport, 'custom-lookup-forbidden');
  }
  const { host, isPipe } = hostFromConnectArguments(args);
  if (!isPipe && loopbackAllowed() && isLoopbackHost(host)) return;
  throw new RiskForkDemoNetworkBlockedError(transport, isPipe ? 'local-or-remote-pipe' : host);
}

function blockAlways(transport) {
  return function blockedNetworkOperation(...args) {
    const candidate = args.find((value) => typeof value === 'string') ?? null;
    throw new RiskForkDemoNetworkBlockedError(transport, candidate);
  };
}

function guardedConnect(original, transport) {
  return function riskForkDemoGuardedConnect(...args) {
    assertSocketAllowed(transport, args);
    return Reflect.apply(original, this, args);
  };
}

function guardHttpRequest(original, transport) {
  return function riskForkDemoGuardedHttpRequest(...args) {
    const first = args[0];
    let host = 'localhost';
    let allowed = false;
    if (typeof first === 'string' || first instanceof URL) {
      const inspected = inspectLoopbackUrl(first);
      host = inspected.host;
      allowed = inspected.allowed;
    } else if (first && typeof first === 'object') {
      host = first.hostname ?? first.host ?? 'localhost';
      allowed = isLoopbackHost(host);
    }
    if (!(loopbackAllowed() && allowed)) {
      throw new RiskForkDemoNetworkBlockedError(transport, String(host));
    }
    return Reflect.apply(original, this, args);
  };
}

function replaceMethod(target, name, replacement) {
  const descriptor = Object.getOwnPropertyDescriptor(target, name);
  if (!descriptor || typeof descriptor.value !== 'function') return false;
  Object.defineProperty(target, name, {
    ...descriptor,
    value: replacement(descriptor.value),
  });
  return true;
}

function installDnsGuards() {
  const guarded = [];
  if (typeof dns.lookup === 'function') {
    const originalLookup = dns.lookup;
    dns.lookup = function riskForkDemoGuardedDnsLookup(hostname, ...args) {
      if (!(loopbackAllowed() && isLoopbackHost(hostname))) {
        throw new RiskForkDemoNetworkBlockedError('dns.lookup', String(hostname));
      }
      return Reflect.apply(originalLookup, this, [hostname, ...args]);
    };
    guarded.push('node:dns.lookup');
  }
  if (dns.promises && typeof dns.promises.lookup === 'function') {
    const originalPromiseLookup = dns.promises.lookup;
    dns.promises.lookup = function riskForkDemoGuardedPromiseDnsLookup(hostname, ...args) {
      if (!(loopbackAllowed() && isLoopbackHost(hostname))) {
        throw new RiskForkDemoNetworkBlockedError('dns.promises.lookup', String(hostname));
      }
      return Reflect.apply(originalPromiseLookup, this, [hostname, ...args]);
    };
    guarded.push('node:dns.promises.lookup');
  }
  for (const name of [...DNS_RESOLUTION_METHODS, 'lookupService']) {
    if (typeof dns[name] === 'function') {
      dns[name] = blockAlways(`dns.${name}`);
      guarded.push(`node:dns.${name}`);
    }
    if (dns.promises && typeof dns.promises[name] === 'function') {
      dns.promises[name] = blockAlways(`dns.promises.${name}`);
      guarded.push(`node:dns.promises.${name}`);
    }
  }
  for (const [Resolver, label] of [
    [dns.Resolver, 'dns.Resolver'],
    [dns.promises?.Resolver, 'dns.promises.Resolver'],
  ]) {
    if (typeof Resolver !== 'function' || !Resolver.prototype) continue;
    for (const name of DNS_RESOLUTION_METHODS) {
      if (replaceMethod(Resolver.prototype, name, () => blockAlways(`${label}.${name}`))) {
        guarded.push(`node:${label}.${name}`);
      }
    }
  }
  return guarded;
}

function installUndiciGuards() {
  let undiciEntry;
  try {
    undiciEntry = require.resolve('undici');
  } catch (error) {
    if (error?.code === 'MODULE_NOT_FOUND') return [];
    throw error;
  }

  const undici = require(undiciEntry);
  const names = [
    'request',
    'stream',
    'pipeline',
    'connect',
    'fetch',
    'upgrade',
    'buildConnector',
    'getGlobalDispatcher',
    'setGlobalDispatcher',
    'Client',
    'Pool',
    'BalancedPool',
    'Agent',
    'ProxyAgent',
    'EnvHttpProxyAgent',
    'RetryAgent',
    'WebSocket',
    'EventSource',
  ];
  return names.filter((name) => replaceMethod(
    undici,
    name,
    () => blockAlways(`undici.${name}`),
  ));
}

export function installNetworkGuard() {
  if (globalThis[INSTALL_MARKER]) return globalThis[INSTALL_MARKER];

  const guardedSurfaces = [
    'node:net.Socket.connect',
    'node:dns',
    'globalThis.fetch',
  ];

  const originalSocketConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = guardedConnect(originalSocketConnect, 'net.Socket.connect');
  if (replaceMethod(net, 'connect', (original) => guardedConnect(original, 'net.connect'))) {
    guardedSurfaces.push('node:net.connect');
  }
  if (replaceMethod(net, 'createConnection', (original) => guardedConnect(original, 'net.createConnection'))) {
    guardedSurfaces.push('node:net.createConnection');
  }
  if (replaceMethod(tls, 'connect', (original) => guardedConnect(original, 'tls.connect'))) {
    guardedSurfaces.push('node:tls.connect');
  }

  for (const [target, name, label] of [
    [http, 'request', 'http.request'],
    [http, 'get', 'http.get'],
    [https, 'request', 'https.request'],
    [https, 'get', 'https.get'],
  ]) {
    if (replaceMethod(target, name, (original) => guardHttpRequest(original, label))) {
      guardedSurfaces.push(`node:${label}`);
    }
  }
  if (replaceMethod(http2, 'connect', () => blockAlways('http2.connect'))) {
    guardedSurfaces.push('node:http2.connect');
  }

  if (replaceMethod(dgram.Socket.prototype, 'connect', () => blockAlways('dgram.connect'))) {
    guardedSurfaces.push('node:dgram.Socket.connect');
  }
  if (replaceMethod(dgram.Socket.prototype, 'send', () => blockAlways('dgram.send'))) {
    guardedSurfaces.push('node:dgram.Socket.send');
  }
  guardedSurfaces.push(...installDnsGuards());

  if (replaceMethod(globalThis, 'WebSocket', () => blockAlways('WebSocket'))) {
    guardedSurfaces.push('globalThis.WebSocket');
  }
  if (replaceMethod(globalThis, 'EventSource', () => blockAlways('EventSource'))) {
    guardedSurfaces.push('globalThis.EventSource');
  }

  const guardedUndiciNames = installUndiciGuards();
  guardedSurfaces.push(...guardedUndiciNames.map((name) => `undici.${name}`));

  // Keep named ESM imports of patched built-ins aligned with their default exports.
  syncBuiltinESMExports();

  Object.defineProperty(globalThis, 'fetch', {
    configurable: false,
    enumerable: true,
    writable: false,
    value: async function riskForkDemoGuardedFetch(input, init = undefined) {
      const inspected = inspectLoopbackUrl(input instanceof Request ? new URL(input.url) : input);
      if (!(loopbackAllowed() && inspected.allowed)) {
        throw new RiskForkDemoNetworkBlockedError('fetch', inspected.host);
      }
      if (!originalFetch) throw new RiskForkDemoNetworkBlockedError('fetch', 'unavailable');
      const guardedInit = init && typeof init === 'object'
        ? { ...init, redirect: 'manual' }
        : { redirect: 'manual' };
      return originalFetch(input, guardedInit);
    },
  });

  const status = Object.freeze({
    schema: 'agoragentic.risk-fork.demo-network-guard.v1',
    banner: NETWORK_GUARD_BANNER,
    installed: true,
    external_network_allowed: false,
    external_network_allowed_scope: 'guarded_in_process_apis_only',
    enforcement_scope: 'best_effort_in_process_api_guard',
    os_egress_enforced: false,
    guarded_surfaces: Object.freeze([...guardedSurfaces].sort()),
    loopback_allowed: loopbackAllowed(),
    loopback_scope: loopbackAllowed() ? ['127.0.0.1', '::1'] : [],
    demo_only: true,
    local_protocol_simulator: true,
    production_ready: false,
    live_traffic_protected: false,
    authority_granted: false,
    provider_calls: 0,
    network_used: false,
    network_used_scope: 'observed_demo_execution_only',
    credentials_used: false,
    clean_commit_performed: false,
  });
  Object.defineProperty(globalThis, INSTALL_MARKER, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: status,
  });
  return status;
}

installNetworkGuard();
