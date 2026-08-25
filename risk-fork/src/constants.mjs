export const RISK_LEVELS = Object.freeze(['LOW', 'ELEVATED', 'HIGH', 'IRREVERSIBLE']);

export const RISK_ACTIONS = Object.freeze({
  LOW: 'NORMAL_EXECUTION',
  ELEVATED: 'RISK_FORK_OPTIONAL',
  HIGH: 'RISK_FORK_REQUIRED',
  IRREVERSIBLE: 'RISK_FORK_PREPARE_CLEAN_COMMIT_REQUIRED',
});

export const MCP_PHASES = Object.freeze([
  'server/discover',
  'initialize',
  'tools/list',
  'resources/list',
  'resources/read',
  'prompts/list',
  'prompts/get',
  'tools/call',
  'UNKNOWN',
]);

export const RUN_STATES = Object.freeze([
  'REQUESTED',
  'SAVEPOINTING',
  'SAVEPOINT_READY',
  'SAVEPOINT_FAILED',
  'FORK_STARTING',
  'FORK_READY',
  'FORK_FAILED',
  'EXECUTING',
  'TAINTED',
  'EXECUTION_FAILED',
  'VALIDATING',
  'COMMIT_READY',
  'VALIDATION_FAILED',
  'PRECOMMIT_DESTROYING',
  'CLEAN_COMMIT_READY',
  'COMMITTING',
  'COMMITTED',
  'COMMIT_FAILED',
  'COMMIT_AMBIGUOUS',
  'ABORTING',
  'ABORTED',
  'DESTROYING',
  'DESTROYED',
  'DESTRUCTION_UNKNOWN',
  'DESTRUCTION_FAILED',
]);

export const FORK_RESOURCE_STATES = Object.freeze([
  'NOT_CREATED',
  'ACTIVE',
  'SUSPENDED',
  'DESTROY_REQUESTED',
  'DESTROYED',
  'DESTROY_UNKNOWN',
]);

export const COMMIT_TYPES = Object.freeze([
  'TYPED_RESULT',
  'WORKSPACE_DIFF',
  'CONSEQUENTIAL_ACTION_PROPOSAL',
]);

export const ACTION_OPERATIONS = Object.freeze([
  'mcp_tool_call',
  'payment',
  'send',
  'publish',
  'deploy',
  'database_mutation',
  'trust_mutation',
  'git_push',
]);

export const EVIDENCE_STATUSES = Object.freeze([
  'requested',
  'observed',
  'verified',
  'failed',
  'unknown',
  'not_applicable',
]);

export const NO_AUTHORITY_FLAGS = Object.freeze({
  grants_authority: false,
  can_spend: false,
  can_sign: false,
  can_deploy: false,
  can_publish: false,
  can_send: false,
  can_mutate_parent: false,
  can_change_trust: false,
  can_expand_scope: false,
});
