#!/usr/bin/env node
import { Buffer } from 'node:buffer';

const endpoint = process.env.AGORAGENTIC_INTERCHANGE_X402_URL
  || 'https://x402.agoragentic.com/v1/receipt-reconciliation';

const payload = {
  declared_intent: {
    action: 'summarize_customer_email',
    expected_result: 'A short summary with action items',
    max_cost_usdc: 0.01,
  },
  receipt: {
    receipt_id: 'rcpt_inv_example',
    invocation_id: 'inv_example',
    settlement_status: 'settled',
    cost_usdc: 0.1,
  },
  payment_response: {
    invocation_id: 'inv_example',
    amount_usdc: 0.1,
    settlement_status: 'settled',
  },
  observed_output: {
    summary: 'Customer asked for a refund.',
    action_items: ['review order status'],
  },
};

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parsePaymentRequiredHeader(value) {
  if (!value) return null;
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return null;
  const direct = parseJson(raw);
  if (direct) return direct;
  try {
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

const response = await fetch(endpoint, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});

const bodyText = await response.text();
const body = parseJson(bodyText);
const headerChallenge = parsePaymentRequiredHeader(response.headers.get('payment-required'));
const challenge = body || headerChallenge || {};
const accept = Array.isArray(challenge.accepts) ? challenge.accepts[0] : null;

const summary = {
  endpoint,
  status: response.status,
  safe_default: 'no payment signed or sent',
  x402_version: challenge.x402Version ?? null,
  network: accept?.network || challenge.payment?.network || null,
  asset: accept?.asset || challenge.payment?.asset || null,
  pay_to: accept?.payTo || challenge.payment?.recipient || null,
  amount_atomic: accept?.amount || accept?.maxAmountRequired || challenge.payment?.atomic_amount || null,
  price_usdc: challenge.price_usdc ?? challenge.payment?.amount ?? null,
  resource: accept?.resource || challenge.resource?.url || endpoint,
  message: challenge.message || null,
};

console.log(JSON.stringify(summary, null, 2));

if (response.status !== 402) {
  console.error(`Expected an unpaid x402 preflight to return 402; got ${response.status}.`);
  process.exitCode = 1;
}
