#!/usr/bin/env node
/**
 * demo — generates documentation only; moves no real funds.
 *
 * Run:
 *   node examples/agoragentic-growth/2026-06-21-render-commerce-funnel-blockers-guide-mj-c7de26169f/render-commerce-funnel-blockers-guide.mjs > x402/X402_COMMERCE_FUNNEL_BLOCKERS.md
 *   node examples/agoragentic-growth/2026-06-21-render-commerce-funnel-blockers-guide-mj-c7de26169f/render-commerce-funnel-blockers-guide.mjs --self-test
 */

import assert from 'node:assert/strict';

function lines(...items) {
  return items.flat().join('\n');
}

function jsRetryFlowSnippet() {
  return lines(
    '```js',
    'const paidChallenges = new Map();',
    '',
    'function challengeFingerprint(requirements) {',
    '  return JSON.stringify(requirements.map((item) => ({',
    '    scheme: item.scheme,',
    '    network: item.network,',
    '    payTo: item.payTo,',
    '    maxAmountRequired: item.maxAmountRequired,',
    '    asset: item.asset ?? item.currency,',
    '  })));',
    '}',
    '',
    'async function executeWith402Retry({ baseUrl, quoteId, input, payChallenge, idempotencyKey }) {',
    '  if (!idempotencyKey) {',
    '    throw new Error("caller must create and persist idempotencyKey before the first attempt");',
    '  }',
    '  const body = { quote_id: quoteId, input };',
    '  const headers = {',
    '    "content-type": "application/json",',
    '    "idempotency-key": idempotencyKey,',
    '  };',
    '',
    '  let response = await fetch(`${baseUrl}/api/x402/execute`, {',
    '    method: "POST",',
    '    headers,',
    '    body: JSON.stringify(body),',
    '  });',
    '',
    '  if (response.status !== 402) {',
    '    return response;',
    '  }',
    '',
    '  const encoded = response.headers.get("payment-required");',
    '  if (!encoded) throw new Error("402 response missing payment-required header");',
    '  const requirements = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));',
    '  const cacheKey = `${idempotencyKey}:${challengeFingerprint(requirements)}`;',
    '',
    '  let authorization = paidChallenges.get(cacheKey);',
    '  if (!authorization) {',
    '    authorization = await payChallenge(requirements, { idempotencyKey, body });',
    '    if (!authorization?.paymentSignature || typeof authorization.paymentSignature !== "string") {',
    '      throw new Error("payChallenge must return a paymentSignature string before retrying");',
    '    }',
    '    paidChallenges.set(cacheKey, authorization);',
    '  }',
    '',
    '  response = await fetch(`${baseUrl}/api/x402/execute`, {',
    '    method: "POST",',
    '    headers: {',
    '      ...headers,',
    '      "PAYMENT-SIGNATURE": authorization.paymentSignature,',
    '    },',
    '    body: JSON.stringify(body),',
    '  });',
    '',
    '  return response;',
    '}',
    '```'
  );
}

function curlRetryFlowSnippet() {
  return lines(
    '```bash',
    'IDEMPOTENCY_KEY="7df1dc0b-4db8-41bf-9188-f896982f1d66"',
    'QUOTE_ID="quote_demo_123"',
    '',
    '# First attempt: expect HTTP 402 with payment-required header.',
    'curl -i https://agoragentic.com/api/x402/execute \\',
    '  -H "Content-Type: application/json" \\',
    '  -H "Idempotency-Key: ${IDEMPOTENCY_KEY}" \\',
    '  -d "{\\"quote_id\\":\\"${QUOTE_ID}\\",\\"input\\":{\\"text\\":\\"hello\\"}}"',
    '',
    '# Retry: reuse the same Idempotency-Key and the exact payment authorization',
    '# created for that 402 challenge. Do not re-authorize unless the server issues',
    '# a fresh 402 with a changed challenge.',
    'curl -i https://agoragentic.com/api/x402/execute \\',
    '  -H "Content-Type: application/json" \\',
    '  -H "Idempotency-Key: ${IDEMPOTENCY_KEY}" \\',
    '  -H "PAYMENT-SIGNATURE: <authorization-from-first-402>" \\',
    '  -d "{\\"quote_id\\":\\"${QUOTE_ID}\\",\\"input\\":{\\"text\\":\\"hello\\"}}"',
    '```'
  );
}

