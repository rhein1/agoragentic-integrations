import { promises as fs } from 'node:fs';
import path from 'node:path';
import { authorityBoundary, sanitizeForPublicEvidence } from './events.mjs';
import { harnessDir, latestRunState, readJsonIfExists } from './state.mjs';

export const WORKTREE_SESSION_SCHEMA = 'agoragentic.harness.worktree-session.v1';

const DEFAULT_OWNER_REVIEW_STATE = 'pending_owner_review';
const VALID_DIRTY_STATES = new Set(['clean', 'dirty', 'unknown']);

export async function attachWorktreeSession({
  dir = process.cwd(),
  worktree_path,
  branch,
  commit_sha = null,
  pr_number = null,
  pr_url = null,
  dirty_state = 'unknown',
  owner_review_state = DEFAULT_OWNER_REVIEW_STATE,
} = {}) {
  if (!worktree_path) throw new Error('worktree attach requires --path <path>');
  if (!branch) throw new Error('worktree attach requires --branch <branch>');
  const attachedAt = new Date().toISOString();
  const latest = await latestRunState(dir);
  const session = buildWorktreeSession({
    generated_at: attachedAt,
    updated_at: attachedAt,
    active: true,
    attached_at: attachedAt,
    detached_at: null,
    worktree_path,
    branch,
    commit_sha,
    pr_number,
    pr_url,
    dirty_state,
    dirty_state_source: dirty_state === 'unknown' ? 'not_supplied' : 'user_supplied',
    owner_review_state,
    latest,
  });
  await writeWorktreeSession(dir, session);
  return {
    ok: true,
    session_path: '.agoragentic/worktree-session.json',
    session,
  };
}

export async function getWorktreeSessionStatus({ dir = process.cwd() } = {}) {
  const session = await readWorktreeSession(dir);
  if (!session) {
    return {
      ok: true,
      present: false,
      active: false,
      session_path: null,
      session: null,
      latest_harness_run_ref: null,
      authority_boundary: worktreeAuthorityBoundary(),
    };
  }
  const latest = await latestRunState(dir);
  const latestRef = latestRunRef(latest) || session.latest_harness_run_ref || null;
  const sessionWithLatest = {
    ...session,
    latest_harness_run_ref: latestRef,
  };
  if (JSON.stringify(session.latest_harness_run_ref || null) !== JSON.stringify(latestRef)) {
    await writeWorktreeSession(dir, sessionWithLatest);
  }
  return {
    ok: true,
    present: true,
    active: session.active === true,
    session_path: '.agoragentic/worktree-session.json',
    session: sanitizeForPublicEvidence(sessionWithLatest),
    latest_harness_run_ref: latestRef,
    authority_boundary: worktreeAuthorityBoundary(),
  };
}

export async function detachWorktreeSession({ dir = process.cwd() } = {}) {
  const existing = await readWorktreeSession(dir);
  const detachedAt = new Date().toISOString();
  const latest = await latestRunState(dir);
  const session = existing
    ? {
      ...existing,
      updated_at: detachedAt,
      active: false,
      detached_at: detachedAt,
      owner_review_state: existing.owner_review_state || 'detached',
      latest_harness_run_ref: latestRunRef(latest) || existing.latest_harness_run_ref || null,
      authority_boundary: worktreeAuthorityBoundary(),
    }
    : buildWorktreeSession({
      generated_at: detachedAt,
      updated_at: detachedAt,
      active: false,
      attached_at: null,
      detached_at: detachedAt,
      worktree_path: null,
      branch: null,
      dirty_state: 'unknown',
      dirty_state_source: 'not_supplied',
      owner_review_state: 'detached',
      latest,
    });
  await writeWorktreeSession(dir, session);
  return {
    ok: true,
    session_path: '.agoragentic/worktree-session.json',
    session,
  };
}

export async function readWorktreeSession(dir = process.cwd()) {
  return readJsonIfExists(worktreeSessionPath(dir));
}

export async function writeWorktreeSession(dir = process.cwd(), session) {
  const root = harnessDir(dir);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(worktreeSessionPath(dir), `${JSON.stringify(session, null, 2)}\n`, 'utf8');
  return '.agoragentic/worktree-session.json';
}

function buildWorktreeSession({
  generated_at,
  updated_at,
  active,
  attached_at,
  detached_at,
  worktree_path,
  branch,
  commit_sha = null,
  pr_number = null,
  pr_url = null,
  dirty_state = 'unknown',
  dirty_state_source = 'not_supplied',
  owner_review_state = DEFAULT_OWNER_REVIEW_STATE,
  latest,
}) {
  const normalizedDirtyState = VALID_DIRTY_STATES.has(String(dirty_state)) ? String(dirty_state) : 'unknown';
  return {
    schema: WORKTREE_SESSION_SCHEMA,
    generated_at,
    updated_at,
    mode: 'local_no_spend',
    artifact: '.agoragentic/worktree-session.json',
    active,
    attached_at,
    detached_at,
    refs_only: true,
    worktree: {
      path: worktree_path ? path.resolve(String(worktree_path)) : null,
      branch: branch ? String(branch) : null,
      commit_sha: commit_sha ? String(commit_sha) : null,
      pr_number: pr_number === null || pr_number === undefined ? null : String(pr_number),
      pr_url: pr_url ? String(pr_url) : null,
      dirty_state: normalizedDirtyState,
      dirty_state_source,
      git_status_read: false,
    },
    latest_harness_run_ref: latestRunRef(latest),
    owner_review_state: String(owner_review_state || DEFAULT_OWNER_REVIEW_STATE),
    artifact_policy: {
      refs_only: true,
      raw_diff_included: false,
      raw_patch_included: false,
      raw_git_log_included: false,
      raw_tool_output_included: false,
      secrets_included: false,
    },
    execution_policy: {
      git_commands_executed: false,
      shell_execution: false,
      branch_created: false,
      push_performed: false,
      pr_created: false,
      framework_tool_executed: false,
      provider_dispatched: false,
      hosted_mutation: false,
    },
    authority_boundary: worktreeAuthorityBoundary(),
  };
}

function latestRunRef(latest) {
  if (!latest) return null;
  return {
    run_id: latest.run_id,
    status: latest.status,
    path: `.agoragentic/runs/${latest.run_id}`,
    completed_at: latest.completed_at || null,
  };
}

function worktreeAuthorityBoundary() {
  return authorityBoundary({
    git_write: false,
    git_branch_create: false,
    git_push: false,
    pr_create: false,
    shell_execution: false,
    framework_tool_execution: false,
    hosted_mutation: false,
    hosted_memory_write: false,
    service_start: false,
    ssh: false,
    tunnel: false,
  });
}

function worktreeSessionPath(dir) {
  return path.join(harnessDir(dir), 'worktree-session.json');
}
