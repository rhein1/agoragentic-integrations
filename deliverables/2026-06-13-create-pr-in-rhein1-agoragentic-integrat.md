# x402 Paid execute() Receipt Checklist for MCP Endpoints

This guide shows how to implement an MCP-facing paid execute() flow that:

- preserves the original buyer request body
- handles HTTP 402 payment challenges
- retries the exact same execute() call with buyer payment headers
- captures receipt evidence needed for reconciliation and support

The examples below assume a server-backed execute endpoint at `/api/x402/execute` and an MCP server that exposes two tools:

- `x402_execute_prepare`
- `x402_execute_retry`

## Receipt checklist

Record all of the following for every paid execute() call:

1. Persist the original JSON request body before the first network call.
2. Compute and persist a stable digest of that body so the retry can prove it reused the exact same payload.
3. Record the first HTTP status.
4. If the first status is `402`, capture the raw `payment-required` header and decode it into structured challenge data.
5. Verify the decoded challenge still matches the intended buyer action before asking the wallet to sign it.
6. Store an `attempt_id` that ties together:
   - the original request body
   - the request digest
   - the first response status
   - the decoded payment challenge
7. Retry the exact same execute body after the buyer produces payment headers.
8. Preserve the full paid response body and all paid response headers.
9. Extract and persist, when present:
   - `invocation_id`
   - `receipt_id`
   - `payment-receipt` header
   - cost / amount charged
   - payment method or settlement status
10. Treat a business-success payload without any receipt identifier as incomplete, not fully reconciled.
11. Keep enough raw evidence to reconcile later:
   - original request body
   - request digest
   - first response headers/body
   - retry response headers/body
   - buyer payment headers actually used on retry
12. Only delete temporary retry state after a successful paid response has been recorded.

## Expected MCP flow

### 1) `x402_execute_prepare`

This tool performs the first `POST /api/x402/execute`.

Possible outcomes:

- `200` or other success: return the response and a completed checklist.
- `402`: return:
  - `attempt_id`
  - `request_digest`
  - original `execute_body`
  - decoded `payment_required`
  - the first response body and headers
  - a checklist showing that payment is now required

### 2) Wallet / buyer step

The MCP host or external buyer stack uses the decoded `payment_required` challenge to produce payment headers such as:

- `payment-signature`
- `x-payment-signature`
- other chain- or wallet-specific payment headers

### 3) `x402_execute_retry`

This tool looks up the original attempt by `attempt_id`, reuses the exact same `execute_body`, adds the buyer payment headers, and retries `POST /api/x402/execute`.

The retry response should include:

- `receipt_checklist`
- raw response headers/body
- the original `request_digest`
- the decoded payment challenge for auditability

## Complete example