function receiptChecklistTable() {
  return lines(
    '| Check | Why it matters | Fix when it fails |',
    '|---|---|---|',
    '| `receipt_id` in body matches `receipt_id` in receipt header/body | Prevents reconciling against the wrong execution | Treat the response as untrusted until both match |',
    '| `invocation_id` is present and durable | Lets you inspect status and later trace the paid run | Persist it with your local job or trace record |',
    '| `quote_id` matches the request you sent | Detects replay or stale quote bugs | Reject the result and fetch a fresh quote |',
    '| Paid amount matches the challenged amount | Catches unit mistakes and overpayment | Compare micro-USDC values, not rounded UI strings |',
    '| Input digest or request hash matches the original input | Confirms the receipt describes your request | Recompute locally before marking the run paid |',
    '| Receipt status is `settled` only when the API explicitly says so | Avoids claiming settlement from a broadcast-only transaction | Distinguish `submitted` from `settled` in logs and UI |',
    '| Same `Idempotency-Key` spans the original request and retry | Prevents duplicate execution after network loss | Reuse the key until the request is conclusively resolved |'
  );
}

function reconciliationExampleTable() {
  return lines(
    '| Symptom | Evidence to compare | Likely root cause | Next action |',
    '|---|---|---|---|',
    '| Customer sees money moved but your app shows failure | Local request log, `Idempotency-Key`, `invocation_id`, `receipt_id` | Client dropped the successful retry response or timed out after payment | Re-query status/receipt using the durable IDs before paying again |',
    '| `receipt_id` exists but result payload is empty | Response body, receipt digest, invocation status | Server persisted receipt before finishing response serialization | Treat the receipt as proof of payment, then recover result via status or support tooling |',
    '| Two receipts for one user action | Two different idempotency keys or a payment callback that re-signed on every retry | Duplicate authorization path | Collapse retries onto one idempotency key and cache the first authorization |',
    '| Response says success but no receipt is stored locally | App only saved business output | Missing audit write in success path | Persist `receipt_id`, `invocation_id`, cost, and payment method before returning success upstream |',
    '| Receipt shows `submitted` or no terminal state | On-chain proof/status call shows only broadcast progress | Settlement finality was assumed too early | Mark as pending and poll until the API exposes terminal settlement |'
  );
}

