#!/usr/bin/env node
// demo — moves no real funds; the self-test pay() callback returns mock authorization only.

import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

const EXECUTE_PATH = "/api/x402/execute";
const PROOF_PATH = (invocationId) => `/api/x402/invocations/${encodeURIComponent(invocationId)}/proof`;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RECEIPT_POLL_ATTEMPTS = 3;
const DEFAULT_RECEIPT_POLL_INTERVAL_MS = 25;
const DEFAULT_MAX_NETWORK_RETRIES = 1;

class TimeoutError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = "TimeoutError";
    Object.assign(this, extra);
  }
}

class HttpStatusError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = "HttpStatusError";
    Object.assign(this, extra);
  }
}

class NetworkRetryError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = "NetworkRetryError";
    Object.assign(this, extra);
  }
}

class ReceiptChecklistError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = "ReceiptChecklistError";
    Object.assign(this, extra);
  }
}

function lowerCaseHeaders(input = {}) {
  if (input instanceof Headers) {
    return Object.fromEntries(Array.from(input.entries(), ([key, value]) => [String(key).toLowerCase(), value]));
  }
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [String(key).toLowerCase(), value]));
}

function readHeader(source, name) {
  if (!source) return null;
  if (typeof source.get === "function") return source.get(name) ?? source.get(String(name).toLowerCase()) ?? null;
  const headers = lowerCaseHeaders(source.headers || source);
  return headers[String(name).toLowerCase()] ?? null;
}

function decodeStructuredValue(raw) {
  if (!raw || typeof raw !== "string") return null;
  const attempts = [raw.trim()];
  try {
    attempts.push(Buffer.from(raw.trim(), "base64").toString("utf8"));
  } catch {}
  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch {}
  }
  return raw;
}

function parsePaymentRequired(raw) {
  const decoded = decodeStructuredValue(raw);
  if (Array.isArray(decoded)) return decoded;
  if (decoded && Array.isArray(decoded.challenges)) return decoded.challenges;
  return [];
}

function extractString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function joinUrl(baseUrl, path) {
  return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

async function safeJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function normalizePayResult(payment) {
  if (!payment || typeof payment !== "object") {
    throw new Error("pay callback must return an object");
  }
  if (!payment.authorizationHeader && !payment.paymentSignature) {
    throw new Error("pay callback must return authorizationHeader or paymentSignature");
  }
  return payment;
}

function withDeadline(timeoutMs, upstream) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new TimeoutError(`Timed out after ${timeoutMs}ms`)), timeoutMs);
  const onAbort = () => controller.abort(upstream?.reason ?? new Error("Aborted"));
  if (upstream) {
    if (upstream.aborted) onAbort();
    else upstream.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cancel() {
      clearTimeout(timer);
      if (upstream) upstream.removeEventListener("abort", onAbort);
    },
  };
}

