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
    write(path.join(tmp, 'src', 'agent.js'), 'export function handler(input) { return { ok: true, input }; }\n');
    write(path.join(tmp, '.env'), 'SECRET=do-not-export\n');
    write(path.join(tmp, 'node_modules', 'ignored', 'index.js'), 'module.exports = "ignored";\n');

    const init = run(['init', '--dir', tmp], microEcfRoot);
    assert.equal(init.ok, true);
    assert.ok(fs.existsSync(path.join(tmp, '.micro-ecf', 'policy.json')));
    assert.ok(fs.existsSync(path.join(tmp, 'AGENTS.md')));
    assert.ok(fs.existsSync(path.join(tmp, 'MICRO_ECF_LLM_BOOTSTRAP.md')));

    const index = run(['index', tmp, '--output-dir', path.join(tmp, '.micro-ecf')], microEcfRoot);
    assert.equal(index.ok, true);
    assert.equal(index.stats.included_sources, 4);
    assert.ok(index.stats.blocked_paths >= 1);

    const sourceMap = readJson(path.join(tmp, '.micro-ecf', 'source-map.json'));
    assert.deepEqual(sourceMap.sources.map((source) => source.path).sort(), ['AGENTS.md', 'MICRO_ECF_LLM_BOOTSTRAP.md', 'docs/api.md', 'src/agent.js']);
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
    assert.equal(contextPacket.citations.length, 4);

    const preview = readJson(path.join(tmp, '.micro-ecf', 'deployment-preview.json'));
    assert.equal(preview.marketplace_policy.can_buy, false);
    assert.equal(preview.marketplace_policy.can_sell, false);
    assert.equal(preview.api_policy.public_api_enabled, false);

    const exported = run(['export', '--agent-os', '--policy', path.join(tmp, '.micro-ecf', 'policy.json'), '--output', path.join(tmp, '.micro-ecf', 'harness-export.json')], microEcfRoot);
    assert.equal(exported.ok, true);

    const harness = readJson(path.join(tmp, '.micro-ecf', 'harness-export.json'));
    assert.equal(harness.schema, 'agoragentic.agent-os.harness.v1');
    assert.equal(harness.public_boundary.no_spend_export, true);
    assert.equal(harness.public_boundary.full_ecf_runtime_included, false);
    assert.equal(harness.public_boundary.router_ranking_included, false);
    assert.equal(harness.public_boundary.settlement_internals_included, false);
    assert.equal(harness.public_boundary.enterprise_governance_internals_included, false);
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
    assert.equal(explanation.boundary.no_spend, true);
    assert.equal(explanation.boundary.no_full_ecf_internals, true);

    const plan = run(['plan', '--dir', tmp], microEcfRoot);
    assert.equal(plan.approval_required, true);
    assert.equal(plan.no_writes_performed, true);
    assert.ok(plan.files_that_may_be_created_or_updated.some((file) => file.endsWith('MICRO_ECF_LLM_BOOTSTRAP.md')));
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
    assert.ok(fs.existsSync(path.join(tmp, 'MICRO_ECF_LLM_BOOTSTRAP.md')));
    assert.ok(fs.existsSync(path.join(tmp, '.micro-ecf', 'context-packet.json')));
    assert.ok(fs.existsSync(path.join(tmp, '.micro-ecf', 'policy-summary.json')));
    assert.ok(fs.existsSync(path.join(tmp, '.micro-ecf', 'harness-export.json')));

    const bootstrap = fs.readFileSync(path.join(tmp, 'MICRO_ECF_LLM_BOOTSTRAP.md'), 'utf8');
    assert.match(bootstrap, /Expected Assistant Disclosure/);
    assert.match(bootstrap, /are you using Micro ECF/);
    assert.match(bootstrap, /does not automatically read repo-level instructions/i);

    const harness = readJson(path.join(tmp, '.micro-ecf', 'harness-export.json'));
    assert.equal(harness.public_boundary.no_spend_export, true);
    assert.equal(harness.public_boundary.cloud_provisioning, false);
    assert.equal(harness.public_boundary.full_ecf_runtime_included, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('package metadata keeps Micro ECF local-first and Apache licensed', () => {
  const packageJson = readJson(path.join(microEcfRoot, 'package.json'));
  assert.equal(packageJson.name, 'agoragentic-micro-ecf');
  assert.equal(packageJson.bin['micro-ecf'], './bin/micro-ecf.mjs');
  assert.equal(packageJson.license, 'Apache-2.0');
  assert.equal(packageJson.engines.node, '>=18');
  assert.ok(packageJson.files.includes('POST_INSTALL.md'));
});
