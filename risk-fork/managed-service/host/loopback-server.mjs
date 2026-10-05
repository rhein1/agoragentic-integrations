import { createServer } from 'node:http';
import { TextDecoder } from 'node:util';
import { requireInteger } from '../src/validation.mjs';

function normalizedRetryAfter(headers) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return {};
  const descriptor = Object.getOwnPropertyDescriptor(headers, 'retry-after');
  if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set || typeof descriptor.value !== 'string') return {};
  if (!/^(?:0|[1-9]\d{0,3})$/.test(descriptor.value)) return {};
  const seconds = Number(descriptor.value);
  return seconds <= 3600 ? { 'retry-after': String(seconds) } : {};
}

// Default-off loopback test ingress. This is NOT a production listener, public
// edge, reverse proxy, TLS terminator, OAuth issuer, or provider executor.
export function createManagedLoopbackServer({ enabled = false, handler,
  port = 0, maxBodyBytes = 65536, maxConnections = 16, deadlineMs = 2000 } = {}) {
  if (enabled !== true) throw new TypeError('Loopback listener requires explicit enabled:true');
  if (typeof handler !== 'function') throw new TypeError('handler is required');
  requireInteger(port, 'port', { min: 0, max: 65535 });
  requireInteger(maxBodyBytes, 'maxBodyBytes', { min: 1, max: 1048576 });
  requireInteger(maxConnections, 'maxConnections', { min: 1, max: 64 });
  requireInteger(deadlineMs, 'deadlineMs', { min: 100, max: 10000 });
  const sockets = new Set();
  let closing = false;
  let starting = null;
  const server = createServer({ maxHeaderSize: 8192, requireHostHeader: true,
    headersTimeout: deadlineMs, requestTimeout: deadlineMs, keepAliveTimeout: 100,
    joinDuplicateHeaders: false }, (request, response) => {
    let complete = false, size = 0;
    const chunks = [];
    const abort = new AbortController();
    const send = (status, body, headers = {}) => {
      if (complete || response.destroyed) return;
      complete = true; clearTimeout(timer); abort.abort();
      response.writeHead(status, { ...headers, 'content-type': 'application/json',
        'cache-control': 'no-store', connection: 'close' });
      response.end(JSON.stringify(body));
    };
    const timer = setTimeout(() => send(408, { error: { code: 'REQUEST_DEADLINE' } }), deadlineMs);
    response.on('close', () => { complete = true; clearTimeout(timer); abort.abort(); });
    request.on('error', () => send(400, { error: { code: 'INVALID_REQUEST' } }));
    // Reject duplicate headers, including Authorization/Content-Length; Node
    // joining or discarding duplicates must not choose a credential for us.
    const headers = Object.create(null);
    for (let i = 0; i < request.rawHeaders.length; i += 2) {
      const name = request.rawHeaders[i].toLowerCase();
      if (Object.hasOwn(headers, name)) { send(400, { error: { code: 'DUPLICATE_HEADER' } }); return; }
      headers[name] = request.rawHeaders[i + 1];
    }
    if (closing || headers['content-encoding'] || headers['transfer-encoding']) {
      send(400, { error: { code: 'UNSUPPORTED_REQUEST_ENCODING' } }); return;
    }
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBodyBytes) { chunks.length = 0; send(413, { error: { code: 'REQUEST_TOO_LARGE' } }); return; }
      if (!complete) chunks.push(chunk);
    });
    request.on('end', async () => {
      if (complete) return;
      try {
        const body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        const result = await handler({ method: request.method, path: request.url, headers, body, signal: abort.signal });
        if (!result || !Number.isInteger(result.status) || result.status < 100 || result.status > 599) throw new Error('invalid response');
        if (Buffer.byteLength(JSON.stringify(result.body), 'utf8') > 1048576) throw new Error('response too large');
        // Only the bounded rate-limit hint is transport-safe; never forward
        // arbitrary handler headers such as Location, cookies, or auth data.
        send(result.status, result.body, normalizedRetryAfter(result.headers));
      } catch { send(500, { error: { code: 'REQUEST_FAILED_CLOSED' } }); }
    });
  });
  server.maxConnections = maxConnections;
  server.maxRequestsPerSocket = 1;
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('clientError', (_error, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
  return Object.freeze({
    async start() {
      if (closing || starting || server.listening) throw new TypeError('Listener cannot be started again');
      starting = new Promise((resolve, reject) => {
        const failed = (error) => { server.off('listening', started); reject(error); };
        const started = () => { server.off('error', failed); resolve(); };
        server.once('error', failed); server.once('listening', started);
        server.listen(port, '127.0.0.1');
      });
      try { await starting; } finally { starting = null; }
      if (closing) throw new TypeError('Listener closed while starting');
      return Object.freeze({ url: `http://127.0.0.1:${server.address().port}`,
        listener_scope: 'local_test_only', production_qualified: false });
    },
    async close() {
      closing = true;
      // A failed sibling listener must not leave this pending bind alive.
      if (starting) await starting.catch(() => {});
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
    production_qualified: false,
  });
}
