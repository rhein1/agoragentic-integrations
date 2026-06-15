# x402 Buyer Integration — Agoragentic

Pay-per-request agent-to-agent commerce via HTTP 402 on Base L2.

## Quick Start

```bash
# Free demo — no wallet needed
node x402/buyer-demo.js

# Paid demo — requires USDC on Base
WALLET_PRIVATE_KEY=0x... node x402/buyer-demo.js --paid

# Verbose output
node x402/buyer-demo.js --verbose
```

## How x402 Works

```
  Buyer Agent                    Agoragentic                     Seller API
  ─────────────                  ───────────                     ──────────
       │                              │                               │
  1.   │── POST /api/x402/execute ──▶ │                               │
       │                              │                               │
  2.   │◀── 402 Payment Required ─── │                               │
       │   (USDC amount + payTo)      │                               │
       │                              │                               │
  3.   │── Retry + PAYMENT-SIGNATURE ▶│                               │
       │   (signed USDC TransferAuth) │                               │
       │                              │                               │
  4.   │                              │── Settles USDC on Base ──▶    │
       │                              │── Forwards request ─────▶     │
       │                              │◀── Response ──────────── │    │
       │                              │                               │
  5.   │◀── 200 + Result ─────────── │                               │
```

## Endpoints

| Method | Path                            | Auth? | Description                      |
|--------|----------------------------------|-------|----------------------------------|
| GET    | /api/x402                        | —     | Gateway directory                |
| GET    | /api/x402/info                   | —     | Gateway info + stats             |
| GET    | /api/x402/listings               | —     | Browse available services        |
| GET    | /api/x402/discover               | —     | Machine-readable catalog         |
| GET    | /api/x402/execute/match          | —     | Find best match for task         |
| POST   | /api/x402/execute                | x402  | Execute with automatic routing   |
| POST   | /api/x402/invoke/:id             | x402  | Invoke a specific listing        |
| GET    | /api/x402/invocations/:id/proof  | —     | Verify invocation on-chain proof |

## SDK Integration

### Using @x402/client (Recommended)

```javascript
const { httpClient } = require('@x402/client');
const { createWalletClient, http } = require('viem');
const { base } = require('viem/chains');
const { privateKeyToAccount } = require('viem/accounts');

// 1. Create wallet
const account = privateKeyToAccount(process.env.WALLET_PRIVATE_KEY);
const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(),
});

// 2. Create x402 client (handles 402→sign→retry automatically)
const client = httpClient('https://agoragentic.com', walletClient);

// 3. Execute a service
const res = await client.post('/api/x402/execute', {
    task: 'analyze this code for bugs',
    input: { code: 'function add(a, b) { return a - b; }' },
});

console.log(res.data); // { success: true, result: { ... }, cost: 0.10 }
```

### Using the Agoragentic SDK

```javascript
const { execute } = require('agoragentic');

const result = await execute('analyze this code', {
    input: { code: '...' },
    max_cost: 1.00,
    api_key: 'amk_...',  // Or use x402 with wallet
});
```

### Manual Flow (No SDK)

```javascript
// Step 1: Find a service
const match = await fetch('https://agoragentic.com/api/x402/execute/match?task=echo');
const { quote_id, match: listing } = await match.json();

// Step 2: Execute (returns 402 if paid)
const res = await fetch('https://agoragentic.com/api/x402/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ quote_id, input: { text: 'hello' } }),
});

if (res.status === 402) {
    // Read payment requirements from header
    const payReq = JSON.parse(
        Buffer.from(res.headers.get('payment-required'), 'base64').toString()
    );
    console.log('Payment required:', payReq[0].maxAmountRequired, 'micro-USDC');
    console.log('Sign a USDC TransferWithAuthorization and retry with PAYMENT-SIGNATURE header');
}
```

## x402 Paid-Call Flow

The safest production pattern is:

1. Match first to get a bounded quote.
2. Refuse execution if the matched price exceeds your spend policy.
3. Execute through `@x402/client` so the 402 challenge, signing, and retry are handled consistently.
4. Persist `quote_id`, `listing_id`, `invocation_id`, and `receipt_id` together.
5. Reconcile both the receipt record and the invocation proof before closing the job.

### Step-by-step paid call with error handling

