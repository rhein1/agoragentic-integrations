import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  DEFAULT_OUTPUT_DIR,
  readJson,
  writeJson,
} from './core.mjs';

export const WORKLOG_DIR = 'worklog';
export const CURRENT_WORK_FILE = 'current.json';
export const HISTORY_FILE = 'history.jsonl';
export const CHECKPOINTS_FILE = 'checkpoints.jsonl';
export const LATEST_SUMMARY_FILE = 'latest-summary.md';
export const DOCS_SYNC_PLAN_FILE = 'docs-sync-plan.json';
export const HANDOFF_FILE = 'handoff.md';
export const NEXT_SESSION_FILE = 'next-session.md';

function portablePath(filePath) {
  return filePath.replace(/\\/g, '/');
}

function relativePortable(from, to) {
  return portablePath(path.relative(from, to) || '.');
}

function resolveWorkspace({ targetDir = process.cwd(), outputDir = null } = {}) {
  const root = path.resolve(targetDir);
  const resolvedOutput = path.resolve(outputDir || path.join(root, DEFAULT_OUTPUT_DIR));
  const worklogDir = path.join(resolvedOutput, WORKLOG_DIR);
  return { root, outputDir: resolvedOutput, worklogDir };
}

function splitList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value || '')
    .split(/[,\n;]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function nowIso() {
  return new Date().toISOString();
}

function safeReadJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return readJson(filePath);
  } catch (error) {
    return {
      parse_error: error.message,
    };
  }
}

