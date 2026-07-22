import { promises as fs } from 'node:fs';
import path from 'node:path';
import { authorityBoundary, sanitizeForPublicEvidence } from './events.mjs';
import { harnessDir, listRunStates, readJsonIfExists } from './state.mjs';

export const SCHEDULE_SCHEMA = 'agoragentic.harness.schedule.v1';

const SUPPORTED_LOOP = 'seller-listing-readiness';
const SUPPORTED_PROFILE = 'seller_listing_readiness';
const SUPPORTED_INTERVALS = Object.freeze({
  daily: 24 * 60 * 60 * 1000,
});

export async function planHarnessSchedule({
  dir = process.cwd(),
  loop = SUPPORTED_LOOP,
  interval = 'daily',
} = {}) {
  assertSupported(loop, interval);
  const existing = await readHarnessSchedule(dir);
  const plannedAt = new Date().toISOString();
  const schedule = buildScheduleRecord({
    previous: (existing?.schedules || []).find((entry) => entry.loop === loop),
    loop,
    interval,
    planned_at: plannedAt,
  });
  const schedules = [
    ...(existing?.schedules || []).filter((entry) => entry.loop !== loop),
    schedule,
  ].sort((a, b) => String(a.loop).localeCompare(String(b.loop)));
  const manifest = buildScheduleManifest({
    previous: existing,
    schedules,
    updated_at: plannedAt,
  });
  await writeHarnessSchedule(dir, manifest);
  const status = await getHarnessScheduleStatus({ dir, now: plannedAt });
  return {
    ok: true,
    schedule_path: '.agoragentic/harness-schedule.json',
    schedule,
    due_state: status.due_states.find((entry) => entry.loop === loop) || null,
    manifest,
  };
}

export async function listHarnessSchedules({ dir = process.cwd(), now = null } = {}) {
  const status = await getHarnessScheduleStatus({ dir, now });
  return {
    ok: true,
    schedule_path: status.schedule_path,
    schedules: status.schedules,
    due_states: status.due_states,
  };
}

export async function checkDueHarnessSchedules({ dir = process.cwd(), now = null } = {}) {
  const status = await getHarnessScheduleStatus({ dir, now });
  return {
    ok: true,
    checked_at: status.checked_at,
    schedule_path: status.schedule_path,
    due_count: status.due_count,
    due_schedules: status.due_schedules,
    due_states: status.due_states,
    execution_policy: status.execution_policy,
  };
}

export async function getHarnessScheduleStatus({ dir = process.cwd(), now = null } = {}) {
  const checkedAt = now || new Date().toISOString();
  const manifest = await readHarnessSchedule(dir);
  const schedules = manifest?.schedules || [];
  const runs = await listRunStates(dir);
  const dueStates = schedules.map((schedule) => computeDueState(schedule, runs, checkedAt));
  return {
    schema: `${SCHEDULE_SCHEMA}.status`,
    checked_at: checkedAt,
    schedule_path: manifest ? '.agoragentic/harness-schedule.json' : null,
    intent_present: schedules.length > 0,
    execution_policy: manifest?.execution_policy || scheduleExecutionPolicy(),
    schedules: schedules.map(summarizeSchedule),
    due_count: dueStates.filter((entry) => entry.due).length,
    due_schedules: dueStates.filter((entry) => entry.due),
    due_states: dueStates,
  };
}

export async function readHarnessSchedule(dir = process.cwd()) {
  return readJsonIfExists(schedulePath(dir));
}