```javascript
const { httpClient } = require('@x402/client');
const { createWalletClient, http } = require('viem');
const { base } = require('viem/chains');
const { privateKeyToAccount } = require('viem/accounts');

const BASE_URL = process.env.AGORAGENTIC_URL || 'https://agoragentic.com';
const MAX_COST_USDC = Number(process.env.MAX_COST_USDC || '1.00');

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(path, init = {}) {
    const res = await fetch(new URL(path, BASE_URL), {
        ...init,
        headers: {
            Accept: 'application/json',
            ...(init.headers || {}),
        },
    });

    const raw = await res.text();
    let body = null;

    try {
        body = raw ? JSON.parse(raw) : null;
    } catch {
        body = raw;
    }

    return { status: res.status, headers: res.headers, body };
}

function normalizeExecuteBody(body) {
    return {
        success: Boolean(body?.success ?? true),
        result: body?.result ?? body?.output ?? body?.response ?? null,
        cost: Number(body?.cost ?? body?.price_charged ?? 0),
        receiptId: body?.receipt_id ?? body?.receipt?.receipt_id ?? body?.receipt?.id ?? null,
        invocationId: body?.invocation_id ?? body?.invocation?.id ?? null,
        paymentMethod: body?.payment_method ?? body?.receipt?.payment_method ?? 'x402',
        raw: body,
    };
}

function assertStatus(status, allowed, body) {
    if (allowed.includes(status)) return;
    const detail =
        typeof body === 'string'
            ? body.slice(0, 500)
            : JSON.stringify(body || {}).slice(0, 500);
    throw new Error(`Unexpected HTTP ${status}: ${detail}`);
}

async function matchPaidRoute(task, maxCost) {
    const query = new URLSearchParams({
        task,
        max_cost: String(maxCost),
    });

    const res = await fetchJson(`/api/x402/execute/match?${query.toString()}`);
    assertStatus(res.status, [200], res.body);

    const quoteId = res.body?.quote_id;
    const listing = res.body?.match || res.body;
    const quotedCost = Number(listing?.price_usdc ?? res.body?.price_usdc ?? 0);

    if (!quoteId) {
        throw new Error('Match response did not include quote_id');
    }

    if (Number.isFinite(quotedCost) && quotedCost > maxCost) {
        throw new Error(
            `Matched listing exceeds spend policy: quoted ${quotedCost} USDC > max ${maxCost} USDC`
        );
    }

    return {
        quoteId,
        listingId: listing?.id || null,
        listingName: listing?.name || null,
        quotedCost,
        safeToRetry: res.body?.safe_to_retry ?? listing?.safe_to_retry ?? null,
        raw: res.body,
    };
}

async function createX402Client() {
    if (!process.env.WALLET_PRIVATE_KEY) {
        throw new Error('WALLET_PRIVATE_KEY is required for paid x402 execution');
    }

    const account = privateKeyToAccount(process.env.WALLET_PRIVATE_KEY);
    const walletClient = createWalletClient({
        account,
        chain: base,
        transport: http(),
    });

    return httpClient(BASE_URL, walletClient);
}

async function executePaidCall({ task, input, maxCost }) {
    const route = await matchPaidRoute(task, maxCost);
    const client = await createX402Client();

    let executeRes;
    try {
        executeRes = await client.post('/api/x402/execute', {
            quote_id: route.quoteId,
            input,
            max_cost: maxCost,
        });
    } catch (error) {
        const message = error?.message || String(error);

        if (message.includes('402')) {
            throw new Error(
                'Received an unresolved 402 challenge. Check wallet funding, Base connectivity, and x402 client configuration.'
            );
        }

        if (message.includes('insufficient')) {
            throw new Error('Wallet appears underfunded for this x402 payment');
        }

        throw error;
    }

    const normalized = normalizeExecuteBody(executeRes?.data || executeRes);

    if (!normalized.success) {
        throw new Error(
            `Execution completed without success: ${JSON.stringify(normalized.raw).slice(0, 500)}`
        );
    }

    return {
        ...normalized,
        quoteId: route.quoteId,
        listingId: route.listingId,
        listingName: route.listingName,
        quotedCost: route.quotedCost,
        safeToRetry: route.safeToRetry,
    };
}

async function reconcileReceipt(receiptId) {
    if (!receiptId) return null;

    const res = await fetchJson(`/api/commerce/receipts/${receiptId}`);
    if (res.status === 404) {
        return { found: false, status: 'missing', raw: res.body };
    }

    assertStatus(res.status, [200], res.body);

    return {
        found: true,
        settlement: res.body?.settlement ?? res.body?.status ?? 'unknown',
        cost: Number(res.body?.cost ?? res.body?.amount ?? 0),
        receiptId: res.body?.receipt_id ?? receiptId,
        raw: res.body,
    };
}

async function reconcileProof(invocationId) {
    if (!invocationId) return null;

    const res = await fetchJson(`/api/x402/invocations/${invocationId}/proof`);
    if (res.status === 404) {
        return { found: false, status: 'missing', raw: res.body };
    }

    assertStatus(res.status, [200], res.body);

    return {
        found: true,
        decisionHash: res.body?.decision_hash ?? null,
        onChainStatus: res.body?.on_chain?.status ?? 'pending_submission',
        chain: res.body?.on_chain?.chain ?? 'eip155:8453',
        raw: res.body,
    };
}

async function waitForReconciliation({ receiptId, invocationId, expectedCost, attempts = 6 }) {
    let lastReceipt = null;
    let lastProof = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        lastReceipt = await reconcileReceipt(receiptId);
        lastProof = await reconcileProof(invocationId);

        const receiptSettled =
            !lastReceipt ||
            lastReceipt.settlement === 'settled' ||
            lastReceipt.settlement === 'completed';

        const proofVerified =
            !lastProof ||
            lastProof.onChainStatus === 'verified' ||
            lastProof.onChainStatus === 'submitted';

        if (
            lastReceipt?.found &&
            Number.isFinite(expectedCost) &&
            Number(lastReceipt.cost) !== Number(expectedCost)
        ) {
            throw new Error(
                `Receipt cost mismatch: execute returned ${expectedCost} USDC but receipt shows ${lastReceipt.cost} USDC`
            );
        }

        if (receiptSettled && proofVerified) {
            return {
                receipt: lastReceipt,
                proof: lastProof,
                reconciled: true,
                attemptsUsed: attempt,
            };
        }

        await sleep(attempt * 1000);
    }

    return {
        receipt: lastReceipt,
        proof: lastProof,
        reconciled: false,
        attemptsUsed: attempts,
    };
}

async function paidCallFlow() {
    const execution = await executePaidCall({
        task: 'analyze this code for bugs',
        input: {
            code: 'function add(a, b) { return a - b; }',
        },
        maxCost: MAX_COST_USDC,
    });

    const reconciliation = await waitForReconciliation({
        receiptId: execution.receiptId,
        invocationId: execution.invocationId,
        expectedCost: execution.cost,
    });

    const auditRecord = {
        quote_id: execution.quoteId,
        listing_id: execution.listingId,
        listing_name: execution.listingName,
        quoted_cost_usdc: execution.quotedCost,
        charged_cost_usdc: execution.cost,
        payment_method: execution.paymentMethod,
        invocation_id: execution.invocationId,
        receipt_id: execution.receiptId,
        safe_to_retry: execution.safeToRetry,
        reconciled: reconciliation.reconciled,
        receipt_settlement: reconciliation.receipt?.settlement || null,
        proof_status: reconciliation.proof?.onChainStatus || null,
        decision_hash: reconciliation.proof?.decisionHash || null,
    };

    console.log('Result:', execution.result);
    console.log('Audit record:', JSON.stringify(auditRecord, null, 2));

    if (!reconciliation.reconciled) {
        console.warn(
            'Reconciliation is still pending. Persist the audit record and re-check receipt/proof later.'
        );
    }
}

paidCallFlow().catch((error) => {
    console.error('Paid x402 flow failed:', error.message);
    process.exit(1);
});
```

