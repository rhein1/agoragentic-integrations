import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_BASE_URL = 'https://agoragentic.com';
export const DEFAULT_OUTPUT_DIR = '.agoragentic/premortem-golden-loop';

const TEXT_EXTENSIONS = new Set([
  '',
  '.cjs',
  '.css',
  '.env',
  '.html',
  '.ini',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.py',
  '.sh',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml'
]);

const IGNORED_DIRS = new Set([
  '.agoragentic',
  '.cache',
  '.git',
  '.micro-ecf',
  '.next',
  '.turbo',
  '.venv',
  '__pycache__',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'target',
  'venv'
]);

const SECRET_PATTERNS = [
  {
    id: 'private-key-block',
    label: 'private key block',
    regex: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/i
  },
  {
    id: 'aws-access-key',
    label: 'AWS access key',
    regex: /\bAKIA[0-9A-Z]{16}\b/
  },
  {
    id: 'openai-style-key',
    label: 'OpenAI-style secret key',
    regex: /\bsk-[A-Za-z0-9_-]{20,}\b/
  },
  {
    id: 'agoragentic-api-key',
    label: 'Agoragentic API key',
    regex: /\bamk_[A-Za-z0-9_-]{12,}\b/
  },
  {
    id: 'github-token',
    label: 'GitHub token',
    regex: /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/
  },
  {
    id: 'env-secret-value',
    label: 'secret-like environment value',
    regex: /\b(?:API[_-]?KEY|SECRET|TOKEN|PRIVATE[_-]?KEY|PASSWORD)\s*[:=]\s*["']?(?!your|example|sample|changeme|placeholder|<|$)[A-Za-z0-9_./+=:@-]{12,}/i
  }
];

function nowIso() {
  return new Date().toISOString();
}

function slash(value) {
  return value.replace(/\\/g, '/');
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeRoot(root = '.') {
  return path.resolve(root);
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readText(filePath) {
  return fs.readFile(filePath, 'utf8');
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readText(filePath));
  } catch {
    return null;
  }
}

async function statSafe(filePath) {
  try {
    return await fs.stat(filePath);
  } catch {
    return null;
  }
}

async function walkFiles(root, { maxFiles = 2500 } = {}) {
  const files = [];
  const queue = [root];

  while (queue.length && files.length < maxFiles) {
    const current = queue.shift();
    let entries = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) queue.push(full);
        continue;
      }
      if (entry.isFile()) files.push(full);
      if (files.length >= maxFiles) break;
    }
  }

  return files;
}

function relative(root, filePath) {
  return slash(path.relative(root, filePath) || '.');
}

function fileBasenames(files) {
  return new Set(files.map((file) => path.basename(file).toLowerCase()));
}

function hasFile(files, names) {
  const basenames = fileBasenames(files);
  return names.some((name) => basenames.has(name.toLowerCase()));
}

function hasPath(files, root, candidates) {
  const rels = files.map((file) => relative(root, file).toLowerCase());
  return candidates.some((candidate) => {
    const normalized = slash(candidate).toLowerCase().replace(/\/$/, '');
    return rels.some((rel) => rel === normalized || rel.startsWith(`${normalized}/`));
  });
}

async function readSearchableText(root, files) {
  const candidates = files.filter((file) => {
    const rel = relative(root, file).toLowerCase();
    const ext = path.extname(file).toLowerCase();
    return TEXT_EXTENSIONS.has(ext)
      && !rel.includes('package-lock.json')
      && !rel.includes('pnpm-lock.yaml')
      && !rel.includes('yarn.lock');
  }).slice(0, 300);

  const chunks = [];
  for (const file of candidates) {
    const stat = await statSafe(file);
    if (!stat || stat.size > 250_000) continue;
    try {
      chunks.push(await readText(file));
    } catch {
      // Ignore unreadable files; the premortem will still report structural gaps.
    }
  }
  return chunks.join('\n').toLowerCase();
}

async function scanSecrets(root, files) {
  const findings = [];
  for (const file of files) {
    const rel = relative(root, file);
    const ext = path.extname(file).toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext)) continue;
    if (/package-lock\.json$|pnpm-lock\.yaml$|yarn\.lock$/i.test(rel)) continue;

    const stat = await statSafe(file);
    if (!stat || stat.size > 350_000) continue;

    let text = '';
    try {
      text = await readText(file);
    } catch {
      continue;
    }

    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const lowered = line.toLowerCase();
      if (lowered.includes('placeholder') || lowered.includes('your_') || lowered.includes('example')) {
        continue;
      }
      for (const pattern of SECRET_PATTERNS) {
        if (pattern.regex.test(line)) {
          findings.push({
            id: pattern.id,
            label: pattern.label,
            file: rel,
            line: index + 1
          });
          break;
        }
      }
      if (findings.length >= 25) return findings;
    }
  }
  return findings;
}

function includesAny(text, terms) {
  return terms.some((term) => text.includes(term.toLowerCase()));
}

function statusFromRisk(severity) {
  if (severity === 'blocker') return 'fail';
  if (severity === 'warning') return 'warn';
  return 'pass';
}

function addRisk(risks, checks, risk) {
  risks.push(risk);
  checks.push({
    id: risk.id,
    title: risk.title,
    status: statusFromRisk(risk.severity),
    evidence: risk.evidence,
    action: risk.action
  });
}

function addPass(checks, id, title, evidence) {
  checks.push({ id, title, status: 'pass', evidence });
}

function summarizeRisks(risks) {
  const blockers = risks.filter((risk) => risk.severity === 'blocker').length;
  const warnings = risks.filter((risk) => risk.severity === 'warning').length;
  const info = risks.filter((risk) => risk.severity === 'info').length;
  const score = Math.max(0, 100 - blockers * 22 - warnings * 8 - info * 2);
  return { score, blockers, warnings, info, risk_count: risks.length };
}

function nextActionsFromRisks(risks) {
  return risks
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
    .slice(0, 8)
    .map((risk) => ({
      risk_id: risk.id,
      severity: risk.severity,
      action: risk.action
    }));
}

function severityRank(severity) {
  return { blocker: 0, warning: 1, info: 2 }[severity] ?? 3;
}

function repoFingerprint(root, files) {
  const hash = crypto.createHash('sha256');
  hash.update(slash(root));
  for (const file of files.map((item) => relative(root, item)).sort()) {
    hash.update('\n');
    hash.update(file);
  }
  return hash.digest('hex').slice(0, 16);
}

