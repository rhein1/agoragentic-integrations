#!/usr/bin/env node
// demo — moves no real funds; the self-test pay() callback returns mock authorization only.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const DEFAULT_BASE_URL = process.env.AGORAGENTIC_URL || "https://agoragentic.com";
const EXECUTE_PATH = "/api/x402/execute";
const PROOF_PATH = (invocationId) => `/api/x402/invocations/${encodeURIComponent(invocationId)}/proof`;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RECEIPT_POLL_ATTEMPTS = 4;
const DEFAULT_RECEIPT_POLL_INTERVAL_MS = 250;
const DEFAULT_MAX_NETWORK_RETRIES = 1;

function readHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") {
    return headers.get(name) ?? headers.get(String(name).toLowerCase()) ?? null;
  }
  const wanted = String(name).toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === wanted) return value;
  }
  return null;
}

function readFirstHeader(headers, names) {
  for (const name of names) {
    const value = readHeader(headers, name);
    if (value) return value;
  }
  return null;
}

function joinUrl(baseUrl, path) {
  return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

function decodeStructuredValue(raw) {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  const attempts = [trimmed];
  try {
    attempts.push(Buffer.from(trimmed, "base64").toString("utf8"));
  } catch {}
  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch {}
  }
  return trimmed;
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

function extractString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function readPaymentReceiptHeader(headers) {
  return readFirstHeader(headers, ["payment-receipt", "x-payment-receipt"]);
}

function extractReceiptId(payload, response) {
  return extractString(
    payload?.receipt_id,
    payload?.receipt?.receipt_id,
    payload?.receipt?.id,
    readPaymentReceiptHeader(response.headers),
  );
}

function extractInvocationId(payload) {
  return extractString(payload?.invocation_id, payload?.invocationId, payload?.invocation?.id);
}

function classifyProof(proof) {
  const status = String(proof?.status ?? proof?.on_chain?.status ?? "").toLowerCase();
  if (["settled", "confirmed", "finalized", "complete", "completed", "verified"].includes(status)) {
    return { status, terminal: true, submitted: false };
  }
  if (["submitted", "broadcast", "pending", "processing"].includes(status)) {
    return { status, terminal: false, submitted: true };
  }
  return { status, terminal: false, submitted: false };
}

function withDeadline(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
  return {
    signal: controller.signal,
    cancel() {
      clearTimeout(timer);
    },
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
      if (response.ok && lastBody) {
        const classification = classifyProof(lastBody);
        if (classification.terminal || classification.submitted || attempt === attempts) {
          return lastBody;
        }
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

async function x402FetchWithFallback(url, options = {}) {
  const {
    fetchImpl,
    pay,
    idempotencyKey,
    method = "GET",
    headers = {},
    body,
    signal,
    maxNetworkRetries = 0,
  } = options;
  let authorization = null;
  let networkRetriesUsed = 0;

  const send = () => {
    const requestHeaders = {
      ...headers,
      "idempotency-key": idempotencyKey,
    };
    if (authorization?.authorizationHeader) requestHeaders.authorization = authorization.authorizationHeader;
    if (authorization?.paymentSignature) requestHeaders["payment-signature"] = authorization.paymentSignature;
    return fetchImpl(url, { method, headers: requestHeaders, body, signal });
  };

  let response = await send();
  if (response.status === 402) {
    const paymentRequired = readFirstHeader(response.headers, [
      "payment-required",
      "x-payment-required",
      "x-payment-challenge",
    ]);
    if (!paymentRequired) {
      throw new Error("HTTP 402 response did not include a payment challenge");
    }
    authorization = await pay(paymentRequired, {
      url,
      method,
      idempotencyKey,
      body,
    });
  }

  for (;;) {
    try {
      if (authorization) {
        response = await send();
      }
      response.x402Meta = {
        paymentAttempted: Boolean(authorization),
        networkRetriesUsed,
      };
      return response;
    } catch (error) {
      if (networkRetriesUsed >= maxNetworkRetries) throw error;
      networkRetriesUsed += 1;
    }
  }
}

function buildChecklist({ idempotencyKey, response, payload, receiptId, invocationId, paymentResponse, proof, quoteId }) {
  const proofState = classifyProof(proof);
  return [
    { item: "idempotency_key_sent", ok: Boolean(idempotencyKey), evidence: idempotencyKey },
    { item: "http_success", ok: response.ok, evidence: { status: response.status } },
    { item: "receipt_id_present", ok: Boolean(receiptId), evidence: receiptId },
    { item: "invocation_id_present", ok: Boolean(invocationId), evidence: invocationId },
    {
      item: "payment_response_decoded",
      ok: readHeader(response.headers, "payment-response") ? paymentResponse !== null : true,
      evidence: paymentResponse,
    },
    {
      item: "proof_state_honest",
      ok: proof ? proofState.terminal || proofState.submitted : true,
      evidence: {
        state: proofState.status || null,
        terminal: proofState.terminal,
        submitted: proofState.submitted,
      },
    },
    {
      item: "quote_id_echoed",
      ok: Boolean(payload?.quote_id) && payload.quote_id === quoteId,
      evidence: {
        expected: quoteId,
        actual: payload?.quote_id ?? null,
      },
    },
  ];
}

function assertChecklistOk(checklist) {
  const failures = checklist.filter((entry) => !entry.ok);
  if (failures.length > 0) {
    throw new Error(`receipt checklist failed: ${JSON.stringify(failures, null, 2)}`);
  }
}

export async function executeBuyerRetryReceiptChecklist({
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
    throw new Error("fetchImpl is required (Node 18+ or provide a custom fetch)");
  }
  if (typeof pay !== "function") {
    throw new Error("pay callback is required and is the explicit gate for payment authorization");
  }
  if (!quoteId || !String(quoteId).trim()) {
    throw new Error("quoteId is required");
  }

  const body = JSON.stringify({ quote_id: quoteId, input });
  const { signal, cancel } = withDeadline(timeoutMs);

  let response;
  try {
    response = await x402FetchWithFallback(joinUrl(baseUrl, EXECUTE_PATH), {
      fetchImpl,
      pay,
      idempotencyKey,
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body,
      signal,
      maxNetworkRetries,
    });
  } finally {
    cancel();
  }

  const payload = await safeJson(response);
  if (!response.ok) {
    const detail = payload?.error ?? payload?.message ?? `HTTP ${response.status}`;
    throw new Error(`execute() failed: ${detail}`);
  }

  const invocationId = extractInvocationId(payload);
  const receiptId = extractReceiptId(payload, response);
  const paymentResponseHeader = readHeader(response.headers, "payment-response");
  const paymentResponse = decodeStructuredValue(paymentResponseHeader);
  const proof = invocationId
    ? await fetchProof(fetchImpl, baseUrl, invocationId, timeoutMs, receiptPollAttempts, receiptPollIntervalMs)
    : null;
  const checklist = buildChecklist({
    idempotencyKey,
    response,
    payload,
    receiptId,
    invocationId,
    paymentResponse,
    proof,
    quoteId,
  });
  assertChecklistOk(checklist);

  const proofState = classifyProof(proof);
  return {
    ok: true,
    responseStatus: response.status,
    idempotencyKey,
    receiptId,
    invocationId,
    paymentReceiptHeader: readPaymentReceiptHeader(response.headers),
    paymentResponseHeader,
    paymentResponse,
    proof,
    proofStatus: proofState.status || null,
    proofTerminal: proofState.terminal,
    proofSubmitted: proofState.submitted,
    payload,
    checklist,
    x402Meta: response.x402Meta ?? null,
  };
}

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
  });
}

function createMockFetch(state) {
  return async (input, init = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const request = new URL(url);
    const method = (init.method || "GET").toUpperCase();
    const headers = new Headers(init.headers || {});

    if (request.pathname === EXECUTE_PATH && method === "POST") {
      state.executeCalls += 1;
      state.idempotencyKeys.push(headers.get("idempotency-key") || "");
      const authorization = headers.get("authorization");
      if (authorization) state.authorizationHeaders.push(authorization);

      const challenge = JSON.stringify([
        {
          scheme: "exact",
          network: "base",
          maxAmountRequired: "1000",
          resource: request.pathname,
          payTo: "0xmerchantdemo",
          asset: "0x833589fCD6EDb6E08f4c7C32D4f71b54bdA02913",
          nonce: "nonce_demo_001",
        },
      ]);

      if (!authorization) {
        return jsonResponse(402, { error: "payment required", quote_id: "quote_demo_paid_execute" }, { "payment-required": challenge });
      }

      if (state.executeCalls === 2) {
        throw new Error("simulated network disconnect after payment authorization");
      }

      const paymentResponse = Buffer.from(JSON.stringify({
        paymentId: "pay_demo_001",
        challengeNonce: "nonce_demo_001",
        reusedAuthorization: true,
      })).toString("base64");

      return jsonResponse(
        200,
        {
          ok: true,
          quote_id: "quote_demo_paid_execute",
          invocation_id: "inv_demo_001",
          receipt_id: "rcpt_demo_001",
          output: { provider: "go165/gpt55-x402-gateway", message: "paid execute() completed" },
        },
        {
          "payment-receipt": "rcpt_demo_001",
          "payment-response": paymentResponse,
        },
      );
    }

    if (request.pathname === PROOF_PATH("inv_demo_001") && method === "GET") {
      state.proofCalls += 1;
      return jsonResponse(200, {
        invocation_id: "inv_demo_001",
        decision_hash: "0xdeadbeef",
        on_chain: {
          chain: "eip155:8453",
          status: "submitted",
        },
      });
    }

    return jsonResponse(404, { error: `Unhandled route ${method} ${request.pathname}` });
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
  const state = {
    payCalls: 0,
    executeCalls: 0,
    proofCalls: 0,
    idempotencyKeys: [],
    authorizationHeaders: [],
  };

  const result = await executeBuyerRetryReceiptChecklist({
    baseUrl: "https://demo.agoragentic.invalid",
    quoteId: "quote_demo_paid_execute",
    input: { prompt: "hello", model: "go165/gpt55-x402-gateway" },
    fetchImpl: createMockFetch(state),
    pay: (paymentRequired, context) => demoPay(paymentRequired, context, state),
    timeoutMs: 5_000,
    receiptPollAttempts: 2,
    receiptPollIntervalMs: 10,
    maxNetworkRetries: 1,
  });

  assert.equal(result.ok, true);
  assert.equal(result.responseStatus, 200);
  assert.equal(result.invocationId, "inv_demo_001");
  assert.equal(result.receiptId, "rcpt_demo_001");
  assert.equal(result.proofSubmitted, true);
  assert.equal(result.proofTerminal, false);
  assert.equal(state.payCalls, 1, "pay() must run exactly once after the 402 challenge");
  assert.equal(state.executeCalls, 3, "expected 402 -> paid retry network error -> paid retry success");
  assert.equal(new Set(state.idempotencyKeys).size, 1, "same idempotency key must be reused across retries");
  assert.deepEqual(state.authorizationHeaders, ["Bearer demo-paid-authorization", "Bearer demo-paid-authorization"]);

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n`);
    process.exitCode = 1;
  });
}
