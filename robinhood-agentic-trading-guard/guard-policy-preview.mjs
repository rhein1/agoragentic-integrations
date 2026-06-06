import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_POLICY_PATH = path.join(__dirname, 'policy.example.json');

const SAMPLE_PROPOSALS = {
  'read-only': {
    intent_id: 'intent_sample_read_only_metadata',
    summary: 'Inspect configured Robinhood MCP metadata without account access or order intent.',
    requested_tool: 'inspect_mcp_config',
    action_class: 'metadata_read',
    metadata_only: true,
    account_scope: 'none'
  },
  'equity-order': {
    intent_id: 'intent_sample_equity_order_review',
    summary: 'Evaluate a proposed long equity order before any brokerage execution.',
    requested_tool: 'place_equity_order',
    action_class: 'proposed_order',
    asset_class: 'equity',
    side: 'buy',
    notional_usd: 25,
    live_mode_requested: false
  },
  'options-order': {
    intent_id: 'intent_sample_options_order_block',
    summary: 'Evaluate a proposed options order.',
    requested_tool: 'place_options_order',
    action_class: 'proposed_order',
    asset_class: 'options',
    side: 'buy_to_open',
    live_mode_requested: false
  }
};

const EXPECTED_DECISIONS = {
  'read-only': 'allow_read_only',
  'equity-order': 'require_owner_review',
  'options-order': 'blocked'
};

const FORBIDDEN_PROPOSAL_KEYS = [
  /credentials?/i,
  /access[_-]?token/i,
  /refresh[_-]?token/i,
  /private[_-]?key/i,
  /account[_-]?number/i,
  /^balance$/i,
  /raw[_-]?portfolio/i,
  /portfolio[_-]?raw/i
];

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  return JSON.parse(readFileSync(policyPath, 'utf8'));
}

function asSet(values) {
  return new Set((values || []).map((value) => String(value).toLowerCase()));
}

function findForbiddenKey(value, pathParts = []) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  for (const [key, child] of Object.entries(value)) {
    const keyPath = [...pathParts, key];
    if (FORBIDDEN_PROPOSAL_KEYS.some((pattern) => pattern.test(key))) {
      return keyPath.join('.');
    }
    const nested = findForbiddenKey(child, keyPath);
    if (nested) {
      return nested;
    }
  }

  return null;
}

function buildReceipt({ proposal, decision, reason, approvalRequirement, matchedRule, policy }) {
  return {
    schema_version: 'agoragentic.robinhood_agentic_trading_guard.receipt.v1',
    integration_id: policy.integration_id,
    receipt_id: `receipt_${proposal.intent_id || 'proposal'}`,
    intent: {
      intent_id: proposal.intent_id || null,
      summary: proposal.summary || null,
      requested_tool: proposal.requested_tool || null,
      action_class: proposal.action_class || null,
      asset_class: proposal.asset_class || null
    },
    policy_decision: {
      decision,
      blocked_reason: decision === 'blocked' ? reason : null,
      approval_requirement: decision === 'require_owner_review' ? approvalRequirement : null
    },
    evidence: {
      matched_rule: matchedRule,
      mcp_metadata_present: Boolean(policy.mcp_metadata?.trading_endpoint_url),
      owner_authenticated_schema_verified: Boolean(policy.mcp_metadata?.owner_authenticated_schema_verified),
      no_live_order_confirmation: true,
      robinhood_mcp_called: false,
      unofficial_api_used: false,
      credentials_stored: false,
      private_account_data_stored: false,
      raw_portfolio_data_stored: false
    },
    governance_boundary: {
      agoragentic_role: 'policy_receipt_approval_layer',
      brokerage_execution_role: 'outside_this_integration',
      live_mode_enabled: Boolean(policy.rules?.live_mode_enabled)
    }
  };
}