```js
#!/usr/bin/env node
'use strict';

const crypto = require('crypto');

const BASE_URL = process.env.AGORAGENTIC_BASE_URL || 'https://agoragentic.com';
const RAW_API_KEY = (process.env.AGORAGENTIC_API_KEY || '').trim();
const PLACEHOLDER_API_KEYS = new Set([
  '',
  'amk_your_key',
  'amk_your_key_here',
  'amk_placeholder',
  'amk_test_placeholder',
]);
const API_KEY = PLACEHOLDER_API_KEYS.has(RAW_API_KEY) ? '' : RAW_API_KEY;
const USER_AGENT = 'agoragentic-x402-paid-receipt-example/1.0';
const pendingAttempts = new Map();

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function decodeBase64Json(headerValue) {
  if (!headerValue) return null;
  try {
    return JSON.parse(Buffer.from(headerValue, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function normalizeStringMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (raw === undefined || raw === null) continue;
    out[String(key).toLowerCase()] = String(raw);
  }
  return out;
}

function buildExecuteBody(args) {
  const body = {
    input: args.input && typeof args.input === 'object' ? args.input : {},
  };

  if (typeof args.quote_id === 'string' && args.quote_id.trim()) {
    body.quote_id = args.quote_id.trim();
  }

  if (typeof args.task === 'string' && args.task.trim()) {
    body.task = args.task.trim();
  }

  if (typeof args.max_cost === 'number' && Number.isFinite(args.max_cost)) {
    body.max_cost = args.max_cost;
  }

  return body;
}

function summarizePaymentRequired(decoded) {
  const challenge = Array.isArray(decoded) ? decoded[0] : decoded;
  if (!challenge || typeof challenge !== 'object') return null;
  return {
    scheme: challenge.scheme || null,
    network: challenge.network || null,
    resource: challenge.resource || null,
    description: challenge.description || null,
    max_amount_required: challenge.maxAmountRequired || challenge.max_amount_required || null,
    pay_to: challenge.payTo || challenge.pay_to || null,
    asset: challenge.asset || null,
    extra: challenge,
  };
}

function extractReceiptEvidence(response) {
  const body = response.data && typeof response.data === 'object' ? response.data : {};
  return {
    invocation_id:
      body.invocation_id ||
      body.invocationId ||
      body.invocation?.id ||
      null,
    receipt_id:
      body.receipt_id ||
      body.receiptId ||
      body.receipt?.id ||
      null,
    payment_receipt_header: response.headers['payment-receipt'] || null,
    payment_method:
      body.payment_method ||
      body.paymentMethod ||
      body.receipt?.payment_method ||
      null,
    settlement:
      body.settlement ||
      body.receipt?.settlement ||
      null,
    cost:
      body.cost ??
      body.amount ??
      body.receipt?.cost ??
      null,
  };
}

function buildChecklist({ requestDigest, firstStatus, paymentRequired, response }) {
  const receipt = extractReceiptEvidence(response);
  const firstWas402 = firstStatus === 402;

  return [
    {
      check: 'request_body_frozen',
      status: requestDigest ? 'pass' : 'fail',
      evidence: requestDigest,
    },
    {
      check: 'first_response_recorded',
      status: firstStatus ? 'pass' : 'fail',
      evidence: firstStatus,
    },
    {
      check: 'payment_required_challenge_recorded_when_needed',
      status: firstWas402 ? (paymentRequired ? 'pass' : 'fail') : 'not_applicable',
      evidence: paymentRequired || null,
    },
    {
      check: 'retry_used_same_execute_body',
      status: response.request_digest === requestDigest ? 'pass' : 'fail',
      evidence: {
        expected: requestDigest,
        actual: response.request_digest,
      },
    },
    {
      check: 'invocation_id_present',
      status: receipt.invocation_id ? 'pass' : 'warn',
      evidence: receipt.invocation_id,
    },
    {
      check: 'receipt_identifier_present',
      status: receipt.receipt_id || receipt.payment_receipt_header ? 'pass' : 'warn',
      evidence: {
        receipt_id: receipt.receipt_id,
        payment_receipt_header: receipt.payment_receipt_header,
      },
    },
    {
      check: 'cost_captured',
      status: receipt.cost !== null && receipt.cost !== undefined ? 'pass' : 'warn',
      evidence: receipt.cost,
    },
    {
      check: 'payment_method_or_settlement_captured',
      status: receipt.payment_method || receipt.settlement ? 'pass' : 'warn',
      evidence: {
        payment_method: receipt.payment_method,
        settlement: receipt.settlement,
      },
    },
    {
      check: 'raw_headers_preserved',
      status: response.headers && Object.keys(response.headers).length > 0 ? 'pass' : 'warn',
      evidence: Object.keys(response.headers || {}),
    },
    {
      check: 'raw_body_preserved',
      status: response.data !== undefined ? 'pass' : 'warn',
      evidence: typeof response.data,
    },
  ];
}

async function postExecute(body, extraHeaders = {}) {
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    'user-agent': USER_AGENT,
    ...normalizeStringMap(extraHeaders),
  };

  if (API_KEY) {
    headers.authorization = `Bearer ${API_KEY}`;
  }

  const response = await fetch(`${BASE_URL}/api/x402/execute`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const rawText = await response.text();
  let data;
  try {
    data = rawText ? JSON.parse(rawText) : {};
  } catch {
    data = { raw: rawText };
  }

  const responseHeaders = {};
  for (const [key, value] of response.headers.entries()) {
    responseHeaders[key.toLowerCase()] = value;
  }

  return {
    status: response.status,
    ok: response.ok,
    data,
    headers: responseHeaders,
    request_digest: sha256(JSON.stringify(body)),
  };
}

async function preparePaidExecute(args) {
  const body = buildExecuteBody(args);
  if (!body.quote_id && !body.task) {
    return {
      error: 'missing_execute_selector',
      message: 'Provide quote_id from /api/x402/execute/match or provide a task string.',
    };
  }

  const firstResponse = await postExecute(body, args.extra_headers);
  const requestDigest = firstResponse.request_digest;
  const decodedPaymentRequired = summarizePaymentRequired(
    decodeBase64Json(firstResponse.headers['payment-required']),
  );

  if (firstResponse.status === 402) {
    const attemptId = `x402_${sha256(`${requestDigest}:${Date.now()}:${Math.random()}`).slice(0, 20)}`;

    pendingAttempts.set(attemptId, {
      created_at: new Date().toISOString(),
      body,
      request_digest: requestDigest,
      extra_headers: normalizeStringMap(args.extra_headers),
      first_response_status: firstResponse.status,
      payment_required: decodedPaymentRequired,
    });

    return {
      phase: 'payment_required',
      attempt_id: attemptId,
      request_digest: requestDigest,
      execute_body: body,
      payment_required: decodedPaymentRequired,
      receipt_checklist: buildChecklist({
        requestDigest,
        firstStatus: firstResponse.status,
        paymentRequired: decodedPaymentRequired,
        response: firstResponse,
      }),
      next_action:
        'Generate buyer payment headers from the decoded challenge, then call x402_execute_retry with the same attempt_id and those headers.',
      first_response: {
        status: firstResponse.status,
        headers: firstResponse.headers,
        body: firstResponse.data,
      },
    };
  }

  if (!firstResponse.ok) {
    return {
      phase: 'error',
      status: firstResponse.status,
      execute_body: body,
      response: firstResponse,
    };
  }

  return {
    phase: 'completed_without_retry',
    request_digest: requestDigest,
    execute_body: body,
    receipt_checklist: buildChecklist({
      requestDigest,
      firstStatus: firstResponse.status,
      paymentRequired: null,
      response: firstResponse,
    }),
    response: firstResponse,
  };
}

async function retryPaidExecute(args) {
  const attempt = pendingAttempts.get(args.attempt_id);
  if (!attempt) {
    return {
      error: 'unknown_attempt_id',
      message: 'Call x402_execute_prepare first, then reuse its attempt_id for retry.',
    };
  }

  const paymentHeaders = normalizeStringMap(args.payment_headers);
  if (typeof args.payment_signature === 'string' && args.payment_signature.trim()) {
    paymentHeaders['payment-signature'] = args.payment_signature.trim();
  }

  if (!paymentHeaders['payment-signature'] && !paymentHeaders['x-payment-signature']) {
    return {
      error: 'missing_payment_headers',
      message:
        'Provide payment_headers with a payment-signature (or x-payment-signature) produced by the buyer wallet flow.',
      payment_required: attempt.payment_required,
    };
  }

  const retryResponse = await postExecute(attempt.body, {
    ...attempt.extra_headers,
    ...paymentHeaders,
  });

  const result = {
    phase: retryResponse.ok ? 'completed_with_retry' : 'retry_error',
    attempt_id: args.attempt_id,
    request_digest: attempt.request_digest,
    execute_body: attempt.body,
    payment_required: attempt.payment_required,
    receipt_checklist: buildChecklist({
      requestDigest: attempt.request_digest,
      firstStatus: attempt.first_response_status,
      paymentRequired: attempt.payment_required,
      response: retryResponse,
    }),
    response: retryResponse,
  };

  if (retryResponse.ok) {
    pendingAttempts.delete(args.attempt_id);
  }

  return result;
}

module.exports = {
  preparePaidExecute,
  retryPaidExecute,
};
```