export async function writeHarnessSchedule(dir = process.cwd(), manifest) {
  const root = harnessDir(dir);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(schedulePath(dir), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return '.agoragentic/harness-schedule.json';
}

function buildScheduleManifest({ previous, schedules, updated_at }) {
  return {
    schema: SCHEDULE_SCHEMA,
    generated_at: previous?.generated_at || updated_at,
    updated_at,
    mode: 'local_no_spend',
    artifact: '.agoragentic/harness-schedule.json',
    scheduling_intent_only: true,
    execution_policy: scheduleExecutionPolicy(),
    schedules: schedules.map((entry) => sanitizeForPublicEvidence(entry)),
    authority_boundary: scheduleAuthorityBoundary(),
  };
}

function buildScheduleRecord({ previous, loop, interval, planned_at }) {
  return {
    id: `schedule_${loop.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '')}`,
    loop,
    profile: SUPPORTED_PROFILE,
    interval,
    interval_seconds: Math.floor(SUPPORTED_INTERVALS[interval] / 1000),
    created_at: previous?.created_at || planned_at,
    updated_at: planned_at,
    enabled: true,
    mode: 'local_no_spend',
    scheduling_intent_only: true,
    due_check_only: true,
    automatic_execution: false,
    manual_invocation_required: true,
    command_ref: `agoragentic-harness loop ${loop} --once --write-inbox --dir .`,
    due_policy: 'latest passed matching local run completed_at plus interval',
    no_authority_statement: 'This schedule records local intent and due state only. It does not start a scheduler, daemon, service, shell, SSH session, tunnel, hosted job, or Harness loop.',
    authority_boundary: scheduleAuthorityBoundary(),
  };
}

function computeDueState(schedule, runs, checkedAt) {
  const latest = runs.find((run) => (
    run.profile === schedule.profile
    && run.status === 'passed'
    && run.completed_at
  ));
  if (!schedule.enabled) {
    return dueState(schedule, checkedAt, {
      due: false,
      reason: 'schedule_disabled',
      latest,
      next_due_at: null,
    });
  }
  if (!latest) {
    return dueState(schedule, checkedAt, {
      due: true,
      reason: 'never_completed',
      latest: null,
      next_due_at: schedule.created_at,
    });
  }
  const intervalMs = SUPPORTED_INTERVALS[schedule.interval] || SUPPORTED_INTERVALS.daily;
  const completedAtMs = Date.parse(latest.completed_at);
  const checkedAtMs = Date.parse(checkedAt);
  const nextDueAt = Number.isFinite(completedAtMs)
    ? new Date(completedAtMs + intervalMs).toISOString()
    : checkedAt;
  const due = !Number.isFinite(completedAtMs) || checkedAtMs >= completedAtMs + intervalMs;
  return dueState(schedule, checkedAt, {
    due,
    reason: due ? 'interval_elapsed' : 'recent_run_within_interval',
    latest,
    next_due_at: nextDueAt,
  });
}

function dueState(schedule, checkedAt, { due, reason, latest, next_due_at }) {
  return {
    id: schedule.id,
    loop: schedule.loop,
    profile: schedule.profile,
    interval: schedule.interval,
    checked_at: checkedAt,
    due,
    reason,
    next_due_at,
    latest_run: latest ? {
      run_id: latest.run_id,
      status: latest.status,
      completed_at: latest.completed_at,
      path: `.agoragentic/runs/${latest.run_id}`,
    } : null,
    manual_command: schedule.command_ref,
    automatic_execution: false,
    action_executed: false,
    authority_boundary: scheduleAuthorityBoundary(),
  };
}

function summarizeSchedule(schedule) {
  return {
    id: schedule.id,
    loop: schedule.loop,
    profile: schedule.profile,
    interval: schedule.interval,
    enabled: schedule.enabled,
    created_at: schedule.created_at,
    updated_at: schedule.updated_at,
    command_ref: schedule.command_ref,
    scheduling_intent_only: true,
    automatic_execution: false,
    manual_invocation_required: true,
  };
}

function scheduleExecutionPolicy() {
  return {
    automatic_execution: false,
    background_service: false,
    daemon: false,
    hosted_automation: false,
    cron_install: false,
    task_scheduler_install: false,
    systemd_install: false,
    process_control: false,
    shell_execution: false,
    ssh: false,
    tunnel: false,
    requires_manual_invocation: true,
  };
}

function scheduleAuthorityBoundary() {
  return authorityBoundary({
    automatic_execution: false,
    hosted_automation: false,
    cron_install: false,
    task_scheduler_install: false,
    systemd_install: false,
    background_service: false,
    service_start: false,
    ssh: false,
    tunnel: false,
    hosted_memory_write: false,
  });
}

function assertSupported(loop, interval) {
  if (loop !== SUPPORTED_LOOP) throw new Error(`unsupported scheduled loop: ${loop}`);
  if (!Object.hasOwn(SUPPORTED_INTERVALS, interval)) {
    throw new Error(`unsupported schedule interval: ${interval}`);
  }
}

function schedulePath(dir) {
  return path.join(harnessDir(dir), 'harness-schedule.json');
}
