import { createHash } from 'node:crypto';
import path from 'node:path';

export const MEMORY_SKILLOPT_SELECTION_SCHEMA = 'agoragentic.memory-skillopt.selection.v1';
export const SKILLOPT_TASK_FORMAT = 'skillopt_sleep.tasks.v1';
export const MEMORY_EXPORT_SCHEMA = 'agoragentic.memory.export.v1';
export const SUPPORTED_MEMORY_VERSION = '0.1.0-rc.2';
export const SUPPORTED_MEMORY_REVISION = '508ac3667a5ad3f6f5da323d7ddaf5f13384095d';
export const SKILLOPT_COMPATIBILITY_VERSION = '0.2.0';
export const SKILLOPT_COMPATIBILITY_REVISION = '47fe269d75d3def79ffd90236261d26d84868ae5';

const MEMORY_ID = /^mem_[a-f0-9]{32}$/;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;
const ALLOWED_TYPES = new Set(['goal', 'intent', 'open_loop', 'validation', 'hypothesis', 'preference']);
const SPLITS = new Set(['train', 'val', 'test']);
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\b(?:sk|ghp|github_pat|amk)_[A-Za-z0-9_-]{16,}\b/,
  /\b(?:database_url|admin_secret|wallet_secret|seed phrase|private key)\b/i,
  /\b(?:password|passwd|token|secret)\s*[:=]\s*[^\s]{8,}/i,
  /\bignore (?:all )?(?:previous|prior) instructions\b/i,
  /\b(?:system prompt|developer message|hidden instructions)\b/i,
];

export function validateMemorySkillOptSelection(selection) {
  exactKeys(selection, [
    'schema',
    'memory_project_id',
    'skillopt_project',
    'target_skill_path',
    'tasks',
  ], 'selection');
  if (selection.schema !== MEMORY_SKILLOPT_SELECTION_SCHEMA) {
    throw new TypeError('selection.schema is unsupported');
  }
  boundedText(selection.memory_project_id, 'selection.memory_project_id', 512);
  safeIdentifier(selection.skillopt_project, 'selection.skillopt_project');
  const target = boundedText(selection.target_skill_path, 'selection.target_skill_path', 512);
  if (path.isAbsolute(target)
    || /^[A-Za-z]:[\\/]/.test(target)
    || target.startsWith('\\')
    || target.split(/[\\/]+/).includes('..')
    || /[\u0000-\u001f\u007f]/.test(target)
    || !/SKILL\.md$/i.test(target)) {
    throw new TypeError('selection.target_skill_path must be a relative SKILL.md path without parent traversal');
  }
  if (!Array.isArray(selection.tasks) || selection.tasks.length < 2 || selection.tasks.length > 50) {
    throw new TypeError('selection.tasks must contain 2-50 entries');
  }
  const ids = new Set();
  const splits = new Set();
  for (const [index, task] of selection.tasks.entries()) {
    exactKeys(task, ['memory_id', 'split', 'skill_hint'], `selection.tasks[${index}]`);
    if (!MEMORY_ID.test(task.memory_id || '') || ids.has(task.memory_id)) {
      throw new TypeError('selection task memory IDs must be unique canonical memory IDs');
    }
    ids.add(task.memory_id);
    if (!SPLITS.has(task.split)) throw new TypeError(`selection.tasks[${index}].split is unsupported`);
    splits.add(task.split);
    if (task.skill_hint !== '') safeIdentifier(task.skill_hint, `selection.tasks[${index}].skill_hint`);
  }
  if (!splits.has('train') || (!splits.has('val') && !splits.has('test'))) {
    throw new TypeError('selection must include train and held-out val or test tasks');
  }
  return selection;
}

export function buildSkillOptTaskDraft(memoryExport, selection) {
  validateMemoryExport(memoryExport);
  validateMemorySkillOptSelection(selection);
  const claims = new Map(memoryExport.claims.map((claim) => [claim.id, claim]));
  const selectedClaims = [];
  const tasks = selection.tasks.map((selected) => {
    const claim = claims.get(selected.memory_id);
    if (!claim) throw new TypeError(`selected memory ${selected.memory_id} is absent from the export`);
    validateSelectedClaim(claim, selection.memory_project_id);
    selectedClaims.push(claim);
    const intent = claim.next_action || claim.title;
    const context = claim.summary;
    assertPublicSafeText(intent, `memory ${claim.id} intent`);
    assertPublicSafeText(context, `memory ${claim.id} context`);
    return {
      id: `memory-${claim.id.slice(4)}`,
      project: selection.skillopt_project,
      intent: boundedText(intent, `memory ${claim.id} intent`, 4096),
      context_excerpt: boundedText(context, `memory ${claim.id} context`, 4096),
      system: '',
      attempted_solution: '',
      outcome: claim.state === 'verified_done' ? 'success' : claim.state === 'blocked' ? 'fail' : 'unknown',
      reference_kind: 'none',
      reference: '',
      judge: {},
      tags: ['agoragentic-memory', `memory-${claim.type}`],
      source_sessions: [],
      split: selected.split,
      origin: 'real',
      derived_from: '',
      skill_hint: selected.skill_hint,
    };
  });
  const selectedIds = selection.tasks.map((item) => item.memory_id);
  return {
    format: SKILLOPT_TASK_FORMAT,
    project: selection.skillopt_project,
    transcript_source: 'agoragentic-memory-export',
    n_sessions: 0,
    target_skill_path: selection.target_skill_path.replaceAll('\\', '/'),
    reviewed: false,
    tasks,
    agoragentic_provenance: {
      schema: 'agoragentic.memory-skillopt.provenance.v1',
      selected_memory_claims_hash: hashValue(selectedClaims.map(publicClaimProjection)),
      memory_project_hash: hashString(selection.memory_project_id),
      selected_memory_ids: selectedIds,
      compatibility: {
        agoragentic_memory_version: SUPPORTED_MEMORY_VERSION,
        agoragentic_memory_revision: SUPPORTED_MEMORY_REVISION,
        skillopt_version: SKILLOPT_COMPATIBILITY_VERSION,
        skillopt_revision: SKILLOPT_COMPATIBILITY_REVISION,
      },
      truth_boundary: {
        memory_export_signature_verified: false,
        source_revision_proven_by_export: false,
        task_text_owner_reviewed: false,
        raw_events_retained: false,
        raw_evidence_retained: false,
      },
      authority_boundary: {
        call_provider: false,
        run_optimization: false,
        adopt_skill: false,
        publish_skill: false,
        spend: false,
      },
    },
  };
}