## Minimal MCP tool contract

Use the example helpers above behind these tool shapes.

### `x402_execute_prepare`

Input:

```json
{
  "quote_id": "optional quote from /api/x402/execute/match",
  "task": "optional fallback task string",
  "input": {
    "prompt": "..."
  },
  "max_cost": 0.05,
  "extra_headers": {
    "x-request-id": "req_123"
  }
}
```

Output on `402`:

```json
{
  "phase": "payment_required",
  "attempt_id": "x402_...",
  "request_digest": "sha256...",
  "execute_body": {
    "quote_id": "q_...",
    "input": {
      "prompt": "..."
    }
  },
  "payment_required": {
    "scheme": "x402",
    "network": "base",
    "resource": "/api/x402/execute",
    "max_amount_required": "..."
  },
  "receipt_checklist": [
    {
      "check": "request_body_frozen",
      "status": "pass"
    }
  ]
}
```

### `x402_execute_retry`

Input:

```json
{
  "attempt_id": "x402_...",
  "payment_signature": "buyer produced signature",
  "payment_headers": {
    "authorization": "X-PAYMENT ...",
    "payment-id": "pay_..."
  }
}
```

Output on successful paid retry:

```json
{
  "phase": "completed_with_retry",
  "attempt_id": "x402_...",
  "request_digest": "sha256...",
  "execute_body": {
    "quote_id": "q_...",
    "input": {
      "prompt": "..."
    }
  },
  "receipt_checklist": [
    {
      "check": "retry_used_same_execute_body",
      "status": "pass"
    },
    {
      "check": "receipt_identifier_present",
      "status": "pass"
    }
  ],
  "response": {
    "status": 200,
    "ok": true,
    "headers": {
      "payment-receipt": "rcpt_..."
    },
    "data": {
      "invocation_id": "inv_...",
      "receipt_id": "rcpt_..."
    }
  }
}
```

## Implementation notes

- Always hash the serialized execute body before the first call and compare that digest on retry.
- Do not rebuild the retry payload from partial state. Reuse the stored body object.
- Lowercase incoming buyer header keys before merging them into the retry request to avoid duplicate header variants.
- Capture both body-level receipt IDs and header-level receipt IDs; some integrations provide one but not the other.
- Preserve the raw paid response even when receipt extraction succeeds. Reconciliation bugs are often only diagnosable from the original headers.
- If the paid retry returns success without `receipt_id` or `payment-receipt`, keep the request marked as partially complete and reconcile it out of band before treating it as settled.