export async function runPremortem(options = {}) {
  const root = normalizeRoot(options.repo || options.root || '.');
  const rootExists = await exists(root);
  const generatedAt = nowIso();

  if (!rootExists) {
    const risks = [{
      id: 'repo-not-found',
      severity: 'blocker',
      title: 'Repository path does not exist',
      evidence: [root],
      action: 'Run the premortem from an existing agent repository or pass --repo <path>.'
    }];
    return {
      schema: 'agoragentic.premortem.v1',
      generated_at: generatedAt,
      root,
      summary: summarizeRisks(risks),
      risks,
      checks: risks.map((risk) => ({
        id: risk.id,
        title: risk.title,
        status: 'fail',
        evidence: risk.evidence,
        action: risk.action
      })),
      next_actions: nextActionsFromRisks(risks),
      no_spend: true
    };
  }

  const files = await walkFiles(root);
  const relFiles = files.map((file) => relative(root, file));
  const basenames = fileBasenames(files);
  const text = await readSearchableText(root, files);
  const packageJsonPath = path.join(root, 'package.json');
  const packageJson = await readJson(packageJsonPath);
  const pyproject = await exists(path.join(root, 'pyproject.toml'));
  const risks = [];
  const checks = [];

  if (hasFile(files, ['README.md', 'README.txt', 'readme.md'])) {
    addPass(checks, 'readme-present', 'README exists', ['README is present.']);
  } else {
    addRisk(risks, checks, {
      id: 'readme-missing',
      severity: 'blocker',
      title: 'No README found',
      evidence: ['Expected README.md or equivalent.'],
      action: 'Add a README with install, configuration, run, test, safety, and support instructions.'
    });
  }

  if (hasFile(files, ['LICENSE', 'LICENSE.md', 'COPYING'])) {
    addPass(checks, 'license-present', 'OSS license exists', ['License file is present.']);
  } else {
    addRisk(risks, checks, {
      id: 'license-missing',
      severity: 'blocker',
      title: 'OSS license is missing',
      evidence: ['Expected LICENSE, LICENSE.md, or COPYING.'],
      action: 'Add a clear OSS license before releasing the repository.'
    });
  }

  const installEvidence = [];
  if (packageJson) installEvidence.push('package.json');
  if (pyproject) installEvidence.push('pyproject.toml');
  if (basenames.has('requirements.txt')) installEvidence.push('requirements.txt');
  if (basenames.has('setup.py')) installEvidence.push('setup.py');
  if (basenames.has('dockerfile')) installEvidence.push('Dockerfile');
  if (installEvidence.length) {
    addPass(checks, 'install-contract-present', 'Install contract exists', installEvidence);
  } else {
    addRisk(risks, checks, {
      id: 'install-contract-missing',
      severity: 'blocker',
      title: 'Install contract is missing',
      evidence: ['No package.json, pyproject.toml, requirements.txt, setup.py, or Dockerfile found.'],
      action: 'Add one reproducible install path so a new owner or agent can set up the repo without guessing.'
    });
  }

  const testEvidence = [];
  if (packageJson?.scripts?.test) testEvidence.push('package.json scripts.test');
  if (hasPath(files, root, ['tests', 'test'])) testEvidence.push('tests/ or test/');
  if (hasPath(files, root, ['.github/workflows'])) testEvidence.push('.github/workflows');
  if (testEvidence.length) {
    addPass(checks, 'test-contract-present', 'Test contract exists', testEvidence);
  } else {
    addRisk(risks, checks, {
      id: 'test-contract-missing',
      severity: 'warning',
      title: 'No test contract found',
      evidence: ['No package test script, tests directory, or GitHub Actions workflow found.'],
      action: 'Add a no-spend smoke test that proves install, configuration, and one deterministic agent action.'
    });
  }

  const descriptorEvidence = relFiles.filter((file) => /(^|\/)(agent-card|agent|openapi|skill|mcp|manifest)\.(json|ya?ml|md)$/i.test(file));
  if (descriptorEvidence.length) {
    addPass(checks, 'agent-discovery-present', 'Agent discovery contract exists', descriptorEvidence.slice(0, 8));
  } else {
    addRisk(risks, checks, {
      id: 'agent-discovery-missing',
      severity: 'warning',
      title: 'Agent discovery contract is missing',
      evidence: ['Expected agent.json, agent-card.json, openapi.yaml/json, SKILL.md, MCP manifest, or equivalent.'],
      action: 'Add a small machine-readable agent descriptor with name, purpose, inputs, outputs, auth, and no-spend/paid boundaries.'
    });
  }

  const secretFindings = await scanSecrets(root, files);
  if (secretFindings.length) {
    addRisk(risks, checks, {
      id: 'secret-hygiene-failed',
      severity: 'blocker',
      title: 'Potential secrets are present in repository text',
      evidence: secretFindings.map((finding) => `${finding.file}:${finding.line} ${finding.label}`),
      action: 'Remove committed secrets, rotate exposed values, and replace them with placeholders in .env.example.'
    });
  } else {
    addPass(checks, 'secret-hygiene-clear', 'No obvious committed secrets found', ['Scanned text files without printing secret values.']);
  }

  const envEvidence = [];
  if (hasFile(files, ['.env.example', 'env.example', 'sample.env'])) envEvidence.push('.env.example or equivalent');
  if (includesAny(text, ['environment variable', 'env var', 'agoragentic_api_key', 'api key', 'configuration'])) {
    envEvidence.push('configuration docs');
  }
  if (envEvidence.length) {
    addPass(checks, 'configuration-contract-present', 'Configuration contract exists', unique(envEvidence));
  } else {
    addRisk(risks, checks, {
      id: 'configuration-contract-missing',
      severity: 'warning',
      title: 'Configuration contract is unclear',
      evidence: ['No .env.example or obvious configuration instructions found.'],
      action: 'Add .env.example plus docs for required and optional environment variables, including which calls can spend money.'
    });
  }

  if (includesAny(text, ['max_cost', 'budget', 'spend cap', 'approval', 'no-spend', 'no spend', 'paid execution', 'x402', 'usdc'])) {
    addPass(checks, 'spend-boundary-present', 'Spend boundary is documented', ['Budget, approval, no-spend, paid execution, x402, or USDC language found.']);
  } else {
    addRisk(risks, checks, {
      id: 'spend-boundary-missing',
      severity: 'warning',
      title: 'Spend boundary is not explicit',
      evidence: ['No obvious budget, approval, no-spend, paid execution, x402, or USDC language found.'],
      action: 'Document exactly which paths are free, which can spend, and which owner approval or environment gate is required before paid execution.'
    });
  }

  if (includesAny(text, ['receipt', 'invocation_id', 'trace id', 'trace_id', 'reconciliation', 'audit trail', 'proof'])) {
    addPass(checks, 'receipt-contract-present', 'Receipt or proof contract is documented', ['Receipt, invocation, trace, reconciliation, audit, or proof language found.']);
  } else {
    addRisk(risks, checks, {
      id: 'receipt-contract-missing',
      severity: 'warning',
      title: 'Receipt/proof contract is missing',
      evidence: ['No obvious receipt, invocation, trace, reconciliation, audit, or proof language found.'],
      action: 'Define what artifact proves the agent ran correctly: local receipt JSON, invocation ID, audit trail, or reconciliation record.'
    });
  }

  if (includesAny(text, ['health', '/health', 'ready', 'readiness', 'rollback', 'runbook', 'incident'])) {
    addPass(checks, 'runtime-operations-present', 'Runtime operations notes exist', ['Health, readiness, rollback, runbook, or incident language found.']);
  } else {
    addRisk(risks, checks, {
      id: 'runtime-operations-missing',
      severity: 'info',
      title: 'Runtime operations notes are thin',
      evidence: ['No obvious health, readiness, rollback, runbook, or incident language found.'],
      action: 'Add a short operations section covering health checks, rollback, support contact, and what to do after a failed run.'
    });
  }

  if (includesAny(text, ['agent os', 'execute(', 'execute(task', 'micro ecf', 'agoragentic'])) {
    addPass(checks, 'agoragentic-alignment-present', 'Agoragentic/Agent OS alignment is visible', ['Agent OS, execute(), Micro ECF, or Agoragentic language found.']);
  } else {
    addRisk(risks, checks, {
      id: 'agoragentic-alignment-missing',
      severity: 'info',
      title: 'Agoragentic alignment is not visible',
      evidence: ['No obvious Agent OS, execute(), Micro ECF, or Agoragentic language found.'],
      action: 'If this repo is meant to launch from Agoragentic, document the Agent OS handoff and prefer execute(task,input,constraints) for external work.'
    });
  }

  const summary = summarizeRisks(risks);
  return {
    schema: 'agoragentic.premortem.v1',
    generated_at: generatedAt,
    root,
    repo_fingerprint: repoFingerprint(root, files),
    summary,
    risks: risks.sort((a, b) => severityRank(a.severity) - severityRank(b.severity)),
    checks,
    next_actions: nextActionsFromRisks(risks),
    file_count_scanned: files.length,
    no_spend: true,
    boundary: {
      credentials_required: false,
      paid_execution: false,
      production_mutation: false
    }
  };
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 10000);
  const started = Date.now();
  try {
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'agoragentic-premortem-golden-loop/0.1'
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal
    });
    const contentType = response.headers.get('content-type') || '';
    const raw = await response.text();
    let body = raw;
    if (contentType.includes('application/json')) {
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        body = raw;
      }
    }
    return {
      ok: response.ok,
      status: response.status,
      elapsed_ms: Date.now() - started,
      content_type: contentType,
      body_shape: bodyShape(body)
    };
  } catch (err) {
    return {
      ok: false,
      status: null,
      elapsed_ms: Date.now() - started,
      error: err.name === 'AbortError' ? 'timeout' : err.message
    };
  } finally {
    clearTimeout(timeout);
  }
}

