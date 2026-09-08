/** Compose with canonical Harness Core; do not copy its policy or receipt engine.
 * Optional installed dependency: agoragentic-harness-core@0.4.2.
 * A local receipt records self-reported synthetic evidence, not remote proof.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export function fixtureSummary(input) {
  if (!input || input.schema !== 'agoragentic.commerce.fixture-evidence.v1'
    || input.fixture_only !== true || input.effect_scope !== 'fixture_sqlite'
    || input.spend_usdc !== '0' || input.payment_attempted !== false
    || input.production_authority !== false || input.settlement_final !== false
    || input.upstream_runtime_exercised !== false
    || !Array.isArray(input.events) || input.events.length > 1000) throw new Error('fixture_boundary_invalid');
  const hash = createHash('sha256').update(JSON.stringify(canonical(input.events))).digest('hex');
  if (hash !== input.evidence_hash) throw new Error('fixture_evidence_hash_mismatch');
  const applied = input.events.filter(event => event.kind === 'applied');
  if (!applied.length || applied.some(event => event.action_executed !== true || event.effect_scope !== 'fixture_sqlite')) {
    throw new Error('fixture_effect_evidence_required');
  }
  return { fixture_evidence_hash: hash, recorded_fixture_effects: applied.length,
    evidence_origin: 'self_reported_local_fixture', independent_verification: false };
}

export async function composeHarnessEvidence(input) {
  const summary = fixtureSummary(input);
  // Missing dependency is an explicit error; there is no fallback receipt engine.
  const harness = await import('agoragentic-harness-core');
  const { decideClaudeCodeToolCall } = await import('agoragentic-harness-core/adapters/claude-code');
  const packageFile = path.resolve(path.dirname(fileURLToPath(import.meta.resolve('agoragentic-harness-core'))), '../package.json');
  const manifest = JSON.parse(await readFile(packageFile, 'utf8'));
  if (manifest.version !== '0.4.2') throw new Error('harness_version_mismatch');
  const project = {
    agent: { schema: 'agoragentic.harness.agent.v1', name: 'Commerce local fixture', framework: 'custom_python',
      primary_goal: 'Record a synthetic local listing edit', description: 'Fixture evidence only' },
    policy: { schema: 'agoragentic.harness.policy.v1',
      context_policy: { allowed_sources: ['fixture'], denied_sources: [] },
      tool_policy: { allowed_tools: ['fixture_title_edit'], denied_tools: [] },
      budget_policy: { max_daily_spend_usdc: 0 },
      approval_policy: { human_gated: ['fixture_title_edit'] },
      deployment_policy: { first_proof_required: true } },
  };
  // Advisory only: this mapping is not wired as production permission middleware.
  const policyDecision = decideClaudeCodeToolCall(project.policy, {
    tool_name: 'mcp__commerce_fixture__apply_change', tool_input: {},
  });
  const proof = harness.createLocalProof(project);
  if (proof.status !== 'passed') throw new Error('harness_local_proof_blocked');
  const receipt = harness.createLocalReceipt(project, proof);
  receipt.settlement_status = 'not_settlement_receipt';
  receipt.evidence.local_artifacts = []; // In-memory run; do not invent file artifacts.
  Object.assign(receipt.evidence, summary, { claim_scope: 'synthetic SQLite only; no upstream/host/production qualification' });
  return { policyDecision, proof, receipt };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('usage: node harness-evidence.mjs fixture-evidence.json');
  const bytes = await readFile(process.argv[2]);
  if (bytes.length > 1024 * 1024) throw new Error('fixture_evidence_too_large');
  console.log(JSON.stringify(await composeHarnessEvidence(JSON.parse(bytes.toString('utf8'))), null, 2));
}
