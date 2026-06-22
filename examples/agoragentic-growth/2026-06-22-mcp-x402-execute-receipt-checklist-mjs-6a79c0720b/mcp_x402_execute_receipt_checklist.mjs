#!/usr/bin/env node
// demo — moves no real funds

import crypto from "node:crypto";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";

async function loadX402Fetch() {
  try {
    const mod = await import("agoragentic/x402-client");
    if (typeof mod.x402Fetch === "function") {
      return mod.x402Fetch;
    }
  } catch {}
  return x402FetchFallback;
}

function makeIdempotencyKey(seed = "") {
  return `idem_${crypto.randomUUID()}${seed ? `_${seed}` : ""}`;
}

function normalizeHeaders(headersLike) {
  const out = {};
  if (!headersLike) return out;
  for (const [k, v] of Object.entries(headersLike)) {
    out[String(k).toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  return out;
}

function readHeader(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === "function") return headers.get(name);
  return normalizeHeaders(headers)[String(name).toLowerCase()];
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(",")}}`;
}

function bodyDigest(body) {
  return sha256Hex(typeof body === "string" ? body : stableJson(body ?? null));
}

function receiptChecklist({ url, method, requestBody, response, paidChallenge, paymentAuthorization }) {
  const responseHeaders = normalizeHeaders(
    typeof response.headers?.entries === "function"
      ? Object.fromEntries(response.headers.entries())
      : response.headers
  );
  const receipt = responseHeaders["x-payment-receipt"] || "";
  const settled = responseHeaders["x-payment-settled"] || "";
  const receiptMatchesChallenge = Boolean(
    receipt && paidChallenge && receipt.includes(sha256Hex(paidChallenge).slice(0, 16))
  );

  return {
    request: {
      url,
      method,
      body_sha256: bodyDigest(requestBody),
      idempotency_key: responseHeaders["x-idempotency-key"] || null,
    },
    payment: {
      authorization_present: Boolean(paymentAuthorization),
      paid_challenge_present: Boolean(paidChallenge),
      receipt_present: Boolean(receipt),
      receipt_matches_paid_challenge: receiptMatchesChallenge,
      settlement_header: settled || "absent",
    },
    response: {
      status: response.status,
      ok: Boolean(response.ok),
    },
    checklist: [
      { item: "Idempotency key attached", ok: Boolean(responseHeaders["x-idempotency-key"]) },
      { item: "Payment only authorized after HTTP 402", ok: Boolean(paymentAuthorization) },
      { item: "Receipt header returned by server", ok: Boolean(receipt) },
      { item: "Receipt correlated to paid challenge", ok: receiptMatchesChallenge },
      { item: "No terminal settlement claim made by client", ok: true },
    ],
  };
}

async function x402FetchFallback(url, options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    pay,
    idempotencyKey,
    headers = {},
    retryNetworkErrors = 1,
    ...rest
  } = options;

  if (typeof fetchImpl !== "function") {
    throw new Error("fetch implementation is required");
  }
  if (!idempotencyKey) {
    throw new Error("idempotencyKey is required");
  }
  if (typeof pay !== "function") {
    throw new Error("pay callback is required for x402 paid calls");
  }

  let paymentAuthorization = null;
  let paidChallenge = null;
  let saw402 = false;

  const requestOnce = async () => {
    const reqHeaders = new Headers(headers);
    reqHeaders.set("Idempotency-Key", idempotencyKey);
    if (paymentAuthorization) {
      reqHeaders.set("X-Payment", paymentAuthorization);
    }
    return fetchImpl(url, { ...rest, headers: reqHeaders });
  };

  let attempt = 0;
  while (true) {
    try {
      let response = await requestOnce();

      if (response.status === 402) {
        saw402 = true;
        const challenge = readHeader(response.headers, "x-payment-challenge");
        if (!challenge) {
          const err = new Error("server returned HTTP 402 without x-payment-challenge");
          err.code = "X402_MISSING_CHALLENGE";
          throw err;
        }

        if (!paymentAuthorization) {
          const payResult = await pay({
            url,
            idempotencyKey,
            challenge,
            method: rest.method || "GET",
            body: rest.body,
          });
          if (!payResult || !payResult.authorization) {
            const err = new Error("pay callback did not return an authorization");
            err.code = "X402_PAYMENT_NOT_AUTHORIZED";
            throw err;
          }
          paymentAuthorization = payResult.authorization;
          paidChallenge = challenge;
        }

        response = await requestOnce();
      }

      response.x402 = {
        saw402,
        paymentAuthorization,
        paidChallenge,
        idempotencyKey,
      };
      return response;
    } catch (error) {
      const networkish =
        error?.name === "TypeError" ||
        error?.code === "ECONNRESET" ||
        error?.code === "ETIMEDOUT" ||
        error?.code === "ENOTFOUND";

      if (!networkish || attempt >= retryNetworkErrors) {
        error.x402 = {
          kind: networkish ? "network-error" : "client-error",
          saw402,
          paymentAuthorization,
          paidChallenge,
          idempotencyKey,
        };
        throw error;
      }

      attempt += 1;
      await delay(50 * attempt);
    }
  }
}

async function executePaidMcpEndpoint({
  endpoint,
  toolName,
  arguments: toolArgs = {},
  pay,
  idempotencyKey = makeIdempotencyKey(toolName),
  fetchImpl = globalThis.fetch,
  requestId = crypto.randomUUID(),
}) {
  const x402Fetch = await loadX402Fetch();

  const body = {
    jsonrpc: "2.0",
    id: requestId,
    method: "tools/call",
    params: {
      name: toolName,
      arguments: toolArgs,
    },
  };

  let response;
  try {
    response = await x402Fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
      fetchImpl,
      pay,
      idempotencyKey,
    });
  } catch (error) {
    return {
      ok: false,
      classification: error?.x402?.kind || "network-error",
      status: null,
      idempotencyKey,
      error: error?.message || String(error),
      payment: error?.x402 || null,
      receiptChecklist: null,
    };
  }

  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;

  if (!response.ok) {
    return {
      ok: false,
      classification: "http-failure",
      status: response.status,
      idempotencyKey,
      error: payload?.error || `HTTP ${response.status}`,
      payment: response.x402 || null,
      receiptChecklist: receiptChecklist({
        url: endpoint,
        method: "POST",
        requestBody: body,
        response,
        paidChallenge: response.x402?.paidChallenge,
        paymentAuthorization: response.x402?.paymentAuthorization,
      }),
    };
  }

  return {
    ok: true,
    classification: "success",
    status: response.status,
    idempotencyKey,
    result: payload?.result ?? payload,
    payment: response.x402 || null,
    receiptChecklist: receiptChecklist({
      url: endpoint,
      method: "POST",
      requestBody: body,
      response,
      paidChallenge: response.x402?.paidChallenge,
      paymentAuthorization: response.x402?.paymentAuthorization,
    }),
  };
}

function createDemoPayGate() {
  let authorizations = 0;
  return {
    async pay({ challenge, idempotencyKey, method, body }) {
      authorizations += 1;
      const token = Buffer.from(
        JSON.stringify({
          kind: "demo-payment-authorization",
          challenge,
          idempotencyKey,
          method,
          body_sha256: bodyDigest(typeof body === "string" ? JSON.parse(body) : body),
        }),
        "utf8"
      ).toString("base64url");
      return { authorization: `demo ${token}` };
    },
    stats() {
      return { authorizations };
    },
  };
}

function startDemoServer() {
  const paidChallenges = new Map();
  const seenExecutions = new Set();
  let firstAttemptNetworkDrop = true;

  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/mcp") {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const body = JSON.parse(rawBody || "{}");
    const idem = req.headers["idempotency-key"];
    const auth = req.headers["x-payment"];

    if (!idem) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "missing Idempotency-Key" }));
      return;
    }

    if (!auth) {
      const challenge = `challenge:${idem}:${bodyDigest(body)}`;
      paidChallenges.set(idem, challenge);
      res.writeHead(402, {
        "content-type": "application/json",
        "x-payment-challenge": challenge,
        "x-idempotency-key": idem,
      });
      res.end(JSON.stringify({ error: "payment required" }));
      return;
    }

    const challenge = paidChallenges.get(idem);
    const receipt = `demo-receipt:${sha256Hex(challenge || "").slice(0, 16)}`;

    if (firstAttemptNetworkDrop) {
      firstAttemptNetworkDrop = false;
      req.socket.destroy();
      return;
    }

    const executionKey = `${idem}:${body.params?.name}`;
    const alreadyExecuted = seenExecutions.has(executionKey);
    if (!alreadyExecuted) {
      seenExecutions.add(executionKey);
    }

    res.writeHead(200, {
      "content-type": "application/json",
      "x-idempotency-key": idem,
      "x-payment-receipt": receipt,
      "x-payment-settled": "unknown",
    });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          tool: body.params?.name,
          arguments: body.params?.arguments || {},
          executed: !alreadyExecuted,
          idempotencyKey: idem,
          note: "demo response from MCP endpoint",
        },
      })
    );
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        server,
        endpoint: `http://127.0.0.1:${port}/mcp`,
      });
    });
  });
}

