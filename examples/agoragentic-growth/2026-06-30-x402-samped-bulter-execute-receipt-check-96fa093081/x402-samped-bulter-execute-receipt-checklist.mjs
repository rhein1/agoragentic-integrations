#!/usr/bin/env node
// demo — moves no real funds; the built-in self-test pay() callback returns mock authorization only.

import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

const DEFAULT_BASE_URL = process.env.AGORAGENTIC_URL || "https://agoragentic.com";
const MATCH_PATH = "/api/x402/execute/match";
const EXECUTE_PATH = "/api/x402/execute";
const PROOF_PATH = (invocationId) => `/api/x402/invocations/${encodeURIComponent(invocationId)}/proof`;
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_RECEIPT_POLL_ATTEMPTS = 4;
const DEFAULT_RECEIPT_POLL_INTERVAL_MS = 250;
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

async function loadX402Fetch() {
  try {
    const preferred = await import("agoragentic/x402-client");
    if (typeof preferred.x402Fetch === "function") {
      return { x402Fetch: preferred.x402Fetch, helperSource: "agoragentic/x402-client" };
    }
  } catch {}

  try {
    const fallback = await import("./x402-receipt-validation-adapter.mjs");
    if (typeof fallback.x402FetchWithFallback === "function") {
      return { x402Fetch: fallback.x402FetchWithFallback, helperSource: "./x402-receipt-validation-adapter.mjs" };
    }
  } catch {}

  throw new Error("Unable to load x402Fetch helper from agoragentic/x402-client or ./x402-receipt-validation-adapter.mjs");
}

function classifyProof(proof) {
  const status = String(proof?.status ?? proof?.on_chain?.status ?? "").toLowerCase();
  return {
    status,
    terminal: ["settled", "confirmed", "finalized", "complete", "completed", "verified"].includes(status),
    submitted: ["submitted", "broadcast", "pending", "processing", "recorded", "pending_submission"].includes(status),
  };
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
    if (attempt < attempts) {
      await sleep(intervalMs);
    }
  }
  return lastBody;
}

function buildReceiptChecklist({ quoteId, idempotencyKey, response, payload, paymentChallenge, paymentResponse, proof }) {
  const receipt = payload?.receipt ?? {};
  const proofState = classifyProof(proof);
  const receiptId = extractString(payload?.receipt_id, receipt?.receipt_id, receipt?.id, readHeader(response.headers, "payment-receipt"));
  const invocationId = extractString(payload?.invocation_id, payload?.invocation?.id, receipt?.invocation_id);
  const receiptChallengeNonce = extractString(receipt?.challenge_nonce, receipt?.challengeNonce, receipt?.nonce);
  const responseChallengeNonce = extractString(paymentResponse?.challengeNonce, paymentResponse?.challenge_nonce, paymentResponse?.nonce);
  const echoedIdempotencyKey = extractString(receipt?.idempotency_key, payload?.idempotency_key, readHeader(response.headers, "x-idempotency-key"));
  const quotedId = extractString(payload?.quote_id, payload?.quote?.id, receipt?.quote_id);
  const checklist = [
    { item: "http_ok", ok: response.ok, evidence: `HTTP ${response.status}` },
    { item: "idempotency_key_sent", ok: Boolean(idempotencyKey), evidence: idempotencyKey },
    { item: "receipt_reference_present", ok: Boolean(receiptId), evidence: receiptId },
    { item: "payment_receipt_header_present", ok: Boolean(readHeader(response.headers, "payment-receipt")), evidence: readHeader(response.headers, "payment-receipt") },
    { item: "payment_response_header_present", ok: Boolean(readHeader(response.headers, "payment-response")), evidence: paymentResponse },
    { item: "invocation_reference_present", ok: Boolean(invocationId), evidence: invocationId },
    { item: "quote_id_matches", ok: quotedId === quoteId, evidence: { expected: quoteId, actual: quotedId } },
    { item: "idempotency_key_echo_matches_when_present", ok: !echoedIdempotencyKey || echoedIdempotencyKey === idempotencyKey, evidence: { expected: idempotencyKey, actual: echoedIdempotencyKey } },
    {
      item: "receipt_matches_paid_challenge_when_present",
      ok: !paymentChallenge?.nonce || !receiptChallengeNonce || receiptChallengeNonce === paymentChallenge.nonce,
      evidence: { challengeNonce: paymentChallenge?.nonce ?? null, receiptChallengeNonce },
    },
    {
      item: "payment_response_matches_paid_challenge_when_present",
      ok: !paymentChallenge?.nonce || !responseChallengeNonce || responseChallengeNonce === paymentChallenge.nonce,
      evidence: { challengeNonce: paymentChallenge?.nonce ?? null, paymentResponseChallengeNonce: responseChallengeNonce },
    },
    { item: "proof_lookup_completed", ok: Boolean(proof), evidence: proof },
    {
      item: "proof_state_honestly_classified",
      ok: proof ? (proofState.terminal || proofState.submitted) : true,
      evidence: proofState,
    },
  ];

  const failed = checklist.filter((entry) => !entry.ok);
  if (failed.length) {
    throw new ReceiptChecklistError("Receipt checklist failed", { checklist, failedItems: failed.map((entry) => entry.item) });
  }

  return {
    quoteId,
    receiptId,
    invocationId,
    proofState,
    checklist,
  };
}

