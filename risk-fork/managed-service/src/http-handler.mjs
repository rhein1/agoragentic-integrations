import {
  assertAllowedKeys,
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
  const retry = code === 'RATE_LIMITED' && Number.isInteger(error?.retry_after_seconds)
    && error.retry_after_seconds >= 0 && error.retry_after_seconds <= 3600
    ? { 'retry-after': String(error.retry_after_seconds) } : {};
  return response(status, { error: { code, message } }, retry);
}

function createHandler(controlPlane, authenticator, allowPublicRoutes, allowWorkerRoutes, requestPolicy) {
  if (!controlPlane || typeof controlPlane.health !== 'function') {
    throw new TypeError('HTTP handler requires a managed control plane');
  }
  if (!authenticator || typeof authenticator.authenticate !== 'function') {
    throw new TypeError('HTTP handler requires a managed authenticator');
  }
  if (requestPolicy !== undefined && (!requestPolicy || typeof requestPolicy.beforeMutation !== 'function')) {
    throw new TypeError('requestPolicy must be a host-owned managed request policy');
  }

  return async function handleManagedServiceRequest(request = {}) {
    try {
      assertPlainRecord(request, 'HTTP request');
      const method = requireString(request.method, 'HTTP request.method', { maxBytes: 16 }).toUpperCase();
      const path = requireString(request.path, 'HTTP request.path', { maxBytes: 512 });
      const headers = request.headers ?? {};
      function checkDeadline() {
        if (request.signal?.aborted) {
          throw managedError('Request deadline expired', 'REQUEST_TIMEOUT', 408);
        }
      }
      checkDeadline();
      async function authenticate(scope, routeClass) {
        const principal = await authenticator.authenticate(
          authorization, scope, Object.freeze({ method, path }),
        );
        checkDeadline();
        if (requestPolicy !== undefined) {
          await requestPolicy.beforeMutation({ principal, routeClass, signal: request.signal });
          checkDeadline();
        }
        return principal;
      }

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

      if (allowPublicRoutes && method === 'POST' && path === '/v1/invocations') {
        const principal = await authenticate('invocations:write', 'admission');
        const result = await controlPlane.admitInvocation(principal, body);
        return response(result.created ? 201 : 200, result);
      }

      const invocationMatch = /^\/v1\/invocations\/([A-Za-z0-9][A-Za-z0-9._:@-]{0,199})$/.exec(path);
      const cancellationMatch = /^\/v1\/invocations\/([A-Za-z0-9][A-Za-z0-9._:@-]{0,199})\/cancel$/.exec(path);
      if (allowPublicRoutes && method === 'POST' && cancellationMatch) {
        // Recovery-class policy keeps owner cancellation available when new
        // admissions/execution are disabled. It grants no worker authority.
        const principal = await authenticate('invocations:cancel', 'recovery');
        if (Object.hasOwn(body, 'invocation_ref')) {
          throw managedError('Cancellation target must be supplied only by the URL path', 'AMBIGUOUS_INVOCATION_TARGET', 400);
        }
        return response(200, await controlPlane.requestCancellation(principal,
          { ...cloneJson(body, 'cancellation request'), invocation_ref: cancellationMatch[1] }));
      }
      if (allowPublicRoutes && method === 'GET' && invocationMatch) {
        const principal = await authenticate('invocations:read', 'read');
        return response(200, await controlPlane.getInvocation(principal, invocationMatch[1]));
      }

      const auditMatch = /^\/v1\/invocations\/([A-Za-z0-9][A-Za-z0-9._:@-]{0,199})\/audit$/.exec(path);
      if (allowPublicRoutes && method === 'GET' && auditMatch) {
        const principal = await authenticate('audit:read', 'read');
        return response(200, {
          events: await controlPlane.listAuditEvents(principal, auditMatch[1]),
          evidence_class: 'control_plane_self_attested',
        });
      }

      const workerMatch = /^\/internal\/v1\/invocations\/([A-Za-z0-9][A-Za-z0-9._:@-]{0,199})\/(claim-execution|claim-cleanup|claim-recovery|renew|renew-execution|renew-cleanup|renew-recovery|resources|resources-execution|resources-recovery|outcome|cleanup|recovery-absent)$/.exec(path);
      if (allowWorkerRoutes && method === 'POST' && workerMatch) {
        const [, ref, action] = workerMatch;
        const purpose = action.includes('execution') || action === 'outcome'
          || action === 'renew' || action === 'resources'
          ? 'execution'
          : action.includes('cleanup') || action === 'cleanup'
            ? 'cleanup'
            : 'recovery';
        const claim = action.startsWith('claim-');
        const principal = await authenticate(`worker:${purpose}:${claim ? 'claim' : 'write'}`, purpose);
        if (Object.hasOwn(body, 'invocation_ref') || Object.hasOwn(body, 'expected_lease_kind')) {
          throw managedError(
            'Worker request target must be supplied only by the URL path',
            'AMBIGUOUS_INVOCATION_TARGET',
            400,
          );
        }
        const input = cloneJson(body, 'worker request');
        input.invocation_ref = ref;
        if (!claim) input.expected_lease_kind = purpose;
        const methods = {
          'claim-execution': 'claimExecution',
          'claim-cleanup': 'claimCleanup',
          'claim-recovery': 'claimRecovery',
          'renew-execution': 'renewLease',
          renew: 'renewLease',
          'renew-cleanup': 'renewLease',
          'renew-recovery': 'renewLease',
          'resources-execution': 'recordResources',
          resources: 'recordResources',
          'resources-recovery': 'recordResources',
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

export function createManagedServiceHttpHandler(options = {}) {
  assertPlainRecord(options, 'public handler options');
  assertAllowedKeys(options, ['controlPlane', 'authenticator', 'requestPolicy'], 'public handler options');
  return createHandler(options.controlPlane, options.authenticator, true, false, options.requestPolicy);
}

export function createManagedWorkerHttpHandler(options = {}) {
  assertPlainRecord(options, 'worker handler options');
  assertAllowedKeys(options, ['controlPlane', 'workerAuthenticator', 'requestPolicy'], 'worker handler options');
  const { controlPlane, workerAuthenticator } = options;
  if (!workerAuthenticator) throw new TypeError('workerAuthenticator is required');
  return createHandler(controlPlane, workerAuthenticator, false, true, options.requestPolicy);
}
