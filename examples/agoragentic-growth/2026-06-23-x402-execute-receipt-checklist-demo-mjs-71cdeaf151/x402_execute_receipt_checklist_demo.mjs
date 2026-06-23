// demo — moves no real funds

import crypto from "node:crypto";

function makeIdempotencyKey(prefix = "x402-demo") {
  return `${prefix}-${crypto.randomUUID()}`;
}

function sha256(text) {
  return crypto.createHash("sha256").update(String(text)).digest("hex");
}

class HeadersBag {
  constructor(init = {}) {
    this.map = new Map();
    if (init instanceof HeadersBag) {
      for (const [k, v] of init.entries()) this.set(k, v);
      return;
    }
    if (typeof Headers !== "undefined" && init instanceof Headers) {
      for (const [k, v] of init.entries()) this.set(k, v);
      return;
    }
    if (Array.isArray(init)) {
      for (const [k, v] of init) this.set(k, v);
      return;
    }
    for (const [k, v] of Object.entries(init || {})) this.set(k, v);
  }

  set(key, value) {
    this.map.set(String(key).toLowerCase(), String(value));
  }

  get(key) {
    return this.map.get(String(key).toLowerCase()) ?? null;
  }

  has(key) {
    return this.map.has(String(key).toLowerCase());
  }

  entries() {
    return this.map.entries();
  }

  toObject() {
    return Object.fromEntries(this.map.entries());
  }
}

class SimpleResponse {
  constructor(status, body, headers = {}) {
    this.status = status;
    this.ok = status >= 200 && status < 300;
    this._body = typeof body === "string" ? body : JSON.stringify(body);
    this.headers = new HeadersBag(headers);
  }

  async text() {
    return this._body;
  }

  async json() {
    return JSON.parse(this._body);
  }
}

async function readResponseBody(response) {
  const text = await response.text();
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: null };
  }
}

function extractChallenge(response, parsedBody) {
  const headerValue = response.headers?.get?.("x-x402-challenge");
  if (headerValue) {
    try {
      return JSON.parse(headerValue);
    } catch {
      return { raw: headerValue };
    }
  }
  if (parsedBody?.json?.challenge) return parsedBody.json.challenge;
  return null;
}

function normalizeFetchResult(result) {
  if (!result || typeof result.status !== "number") {
    throw new Error("x402Fetch did not return a Response-like object");
  }
  return result.response && typeof result.response.status === "number" ? result.response : result;
}

function networkError(message, details = {}) {
  const err = new Error(message);
  err.name = "X402NetworkError";
  err.classification = "network_error";
  Object.assign(err, details);
  return err;
}

async function fallbackX402Fetch(url, options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    pay,
    idempotencyKey,
    method = "POST",
    headers = {},
    body,
    maxNetworkRetries = 1,
  } = options;

  if (typeof fetchImpl !== "function") {
    throw new Error("No fetch implementation available");
  }
  if (!idempotencyKey) {
    throw new Error("idempotencyKey is required");
  }

  const baseHeaders = new HeadersBag(headers);
  baseHeaders.set("x-idempotency-key", idempotencyKey);

  let authorization = null;
  let challengeFingerprint = null;
  let lastNetworkError = null;

  for (let attempt = 0; attempt <= maxNetworkRetries + 1; attempt += 1) {
    const requestHeaders = new HeadersBag(baseHeaders);
    if (authorization) requestHeaders.set("x-x402-authorization", authorization);

    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: requestHeaders.toObject(),
        body,
      });
    } catch (error) {
      lastNetworkError = error;
      if (attempt < maxNetworkRetries + 1) {
        continue;
      }
      throw networkError("Network error during x402 paid call", {
        cause: error,
        url,
        method,
        idempotencyKey,
        authorizationReused: Boolean(authorization),
      });
    }

    if (response.status === 402) {
      if (typeof pay !== "function") {
        throw new Error("Server requested payment (HTTP 402) but no pay callback was provided");
      }

      const parsed402 = await readResponseBody(response);
      const challenge = extractChallenge(response, parsed402);
      if (!challenge) {
        throw new Error("HTTP 402 response did not include a payment challenge");
      }

      const fingerprint = sha256(JSON.stringify(challenge));
      if (!authorization || fingerprint !== challengeFingerprint) {
        const payment = await pay({
          url,
          method,
          idempotencyKey,
          challenge,
        });
        const token = typeof payment === "string" ? payment : payment?.authorization;
        if (!token) {
          throw new Error("pay callback must return an authorization string or { authorization }");
        }
        authorization = token;
        challengeFingerprint = fingerprint;
      }

      continue;
    }

    if (!response.ok) {
      const failure = new Error(`HTTP failure from paid call: ${response.status}`);
      failure.name = "X402HttpFailure";
      failure.classification = "http_failure";
      failure.status = response.status;
      failure.idempotencyKey = idempotencyKey;
      throw failure;
    }

    response.x402Meta = {
      idempotencyKey,
      authorizationReused: Boolean(authorization),
      hadPriorNetworkError: Boolean(lastNetworkError),
    };
    return response;
  }

  throw new Error("x402Fetch exhausted retries without a terminal result");
}

async function loadX402Fetch() {
  const candidates = [
    "agoragentic/x402-client",
    "../lib/x402-client.mjs",
    "../src/x402-client.mjs",
    "../../lib/x402-client.mjs",
    "../../src/x402-client.mjs",
  ];

  for (const specifier of candidates) {
    try {
      const mod = await import(specifier);
      if (typeof mod.x402Fetch === "function") {
        return { x402Fetch: mod.x402Fetch, source: specifier };
      }
    } catch {
      // fall through to next candidate
    }
  }

  return { x402Fetch: fallbackX402Fetch, source: "inline-demo-fallback" };
}

