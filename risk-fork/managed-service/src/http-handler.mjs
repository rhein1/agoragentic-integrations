import {
  assertPlainRecord,
  cloneJson,
  managedError,
  requireString,
} from './validation.mjs';
import { MANAGED_SERVICE_PROTOCOL_LIMITS } from './constants.mjs';

function response(status, body, headers = {}) {
  return Object.freeze({
    status,
    headers: Object.freeze({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    }),
    body: Object.freeze(body),
  });
}

function readHeader(headers, wanted) {
  assertPlainRecord(headers, 'request headers');
  const matches = Object.entries(headers).filter(
    ([name]) => name.toLowerCase() === wanted.toLowerCase(),
  );
  if (matches.length !== 1 || typeof matches[0][1] !== 'string') return null;
  return matches[0][1];
}

function parseBody(value, maxBytes) {
  if (typeof value !== 'string') {
    throw managedError('Request body must be JSON text', 'INVALID_JSON_BODY', 400);
  }
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw managedError('Request body is too large', 'REQUEST_TOO_LARGE', 413);
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw managedError('Request body is invalid JSON', 'INVALID_JSON_BODY', 400);
  }
  assertPlainRecord(parsed, 'request body');
  return parsed;
}

function safeError(error) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error.status
    : error instanceof TypeError
      ? 400
      : 500;
  const code = typeof error?.code === 'string'
    ? error.code
    : status === 500
      ? 'INTERNAL_ERROR'
      : 'INVALID_REQUEST';
  const message = status === 500 ? 'Request failed closed' : String(error.message);
  return response(status, { error: { code, message } });
}

export function createManagedServiceHttpHandler({ controlPlane, authenticator } = {}) {
  if (!controlPlane || typeof controlPlane.health !== 'function') {
    throw new TypeError('HTTP handler requires a managed control plane');
  }
  if (!authenticator || typeof authenticator.authenticate !== 'function') {
    throw new TypeError('HTTP handler requires a managed authenticator');
  }

  return async function handleManagedServiceRequest(request = {}) {
    try {
      assertPlainRecord(request, 'HTTP request');
      const method = requireString(request.method, 'HTTP request.method', { maxBytes: 16 }).toUpperCase();
      const path = requireString(request.path, 'HTTP request.path', { maxBytes: 512 });
      const headers = request.headers ?? {};

      if (method === 'GET' && path === '/healthz') {
        return response(200, {
          alive: true,
          deployed: false,
          live_traffic_protected: false,
        });
      }
      if (method === 'GET' && path === '/readyz') {
        const health = await controlPlane.health();
        return response(health.ready ? 200 : 503, {
          ready: health.ready,
          readiness_scope: health.readiness_scope,
          production_qualified: false,
          deployed: false,
          live_traffic_protected: false,
        });
      }

      const authorization = readHeader(headers, 'authorization');
      if (authorization === null) {
        throw managedError('Bearer authentication is required', 'AUTHENTICATION_REQUIRED', 401);
      }
      if (method === 'POST') {
        const contentType = readHeader(headers, 'content-type');
        if (contentType === null
          || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) {
          throw managedError('Content-Type application/json is required', 'UNSUPPORTED_MEDIA_TYPE', 415);
        }
      }
      const body = method === 'POST'
        ? parseBody(request.body, MANAGED_SERVICE_PROTOCOL_LIMITS.max_request_bytes)
        : null;

      if (method === 'POST' && path === '/v1/invocations') {
        const principal = await authenticator.authenticate(authorization, 'invocations:write');
        const result = await controlPlane.admitInvocation(principal, body);
        return response(result.created ? 201 : 200, result);
      }

      const invocationMatch = /^\/v1\/invocations\/([A-Za-z0-9][A-Za-z0-9._:@-]{0,199})$/.exec(path);
      if (method === 'GET' && invocationMatch) {
        const principal = await authenticator.authenticate(authorization, 'invocations:read');
        return response(200, await controlPlane.getInvocation(principal, invocationMatch[1]));
      }

      const auditMatch = /^\/v1\/invocations\/([A-Za-z0-9][A-Za-z0-9._:@-]{0,199})\/audit$/.exec(path);
      if (method === 'GET' && auditMatch) {
        const principal = await authenticator.authenticate(authorization, 'audit:read');
        return response(200, {
          events: await controlPlane.listAuditEvents(principal, auditMatch[1]),
          evidence_class: 'control_plane_self_attested',
        });
      }

      const workerMatch = /^\/internal\/v1\/invocations\/([A-Za-z0-9][A-Za-z0-9._:@-]{0,199})\/(claim-execution|claim-cleanup|claim-recovery|renew|resources|outcome|cleanup|recovery-absent)$/.exec(path);
      if (method === 'POST' && workerMatch) {
        const [, ref, action] = workerMatch;
        const principal = await authenticator.authenticate(
          authorization,
          action.startsWith('claim-') ? 'worker:claim' : 'worker:write',
        );
        if (Object.hasOwn(body, 'invocation_ref')) {
          throw managedError(
            'Worker request target must be supplied only by the URL path',
            'AMBIGUOUS_INVOCATION_TARGET',
            400,
          );
        }
        const input = cloneJson(body, 'worker request');
        input.invocation_ref = ref;
        const methods = {
          'claim-execution': 'claimExecution',
          'claim-cleanup': 'claimCleanup',
          'claim-recovery': 'claimRecovery',
          renew: 'renewLease',
          resources: 'recordResources',
          outcome: 'recordExecutionOutcome',
          cleanup: 'completeCleanup',
          'recovery-absent': 'completeRecoveryAbsence',
        };
        return response(200, await controlPlane[methods[action]](principal, input));
      }

      return response(404, { error: { code: 'NOT_FOUND', message: 'Route was not found' } });
    } catch (error) {
      return safeError(error);
    }
  };
}
