// Loaded before the module graph by the CLI tests. No network is attempted.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import dgram from 'node:dgram';
import { syncBuiltinESMExports } from 'node:module';
const denied = () => { throw new Error('RUNPAY_TEST_NETWORK_FORBIDDEN'); };
globalThis.fetch = denied;
if (globalThis.WebSocket) globalThis.WebSocket = class { constructor() { denied(); } };
http.request = http.get = https.request = https.get = denied;
net.connect = net.createConnection = net.Socket.prototype.connect = tls.connect = denied;
dgram.createSocket = denied;
for (const key of Object.keys(dns)) if (key === 'lookup' || key.startsWith('resolve')) if (typeof dns[key] === 'function') dns[key] = denied;
for (const key of Object.keys(dns.promises)) if (key === 'lookup' || key.startsWith('resolve')) if (typeof dns.promises[key] === 'function') dns.promises[key] = denied;
syncBuiltinESMExports();
