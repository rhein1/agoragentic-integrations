import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SolanaX402DemoClient,
  createMockSolanaX402Fetch,
} from '../examples/agoragentic-growth/2026-06-21-solana-x402-paid-call-adapter-demo-mjs-c10944a6cc/solana_x402_paid_call_adapter_demo.mjs';
import * as payouts from '../zoneless/agoragentic_zoneless_payouts.ts';

const {
  assertSolanaAddress,
  assertZonelessPayoutBoundary,
  buildPayoutReceiptDraft,
  buildSellerPayoutDraft,
  buildZonelessPayoutRequestDraft,
  parseUsdcMinorUnits,
  toZonelessCents,
} = payouts;

// Syntax fixtures only: neither value is evidence of a funded wallet or a transaction.
const VALID_SOLANA_ADDRESS = '11111111111111111111111111111111';
const SYNTACTIC_SIGNATURE = '1'.repeat(64);
const ACCOUNT_ID = 'acct_z_1Nv0FGQ9RKHgCVdK';
const WALLET_ID = 'wa_z_1Nv0FGQ9RKHgCVdK';

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

function payoutInput(overrides = {}) {
  return {
    sellerId: 'seller-1',
    amountUsdc: '12.34',
    solanaWallet: VALID_SOLANA_ADDRESS,
    sourceReceipts: ['receipt-1'],
    ...overrides,
  };
}

function requestInput(overrides = {}) {
  return {
    ...payoutInput(),
    connectedAccountId: ACCOUNT_ID,
    walletReference: {
      seller_id: 'seller-1',
      id: WALLET_ID,
      account: ACCOUNT_ID,
      wallet_address: VALID_SOLANA_ADDRESS,
      object: 'wallet',
      network: 'solana',
      currency: 'usdc',
      status: 'new',
    },
    ...overrides,
  };
}

test('internal draft uses explicit atomic units and cannot be mistaken for the API body', () => {
  const input = payoutInput();
  const draft = buildSellerPayoutDraft(input);
  assert.equal(draft.schema, 'agoragentic.seller-payout-draft.v1');
  assert.equal(draft.amount_atomic_units, '12340000');
  assert.equal(draft.destination_wallet_address, VALID_SOLANA_ADDRESS);
  assert.equal(draft.canonical_balance_network, 'base');
  assert.equal(draft.canonical_balance_asset, 'USDC');
  assert.equal(draft.execution_authority, 'none');
  assert.equal('amount' in draft, false);
  assert.equal('destination' in draft, false);
  input.sourceReceipts.push('later-receipt');
  assert.deepEqual(draft.source_receipts, ['receipt-1']);
  assert.equal('toZonelessPayoutRequest' in payouts, false, 'remove the misleading legacy API, not an alias');
});

test('one atomic unit is valid internally but is rejected by the cent-based request builder', () => {
  assert.equal(buildSellerPayoutDraft(payoutInput({ amountUsdc: '0.000001' })).amount_atomic_units, '1');
  assert.throws(() => buildZonelessPayoutRequestDraft(requestInput({ amountUsdc: '0.000001' })), /whole cents/);
});

for (const [amount, expected] of [['10', 1000], ['12.34', 1234], ['0.01', 1], ['1.230000', 123], [' 2.00 ', 200]]) {
  test(`exact upstream cents for ${JSON.stringify(amount)}`, () => {
    const request = buildZonelessPayoutRequestDraft(requestInput({ amountUsdc: amount }));
    assert.equal(request.body.amount, expected);
    assert.equal(typeof request.body.amount, 'number');
    assert.equal(Number.isSafeInteger(request.body.amount), true);
    assert.equal(BigInt(request.body.amount) * 10_000n, parseUsdcMinorUnits(amount));
  });
}

for (const amount of ['0.000001', '0.009999', '1.000001', '1.234567']) {
  test(`sub-cent conversion rejects ${amount} without rounding`, () => {
    assert.throws(() => toZonelessCents(amount), /whole cents/);
  });
}

for (const amount of ['0', '-1', '1e2', 'NaN', 'Infinity', '1.0000001', '', '01', '1.', 10, null]) {
  test(`cent conversion rejects invalid input ${JSON.stringify(amount)}`, () => {
    assert.throws(() => toZonelessCents(amount));
  });
}

test('safe integer limit is checked before BigInt becomes a JSON number', () => {
  assert.equal(toZonelessCents('90071992547409.91'), Number.MAX_SAFE_INTEGER);
  assert.throws(() => toZonelessCents('90071992547409.92'), /safe integer/);
  assert.throws(() => toZonelessCents('999999999999999999999999999999.99'), /safe integer/);
});