function publicClaimProjection(claim) {
  return {
    id: claim.id,
    type: claim.type,
    state: claim.state,
    title: claim.title,
    summary: claim.summary,
    next_action: claim.next_action ?? null,
    sensitivity: claim.sensitivity,
    evidence_total: claim.evidence_total,
    evidence_reference_hashes: claim.evidence.map(hashValue).sort(),
  };
}

function validateMemoryExport(value) {
  requireBoundedJson(value, 'memory export', 4 * 1024 * 1024);
  exactKeys(value, [
    'schema', 'generated_at', 'authority', 'scope', 'limits', 'excludes',
    'truncation_possible', 'repositories', 'claims', 'events',
  ], 'memory export');
  if (value.schema !== MEMORY_EXPORT_SCHEMA
    || value.authority !== 'index_only_verify_sources'
    || value.scope !== 'bounded_current_state') {
    throw new TypeError('memory export boundary is unsupported');
  }
  if (!Array.isArray(value.claims) || value.claims.length > 2000 || !Array.isArray(value.events)) {
    throw new TypeError('memory export claims/events are malformed');
  }
  const claimIds = new Set();
  for (const claim of value.claims) {
    if (!claim || typeof claim !== 'object' || Array.isArray(claim) || !MEMORY_ID.test(claim.id || '')) {
      throw new TypeError('memory export contains a malformed claim identity');
    }
    if (claimIds.has(claim.id)) throw new TypeError(`memory export contains duplicate claim identity ${claim.id}`);
    claimIds.add(claim.id);
  }
}

function validateSelectedClaim(claim, projectId) {
  if (!claim || typeof claim !== 'object' || Array.isArray(claim)) throw new TypeError('selected claim is malformed');
  if (!MEMORY_ID.test(claim.id || '') || claim.project_id !== projectId) {
    throw new TypeError(`selected memory ${String(claim.id || 'unknown')} has the wrong project identity`);
  }
  if (claim.sensitivity !== 'public') throw new TypeError(`selected memory ${claim.id} is not public`);
  if (!ALLOWED_TYPES.has(claim.type)) throw new TypeError(`selected memory ${claim.id} is not a task-like claim`);
  if (!Number.isInteger(claim.evidence_total) || claim.evidence_total < 1 || !Array.isArray(claim.evidence) || claim.evidence.length < 1) {
    throw new TypeError(`selected memory ${claim.id} has no evidence reference`);
  }
  boundedText(claim.title, `memory ${claim.id} title`, 256);
  boundedText(claim.summary, `memory ${claim.id} summary`, 16 * 1024);
  if (claim.next_action !== null && claim.next_action !== undefined && claim.next_action !== '') {
    boundedText(claim.next_action, `memory ${claim.id} next_action`, 4096);
  }
}

function assertPublicSafeText(value, label) {
  const text = boundedText(value, label, 16 * 1024);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw new TypeError(`${label} contains control characters`);
  }
  const match = SECRET_PATTERNS.find((pattern) => pattern.test(text));
  if (match) throw new TypeError(`${label} contains secret-shaped or instruction-like text`);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  if (stableStringify(actual) !== stableStringify([...expected].sort())) {
    throw new TypeError(`${label} contains missing or unknown fields`);
  }
}

function boundedText(value, label, maximum) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw new TypeError(`${label} must be a non-empty string of at most ${maximum} characters`);
  }
  return value;
}

function safeIdentifier(value, label) {
  const text = boundedText(value, label, 128);
  if (!SAFE_IDENTIFIER.test(text)) throw new TypeError(`${label} must be a bounded public-safe identifier`);
  return text;
}

function requireBoundedJson(value, label, maximum) {
  let serialized;
  try { serialized = JSON.stringify(value); } catch { throw new TypeError(`${label} must be JSON-serializable`); }
  if (Buffer.byteLength(serialized, 'utf8') > maximum) throw new RangeError(`${label} exceeds ${maximum} bytes`);
}

function hashString(value) {
  return `sha256:${createHash('sha256').update(String(value), 'utf8').digest('hex')}`;
}

function hashValue(value) {
  return hashString(stableStringify(value));
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}
