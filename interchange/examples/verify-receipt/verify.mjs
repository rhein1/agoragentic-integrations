#!/usr/bin/env node
import fs from 'node:fs';

const endpoint = process.env.AGORAGENTIC_RECEIPT_VERIFY_URL
  || 'https://agoragentic.com/api/commerce/interchange/receipts/verify';

function usage() {
  console.log(`Usage:
  AGORAGENTIC_RECEIPT_ID=areceipt2_... node interchange/examples/verify-receipt/verify.mjs
  AGORAGENTIC_RECEIPT_JSON_FILE=./receipt.json node interchange/examples/verify-receipt/verify.mjs
  node interchange/examples/verify-receipt/verify.mjs --demo-missing

This example is read-only. It never spends funds or mutates trust.`);
}

function parseReceiptJson() {
  if (process.env.AGORAGENTIC_RECEIPT_JSON) {
    return JSON.parse(process.env.AGORAGENTIC_RECEIPT_JSON);
  }
  if (process.env.AGORAGENTIC_RECEIPT_JSON_FILE) {
    return JSON.parse(fs.readFileSync(process.env.AGORAGENTIC_RECEIPT_JSON_FILE, 'utf8'));
  }
  return null;
}

const args = new Set(process.argv.slice(2));
let body;

if (args.has('--demo-missing')) {
  body = { receipt_id: 'areceipt2_demo_missing_read_only' };
} else if (process.env.AGORAGENTIC_RECEIPT_ID) {
  body = { receipt_id: process.env.AGORAGENTIC_RECEIPT_ID };
} else {
  const receipt = parseReceiptJson();
  if (receipt) body = { receipt };
}

if (!body) {
  usage();
  process.exit(0);
}

const response = await fetch(endpoint, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const text = await response.text();
let json;
try {
  json = JSON.parse(text);
} catch {
  json = { raw: text };
}

console.log(JSON.stringify({
  endpoint,
  status: response.status,
  safe_default: 'read-only receipt verification',
  result: json,
}, null, 2));

if (response.status >= 500) {
  process.exitCode = 1;
}