function buildGuide() {
  return lines(
    '# x402 commerce funnel blockers',
    '',
    'This guide focuses on the failure modes that break buyer onboarding after a quote looks valid but the paid call does not cleanly reconcile. The examples assume `GET /api/x402/execute/match` for quote discovery and `POST /api/x402/execute` for the paid call.',
    '',
    '## Fast triage order',
    '',
    '1. Save the original `quote_id`, `Idempotency-Key`, request body hash, and first HTTP status.',
    '2. If the first paid attempt returned `402`, keep the original challenge payload and do not authorize payment again unless a new `402` is issued.',
    '3. If any retry may have reached the server, look up `invocation_id` or `receipt_id` before creating another payment authorization.',
    '4. Reconcile using exact micro-USDC amounts and durable IDs, not rounded display values.',
    '5. Treat `submitted`, `broadcast`, or equivalent on-chain states as non-terminal until the API explicitly reports a settled receipt.',
    '',
    '## Blocker 1: the client re-pays on every retry',
    '',
    'This is the most expensive x402 integration bug. A network timeout after payment does not mean the server needs a second authorization. The safe pattern is: authorize only on HTTP `402`, cache that authorization under the original `Idempotency-Key`, then replay the same authorization for transport retries of the same request.',
    '',
    'Signals:',
    '',
    '- Multiple wallet authorization attempts for one UI action.',
    '- Different payment signatures attached to the same logical request.',
    '- Two receipts with nearly identical payloads but different request identifiers.',
    '',
    'Fix:',
    '',
    '- Generate one `Idempotency-Key` before the first POST.',
    '- Cache the first authorization produced for that `402` challenge.',
    '- Reuse that authorization for retries unless the server returns a fresh `402` with changed payment requirements.',
    '',
    jsRetryFlowSnippet(),
    '',
    '## Blocker 2: retries do not reuse the same Idempotency-Key',
    '',
    'If the first paid request times out and the retry gets a new `Idempotency-Key`, the server cannot safely collapse them into one execution. That creates the classic “buyer was charged twice” investigation, even if each individual request was valid.',
    '',
    'Signals:',
    '',
    '- Logs show a new request ID for every retry attempt.',
    '- The server created more than one invocation for the same user click.',
    '',
    'Fix:',
    '',
    '- Mint the idempotency key once at the start of the workflow, not inside a retry helper.',
    '- Reuse it across the initial request, the 402 replay, and any transport-level retried POST.',
    '',
    curlRetryFlowSnippet(),
    '',
    '## Blocker 3: receipt exists, but your app cannot reconcile it to the request',
    '',
    'A receipt is only useful if it can be matched back to the request that caused the spend. Builders often store the business result but drop the durable commerce fields. When support later needs to answer “what paid for this?”, the trail is gone.',
    '',
    'Store these fields together in one local record:',
    '',
    '- `quote_id`',
    '- `Idempotency-Key`',
    '- `invocation_id`',
    '- `receipt_id`',
    '- challenged amount in micro-USDC',
    '- normalized payment method (`x402`)',
    '- a request hash for the input body you actually sent',
    '',
    'Receipt reconciliation checklist:',
    '',
    receiptChecklistTable(),
    '',
    '## Blocker 4: success is reported before settlement is actually terminal',
    '',
    'Do not collapse “payment broadcast happened” and “receipt settled” into the same status. On-chain submission is not the same thing as terminal settlement. If your logs say `verified` or `settled`, that claim must come from the API fields you actually checked, not from a wallet callback that only confirmed submission.',
    '',
    'Signals:',
    '',
    '- UI shows success immediately, then finance later marks the payment unresolved.',
    '- The proof endpoint shows `submitted` or similar but your app stored `settled`.',
    '',
    'Fix:',
    '',
    '- Persist raw status values from the receipt or proof API.',
    '- Keep a distinct pending state for post-broadcast reconciliation.',
    '- Only mark the commerce record settled when the API exposes a terminal settled state.',
    '',
    '## Blocker 5: the 402 challenge is malformed or ignored',
    '',
    'Some clients inspect the response body but forget that the payment challenge is carried in headers. If `payment-required` is absent, empty, or unparsable, the client cannot construct the authorization and will either fail open or mis-price the payment.',
    '',
    'Signals:',
    '',
    '- HTTP `402` is returned, but the payment callback receives no usable challenge.',
    '- The payer signs for a default amount instead of the challenged amount.',
    '',
    'Fix:',
    '',
    '- Fail closed when the `payment-required` header is missing or invalid.',
    '- Base64-decode and parse the full challenge payload before invoking your wallet/payment callback.',
    '- Bind your cached authorization to the challenge fingerprint so you do not reuse it against a different challenge.',
    '',
    '## Blocker 6: a transport timeout is treated as a failed purchase instead of an unknown purchase',
    '',
    'After the buyer sends payment proof, the next failure mode is uncertainty, not a clean failure. The server may have accepted payment and completed the invocation while the client lost the response. In that case, immediately re-paying is the wrong move.',
    '',
    'Fix path:',
    '',
    '1. Reuse the same `Idempotency-Key` and same payment authorization for a replay if your transport library supports a safe repeat of the exact request.',
    '2. If you have `invocation_id` or `receipt_id`, query status or receipt before making a new payment decision.',
    '3. If you have neither durable ID, reconcile from your local request ledger: same idempotency key, same challenge fingerprint, same requested amount.',
    '',
    'Real-world reconciliation matrix:',
    '',
    reconciliationExampleTable(),
    '',
    '## Minimal buyer invariants',
    '',
    '- Authorize payment only when the server explicitly returns HTTP `402`.',
    '- Reuse the original authorization for retries of the same challenge.',
    '- Always send an `Idempotency-Key` and keep it stable for the entire request lifecycle.',
    '- Persist `invocation_id` and `receipt_id` with your business record before acknowledging success upstream.',
    '- Never claim a payment is settled, verified, or terminal unless the API field you checked says that explicitly.',
    '',
    '## Recommended local logging fields',
    '',
    '```text',
    'attempt_ts',
    'quote_id',
    'idempotency_key',
    'request_hash',
    'http_status',
    'payment_required_fingerprint',
    'payment_authorization_fingerprint',
    'invocation_id',
    'receipt_id',
    'challenged_amount_micro_usdc',
    'settlement_status',
    '```',
    '',
    '## Generation note',
    '',
    'This file can be regenerated with `node examples/agoragentic-growth/2026-06-21-render-commerce-funnel-blockers-guide-mj-c7de26169f/render-commerce-funnel-blockers-guide.mjs`.'
  );
}

function runSelfTest() {
  const output = buildGuide();
  const requiredSnippets = [
    '# x402 commerce funnel blockers',
    '## Blocker 1: the client re-pays on every retry',
    'Idempotency-Key',
    'Receipt reconciliation checklist:',
    'Never claim a payment is settled, verified, or terminal unless the API field you checked says that explicitly.',
    'caller must create and persist idempotencyKey before the first attempt',
    'payChallenge must return a paymentSignature string before retrying',
    'node examples/agoragentic-growth/2026-06-21-render-commerce-funnel-blockers-guide-mj-c7de26169f/render-commerce-funnel-blockers-guide.mjs',
  ];

  for (const snippet of requiredSnippets) {
    assert.ok(output.includes(snippet), `missing required snippet: ${snippet}`);
  }

  assert.ok(output.includes('```js'));
  assert.ok(output.includes('```bash'));
  assert.ok(output.includes('| Symptom | Evidence to compare | Likely root cause | Next action |'));
  return 'self-test: ok';
}

if (process.argv.includes('--self-test')) {
  console.log(runSelfTest());
} else {
  console.log(buildGuide());
}
