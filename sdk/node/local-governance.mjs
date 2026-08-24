import governance from './local-governance.js';

export const {
  POLICY_SCHEMA,
  RECEIPT_SCHEMA,
  DEFAULT_POLICY_FILE,
  createDefaultPolicy,
  detectAdapters,
  initializeProject,
  loadPolicy,
  evaluatePolicy,
  govern,
  runGovernedCommand,
} = governance;

export default governance;
