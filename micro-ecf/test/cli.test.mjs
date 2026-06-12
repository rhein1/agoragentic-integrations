import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const microEcfRoot = path.join(__dirname, '..');
const cli = path.join(microEcfRoot, 'bin', 'micro-ecf.mjs');

function run(args, cwd) {
  return JSON.parse(execFileSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function write(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text);
}

test('micro-ecf CLI initializes, indexes, builds, and exports bounded local artifacts', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'micro-ecf-cli-'));

  try {
    write(path.join(tmp, 'docs', 'api.md'), '# API\n\nThis local service exposes a support workflow.');
    write(path.join(tmp, 'agent.js'), 'export const rootAgent = true;\n');
    write(path.join(tmp, 'src', 'agent.js'), 'export function handler(input) { return { ok: true, input }; }\n');
    write(path.join(tmp, '.env'), 'SECRET=do-not-export\n');
    write(path.join(tmp, '.ecf-core', 'agent-os-import.json'), '{"generated":true}\n');
    write(path.join(tmp, 'node_modules', 'ignored', 'index.js'), 'module.exports = "ignored";\n');

    const init = run(['init', '--dir', tmp], microEcfRoot);
    assert.equal(init.ok, true);
    assert.ok(fs.existsSync(path.join(tmp, '.micro-ecf', 'policy.json')));
    assert.ok(fs.existsSync(path.join(tmp, 'ECF.md')));
    assert.ok(fs.existsSync(path.join(tmp, 'AGENTS.md')));
    assert.ok(fs.existsSync(path.join(tmp, 'MICRO_ECF_LLM_BOOTSTRAP.md')));

    const lint = run(['lint', path.join(tmp, 'ECF.md')], microEcfRoot);
    assert.equal(lint.ok, true);
    assert.equal(lint.tokens.project, path.basename(tmp));

    const doctor = run(['doctor', '--dir', tmp], microEcfRoot);
    assert.equal(doctor.ok, false);
    assert.ok(doctor.checks.some((check) => check.name === 'source_map' && check.ok === false));

    const scan = run(['scan', '--dir', tmp], microEcfRoot);
    assert.equal(scan.ok, true);
    assert.equal(scan.no_writes_performed, true);
    assert.ok(scan.stats.sensitive_blocked_paths >= 1);

    const index = run(['index', tmp, '--output-dir', path.join(tmp, '.micro-ecf')], microEcfRoot);
    assert.equal(index.ok, true);
    assert.equal(index.stats.included_sources, 3);
    assert.equal(index.stats.generated_sources_excluded >= 4, true);
    assert.ok(index.stats.blocked_paths >= 1);

    const sourceMap = readJson(path.join(tmp, '.micro-ecf', 'source-map.json'));
    assert.deepEqual(sourceMap.sources.map((source) => source.path).sort(), ['agent.js', 'docs/api.md', 'src/agent.js']);
    assert.equal(sourceMap.sources.find((source) => source.path === 'docs/api.md').summary, 'API: This local service exposes a support workflow.');
    assert.ok(sourceMap.generated.some((entry) => entry.path === 'ECF.md'));
    assert.ok(sourceMap.generated.some((entry) => entry.path === 'AGENTS.md'));
    assert.ok(sourceMap.generated.some((entry) => entry.path === 'MICRO_ECF_LLM_BOOTSTRAP.md'));
    assert.ok(sourceMap.generated.some((entry) => entry.path === '.ecf-core/agent-os-import.json'));
    assert.ok(sourceMap.blocked.some((entry) => entry.path === '.env'));
    assert.equal(JSON.stringify(sourceMap).includes('do-not-export'), false);
    assert.equal(JSON.stringify(sourceMap).includes(tmp.replace(/\\/g, '/')), false);

    const built = run(['build-packet', '--policy', path.join(tmp, '.micro-ecf', 'policy.json'), '--source-map', path.join(tmp, '.micro-ecf', 'source-map.json'), '--output-dir', path.join(tmp, '.micro-ecf')], microEcfRoot);
    assert.equal(built.ok, true);
    assert.ok(fs.existsSync(path.join(tmp, '.micro-ecf', 'context-packet.json')));
    assert.ok(fs.existsSync(path.join(tmp, '.micro-ecf', 'policy-summary.json')));
    assert.ok(fs.existsSync(path.join(tmp, '.micro-ecf', 'deployment-preview.json')));

    const contextPacket = readJson(path.join(tmp, '.micro-ecf', 'context-packet.json'));
    assert.equal(contextPacket.schema, 'agoragentic.micro-ecf.context-packet.v1');
    assert.equal(contextPacket.export_boundary.raw_content_exported, false);
    assert.equal(contextPacket.citations.length, 3);

    const preview = readJson(path.join(tmp, '.micro-ecf', 'deployment-preview.json'));
    assert.equal(preview.marketplace_policy.can_buy, false);
    assert.equal(preview.marketplace_policy.can_sell, false);
    assert.equal(preview.api_policy.public_api_enabled, false);
    assert.equal(preview.learning_memory.mode, 'review_guidance_only');
    assert.equal(preview.learning_memory.side_effect_authority.can_authorize_live_spend, false);

    const exported = run(['export', '--agent-os', '--policy', path.join(tmp, '.micro-ecf', 'policy.json'), '--output', path.join(tmp, '.micro-ecf', 'harness-export.json')], microEcfRoot);
    assert.equal(exported.ok, true);

    const healthy = run(['doctor', '--dir', tmp], microEcfRoot);
    assert.equal(healthy.ok, true);

    const harness = readJson(path.join(tmp, '.micro-ecf', 'harness-export.json'));
    assert.equal(harness.schema, 'agoragentic.agent-os.harness.v1');
    assert.equal(harness.public_boundary.no_spend_export, true);
    assert.equal(harness.public_boundary.full_ecf_runtime_included, false);
    assert.equal(harness.public_boundary.router_ranking_included, false);
    assert.equal(harness.public_boundary.settlement_internals_included, false);
    assert.equal(harness.public_boundary.enterprise_governance_internals_included, false);
    assert.equal(harness.public_boundary.learning_memory_review_only, true);
    assert.equal(harness.public_boundary.memory_can_authorize_live_actions, false);
    assert.equal(harness.public_boundary.memory_auto_execute, false);
    assert.equal(harness.learning_memory_boundary.mode, 'review_guidance_only');
    assert.deepEqual(harness.learning_memory_boundary.review_statuses, ['blocked', 'manual_review', 'proposal_ready']);
    assert.equal(harness.learning_memory_boundary.side_effect_authority.can_authorize_deploy, false);
    assert.equal(harness.agent_os_preview_request.deployment_packet.source, 'public_micro_ecf');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('LLM install flow is read-only until explicit approval', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'micro-ecf-llm-install-'));

  try {
    write(path.join(tmp, 'docs', 'guide.md'), '# Guide\n\nUse this project safely.');

    const explanation = run(['explain'], microEcfRoot);
    assert.equal(explanation.boundary.local_only, true);
    assert.equal(explanation.boundary.micro_ecf, 'local context wedge');
    assert.equal(explanation.boundary.no_spend, true);
    assert.equal(explanation.boundary.no_semantic_rag_engine, true);
    assert.equal(explanation.boundary.no_generated_answers, true);
    assert.equal(explanation.boundary.no_full_ecf_internals, true);
    assert.match(explanation.what_it_does.join(' '), /external context providers/i);

    const plan = run(['plan', '--dir', tmp], microEcfRoot);
    assert.equal(plan.approval_required, true);
    assert.equal(plan.no_writes_performed, true);
    assert.ok(plan.files_that_may_be_created_or_updated.some((file) => file.endsWith('MICRO_ECF_LLM_BOOTSTRAP.md')));
    assert.ok(plan.files_that_may_be_created_or_updated.some((file) => file.endsWith('ECF.md')));
    assert.ok(plan.files_that_may_be_created_or_updated.some((file) => file.endsWith('.micro-ecf/harness-export.json')));
    assert.equal(fs.existsSync(path.join(tmp, '.micro-ecf')), false);

    const refused = run(['install', '--dir', tmp], microEcfRoot);
    assert.equal(refused.ok, false);
    assert.equal(refused.requires_approval, true);
    assert.equal(fs.existsSync(path.join(tmp, '.micro-ecf')), false);

    const installed = run(['install', '--dir', tmp, '--yes'], microEcfRoot);
    assert.equal(installed.ok, true);
    assert.equal(installed.approved, true);
    assert.ok(fs.existsSync(path.join(tmp, 'AGENTS.md')));
    assert.ok(fs.existsSync(path.join(tmp, 'ECF.md')));
    assert.ok(fs.existsSync(path.join(tmp, 'MICRO_ECF_LLM_BOOTSTRAP.md')));
    assert.ok(fs.existsSync(path.join(tmp, '.micro-ecf', 'context-packet.json')));
    assert.ok(fs.existsSync(path.join(tmp, '.micro-ecf', 'policy-summary.json')));
    assert.ok(fs.existsSync(path.join(tmp, '.micro-ecf', 'harness-export.json')));

    const bootstrap = fs.readFileSync(path.join(tmp, 'MICRO_ECF_LLM_BOOTSTRAP.md'), 'utf8');
    assert.match(bootstrap, /ECF\.md/);
    assert.match(bootstrap, /Expected Assistant Disclosure/);
    assert.match(bootstrap, /are you using Micro ECF/);
    assert.match(bootstrap, /not a semantic RAG engine/i);
    assert.match(bootstrap, /governs what those systems may expose or act on/i);
    assert.match(bootstrap, /does not automatically read repo-level instructions/i);

    const harness = readJson(path.join(tmp, '.micro-ecf', 'harness-export.json'));
    assert.equal(harness.public_boundary.no_spend_export, true);
    assert.equal(harness.public_boundary.cloud_provisioning, false);
    assert.equal(harness.public_boundary.full_ecf_runtime_included, false);
    assert.equal(harness.public_boundary.learning_memory_review_only, true);
    assert.equal(harness.public_boundary.memory_can_authorize_live_actions, false);

    const spec = run(['spec', '--json'], microEcfRoot);
    assert.equal(spec.name, 'ECF.md');
    assert.ok(spec.required_front_matter.includes('allowed_sources'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('resident status and context pack expose local always-on handoff artifacts', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'micro-ecf-resident-'));

  try {
    write(path.join(tmp, 'docs', 'api.md'), '# API\n\nThis local service exposes a supervised lead workflow.');

    const installed = run(['install', '--dir', tmp, '--yes'], microEcfRoot);
    assert.equal(installed.ok, true);

    const status = run(['status', '--dir', tmp, '--write'], microEcfRoot);
    assert.equal(status.schema, 'agoragentic.micro-ecf.resident-status.v1');
    assert.equal(status.ok, true);
    assert.equal(status.resident_state, 'ready');
    assert.equal(status.authority_boundary.local_only, true);
    assert.equal(status.authority_boundary.no_spend, true);
    assert.equal(status.authority_boundary.no_deploy, true);
    assert.equal(status.authority_boundary.no_x402_settlement, true);
    assert.equal(status.authority_boundary.full_ecf_private_internals_included, false);
    assert.ok(status.mcp.tools.includes('micro_ecf.status'));
    assert.ok(status.mcp.tools.includes('micro_ecf.context_pack'));
    assert.ok(fs.existsSync(path.join(tmp, '.micro-ecf', 'resident-status.json')));

    const pack = run(['context-pack', 'review current task', '--dir', tmp, '--write'], microEcfRoot);
    assert.equal(pack.schema, 'agoragentic.micro-ecf.context-pack.v1');
    assert.equal(pack.ok, true);
    assert.equal(pack.task, 'review current task');
    assert.equal(pack.authority_boundary.no_wallet_mutation, true);
    assert.equal(pack.authority_boundary.no_marketplace_publication, true);
    assert.equal(pack.assistant_bootstrap.read_order.includes('AGENTS.md'), true);
    assert.equal(pack.summary.source_counts.included_sources > 0, true);
    assert.ok(fs.existsSync(path.join(tmp, '.micro-ecf', 'context-pack.json')));

    const residentStatus = run(['resident', 'status', '--dir', tmp, '--write'], microEcfRoot);
    assert.equal(residentStatus.schema, 'agoragentic.micro-ecf.resident-status.v1');
    assert.equal(residentStatus.ok, true);
    assert.equal(residentStatus.authority_boundary.local_only, true);
    assert.equal(residentStatus.authority_boundary.no_deploy, true);
    assert.equal(residentStatus.authority_boundary.no_spend, true);
    assert.equal(residentStatus.authority_boundary.full_ecf_private_internals_included, false);

    const refresh = run(['resident', 'refresh', '--dir', tmp, '--task', 'refresh resident continuity'], microEcfRoot);
    assert.equal(refresh.schema, 'agoragentic.micro-ecf.resident-refresh.v1');
    assert.equal(refresh.ok, true);
    assert.equal(refresh.context_pack.task, 'refresh resident continuity');
    assert.equal(refresh.authority_boundary.local_only, true);
    assert.equal(refresh.authority_boundary.deploy_enabled, false);
    assert.equal(refresh.authority_boundary.spend_enabled, false);
    assert.equal(refresh.authority_boundary.wallet_mutation_enabled, false);
    assert.equal(refresh.authority_boundary.x402_settlement_enabled, false);
    assert.equal(refresh.authority_boundary.marketplace_publication_enabled, false);
    assert.equal(refresh.authority_boundary.hosted_runtime_enabled, false);
    assert.equal(refresh.authority_boundary.full_ecf_private_internals_included, false);
    assert.ok(refresh.status.status_path.endsWith('.micro-ecf/resident-status.json'));
    assert.ok(refresh.context_pack.context_pack_path.endsWith('.micro-ecf/context-pack.json'));
    assert.ok(refresh.docs_sync_plan.plan_path.endsWith('.micro-ecf/docs-sync-plan.json'));
    assert.ok(refresh.handoff.handoff_path.endsWith('.micro-ecf/handoff.md'));
    assert.ok(fs.existsSync(path.join(tmp, '.micro-ecf', 'resident-status.json')));
    assert.ok(fs.existsSync(path.join(tmp, '.micro-ecf', 'context-pack.json')));
    assert.ok(fs.existsSync(path.join(tmp, '.micro-ecf', 'docs-sync-plan.json')));
    assert.ok(fs.existsSync(path.join(tmp, '.micro-ecf', 'handoff.md')));
    assert.ok(fs.existsSync(path.join(tmp, '.micro-ecf', 'handoff.json')));
    assert.ok(fs.existsSync(path.join(tmp, '.micro-ecf', 'next-session.md')));

    const codexHome = path.join(tmp, 'codex-home');
    const mcpConfig = run([
      'mcp-config',
      '--target',
      'codex',
      '--dir',
      tmp,
      '--write',
      '--codex-home',
      codexHome,
      '--server-name',
      'test_micro_ecf',
    ], microEcfRoot);
    assert.equal(mcpConfig.schema, 'agoragentic.micro-ecf.mcp-config.v1');
    assert.equal(mcpConfig.server_name, 'test_micro_ecf');
    assert.match(mcpConfig.toml, /\[mcp_servers\.test_micro_ecf\]/);
    assert.match(mcpConfig.toml, /serve-mcp/);
    assert.equal(mcpConfig.codex_config_updated, false);
    assert.ok(fs.existsSync(path.join(tmp, '.micro-ecf', 'codex-mcp.toml')));
    assert.ok(fs.existsSync(path.join(tmp, '.micro-ecf', 'CODEX_MCP_INSTALL.md')));

    const installedConfig = run([
      'mcp-config',
      '--target',
      'codex',
      '--dir',
      tmp,
      '--install-codex',
      '--codex-home',
      codexHome,
      '--server-name',
      'test_micro_ecf',
    ], microEcfRoot);
    assert.equal(installedConfig.codex_config_updated, true);
    const codexConfig = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
    assert.match(codexConfig, /BEGIN Micro ECF resident test_micro_ecf/);
    assert.match(codexConfig, /\[mcp_servers\.test_micro_ecf\]/);
    assert.match(codexConfig, /micro-ecf\.mjs/);

    const mcpRequests = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'micro_ecf.status',
          arguments: {},
        },
      },
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'micro_ecf.context_pack',
          arguments: { task: 'mcp task' },
        },
      },
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'micro_ecf.worklog_status',
          arguments: {},
        },
      },
    ].map((item) => JSON.stringify(item)).join('\n');
    const mcpOutput = execFileSync(process.execPath, [
      cli,
      'serve-mcp',
      '--root',
      path.join(tmp, '.micro-ecf'),
    ], {
      input: `${mcpRequests}\n`,
      encoding: 'utf8',
    });
    const responses = mcpOutput.trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(responses[1].result.tools.some((tool) => tool.name === 'micro_ecf.status'));
    assert.ok(responses[1].result.tools.some((tool) => tool.name === 'micro_ecf.context_pack'));
    const mcpStatus = JSON.parse(responses[2].result.content[0].text);
    assert.equal(mcpStatus.resident_state, 'ready');
    const mcpPack = JSON.parse(responses[3].result.content[0].text);
    assert.equal(mcpPack.task, 'mcp task');
    assert.equal(mcpPack.authority_boundary.no_cloud_call, true);
    const mcpWorklog = JSON.parse(responses[4].result.content[0].text);
    assert.equal(mcpWorklog.schema, 'agoragentic.micro-ecf.worklog-status.v1');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('resident work memory records goals, docs-sync plans, and handoffs without editing docs', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'micro-ecf-worklog-'));

  try {
    write(path.join(tmp, 'README.md'), '# Fixture\n');
    write(path.join(tmp, 'docs', 'API_REFERENCE.md'), '# API\n');
    const installed = run(['install', '--dir', tmp, '--yes'], microEcfRoot);
    assert.equal(installed.ok, true);

    const begin = run([
      'worklog',
      'begin',
      '--dir',
      tmp,
      '--goal',
      'Add local proof runner',
      '--files',
      'bin/micro-ecf.mjs,src/work-memory.mjs',
    ], microEcfRoot);
    assert.equal(begin.ok, true);
    assert.equal(begin.current.status, 'active');
    assert.equal(begin.current.goal, 'Add local proof runner');
    assert.equal(begin.current.authority_boundary.docs_auto_edit_enabled, false);

    const checkpoint = run([
      'worklog',
      'checkpoint',
      '--dir',
      tmp,
      '--summary',
      'CLI shape complete',
      '--validation',
      'npm test',
    ], microEcfRoot);
    assert.equal(checkpoint.ok, true);
    assert.equal(checkpoint.checkpoint.summary, 'CLI shape complete');

    const finished = run([
      'worklog',
      'finish',
      '--dir',
      tmp,
      '--summary',
      'Committed local proof runner',
      '--commit',
      'abc123',
      '--tests',
      'npm test',
      '--unfinished',
      'Harden receipt verifier',
      '--next-prompt',
      'feat(core): harden receipt verifier',
    ], microEcfRoot);
    assert.equal(finished.ok, true);
    assert.equal(finished.finished.status, 'finished');
    assert.deepEqual(finished.finished.commits, ['abc123']);
    assert.ok(fs.existsSync(path.join(tmp, '.micro-ecf', 'worklog', 'latest-summary.md')));

    const plan = run(['docs-sync', 'plan', '--dir', tmp], microEcfRoot);
    assert.equal(plan.schema, 'agoragentic.micro-ecf.docs-sync-plan.v1');
    assert.equal(plan.docs_auto_edit_enabled, false);
    assert.equal(plan.apply_supported, false);
    assert.ok(plan.impact.candidates.some((candidate) => candidate.path === 'README.md' && candidate.exists));
    assert.ok(fs.existsSync(path.join(tmp, '.micro-ecf', 'docs-sync-plan.json')));

    const handoff = run(['handoff', '--dir', tmp, '--write'], microEcfRoot);
    assert.equal(handoff.schema, 'agoragentic.micro-ecf.handoff.v1');
    assert.equal(handoff.work.next_prompt, 'feat(core): harden receipt verifier');
    assert.ok(fs.existsSync(path.join(tmp, '.micro-ecf', 'handoff.md')));
    assert.ok(fs.existsSync(path.join(tmp, '.micro-ecf', 'next-session.md')));
    const handoffText = fs.readFileSync(path.join(tmp, '.micro-ecf', 'next-session.md'), 'utf8');
    assert.match(handoffText, /Add local proof runner/);
    assert.match(handoffText, /feat\(core\): harden receipt verifier/);
    assert.match(handoffText, /does not deploy, spend, mutate wallets/);

    const memoryRequests = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'micro_ecf.work_memory',
          arguments: {},
        },
      },
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'micro_ecf.handoff',
          arguments: {},
        },
      },
    ].map((item) => JSON.stringify(item)).join('\n');
    const memoryOutput = execFileSync(process.execPath, [
      cli,
      'serve-mcp',
      '--root',
      path.join(tmp, '.micro-ecf'),
    ], {
      input: `${memoryRequests}\n`,
      encoding: 'utf8',
    });
    const responses = memoryOutput.trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(responses[1].result.tools.some((tool) => tool.name === 'micro_ecf.work_memory'));
    assert.ok(responses[1].result.tools.some((tool) => tool.name === 'micro_ecf.handoff'));
    const memory = JSON.parse(responses[2].result.content[0].text);
    assert.equal(memory.status.current.goal, 'Add local proof runner');
    assert.equal(memory.authority_boundary.docs_auto_edit_enabled, false);
    const mcpHandoff = JSON.parse(responses[3].result.content[0].text);
    assert.equal(mcpHandoff.work.status, 'finished');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('package metadata keeps Micro ECF local-first and Apache licensed', () => {
  const packageJson = readJson(path.join(microEcfRoot, 'package.json'));
  assert.equal(packageJson.name, 'agoragentic-micro-ecf');
  assert.equal(packageJson.bin['micro-ecf'], './bin/micro-ecf.mjs');
  assert.equal(packageJson.license, 'Apache-2.0');
  assert.match(packageJson.description, /Local-first context layer/);
  assert.equal(packageJson.engines.node, '>=18');
  assert.ok(packageJson.files.includes('assets/'));
  assert.ok(packageJson.files.includes('POST_INSTALL.md'));
  assert.ok(packageJson.files.includes('CODEX_MCP.md'));
  assert.ok(packageJson.files.includes('PROVIDER_WRAPPING.md'));
  assert.ok(packageJson.files.includes('FRAMEWORKS.md'));
  assert.ok(packageJson.files.includes('ECF_CORE_UPGRADE.md'));
  assert.ok(packageJson.files.includes('AGENT_OS_EVIDENCE_EVAL_BACKLOG.md'));
});

