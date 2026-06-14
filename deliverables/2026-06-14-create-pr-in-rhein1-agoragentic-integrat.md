┊ review diff
a//tmp/paid_receipt_mock_mcp_example.js → b//tmp/paid_receipt_mock_mcp_example.js
@@ -0,0 +1,423 @@
+#!/usr/bin/env node
+'use strict';
+
+const http = require('http');
+const crypto = require('crypto');
+
+const HOST = '127.0.0.1';
+const PORT = Number(process.env.MOCK_MCP_PORT || 4877);
+const MCP_PATH = '/mcp';
+const MOCK_PAYMENT_AMOUNT = '250000';
+const MOCK_PAY_TO = '0x0000000000000000000000000000000000004020';
+
+function sha256(input) {
+  return crypto.createHash('sha256').update(input).digest('hex');
+}
+
+function toBase64Json(value) {
+  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
+}
+
+function fromBase64Json(value) {
+  if (!value) return null;
+  try {
+    return JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
+  } catch {
+    return null;
+  }
+}
+
+function readRequestBody(req) {
+  return new Promise((resolve, reject) => {
+    const chunks = [];
+    req.on('data', (chunk) => chunks.push(chunk));
+    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
+    req.on('error', reject);
+  });
+}
+
+function writeJson(res, statusCode, payload, extraHeaders = {}) {
+  const body = JSON.stringify(payload, null, 2);
+  res.writeHead(statusCode, {
+    'content-type': 'application/json; charset=utf-8',
+    'content-length': Buffer.byteLength(body),
+    ...extraHeaders,
+  });
+  res.end(body);
+}
+
+function buildChallenge(requestDigest) {
+  return [{
+    scheme: 'exact',
+    network: 'base',
+    asset: 'USDC',
+    maxAmountRequired: MOCK_PAYMENT_AMOUNT,
+    payTo: MOCK_PAY_TO,
+    resource: `http://${HOST}:${PORT}${MCP_PATH}`,
+    description: 'Mock x402 payment challenge for MCP execute()',
+    requestDigest,
+  }];
+}
+
+async function postJson(url, rawBody, headers = {}) {
+  const response = await fetch(url, {
+    method: 'POST',
+    headers: {
+      accept: 'application/json',
+      'content-type': 'application/json',
+      ...headers,
+    },
+    body: rawBody,
+  });
+
+  const text = await response.text();
+  let data;
+  try {
+    data = text ? JSON.parse(text) : {};
+  } catch {
+    data = { raw: text };
… omitted 345 diff line(s) across 1 additional file(s)/section(s)
#!/usr/bin/env node
'use strict';

const http = require('http');
const crypto = require('crypto');

const HOST = '127.0.0.1';
const PORT = Number(process.env.MOCK_MCP_PORT || 4877);
const MCP_PATH = '/mcp';
const MOCK_PAYMENT_AMOUNT = '250000';
const MOCK_PAY_TO = '0x0000000000000000000000000000000000004020';

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function toBase64Json(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

function fromBase64Json(value) {
  if (!value) return null;
  try {
    return JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function writeJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function buildChallenge(requestDigest) {
  return [{
    scheme: 'exact',
    network: 'base',
    asset: 'USDC',
    maxAmountRequired: MOCK_PAYMENT_AMOUNT,
    payTo: MOCK_PAY_TO,
    resource: `http://${HOST}:${PORT}${MCP_PATH}`,
    description: 'Mock x402 payment challenge for MCP execute()',
    requestDigest,
  }];
}

async function postJson(url, rawBody, headers = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...headers,
    },
    body: rawBody,
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  const responseHeaders = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key.toLowerCase()] = value;
  });

  return {
    status: response.status,
    ok: response.ok,
    data,
    headers: responseHeaders,
  };
}

function normalizeReceipt(payload, headers) {
  const result = payload && typeof payload === 'object' ? payload.result || payload : {};
  const receipt = result.receipt && typeof result.receipt === 'object' ? result.receipt : {};

  return {
    invocation_id: result.invocation_id || result.invocationId || null,
    receipt_id: result.receipt_id || result.receiptId || receipt.id || null,
    payment_receipt_header: headers['payment-receipt'] || null,
    payment_method: result.payment_method || result.paymentMethod || receipt.payment_method || null,
    settlement: result.settlement || receipt.settlement || null,
    cost: result.cost ?? receipt.cost ?? null,
    output: result.output || null,
  };
}

function buildReceiptChecklist({ requestDigest, firstResponse, retryResponse, paymentRequired, receipt }) {
  return [
    {
      check: 'request_body_frozen_before_first_call',
      status: requestDigest ? 'pass' : 'fail',
      evidence: requestDigest,
    },
    {
      check: 'first_response_status_recorded',
      status: Number.isInteger(firstResponse.status) ? 'pass' : 'fail',
      evidence: firstResponse.status,
    },
    {
      check: 'payment_required_challenge_decoded',
      status: firstResponse.status === 402 ? (paymentRequired ? 'pass' : 'fail') : 'not_applicable',
      evidence: paymentRequired,
    },
    {
      check: 'retry_used_same_body_digest',
      status: retryResponse.headers['x-request-digest'] === requestDigest ? 'pass' : 'fail',
      evidence: {
        expected: requestDigest,
        actual: retryResponse.headers['x-request-digest'] || null,
      },
    },
    {
      check: 'retry_completed_successfully',
      status: retryResponse.ok ? 'pass' : 'fail',
      evidence: retryResponse.status,
    },
    {
      check: 'invocation_id_captured',
      status: receipt.invocation_id ? 'pass' : 'warn',
      evidence: receipt.invocation_id,
    },
    {
      check: 'receipt_identifier_captured',
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
      status: Object.keys(retryResponse.headers).length > 0 ? 'pass' : 'warn',
      evidence: Object.keys(retryResponse.headers),
    },
    {
      check: 'raw_body_preserved',
      status: retryResponse.data !== undefined ? 'pass' : 'warn',
      evidence: typeof retryResponse.data,
    },
  ];
}

async function executeWithBuyerRetry({ endpointUrl, executeArgs, getPaymentHeaders }) {
  const rpcRequest = {
    jsonrpc: '2.0',
    id: `req_${crypto.randomUUID()}`,
    method: 'tools/call',
    params: {
      name: 'execute',
      arguments: executeArgs,
    },
  };

  const rawBody = JSON.stringify(rpcRequest);
  const requestDigest = sha256(rawBody);

  const firstResponse = await postJson(endpointUrl, rawBody, {
    'x-request-digest': requestDigest,
  });

  if (firstResponse.status !== 402) {
    if (!firstResponse.ok) {
      throw new Error(`execute() failed before payment retry: HTTP ${firstResponse.status}`);
    }

    const receipt = normalizeReceipt(firstResponse.data, firstResponse.headers);
    return {
      request_digest: requestDigest,
      first_response_status: firstResponse.status,
      payment_required: null,
      receipt,
      checklist: buildReceiptChecklist({
        requestDigest,
        firstResponse,
        retryResponse: firstResponse,
        paymentRequired: null,
        receipt,
      }),
      response: firstResponse.data,
    };
  }

  const paymentRequired = fromBase64Json(firstResponse.headers['payment-required']);
  const paymentHeaders = await getPaymentHeaders({
    payment_required: paymentRequired,
    request_digest: requestDigest,
    request_body: rawBody,
    execute_args: executeArgs,
  });

  const retryResponse = await postJson(endpointUrl, rawBody, {
    'x-request-digest': requestDigest,
    ...paymentHeaders,
  });

  if (!retryResponse.ok) {
    throw new Error(`execute() retry failed: HTTP ${retryResponse.status}`);
  }

  const receipt = normalizeReceipt(retryResponse.data, retryResponse.headers);
  return {
    request_digest: requestDigest,
    first_response_status: firstResponse.status,
    payment_required: paymentRequired,
    receipt,
    checklist: buildReceiptChecklist({
      requestDigest,
      firstResponse,
      retryResponse,
      paymentRequired,
      receipt,
    }),
    response: retryResponse.data,
  };
}

function startMockMcpServer() {
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== MCP_PATH) {
      writeJson(res, 404, { error: 'not_found' });
      return;
    }

    const rawBody = await readRequestBody(req);
    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      writeJson(res, 400, { error: 'invalid_json' });
      return;
    }

    if (payload.method !== 'tools/call' || payload.params?.name !== 'execute') {
      writeJson(res, 400, { error: 'unsupported_method' });
      return;
    }

    const requestDigest = sha256(rawBody);
    const declaredDigest = req.headers['x-request-digest'];
    if (declaredDigest && declaredDigest !== requestDigest) {
      writeJson(res, 400, {
        error: 'digest_mismatch',
        expected: requestDigest,
        received: declaredDigest,
      });
      return;
    }

    const paymentSignature = req.headers['payment-signature'] || req.headers['x-payment-signature'];
    if (!paymentSignature) {
      const challenge = buildChallenge(requestDigest);
      writeJson(
        res,
        402,
        {
          jsonrpc: '2.0',
          id: payload.id,
          error: {
            code: 402,
            message: 'payment required',
            data: {
              request_digest: requestDigest,
              quote_id: 'quote_mock_paid_call',
            },
          },
        },
        {
          'payment-required': toBase64Json(challenge),
          'x-request-digest': requestDigest,
        },
      );
      return;
    }

    const expectedSignature = `mock-signed:${requestDigest}`;
    if (paymentSignature !== expectedSignature) {
      writeJson(
        res,
        403,
        {
          jsonrpc: '2.0',
          id: payload.id,
          error: {
            code: 403,
            message: 'invalid payment signature',
          },
        },
        {
          'x-request-digest': requestDigest,
        },
      );
      return;
    }

    const invocationId = `inv_${requestDigest.slice(0, 16)}`;
    const receiptId = `rcpt_${requestDigest.slice(16, 32)}`;
    const responsePayload = {
      jsonrpc: '2.0',
      id: payload.id,
      result: {
        invocation_id: invocationId,
        status: 'completed',
        output: {
          accepted: true,
          task: payload.params.arguments.task || 'unknown',
          echo: payload.params.arguments.input || {},
        },
        cost: 0.25,
        payment_method: 'x402',
        receipt: {
          id: receiptId,
          cost: 0.25,
          payment_method: 'x402',
          settlement: {
            network: 'base',
            asset: 'USDC',
            amount: MOCK_PAYMENT_AMOUNT,
            pay_to: MOCK_PAY_TO,
          },
        },
      },
    };

    writeJson(res, 200, responsePayload, {
      'payment-receipt': receiptId,
      'x-request-digest': requestDigest,
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, () => resolve(server));
  });
}

async function mockBuyerPaymentHeaders({ request_digest, payment_required }) {
  const challenge = Array.isArray(payment_required) ? payment_required[0] : payment_required;
  if (!challenge || challenge.requestDigest !== request_digest) {
    throw new Error('decoded payment challenge does not match the frozen execute() request');
  }

  return {
    'payment-signature': `mock-signed:${request_digest}`,
    'payment-authorization': `mock-authorization:${challenge.maxAmountRequired}:${challenge.payTo}`,
  };
}

async function main() {
  const server = await startMockMcpServer();
  const endpointUrl = `http://${HOST}:${PORT}${MCP_PATH}`;

  try {
    const result = await executeWithBuyerRetry({
      endpointUrl,
      executeArgs: {
        task: 'summarize paid MCP response',
        input: {
          text: 'Paid calls should preserve the original execute() body and receipt evidence.',
        },
        max_cost: 0.25,
      },
      getPaymentHeaders: mockBuyerPaymentHeaders,
    });

    console.log(JSON.stringify(result, null, 2));
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  buildReceiptChecklist,
  executeWithBuyerRetry,
  mockBuyerPaymentHeaders,
  startMockMcpServer,
};