function decideProposal(proposal, policy = loadPolicy()) {
  const requestedTool = String(proposal.requested_tool || '').toLowerCase();
  const actionClass = String(proposal.action_class || '').toLowerCase();
  const assetClass = String(proposal.asset_class || '').toLowerCase();
  const blockedTools = asSet(policy.blocked_tools);
  const blockedAssetClasses = asSet(policy.blocked_asset_classes);
  const allowedMetadataTools = asSet(policy.allowed_metadata_tools);
  const allowedReadOnlyTools = asSet(policy.allowed_read_only_tools);
  const reviewRequiredTools = asSet(policy.review_required_tools);

  const forbiddenKey = findForbiddenKey(proposal);
  if (forbiddenKey) {
    return buildReceipt({
      proposal,
      policy,
      decision: 'blocked',
      reason: `Proposal includes forbidden private field: ${forbiddenKey}.`,
      approvalRequirement: null,
      matchedRule: 'forbidden_private_fields'
    });
  }

  if (blockedTools.has(requestedTool)) {
    return buildReceipt({
      proposal,
      policy,
      decision: 'blocked',
      reason: `${requestedTool} is blocked by default policy.`,
      approvalRequirement: null,
      matchedRule: `blocked_tools.${requestedTool}`
    });
  }

  if (assetClass && blockedAssetClasses.has(assetClass)) {
    return buildReceipt({
      proposal,
      policy,
      decision: 'blocked',
      reason: `${assetClass} actions are blocked by default policy.`,
      approvalRequirement: null,
      matchedRule: `blocked_asset_classes.${assetClass}`
    });
  }

  if (proposal.live_mode_requested === true && policy.rules?.live_mode_enabled !== true) {
    return buildReceipt({
      proposal,
      policy,
      decision: 'require_owner_review',
      reason: null,
      approvalRequirement: 'Live mode is disabled by default and requires explicit owner approval before any separate executor can be considered.',
      matchedRule: 'rules.owner_approval_required_for_live_mode'
    });
  }

  if (actionClass === 'metadata_read' && proposal.metadata_only === true && allowedMetadataTools.has(requestedTool)) {
    return buildReceipt({
      proposal,
      policy,
      decision: 'allow_read_only',
      reason: null,
      approvalRequirement: null,
      matchedRule: `allowed_metadata_tools.${requestedTool}`
    });
  }

  if (allowedReadOnlyTools.has(requestedTool)) {
    return buildReceipt({
      proposal,
      policy,
      decision: 'allow_read_only',
      reason: null,
      approvalRequirement: null,
      matchedRule: `allowed_read_only_tools.${requestedTool}`
    });
  }

  if (reviewRequiredTools.has(requestedTool) || actionClass.includes('order')) {
    return buildReceipt({
      proposal,
      policy,
      decision: 'require_owner_review',
      reason: null,
      approvalRequirement: 'Owner review is required. This guard does not dispatch live orders.',
      matchedRule: reviewRequiredTools.has(requestedTool) ? `review_required_tools.${requestedTool}` : 'rules.owner_approval_required_for_order_like_actions'
    });
  }

  return buildReceipt({
    proposal,
    policy,
    decision: 'blocked',
    reason: 'Proposal does not match an allowed read-only or owner-reviewed action.',
    approvalRequirement: null,
    matchedRule: 'default_block'
  });
}

function parseArgs(argv) {
  const args = {
    sample: 'read-only',
    assert: false,
    proposalPath: null,
    policyPath: DEFAULT_POLICY_PATH
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--assert') {
      args.assert = true;
    } else if (arg === '--sample') {
      args.sample = argv[index + 1];
      index += 1;
    } else if (arg === '--proposal') {
      args.proposalPath = argv[index + 1];
      index += 1;
    } else if (arg === '--policy') {
      args.policyPath = argv[index + 1];
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage:
  node robinhood-agentic-trading-guard/guard-policy-preview.mjs --sample read-only
  node robinhood-agentic-trading-guard/guard-policy-preview.mjs --sample equity-order
  node robinhood-agentic-trading-guard/guard-policy-preview.mjs --sample options-order
  node robinhood-agentic-trading-guard/guard-policy-preview.mjs --proposal path/to/proposal.json
  node robinhood-agentic-trading-guard/guard-policy-preview.mjs --assert
`);
}

function runAssertions(policy) {
  for (const [sampleName, expectedDecision] of Object.entries(EXPECTED_DECISIONS)) {
    const receipt = decideProposal(SAMPLE_PROPOSALS[sampleName], policy);
    if (receipt.policy_decision.decision !== expectedDecision) {
      throw new Error(`${sampleName} expected ${expectedDecision}, got ${receipt.policy_decision.decision}`);
    }
    if (receipt.evidence.no_live_order_confirmation !== true || receipt.evidence.robinhood_mcp_called !== false) {
      throw new Error(`${sampleName} receipt does not confirm no live order and no MCP call`);
    }
  }

  const authority = policy.authority_boundary || {};
  const disabledAuthorityFlags = [
    'brokerage_execution_enabled',
    'live_order_dispatch_enabled',
    'credential_storage_enabled',
    'private_account_data_storage_enabled',
    'unofficial_api_usage_allowed',
    'trading_bot_behavior_allowed'
  ];
  for (const flag of disabledAuthorityFlags) {
    if (authority[flag] !== false) {
      throw new Error(`Policy authority flag must remain false: ${flag}`);
    }
  }

  if (policy.rules?.live_mode_enabled !== false) {
    throw new Error('Policy live_mode_enabled must remain false by default');
  }

  if (!asSet(policy.blocked_asset_classes).has('options')) {
    throw new Error('Options must remain blocked by default');
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const policy = loadPolicy(args.policyPath);
  if (args.assert) {
    runAssertions(policy);
    console.log('Robinhood Agentic Trading Guard assertions passed.');
    return;
  }

  const proposal = args.proposalPath
    ? JSON.parse(readFileSync(args.proposalPath, 'utf8'))
    : SAMPLE_PROPOSALS[args.sample];

  if (!proposal) {
    throw new Error(`Unknown sample: ${args.sample}`);
  }

  console.log(JSON.stringify(decideProposal(proposal, policy), null, 2));
}

main();