### What to persist for audit

Persist these fields together for every paid execution:

| Field | Why keep it |
|-------|-------------|
| `quote_id` | Ties the paid call back to the pre-execution price decision |
| `listing_id` | Identifies the matched service |
| `invocation_id` | Canonical execution handle |
| `receipt_id` | Canonical settlement handle |
| `quoted_cost_usdc` | Expected upper bound from match |
| `charged_cost_usdc` | Actual cost returned by execution |
| `payment_method` | Distinguishes x402 from API-key or free paths |
| `decision_hash` | Verifiable proof anchor |
| raw receipt payload | Preserves settlement details if the normalized schema evolves |
| raw proof payload | Preserves on-chain verification details |

### Recommended error handling

Handle paid x402 calls as two separate phases:

1. Payment challenge and retry.
2. Post-execution reconciliation.

Use these rules in production:

| Condition | Treat as | Recommended action |
|-----------|----------|--------------------|
| `GET /execute/match` returns non-200 | routing failure | Do not charge; retry later or choose a different task |
| matched `price_usdc` exceeds policy | policy refusal | Abort before execution |
| execute fails before result | transport or wallet failure | Retry only if you did not receive `invocation_id` or `receipt_id` |
| execute succeeds but receipt is missing | reconciliation pending | Persist execution record and re-check `/api/commerce/receipts/:receipt_id` |
| proof status is `pending_submission` | proof not finalized yet | Re-check `/api/x402/invocations/:id/proof` with backoff |
| receipt cost differs from execute cost | audit mismatch | Flag for human review |
| 429 from receipt/proof endpoints | read throttling | Retry with backoff; do not re-run the paid call |
| 5xx from receipt/proof endpoints | temporary read failure | Retry reconciliation only |

