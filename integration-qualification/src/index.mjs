import { createHash } from 'node:crypto';
import { types } from 'node:util';

export const QUALIFICATION_LEVELS = Object.freeze([
  'research_only',
  'metadata_mapping',
  'source_adapter',
  'policy_enforcement',
  'runtime_compatibility',
  'exact_runtime_verification',
  'hosted_availability',
  'production_activation',
]);

export const EVIDENCE_CLASSES = Object.freeze([
  'official_metadata',
  'static_source',
  'local_test',
  'artifact_digest',
  'host_runtime',
  'restricted_runtime',
  'hosted_observation',
  'production_observation',
  'human_decision',
]);

const LEVEL_RULES = Object.freeze({
  research_only: Object.freeze([
    ['official_project_identified', ['official_metadata']],
  ]),
  metadata_mapping: Object.freeze([
    ['metadata_mapping_tested', ['local_test', 'host_runtime', 'restricted_runtime']],
  ]),
  source_adapter: Object.freeze([
    ['source_adapter_tested', ['local_test', 'host_runtime', 'restricted_runtime']],
  ]),
  policy_enforcement: Object.freeze([
    ['policy_boundary_observed', ['host_runtime', 'restricted_runtime']],
  ]),
  runtime_compatibility: Object.freeze([
    ['immutable_release_pin_verified', ['artifact_digest']],
    ['exact_host_artifact_loaded', ['host_runtime', 'restricted_runtime']],
    ['compatibility_matrix_passed', ['host_runtime', 'restricted_runtime']],
  ]),
  exact_runtime_verification: Object.freeze([
    ['restricted_exact_runtime_observed', ['restricted_runtime']],
  ]),
  hosted_availability: Object.freeze([
    ['hosted_endpoint_observed', ['hosted_observation', 'production_observation']],
  ]),
  production_activation: Object.freeze([
    ['production_activation_observed', ['production_observation']],
    ['owner_promotion_approved', ['human_decision']],
  ]),
});

const LEVEL_PREREQUISITES = Object.freeze({
  research_only: Object.freeze([]),
  metadata_mapping: Object.freeze(['research_only']),
  source_adapter: Object.freeze(['metadata_mapping']),
  policy_enforcement: Object.freeze(['source_adapter']),
  runtime_compatibility: Object.freeze(['source_adapter']),
  exact_runtime_verification: Object.freeze(['runtime_compatibility']),
  hosted_availability: Object.freeze(['exact_runtime_verification']),
  production_activation: Object.freeze(['hosted_availability']),
});

