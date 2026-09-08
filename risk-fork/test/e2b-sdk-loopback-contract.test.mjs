import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { Sandbox } from 'e2b';

import {
  buildE2BCleanSandboxCreateOptions,
  validateE2BSandboxInfo,
} from '../src/adapters/e2b.mjs';

const SANDBOX_ID = 'sandbox-loopback-contract';
const TEMPLATE_ID = 'template-loopback-contract';
const CREATED_AT_MS = Date.parse('2030-01-01T00:00:00.000Z');
const TIMEOUT_MS = 70_000;
const METADATA = Object.freeze({
  'agoragentic.risk_fork.profile': 'agoragentic.risk-fork.e2b-live-qualification.v1',
  'agoragentic.risk_fork.run_hash': `sha256:${'a'.repeat(64)}`,
});

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return { raw: null, value: null };
  const raw = Buffer.concat(chunks).toString('utf8');
  return { raw, value: JSON.parse(raw) };
}

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

async function listenLoopback(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Loopback server address is absent');
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server) {
  await new Promise((resolve, reject) => server.close((error) => (
    error ? reject(error) : resolve()
  )));
}

function countingProxy(target, onTrap) {
  return new Proxy(target, {
    get(...args) {
      onTrap();
      return Reflect.get(...args);
    },
    getPrototypeOf(...args) {
      onTrap();
      return Reflect.getPrototypeOf(...args);
    },
    ownKeys(...args) {
      onTrap();
      return Reflect.ownKeys(...args);
    },
    getOwnPropertyDescriptor(...args) {
      onTrap();
      return Reflect.getOwnPropertyDescriptor(...args);
    },
  });
}

test('clean creation options are exact, immutable, and authority-free', () => {
  const options = buildE2BCleanSandboxCreateOptions({
    timeoutMs: TIMEOUT_MS,
    metadata: METADATA,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(options)), {
    timeoutMs: TIMEOUT_MS,
    secure: true,
    allowInternetAccess: false,
    network: {
      allowOut: [],
      denyOut: ['0.0.0.0/0'],
      allowPublicTraffic: false,
    },
    lifecycle: { onTimeout: 'kill', autoResume: false },
    metadata: METADATA,
    envs: {},
    iam: { tokens: {} },
    volumeMounts: {},
  });
  assert.ok(Object.isFrozen(options));
  assert.ok(Object.isFrozen(options.network));
  assert.ok(Object.isFrozen(options.metadata));
  for (const selector of [options.network.allowOut, options.network.denyOut]) {
    assert.equal(Array.isArray(selector), true);
    assert.equal(Object.getPrototypeOf(selector), null);
    assert.ok(Object.isFrozen(selector));
  }
  for (const record of [
    options,
    options.network,
    options.lifecycle,
    options.metadata,
    options.envs,
    options.iam,
    options.iam.tokens,
    options.volumeMounts,
  ]) {
    assert.equal(Object.getPrototypeOf(record), null);
  }
  assert.equal('apiKey' in options, false);
  assert.equal('accessToken' in options, false);
  assert.throws(
    () => buildE2BCleanSandboxCreateOptions({
      timeoutMs: TIMEOUT_MS,
      metadata: METADATA,
      apiKey: 'not-permitted',
    }),
    /unsupported/,
  );
  assert.throws(
    () => buildE2BCleanSandboxCreateOptions({
      timeoutMs: TIMEOUT_MS,
      metadata: {
        ...METADATA,
        'agoragentic.risk_fork.extra': 'not-permitted',
      },
    }),
    /unsupported key/,
  );
  assert.throws(
    () => buildE2BCleanSandboxCreateOptions({
      timeoutMs: TIMEOUT_MS,
      metadata: {
        'agoragentic.risk_fork.profile': METADATA['agoragentic.risk_fork.profile'],
      },
    }),
    /supported exact profile/,
  );
  let accessorCalls = 0;
  const accessorMetadata = {};
  Object.defineProperty(accessorMetadata, 'agoragentic.risk_fork.profile', {
    enumerable: true,
    get() {
      accessorCalls += 1;
      return METADATA['agoragentic.risk_fork.profile'];
    },
  });
  assert.throws(
    () => buildE2BCleanSandboxCreateOptions({
      timeoutMs: TIMEOUT_MS,
      metadata: accessorMetadata,
    }),
    /hidden or accessor field/,
  );
  assert.equal(accessorCalls, 0);
});

