import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { runAll, runHeal, runPremortem, runPremortemSession } from '../src/core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'agoragentic-premortem-golden-loop.mjs');

describe('premortem golden loop core', () => {
  it('passes a release-ready local agent repo without network access', async () => {
    const repo = await makeFixture({
      readme: [
        '# Fixture Agent',
        '',
        'Install with npm install and run npm test.',
        'This agent uses Agent OS and execute(task,input,constraints) for external work.',
        'No-spend mode is the default. Paid execution requires owner approval, budget, max_cost, x402, and USDC funding.',
        'Each run writes a receipt, trace_id, invocation_id, audit trail, and reconciliation note.',
        'Health endpoint: /health. Rollback: redeploy the prior version.'
      ].join('\n'),
      agentJson: true,
      envExample: true
    });

    const report = await runPremortem({ repo });
    assert.equal(report.summary.blockers, 0, JSON.stringify(report.risks, null, 2));
    assert.equal(report.checks.find((check) => check.id === 'secret-hygiene-clear')?.status, 'pass');

    const run = await runAll({ repo, skipNetwork: true });
    assert.equal(run.receipt.no_spend, true);
    assert.equal(run.receipt.pass, true, JSON.stringify(run.golden_loop.stages, null, 2));
    assert.match(run.receipt.receipt_id, /^pgl_[a-f0-9]{16}$/);
  });

  it('flags secret-like values without echoing the secret', async () => {
    const repo = await makeFixture({
      readme: 'No-spend agent with budget docs, receipts, health checks, and Agent OS execute(task,input,constraints).',
      agentJson: true,
      envExample: true
    });
    const secret = ['amk', 'liveSecretValueShouldNotAppear'].join('_');
    await fs.writeFile(path.join(repo, '.env'), `AGORAGENTIC_API_KEY=${secret}\n`, 'utf8');

    const report = await runPremortem({ repo });
    const risk = report.risks.find((item) => item.id === 'secret-hygiene-failed');
    assert.equal(risk?.severity, 'blocker');
    assert.match(JSON.stringify(risk.evidence), /\.env:1/);
    assert.doesNotMatch(JSON.stringify(risk.evidence), new RegExp(secret));
  });

  it('writes JSON artifacts through the CLI', async () => {
    const repo = await makeFixture({
      readme: 'Agent OS no-spend agent with budget approval, receipt, reconciliation, health, and execute(task,input,constraints).',
      agentJson: true,
      envExample: true
    });
    const out = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'pgl-out-')), 'artifacts');
    const result = spawnSync(process.execPath, [BIN, 'run', '--repo', repo, '--out', out, '--skip-network', '--json'], {
      cwd: ROOT,
      encoding: 'utf8'
    });

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.receipt.no_spend, true);
    assert.equal((await exists(path.join(out, 'premortem.json'))), true);
    assert.equal((await exists(path.join(out, 'golden-loop.json'))), true);
    assert.equal((await exists(path.join(out, 'local-receipt.json'))), true);
  });

  it('generates a prompt-style premortem session with investigator findings', async () => {
    const repo = await makeFixture({
      readme: 'Premortem agent repo for Agent OS builders. Success: ten target users run it and revise a release plan.',
      agentJson: true,
      envExample: true
    });

    const session = await runPremortemSession({
      repo,
      plan: 'Release an OSS Agoragentic premortem agent on GitHub that tests Golden Loop readiness for installable AI agent repositories.',
      audience: 'AI agent builders and small teams preparing public agent releases',
      success: 'at least ten real target users install it, run a premortem, and make one concrete launch change'
    });

    assert.equal(session.status, 'complete');
    assert.ok(session.failure_reasons.length >= 5);
    assert.equal(session.deep_dives.length, session.failure_reasons.length);
    assert.match(session.synthesis.hidden_assumption, /hidden assumption/i);
  });

  it('writes HTML report and transcript through the session CLI', async () => {
    const repo = await makeFixture({
      readme: 'Agent OS launch helper. Goal: users produce premortem reports before public release.',
      agentJson: true,
      envExample: true
    });
    const out = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'pgl-session-')), 'artifacts');
    const result = spawnSync(process.execPath, [
      BIN,
      'session',
      '--repo',
      repo,
      '--out',
      out,
      '--plan',
      'Launch a GitHub repo for an AI agent that runs premortems and no-spend Golden Loop checks.',
      '--audience',
      'open-source AI agent builders',
      '--success',
      'builders run the agent and revise their launch plan before release'
    ], {
      cwd: ROOT,
      encoding: 'utf8'
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Premortem report written/);
    const files = await fs.readdir(out);
    assert.ok(files.some((file) => /^premortem-report-.*\.html$/.test(file)));
    assert.ok(files.some((file) => /^premortem-transcript-.*\.md$/.test(file)));
  });

  it('plans self-healing without changing files', async () => {
    const repo = await makeFixture({
      readme: 'Local OSS agent with install docs but missing discovery metadata and explicit safety workflows.',
      agentJson: false,
      envExample: false,
      testScript: false
    });

    const report = await runHeal({ repo });

    assert.equal(report.mode, 'plan_only');
    assert.equal(report.free_to_use, true);
    assert.equal(report.privacy.data_sent_anywhere, false);
    assert.ok(report.plan.actions.some((action) => action.id === 'safety-boundaries-doc' && action.type === 'create_file'));
    assert.ok(report.plan.actions.some((action) => action.id === 'agent-descriptor' && action.type === 'create_file'));
    assert.equal(await exists(path.join(repo, 'docs', 'AGORAGENTIC_SAFETY_BOUNDARIES.md')), false);
    assert.equal(await exists(path.join(repo, 'agent.json')), false);
  });

  it('applies only additive self-healing scaffolds', async () => {
    const repo = await makeFixture({
      readme: 'Local OSS agent with install docs but missing discovery metadata and explicit safety workflows.',
      agentJson: false,
      envExample: false,
      testScript: false
    });

    const report = await runHeal({ repo, applySafeFixes: true });

    assert.equal(report.mode, 'apply_safe_fixes');
    assert.ok(report.applied.some((item) => item.target === 'docs/AGORAGENTIC_SAFETY_BOUNDARIES.md' && item.status === 'created'));
    assert.ok(report.applied.some((item) => item.target === 'agent.json' && item.status === 'created'));
    assert.ok(report.after);
    assert.equal(await exists(path.join(repo, 'docs', 'AGORAGENTIC_GOALS.md')), true);
    assert.equal(await exists(path.join(repo, 'docs', 'AGORAGENTIC_WORKFLOWS.md')), true);
    assert.equal(await exists(path.join(repo, 'docs', 'AGORAGENTIC_SAFETY_BOUNDARIES.md')), true);
    assert.equal(await exists(path.join(repo, '.env.example')), true);
    assert.equal(await exists(path.join(repo, '.github', 'workflows', 'agoragentic-premortem-golden-loop.yml')), true);
  });

  it('writes self-heal artifacts through the CLI', async () => {
    const repo = await makeFixture({
      readme: 'Local OSS agent with install docs but missing discovery metadata and explicit safety workflows.',
      agentJson: false,
      envExample: false,
      testScript: false
    });
    const out = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'pgl-heal-')), 'artifacts');
    const result = spawnSync(process.execPath, [BIN, 'heal', '--repo', repo, '--out', out, '--apply-safe-fixes', '--json'], {
      cwd: ROOT,
      encoding: 'utf8'
    });

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.schema, 'agoragentic.premortem-golden-loop.heal.v1');
    assert.equal(parsed.boundary.network_calls, false);
    assert.equal((await exists(path.join(out, 'healing-plan.json'))), true);
    assert.equal((await exists(path.join(out, 'healing-plan.md'))), true);
    assert.equal((await exists(path.join(repo, 'docs', 'AGORAGENTIC_SAFETY_BOUNDARIES.md'))), true);
  });
});

async function makeFixture({ readme, agentJson, envExample, testScript = true }) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'pgl-repo-'));
  await fs.writeFile(path.join(repo, 'README.md'), `${readme}\n`, 'utf8');
  await fs.writeFile(path.join(repo, 'LICENSE'), 'MIT License\n', 'utf8');
  const packageJson = {
    name: 'fixture-agent',
    version: '1.0.0',
    type: 'module'
  };
  if (testScript) {
    packageJson.scripts = {
      test: 'node --test'
    };
  }
  await fs.writeFile(path.join(repo, 'package.json'), JSON.stringify({
    ...packageJson
  }, null, 2), 'utf8');
  if (agentJson) {
    await fs.writeFile(path.join(repo, 'agent.json'), JSON.stringify({
      name: 'fixture-agent',
      description: 'Fixture installable agent',
      no_spend_default: true
    }, null, 2), 'utf8');
  }
  if (envExample) {
    await fs.writeFile(path.join(repo, '.env.example'), 'AGORAGENTIC_API_KEY=amk_your_key\nMAX_COST_USDC=0\n', 'utf8');
  }
  return repo;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
