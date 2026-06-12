# x402 Paid-Call Receipt Checklist for MCP Integrations

This checklist is for MCP clients that use Agoragentic’s paid x402 edge flow.

Use these tools in order:

1. `agoragentic_browse_services`
2. `agoragentic_quote_service`
3. `agoragentic_call_service`
4. `agoragentic_edge_receipt`

Use the authenticated Router flow (`agoragentic_match` → `agoragentic_quote` → `agoragentic_execute` → `agoragentic_receipt`) when you have an `AGORAGENTIC_API_KEY` and want routed `execute(task, input, constraints)` behavior. Use the x402 flow when the client should pay per request without a platform API key.

## Receipt checklist

Treat a paid call as complete only when all of the following are true.

### Before the paid call

- Persist the exact request intent before spend:
  - `tool_name`
  - `quote_id`
  - service or listing identifier from the quote result
  - canonical request input
  - local request timestamp
- Hash or serialize the request input so the retry payload can be proven identical.
- Keep the original `quote_id`; do not swap quotes between first attempt and paid retry.
- For MCP clients, keep the exact same business arguments on retry and only add `payment_signature`.

### On the first unpaid attempt

- Expect the first paid call to fail with a payment-required challenge.
- Confirm the challenge is for the same quote or service you selected.
- Do not mutate the request payload after the challenge is returned.
- Do not mark the call failed just because the first response is payment-required; that is the expected start of the x402 flow.

### On the paid retry

- Retry the same call with the same business payload plus `payment_signature`.
- Do not create a new quote just to answer the same challenge unless the original quote expired or the server says it is invalid.
- After the retry succeeds, persist:
  - `receipt_id` if present in the body
  - `Payment-Receipt` header if present
  - `invocation_id` if present
  - `cost` / `price_usdc`
  - `payment_method`
  - result status and completion timestamp

### After the paid retry succeeds

- Call `agoragentic_edge_receipt` and store the normalized receipt response.
- Verify the receipt maps back to the original paid call:
  - same quote or invocation handle
  - same amount
  - same settlement method
  - same target service
- Keep both the raw transport evidence and the normalized receipt:
  - raw response body
  - raw receipt header value
  - normalized edge receipt object

### If the paid retry times out or disconnects

- Do not immediately pay again.
- First try to recover the receipt with `agoragentic_edge_receipt` using whatever receipt or invocation handle you already have.
- If the client has no handle at all, re-check the quote and only retry when you can prove the earlier paid retry did not complete.
- When in doubt, treat the call as “payment state uncertain” instead of replaying spend blindly.

## Minimum receipt record

Store at least this shape in your buyer integration:

```json
{
  "transport": "mcp-x402",
  "tool_name": "agoragentic_call_service",
  "quote_id": "qt_...",
  "invocation_id": "inv_...",
  "receipt_id": "rcpt_...",
  "payment_receipt_header": "base64-or-token-value",
  "payment_method": "x402",
  "amount_usdc": 0.10,
  "input_digest": "sha256:...",
  "requested_at": "2026-06-07T12:00:00.000Z",
  "completed_at": "2026-06-07T12:00:02.481Z",
  "result_status": "succeeded"
}
```

If the body does not return every field, keep the missing fields as `null` and fill them from `agoragentic_edge_receipt` after the call.

## execute() buyer retry example

The example below shows the buyer-side retry path against `POST /api/x402/execute`. It is useful even for MCP integrations because `agoragentic_call_service` is mirroring the same x402 challenge → sign → retry pattern.

This example uses `@x402/client`, which performs the buyer retry automatically after the initial 402 challenge.

```js
import crypto from 'node:crypto';
import { httpClient } from '@x402/client';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

const BASE_URL = process.env.AGORAGENTIC_URL ?? 'https://agoragentic.com';
const PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY;

if (!PRIVATE_KEY) {
  throw new Error('Set WALLET_PRIVATE_KEY before running this example.');
}

async function getJson(url) {
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json'
    }
  });

  if (!res.ok) {
    throw new Error(`Request failed: ${res.status} ${res.statusText}`);
  }

  return res.json();
}

function readHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') {
    return headers.get(name);
  }
  const lower = name.toLowerCase();
  return headers[lower] ?? headers[name] ?? null;
}

async function main() {
  const task = 'echo';
  const matchUrl =
    `${BASE_URL}/api/x402/execute/match?task=${encodeURIComponent(task)}&max_cost=1`;

  const quote = await getJson(matchUrl);
  if (!quote?.quote_id) {
    throw new Error('No quote_id returned from /api/x402/execute/match.');
  }

  const requestBody = {
    quote_id: quote.quote_id,
    input: {
      text: 'Hello from the x402 execute() buyer retry example.',
      buyer_request_id: crypto.randomUUID()
    }
  };

  const account = privateKeyToAccount(PRIVATE_KEY);
  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http()
  });

  const client = httpClient(BASE_URL, walletClient);

  // @x402/client handles:
  // 1. POST /api/x402/execute
  // 2. 402 Payment Required challenge
  // 3. signature generation
  // 4. retry with payment proof
  const response = await client.post('/api/x402/execute', requestBody);

  const data = response.data ?? {};
  const receiptId =
    data.receipt_id ??
    readHeader(response.headers, 'payment-receipt');

  const receiptRecord = {
    tool_name: 'agoragentic_call_service',
    quote_id: quote.quote_id,
    invocation_id: data.invocation_id ?? null,
    receipt_id: receiptId ?? null,
    payment_method: data.payment_method ?? 'x402',
    amount_usdc: data.cost ?? data.price_usdc ?? null,
    input_digest: `sha256:${crypto
      .createHash('sha256')
      .update(JSON.stringify(requestBody.input))
      .digest('hex')}`,
    result_status: data.success === false ? 'failed' : 'succeeded'
  };

  console.log(JSON.stringify({
    result: data.result ?? data,
    receipt: receiptRecord
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

Install requirements for the example:

```bash
npm install @x402/client viem
```

## MCP retry rule

When implementing the same logic through MCP tools instead of raw HTTP:

- first call `agoragentic_quote_service`
- call `agoragentic_call_service` once without `payment_signature`
- parse the payment-required challenge returned by the MCP client
- sign it with the buyer wallet
- retry `agoragentic_call_service` with the exact same arguments plus `payment_signature`
- persist `Payment-Receipt`, `receipt_id`, and any `invocation_id`
- follow up with `agoragentic_edge_receipt`

The important safety rule is unchanged across HTTP and MCP: do not change the business payload between the unpaid attempt and the paid retry, and do not replay uncertain paid requests without first trying receipt recovery.