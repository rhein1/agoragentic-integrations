import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SolanaX402DemoClient,
  createMockSolanaX402Fetch,
} from '../examples/agoragentic-growth/2026-06-21-solana-x402-paid-call-adapter-demo-mjs-c10944a6cc/solana_x402_paid_call_adapter_demo.mjs';
import {
  assertSolanaAddress,
  buildPayoutReceiptDraft,
  parseUsdcMinorUnits,
  toZonelessPayoutRequest,
} from '../zoneless/agoragentic_zoneless_payouts.ts';

const VALID_SOLANA_ADDRESS = '11111111111111111111111111111111';

async function runMode(mode) {
  const mock = createMockSolanaX402Fetch({ mode });
  const client = new SolanaX402DemoClient({ fetchImpl: mock.fetchImpl });
  const execute = () => client.execute({
    url: 'https://example.invalid/paid-call',
    idempotencyKey: `idem-${mode}`,
    body: { task: mode },
    pay: mock.pay,
  });
  return { mock, client, execute };
}

test('Solana demo performs one challenge and one signed success', async () => {
  const { mock, execute } = await runMode('success');
  const result = await execute();
  assert.equal(result.ok, true);
  assert.equal(result.paymentAuthorizationsCreated, 1);
  assert.equal(result.signedRequestAttempts, 1);
  assert.equal(result.receipt.verifiedAgainstChallenge, true);
  assert.equal(result.receipt.settlementVerified, false);
  assert.equal(mock.state.calls, 2);
  assert.equal(mock.state.signedCalls, 1);
  assert.equal(mock.state.payCalls, 1);
  assert.equal(new Set(mock.state.idempotencyKeys).size, 1);
});

for (const mode of ['repeat-402', 'http-500', 'network-loss', 'unreadable', 'redirect']) {
  test(`Solana demo fails closed and locks after ${mode}`, async () => {
    const { mock, client, execute } = await runMode(mode);
    await assert.rejects(execute, (error) => {
      assert.equal(error.ambiguousOutcome, true);
      assert.equal(error.retryable, false);
      assert.equal(error.signedRequestAttempts, 1);
      return true;
    });
    assert.equal(mock.state.payCalls, 1);
    assert.equal(mock.state.signedCalls, 1);
    await assert.rejects(execute, (error) => {
      assert.equal(error.blockedByPriorAmbiguousOutcome, true);
      return true;
    });
    assert.equal(mock.state.payCalls, 1, 'locked client must not create another payment authorization');
    assert.equal(mock.state.signedCalls, 1, 'locked client must not replay a signed request');
    assert.equal(client.reconcile({ settlementStatus: 'not_found' }), true);
  });
}

test('Solana demo requires a caller-supplied pay callback', async () => {
  const mock = createMockSolanaX402Fetch();
  const client = new SolanaX402DemoClient({ fetchImpl: mock.fetchImpl });
  await assert.rejects(
    client.execute({ url: 'https://example.invalid/paid-call' }),
    /caller-supplied pay callback/,
  );
  assert.equal(mock.state.calls, 0);
});

test('USDC string parsing uses exact six-decimal minor units', () => {
  assert.equal(parseUsdcMinorUnits('12.34'), 12_340_000n);
  assert.equal(parseUsdcMinorUnits('0.000001'), 1n);
  assert.throws(() => parseUsdcMinorUnits('0'), /greater than zero/);
  assert.throws(() => parseUsdcMinorUnits('-1'), /positive decimal string/);
  assert.throws(() => parseUsdcMinorUnits('1.0000001'), /at most 6/);
  assert.throws(() => parseUsdcMinorUnits('NaN'), /positive decimal string/);
  assert.throws(() => parseUsdcMinorUnits('Infinity'), /positive decimal string/);
});

test('Solana address validation is local and requires a 32-byte base58 address', () => {
  assert.doesNotThrow(() => assertSolanaAddress(VALID_SOLANA_ADDRESS));
  assert.throws(() => assertSolanaAddress('0OIl'), /non-base58/);
  assert.throws(() => assertSolanaAddress('1111'), /32 bytes/);
});

test('Solana USDC payout request uses exact minor-unit string and source receipts', () => {
  const request = toZonelessPayoutRequest({
    sellerId: 'seller-1',
    amountUsdc: '12.34',
    solanaWallet: VALID_SOLANA_ADDRESS,
    sourceReceipts: ['receipt-1'],
  });
  assert.equal(request.amount, '12340000');
  assert.equal(request.currency, 'usdc');
  assert.equal(request.destination, VALID_SOLANA_ADDRESS);
  assert.throws(() => toZonelessPayoutRequest({
    sellerId: 'seller-1',
    amountUsdc: '1',
    solanaWallet: VALID_SOLANA_ADDRESS,
    sourceReceipts: [],
  }), /source Agoragentic receipts/);
});

test('submitted is not confirmed and confirmation requires explicit settlement evidence', () => {
  const submitted = buildPayoutReceiptDraft({
    sellerId: 'seller-1',
    amountUsdc: '5.00',
    sourceReceipts: ['receipt-1'],
    payoutTx: 'demo-signature',
  });
  assert.equal(submitted.status, 'submitted');
  assert.equal(submitted.settlement_confirmed, false);

  assert.throws(() => buildPayoutReceiptDraft({
    sellerId: 'seller-1',
    amountUsdc: '5.00',
    sourceReceipts: ['receipt-1'],
    payoutTx: 'demo-signature',
    status: 'confirmed',
  }), /explicit settlement confirmation/);

  const confirmed = buildPayoutReceiptDraft({
    sellerId: 'seller-1',
    amountUsdc: '5.00',
    sourceReceipts: ['receipt-1'],
    payoutTx: 'demo-signature',
    status: 'confirmed',
    settlementConfirmed: true,
  });
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.settlement_confirmed, true);
});