test('clean creation rejects Proxies and inherited fields before caller code can run', () => {
  let trapCalls = 0;
  const onTrap = () => {
    trapCalls += 1;
  };
  assert.throws(
    () => buildE2BCleanSandboxCreateOptions(countingProxy({
      timeoutMs: TIMEOUT_MS,
      metadata: METADATA,
    }, onTrap)),
    /must not be a Proxy/,
  );
  assert.throws(
    () => buildE2BCleanSandboxCreateOptions({
      timeoutMs: TIMEOUT_MS,
      metadata: countingProxy({ ...METADATA }, onTrap),
    }),
    /must not be a Proxy/,
  );
  assert.throws(
    () => buildE2BCleanSandboxCreateOptions({
      timeoutMs: TIMEOUT_MS,
      metadata: {
        ...METADATA,
        'agoragentic.risk_fork.run_hash': countingProxy({}, onTrap),
      },
    }),
    /must not be a Proxy/,
  );
  assert.equal(trapCalls, 0);

  let inheritedGetterCalls = 0;
  const originalTimeoutDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'timeoutMs');
  Object.defineProperty(Object.prototype, 'timeoutMs', {
    configurable: true,
    get() {
      inheritedGetterCalls += 1;
      return TIMEOUT_MS;
    },
  });
  try {
    assert.throws(
      () => buildE2BCleanSandboxCreateOptions({ metadata: METADATA }),
      /exact required fields/,
    );
    assert.equal(inheritedGetterCalls, 0);
  } finally {
    if (originalTimeoutDescriptor) {
      Object.defineProperty(Object.prototype, 'timeoutMs', originalTimeoutDescriptor);
    } else {
      delete Object.prototype.timeoutMs;
    }
  }
});

test('clean creation output cannot acquire inherited provider authority after construction', () => {
  const options = buildE2BCleanSandboxCreateOptions({
    timeoutMs: TIMEOUT_MS,
    metadata: METADATA,
  });
  const pollutedKeys = ['mcp', 'apiUrl', 'rules', 'maskRequestHost', 'toJSON'];
  const originals = new Map(pollutedKeys.map((key) => (
    [key, Object.getOwnPropertyDescriptor(Object.prototype, key)]
  )));
  try {
    for (const key of pollutedKeys) {
      Object.defineProperty(Object.prototype, key, {
        configurable: true,
        value: `polluted:${key}`,
      });
    }
    assert.equal('mcp' in options, false);
    assert.equal('apiUrl' in options, false);
    assert.equal('rules' in options.network, false);
    assert.equal('maskRequestHost' in options.network, false);
    assert.equal('toJSON' in options, false);
    assert.equal('toJSON' in options.metadata, false);
    assert.equal('toJSON' in options.envs, false);
    assert.equal('toJSON' in options.volumeMounts, false);
  } finally {
    for (const key of pollutedKeys) {
      const descriptor = originals.get(key);
      if (descriptor) Object.defineProperty(Object.prototype, key, descriptor);
      else delete Object.prototype[key];
    }
  }
});

