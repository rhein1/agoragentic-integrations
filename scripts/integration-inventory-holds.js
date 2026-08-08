'use strict';

const HOLD_KEYS = Object.freeze([
  'directory',
  'status',
  'reason',
  'owner',
  'tracking_ref',
  'review_by',
  'published',
  'external_compatibility_verified',
  'ready_for_manifest',
  'authority_granted',
]);
const HOLD_KEY_SET = new Set(HOLD_KEYS);
const DIRECTORY_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const TRACKING_REF_PATTERN = /^https:\/\/github\.com\/rhein1\/agoragentic-integrations\/(issues|pull)\/[0-9]+$/;
const MAX_HOLD_DAYS = 90;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isValidDateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validateInventoryHolds(manifest, options = {}) {
  const errors = [];
  const heldDirectories = new Set();
  const seenDirectories = new Set();
  const integrationDirectories = new Set(options.integrationDirectories || []);
  const representedDirectories = new Set(options.representedDirectories || []);
  const today = options.today || new Date().toISOString().slice(0, 10);
  const holds = manifest?.inventory_holds;

  if (!isValidDateOnly(today)) {
    return { errors: [`inventory hold validation date is invalid: ${today}`], heldDirectories };
  }
  if (!Array.isArray(holds)) {
    return { errors: ['integrations.json inventory_holds must be an array'], heldDirectories };
  }

  holds.forEach((hold, index) => {
    const prefix = `integrations.json inventory_holds[${index}]`;
    const startErrorCount = errors.length;
    if (!isPlainObject(hold)) {
      errors.push(`${prefix} must be an object`);
      return;
    }

    for (const key of HOLD_KEYS) {
      if (!(key in hold)) errors.push(`${prefix}.${key} is required`);
    }
    for (const key of Object.keys(hold)) {
      if (!HOLD_KEY_SET.has(key)) errors.push(`${prefix} contains unsupported field: ${key}`);
    }

    const directory = hold.directory;
    if (typeof directory !== 'string' || !DIRECTORY_PATTERN.test(directory)) {
      errors.push(`${prefix}.directory must be a safe top-level directory name`);
    } else {
      if (seenDirectories.has(directory)) errors.push(`${prefix}.directory is duplicated: ${directory}`);
      seenDirectories.add(directory);
      if (!integrationDirectories.has(directory)) errors.push(`${prefix}.directory does not exist as an integration: ${directory}`);
      if (representedDirectories.has(directory)) errors.push(`${prefix}.directory is already represented in integrations.json: ${directory}`);
    }

    if (hold.status !== 'unpublished_alpha') errors.push(`${prefix}.status must be unpublished_alpha`);
    if (typeof hold.reason !== 'string' || hold.reason.trim().length < 24) {
      errors.push(`${prefix}.reason must explain the temporary hold`);
    }
    if (hold.owner !== 'repository-maintainers') errors.push(`${prefix}.owner must be repository-maintainers`);
    if (typeof hold.tracking_ref !== 'string' || !TRACKING_REF_PATTERN.test(hold.tracking_ref)) {
      errors.push(`${prefix}.tracking_ref must identify a repository issue or pull request`);
    }
    if (!isValidDateOnly(hold.review_by)) {
      errors.push(`${prefix}.review_by must be a valid ISO date`);
    } else if (hold.review_by < today) {
      errors.push(`${prefix} expired on ${hold.review_by}`);
    } else {
      const holdTime = new Date(`${hold.review_by}T00:00:00.000Z`).getTime();
      const todayTime = new Date(`${today}T00:00:00.000Z`).getTime();
      if (holdTime - todayTime > MAX_HOLD_DAYS * 24 * 60 * 60 * 1000) {
        errors.push(`${prefix}.review_by exceeds the ${MAX_HOLD_DAYS}-day limit`);
      }
    }

    for (const field of ['published', 'external_compatibility_verified', 'ready_for_manifest', 'authority_granted']) {
      if (hold[field] !== false) errors.push(`${prefix}.${field} must remain false`);
    }

    if (errors.length === startErrorCount) heldDirectories.add(directory);
  });

  return { errors, heldDirectories };
}

module.exports = {
  HOLD_KEYS,
  MAX_HOLD_DAYS,
  isValidDateOnly,
  validateInventoryHolds,
};