function bodyShape(body) {
  if (Array.isArray(body)) return { type: 'array', length: body.length };
  if (body && typeof body === 'object') return { type: 'object', keys: Object.keys(body).slice(0, 12) };
  if (typeof body === 'string') return { type: 'text', length: body.length };
  return { type: typeof body };
}

function stage(id, title, status, evidence = [], action = null) {
  return { id, title, status, evidence, action };
}

function stageSummary(stages) {
  return {
    pass: stages.filter((item) => item.status === 'pass').length,
    warn: stages.filter((item) => item.status === 'warn').length,
    fail: stages.filter((item) => item.status === 'fail').length,
    skip: stages.filter((item) => item.status === 'skip').length
  };
}

function findCheck(report, idPrefix) {
  return report.checks.find((check) => check.id.startsWith(idPrefix));
}

async function runPublicCanaries(baseUrl) {
  const cleanBase = String(baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
  const probes = [
    {
      id: 'discovery-check',
      title: 'Agoragentic public discovery self-test',
      url: `${cleanBase}/api/discovery/check`,
      method: 'GET',
      accept: [200]
    },
    {
      id: 'x402-info',
      title: 'x402 public info surface',
      url: `${cleanBase}/api/x402/info`,
      method: 'GET',
      accept: [200]
    },
    {
      id: 'x402-test-echo',
      title: 'Free x402 test echo surface',
      url: `${cleanBase}/api/x402/test/echo`,
      method: 'GET',
      accept: [200, 402]
    },
    {
      id: 'catalog-no-spend',
      title: 'No-spend catalog metadata surface',
      url: `${cleanBase}/api/catalog?spend_possible=false&auth=none`,
      method: 'GET',
      accept: [200]
    }
  ];

  const results = [];
  for (const probe of probes) {
    const response = await fetchWithTimeout(probe.url, { method: probe.method });
    const passed = response.status && probe.accept.includes(response.status);
    results.push({
      id: probe.id,
      title: probe.title,
      url: probe.url,
      method: probe.method,
      status: passed ? 'pass' : 'warn',
      http_status: response.status,
      elapsed_ms: response.elapsed_ms,
      evidence: response.error
        ? [`${probe.method} ${probe.url} failed: ${response.error}`]
        : [`${probe.method} ${probe.url} returned HTTP ${response.status}`],
      body_shape: response.body_shape
    });
  }
  return results;
}

async function runTargetChecks(targetUrl) {
  if (!targetUrl) return [];
  const clean = String(targetUrl).replace(/\/$/, '');
  const candidates = [
    clean,
    `${clean}/health`,
    `${clean}/.well-known/agent.json`,
    `${clean}/agent.json`,
    `${clean}/openapi.json`,
    `${clean}/openapi.yaml`
  ];
  const checks = [];
  for (const url of candidates) {
    const response = await fetchWithTimeout(url, { method: 'GET', timeoutMs: 8000 });
    checks.push({
      url,
      status: response.status && response.status < 500 ? 'pass' : 'warn',
      http_status: response.status,
      elapsed_ms: response.elapsed_ms,
      body_shape: response.body_shape,
      evidence: response.error ? [`GET ${url} failed: ${response.error}`] : [`GET ${url} returned HTTP ${response.status}`]
    });
  }
  return checks;
}

async function runDeclaredTests(root, enabled) {
  if (!enabled) {
    return stage(
      'declared-tests',
      'Declared repo tests',
      'skip',
      ['Skipped. Pass --run-tests to run package.json scripts.test with AGORAGENTIC_NO_SPEND=1.']
    );
  }

  const packageJson = await readJson(path.join(root, 'package.json'));
  if (!packageJson?.scripts?.test) {
    return stage(
      'declared-tests',
      'Declared repo tests',
      'skip',
      ['No package.json scripts.test found.']
    );
  }

  const testCommand = process.platform === 'win32'
    ? { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', 'npm test'] }
    : { command: 'npm', args: ['test'] };
  const result = await spawnForReceipt(testCommand.command, testCommand.args, {
    cwd: root,
    timeoutMs: 120000,
    env: sanitizeEnv({
      ...process.env,
      AGORAGENTIC_NO_SPEND: '1',
      AGORAGENTIC_ALLOW_REAL_SPEND: '0'
    })
  });

  return stage(
    'declared-tests',
    'Declared repo tests',
    result.exit_code === 0 ? 'pass' : 'fail',
    [
      `npm test exited ${result.exit_code}`,
      ...result.output_tail
    ],
    result.exit_code === 0 ? null : 'Fix the declared test suite before publishing the agent.'
  );
}

function spawnForReceipt(command, args, options) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (err) {
      resolve({ exit_code: 1, output_tail: [`spawn failed: ${err.message}`] });
      return;
    }
    const chunks = [];
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
    }, options.timeoutMs || 120000);
    child.stdout.on('data', (chunk) => chunks.push(String(chunk)));
    child.stderr.on('data', (chunk) => chunks.push(String(chunk)));
    child.on('error', (err) => {
      clearTimeout(timeout);
      resolve({ exit_code: 1, output_tail: [`spawn failed: ${err.message}`] });
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      const lines = chunks.join('').split(/\r?\n/).filter(Boolean).slice(-12);
      resolve({ exit_code: code ?? 1, output_tail: lines });
    });
  });
}

function sanitizeEnv(env) {
  return Object.fromEntries(
    Object.entries(env)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value).replace(/\0/g, '')])
  );
}

export async function runGoldenLoop(options = {}) {
  const root = normalizeRoot(options.repo || options.root || '.');
  const premortem = options.premortem || await runPremortem({ repo: root });
  const stages = [];

  const installCheck = findCheck(premortem, 'install-contract');
  stages.push(stage(
    'install-contract',
    'Install contract',
    installCheck?.status === 'pass' ? 'pass' : 'fail',
    installCheck?.evidence || [],
    installCheck?.status === 'pass' ? null : 'Add a reproducible install contract before release.'
  ));

  const configCheck = findCheck(premortem, 'configuration-contract');
  const secretCheck = findCheck(premortem, 'secret-hygiene');
  stages.push(stage(
    'configure-contract',
    'Configuration and secret boundary',
    configCheck?.status === 'pass' && secretCheck?.status === 'pass' ? 'pass' : 'warn',
    unique([...(configCheck?.evidence || []), ...(secretCheck?.evidence || [])]),
    configCheck?.status === 'pass' && secretCheck?.status === 'pass'
      ? null
      : 'Add .env.example/config docs and remove or rotate any committed secret-like values.'
  ));

  const discoveryCheck = findCheck(premortem, 'agent-discovery');
  stages.push(stage(
    'agent-discovery',
    'Agent discovery contract',
    discoveryCheck?.status === 'pass' ? 'pass' : 'warn',
    discoveryCheck?.evidence || [],
    discoveryCheck?.status === 'pass' ? null : 'Add agent.json, agent-card.json, SKILL.md, OpenAPI, MCP, or equivalent discovery metadata.'
  ));

  stages.push(stage(
    'premortem-risk',
    'Premortem risk gate',
    premortem.summary.blockers === 0 ? 'pass' : 'fail',
    [`${premortem.summary.blockers} blockers, ${premortem.summary.warnings} warnings, score ${premortem.summary.score}`],
    premortem.summary.blockers === 0 ? null : 'Resolve premortem blockers before release.'
  ));

  const receiptCheck = findCheck(premortem, 'receipt-contract');
  stages.push(stage(
    'receipt-contract',
    'Receipt and proof contract',
    receiptCheck?.status === 'pass' ? 'pass' : 'warn',
    receiptCheck?.evidence || [],
    receiptCheck?.status === 'pass' ? null : 'Define the local receipt or hosted invocation proof consumers can inspect after a run.'
  ));

  const spendCheck = findCheck(premortem, 'spend-boundary');
  stages.push(stage(
    'owner-spend-boundary',
    'Owner approval and spend boundary',
    spendCheck?.status === 'pass' ? 'pass' : 'warn',
    spendCheck?.evidence || [],
    spendCheck?.status === 'pass' ? null : 'Document no-spend defaults, paid execution gates, budgets, and owner approval requirements.'
  ));

  const runNetworkCanaries = Boolean(options.allowNetworkCanaries) && !options.skipNetwork;
  if (!runNetworkCanaries) {
    stages.push(stage(
      'public-no-spend-canaries',
      'Public no-spend Agoragentic canaries',
      'skip',
      [options.skipNetwork ? 'Skipped by --skip-network.' : 'Skipped by default. Pass --allow-network-canaries to call public no-spend endpoints without sending repo contents.']
    ));
  } else {
    const canaries = await runPublicCanaries(options.baseUrl || DEFAULT_BASE_URL);
    const failed = canaries.filter((item) => item.status !== 'pass');
    stages.push(stage(
      'public-no-spend-canaries',
      'Public no-spend Agoragentic canaries',
      failed.length ? 'warn' : 'pass',
      canaries.flatMap((item) => item.evidence),
      failed.length ? 'Check public connectivity before treating the loop as externally verifiable.' : null
    ));
    stages[stages.length - 1].canaries = canaries;
  }

  const targetChecks = await runTargetChecks(options.targetUrl);
  if (targetChecks.length) {
    const targetPass = targetChecks.some((item) => item.status === 'pass' && item.http_status && item.http_status < 400);
    stages.push(stage(
      'target-runtime',
      'Optional target runtime',
      targetPass ? 'pass' : 'warn',
      targetChecks.flatMap((item) => item.evidence),
      targetPass ? null : 'Expose a health endpoint or discovery document at the target runtime URL.'
    ));
    stages[stages.length - 1].target_checks = targetChecks;
  } else {
    stages.push(stage(
      'target-runtime',
      'Optional target runtime',
      'skip',
      ['No --target-url provided.']
    ));
  }

  stages.push(await runDeclaredTests(root, Boolean(options.runTests)));

  const summary = stageSummary(stages);
  const generatedAt = nowIso();
  return {
    schema: 'agoragentic.golden-loop.no-spend.v1',
    generated_at: generatedAt,
    root,
    target_url: options.targetUrl || null,
    summary,
    stages,
    pass: summary.fail === 0,
    no_spend: true,
    boundary: {
      free_to_use: true,
      local_artifacts_only: !runNetworkCanaries && !options.targetUrl,
      network_calls: runNetworkCanaries || Boolean(options.targetUrl),
      repo_contents_uploaded: false,
      credentials_required: false,
      paid_execution: false,
      production_mutation: false,
      real_usdc_transfer: false
    }
  };
}