function buildReceiptChecklist({ response, payload, idempotencyKey }) {
  const receiptHeader = response.headers?.get?.("x-x402-receipt");
  const challengeIdHeader = response.headers?.get?.("x-x402-challenge-id");
  const receipt = payload?.receipt ?? null;
  const challengeId = challengeIdHeader ?? receipt?.challengeId ?? null;

  return [
    {
      item: "Request used an idempotency key",
      pass: typeof idempotencyKey === "string" && idempotencyKey.length > 0,
      evidence: idempotencyKey,
    },
    {
      item: "Paid call completed with HTTP 2xx",
      pass: response.ok,
      evidence: `status=${response.status}`,
    },
    {
      item: "Response included a receipt handle",
      pass: Boolean(receiptHeader || receipt?.id),
      evidence: receiptHeader || receipt?.id || "missing",
    },
    {
      item: "Receipt is linked to a paid challenge",
      pass: Boolean(challengeId),
      evidence: challengeId || "missing",
    },
    {
      item: "Receipt data is structurally present in the body",
      pass: Boolean(receipt && typeof receipt === "object"),
      evidence: receipt ? JSON.stringify(receipt) : "missing",
    },
    {
      item: "Demo does not claim settlement beyond returned receipt fields",
      pass: !receipt?.settledAt && receipt?.note === "demo - no real funds moved",
      evidence: receipt?.note || "missing",
    },
  ];
}

export async function execute(url, options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    pay,
    idempotencyKey = makeIdempotencyKey(),
    method = "POST",
    headers = {},
    body,
    maxNetworkRetries = 1,
  } = options;

  const { x402Fetch, source } = await loadX402Fetch();
  const rawResponse = await x402Fetch(url, {
    fetchImpl,
    pay,
    idempotencyKey,
    method,
    headers,
    body,
    maxNetworkRetries,
  });

  const response = normalizeFetchResult(rawResponse);
  const { text, json } = await readResponseBody(response);
  const payload = json ?? { raw: text };

  return {
    helperSource: source,
    idempotencyKey,
    response,
    payload,
    checklist: buildReceiptChecklist({ response, payload, idempotencyKey }),
  };
}

function makeDemoFetch() {
  const state = {
    requestCount: 0,
    payCalls: 0,
    challengeId: "ch_demo_receipt_001",
    receiptId: "rcpt_demo_001",
    authorizationSeen: [],
    idempotencyKeys: [],
    networkFailedOnce: false,
  };

  const fetchImpl = async (_url, init = {}) => {
    state.requestCount += 1;
    const headers = new HeadersBag(init.headers || {});
    const auth = headers.get("x-x402-authorization");
    const idempotencyKey = headers.get("x-idempotency-key");

    state.authorizationSeen.push(auth);
    state.idempotencyKeys.push(idempotencyKey);

    if (!auth) {
      return new SimpleResponse(
        402,
        {
          error: "payment required",
          challenge: {
            id: state.challengeId,
            asset: "demo-usdc",
            amount: "1000",
            note: "demo only",
          },
        },
        {
          "content-type": "application/json",
          "x-x402-challenge": JSON.stringify({
            id: state.challengeId,
            asset: "demo-usdc",
            amount: "1000",
            note: "demo only",
          }),
        },
      );
    }

    if (!state.networkFailedOnce) {
      state.networkFailedOnce = true;
      throw new Error("simulated transient network failure after payment authorization");
    }

    return new SimpleResponse(
      200,
      {
        ok: true,
        receipt: {
          id: state.receiptId,
          challengeId: state.challengeId,
          authorizationHash: sha256(auth).slice(0, 16),
          note: "demo - no real funds moved",
        },
      },
      {
        "content-type": "application/json",
        "x-x402-receipt": state.receiptId,
        "x-x402-challenge-id": state.challengeId,
      },
    );
  };

  const pay = async ({ challenge, idempotencyKey }) => {
    state.payCalls += 1;
    return {
      authorization: `demo-auth:${challenge.id}:${idempotencyKey}`,
    };
  };

  return { state, fetchImpl, pay };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function main() {
  const { state, fetchImpl, pay } = makeDemoFetch();

  const result = await execute("https://example.invalid/paid/execute", {
    fetchImpl,
    pay,
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      op: "execute",
      buyer: "demo",
    }),
    idempotencyKey: "demo-idempotency-key-001",
    maxNetworkRetries: 1,
  });

  assert(result.payload.ok === true, "execute() should succeed");
  assert(state.payCalls === 1, "payment should be authorized exactly once");
  assert(state.requestCount === 3, "demo should perform 402 -> network retry -> success");
  assert(
    state.idempotencyKeys.every((k) => k === "demo-idempotency-key-001"),
    "all retries should reuse the same idempotency key",
  );
  assert(
    state.authorizationSeen[1] && state.authorizationSeen[1] === state.authorizationSeen[2],
    "authorization should be reused after transient failure",
  );
  assert(
    result.checklist.every((item) => item.pass),
    "receipt checklist should pass in the demo",
  );

  const summary = {
    helperSource: result.helperSource,
    requestCount: state.requestCount,
    payCalls: state.payCalls,
    idempotencyKey: result.idempotencyKey,
    authorizationReused: state.authorizationSeen[1] === state.authorizationSeen[2],
    checklist: result.checklist,
    receipt: result.payload.receipt,
  };

  console.log(JSON.stringify(summary, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(
      JSON.stringify(
        {
          error: error.message,
          name: error.name,
          classification: error.classification || null,
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  });
}