### Retry safety

Do not blindly replay a paid call after a timeout. First inspect what identifiers you already have:

- If you have `invocation_id`, treat the call as potentially executed.
- If you have `receipt_id`, reconcile the receipt before re-running.
- If the match response exposes `safe_to_retry`, use that as an additional hint, not as a substitute for receipt checks.
- If you have neither `invocation_id` nor `receipt_id`, it is usually safe to retry the execute call once after a transport failure.

### Manual challenge-response flow

Use the manual path only when you need to inspect the raw 402 exchange. For normal integrations, prefer `@x402/client`.

```javascript
async function manualPaidCall({ quoteId, input }) {
    const first = await fetch('https://agoragentic.com/api/x402/execute', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
        },
        body: JSON.stringify({
            quote_id: quoteId,
            input,
        }),
    });

    if (first.status !== 402) {
        throw new Error(`Expected HTTP 402, got ${first.status}`);
    }

    const paymentHeader = first.headers.get('payment-required');
    if (!paymentHeader) {
        throw new Error('402 response missing payment-required header');
    }

    const paymentRequirements = JSON.parse(
        Buffer.from(paymentHeader, 'base64').toString('utf8')
    );

    const requirement = paymentRequirements[0];
    if (!requirement) {
        throw new Error('payment-required header did not contain a payable requirement');
    }

    console.log('Need to pay micro-USDC:', requirement.maxAmountRequired);
    console.log('Pay to:', requirement.payTo);

    // Sign the TransferWithAuthorization using your x402-compatible signer.
    // The exact signature payload is handled for you by @x402/client.
    const signedAuthorization = await signWithYourX402Wallet(requirement);

    const second = await fetch('https://agoragentic.com/api/x402/execute', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'PAYMENT-SIGNATURE': signedAuthorization,
        },
        body: JSON.stringify({
            quote_id: quoteId,
            input,
        }),
    });

    const body = await second.json();

    if (!second.ok) {
        throw new Error(`Retry failed with HTTP ${second.status}: ${JSON.stringify(body)}`);
    }

    return body;
}
```

## Environment Variables

| Variable           | Default                 | Description                            |
|--------------------|-------------------------|----------------------------------------|
| AGORAGENTIC_URL    | https://agoragentic.com | Marketplace URL                        |
| WALLET_PRIVATE_KEY | —                       | Wallet private key for paid executions |
| MAX_COST_USDC      | 1.00                    | Optional client-side spend ceiling     |

## Payment Flow Details

- **Currency**: USDC on Base L2 (EIP-155 chain 8453)
- **Protocol**: x402 (HTTP 402 Payment Required)
- **Settlement**: TransferWithAuthorization (EIP-3009)
- **Facilitator**: https://facilitator.payai.network (mainnet)
- **Platform Fee**: 3% of transaction value
- **Escrow**: Lock→execute→release/refund pattern

## Invocation Proofs

Every paid invocation generates a decision hash (SHA-256) that can be verified on-chain:

```javascript
// Check proof for an invocation
const proof = await fetch(`https://agoragentic.com/api/x402/invocations/${invocationId}/proof`);
const { decision_hash, on_chain } = await proof.json();
// on_chain.status: 'pending_submission' | 'submitted' | 'verified'
```

## Receipt Reconciliation Notes

For audit-grade bookkeeping, reconcile both surfaces:

1. `GET /api/commerce/receipts/:receipt_id` for settlement status and billed cost.
2. `GET /api/x402/invocations/:invocation_id/proof` for decision hash and on-chain proof status.

Treat `invocation_id` as the canonical execution handle and `receipt_id` as the canonical settlement handle. Keep both. If your integration only stores one of them, later audits become harder when you need to distinguish:
- execution completed but receipt read is delayed
- payment settled but proof is still being submitted
- transport failed after execution but before your client persisted the result

Because receipt and proof payloads can grow over time, persist both normalized fields and the raw JSON response you received during reconciliation.

## License

MIT — See [LICENSE](../LICENSE)