export async function runAll(options = {}) {
  const root = normalizeRoot(options.repo || options.root || '.');
  const premortem = await runPremortem({ repo: root });
  const goldenLoop = await runGoldenLoop({ ...options, repo: root, premortem });
  const receipt = buildLocalReceipt({ root, premortem, goldenLoop });
  return { premortem, golden_loop: goldenLoop, receipt };
}

export async function runHeal(options = {}) {
  const root = normalizeRoot(options.repo || options.root || '.');
  const before = await runAll({ ...options, repo: root, skipNetwork: true });
  const plan = await buildHealingPlan({ root, premortem: before.premortem, goldenLoop: before.golden_loop });
  const applied = options.applySafeFixes ? await applyHealingPlan(root, plan) : [];
  const after = options.applySafeFixes
    ? await runAll({ ...options, repo: root, skipNetwork: true })
    : null;

  return {
    schema: 'agoragentic.premortem-golden-loop.heal.v1',
    generated_at: nowIso(),
    root,
    mode: options.applySafeFixes ? 'apply_safe_fixes' : 'plan_only',
    free_to_use: true,
    privacy: LOCAL_PRIVACY_BOUNDARY,
    before,
    plan,
    applied,
    after,
    boundary: {
      local_only: true,
      network_calls: false,
      credentials_required: false,
      paid_execution: false,
      production_mutation: false,
      code_rewrite: false,
      destructive_changes: false
    }
  };
}

const LOCAL_PRIVACY_BOUNDARY = {
  default_network: false,
  data_sent_anywhere: false,
  repo_contents_uploaded: false,
  api_key_required: false,
  cost_usdc: 0,
  note: 'Default heal/run/session modes read local files and write local artifacts only. Public no-spend canaries run only when the caller explicitly opts in.'
};

async function buildHealingPlan({ root, premortem, goldenLoop }) {
  const files = await walkFiles(root, { maxFiles: 2500 });
  const rels = new Set(files.map((file) => relative(root, file).toLowerCase()));
  const packageJson = await readJson(path.join(root, 'package.json'));
  const projectName = packageJson?.name || path.basename(root);
  const actions = [];

  const addCreate = (id, target, title, reason, content) => {
    if (rels.has(slash(target).toLowerCase())) {
      actions.push({
        id,
        type: 'skip_existing',
        target,
        title,
        reason: `${target} already exists.`
      });
      return;
    }
    actions.push({
      id,
      type: 'create_file',
      target,
      title,
      reason,
      content
    });
  };

  addCreate(
    'goals-doc',
    'docs/AGORAGENTIC_GOALS.md',
    'Create goals contract',
    'Every self-testing agent needs explicit goals, non-goals, success signals, and owner review checkpoints.',
    renderGoalsDoc({ projectName })
  );
  addCreate(
    'workflows-doc',
    'docs/AGORAGENTIC_WORKFLOWS.md',
    'Create workflows contract',
    'The agent should give users repeatable local workflows for premortem, self-test, self-heal, release, and Agent OS handoff.',
    renderWorkflowsDoc({ projectName })
  );
  addCreate(
    'safety-boundaries-doc',
    'docs/AGORAGENTIC_SAFETY_BOUNDARIES.md',
    'Create safety boundaries contract',
    'Users need a direct statement that default runs are free, local, no-network, no-spend, and non-mutating unless explicitly approved.',
    renderSafetyBoundariesDoc({ projectName })
  );

  if (premortem.checks.some((check) => check.id.startsWith('agent-discovery') && check.status !== 'pass')) {
    addCreate(
      'agent-descriptor',
      'agent.json',
      'Create local agent descriptor',
      'Machine-readable agent metadata helps humans and agent runtimes understand purpose, inputs, outputs, and authority boundaries.',
      `${JSON.stringify(buildAgentDescriptor(projectName), null, 2)}\n`
    );
  }

  if (premortem.checks.some((check) => check.id.startsWith('configuration-contract') && check.status !== 'pass')) {
    addCreate(
      'env-example',
      '.env.example',
      'Create local environment example',
      'Configuration should be explicit even when no credentials are required by default.',
      renderEnvExample()
    );
  }

  if (premortem.checks.some((check) => check.id.startsWith('test-contract') && check.status !== 'pass')) {
    addCreate(
      'ci-workflow',
      '.github/workflows/agoragentic-premortem-golden-loop.yml',
      'Create no-spend CI workflow',
      'A repeatable self-test loop makes release readiness visible on every push without credentials or paid calls.',
      renderGithubWorkflow()
    );
  }

  const manual = [];
  if (premortem.risks.some((risk) => risk.id === 'secret-hygiene-failed')) {
    manual.push({
      id: 'rotate-secrets',
      title: 'Remove and rotate committed secrets',
      reason: 'The agent will not edit or delete secret-bearing files automatically.',
      action: 'Remove the secret manually, rotate it with the provider, then rerun heal.'
    });
  }
  if (premortem.risks.some((risk) => risk.id === 'license-missing')) {
    manual.push({
      id: 'choose-license',
      title: 'Choose an OSS license',
      reason: 'License choice is a project decision.',
      action: 'Add LICENSE with the license the owner wants before public release.'
    });
  }

  return {
    summary: {
      proposed_file_creates: actions.filter((action) => action.type === 'create_file').length,
      skipped_existing: actions.filter((action) => action.type === 'skip_existing').length,
      manual_actions: manual.length,
      golden_loop_pass_before: goldenLoop.pass,
      blockers_before: premortem.summary.blockers
    },
    actions,
    manual,
    safety: {
      applies_only_when_flagged: '--apply-safe-fixes',
      writes_only_new_files: true,
      overwrites_existing_files: false,
      deletes_files: false,
      edits_application_code: false,
      sends_data: false,
      costs_money: false
    }
  };
}