function appendJsonl(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`);
  return filePath;
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        return {
          parse_error: error.message,
          raw_length: line.length,
        };
      }
    });
}

function safeGit(root, args) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function gitSnapshot(root) {
  const statusShort = safeGit(root, ['status', '--short']);
  const branch = safeGit(root, ['branch', '--show-current']);
  const head = safeGit(root, ['rev-parse', '--short', 'HEAD']);
  const changedFiles = safeGit(root, ['diff', '--name-only'])
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
  const stagedFiles = safeGit(root, ['diff', '--cached', '--name-only'])
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
  return {
    branch: branch || null,
    head: head || null,
    status_short: statusShort,
    changed_files: changedFiles,
    staged_files: stagedFiles,
  };
}

function boundary() {
  return {
    local_only: true,
    proposal_first: true,
    docs_auto_edit_enabled: false,
    deploy_enabled: false,
    spend_enabled: false,
    wallet_mutation_enabled: false,
    x402_settlement_enabled: false,
    marketplace_publication_enabled: false,
    hosted_runtime_enabled: false,
    full_ecf_private_internals_included: false,
  };
}

function currentWorkPath(worklogDir) {
  return path.join(worklogDir, CURRENT_WORK_FILE);
}

function historyPath(worklogDir) {
  return path.join(worklogDir, HISTORY_FILE);
}

function checkpointsPath(worklogDir) {
  return path.join(worklogDir, CHECKPOINTS_FILE);
}

function requireCurrent(worklogDir) {
  const current = safeReadJson(currentWorkPath(worklogDir), null);
  if (!current || current.parse_error) {
    throw new Error('No active worklog. Run micro-ecf worklog begin --goal "..." first.');
  }
  return current;
}

function workId(goal) {
  const safeGoal = String(goal || 'work').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'work';
  return `${safeGoal}-${Date.now().toString(36)}`;
}

export function beginWorklog(options = {}) {
  const { root, outputDir, worklogDir } = resolveWorkspace(options);
  const goal = String(options.goal || options.summary || '').trim();
  if (!goal) throw new Error('worklog begin requires --goal "..."');
  const current = {
    schema: 'agoragentic.micro-ecf.worklog-current.v1',
    work_id: options.workId || workId(goal),
    goal,
    status: 'active',
    started_at: nowIso(),
    updated_at: nowIso(),
    workspace_root: relativePortable(process.cwd(), root),
    output_dir: relativePortable(process.cwd(), outputDir),
    decisions: splitList(options.decisions),
    changed_files: splitList(options.files),
    validation: splitList(options.validation),
    commits: [],
    unfinished_work: splitList(options.unfinished),
    next_prompt: String(options.nextPrompt || '').trim() || null,
    git: gitSnapshot(root),
    authority_boundary: boundary(),
  };
  writeJson(currentWorkPath(worklogDir), current);
  appendJsonl(historyPath(worklogDir), {
    event: 'begin',
    work_id: current.work_id,
    goal: current.goal,
    at: current.started_at,
  });
  return {
    ok: true,
    current,
    current_path: relativePortable(process.cwd(), currentWorkPath(worklogDir)),
  };
}

export function checkpointWorklog(options = {}) {
  const { root, worklogDir } = resolveWorkspace(options);
  const current = requireCurrent(worklogDir);
  const checkpoint = {
    schema: 'agoragentic.micro-ecf.worklog-checkpoint.v1',
    work_id: current.work_id,
    at: nowIso(),
    summary: String(options.summary || '').trim() || 'Checkpoint recorded.',
    decisions: splitList(options.decisions),
    changed_files: splitList(options.files),
    validation: splitList(options.validation),
    unfinished_work: splitList(options.unfinished),
    next_prompt: String(options.nextPrompt || '').trim() || null,
    git: gitSnapshot(root),
    authority_boundary: boundary(),
  };
  current.updated_at = checkpoint.at;
  current.decisions = [...new Set([...(current.decisions || []), ...checkpoint.decisions])];
  current.changed_files = [...new Set([...(current.changed_files || []), ...checkpoint.changed_files, ...checkpoint.git.changed_files])];
  current.validation = [...new Set([...(current.validation || []), ...checkpoint.validation])];
  current.unfinished_work = checkpoint.unfinished_work.length ? checkpoint.unfinished_work : current.unfinished_work;
  current.next_prompt = checkpoint.next_prompt || current.next_prompt;
  current.git = checkpoint.git;
  writeJson(currentWorkPath(worklogDir), current);
  appendJsonl(checkpointsPath(worklogDir), checkpoint);
  appendJsonl(historyPath(worklogDir), {
    event: 'checkpoint',
    work_id: current.work_id,
    summary: checkpoint.summary,
    at: checkpoint.at,
  });
  return {
    ok: true,
    checkpoint,
    current,
    checkpoint_path: relativePortable(process.cwd(), checkpointsPath(worklogDir)),
  };
}

export function finishWorklog(options = {}) {
  const { root, worklogDir } = resolveWorkspace(options);
  const current = requireCurrent(worklogDir);
  const commit = String(options.commit || '').trim();
  const finished = {
    ...current,
    schema: 'agoragentic.micro-ecf.worklog-finished.v1',
    status: 'finished',
    finished_at: nowIso(),
    updated_at: nowIso(),
    summary: String(options.summary || '').trim() || current.goal,
    commits: [...new Set([...(current.commits || []), ...splitList(commit)])],
    changed_files: [...new Set([...(current.changed_files || []), ...splitList(options.files), ...gitSnapshot(root).changed_files])],
    validation: [...new Set([...(current.validation || []), ...splitList(options.validation), ...splitList(options.tests)])],
    unfinished_work: splitList(options.unfinished).length ? splitList(options.unfinished) : current.unfinished_work,
    next_prompt: String(options.nextPrompt || '').trim() || current.next_prompt,
    git: gitSnapshot(root),
    authority_boundary: boundary(),
  };
  writeJson(currentWorkPath(worklogDir), finished);
  appendJsonl(historyPath(worklogDir), {
    event: 'finish',
    work_id: finished.work_id,
    goal: finished.goal,
    summary: finished.summary,
    commits: finished.commits,
    at: finished.finished_at,
  });
  const summaryPath = writeLatestSummary({ worklogDir, work: finished });
  return {
    ok: true,
    finished,
    current_path: relativePortable(process.cwd(), currentWorkPath(worklogDir)),
    latest_summary_path: relativePortable(process.cwd(), summaryPath),
  };
}

function docsCandidate(pathName, reason, exists) {
  return {
    path: pathName,
    exists,
    action: exists ? 'review_update_if_claims_changed' : 'skip_missing',
    reason,
  };
}

function docsImpact(root, work) {
  const changed = new Set([...(work?.changed_files || []), ...(work?.git?.changed_files || []), ...(work?.git?.staged_files || [])]);
  const touchedApi = [...changed].some((file) => file.startsWith('server/routes/') || file === 'public/openapi.yaml' || file.includes('openapi'));
  const touchedDocs = [...changed].some((file) => file.startsWith('docs/') || file.endsWith('.md'));
  const touchedCli = [...changed].some((file) => file.startsWith('bin/') || file.includes('/bin/') || file === 'package.json');
  const touchedPublic = [...changed].some((file) => file.startsWith('public/') || file.includes('llms') || file.includes('agents.txt'));
  const candidates = [
    docsCandidate('WRAPUP.md', 'Record finished goals, commits, validations, pending work, and next prompt.', fs.existsSync(path.join(root, 'WRAPUP.md'))),
    docsCandidate('DOCUMENTATION_INDEX.md', 'Link new files or update file-purpose descriptions.', fs.existsSync(path.join(root, 'DOCUMENTATION_INDEX.md'))),
    docsCandidate('docs/API_REFERENCE.md', touchedApi ? 'API or OpenAPI surfaces changed.' : 'No API route change detected; usually no update needed.', fs.existsSync(path.join(root, 'docs', 'API_REFERENCE.md'))),
    docsCandidate('docs/TOMORROW_PLAN.md', 'Carry forward unfinished work and next implementation prompt.', fs.existsSync(path.join(root, 'docs', 'TOMORROW_PLAN.md'))),
    docsCandidate('START_HERE.md', 'Update only if status, roadmap, or quickstart changed.', fs.existsSync(path.join(root, 'START_HERE.md'))),
    docsCandidate('README.md', touchedCli ? 'CLI/package command surface changed.' : 'Update only if public package usage changed.', fs.existsSync(path.join(root, 'README.md'))),
    docsCandidate('POST_INSTALL.md', touchedCli ? 'Post-install or MCP/workflow command surface changed.' : 'Update only if after-install workflow changed.', fs.existsSync(path.join(root, 'POST_INSTALL.md'))),
    docsCandidate('public/agents.txt', touchedPublic ? 'Public agent discovery changed.' : 'No public discovery change detected.', fs.existsSync(path.join(root, 'public', 'agents.txt'))),
  ];
  return {
    changed_file_count: changed.size,
    changed_files: [...changed].sort(),
    touched_api: touchedApi,
    touched_docs: touchedDocs,
    touched_cli: touchedCli,
    touched_public_discovery: touchedPublic,
    candidates,
  };
}

export function planDocsSync(options = {}) {
  const { root, outputDir, worklogDir } = resolveWorkspace(options);
  const current = safeReadJson(currentWorkPath(worklogDir), null);
  const work = current && !current.parse_error ? current : {
    goal: String(options.goal || '').trim() || 'unspecified',
    changed_files: splitList(options.files),
    validation: splitList(options.validation),
    git: gitSnapshot(root),
  };
  const impact = docsImpact(root, work);
  const plan = {
    schema: 'agoragentic.micro-ecf.docs-sync-plan.v1',
    ok: true,
    generated_at: nowIso(),
    workspace_root: relativePortable(process.cwd(), root),
    output_dir: relativePortable(process.cwd(), outputDir),
    work_id: work.work_id || null,
    goal: work.goal || null,
    summary: work.summary || null,
    docs_auto_edit_enabled: false,
    apply_supported: false,
    explicit_apply_required: true,
    impact,
    recommended_updates: impact.candidates.filter((candidate) => candidate.exists && !candidate.reason.startsWith('No ')),
    authority_boundary: boundary(),
  };
  const planPath = writeJson(path.join(outputDir, DOCS_SYNC_PLAN_FILE), plan);
  return {
    ...plan,
    plan_path: relativePortable(process.cwd(), planPath),
  };
}

function formatList(items, fallback = 'None recorded.') {
  const values = (items || []).filter(Boolean);
  if (!values.length) return fallback;
  return values.map((item) => `- ${item}`).join('\n');
}

function workSummaryMarkdown(work) {
  return `# Micro ECF Work Summary

Generated: ${nowIso()}

## Goal

${work.goal || 'No goal recorded.'}

## Status

${work.status || 'unknown'}

## Summary

${work.summary || 'No summary recorded.'}

## Commits

${formatList(work.commits)}

## Changed Files

${formatList(work.changed_files)}

## Validation

${formatList(work.validation)}

## Decisions

${formatList(work.decisions)}

## Unfinished Work

${formatList(work.unfinished_work)}

## Next Prompt

${work.next_prompt || 'None recorded.'}

## Boundary

- Local-only: true
- Docs auto-edit enabled: false
- Deploy/spend/wallet/x402/marketplace authority: false
`;
}

function writeLatestSummary({ worklogDir, work }) {
  const summaryPath = path.join(worklogDir, LATEST_SUMMARY_FILE);
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
  fs.writeFileSync(summaryPath, workSummaryMarkdown(work));
  return summaryPath;
}

export function buildWorklogStatus(options = {}) {
  const { worklogDir } = resolveWorkspace(options);
  const current = safeReadJson(currentWorkPath(worklogDir), null);
  const history = readJsonl(historyPath(worklogDir));
  const checkpoints = readJsonl(checkpointsPath(worklogDir));
  return {
    schema: 'agoragentic.micro-ecf.worklog-status.v1',
    ok: true,
    generated_at: nowIso(),
    active: Boolean(current && !current.parse_error && current.status !== 'finished'),
    current: current && !current.parse_error ? current : null,
    history_tail: history.slice(-10),
    checkpoint_tail: checkpoints.slice(-10),
    authority_boundary: boundary(),
  };
}

export function buildHandoff(options = {}) {
  const { root, outputDir, worklogDir } = resolveWorkspace(options);
  const current = safeReadJson(currentWorkPath(worklogDir), null);
  const docsPlan = safeReadJson(path.join(outputDir, DOCS_SYNC_PLAN_FILE), null);
  const work = current && !current.parse_error ? current : {
    goal: String(options.goal || '').trim() || 'No active worklog.',
    status: 'unknown',
    summary: 'No worklog current.json found.',
    commits: [],
    changed_files: [],
    validation: [],
    decisions: [],
    unfinished_work: [],
    next_prompt: null,
  };
  return {
    schema: 'agoragentic.micro-ecf.handoff.v1',
    ok: true,
    generated_at: nowIso(),
    workspace_root: relativePortable(process.cwd(), root),
    output_dir: relativePortable(process.cwd(), outputDir),
    work,
    docs_sync_plan: docsPlan && !docsPlan.parse_error ? {
      path: relativePortable(process.cwd(), path.join(outputDir, DOCS_SYNC_PLAN_FILE)),
      recommended_updates: docsPlan.recommended_updates || [],
    } : null,
    read_order: [
      'AGENTS.md',
      'ECF.md',
      '.micro-ecf/context-pack.json',
      '.micro-ecf/worklog/latest-summary.md',
      '.micro-ecf/next-session.md',
    ],
    authority_boundary: boundary(),
  };
}

export function writeHandoff(options = {}) {
  const { outputDir, worklogDir } = resolveWorkspace(options);
  const handoff = buildHandoff(options);
  const handoffPath = writeJson(path.join(outputDir, HANDOFF_FILE.replace(/\.md$/, '.json')), handoff);
  const markdown = `# Micro ECF Next Session Handoff

Generated: ${handoff.generated_at}

## Read First

${formatList(handoff.read_order)}

## Goal

${handoff.work.goal || 'No goal recorded.'}

## Status

${handoff.work.status || 'unknown'}

## Summary

${handoff.work.summary || 'No summary recorded.'}

## Commits

${formatList(handoff.work.commits)}

## Changed Files

${formatList(handoff.work.changed_files)}

## Validation

${formatList(handoff.work.validation)}

## Unfinished Work

${formatList(handoff.work.unfinished_work)}

## Next Prompt

${handoff.work.next_prompt || 'None recorded.'}

## Docs Sync

${handoff.docs_sync_plan
    ? formatList((handoff.docs_sync_plan.recommended_updates || []).map((item) => `${item.path}: ${item.reason}`))
    : 'No docs-sync plan recorded.'}

## Boundary

This handoff is local-only. It does not deploy, spend, mutate wallets, settle x402, publish marketplace listings, provision hosted runtime, or expose Full ECF private internals.
`;
  const markdownPath = path.join(outputDir, HANDOFF_FILE);
  const nextSessionPath = path.join(outputDir, NEXT_SESSION_FILE);
  fs.writeFileSync(markdownPath, markdown);
  fs.writeFileSync(nextSessionPath, markdown);
  if (handoff.work && handoff.work.goal) {
    writeLatestSummary({ worklogDir, work: handoff.work });
  }
  return {
    ...handoff,
    handoff_json_path: relativePortable(process.cwd(), handoffPath),
    handoff_path: relativePortable(process.cwd(), markdownPath),
    next_session_path: relativePortable(process.cwd(), nextSessionPath),
  };
}

export function readWorklogArtifacts(options = {}) {
  const { outputDir, worklogDir } = resolveWorkspace(options);
  return {
    schema: 'agoragentic.micro-ecf.worklog-artifacts.v1',
    ok: true,
    status: buildWorklogStatus(options),
    docs_sync_plan: safeReadJson(path.join(outputDir, DOCS_SYNC_PLAN_FILE), null),
    handoff: safeReadJson(path.join(outputDir, HANDOFF_FILE.replace(/\.md$/, '.json')), null),
    latest_summary: fs.existsSync(path.join(worklogDir, LATEST_SUMMARY_FILE))
      ? fs.readFileSync(path.join(worklogDir, LATEST_SUMMARY_FILE), 'utf8')
      : null,
    authority_boundary: boundary(),
  };
}