test('context provider docs and examples keep Micro ECF as a governance wrapper', () => {
  const schema = readJson(path.join(microEcfRoot, 'schema', 'micro-ecf-policy.v1.json'));
  const providerTypes = schema.properties.context_providers.items.properties.type.enum;
  assert.ok(providerTypes.includes('retrieval_context'));
  assert.ok(providerTypes.includes('code_graph'));

  const guide = fs.readFileSync(path.join(microEcfRoot, 'PROVIDER_WRAPPING.md'), 'utf8');
  const postInstall = fs.readFileSync(path.join(microEcfRoot, 'POST_INSTALL.md'), 'utf8');
  const codexMcp = fs.readFileSync(path.join(microEcfRoot, 'CODEX_MCP.md'), 'utf8');
  const readme = fs.readFileSync(path.join(microEcfRoot, 'README.md'), 'utf8');
  assert.match(guide, /does not replace your RAG/i);
  assert.match(guide, /raw_secret_content_allowed/);
  assert.match(guide, /fail closed/i);
  const upgrade = fs.readFileSync(path.join(microEcfRoot, 'ECF_CORE_UPGRADE.md'), 'utf8');
  assert.match(upgrade, /Micro ECF/);
  assert.match(upgrade, /ECF Core/);
  assert.match(upgrade, /Agent OS/);
  assert.match(upgrade, /Full ECF private internals/);
  assert.match(postInstall, /micro-ecf mcp-config --target codex/);
  assert.match(postInstall, /micro-ecf worklog begin/);
  assert.match(postInstall, /micro-ecf docs-sync plan/);
  assert.match(postInstall, /micro-ecf handoff --write/);
  assert.match(postInstall, /micro-ecf resident refresh --dir \./);
  assert.match(readme, /micro-ecf resident refresh/);
  assert.match(readme, /does not deploy, spend, mutate wallets/);
  assert.match(codexMcp, /Resident MCP for Codex/);
  assert.match(codexMcp, /micro_ecf\.context_pack/);
  assert.match(codexMcp, /micro_ecf\.work_memory/);
  assert.match(codexMcp, /resident refresh/);
  assert.match(codexMcp, /auto-edit docs/);

  const examples = [
    ['context-provider-rag.policy.json', 'retrieval_context', 'local_rag'],
    ['context-provider-gitnexus.policy.json', 'code_graph', 'gitnexus'],
    ['context-provider-database-mcp.policy.json', 'retrieval_context', 'database_mcp'],
  ];

  for (const [fileName, expectedType, expectedProvider] of examples) {
    const examplePath = path.join(microEcfRoot, 'examples', fileName);
    const policy = readJson(examplePath);
    assert.equal(policy.schema, 'agoragentic.micro-ecf.policy.v1');
    assert.equal(policy.context_providers[0].type, expectedType);
    assert.equal(policy.context_providers[0].provider, expectedProvider);
    assert.equal(JSON.stringify(policy).includes('PRIVATE_KEY='), false);

    const validated = run(['validate-policy', '--policy', examplePath], microEcfRoot);
    assert.equal(validated.ok, true);
  }
});