export function classifyExecuteError(error) {
  if (!error) return { category: "unknown", retryable: false, detail: "unknown error" };
  if (error instanceof TimeoutError) {
    return { category: "timeout", retryable: true, detail: error.message };
  }
  if (error?.name === "NetworkError" || error?.name === "TypeError") {
    return {
      category: "network_after_payment_authorized",
      retryable: true,
      detail: error.message,
      networkRetriesUsed: error.networkRetriesUsed ?? null,
      idempotencyKey: error.idempotencyKey ?? null,
    };
  }
  if (error instanceof HttpStatusError) {
    return {
      category: "http_status",
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
      failedItems: error.failedItems ?? [],
    };
  }
  return {
    category: "unknown",
    retryable: false,
    detail: error instanceof Error ? error.message : String(error),
  };
}

export async function executeSampedBulterReceiptChecklist({
  baseUrl = DEFAULT_BASE_URL,
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
    throw new Error("fetchImpl is required (Node 18+ or pass a custom fetch implementation)");
  }
  if (typeof pay !== "function") {
    throw new Error("pay callback is required and is the explicit gate for payment authorization");
  }
  if (!quoteId || !String(quoteId).trim()) {
    throw new Error("quoteId is required");
  }

  const { x402Fetch, helperSource } = await loadX402Fetch();
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
      body: JSON.stringify({ quote_id: quoteId, input }),
      signal,
      maxNetworkRetries,
    });
  } catch (error) {
    cancel();
    if (error?.name === "AbortError" || /timed out/i.test(String(error?.message ?? ""))) {
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

  const invocationId = extractString(payload?.invocation_id, payload?.invocation?.id, payload?.receipt?.invocation_id);
  const proof = invocationId
    ? await fetchProof(fetchImpl, baseUrl, invocationId, timeoutMs, receiptPollAttempts, receiptPollIntervalMs)
    : null;
  const paymentResponseHeader = readHeader(response.headers, "payment-response");
  const paymentResponse = decodeStructuredValue(paymentResponseHeader);
  const paymentChallenge = response.x402Meta?.challenge ?? null;
  const receiptChecklist = buildReceiptChecklist({
    quoteId,
    idempotencyKey,
    response,
    payload,
    paymentChallenge,
    paymentResponse,
    proof,
  });

  return {
    ok: true,
    helperSource,
    baseUrl,
    endpoints: {
      match: joinUrl(baseUrl, MATCH_PATH),
      execute: joinUrl(baseUrl, EXECUTE_PATH),
      proof: invocationId ? joinUrl(baseUrl, PROOF_PATH(invocationId)) : null,
    },
    idempotencyKey,
    responseStatus: response.status,
    quoteId,
    receiptId: receiptChecklist.receiptId,
    invocationId: receiptChecklist.invocationId,
    paymentReceiptHeader: readHeader(response.headers, "payment-receipt"),
    paymentResponseHeader,
    paymentResponse,
    proof,
    proofStatus: receiptChecklist.proofState.status || null,
    proofTerminal: receiptChecklist.proofState.terminal,
    proofSubmitted: receiptChecklist.proofState.submitted,
    checklist: receiptChecklist.checklist,
    payload,
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
    challengeNonce: "nonce_demo_samped_bulter_001",
    quoteId: "quote_demo_samped_bulter_execute",
    invocationId: "inv_demo_samped_bulter_001",
    receiptId: "rcpt_demo_samped_bulter_001",
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === MATCH_PATH) {
      return json(res, 200, {
        quote_id: state.quoteId,
        match: {
          provider: "demo-samped-bulter",
          listing_id: "listing_demo_samped_bulter",
          price_usdc: 0.01,
        },
      });
    }

    if (req.method === "POST" && url.pathname === EXECUTE_PATH) {
      state.executeCalls += 1;
      const body = await readJsonBody(req);
      const idempotencyKey = req.headers["idempotency-key"] ?? null;
      const authorization = req.headers.authorization ?? null;
      const paymentSignature = req.headers["payment-signature"] ?? null;

      if (idempotencyKey) state.idempotencyKeys.push(idempotencyKey);
      if (authorization) state.authorizationHeaders.push(authorization);
      if (paymentSignature) state.paymentSignatures.push(paymentSignature);

      if (!authorization && !paymentSignature) {
        const paymentRequired = Buffer.from(JSON.stringify([
          {
            scheme: "exact",
            network: "base",
            resource: EXECUTE_PATH,
            payTo: "demo-seller",
            maxAmountRequired: "1000",
            asset: "USDC",
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
        paymentId: "pay_demo_samped_bulter_001",
        challengeNonce: state.challengeNonce,
        authorizationReused: true,
      })).toString("base64");

      return json(res, 200, {
        ok: true,
        quote_id: body.quote_id ?? state.quoteId,
        invocation_id: state.invocationId,
        receipt_id: state.receiptId,
        output: {
          provider: "demo-samped-bulter",
          message: "paid execute() completed",
        },
        receipt: {
          id: state.receiptId,
          receipt_id: state.receiptId,
          quote_id: body.quote_id ?? state.quoteId,
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
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
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
    paymentId: "pay_demo_samped_bulter_001",
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
    const result = await executeSampedBulterReceiptChecklist({
      baseUrl: demo.baseUrl,
      quoteId: demo.state.quoteId,
      input: {
        task: "samped/bulter paid execute demo",
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
      ok: true,
      result,
      errorClassificationExample: classifyExecuteError(new HttpStatusError("HTTP 503 from execute()", { status: 503, body: { error: "busy" } })),
      demoState: demo.state,
    }, null, 2)}\n`);
  } finally {
    await demo.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: classifyExecuteError(error) }, null, 2)}\n`);
    process.exitCode = 1;
  });
}