function createInlineX402Fetch() {
  return async function x402Fetch(url, options = {}) {
    const {
      fetchImpl = globalThis.fetch,
      pay,
      idempotencyKey = randomUUID(),
      method = "GET",
      headers = {},
      body,
      signal,
      maxNetworkRetries = DEFAULT_MAX_NETWORK_RETRIES,
    } = options;

    if (typeof fetchImpl !== "function") {
      throw new Error("fetchImpl is required");
    }

    const baseHeaders = lowerCaseHeaders(headers);
    let cachedPayment = null;
    let cachedChallenge = null;
    let sawPaymentChallenge = false;
    let networkRetriesUsed = 0;

    while (true) {
      const requestHeaders = {
        accept: "application/json",
        "idempotency-key": idempotencyKey,
        ...baseHeaders,
      };

      let requestBody = body;
      if (requestBody !== undefined && requestBody !== null && typeof requestBody !== "string") {
        requestBody = JSON.stringify(requestBody);
        if (!requestHeaders["content-type"]) requestHeaders["content-type"] = "application/json";
      }

      if (cachedPayment?.authorizationHeader) requestHeaders.authorization = cachedPayment.authorizationHeader;
      if (cachedPayment?.paymentSignature) requestHeaders["payment-signature"] = cachedPayment.paymentSignature;

      try {
        const response = await fetchImpl(url, {
          method,
          headers: requestHeaders,
          body: requestBody,
          signal,
        });

        if (response.status !== 402) {
          response.x402Meta = {
            helper: "inline-x402Fetch",
            idempotencyKey,
            paymentAttempted: sawPaymentChallenge,
            paymentAuthorized: Boolean(cachedPayment),
            networkRetriesUsed,
            challenge: cachedChallenge,
          };
          return response;
        }

        sawPaymentChallenge = true;
        const paymentRequired = readHeader(response, "payment-required");
        if (!paymentRequired) {
          throw new HttpStatusError("Received HTTP 402 without payment-required header", {
            status: 402,
            idempotencyKey,
          });
        }
        if (typeof pay !== "function") {
          throw new HttpStatusError("HTTP 402 requires a caller-supplied pay callback", {
            status: 402,
            idempotencyKey,
            paymentRequired,
          });
        }
        if (!cachedPayment) {
          cachedChallenge = parsePaymentRequired(paymentRequired)[0] ?? null;
          cachedPayment = normalizePayResult(await pay(paymentRequired, {
            url,
            method,
            headers: requestHeaders,
            body: requestBody,
            idempotencyKey,
            challenge: cachedChallenge,
          }));
        }
      } catch (error) {
        if (typeof error?.status === "number") throw error;
        if (!cachedPayment) throw error;
        if (networkRetriesUsed >= maxNetworkRetries) {
          throw new NetworkRetryError(`Network error after payment authorization was prepared: ${error.message}`, {
            cause: error,
            idempotencyKey,
            paymentAttempted: sawPaymentChallenge,
            paymentAuthorized: true,
            challenge: cachedChallenge,
            networkRetriesUsed,
          });
        }
        networkRetriesUsed += 1;
      }
    }
  };
}

let cachedX402FetchPromise = null;
async function loadX402Fetch() {
  if (!cachedX402FetchPromise) {
    cachedX402FetchPromise = (async () => {
      try {
        const preferred = await import("agoragentic/x402-client");
        if (typeof preferred.x402Fetch === "function") {
          return { fn: preferred.x402Fetch, source: "agoragentic/x402-client" };
        }
      } catch {}
      try {
        const fallback = await import("./x402-receipt-validation-adapter.mjs");
        if (typeof fallback.x402FetchWithFallback === "function") {
          return { fn: fallback.x402FetchWithFallback, source: "./x402-receipt-validation-adapter.mjs" };
        }
      } catch {}
      return { fn: createInlineX402Fetch(), source: "inline-fallback" };
    })();
  }
  return cachedX402FetchPromise;
}

function classifyProof(proof) {
  const status = String(proof?.status ?? proof?.on_chain?.status ?? "").toLowerCase();
  if (["settled", "confirmed", "finalized", "complete", "completed"].includes(status)) {
    return { status, terminal: true, submitted: false };
  }
  if (["submitted", "broadcast", "pending", "processing", "recorded"].includes(status)) {
    return { status, terminal: false, submitted: true };
  }
  return { status, terminal: false, submitted: false };
}

async function fetchProof(fetchImpl, baseUrl, invocationId, timeoutMs, attempts, intervalMs) {
  let lastBody = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const { signal, cancel } = withDeadline(timeoutMs);
    try {
      const response = await fetchImpl(joinUrl(baseUrl, PROOF_PATH(invocationId)), {
        method: "GET",
        headers: { accept: "application/json" },
        signal,
      });
      lastBody = await safeJson(response);
      if (response.ok && lastBody) return lastBody;
      if (![404, 409, 425, 503].includes(response.status)) {
        throw new HttpStatusError(`Proof lookup failed with HTTP ${response.status}`, {
          status: response.status,
          body: lastBody,
        });
      }
    } finally {
      cancel();
    }
    if (attempt < attempts) await sleep(intervalMs);
  }
  return lastBody;
}

