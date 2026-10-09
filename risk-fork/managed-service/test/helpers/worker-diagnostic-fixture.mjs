import { createFixture, invocationRequest, TestProvider } from '../helpers.mjs';
import { sha256Ref } from '../../../src/canonical.mjs';
import { createManagedRiskForkWorker } from '../../src/worker.mjs';
import { createCleanupVerificationEvidence } from '../../../src/provider.mjs';
import { makeCapsule, closedResultSchema } from '../../../test/helpers.mjs';

export const NOW = '2026-09-05T12:00:00.000Z';
export const workerDiagnosticSettings = { bucket_ms: 1000,max_age_ms: 60000,max_future_ms: 1000,
  rules: [{ rule_id: 'worker_provider_call_unconfirmed',threshold: 1,window_ms: 60000 }] };
class Provider extends TestProvider {
  created = []; destroyed = new Set();
  async createSavepoint() { this.created.push('savepoint'); return { savepoint_ref: 'savepoint:test',savepoint_hash: sha256Ref('savepoint') }; }
  async createFork() { this.created.push('fork'); return { fork_ref: 'fork:test',fork_hash: sha256Ref('fork') }; }
  async getForkStatus() { return { status: 'ready' }; }
  async executeInFork() { return { status: 'completed',taint_status: 'TAINTED',authority_granted: false,result_hash: sha256Ref('result'),
    commit_candidate: { type: 'TYPED_RESULT',payload: { answer: 'bounded' },payload_schema: closedResultSchema() } }; }
  async destroyFork(input) { this.destroyed.add(input.fork_ref); }
  async destroySavepoint(input) { this.destroyed.add(input.savepoint_ref); }
  async verifyDestroyed(input) { return this.verify(input); }
  async verifySavepointDestroyed(input) { return this.verify(input); }
  verify(input) { return createCleanupVerificationEvidence(input.cleanup_request,{ status: this.destroyed.has(input.fork_ref ?? input.savepoint_ref) ? 'verified' : 'failed',
    outcome: this.destroyed.has(input.fork_ref ?? input.savepoint_ref) ? 'success' : 'failure',observed_at: NOW,evidence_ref: 'fixture:absence',observation_hash: sha256Ref(input) }); }
}
export async function workerDiagnosticFixture({ setupProvider, ...overrides } = {}) {
  const provider = new Provider();
  if (setupProvider) setupProvider(provider);
  const current = await createFixture({ provider,verifyResourceBinding: () => true,verifyCleanupEvidence: () => true });
  const { invocation: admitted } = await current.controlPlane.admitInvocation(current.principal,invocationRequest({
    operation: { kind: 'mcp_tool_call',tool_name: 'example_tool',arguments: { value: 1 } } }));
  const capsule = makeCapsule({ created_at: NOW,expires_at: '2026-09-05T12:10:00.000Z',allowed_commit_types: ['TYPED_RESULT'] });
  const packets = [], options = { controlPlane: current.controlPlane,providerRegistry: current.providerRegistry,
    executionPrincipal: current.principal,cleanupPrincipal: current.sameTenantPrincipal,recoveryPrincipal: current.recoveryPrincipal,
    workerId: 'worker:diagnostic',leaseMs: 10000,clock: () => new Date(NOW),
    loadPrepareInput: (invocation) => ({ risk_input: { mcp_phase: 'tools/call',mcp_server_ref: capsule.proposed_interaction.mcp_server_ref,
      mcp_server_origin: capsule.proposed_interaction.mcp_server_origin,mcp_server_trust: 'reachable',tool_name: 'example_tool',capabilities: { filesystem_write: true } },
      capsule,savepoint_input: {},operation: invocation.operation,effective_arguments: { value: 1 },expected_commit_type: 'TYPED_RESULT',
      commit_policy: { typed_result_schema_hash: capsule.authorized_result_schema_hash },network_policy: { mode: 'blocked' },max_execution_ms: 1000 }),
    invokeProvider: async (packet) => { await packet.effectFence(); return packet.provider[packet.method](packet.input); },
    lookupResources: () => ({ savepoint_ref: null,fork_ref: null,absence_evidence: {} }),measureCostMicros: () => 0,
    workerDiagnosticSettings,workerDiagnosticClock: () => Date.now(),workerDiagnosticStore: { async appendWorkerDiagnosticObservation(event) {
      packets.push(event); return { event_ref: event.event_ref,persisted: true }; } },...overrides };
  return { ...current,admitted,provider,options,packets,worker: createManagedRiskForkWorker(options) };
}
