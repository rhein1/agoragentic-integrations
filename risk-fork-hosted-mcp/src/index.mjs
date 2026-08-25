import mcpRuntime from '../../mcp/mcp-server.js';

export {
  RiskForkCommitError,
  RiskForkController,
  RiskForkPreparationError,
  assertPreparedForCleanCommit,
} from '../../risk-fork/src/controller.mjs';
export {
  RiskForkMcpBoundary,
  assertHostCanEnforce,
  createMcpInterceptionPlan,
} from '../../risk-fork/src/interception.mjs';
export {
  REQUIRED_PROVIDER_METHODS,
  RiskForkProvider,
  assertRiskForkProvider,
  requireProviderCapability,
} from '../../risk-fork/src/provider.mjs';
export {
  classifyRisk,
  createTrustedMcpServerVerifier,
  riskDecisionCanonicalBytes,
  verifyRiskDecision,
} from '../../risk-fork/src/risk-classifier.mjs';
export {
  buildExecutionBinding,
  createForkIdentity,
  createSavepointCapsule,
  networkPolicy,
  verifyExecutionBinding,
  verifySavepointCapsule,
} from '../../risk-fork/src/contracts.mjs';
export {
  scanTaintedValue,
  validateCommitCandidate,
  verifyCommitArtifact,
} from '../../risk-fork/src/taint-gate.mjs';
export {
  FileExecutionAuthorizationTransaction,
  FileParentHeadTransaction,
  commitPreparedArtifact,
  deriveParentAuthorityRef,
} from '../../risk-fork/src/clean-commit.mjs';
export {
  E2B_EXTERNAL_BIRTH_CONTROLS,
  E2B_EXTERNAL_QUALIFICATION_EVIDENCE_REFS,
  E2B_EXTERNAL_QUALIFICATION_OBSERVATION_SCHEMA,
  E2B_EXTERNAL_PROVIDER_CONTROLS,
  E2B_QUALIFICATION_CONTROLS,
  E2B_QUALIFICATION_SCHEMA,
  E2B_QUALIFICATION_TRUST_SCHEMA,
  E2B_RUNTIME_SDK_INTEGRITY_SCHEMA,
  applyE2BExternalQualificationObservation,
  createE2BExternalQualificationObservationVerifier,
  createE2BQualificationEvidence,
  createE2BQualificationTrustVerifier,
  createE2BRuntimeSdkIntegrityVerifier,
  isE2BQualificationEvidenceCanonical,
  isE2BRuntimeSdkIntegrityVerifier,
  loadVerifiedE2BRuntimeSdk,
  sha256BytesRef,
  sha256FileRef,
  validateE2BQualificationEvidence,
  verifyE2BExternalQualificationObservation,
  verifyE2BQualificationTrust,
} from '../../risk-fork/src/e2b-qualification.mjs';
export {
  E2BRiskForkAdapter,
  E2B_RISK_FORK_PATHS,
  E2B_SECURE_SNAPSHOT_PROFILE_UNAVAILABLE,
} from '../../risk-fork/src/adapters/e2b.mjs';
export {
  E2B_INDEPENDENT_SOURCE_ATTESTATION_SCHEMA,
  createE2BAuthorityFreeSourceVerifier,
  scanE2BStagedBytesAuthorityFree,
} from '../../risk-fork/src/adapters/e2b-source-verifier.mjs';
export {
  PostgresDistributedCommitAuthority,
  isPostgresDistributedCommitAuthority,
  isProductionPostgresDistributedCommitAuthority,
} from '../../risk-fork/src/adapters/postgres-authority.mjs';
export {
  acquirePostgresAuthorityClient,
  buildPostgresAuthorityPoolConfig,
  createPostgresAuthorityPool,
  migratePostgresDistributedAuthority,
  quotePostgresAuthorityIdentifier,
  verifyPostgresAuthorityClientTransport,
  verifyPostgresDistributedAuthoritySchema,
} from '../../risk-fork/src/adapters/postgres-authority-migrator.mjs';

const REVIEWED_SOURCE_INTEGRITY = typeof __AGORAGENTIC_REVIEWED_SOURCE_INTEGRITY__ === 'string'
  ? __AGORAGENTIC_REVIEWED_SOURCE_INTEGRITY__
  : null;

export const HOSTED_MCP_BUNDLE_METADATA = Object.freeze({
  package_name: '@agoragentic/risk-fork-hosted-mcp',
  package_version: '0.1.0-alpha.0',
  mcp_source_version: '2.0.0',
  risk_fork_source_version: '0.1.0-alpha.0',
  reviewed_source_integrity: REVIEWED_SOURCE_INTEGRITY,
  optional_e2b_peer_version: '2.39.0',
  publication_status: 'private_unpublished',
  outbound_mcp_transport_qualified: false,
  managed_postgres_qualified: false,
  e2b_live_qualified: false,
  authority_granted: false,
});

export const {
  MCP_ENFORCEMENT_SCHEMAS,
  MCP_V2_PROTOCOL_VERSION,
  buildFallbackToolList,
  closeRemoteSession,
  computeMcpCleanImportEvidenceHash,
  connectRemoteClient,
  createMcpEnforcementBoundary,
  createRemoteToolDirectory,
  executeFallbackTool,
  runAcpAdapter,
  runMcpRelay,
} = mcpRuntime;