function buildChecklist({ idempotencyKey, response, payload, paymentRequired, paymentResponse, proof }) {
  const receipt = payload?.receipt ?? {};
  const receiptId = extractString(payload?.receipt_id, receipt?.receipt_id, receipt?.id, readHeader(response.headers, "payment-receipt"));
  const invocationId = extractString(payload?.invocation_id, payload?.invocation?.id, receipt?.invocation_id);
  const challenge = parsePaymentRequired(paymentRequired)[0] ?? null;
  const proofState = classifyProof(proof);
  const steps = [
    {
      step: 1,
      item: "idempotency_key_sent",
      ok: Boolean(idempotencyKey),
      evidence: idempotencyKey,
    },
    {
      step: 2,
      item: "payment_challenge_received",
      ok: Boolean(paymentRequired),
      evidence: challenge ?? paymentRequired ?? null,
    },
    {
      step: 3,
      item: "payment_response_header_present",
      ok: Boolean(readHeader(response.headers, "payment-response")),
      evidence: paymentResponse,
    },
    {
      step: 4,
      item: "receipt_reference_present",
      ok: Boolean(receiptId),
      evidence: receiptId,
    },
    {
      step: 5,
      item: "receipt_echoes_idempotency_key",
      ok: receipt?.idempotency_key === idempotencyKey,
      evidence: {
        receipt_idempotency_key: receipt?.idempotency_key ?? null,
        expected: idempotencyKey,
      },
    },
    {
      step: 6,
      item: "receipt_matches_paid_challenge_nonce",
      ok: receipt?.challenge_nonce === (challenge?.nonce ?? null),
      evidence: {
        receipt_challenge_nonce: receipt?.challenge_nonce ?? null,
        paid_challenge_nonce: challenge?.nonce ?? null,
      },
    },
    {
      step: 7,
      item: "invocation_id_present",
      ok: Boolean(invocationId),
      evidence: invocationId,
    },
    {
      step: 8,
      item: "proof_honestly_classified",
      ok: !proof || proofState.terminal || proofState.submitted,
      evidence: {
        status: proofState.status || null,
        terminal: proofState.terminal,
        submitted: proofState.submitted,
      },
    },
  ];
  return { steps, receiptId, invocationId, proofState, challenge };
}

function ensureChecklistOk(checklist) {
  const failed = checklist.steps.filter((step) => !step.ok);
  if (failed.length > 0) {
    throw new ReceiptChecklistError(`Receipt checklist failed: ${failed.map((step) => step.item).join(", ")}`, {
      checklist: checklist.steps,
    });
  }
}

function classifyError(error) {
  if (error instanceof TimeoutError) {
    return {
      category: "timeout",
      retryable: true,
      detail: error.message,
    };
  }
  if (error instanceof NetworkRetryError) {
    return {
      category: "network_after_payment_authorized",
      retryable: false,
      detail: error.message,
      idempotencyKey: error.idempotencyKey ?? null,
      retriesUsed: error.networkRetriesUsed ?? null,
    };
  }
  if (error instanceof HttpStatusError) {
    return {
      category: "http_failure",
      retryable: [408, 409, 425, 429, 500, 502, 503, 504].includes(error.status),
      detail: error.message,
      status: error.status,
      body: error.body ?? null,
    };
  }
  if (error instanceof ReceiptChecklistError) {
    return {
      category: "receipt_checklist_failed",
      retryable: false,
      detail: error.message,
      checklist: error.checklist ?? null,
    };
  }
  return {
    category: "unknown",
    retryable: false,
    detail: error instanceof Error ? error.message : String(error),
  };
}

