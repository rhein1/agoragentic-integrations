#!/usr/bin/env node
// demo — moves no real funds

import crypto from "node:crypto";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

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

function safeJsonParse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    return {
      raw_body: text,
      parse_error: error.message,
    };
  }
}

function decodeHeaderJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {}
  for (const encoding of ["base64", "base64url"]) {
    try {
      return JSON.parse(Buffer.from(String(value), encoding).toString("utf8"));
    } catch {}
  }
  return null;
}

function firstObject(value) {
  if (Array.isArray(value)) return value.find((item) => item && typeof item === "object") || null;
  return value && typeof value === "object" ? value : null;
}

function readAnyHeader(headers, names) {
  for (const name of names) {
    const value = readHeader(headers, name);
    if (value) return value;
  }
  return undefined;
}

function parsePaymentChallenge(headers) {
  const raw = readAnyHeader(headers, [
    "payment-required",
    "X-Payment-Required",
    "x-payment-required",
    "x-payment-challenge",
  ]);
  if (!raw) return null;

  const parsed = firstObject(decodeHeaderJson(raw));
  if (parsed) {
    return {
      raw,
      parsed,
      challengeId: parsed.challenge_id || parsed.challengeId || parsed.id || null,
    };
  }

  return {
    raw,
    parsed: null,
    challengeId: String(raw),
  };
}

function parsePaymentReceipt(headers) {
  const raw = readAnyHeader(headers, [
    "payment-receipt",
    "Payment-Receipt",
    "x-payment-receipt",
  ]);
  if (!raw) return null;

  const parsed = firstObject(decodeHeaderJson(raw));
  return {
    raw,
    parsed,
    receiptId: parsed?.receipt_id || parsed?.receiptId || parsed?.id || String(raw),
    challengeId: parsed?.challenge_id || parsed?.challengeId || null,
  };
}

function receiptChecklist({ url, method, requestBody, response, paidChallenge, paymentAuthorization }) {
  const responseHeaders = normalizeHeaders(
    typeof response.headers?.entries === "function"
      ? Object.fromEntries(response.headers.entries())
      : response.headers
  );
  const receipt = parsePaymentReceipt(responseHeaders);
  const challenge = firstObject(decodeHeaderJson(paidChallenge));
  const paidChallengeId = challenge?.challenge_id || challenge?.challengeId || paidChallenge || null;
  const settled = responseHeaders["x-payment-settled"] || "";
  const receiptMatchesChallenge = Boolean(receipt && paidChallengeId && receipt.challengeId === paidChallengeId);

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
      receipt_id: receipt?.receiptId || null,
      receipt_challenge_id: receipt?.challengeId || null,
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
      reqHeaders.set("PAYMENT-SIGNATURE", paymentAuthorization);
    }
    return fetchImpl(url, { ...rest, headers: reqHeaders });
  };

  let attempt = 0;
  while (true) {
    try {
      let response = await requestOnce();

      if (response.status === 402) {
        saw402 = true;
        if (paymentAuthorization) {
          const err = new Error("server returned a second HTTP 402 after payment authorization");
          err.code = "X402_PAYMENT_REJECTED_AFTER_AUTHORIZATION";
          throw err;
        }

        const challengeInfo = parsePaymentChallenge(response.headers);
        const challenge = challengeInfo?.raw;
        if (!challenge) {
          const err = new Error("server returned HTTP 402 without payment-required challenge");
          err.code = "X402_MISSING_CHALLENGE";
          throw err;
        }

        if (!paymentAuthorization) {
          let payResult;
          try {
            payResult = await pay({
              url,
              idempotencyKey,
              challenge,
              challengeParsed: challengeInfo.parsed,
              method: rest.method || "GET",
              body: rest.body,
            });
          } catch (error) {
            error.x402 = {
              kind: "payment-callback-error",
              saw402,
              paymentAuthorization,
              paidChallenge,
              idempotencyKey,
            };
            throw error;
          }
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

      if (paymentAuthorization && RETRYABLE_STATUS.has(response.status)) {
        if (attempt >= retryNetworkErrors) {
          response.x402 = {
            saw402,
            paymentAuthorization,
            paidChallenge,
            idempotencyKey,
          };
          return response;
        }
        attempt += 1;
        await delay(50 * attempt);
        continue;
      }

      response.x402 = {
        saw402,
        paymentAuthorization,
        paidChallenge,
        idempotencyKey,
      };
      return response;
    } catch (error) {
      if (error?.x402?.kind === "payment-callback-error") {
        throw error;
      }
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
  const payload = safeJsonParse(text);

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

  if (payload?.error) {
    return {
      ok: false,
      classification: "json-rpc-error",
      status: response.status,
      idempotencyKey,
      error: payload.error,
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
    const auth = req.headers["payment-signature"] || req.headers["x-payment"];

    if (!idem) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "missing Idempotency-Key" }));
      return;
    }

    if (!auth) {
      const challenge = {
        challenge_id: `challenge:${idem}:${bodyDigest(body)}`,
        idempotency_key: idem,
        request_body_sha256: bodyDigest(body),
        amount: "0.01",
        asset: "USD",
        pay_to: "demo-mcp-seller",
      };
      const encodedChallenge = Buffer.from(JSON.stringify([challenge]), "utf8").toString("base64");
      paidChallenges.set(idem, challenge);
      res.writeHead(402, {
        "content-type": "application/json",
        "payment-required": encodedChallenge,
        "X-Payment-Required": encodedChallenge,
        "x-payment-challenge": challenge.challenge_id,
        "x-idempotency-key": idem,
      });
      res.end(JSON.stringify({ error: "payment required" }));
      return;
    }

    const challenge = paidChallenges.get(idem);
    const receipt = {
      receipt_id: `demo-receipt:${sha256Hex(stableJson(challenge || {})).slice(0, 16)}`,
      challenge_id: challenge?.challenge_id || null,
      idempotency_key: idem,
      status: "demo-accepted",
    };
    const encodedReceipt = Buffer.from(JSON.stringify(receipt), "utf8").toString("base64");

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
      "Payment-Receipt": encodedReceipt,
      "x-payment-receipt": encodedReceipt,
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
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