async function applyHealingPlan(root, plan) {
  const applied = [];
  for (const action of plan.actions) {
    if (action.type !== 'create_file') continue;
    const full = path.resolve(root, action.target);
    if (!isInside(root, full)) {
      applied.push({ ...action, status: 'blocked', reason: 'Target path escapes repo root.' });
      continue;
    }
    if (await exists(full)) {
      applied.push({ ...action, status: 'skipped_existing' });
      continue;
    }
    await writeText(full, action.content);
    applied.push({ id: action.id, target: action.target, status: 'created' });
  }
  return applied;
}

function isInside(root, target) {
  const relativePath = path.relative(root, target);
  return relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

function buildAgentDescriptor(projectName) {
  return {
    schema: 'agoragentic.local-agent.v1',
    name: projectName,
    description: 'Local AI agent prepared with Agoragentic Premortem Golden Loop.',
    free_to_use: true,
    default_boundary: {
      local_only: true,
      network_calls: false,
      credentials_required: false,
      paid_execution: false,
      production_mutation: false,
      repo_contents_uploaded: false
    },
    workflows: [
      'premortem',
      'self-test',
      'self-heal-plan',
      'golden-loop-readiness'
    ],
    artifacts: [
      '.agoragentic/premortem-golden-loop/premortem.json',
      '.agoragentic/premortem-golden-loop/golden-loop.json',
      '.agoragentic/premortem-golden-loop/local-receipt.json',
      '.agoragentic/premortem-golden-loop/healing-plan.json'
    ]
  };
}

function renderGoalsDoc({ projectName }) {
  return `# Agoragentic Goals

Project: ${projectName}

## Primary Goal

Make the agent safe to install, inspect, test, and improve locally before any hosted deployment, paid execution, marketplace exposure, or x402 monetization.

## Success Signals

- A new user can run the local premortem and Golden Loop readiness check from a clean checkout.
- The run produces local receipts under \`.agoragentic/premortem-golden-loop/\`.
- The user can see exactly what passed, what failed, and what changed.
- Any self-healing change is additive, reviewable, and made only after explicit approval.

## Non-Goals

- No autonomous deployment.
- No wallet funding or USDC transfer.
- No paid \`execute()\` call.
- No secret rotation on the user's behalf.
- No upload of repo contents, prompts, plans, receipts, or code.

## Owner Review Checkpoints

- Before applying generated fixes.
- Before enabling network canaries.
- Before connecting Agent OS, Micro ECF, x402, or marketplace flows.
- Before publishing any generated report publicly.
`;
}

function renderWorkflowsDoc({ projectName }) {
  return `# Agoragentic Workflows

Project: ${projectName}

## 1. Premortem Session

\`\`\`bash
npx agoragentic-premortem-golden-loop session \\
  --plan "Describe the launch or decision" \\
  --audience "Who this is for" \\
  --success "What a win looks like"
\`\`\`

Output: HTML report, Markdown transcript, and JSON session artifact.

## 2. Local Self-Test

\`\`\`bash
npx agoragentic-premortem-golden-loop run --repo . --ci --skip-network
\`\`\`

Output: premortem audit, no-spend Golden Loop readiness report, and local receipt.

## 3. Self-Heal Plan

\`\`\`bash
npx agoragentic-premortem-golden-loop heal --repo .
\`\`\`

Output: proposed safe fixes only. No files are changed.

## 4. Apply Safe Fixes

\`\`\`bash
npx agoragentic-premortem-golden-loop heal --repo . --apply-safe-fixes
\`\`\`

Only additive docs, metadata, env examples, or CI scaffolds are created. Existing files are not overwritten.

## 5. Optional Public No-Spend Canaries

\`\`\`bash
npx agoragentic-premortem-golden-loop run --repo . --allow-network-canaries
\`\`\`

This calls public Agoragentic no-spend endpoints. It does not send repository contents.

## 6. Agent OS Handoff

Use Agent OS or Micro ECF only after local readiness is clean and the owner approves. Hosted deployment, wallet funding, marketplace publication, x402 monetization, and paid execution are separate explicit steps.
`;
}

function renderSafetyBoundariesDoc({ projectName }) {
  return `# Agoragentic Safety Boundaries

Project: ${projectName}

## Default Boundary

- Free to use.
- Local file reads only.
- Local artifact writes only.
- No API key required.
- No wallet required.
- No network calls by default.
- No repository contents, business plans, prompts, or receipts are sent anywhere.
- No paid execution.
- No production mutation.
- No deployment.
- No marketplace publication.

## What Self-Heal May Do

Only when \`--apply-safe-fixes\` is passed, the agent may create missing additive scaffolds:

- \`docs/AGORAGENTIC_GOALS.md\`
- \`docs/AGORAGENTIC_WORKFLOWS.md\`
- \`docs/AGORAGENTIC_SAFETY_BOUNDARIES.md\`
- \`agent.json\`
- \`.env.example\`
- \`.github/workflows/agoragentic-premortem-golden-loop.yml\`

It does not overwrite existing files.

## What Self-Heal Will Not Do

- It will not edit application source code.
- It will not delete files.
- It will not remove secrets automatically.
- It will not rotate credentials.
- It will not install dependencies without the user's own package manager command.
- It will not run paid \`execute()\` calls.
- It will not transfer USDC or sign wallet payments.
- It will not publish to Agent OS, a marketplace, npm, PyPI, or GitHub.

## Optional Network Canaries

\`--allow-network-canaries\` calls only public no-spend Agoragentic endpoints and sends no repo content. Keep it off for fully offline runs.
`;
}

function renderEnvExample() {
  return `# Agoragentic Premortem Golden Loop defaults
AGORAGENTIC_NO_SPEND=1
AGORAGENTIC_ALLOW_REAL_SPEND=0
AGORAGENTIC_ALLOW_NETWORK_CANARIES=0

# Optional only if this repo later uses hosted Agent OS APIs.
AGORAGENTIC_API_KEY=amk_your_key
`;
}

function renderGithubWorkflow() {
  return `name: Agoragentic Premortem Golden Loop

on:
  pull_request:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  local-readiness:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    env:
      AGORAGENTIC_NO_SPEND: "1"
      AGORAGENTIC_ALLOW_REAL_SPEND: "0"
      AGORAGENTIC_ALLOW_NETWORK_CANARIES: "0"
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - name: Run local no-spend readiness
        run: npx --yes agoragentic-premortem-golden-loop run --repo . --ci --skip-network
`;
}

export function renderHealingPlanMarkdown(report) {
  const lines = [
    '# Agoragentic Self-Heal Plan',
    '',
    `Generated: ${report.generated_at}`,
    `Repository: ${report.root}`,
    `Mode: ${report.mode}`,
    '',
    '## Privacy Boundary',
    '',
    '- Free to use',
    '- No API key required',
    '- No network calls in heal mode',
    '- No repo contents uploaded',
    '- No paid execution or wallet action',
    '',
    '## Proposed Safe Fixes',
    '',
    '| Action | Target | Status | Reason |',
    '|---|---|---|---|'
  ];

  for (const action of report.plan.actions) {
    lines.push(`| ${escapeMd(action.title)} | ${escapeMd(action.target)} | ${action.type} | ${escapeMd(action.reason)} |`);
  }

  lines.push('', '## Manual Actions', '');
  if (!report.plan.manual.length) {
    lines.push('- None.');
  } else {
    for (const item of report.plan.manual) lines.push(`- ${item.title}: ${item.action}`);
  }

  if (report.applied.length) {
    lines.push('', '## Applied', '');
    for (const item of report.applied) lines.push(`- ${item.status}: ${item.target}`);
  }

  lines.push('');
  return `${lines.join('\n')}\n`;
}

export async function runPremortemSession(options = {}) {
  const root = normalizeRoot(options.repo || options.root || '.');
  const generatedAt = nowIso();
  const timestamp = timestampSlug(generatedAt);
  const context = await buildPremortemContext({ ...options, root });

  if (!context.sufficient) {
    return {
      schema: 'agoragentic.premortem-session.v1',
      generated_at: generatedAt,
      timestamp,
      status: 'needs_context',
      root,
      context,
      question: nextContextQuestion(context.missing),
      no_spend: true
    };
  }

  const frame = `It is 6 months from now. ${context.what} has failed. It is done. We are looking back and trying to understand what went wrong.`;
  const failureReasons = generateFailureReasons(context);
  const deepDives = await Promise.all(
    failureReasons.map((reason, index) => analyzeFailureReason(context, reason, index))
  );
  const synthesis = synthesizePremortem(context, failureReasons, deepDives);

  return {
    schema: 'agoragentic.premortem-session.v1',
    generated_at: generatedAt,
    timestamp,
    status: 'complete',
    root,
    context,
    frame,
    failure_reasons: failureReasons,
    investigator_pass: {
      mode: 'local_parallel_investigator_pass',
      agent_count: deepDives.length,
      note: 'Each failure reason is analyzed independently through the same investigator contract. Hosted or model-backed runners can replace this deterministic pass with parallel sub-agents.'
    },
    deep_dives: deepDives,
    synthesis,
    no_spend: true,
    boundary: {
      credentials_required: false,
      paid_execution: false,
      production_mutation: false
    }
  };
}

async function buildPremortemContext(options) {
  const root = options.root;
  const planFileText = options.planFile ? await readText(path.resolve(root, options.planFile)).catch(() => '') : '';
  const explicitPlan = String(options.plan || '').trim();
  const workspace = await collectWorkspaceContext(root);
  const combined = [explicitPlan, planFileText, workspace.map((item) => item.excerpt).join('\n')].filter(Boolean).join('\n\n');
  const what = explicitPlan || firstNonEmptyLine(planFileText) || inferWhat(combined);
  const who = String(options.audience || '').trim() || inferAudience(combined);
  const success = String(options.success || '').trim() || inferSuccess(combined);
  const missing = [];
  if (!what) missing.push('what');
  if (!who) missing.push('who');
  if (!success) missing.push('success');

  return {
    what,
    who,
    success,
    plan_text: combined.trim(),
    workspace_context: workspace,
    sufficient: missing.length === 0,
    missing
  };
}

async function collectWorkspaceContext(root) {
  const preferred = [
    'CLAUDE.md',
    'claude.md',
    'AGENTS.md',
    'README.md',
    'START_HERE.md'
  ];
  const snippets = [];

  for (const rel of preferred) {
    const full = path.join(root, rel);
    if (await exists(full)) {
      const text = await readText(full).catch(() => '');
      if (text.trim()) snippets.push({ file: slash(rel), excerpt: excerpt(text, 1800) });
    }
  }

  const files = await walkFiles(root, { maxFiles: 800 });
  const candidates = files
    .map((file) => relative(root, file))
    .filter((rel) => /(^|\/)(memory|docs|plans?|briefs?|strategy|launch|prd)(\/|$)|premortem|plan|brief|strategy|launch|product|roadmap/i.test(rel))
    .filter((rel) => TEXT_EXTENSIONS.has(path.extname(rel).toLowerCase()))
    .slice(0, 8);

  for (const rel of candidates) {
    if (snippets.some((item) => item.file.toLowerCase() === rel.toLowerCase())) continue;
    const full = path.join(root, rel);
    const stat = await statSafe(full);
    if (!stat || stat.size > 250_000) continue;
    const text = await readText(full).catch(() => '');
    if (text.trim()) snippets.push({ file: slash(rel), excerpt: excerpt(text, 1200) });
    if (snippets.length >= 10) break;
  }

  return snippets;
}

function firstNonEmptyLine(text) {
  return String(text || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
}

function excerpt(text, maxChars) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

function inferWhat(text) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const useful = lines.find((line) => /launch|build|release|ship|plan|strategy|product|agent|repo|workshop|pricing|hire/i.test(line));
  return useful ? useful.replace(/^#+\s*/, '').slice(0, 220) : '';
}

function inferAudience(text) {
  const source = String(text || '');
  const patterns = [
    /\btarget(?:ing)?\s+([^.\n]{8,120})/i,
    /\bfor\s+([^.\n]{8,120})/i,
    /\baudience\s*[:=-]\s*([^.\n]{8,120})/i,
    /\bcustomer(?:s)?\s*[:=-]\s*([^.\n]{8,120})/i
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match?.[1]) return cleanInference(match[1]);
  }
  return '';
}

function inferSuccess(text) {
  const source = String(text || '');
  const patterns = [
    /\bsuccess(?:\s+looks\s+like)?\s*[:=-]\s*([^.\n]{8,160})/i,
    /\bwin(?:\s+looks\s+like)?\s*[:=-]\s*([^.\n]{8,160})/i,
    /\bgoal\s*[:=-]\s*([^.\n]{8,160})/i,
    /\bso that\s+([^.\n]{8,160})/i
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match?.[1]) return cleanInference(match[1]);
  }
  return '';
}

