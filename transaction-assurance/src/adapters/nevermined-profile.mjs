import { digestJson, freezeDeep, LIMITS } from './nevermined-json.mjs';

export const NEVERMINED_REVISION = '7c3e0c1dd00119f8e72983572c1807e78a9c1ee2';
export const NEVERMINED_PROFILE_ID = `nevermined.merchant-payment.${NEVERMINED_REVISION}`;
export const NEVERMINED_PROFILE = freezeDeep({
  id: NEVERMINED_PROFILE_ID,
  version: '1.0.0',
  revision: NEVERMINED_REVISION,
  basis: 'vendor_documentation_example',
  source: `https://github.com/nevermined-io/docs/blob/${NEVERMINED_REVISION}/products/catalog/router/ledger.mdx`,
  source_git_blob: '40c5314dba599315497bf6a3d240f5ea8598b433',
  section: 'List payments',
  endpoint: 'GET /api/v1/router/payments',
  limits: LIMITS,
  fields: [
    'id', 'createdAt', 'status', 'protocol', 'network', 'asset', 'amount',
    'merchantAddress', 'txHash', 'delegationId', 'requestId', 'resourceUrl', 'buyer',
    'feeAtomic', 'feeBps', 'feeCents', 'feeStatus', 'feeTxHash', 'feeNonce',
    'feeFailureReason', 'assetSymbol', 'assetDecimals',
  ],
  network_aliases: { base: 'eip155:8453', 'eip155:8453': 'eip155:8453' },
  merchant_statuses: { Issued: 'issued', Settled: 'settled', Failed: 'failed' },
  fee_statuses: ['None', 'Accrued', 'Submitted', 'Settled', 'Failed', 'Released'],
  immutable_fields: ['request_id', 'delegation_ref', 'protocol', 'network', 'asset', 'amount_atomic', 'decimals', 'buyer_wallet', 'merchant_wallet', 'settlement_ref', 'created_at'],
  merchant_incompatible_pairs: [['settled', 'failed']],
  fee_incompatible_pairs: [['Settled', 'Released']],
  redaction: {
    id: 'agoragentic.nevermined-allowlist-redaction.v1',
    dropped_fields: ['feeFailureReason'],
    resource_url: 'drop_userinfo_query_fragment_or_entire_non_http_url',
    unknown_fields: 'drop_before_hash_and_output',
    secret_like_allowed_values: 'reject_without_echo',
  },
});
export const NEVERMINED_PROFILE_DIGEST = digestJson(NEVERMINED_PROFILE);