const BOUNDARY_KEYS = Object.freeze([
  'credentials_used',
  'paid_provider_calls',
  'production_deployed',
  'package_published',
  'outreach_performed',
  'public_compatibility_claimed',
  'wallet_mutated',
  'settlement_mutated',
  'trust_mutated',
  'ranking_mutated',
]);
const PACKET_INPUT_KEYS = Object.freeze([
  'integration_id',
  'declared_level',
  'generated_at',
  'subject',
  'release',
  'release_observation',
  'observations',
  'promotion_blockers',
  'boundaries',
]);
const PACKET_KEYS = Object.freeze([
  'schema',
  'packet_version',
  'integration_id',
  'generated_at',
  'subject',
  'release',
  'release_observation',
  'observations',
  'promotion_blockers',
  'qualification',
  'boundaries',
  'evidence_hash',
]);
const SUBJECT_KEYS = Object.freeze(['project', 'repository']);
const RELEASE_KEYS = Object.freeze([
  'tag',
  'commit',
  'asset_name',
  'asset_sha256',
  'asset_size_bytes',
  'asset_url',
]);
const RELEASE_OBSERVATION_KEYS = Object.freeze([
  'status',
  'pinned_tag',
  'pinned_commit',
  'observed_latest_tag',
  'observed_latest_commit',
  'observed_at',
  'auto_update',
  'pin_changed',
  'binary_executed',
  'promotion_changed',
]);
const OBSERVATION_KEYS = Object.freeze(['status', 'proof_class', 'evidence_refs', 'summary']);
const OBSERVATION_STATUSES = Object.freeze(['passed', 'failed', 'unknown']);
const RELEASE_OBSERVATION_STATUSES = Object.freeze(['current', 'update_available']);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const EVIDENCE_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/;
const MAX_ARRAY_INDEX = 2 ** 32 - 2;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 10_000;
const MAX_PUBLIC_STRING_LENGTH = 4096;
const SECRET_LIKE_PATTERNS = Object.freeze([
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\b(?:amk_|sk-|sk_live_|sk_test_|rk_live_|rk_test_|whsec_|gh[pousr]_|github_pat_|glpat[-_]|glrt-|glft-|gldt-|npm_[A-Za-z0-9][A-Za-z0-9_-]{23,}|hf_[A-Za-z0-9][A-Za-z0-9_-]{23,}|pypi-|dop_v1_|shpat_|shpca_|shppa_|shpss_|xox[bcaprs]-)[A-Za-z0-9._-]{8,}/i,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bAIza[A-Za-z0-9_-]{20,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP |ENCRYPTED )?[A-Z ]*PRIVATE KEY-----/i,
  /\b(?:api[_ -]?key|account[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password|authorization)\b\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/i,
]);
const PRIVATE_PATH_PATTERN = /(?:(?:^|[\s("'`=\[{},;])(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/]|\/\/[^/\s]+(?:\/|$)|~[\\/]|\/(?!\/)[^\s"'`<>\[\]{}(),;]+|file:\/\/)|:[A-Za-z]:[\\/]|:\\\\[^\\/\s]+[\\/]|:\/(?!\/)[^\s"'`<>\[\]{}(),;]+)/i;
const CREDENTIALLESS_HTTPS_URI_PATTERN = /^https:\/\/[^/?#@\s]+(?:[/?#]|$)/i;

function isRecord(value) {
  if (value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || types.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownDataValue(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && Object.hasOwn(descriptor, 'value')
    ? descriptor.value
    : undefined;
}

function isArrayIndexKey(key, length) {
  if (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isInteger(index)
    && index >= 0
    && index <= MAX_ARRAY_INDEX
    && index < length
    && String(index) === key;
}

function validateArrayShape(value, path) {
  if (!Array.isArray(value)) return [`${path} must be an array`];
  if (types.isProxy(value)) return [`${path} must not be a Proxy`];
  const errors = [];
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (!Number.isSafeInteger(lengthDescriptor?.value)
    || lengthDescriptor.value < 0
    || lengthDescriptor.value > MAX_JSON_NODES) {
    return [`${path} exceeds the JSON node limit`];
  }
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    errors.push(`${path} must use the standard Array prototype`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !isArrayIndexKey(key, value.length)) {
      errors.push(`${path} contains a non-index own property`);
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      errors.push(`${path}[${key}] must be an enumerable data property`);
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) errors.push(`${path}[${index}] is required`);
  }
  return errors;
}

function snapshotJsonDataInner(value, path, state, depth) {
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES) throw new TypeError(`${path} exceeds the JSON node limit`);
  if (depth > MAX_JSON_DEPTH) throw new TypeError(`${path} exceeds the JSON depth limit`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value === undefined || typeof value !== 'object') {
    throw new TypeError(`${path} must contain only JSON values`);
  }
  if (types.isProxy(value)) throw new TypeError(`${path} must not be a Proxy`);
  if (state.ancestors.has(value)) throw new TypeError(`${path} must not contain a cycle`);

  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const errors = validateArrayShape(value, path);
      if (errors.length > 0) throw new TypeError(errors.join('; '));
      const clone = [];
      for (let index = 0; index < value.length; index += 1) {
        clone.push(snapshotJsonDataInner(
          ownDataValue(value, String(index)),
          `${path}[${index}]`,
          state,
          depth + 1,
        ));
      }
      return clone;
    }
    if (!isRecord(value)) throw new TypeError(`${path} must use a plain object`);
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length > MAX_JSON_NODES - state.nodes) {
      throw new TypeError(`${path} exceeds the JSON node limit`);
    }
    for (const key of ownKeys) {
      if (typeof key !== 'string') throw new TypeError(`${path} contains a symbol own property`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError(`${path} contains an accessor or non-enumerable property`);
      }
    }
    const clone = Object.create(null);
    for (const key of ownKeys) {
      clone[key] = snapshotJsonDataInner(
        ownDataValue(value, key),
        `${path}.<field>`,
        state,
        depth + 1,
      );
    }
    return clone;
  } finally {
    state.ancestors.delete(value);
  }
}

export function snapshotJsonData(value, path = '$') {
  return snapshotJsonDataInner(value, path, { ancestors: new WeakSet(), nodes: 0 }, 0);
}

function publicSafetyErrors(value, path, errors) {
  if (typeof value === 'string') {
    if (value.length > MAX_PUBLIC_STRING_LENGTH) {
      errors.push(`${path} exceeds the public-safe string limit`);
    }
    if (/\u0000|[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) {
      errors.push(`${path} contains unsupported control characters`);
    }
    if (SECRET_LIKE_PATTERNS.some((pattern) => pattern.test(value))) {
      errors.push(`${path} contains credential-like text`);
    }
    if (PRIVATE_PATH_PATTERN.test(value)) {
      errors.push(`${path} contains a local or private path`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => publicSafetyErrors(entry, `${path}[${index}]`, errors));
    return;
  }
  if (isRecord(value)) {
    for (const key of Object.keys(value)) {
      const keyErrors = [];
      publicSafetyErrors(key, `${path} property name`, keyErrors);
      if (keyErrors.length > 0) {
        errors.push(...keyErrors);
        continue;
      }
      publicSafetyErrors(ownDataValue(value, key), `${path}.<field>`, errors);
    }
  }
}

export function snapshotPublicSafeJson(value, path = '$') {
  const snapshot = snapshotJsonData(value, path);
  const errors = [];
  publicSafetyErrors(snapshot, path, errors);
  if (errors.length > 0) throw new TypeError(errors.join('; '));
  return snapshot;
}

function sortCanonical(value, path = '$') {
  if (Array.isArray(value)) {
    const errors = validateArrayShape(value, path);
    if (errors.length > 0) throw new TypeError(errors.join('; '));
    return value.map((entry, index) => sortCanonical(entry, `${path}[${index}]`));
  }
  if (isRecord(value)) {
    const errors = validateObjectShape(
      value,
      path,
      Object.getOwnPropertyNames(value),
      [],
    );
    if (errors.length > 0) throw new TypeError(errors.join('; '));
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortCanonical(ownDataValue(value, key), `${path}.<field>`)]),
    );
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new TypeError(`${path} must contain only JSON values`);
}

export function stableStringify(value) {
  return JSON.stringify(sortCanonical(snapshotJsonData(value)));
}

export function sha256Ref(value) {
  const bytes = typeof value === 'string' ? value : stableStringify(value);
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function fieldPath(prefix, field) {
  return prefix.length > 0 ? `${prefix}.${field}` : field;
}

function validateObjectShape(value, path, allowedKeys, requiredKeys = allowedKeys) {
  if (!isRecord(value)) return [`${path} must be an object`];
  const errors = [];
  for (const key of requiredKeys) {
    if (!Object.hasOwn(value, key)) errors.push(`${fieldPath(path, key)} is required`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      errors.push(`${path} contains a symbol own property`);
      continue;
    }
    if (!allowedKeys.includes(key)) {
      errors.push(`${path}.<field> is not allowed`);
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      errors.push(`${fieldPath(path, key)} must be an enumerable data property`);
    }
  }
  return errors;
}

function isDateTime(value) {
  if (typeof value !== 'string') return false;
  const match = DATE_TIME_PATTERN.exec(value);
  if (match === null || Number.isNaN(Date.parse(value))) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText,
    offsetSign, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1
    && month <= 12
    && day >= 1
    && day <= daysInMonth[month - 1]
    && hour <= 23
    && minute <= 59
    && second <= 59
    && (offsetSign === undefined
      || (Number(offsetHourText) <= 23 && Number(offsetMinuteText) <= 59));
}

function isHttpsUri(value) {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_PUBLIC_STRING_LENGTH
    || /\s/.test(value)
    || !CREDENTIALLESS_HTTPS_URI_PATTERN.test(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:'
      && parsed.hostname !== ''
      && parsed.username === ''
      && parsed.password === '';
  } catch {
    return false;
  }
}

function validateSubject(subject, path = 'subject') {
  const errors = validateObjectShape(subject, path, SUBJECT_KEYS);
  if (!isRecord(subject)) return errors;
  if (typeof subject.project !== 'string'
    || subject.project.trim().length === 0
    || subject.project.length > 200) {
    errors.push(`${fieldPath(path, 'project')} must be a non-empty string`);
  }
  if (!isHttpsUri(subject.repository)) {
    errors.push(`${fieldPath(path, 'repository')} must be an HTTPS URI without credentials`);
  }
  return errors;
}

function validateRelease(release, path = 'release') {
  const errors = validateObjectShape(
    release,
    path,
    RELEASE_KEYS,
  );
  if (!isRecord(release)) return errors;
  if (typeof release.tag !== 'string'
    || release.tag.trim().length === 0
    || release.tag.length > 200
    || /[\r\n]/.test(release.tag)) {
    errors.push(`${fieldPath(path, 'tag')} must be a non-empty string`);
  }
  if (typeof release.commit !== 'string' || !COMMIT_PATTERN.test(release.commit)) {
    errors.push(`${fieldPath(path, 'commit')} must be a lowercase 40-character commit hash`);
  }
  if (typeof release.asset_name !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/.test(release.asset_name)) {
    errors.push(`${fieldPath(path, 'asset_name')} must be a non-empty string`);
  }
  if (typeof release.asset_sha256 !== 'string' || !SHA256_PATTERN.test(release.asset_sha256)) {
    errors.push(`${fieldPath(path, 'asset_sha256')} must be a lowercase SHA-256 digest`);
  }
  if (!Number.isSafeInteger(release.asset_size_bytes) || release.asset_size_bytes < 1) {
    errors.push(`${fieldPath(path, 'asset_size_bytes')} must be a positive safe integer`);
  }
  if (!isHttpsUri(release.asset_url)) {
    errors.push(`${fieldPath(path, 'asset_url')} must be an HTTPS URI without credentials`);
  }
  return errors;
}

function validateReleaseObservation(releaseObservation, release, path = 'release_observation') {
  const errors = validateObjectShape(
    releaseObservation,
    path,
    RELEASE_OBSERVATION_KEYS,
  );
  if (!isRecord(releaseObservation)) return errors;
  if (!RELEASE_OBSERVATION_STATUSES.includes(releaseObservation.status)) {
    errors.push(`${fieldPath(path, 'status')} is invalid`);
  }
  for (const key of ['pinned_tag', 'observed_latest_tag']) {
    if (typeof releaseObservation[key] !== 'string'
      || releaseObservation[key].length === 0
      || releaseObservation[key].length > 200) {
      errors.push(`${fieldPath(path, key)} must be a non-empty string`);
    }
  }
  for (const key of ['pinned_commit', 'observed_latest_commit']) {
    if (typeof releaseObservation[key] !== 'string'
      || !COMMIT_PATTERN.test(releaseObservation[key])) {
      errors.push(`${fieldPath(path, key)} must be a lowercase 40-character commit hash`);
    }
  }
  if (!isDateTime(releaseObservation.observed_at)) {
    errors.push(`${fieldPath(path, 'observed_at')} must be an RFC 3339 date-time`);
  }
  for (const key of ['auto_update', 'pin_changed', 'binary_executed', 'promotion_changed']) {
    if (releaseObservation[key] !== false) {
      errors.push(`${fieldPath(path, key)} must be false`);
    }
  }

  if (isRecord(release)) {
    if (releaseObservation.pinned_tag !== release.tag) {
      errors.push(`${fieldPath(path, 'pinned_tag')} must match release.tag`);
    }
    if (releaseObservation.pinned_commit !== release.commit) {
      errors.push(`${fieldPath(path, 'pinned_commit')} must match release.commit`);
    }
  }

  const expectedStatus = releaseObservation.pinned_tag === releaseObservation.observed_latest_tag
    && releaseObservation.pinned_commit === releaseObservation.observed_latest_commit
    ? 'current'
    : 'update_available';
  if (RELEASE_OBSERVATION_STATUSES.includes(releaseObservation.status)
    && releaseObservation.status !== expectedStatus) {
    errors.push(`${fieldPath(path, 'status')} does not match the observed release identity`);
  }
  return errors;
}

function validateExactShape(actual, expected, path) {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [`${path} must be an array`];
    const errors = validateArrayShape(actual, path);
    if (actual.length !== expected.length) errors.push(`${path} has an unexpected length`);
    for (let index = 0; index < Math.min(actual.length, expected.length); index += 1) {
      if (Object.hasOwn(actual, index)) {
        const descriptor = Object.getOwnPropertyDescriptor(actual, String(index));
        if (Object.hasOwn(descriptor, 'value')) {
          errors.push(...validateExactShape(
            descriptor.value,
            expected[index],
            `${path}[${index}]`,
          ));
        }
      }
    }
    return errors;
  }
  if (isRecord(expected)) {
    return validateObjectShape(actual, path, Object.keys(expected), Object.keys(expected))
      .concat(isRecord(actual)
        ? Object.keys(expected).flatMap((key) => {
          if (!Object.hasOwn(actual, key)) return [];
          const descriptor = Object.getOwnPropertyDescriptor(actual, key);
          return Object.hasOwn(descriptor, 'value')
            ? validateExactShape(descriptor.value, expected[key], fieldPath(path, key))
            : [];
        })
        : []);
  }
  return Object.is(actual, expected) ? [] : [`${path} does not match packet evidence`];
}

function isPrerequisiteOf(candidate, level) {
  const directPrerequisites = LEVEL_PREREQUISITES[level] ?? [];
  return directPrerequisites.includes(candidate)
    || directPrerequisites.some((prerequisite) => isPrerequisiteOf(candidate, prerequisite));
}

function strongestQualifiedAncestor(level, qualifiedLevels) {
  return [...qualifiedLevels]
    .reverse()
    .find((candidate) => isPrerequisiteOf(candidate, level)) ?? null;
}

function maximalQualifiedLevels(qualifiedLevels) {
  return qualifiedLevels.filter(
    (level) => !qualifiedLevels.some(
      (candidate) => candidate !== level && isPrerequisiteOf(level, candidate),
    ),
  );
}

function observationPasses(observation, allowedProofClasses) {
  const evidenceRefs = isRecord(observation)
    ? ownDataValue(observation, 'evidence_refs')
    : undefined;
  return isRecord(observation)
    && ownDataValue(observation, 'status') === 'passed'
    && allowedProofClasses.includes(ownDataValue(observation, 'proof_class'))
    && Array.isArray(evidenceRefs)
    && validateArrayShape(evidenceRefs, 'observation.evidence_refs').length === 0
    && evidenceRefs.length > 0
    && evidenceRefs.every((ref) => typeof ref === 'string' && ref.trim().length > 0);
}

function validateBoundaries(boundaries) {
  const errors = [];
  if (!isRecord(boundaries)) return ['boundaries must be an object'];
  errors.push(...validateObjectShape(boundaries, 'boundaries', BOUNDARY_KEYS));
  for (const key of BOUNDARY_KEYS) {
    if (typeof boundaries[key] !== 'boolean') errors.push(`boundaries.${key} must be boolean`);
  }
  return errors;
}

function validateObservations(observations) {
  const errors = [];
  if (!isRecord(observations)) return ['observations must be an object'];
  const observationMapErrors = validateObjectShape(
    observations,
    'observations',
    Object.getOwnPropertyNames(observations),
    [],
  );
  errors.push(...observationMapErrors);
  if (Object.getOwnPropertyNames(observations).length > 256) {
    errors.push('observations must contain at most 256 entries');
  }
  for (const id of Object.getOwnPropertyNames(observations)) {
    if (!/^[a-z][a-z0-9_]{0,99}$/.test(id)) {
      errors.push(`observations.${id} has an unsupported identifier`);
      continue;
    }
    const observation = ownDataValue(observations, id);
    if (!isRecord(observation)) {
      errors.push(`observations.${id} must be an object`);
      continue;
    }
    errors.push(...validateObjectShape(
      observation,
      `observations.${id}`,
      OBSERVATION_KEYS,
      ['status', 'proof_class', 'evidence_refs'],
    ));
    const observedStatus = ownDataValue(observation, 'status');
    const observedProofClass = ownDataValue(observation, 'proof_class');
    if (!OBSERVATION_STATUSES.includes(observedStatus)) {
      errors.push(`observations.${id}.status is invalid`);
    }
    if (!EVIDENCE_CLASSES.includes(observedProofClass)) {
      errors.push(`observations.${id}.proof_class is invalid`);
    }
    const evidenceRefs = ownDataValue(observation, 'evidence_refs');
    const evidenceRefShapeErrors = Array.isArray(evidenceRefs)
      ? validateArrayShape(evidenceRefs, `observations.${id}.evidence_refs`)
      : [];
    errors.push(...evidenceRefShapeErrors);
    if (!Array.isArray(evidenceRefs)
      || evidenceRefShapeErrors.length > 0
      || evidenceRefs.length === 0
      || evidenceRefs.length > 256
      || evidenceRefs.some((ref) => typeof ref !== 'string'
        || ref.trim().length === 0
        || ref.length > MAX_PUBLIC_STRING_LENGTH)
      || new Set(evidenceRefs).size !== evidenceRefs.length) {
      errors.push(`observations.${id}.evidence_refs must contain 1 to 256 bounded strings`);
    }
    if (Object.hasOwn(observation, 'summary')
      && (typeof ownDataValue(observation, 'summary') !== 'string'
        || ownDataValue(observation, 'summary').length > MAX_PUBLIC_STRING_LENGTH)) {
      errors.push(`observations.${id}.summary must be a bounded string`);
    }
  }
  return errors;
}

function referencesUnresolvedObservation(observations, id) {
  if (!isRecord(observations) || !Object.hasOwn(observations, id)) return false;
  const observation = ownDataValue(observations, id);
  return isRecord(observation) && ownDataValue(observation, 'status') !== 'passed';
}

export function evaluateQualification(record) {
  record = snapshotPublicSafeJson(record, 'qualification record');
  if (!isRecord(record)) throw new TypeError('qualification record must be an object');
  for (const key of ['declared_level', 'observations', 'promotion_blockers', 'boundaries']) {
    if (!Object.hasOwn(record, key)) {
      throw new TypeError(`qualification record.${key} is required`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`qualification record.${key} must be an enumerable data property`);
    }
  }
  const declaredLevel = ownDataValue(record, 'declared_level');
  const observations = ownDataValue(record, 'observations');
  const promotionBlockers = ownDataValue(record, 'promotion_blockers');
  const boundaries = ownDataValue(record, 'boundaries');
  if (!QUALIFICATION_LEVELS.includes(declaredLevel)) {
    throw new TypeError('declared_level must be a known qualification level');
  }
  if (!isRecord(observations)) {
    throw new TypeError('observations must be an object');
  }
  const observationErrors = validateObservations(observations);
  if (observationErrors.length > 0) throw new TypeError(observationErrors.join('; '));
  const blockerShapeErrors = Array.isArray(promotionBlockers)
    ? validateArrayShape(promotionBlockers, 'promotion_blockers')
    : [];
  if (!Array.isArray(promotionBlockers)
    || blockerShapeErrors.length > 0
    || promotionBlockers.length > 256
    || new Set(promotionBlockers).size !== promotionBlockers.length
    || promotionBlockers.some((id) => typeof id !== 'string'
      || !/^[a-z][a-z0-9_]{0,99}$/.test(id)
      || !referencesUnresolvedObservation(observations, id))) {
    throw new TypeError('promotion_blockers must contain up to 256 unique unresolved observation identifiers');
  }

  const levelResults = {};
  const qualifiedLevels = [];
  for (const level of QUALIFICATION_LEVELS) {
    const requirements = LEVEL_RULES[level];
    const unmetByObservation = new Map();
    for (const prerequisite of LEVEL_PREREQUISITES[level]) {
      for (const unmet of levelResults[prerequisite].unmet) {
        unmetByObservation.set(unmet.observation_id, unmet);
      }
    }
    for (const [observationId, allowedProofClasses] of requirements) {
      const observation = Object.hasOwn(observations, observationId)
        ? ownDataValue(observations, observationId)
        : undefined;
      if (!observationPasses(observation, allowedProofClasses)) {
        unmetByObservation.set(observationId, {
          observation_id: observationId,
          allowed_proof_classes: [...allowedProofClasses],
          observed_status: isRecord(observation)
            ? ownDataValue(observation, 'status') ?? 'missing'
            : 'missing',
          observed_proof_class: isRecord(observation)
            ? ownDataValue(observation, 'proof_class') ?? null
            : null,
        });
      }
    }
    const unmet = [...unmetByObservation.values()];
    const qualified = unmet.length === 0;
    levelResults[level] = { qualified, unmet };
    if (qualified) qualifiedLevels.push(level);
  }

  const evidenceLevels = maximalQualifiedLevels(qualifiedLevels);
  const evidenceLevel = evidenceLevels.length === 1 ? evidenceLevels[0] : null;
  const boundaryErrors = validateBoundaries(boundaries);
  const violatedBoundaries = BOUNDARY_KEYS.filter(
    (key) => isRecord(boundaries) && ownDataValue(boundaries, key) === true,
  );
  const hardStopViolated = boundaryErrors.length > 0 || violatedBoundaries.length > 0;
  const regressionDetected = !levelResults[declaredLevel].qualified;
  const evidencedPromotionLevels = hardStopViolated || regressionDetected
    ? []
    : evidenceLevels.filter(
      (level) => level !== declaredLevel && !isPrerequisiteOf(level, declaredLevel),
    );
  const promotionBlocked = promotionBlockers.length > 0;
  const promotionCandidateLevels = promotionBlocked ? [] : evidencedPromotionLevels;
  const promotionCandidate = promotionCandidateLevels.length === 1
    ? promotionCandidateLevels[0]
    : null;
  const promotionAvailable = evidencedPromotionLevels.length > 0;
  const effectiveLevel = regressionDetected
    ? strongestQualifiedAncestor(declaredLevel, qualifiedLevels)
    : declaredLevel;

  return {
    declared_level: declaredLevel,
    evidence_level: evidenceLevel,
    evidence_levels: evidenceLevels,
    effective_level: effectiveLevel,
    qualified_levels: qualifiedLevels,
    level_results: levelResults,
    promotion_candidate_level: promotionCandidate,
    promotion_candidate_levels: promotionCandidateLevels,
    promotion_blocked: promotionBlocked,
    promotion_blockers: [...promotionBlockers],
    human_promotion_required: promotionAvailable,
    auto_promoted: false,
    regression_detected: regressionDetected,
    hard_stop_violated: hardStopViolated,
    violated_boundaries: violatedBoundaries,
    validation_errors: boundaryErrors,
  };
}

export function observeReleaseDrift(input) {
  input = snapshotPublicSafeJson(input, 'release observation input');
  if (!isRecord(input)) {
    throw new TypeError('release observation input must be an object');
  }
  const inputErrors = validateObjectShape(
    input,
    'release observation input',
    ['pinned', 'observedLatest'],
  );
  if (inputErrors.length > 0) throw new TypeError(inputErrors.join('; '));
  for (const key of ['pinned', 'observedLatest']) {
    if (!Object.hasOwn(input, key)) {
      throw new TypeError(`release observation input.${key} is required`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`release observation input.${key} must be an enumerable data property`);
    }
  }
  const pinned = ownDataValue(input, 'pinned');
  const observedLatest = ownDataValue(input, 'observedLatest');
  if (!isRecord(pinned) || !isRecord(observedLatest)) {
    throw new TypeError('pinned and observedLatest release records are required');
  }
  const errors = validateObjectShape(pinned, 'pinned', ['tag', 'commit']);
  errors.push(...validateObjectShape(
    observedLatest,
    'observedLatest',
    ['tag', 'commit', 'observed_at'],
  ));
  const pinnedTag = ownDataValue(pinned, 'tag');
  const pinnedCommit = ownDataValue(pinned, 'commit');
  const observedLatestTag = ownDataValue(observedLatest, 'tag');
  const observedLatestCommit = ownDataValue(observedLatest, 'commit');
  const observedAt = ownDataValue(observedLatest, 'observed_at');
  for (const [path, value] of [
    ['pinned.tag', pinnedTag],
    ['observedLatest.tag', observedLatestTag],
  ]) {
    if (typeof value !== 'string' || value.trim().length === 0 || value.length > 200) {
      errors.push(`${path} must be a non-empty string`);
    }
  }
  for (const [path, value] of [
    ['pinned.commit', pinnedCommit],
    ['observedLatest.commit', observedLatestCommit],
  ]) {
    if (typeof value !== 'string' || !COMMIT_PATTERN.test(value)) {
      errors.push(`${path} must be a lowercase 40-character commit hash`);
    }
  }
  if (!isDateTime(observedAt)) {
    errors.push('observedLatest.observed_at must be an RFC 3339 date-time');
  }
  if (errors.length > 0) throw new TypeError(errors.join('; '));

  const sameTag = pinnedTag === observedLatestTag;
  const sameCommit = pinnedCommit === observedLatestCommit;
  return {
    status: sameTag && sameCommit ? 'current' : 'update_available',
    pinned_tag: pinnedTag,
    pinned_commit: pinnedCommit,
    observed_latest_tag: observedLatestTag,
    observed_latest_commit: observedLatestCommit,
    observed_at: observedAt,
    auto_update: false,
    pin_changed: false,
    binary_executed: false,
    promotion_changed: false,
  };
}

function assertPacketInput(input) {
  const errors = validateObjectShape(input, 'packet input', PACKET_INPUT_KEYS);
  if (!isRecord(input)) throw new TypeError(errors.join('; '));
  if (typeof input.integration_id !== 'string'
    || !/^[a-z][a-z0-9_-]{0,99}$/.test(input.integration_id)) {
    errors.push('integration_id must be a bounded lowercase identifier');
  }
  if (!QUALIFICATION_LEVELS.includes(input.declared_level)) {
    errors.push('declared_level must be a known qualification level');
  }
  if (!isDateTime(input.generated_at)) {
    errors.push('generated_at must be an RFC 3339 date-time');
  }
  errors.push(...validateSubject(input.subject));
  errors.push(...validateRelease(input.release));
  errors.push(...validateReleaseObservation(input.release_observation, input.release));
  errors.push(...validateObservations(input.observations));
  errors.push(...validateBoundaries(input.boundaries));
  if (errors.length > 0) throw new TypeError(errors.join('; '));
}

export function createQualificationEvidencePacket(input) {
  input = snapshotPublicSafeJson(input, 'packet input');
  assertPacketInput(input);
  const qualification = evaluateQualification(input);
  const packetBody = {
    schema: 'agoragentic.integration-qualification-evidence.v1',
    packet_version: 1,
    integration_id: input.integration_id,
    generated_at: input.generated_at,
    subject: structuredClone(input.subject),
    release: structuredClone(input.release),
    release_observation: structuredClone(input.release_observation),
    observations: structuredClone(input.observations),
    promotion_blockers: structuredClone(input.promotion_blockers),
    qualification,
    boundaries: structuredClone(input.boundaries),
  };
  const packet = {
    ...packetBody,
    evidence_hash: sha256Ref(packetBody),
  };
  const verification = verifyQualificationEvidencePacket(packet);
  if (!verification.ok) {
    throw new TypeError(`created packet is invalid: ${verification.errors.join('; ')}`);
  }
  return Object.freeze(packet);
}

export function verifyQualificationEvidencePacket(packet) {
  const errors = [];
  try {
    packet = snapshotPublicSafeJson(packet, 'packet');
  } catch (error) {
    return { ok: false, errors: [error.message], expected_hash: null };
  }
  if (!isRecord(packet)) return { ok: false, errors: ['packet must be an object'] };
  errors.push(...validateObjectShape(packet, 'packet', PACKET_KEYS));
  if (packet.schema !== 'agoragentic.integration-qualification-evidence.v1') {
    errors.push('packet.schema is not supported');
  }
  if (packet.packet_version !== 1) errors.push('packet.packet_version must be 1');
  if (typeof packet.integration_id !== 'string'
    || !/^[a-z][a-z0-9_-]{0,99}$/.test(packet.integration_id)) {
    errors.push('packet.integration_id must be a bounded lowercase identifier');
  }
  if (!isDateTime(packet.generated_at)) {
    errors.push('packet.generated_at must be an RFC 3339 date-time');
  }
  errors.push(...validateSubject(packet.subject, 'packet.subject'));
  errors.push(...validateRelease(packet.release, 'packet.release'));
  errors.push(...validateReleaseObservation(
    packet.release_observation,
    packet.release,
    'packet.release_observation',
  ));
  errors.push(...validateBoundaries(packet.boundaries));
  errors.push(...validateObservations(packet.observations));
  const blockerShapeErrors = Array.isArray(packet.promotion_blockers)
    ? validateArrayShape(packet.promotion_blockers, 'packet.promotion_blockers')
    : [];
  if (!Array.isArray(packet.promotion_blockers)
    || blockerShapeErrors.length > 0
    || packet.promotion_blockers.length > 256
    || new Set(packet.promotion_blockers).size !== packet.promotion_blockers.length
    || packet.promotion_blockers.some((id) => typeof id !== 'string'
      || !/^[a-z][a-z0-9_]{0,99}$/.test(id)
      || !referencesUnresolvedObservation(packet.observations, id))) {
    errors.push('packet.promotion_blockers must contain up to 256 unique unresolved observation identifiers');
  }
  if (!isRecord(packet.qualification)) errors.push('packet.qualification must be an object');
  if (typeof packet.evidence_hash !== 'string'
    || !EVIDENCE_HASH_PATTERN.test(packet.evidence_hash)) {
    errors.push('packet.evidence_hash must be a SHA-256 reference');
  }

  const { evidence_hash: observedHash, ...packetBody } = packet;
  let expectedHash = null;
  try {
    expectedHash = sha256Ref(packetBody);
    if (observedHash !== expectedHash) errors.push('packet.evidence_hash mismatch');
  } catch {
    errors.push('packet cannot be canonically hashed');
  }

  try {
    const recomputed = evaluateQualification({
      declared_level: packet.qualification?.declared_level,
      observations: packet.observations,
      promotion_blockers: packet.promotion_blockers,
      boundaries: packet.boundaries,
    });
    errors.push(...validateExactShape(packet.qualification, recomputed, 'packet.qualification'));
    if (stableStringify(recomputed) !== stableStringify(packet.qualification)) {
      errors.push('packet.qualification does not match packet evidence');
    }
  } catch (error) {
    errors.push(`packet qualification is invalid: ${error.message}`);
  }

  return { ok: errors.length === 0, errors, expected_hash: expectedHash };
}