function cleanInference(value) {
  return String(value || '').replace(/[`*_#]/g, '').trim().slice(0, 180);
}

function nextContextQuestion(missing) {
  if (missing.includes('what')) return 'What specifically are you about to launch, build, decide, or release?';
  if (missing.includes('who')) return 'Who is this for, and who will be affected if it fails?';
  if (missing.includes('success')) return 'What does a win look like for this?';
  return 'What context should this premortem use?';
}

function generateFailureReasons(context) {
  const text = `${context.what}\n${context.who}\n${context.success}\n${context.plan_text}`.toLowerCase();
  const candidates = [
    {
      id: 'audience-mismatch',
      reason: `${context.who} did not behave like the plan assumed, so the offer landed with people adjacent to the target user instead of the people who could make ${context.success} happen.`,
      assumption: `The target audience is reachable, self-identifies with this problem, and has enough urgency to act now.`,
      warning_signs: ['Interested replies come from adjacent users who are not the intended buyer or operator.', 'People praise the idea but cannot name when they would install, buy, or use it.'],
      revision: 'Run a small target-user pilot first and only scale the release once the actual buyers match the intended audience.',
      likelihood: 5,
      severity: 4
    },
    {
      id: 'distribution-gap',
      reason: `The release shipped, but the distribution plan was too passive; a GitHub repo or launch post did not create repeated qualified installs from ${context.who}.`,
      assumption: `Publishing the artifact is close enough to distribution.`,
      warning_signs: ['Stars or likes arrive without installs, issues, forks, receipts, or repeat runs.', 'Most traffic comes from one launch spike and disappears inside two weeks.'],
      revision: 'Define three repeatable distribution loops before launch: one community channel, one partner/user workflow, and one machine-readable discovery path.',
      likelihood: 4,
      severity: 4
    },
    {
      id: 'onboarding-friction',
      reason: `People installed it and stalled before the first successful run because setup, context gathering, or output expectations were not obvious enough for a fresh repo owner.`,
      assumption: `A motivated user will debug the setup path and infer the intended workflow.`,
      warning_signs: ['Issues ask basic install or first-run questions already covered in the README.', 'Users run the CLI once but no generated report or receipt appears.'],
      revision: 'Make the first-run path one command, no credentials by default, with a sample fixture and expected output committed in docs.',
      likelihood: text.includes('repo') || text.includes('install') || text.includes('github') ? 5 : 3,
      severity: 4
    },
    {
      id: 'proof-gap',
      reason: `The Golden Loop claim was not credible to users because the local report looked like analysis, not proof that the agent could install, run, produce receipts, and stay inside a no-spend boundary.`,
      assumption: `Users will trust the workflow without a concrete artifact trail.`,
      warning_signs: ['Users ask whether the report is just generated text.', 'Maintainers cannot point to a receipt, transcript, or reproducible check for a specific release.'],
      revision: 'Treat the local receipt, transcript, and no-spend canary output as release artifacts and publish them with every tagged release.',
      likelihood: text.includes('golden loop') || text.includes('receipt') || text.includes('agent') ? 5 : 3,
      severity: 5
    },
    {
      id: 'scope-sprawl',
      reason: `The project tried to be a premortem agent, release auditor, Golden Loop tester, and launch package at once, so none of the workflows felt sharp enough to become habitual.`,
      assumption: `More adjacent safety features will make the product clearer instead of harder to understand.`,
      warning_signs: ['The README keeps growing but the primary command is still hard to explain in one sentence.', 'Users ask which mode they are supposed to run first.'],
      revision: 'Separate the public story into two commands: decision premortem for plans, and Golden Loop readiness for installable agent repos.',
      likelihood: text.includes('premortem') && text.includes('golden loop') ? 5 : 3,
      severity: 3
    },
    {
      id: 'trust-safety',
      reason: `The agent scared off serious users because it touched repo files, scanned secrets, or discussed paid execution without making the authority boundary unmistakable.`,
      assumption: `Users will read the safety notes before deciding whether to run it.`,
      warning_signs: ['Security-minded users ask what leaves their machine.', 'People avoid running it on real repos until someone audits the behavior.'],
      revision: 'Keep no-spend/no-network defaults visible in the command output and document exactly what is read, written, and never transmitted.',
      likelihood: text.includes('secret') || text.includes('paid') || text.includes('wallet') || text.includes('usdc') ? 4 : 3,
      severity: 5
    },
    {
      id: 'maintenance-drag',
      reason: `After the launch, the agent became a maintenance surface without a clear owner: prompts drifted, report quality varied, and compatibility issues accumulated faster than usage proof.`,
      assumption: `The first release will be stable enough that maintenance can wait.`,
      warning_signs: ['Small issues linger for more than a week.', 'Prompt updates happen without tests that prove the output shape still works.'],
      revision: 'Add output-shape tests, fixture premortems, and a release checklist before inviting broad public usage.',
      likelihood: 3,
      severity: 4
    },
    {
      id: 'success-metric-drift',
      reason: `The team celebrated visible activity while missing ${context.success}, so the project looked alive while failing its actual purpose.`,
      assumption: `Early attention is a reliable proxy for the outcome that matters.`,
      warning_signs: ['The dashboard tracks stars, posts, or comments but not completed runs and acted-on revisions.', 'Users read reports but do not change their plans.'],
      revision: 'Define success as completed premortems with at least one concrete plan revision, not impressions or repository stars.',
      likelihood: 4,
      severity: 4
    }
  ];

  const selected = candidates
    .filter((item) => {
      if (['audience-mismatch', 'distribution-gap', 'success-metric-drift'].includes(item.id)) return true;
      if (item.id === 'onboarding-friction') return /repo|install|github|cli|agent|oss|open source/.test(text);
      if (item.id === 'proof-gap') return /golden loop|receipt|proof|agent|test/.test(text);
      if (item.id === 'scope-sprawl') return /premortem|golden loop|agent|oss/.test(text);
      if (item.id === 'trust-safety') return /secret|paid|wallet|usdc|api key|repo|agent/.test(text);
      if (item.id === 'maintenance-drag') return /oss|open source|github|repo|package|agent/.test(text);
      return false;
    })
    .slice(0, 8);

  return selected.map((item, index) => ({
    ...item,
    rank: index + 1,
    accent: ['#7dd3fc', '#fca5a5', '#c4b5fd', '#86efac', '#fcd34d', '#f9a8d4', '#93c5fd', '#fdba74'][index % 8]
  }));
}

async function analyzeFailureReason(context, reason, index) {
  const moments = [
    `At launch, the team framed ${context.what} around the intended outcome: ${context.success}. The first signal looked encouraging, but the behavior underneath did not match the plan.`,
    `${context.who} hit the exact weak point: ${reason.reason} The team adjusted messaging and docs after the fact, but by then the first cohort had already formed the wrong impression.`,
    `By month six, the failure was no longer a single bug or missed announcement. It was a pattern: the plan depended on "${reason.assumption}", and the evidence kept saying that assumption was false.`
  ];

  return {
    id: reason.id,
    agent_id: `investigator-${String(index + 1).padStart(2, '0')}`,
    failure_reason: reason.reason,
    likelihood: reason.likelihood,
    severity: reason.severity,
    failure_story: `${moments[0]}\n\n${moments[1]} ${moments[2]}`,
    underlying_assumption: reason.assumption,
    early_warning_signs: reason.warning_signs,
    concrete_revision: reason.revision,
    accent: reason.accent
  };
}

function synthesizePremortem(context, reasons, deepDives) {
  const mostLikely = [...deepDives].sort((a, b) => b.likelihood - a.likelihood || b.severity - a.severity)[0];
  const mostDangerous = [...deepDives].sort((a, b) => b.severity - a.severity || b.likelihood - a.likelihood)[0];
  const hiddenAssumption = `The hidden assumption is that ${context.who} will understand the value, trust the boundary, complete the first run, and convert the output into action without a tighter launch loop proving each step.`;
  const revisedPlan = deepDives
    .slice()
    .sort((a, b) => (b.likelihood + b.severity) - (a.likelihood + a.severity))
    .slice(0, 6)
    .map((item) => ({
      failure_id: item.id,
      change: item.concrete_revision
    }));
  const checklist = [
    `Describe the target user and success metric in one sentence: "${context.who}" and "${context.success}".`,
    'Run one end-to-end first-use test from a clean checkout and preserve the generated receipt.',
    'Publish the no-spend boundary beside the install command, including what is read, written, and never transmitted.',
    'Test distribution with at least five real target users before treating public launch attention as validation.',
    'Require every release to include a premortem transcript, report, and one concrete plan revision.'
  ];

  return {
    most_likely_failure: {
      id: mostLikely.id,
      title: mostLikely.failure_reason,
      why: `It has the highest likelihood because it can happen even if the build succeeds: the intended users simply do not behave the way the plan needs them to.`
    },
    most_dangerous_failure: {
      id: mostDangerous.id,
      title: mostDangerous.failure_reason,
      why: `It is the most damaging because it undermines trust in the whole release, not just one feature or launch channel.`
    },
    hidden_assumption: hiddenAssumption,
    revised_plan: revisedPlan,
    pre_launch_checklist: checklist,
    chat_summary: [
      `Most likely failure: ${mostLikely.failure_reason}`,
      `Hidden assumption: ${hiddenAssumption}`,
      `Most important revision: ${revisedPlan[0]?.change || 'Run a narrow pilot before the public release.'}`
    ]
  };
}

export function renderPremortemSessionHtml(session) {
  const cards = session.deep_dives.map((item) => `
    <article class="card" style="--accent:${escapeHtml(item.accent)}">
      <div class="card-top">
        <span>${escapeHtml(item.agent_id)}</span>
        <span>L${item.likelihood} / S${item.severity}</span>
      </div>
      <h3>${escapeHtml(item.failure_reason)}</h3>
      <p>${escapeHtml(item.failure_story).replace(/\n\n/g, '</p><p>')}</p>
      <div class="minor"><strong>Underlying assumption:</strong> ${escapeHtml(item.underlying_assumption)}</div>
      <ul>${item.early_warning_signs.map((sign) => `<li>${escapeHtml(sign)}</li>`).join('')}</ul>
    </article>
  `).join('\n');

  const revisions = session.synthesis.revised_plan.map((item) => `<li><strong>${escapeHtml(item.failure_id)}:</strong> ${escapeHtml(item.change)}</li>`).join('');
  const checklist = session.synthesis.pre_launch_checklist.map((item) => `<li>${escapeHtml(item)}</li>`).join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Premortem Report</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #0a0e1a; color: #e5ecff; }
    main { max-width: 1180px; margin: 0 auto; padding: 40px 20px 56px; }
    h1, h2, h3 { margin: 0; line-height: 1.1; letter-spacing: 0; }
    h1 { font-size: clamp(32px, 5vw, 58px); max-width: 920px; }
    h2 { font-size: 22px; margin-bottom: 14px; }
    h3 { font-size: 18px; margin: 14px 0 10px; }
    p, li { color: #c9d4ef; line-height: 1.55; }
    .eyebrow { color: #7dd3fc; text-transform: uppercase; font-size: 12px; letter-spacing: .08em; font-weight: 700; }
    .hero { border-bottom: 1px solid #22304f; padding-bottom: 28px; margin-bottom: 28px; }
    .meta { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 22px; }
    .pill { border: 1px solid #2d3c61; border-radius: 999px; padding: 8px 12px; color: #b8c5e6; background: #11182a; font-size: 13px; }
    .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
    .panel, .card { background: #101827; border: 1px solid #24304e; border-radius: 8px; padding: 18px; }
    .panel strong { color: #ffffff; }
    .synthesis { grid-template-columns: repeat(2, minmax(0, 1fr)); margin-bottom: 28px; }
    .wide { grid-column: 1 / -1; }
    .card { border-top: 4px solid var(--accent); }
    .card-top { display: flex; justify-content: space-between; gap: 12px; color: var(--accent); font-size: 12px; font-weight: 700; text-transform: uppercase; }
    .minor { border-left: 3px solid var(--accent); padding-left: 12px; color: #dbe6ff; margin: 14px 0; }
    footer { margin-top: 34px; color: #7f8cad; font-size: 13px; }
    @media (max-width: 860px) { .grid, .synthesis { grid-template-columns: 1fr; } main { padding: 28px 14px 40px; } }
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <div class="eyebrow">Premortem Report</div>
      <h1>${escapeHtml(session.context.what)}</h1>
      <div class="meta">
        <span class="pill">${escapeHtml(session.generated_at)}</span>
        <span class="pill">${session.investigator_pass.agent_count} investigators</span>
        <span class="pill">No-spend local analysis</span>
      </div>
    </section>

    <section class="grid synthesis">
      <div class="panel"><h2>Most Likely Failure</h2><p><strong>${escapeHtml(session.synthesis.most_likely_failure.title)}</strong></p><p>${escapeHtml(session.synthesis.most_likely_failure.why)}</p></div>
      <div class="panel"><h2>Most Dangerous Failure</h2><p><strong>${escapeHtml(session.synthesis.most_dangerous_failure.title)}</strong></p><p>${escapeHtml(session.synthesis.most_dangerous_failure.why)}</p></div>
      <div class="panel wide"><h2>Hidden Assumption</h2><p>${escapeHtml(session.synthesis.hidden_assumption)}</p></div>
      <div class="panel"><h2>Revised Plan</h2><ol>${revisions}</ol></div>
      <div class="panel"><h2>Pre-Launch Checklist</h2><ol>${checklist}</ol></div>
    </section>

    <section>
      <h2>Investigator Findings</h2>
      <div class="grid">${cards}</div>
    </section>

    <footer>Premortem generated for ${escapeHtml(session.context.what)}. Audience: ${escapeHtml(session.context.who)}. Success: ${escapeHtml(session.context.success)}.</footer>
  </main>
</body>
</html>
`;
}

export function renderPremortemSessionTranscript(session) {
  const lines = [
    '# Premortem Transcript',
    '',
    `Generated: ${session.generated_at}`,
    '',
    '## Context',
    '',
    `What: ${session.context.what}`,
    `Who: ${session.context.who}`,
    `Success: ${session.context.success}`,
    '',
    '## Frame',
    '',
    session.frame,
    '',
    '## Raw Failure Reasons',
    ''
  ];

  for (const reason of session.failure_reasons) {
    lines.push(`${reason.rank}. ${reason.reason}`);
  }

  lines.push('', '## Deep Dives', '');
  for (const dive of session.deep_dives) {
    lines.push(`### ${dive.agent_id}: ${dive.failure_reason}`, '');
    lines.push('Failure story:', '', dive.failure_story, '');
    lines.push(`Underlying assumption: ${dive.underlying_assumption}`, '');
    lines.push('Early warning signs:');
    for (const sign of dive.early_warning_signs) lines.push(`- ${sign}`);
    lines.push('');
  }

  lines.push('## Synthesis', '');
  lines.push(`Most likely failure: ${session.synthesis.most_likely_failure.title}`);
  lines.push(`Why: ${session.synthesis.most_likely_failure.why}`, '');
  lines.push(`Most dangerous failure: ${session.synthesis.most_dangerous_failure.title}`);
  lines.push(`Why: ${session.synthesis.most_dangerous_failure.why}`, '');
  lines.push(`Hidden assumption: ${session.synthesis.hidden_assumption}`, '');
  lines.push('Revised plan:');
  for (const item of session.synthesis.revised_plan) lines.push(`- ${item.change}`);
  lines.push('', 'Pre-launch checklist:');
  for (const item of session.synthesis.pre_launch_checklist) lines.push(`- ${item}`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

export function renderPremortemSessionSummary(session) {
  return session.synthesis.chat_summary.join(' ');
}

export function premortemSessionFileNames(timestamp) {
  return {
    report: `premortem-report-${timestamp}.html`,
    transcript: `premortem-transcript-${timestamp}.md`,
    json: `premortem-session-${timestamp}.json`
  };
}

export function buildLocalReceipt({ root, premortem, goldenLoop }) {
  const digest = crypto.createHash('sha256')
    .update(JSON.stringify({
      root: slash(root),
      premortem: premortem.summary,
      golden_loop: goldenLoop.summary,
      repo_fingerprint: premortem.repo_fingerprint
    }))
    .digest('hex');

  return {
    schema: 'agoragentic.premortem-golden-loop.local-receipt.v1',
    receipt_id: `pgl_${digest.slice(0, 16)}`,
    generated_at: nowIso(),
    root,
    repo_fingerprint: premortem.repo_fingerprint || null,
    premortem_summary: premortem.summary,
    golden_loop_summary: goldenLoop.summary,
    pass: premortem.summary.blockers === 0 && goldenLoop.summary.fail === 0,
    no_spend: true,
    boundary: {
      free_to_use: true,
      network_calls: false,
      repo_contents_uploaded: false,
      credentials_required: false,
      paid_execution: false,
      production_mutation: false,
      real_usdc_transfer: false,
      agoragentic_api_key_required: false
    }
  };
}

export async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function writeText(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, value, 'utf8');
}

export function renderPremortemMarkdown(report) {
  const lines = [
    '# Agoragentic Premortem',
    '',
    `Generated: ${report.generated_at}`,
    `Repository: ${report.root}`,
    `Score: ${report.summary.score}`,
    `Blockers: ${report.summary.blockers}`,
    `Warnings: ${report.summary.warnings}`,
    '',
    '## Risks',
    '',
    '| Severity | Risk | Evidence | Action |',
    '|---|---|---|---|'
  ];

  if (!report.risks.length) {
    lines.push('| pass | No release blockers found | Premortem checks passed | Keep the receipt with the release artifacts |');
  } else {
    for (const risk of report.risks) {
      lines.push(`| ${risk.severity} | ${escapeMd(risk.title)} | ${escapeMd((risk.evidence || []).join('; '))} | ${escapeMd(risk.action)} |`);
    }
  }

  lines.push('', '## Next Actions', '');
  if (!report.next_actions.length) {
    lines.push('- Keep the generated receipt with the release artifacts.');
  } else {
    for (const item of report.next_actions) {
      lines.push(`- [${item.severity}] ${item.action}`);
    }
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

export function renderGoldenLoopMarkdown(report) {
  const lines = [
    '# Agoragentic No-Spend Golden Loop',
    '',
    `Generated: ${report.generated_at}`,
    `Repository: ${report.root}`,
    `Pass: ${report.pass ? 'yes' : 'no'}`,
    '',
    '| Stage | Status | Evidence |',
    '|---|---|---|'
  ];

  for (const item of report.stages) {
    lines.push(`| ${escapeMd(item.title)} | ${item.status} | ${escapeMd((item.evidence || []).join('; '))} |`);
  }

  lines.push('', 'Boundary: no credentials, no paid execution, no production mutation, no real USDC transfer.', '');
  return `${lines.join('\n')}\n`;
}

export function renderSummaryMarkdown(run) {
  const receipt = run.receipt;
  return [
    '# Premortem Golden Loop Receipt',
    '',
    `Receipt: ${receipt.receipt_id}`,
    `Generated: ${receipt.generated_at}`,
    `Pass: ${receipt.pass ? 'yes' : 'no'}`,
    `Premortem score: ${receipt.premortem_summary.score}`,
    `Golden Loop failures: ${receipt.golden_loop_summary.fail}`,
    '',
    'This is a local no-spend receipt. It does not prove paid settlement, hosted deployment, or seller earnings.',
    ''
  ].join('\n');
}

function escapeMd(value) {
  return String(value || '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function timestampSlug(iso) {
  return String(iso || nowIso()).replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-').replace('Z', '');
}
