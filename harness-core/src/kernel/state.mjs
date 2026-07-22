import { promises as fs } from 'node:fs';
import path from 'node:path';
import { authorityBoundary, createHarnessEvent, sanitizeForPublicEvidence, stableId } from './events.mjs';

export const RUN_SCHEMA = 'agoragentic.harness.run.v1';

export function harnessDir(dir = process.cwd()) {
  return path.join(path.resolve(dir), '.agoragentic');
}

export function runDir(dir, runId) {
  return path.join(harnessDir(dir), 'runs', runId);
}

export async function ensureHarnessDir(dir = process.cwd()) {
  await fs.mkdir(harnessDir(dir), { recursive: true });
  return harnessDir(dir);
}

export async function ensureRunDir(dir, runId) {
  const target = runDir(dir, runId);
  await fs.mkdir(target, { recursive: true });
  return target;
}

export async function createRunState({
  dir = process.cwd(),
  profile = 'local_no_spend',
  task = 'local harness proof',
  project_paths = {},
  created_at,
} = {}) {
  const createdAt = created_at || new Date().toISOString();
  const runId = createRunId({ profile, task, created_at: createdAt });
  const state = {
    schema: RUN_SCHEMA,
    run_id: runId,
    created_at: createdAt,
    completed_at: null,
    mode: 'local_no_spend',
    profile,
    task: sanitizeForPublicEvidence(task, { maxStringLength: 240 }),
    status: 'running',
    project_paths: sanitizeForPublicEvidence(project_paths),
    artifacts: {},
    event_count: 0,
    approval_count: 0,
    guard_decision_count: 0,
    blocked_actions: [],
    authority_boundary: authorityBoundary(),
  };
  await ensureRunDir(dir, runId);
  await writeRunState(dir, state);
  return state;
}

export async function writeRunState(dir, state) {
  const target = runDir(dir, state.run_id);
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, 'state.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return path.join(target, 'state.json');
}

export async function appendRunEvent(dir, state, eventInput) {
  const sequence = Number(state.event_count || 0) + 1;
  const event = createHarnessEvent({
    ...eventInput,
    run_id: state.run_id,
    sequence,
  });
  await ensureRunDir(dir, state.run_id);
  await fs.appendFile(path.join(runDir(dir, state.run_id), 'events.jsonl'), `${JSON.stringify(event)}\n`, 'utf8');
  state.event_count = sequence;
  if (event.type === 'approval_required') state.approval_count = Number(state.approval_count || 0) + 1;
  if (event.type === 'guard_decision') state.guard_decision_count = Number(state.guard_decision_count || 0) + 1;
  if (event.severity === 'blocked' || event.type === 'run_blocked') {
    state.blocked_actions = [
      ...(state.blocked_actions || []),
      {
        event_id: event.event_id,
        type: event.type,
        summary: event.summary,
      },
    ];
  }
  await writeRunState(dir, state);
  return event;
}

export async function completeRunState(dir, state, status = 'passed', updates = {}) {
  state.status = status;
  state.completed_at = updates.completed_at || new Date().toISOString();
  if (updates.artifacts) {
    state.artifacts = {
      ...(state.artifacts || {}),
      ...sanitizeForPublicEvidence(updates.artifacts),
    };
  }
  if (updates.project_paths) {
    state.project_paths = {
      ...(state.project_paths || {}),
      ...sanitizeForPublicEvidence(updates.project_paths),
    };
  }
  await writeRunState(dir, state);
  return state;
}

export async function writeRunArtifact(dir, state, fileName, payload) {
  const target = runDir(dir, state.run_id);
  await fs.mkdir(target, { recursive: true });
  const filePath = path.join(target, fileName);
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  state.artifacts = {
    ...(state.artifacts || {}),
    [artifactKey(fileName)]: path.relative(path.resolve(dir), filePath).replace(/\\/g, '/'),
  };
  await writeRunState(dir, state);
  return filePath;
}

export async function writeTextRunArtifact(dir, state, fileName, text) {
  const target = runDir(dir, state.run_id);
  await fs.mkdir(target, { recursive: true });
  const filePath = path.join(target, fileName);
  await fs.writeFile(filePath, String(text), 'utf8');
  state.artifacts = {
    ...(state.artifacts || {}),
    [artifactKey(fileName)]: path.relative(path.resolve(dir), filePath).replace(/\\/g, '/'),
  };
  await writeRunState(dir, state);
  return filePath;
}

export async function listRunStates(dir = process.cwd()) {
  const root = path.join(harnessDir(dir), 'runs');
  let entries = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const states = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const state = await readRunState(dir, entry.name);
    if (state) states.push(state);
  }
  return states.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

export async function readRunState(dir, runId) {
  try {
    return JSON.parse(await fs.readFile(path.join(runDir(dir, runId), 'state.json'), 'utf8'));
  } catch {
    return null;
  }
}

export async function readRunEvents(dir, runId, { limit = null } = {}) {
  const eventsPath = path.join(runDir(dir, runId), 'events.jsonl');
  let lines = [];
  try {
    lines = (await fs.readFile(eventsPath, 'utf8')).split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
  const selected = limit ? lines.slice(-Number(limit)) : lines;
  return selected.map((line) => JSON.parse(line));
}

export async function latestRunState(dir = process.cwd()) {
  const [latest] = await listRunStates(dir);
  return latest || null;
}

export async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export function relativeArtifactPath(dir, filePath) {
  return path.relative(path.resolve(dir), filePath).replace(/\\/g, '/');
}

function createRunId(seed) {
  const random = stableId('seed', `${process.pid}:${Date.now()}:${Math.random()}`);
  return stableId('run', `${seed.profile}:${seed.task}:${seed.created_at}:${random}`);
}

function artifactKey(fileName) {
  return String(fileName).replace(/\.[^.]+$/, '').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase();
}