test('pinned E2B SDK preserves the clean request and observation contract over loopback', async (t) => {
  const requests = [];
  const server = createServer(async (request, response) => {
    try {
      const { raw, value: body } = await readJson(request);
      requests.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body,
        rawBody: raw,
      });
      if (request.method === 'POST' && request.url === '/sandboxes') {
        sendJson(response, 201, {
          sandboxID: SANDBOX_ID,
          templateID: TEMPLATE_ID,
          clientID: 'loopback-client',
          domain: 'localhost',
          envdVersion: '0.6.5',
        });
        return;
      }
      if (request.method === 'GET' && request.url === `/sandboxes/${SANDBOX_ID}`) {
        sendJson(response, 200, {
          sandboxID: SANDBOX_ID,
          templateID: TEMPLATE_ID,
          clientID: 'loopback-client',
          domain: 'localhost',
          envdVersion: '0.6.5',
          cpuCount: 1,
          diskSizeMB: 512,
          memoryMB: 512,
          startedAt: new Date(CREATED_AT_MS).toISOString(),
          endAt: new Date(CREATED_AT_MS + TIMEOUT_MS).toISOString(),
          state: 'running',
          metadata: METADATA,
          allowInternetAccess: false,
          network: {
            allowOut: [],
            denyOut: ['0.0.0.0/0'],
            allowPublicTraffic: false,
          },
          lifecycle: { onTimeout: 'kill', autoResume: false },
          volumeMounts: [],
        });
        return;
      }
      sendJson(response, 404, { code: 404, message: 'unexpected loopback request' });
    } catch (error) {
      sendJson(response, 500, { code: 500, message: error.message });
    }
  });
  const apiUrl = await listenLoopback(server);
  t.after(() => closeServer(server));

  const connection = {
    apiUrl,
    apiKey: 'local-contract-placeholder',
    validateApiKey: false,
    requestTimeoutMs: 10_000,
  };
  const createOptions = buildE2BCleanSandboxCreateOptions({
    timeoutMs: TIMEOUT_MS,
    metadata: METADATA,
  });
  const sdkOptions = Object.assign(Object.create(null), connection, createOptions);
  assert.equal(Object.getPrototypeOf(sdkOptions), null);
  const pollutionKeys = ['mcp', 'rules', 'maskRequestHost'];
  const originalPollution = new Map(pollutionKeys.map((key) => (
    [key, Object.getOwnPropertyDescriptor(Object.prototype, key)]
  )));
  const protectedNetworkArrays = new Set([
    createOptions.network.allowOut,
    createOptions.network.denyOut,
  ]);
  const originalArrayPollution = new Map([
    ['0', Object.getOwnPropertyDescriptor(Array.prototype, '0')],
    ['toJSON', Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON')],
    [Symbol.iterator, Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator)],
  ]);
  const originalArrayIterator = originalArrayPollution.get(Symbol.iterator)?.value;
  let protectedToJsonCalls = 0;
  let protectedIteratorCalls = 0;
  let sandbox;
  try {
    for (const key of pollutionKeys) {
      Object.defineProperty(Object.prototype, key, {
        configurable: true,
        value: `polluted:${key}`,
      });
    }
    Object.defineProperty(Array.prototype, '0', {
      configurable: true,
      value: 'attacker.invalid',
      writable: true,
    });
    Object.defineProperty(Array.prototype, 'toJSON', {
      configurable: true,
      value() {
        if (protectedNetworkArrays.has(this)) {
          protectedToJsonCalls += 1;
          return ['attacker.invalid'];
        }
        return this;
      },
    });
    Object.defineProperty(Array.prototype, Symbol.iterator, {
      configurable: true,
      value: function* pollutedArrayIterator() {
        if (protectedNetworkArrays.has(this)) {
          protectedIteratorCalls += 1;
          yield 'attacker.invalid';
          return;
        }
        yield* originalArrayIterator.call(this);
      },
    });
    assert.equal(createOptions.network.allowOut[0], undefined);
    assert.equal(createOptions.network.allowOut.toJSON, undefined);
    assert.equal(createOptions.network.allowOut[Symbol.iterator], undefined);
    sandbox = await Sandbox.create(TEMPLATE_ID, sdkOptions);
  } finally {
    for (const key of pollutionKeys) {
      const descriptor = originalPollution.get(key);
      if (descriptor) Object.defineProperty(Object.prototype, key, descriptor);
      else delete Object.prototype[key];
    }
    for (const key of ['0', 'toJSON', Symbol.iterator]) {
      const descriptor = originalArrayPollution.get(key);
      if (descriptor) Object.defineProperty(Array.prototype, key, descriptor);
      else delete Array.prototype[key];
    }
  }
  assert.equal(protectedToJsonCalls, 0);
  assert.equal(protectedIteratorCalls, 0);
  assert.equal(sandbox.sandboxId, SANDBOX_ID);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].url, '/sandboxes');
  assert.deepEqual(requests[0].body, {
    templateID: TEMPLATE_ID,
    metadata: METADATA,
    envVars: {},
    timeout: 70,
    secure: true,
    allow_internet_access: false,
    network: {
      allowOut: [],
      denyOut: ['0.0.0.0/0'],
      allowPublicTraffic: false,
    },
    autoPause: false,
    autoResume: { enabled: false },
    volumeMounts: [],
  });
  assert.ok(requests[0].rawBody.includes(
    '"network":{"allowOut":[],"denyOut":["0.0.0.0/0"],"allowPublicTraffic":false}',
  ));
  // e2b@2.39.0 omits an empty IAM input from the wire body. This exact SDK
  // behavior is recorded here and is not treated as provider-side absence
  // proof; live credential-inheritance qualification remains external.
  assert.equal('iam' in requests[0].body, false);

  const info = await Sandbox.getInfo(SANDBOX_ID, connection);
  const observation = validateE2BSandboxInfo(info, {
    field: 'loopback E2B SDK observation',
    sandboxId: SANDBOX_ID,
    templateId: TEMPLATE_ID,
    metadata: METADATA,
    createdAtMs: CREATED_AT_MS,
    ttlMs: TIMEOUT_MS,
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].method, 'GET');
  assert.equal(requests[1].url, `/sandboxes/${SANDBOX_ID}`);
  assert.equal(observation.network_status, 'exact_sdk_ipv4_sentinel_observed_ipv6_unqualified');
  assert.equal(observation.volume_mount_status, 'provider_reported_zero_observed');
  assert.equal(observation.lifecycle_status, 'provider_reported_kill_no_auto_resume_observed');
});
