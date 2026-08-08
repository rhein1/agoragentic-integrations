import dgram from 'node:dgram';
import dns from 'node:dns';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';

const state = {
  attempts: 0,
  last_api: null,
};

function deny(api) {
  return function networkDisabled() {
    state.attempts += 1;
    state.last_api = api;
    const error = new Error('Network access is disabled inside the parser process.');
    error.code = 'network_disabled';
    throw error;
  };
}

function replace(target, key, api) {
  if (!target || !(key in target)) return;
  try {
    target[key] = deny(api);
  } catch {
    // A read-only optional API is already unavailable to parser code.
  }
}

for (const key of ['request', 'get']) replace(http, key, `http.${key}`);
for (const key of ['request', 'get']) replace(https, key, `https.${key}`);
replace(http.Agent?.prototype, 'createConnection', 'http.Agent.createConnection');
replace(https.Agent?.prototype, 'createConnection', 'https.Agent.createConnection');
replace(http2, 'connect', 'http2.connect');

for (const key of ['connect', 'createConnection']) replace(net, key, `net.${key}`);
replace(net.Socket?.prototype, 'connect', 'net.Socket.connect');
replace(tls, 'connect', 'tls.connect');

replace(dgram, 'createSocket', 'dgram.createSocket');
replace(dgram.Socket?.prototype, 'connect', 'dgram.Socket.connect');
replace(dgram.Socket?.prototype, 'send', 'dgram.Socket.send');

for (const key of Object.keys(dns)) {
  if (key === 'promises' || typeof dns[key] !== 'function') continue;
  replace(dns, key, `dns.${key}`);
}
for (const key of Object.keys(dns.promises || {})) {
  if (typeof dns.promises[key] === 'function') replace(dns.promises, key, `dns.promises.${key}`);
}
for (const key of Object.getOwnPropertyNames(dns.Resolver?.prototype || {})) {
  if (key !== 'constructor' && typeof dns.Resolver.prototype[key] === 'function') {
    replace(dns.Resolver.prototype, key, `dns.Resolver.${key}`);
  }
}

for (const key of ['fetch', 'WebSocket', 'EventSource']) {
  if (typeof globalThis[key] === 'function') replace(globalThis, key, `globalThis.${key}`);
}

syncBuiltinESMExports();

export function networkBoundaryState() {
  return { ...state };
}
