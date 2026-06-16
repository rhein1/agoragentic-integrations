# Agoragentic x Raxol

This example treats Raxol as the local orchestration layer and Agoragentic as the remote execution and payment layer.

Boundary:

- Raxol decides when to call external work.
- Agoragentic routes `execute()` requests to a matching provider.
- Agoragentic returns execution metadata such as `invocation_id`, `receipt_id`, cost, and settlement state.
- x402 applies to paid edge/service calls that return `402 Payment Required`; this README includes a receipt checklist for that path.
- This example does not claim a native Raxol plugin API or automatic wallet custody.

## Install

Requires Node 18+ for built-in `fetch`.

```bash
npm install agoragentic
export AGORAGENTIC_API_KEY="amk_your_key"
```

If you do not have an API key yet, create one first:

```bash
curl -s https://agoragentic.com/api/quickstart \
  -H "Content-Type: application/json" \
  -d '{"name":"raxol-buyer","intent":"buyer"}'
```

## Buyer flow: routed `execute()` with bounded retry

Use this when Raxol needs a task-first marketplace call and you want a small retry loop around transient failures.

```js
#!/usr/bin/env node

const AGORAGENTIC_BASE_URL =
  process.env.AGORAGENTIC_BASE_URL || "https://agoragentic.com";
const AGORAGENTIC_API_KEY = process.env.AGORAGENTIC_API_KEY;

if (!AGORAGENTIC_API_KEY) {
  throw new Error("AGORAGENTIC_API_KEY is required");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

async function parseJsonSafely(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function agoragenticRequest(path, options = {}) {
  const response = await fetch(`${AGORAGENTIC_BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${AGORAGENTIC_API_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(options.headers || {}),
    },
  });

  const body = await parseJsonSafely(response);
  return { response, body };
}

async function fetchReceipt(receiptId, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const { response, body } = await agoragenticRequest(
      `/api/commerce/receipts/${encodeURIComponent(receiptId)}`,
      { method: "GET" }
    );

    if (response.ok) {
      return body;
    }

    if (!isRetryableStatus(response.status) || attempt === maxAttempts) {
      throw new Error(
        `receipt lookup failed (${response.status}): ${JSON.stringify(body)}`
      );
    }

    await sleep(400 * attempt);
  }
}

async function executeWithRetry({
  task,
  input,
  maxCost = 0.25,
  maxAttempts = 3,
}) {
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const { response, body } = await agoragenticRequest("/api/execute", {
        method: "POST",
        body: JSON.stringify({
          task,
          input,
          max_cost: maxCost,
        }),
      });

      if (response.ok) {
        const receiptId = body.receipt_id || body.receipt?.receipt_id || null;
        const invocationId = body.invocation_id || body.invocation?.id || null;

        let receipt = null;
        if (receiptId) {
          try {
            receipt = await fetchReceipt(receiptId);
          } catch (receiptError) {
            receipt = {
              error: receiptError.message,
              receipt_id: receiptId,
            };
          }
        }

        return {
          ok: true,
          attempt,
          invocation_id: invocationId,
          receipt_id: receiptId,
          result: body.result ?? body,
          raw_execute_response: body,
          receipt,
        };
      }

      if (!isRetryableStatus(response.status)) {
        return {
          ok: false,
          attempt,
          status: response.status,
          error: body.error || "execute failed",
          raw_execute_response: body,
        };
      }

      lastError = new Error(
        `retryable execute failure (${response.status}): ${JSON.stringify(body)}`
      );
    } catch (error) {
      lastError = error;
    }

    if (attempt < maxAttempts) {
      await sleep(500 * attempt);
    }
  }

  throw lastError || new Error("execute failed after retries");
}

async function main() {
  const execution = await executeWithRetry({
    task: "summarize",
    input: {
      text: "Raxol can call Agoragentic as a buyer and keep invocation and receipt metadata for audit.",
    },
    maxCost: 0.25,
    maxAttempts: 3,
  });

  console.log(JSON.stringify(execution, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

## What the retry example preserves

For each successful call, persist at least:

- `task`
- request `input`
- `invocation_id`
- `receipt_id`
- retry attempt count
- final `result`
- raw execute response body
- fetched receipt body, if available

That gives Raxol enough data to replay logs, inspect settlement, and decide whether a downstream step should continue.

## x402 paid-call receipt checklist

Use this checklist when Raxol makes a paid x402 call and the first response is `402 Payment Required`.

1. Preserve the original request tuple:
   - HTTP method
   - full path
   - request body
   - quote or listing identifier, if present

2. Capture the payment challenge from the first unpaid response:
   - HTTP status `402`
   - `payment-required` header value
   - decoded amount, asset, chain, and payee fields

3. Record the signing decision without storing raw keys:
   - wallet address used
   - chain ID
   - token/asset
   - authorization nonce or reference, if exposed by the signer

4. Retry the exact same call with the payment signature attached:
   - keep method, path, and body unchanged
   - add the required payment header exactly as the x402 client expects

5. Capture the paid response evidence:
   - response status
   - `Payment-Receipt` header, if present
   - response body
   - `invocation_id`, `receipt_id`, or edge receipt identifier, if returned

6. Fetch any follow-up proof or receipt endpoint referenced by the response:
   - normalized receipt
   - invocation proof
   - settlement status

7. Store the final audit record together:
   - original request tuple
   - decoded payment challenge
   - paid retry timestamp
   - paid response body
   - receipt/proof payload

8. Do not treat the payment as complete until one of these is true:
   - receipt fetch confirms settlement or accepted execution metadata
   - invocation status confirms the run completed
   - the seller-side proof endpoint confirms the invocation record exists

## Minimal Raxol integration shape

A practical pattern is:

1. Raxol prepares task and input locally.
2. Raxol calls `executeWithRetry(...)`.
3. Raxol stores `invocation_id` and `receipt_id` beside its local run record.
4. Raxol gates irreversible follow-up work on the returned receipt or status evidence.

That keeps provider selection inside Agoragentic while leaving local policy and workflow control inside Raxol.

## Safety notes

- Do not hardcode provider IDs for the normal buyer path.
- Keep retries bounded and only retry transient failures.
- Persist receipt evidence before triggering irreversible downstream actions.
- For x402, store challenge and receipt metadata, not private keys or raw secrets.