export async function executePaidCallReceiptChecklist({
  baseUrl,
  quoteId,
  input = {},
  fetchImpl = globalThis.fetch,
  pay,
  idempotencyKey = randomUUID(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  receiptPollAttempts = DEFAULT_RECEIPT_POLL_ATTEMPTS,
  receiptPollIntervalMs = DEFAULT_RECEIPT_POLL_INTERVAL_MS,
  maxNetworkRetries = DEFAULT_MAX_NETWORK_RETRIES,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("fetchImpl is required (Node 18+ or pass a custom fetch)");
  }
  if (typeof pay !== "function") {
    throw new Error("pay callback is required and is the explicit gate for payment authorization");
  }
  if (!quoteId || !String(quoteId).trim()) {
    throw new Error("quoteId is required");
  }
  if (!baseUrl || !String(baseUrl).trim()) {
    throw new Error("baseUrl is required");
  }

  const { fn: x402Fetch, source: helperSource } = await loadX402Fetch();
  const requestBody = JSON.stringify({ quote_id: quoteId, input });
  const { signal, cancel } = withDeadline(timeoutMs);

  let response;
  try {
    response = await x402Fetch(joinUrl(baseUrl, EXECUTE_PATH), {
      fetchImpl,
      pay,
      idempotencyKey,
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: requestBody,
      signal,
      maxNetworkRetries,
    });
  } catch (error) {
    cancel();
    if (error?.name === "AbortError") {
      throw new TimeoutError(`execute() exceeded ${timeoutMs}ms`, { cause: error });
    }
    if (error instanceof Error && /timed out/i.test(error.message)) {
      throw new TimeoutError(`execute() exceeded ${timeoutMs}ms`, { cause: error });
    }
    throw error;
  } finally {
    cancel();
  }

  const payload = await safeJson(response);
  if (!response.ok) {
    throw new HttpStatusError(`execute() failed with HTTP ${response.status}`, {
      status: response.status,
      body: payload,
    });
  }

  const proofInvocationId = extractString(payload?.invocation_id, payload?.invocation?.id, payload?.receipt?.invocation_id);
  const proof = proofInvocationId
    ? await fetchProof(fetchImpl, baseUrl, proofInvocationId, timeoutMs, receiptPollAttempts, receiptPollIntervalMs)
    : null;
  const paymentRequired = JSON.stringify(response.x402Meta?.challenge ? [response.x402Meta.challenge] : []);
  const paymentResponse = decodeStructuredValue(readHeader(response.headers, "payment-response"));
  const checklist = buildChecklist({
    idempotencyKey,
    response,
    payload,
    paymentRequired,
    paymentResponse,
    proof,
  });
  ensureChecklistOk(checklist);

  return {
    ok: true,
    helperSource,
    idempotencyKey,
    responseStatus: response.status,
    payload,
    receiptId: checklist.receiptId,
    invocationId: checklist.invocationId,
    paymentReceiptHeader: readHeader(response.headers, "payment-receipt"),
    paymentResponseHeader: readHeader(response.headers, "payment-response"),
    paymentResponse,
    proof,
    proofStatus: checklist.proofState.status || null,
    proofTerminal: checklist.proofState.terminal,
    proofSubmitted: checklist.proofState.submitted,
    checklist: checklist.steps,
    x402Meta: {
      ...(response.x402Meta ?? {}),
      helperSource,
    },
  };
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, {
    "content-type": "application/json",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

async function startDemoServer() {
  const state = {
    payCalls: 0,
    executeCalls: 0,
    proofCalls: 0,
    disconnects: 0,
    idempotencyKeys: [],
    authorizationHeaders: [],
    paymentSignatures: [],
    quoteId: "quote_demo_paid_execute",
    invocationId: "inv_demo_001",
    receiptId: "rcpt_demo_001",
    challengeNonce: "nonce_demo_001",
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "POST" && url.pathname === EXECUTE_PATH) {
      state.executeCalls += 1;
      const authorization = req.headers.authorization ?? null;
      const paymentSignature = req.headers["payment-signature"] ?? null;
      const idempotencyKey = req.headers["idempotency-key"] ?? null;
      if (idempotencyKey) state.idempotencyKeys.push(idempotencyKey);
      if (authorization) state.authorizationHeaders.push(authorization);
      if (paymentSignature) state.paymentSignatures.push(paymentSignature);
      const body = await readJsonBody(req);

      if (!authorization) {
        const paymentRequired = Buffer.from(JSON.stringify([
          {
            scheme: "exact",
            network: "base",
            resource: EXECUTE_PATH,
            maxAmountRequired: "1000",
            asset: "USDC",
            payTo: "demo-seller",
            nonce: state.challengeNonce,
          },
        ])).toString("base64");
        return json(res, 402, {
          error: "payment required",
          quote_id: body.quote_id ?? state.quoteId,
        }, {
          "payment-required": paymentRequired,
        });
      }

      if (state.disconnects === 0) {
        state.disconnects += 1;
        req.socket.destroy(new Error("simulated disconnect after payment authorization"));
        return;
      }

      const paymentResponse = Buffer.from(JSON.stringify({
        paymentId: "pay_demo_001",
        challengeNonce: state.challengeNonce,
        authorizationReused: true,
      })).toString("base64");

      return json(res, 200, {
        ok: true,
        quote_id: body.quote_id ?? state.quoteId,
        invocation_id: state.invocationId,
        receipt_id: state.receiptId,
        output: {
          provider: "local-demo",
          message: "paid execute() completed",
        },
        receipt: {
          id: state.receiptId,
          receipt_id: state.receiptId,
          invocation_id: state.invocationId,
          idempotency_key: idempotencyKey,
          challenge_nonce: state.challengeNonce,
          status: "submitted",
        },
      }, {
        "payment-receipt": state.receiptId,
        "payment-response": paymentResponse,
      });
    }

    if (req.method === "GET" && url.pathname === PROOF_PATH(state.invocationId)) {
      state.proofCalls += 1;
      return json(res, 200, {
        invocation_id: state.invocationId,
        decision_hash: "0xdeadbeef",
        on_chain: {
          chain: "eip155:8453",
          status: "submitted",
        },
      });
    }

    return json(res, 404, { error: `Unhandled route ${req.method} ${url.pathname}` });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    state,
    async close() {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

async function demoPay(paymentRequired, context, state) {
  state.payCalls += 1;
  return {
    authorizationHeader: "Bearer demo-paid-authorization",
    paymentSignature: "demo-signature",
    paymentId: "pay_demo_001",
    receipt: {
      demo: true,
      challenge: decodeStructuredValue(paymentRequired),
      idempotencyKey: context.idempotencyKey,
      method: context.method,
    },
  };
}

async function main() {
  const demo = await startDemoServer();
  try {
    const result = await executePaidCallReceiptChecklist({
      baseUrl: demo.baseUrl,
      quoteId: demo.state.quoteId,
      input: {
        task: "local execute buyer example",
        value: "hello",
      },
      fetchImpl: globalThis.fetch,
      pay: (paymentRequired, context) => demoPay(paymentRequired, context, demo.state),
      timeoutMs: 5_000,
      receiptPollAttempts: 2,
      receiptPollIntervalMs: 10,
      maxNetworkRetries: 1,
    });

    assert.equal(result.ok, true);
    assert.equal(result.responseStatus, 200);
    assert.equal(result.receiptId, demo.state.receiptId);
    assert.equal(result.invocationId, demo.state.invocationId);
    assert.equal(result.proofSubmitted, true);
    assert.equal(result.proofTerminal, false);
    assert.equal(demo.state.payCalls, 1, "pay() must run exactly once after the 402 challenge");
    assert.equal(demo.state.executeCalls, 3, "expected 402 -> paid retry network error -> paid retry success");
    assert.equal(new Set(demo.state.idempotencyKeys).size, 1, "same idempotency key must be reused across retries");
    assert.deepEqual(demo.state.authorizationHeaders, ["Bearer demo-paid-authorization", "Bearer demo-paid-authorization"]);
    assert.deepEqual(demo.state.paymentSignatures, ["demo-signature", "demo-signature"]);

    process.stdout.write(`${JSON.stringify({
      result,
      errorClassificationExample: classifyError(new HttpStatusError("HTTP 503 from execute()", { status: 503, body: { error: "busy" } })),
      demoState: demo.state,
    }, null, 2)}\n`);
  } finally {
    await demo.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    const output = {
      ok: false,
      error: classifyError(error),
    };
    process.stderr.write(`${JSON.stringify(output, null, 2)}\n`);
    process.exitCode = 1;
  });
}