test('cent conversion preserves 1001 deterministic round trips', () => {
  for (let cents = 1n; cents <= 1001n; cents += 1n) {
    const amount = `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
    assert.equal(BigInt(toZonelessCents(amount)) * 10_000n, parseUsdcMinorUnits(amount));
  }
});

test('offline API draft matches the pinned upstream amount, destination, and account contract', () => {
  // Zoneless 314414420494f63863015a060d231a7329b620e1: PayoutSchema.ts,
  // payouts.routes.ts, ExternalWallet.ts. This is not an upstream runtime test.
  const result = buildZonelessPayoutRequestDraft(requestInput());
  assert.equal(result.execution_authority, 'none');
  assert.deepEqual(result.request_options, { zonelessAccount: ACCOUNT_ID });
  assert.deepEqual(result.body, {
    amount: 1234,
    currency: 'usdc',
    destination: WALLET_ID,
    metadata: {
      agoragentic_seller_id: 'seller-1',
      canonical_network: 'base',
      source_receipts: '["receipt-1"]',
      source_receipts_encoding: 'json',
    },
  });
  assert.doesNotThrow(() => JSON.stringify(result));
});

for (const [field, value, expected] of [
  ['seller_id', 'seller-2', /seller and connected account/],
  ['account', 'acct_z_Other', /seller and connected account/],
  ['wallet_address', 'other-wallet', /does not match/],
  ['id', VALID_SOLANA_ADDRESS, /registered wa_z_/],
  ['id', '', /External wallet id/],
  ['status', 'archived', /unsupported status/],
  ['status', 'verification_failed', /unsupported status/],
  ['status', 'errored', /unsupported status/],
  ['status', 'active', /unsupported status/],
  ['status', undefined, /unsupported status/],
  ['network', 'base', /Solana USDC/],
  ['currency', 'sol', /Solana USDC/],
  ['object', 'account', /Solana USDC/],
]) {
  test(`rejects mismatched wallet reference ${field}=${value}`, () => {
    const input = requestInput();
    input.walletReference[field] = value;
    assert.throws(() => buildZonelessPayoutRequestDraft(input), expected);
  });
}

for (const status of ['new', 'validated', 'verified']) {
  test(`recognizes upstream wallet status ${status} without granting authority`, () => {
    const input = requestInput();
    input.walletReference.status = status;
    assert.equal(buildZonelessPayoutRequestDraft(input).execution_authority, 'none');
  });
}

test('requires explicit registered account and wallet, never a default-wallet fallback', () => {
  for (const connectedAccountId of [undefined, '', 'acct_z_', 'seller-1', ` ${ACCOUNT_ID}`]) {
    assert.throws(() => buildZonelessPayoutRequestDraft(requestInput({ connectedAccountId })), /Connected account id/);
  }
  for (const walletReference of [undefined, null]) {
    assert.throws(() => buildZonelessPayoutRequestDraft(requestInput({ walletReference })), /External wallet reference/);
  }
});

test('source receipt IDs remain lossless in metadata, including commas and quotes', () => {
  const sourceReceipts = ['receipt,1', 'receipt"2'];
  const result = buildZonelessPayoutRequestDraft(requestInput({ sourceReceipts }));
  assert.deepEqual(JSON.parse(result.body.metadata.source_receipts), sourceReceipts);
});

test('draft builders reject empty and malformed seller/source receipt identifiers', () => {
  for (const sellerId of ['', ' ', null, 3, ' seller-1']) {
    assert.throws(() => buildSellerPayoutDraft(payoutInput({ sellerId })), /Seller id/);
  }
  for (const sourceReceipts of [[], null, 'receipt', [''], [' '], [2], [' padded']]) {
    assert.throws(() => buildSellerPayoutDraft(payoutInput({ sourceReceipts })));
    assert.throws(() => buildPayoutReceiptDraft(payoutInput({ sourceReceipts })));
  }
});

test('existing Base-canonical and manual-approval policy boundaries remain required', () => {
  const preference = {
    seller_id: 'seller-1', canonical_balance_network: 'base', canonical_balance_asset: 'USDC',
    preferred_payout_network: 'solana', preferred_payout_asset: 'USDC',
    solana_wallet: VALID_SOLANA_ADDRESS, payout_mode: 'manual_batch', requires_owner_approval: true,
  };
  assert.doesNotThrow(() => assertZonelessPayoutBoundary(preference));
  for (const change of [
    { canonical_balance_network: 'solana' }, { canonical_balance_asset: 'SOL' },
    { preferred_payout_asset: 'SOL' }, { preferred_payout_network: 'unknown' },
    { solana_wallet: '' }, { payout_mode: 'automatic' }, { requires_owner_approval: false },
  ]) assert.throws(() => assertZonelessPayoutBoundary({ ...preference, ...change }));
});

test('receipt drafts default to simulated, unverified, and no settlement authority', () => {
  const result = buildPayoutReceiptDraft(payoutInput());
  assert.equal(result.schema, 'agoragentic.seller-payout-receipt-draft.v2');
  assert.equal(result.receipt_type, 'seller_payout_draft');
  assert.equal(result.evidence_mode, 'simulated');
  assert.equal(result.status, 'draft');
  assert.equal(result.execution_authority, 'none');
  assert.equal(result.evidence_source, 'caller_supplied_unverified');
  assert.equal(result.chain_verification, 'not_performed');
  assert.equal(result.settlement_confirmed, false);
  assert.equal(result.amount_atomic_units, '12340000');
});

test('simulated success has its own status and cannot become a submitted payment', () => {
  const result = buildPayoutReceiptDraft({ ...payoutInput(), status: 'simulated' });
  assert.equal(result.status, 'simulated');
  assert.equal(result.settlement_confirmed, false);
  for (const change of [{ status: 'submitted' }, { payoutTx: 'sim_sig_payout' }, { payoutTx: SYNTACTIC_SIGNATURE }]) {
    assert.throws(() => buildPayoutReceiptDraft({ ...payoutInput(), ...change }), /Simulated evidence/);
  }
  assert.throws(() => buildPayoutReceiptDraft({ ...payoutInput(), status: 'simulated', evidenceMode: 'onchain' }), /simulated evidence mode/);
});

test('submitted is a caller-reported onchain state, never independent confirmation', () => {
  const result = buildPayoutReceiptDraft({ ...payoutInput(), payoutTx: SYNTACTIC_SIGNATURE, evidenceMode: 'onchain' });
  assert.equal(result.status, 'submitted');
  assert.equal(result.payout_tx, SYNTACTIC_SIGNATURE);
  assert.equal(result.evidence_mode, 'onchain');
  assert.equal(result.settlement_confirmed, false);
  assert.equal(result.chain_verification, 'not_performed');
  assert.equal(result.evidence_source, 'caller_supplied_unverified');
});

for (const change of [
  { status: 'confirmed' }, { status: 'confirmed', settlementConfirmed: true },
  { settlementConfirmed: true }, { settlementConfirmed: 'true' }, { settlementConfirmed: 1 },
]) {
  test(`caller cannot manufacture settlement confirmation with ${JSON.stringify(change)}`, () => {
    assert.throws(() => buildPayoutReceiptDraft({
      ...payoutInput(), evidenceMode: 'onchain', payoutTx: SYNTACTIC_SIGNATURE, ...change,
    }), /cannot confirm payouts/);
  });
}

test('receipt draft rejects impossible and unknown states', () => {
  for (const change of [
    { evidenceMode: 'unknown' }, { status: 'paid' }, { status: 'unrecognized' },
    { status: 'submitted', evidenceMode: 'onchain' },
    { status: 'draft', evidenceMode: 'onchain', payoutTx: SYNTACTIC_SIGNATURE },
    { status: 'pending_signature', evidenceMode: 'onchain', payoutTx: SYNTACTIC_SIGNATURE },
  ]) assert.throws(() => buildPayoutReceiptDraft({ ...payoutInput(), ...change }));
});

test('onchain claims reject synthetic, empty, and malformed signature strings', () => {
  for (const payoutTx of ['sim_sig_payout', 'demo-signature', '', ' ', '1111', '2'.repeat(89)]) {
    assert.throws(() => buildPayoutReceiptDraft({ ...payoutInput(), evidenceMode: 'onchain', payoutTx }));
  }
});

test('all accepted evidence modes and statuses remain non-authoritative', () => {
  for (const evidenceMode of ['simulated', 'onchain']) {
    for (const status of ['draft', 'pending_signature', 'failed']) {
      const result = buildPayoutReceiptDraft({ ...payoutInput(), evidenceMode, status });
      assert.equal(result.settlement_confirmed, false);
      assert.equal(result.execution_authority, 'none');
    }
  }
});