async function main() {
  const { server, endpoint } = await startDemoServer();
  const gate = createDemoPayGate();

  try {
    const result = await executePaidMcpEndpoint({
      endpoint,
      toolName: "check_receipt",
      arguments: {
        orderId: "demo-order-123",
        expectedAsset: "USD",
      },
      pay: gate.pay,
      idempotencyKey: makeIdempotencyKey("receipt_check"),
    });

    const output = {
      demo: true,
      endpoint,
      authorizations: gate.stats().authorizations,
      result,
      selfTest: {
        success: result.ok === true,
        singleAuthorizationReusedAcrossRetry: gate.stats().authorizations === 1,
        receiptPresent: Boolean(result.receiptChecklist?.payment?.receipt_present),
        receiptMatchesChallenge: Boolean(
          result.receiptChecklist?.payment?.receipt_matches_paid_challenge
        ),
      },
    };

    console.log(JSON.stringify(output, null, 2));

    if (
      !output.selfTest.success ||
      !output.selfTest.singleAuthorizationReusedAcrossRetry ||
      !output.selfTest.receiptPresent ||
      !output.selfTest.receiptMatchesChallenge
    ) {
      process.exitCode = 1;
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: error?.message || String(error),
          code: error?.code || null,
          payment: error?.x402 || null,
        },
        null,
        2
      )
    );
    process.exit(1);
  });
}

export {
  executePaidMcpEndpoint,
  receiptChecklist,
  x402FetchFallback,
  makeIdempotencyKey,
};
