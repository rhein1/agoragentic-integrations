import { createHash } from 'node:crypto';

import { assertCanonicalJson, canonicalize, sha256Ref } from './canonical.mjs';
import {
  assertAllowedKeys,
  assertPlainObject,
  boundedInteger,
  deepFreeze,
  requireEnum,
  requireIsoDate,
  requireOpaqueRef,
  requireSha256Ref,
  requireString,
  safeEqual,
} from './util.mjs';

export const SKILLSPECTOR_ADMISSION_EVIDENCE_SCHEMA =
  'agoragentic.risk-fork.skillspector-admission-evidence.v1';
export const SKILLSPECTOR_REVIEWED_VERSION = '2.11.2';
export const SKILLSPECTOR_REVIEWED_SOURCE_REVISION =
  'git:69dcdfb74487d361ba4c811d088cfdea2ff3a9dc';
export const SKILLSPECTOR_REVIEWED_ARTIFACT_HASH =
  'sha256:9e0eb261d63e7ae92f94177a44aeb8fef5e0ceeaa4d09135780baf94cbc420ec';
export const SKILLSPECTOR_RULES_MANIFEST_SCHEMA =
  'agoragentic.risk-fork.skillspector-rules-manifest.v1';
export const SKILLSPECTOR_RUNTIME_CLOSURE_SCHEMA =
  'agoragentic.risk-fork.skillspector-runtime-closure.v1';

const REVIEWED_STATIC_ANALYZER_IDS = new Set([
  'static_patterns_prompt_injection',
  'static_patterns_data_exfiltration',
  'static_patterns_privilege_escalation',
  'static_patterns_supply_chain',
  'static_patterns_harmful_content',
  'static_patterns_excessive_agency',
  'static_patterns_output_handling',
  'static_patterns_system_prompt_leakage',
  'static_patterns_memory_poisoning',
  'static_patterns_tool_misuse',
  'static_patterns_rogue_agent',
  'static_patterns_agent_snooping',
  'static_patterns_anti_refusal',
  'static_patterns_ssrf',
  'static_patterns_deserialization',
  'static_yara',
]);

export const SKILLSPECTOR_ADMISSION_DIAGNOSTIC_CODES = Object.freeze({
  INVALID_INPUT: 'RISK_FORK_SKILLSPECTOR_INVALID_INPUT',
  REPORT_CONTRACT_INVALID: 'RISK_FORK_SKILLSPECTOR_REPORT_CONTRACT_INVALID',
  SCANNER_BINDING_MISMATCH: 'RISK_FORK_SKILLSPECTOR_SCANNER_BINDING_MISMATCH',
  EVIDENCE_HASH_MISMATCH: 'RISK_FORK_SKILLSPECTOR_EVIDENCE_HASH_MISMATCH',
  EXPECTED_BINDING_MISMATCH: 'RISK_FORK_SKILLSPECTOR_EXPECTED_BINDING_MISMATCH',
});

const REPORT_TOP_LEVEL_KEYS = Object.freeze([
  'skill',
  'risk_assessment',
  'components',
  'structured_summaries',
  'issues',
  'suppressed_count',
  'suppressed',
  'metadata',
  'execution_successful',
  'analysis_completeness',
]);
const METADATA_KEYS = Object.freeze([
  'has_executable_scripts',
  'skillspector_version',
  'llm_requested',
  'llm_available',
  'meta_analysis_applied',
  'inference_usage',
  'filtering_mode',
  'llm_calls_attempted',
  'llm_calls_succeeded',
  'llm_degraded',
  'llm_error',
  'transitive_targets_scanned',
  'transitive_bytes_scanned',
  'transitive_truncated',
  'transitive_truncation_reasons',
]);
const COMPLETENESS_KEYS = Object.freeze([
  'total_components',
  'scanned_components',
  'coverage_percent',
  'is_complete',
  'status',
  'execution_successful',
  'fully_inspected_files',
  'partially_inspected_files',
  'entirely_uninspected_files',
  'ledger_exceptions',
  'scope_exclusions',
  'analyzer_statuses',
  'references',
  'limitations',
  'findings_before_filtering',
  'findings_after_filtering',
]);
const ISSUE_KEYS = Object.freeze([
  'id',
  'finding_id',
  'category',
  'pattern',
  'severity',
  'confidence',
  'location',
  'finding',
  'explanation',
  'remediation',
  'code_snippet',
  'intent',
  'tags',
  'evidence',
  'match_fingerprint',
  'occurrences',
  'transitive_depth',
  'source_url',
  'source_identity',
  'source_digest',
]);
const COMPONENT_KEYS = Object.freeze([
  'path',
  'type',
  'lines',
  'executable',
  'size_bytes',
  'source_url',
  'source_identity',
  'source_digest',
]);
const INVOCATION_KEYS = Object.freeze([
  'input_mode',
  'format',
  'no_llm',
  'fail_on_incomplete',
  'recursive',
  'baseline',
  'use_shipped_baseline',
  'show_suppressed',
  'transitive',
  'custom_rules',
]);
const EVIDENCE_KEYS = Object.freeze([
  'schema',
  'subject',
  'binding',
  'scanner',
  'invocation',
  'network_enforcement',
  'report',
  'coverage',
  'result',
  'authority_flags',
  'evidence_hash',
]);
const REASON_CODES = Object.freeze([
  'skillspector_caution',
  'skillspector_clear',
  'skillspector_do_not_install',
  'skillspector_analyzer_incomplete',
  'skillspector_empty_scope',
  'skillspector_execution_failed',
  'skillspector_filtered_findings',
  'skillspector_findings_present',
  'skillspector_high_severity_finding',
  'skillspector_incomplete_coverage',
  'skillspector_ledger_exception',
  'skillspector_limitations_present',
  'skillspector_network_unverified',
  'skillspector_output_truncated',
  'skillspector_scope_exclusion',
  'skillspector_suppression_detected',
]);
const MAX_REPORT_BYTES = 8 * 1024 * 1024;
const MAX_REPORT_ITEMS = 20_000;
const SKILLSPECTOR_FINDING_OUTPUT_RECORD_LIMIT = 10_000;
const MAX_VALIDITY_MS = 24 * 60 * 60 * 1000;
const SEVERITIES = Object.freeze(['NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
const RECOMMENDATIONS = Object.freeze(['SAFE', 'CAUTION', 'DO_NOT_INSTALL']);
const OUTCOMES = Object.freeze(['clear', 'review', 'block', 'incomplete']);
const ANALYZER_STATUS_KEYS = Object.freeze([
  'analyzer_id',
  'status',
  'planned_work',
  'completed',
  'partial',
  'skipped',
  'failed',
  'unaccounted',
  'reason_code',
  'message',
]);
const ANALYZER_STATUS_REQUIRED_KEYS = Object.freeze([
  'analyzer_id',
  'status',
  'planned_work',
  'completed',
  'partial',
  'skipped',
  'failed',
  'unaccounted',
]);
const NO_LLM_DISABLED_ANALYZERS = new Set([
  'meta_analyzer',
  'semantic_security_discovery',
  'semantic_developer_intent',
  'semantic_quality_policy',
]);

export class SkillSpectorAdmissionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SkillSpectorAdmissionError';
    this.code = code;
  }
}

function admissionError(code, message) {
  return new SkillSpectorAdmissionError(code, message);
}

function requireFields(value, fields, label) {
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) {
      throw admissionError(
        SKILLSPECTOR_ADMISSION_DIAGNOSTIC_CODES.INVALID_INPUT,
        `${label} is incomplete`,
      );
    }
  }
}

function requireBoolean(value, field) {
  if (typeof value !== 'boolean') throw new TypeError(`${field} must be a boolean`);
  return value;
}

function requireArray(value, field, { maxItems = MAX_REPORT_ITEMS } = {}) {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new TypeError(`${field} must be an array of at most ${maxItems} items`);
  }
  return value;
}

function requireBoundedNumber(value, field, { min = 0, max = 100 } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new TypeError(`${field} must be a number between ${min} and ${max}`);
  }
  return value;
}

function rawSha256Ref(value) {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function normalizeInvocation(value) {
  assertAllowedKeys(value, INVOCATION_KEYS, 'SkillSpector invocation');
  requireFields(value, INVOCATION_KEYS, 'SkillSpector invocation');
  const normalized = {
    input_mode: requireEnum(
      value.input_mode,
      ['local_snapshot'],
      'SkillSpector invocation.input_mode',
    ),
    format: requireEnum(value.format, ['json'], 'SkillSpector invocation.format'),
    no_llm: requireBoolean(value.no_llm, 'SkillSpector invocation.no_llm'),
    fail_on_incomplete: requireBoolean(
      value.fail_on_incomplete,
      'SkillSpector invocation.fail_on_incomplete',
    ),
    recursive: requireBoolean(value.recursive, 'SkillSpector invocation.recursive'),
    baseline: requireBoolean(value.baseline, 'SkillSpector invocation.baseline'),
    use_shipped_baseline: requireBoolean(
      value.use_shipped_baseline,
      'SkillSpector invocation.use_shipped_baseline',
    ),
    show_suppressed: requireBoolean(
      value.show_suppressed,
      'SkillSpector invocation.show_suppressed',
    ),
    transitive: requireBoolean(value.transitive, 'SkillSpector invocation.transitive'),
    custom_rules: requireBoolean(value.custom_rules, 'SkillSpector invocation.custom_rules'),
  };
  if (!normalized.no_llm
    || !normalized.fail_on_incomplete
    || normalized.recursive
    || normalized.baseline
    || normalized.use_shipped_baseline
    || normalized.show_suppressed
    || normalized.transitive
    || normalized.custom_rules) {
    throw admissionError(
      SKILLSPECTOR_ADMISSION_DIAGNOSTIC_CODES.INVALID_INPUT,
      'SkillSpector admission requires the reviewed static, single-skill, no-suppression invocation',
    );
  }
  return normalized;
}

function normalizeNetworkEnforcement(value) {
  assertAllowedKeys(value, [
    'mode',
    'osv_mode',
    'evidence_ref',
    'evidence_hash',
  ], 'SkillSpector network enforcement');
  requireFields(value, [
    'mode',
    'osv_mode',
    'evidence_ref',
    'evidence_hash',
  ], 'SkillSpector network enforcement');
  const mode = requireEnum(
    value.mode,
    ['deny_all', 'unknown'],
    'SkillSpector network enforcement.mode',
  );
  const osvMode = requireEnum(
    value.osv_mode,
    ['bundled_fallback_only', 'unknown'],
    'SkillSpector network enforcement.osv_mode',
  );
  const evidenceRef = value.evidence_ref === null
    ? null
    : requireOpaqueRef(value.evidence_ref, 'SkillSpector network enforcement.evidence_ref');
  const evidenceHash = value.evidence_hash === null
    ? null
    : requireSha256Ref(value.evidence_hash, 'SkillSpector network enforcement.evidence_hash');
  if ((mode === 'deny_all') !== (evidenceRef !== null && evidenceHash !== null)
    || (mode === 'deny_all') !== (osvMode === 'bundled_fallback_only')) {
    throw new TypeError('SkillSpector network enforcement evidence is inconsistent');
  }
  return {
    mode,
    osv_mode: osvMode,
    evidence_ref: evidenceRef,
    evidence_hash: evidenceHash,
  };
}

function normalizeComponentManifest(value) {
  const components = requireArray(value, 'SkillSpector component manifest');
  const normalized = components.map((component, index) => {
    const field = `SkillSpector components[${index}]`;
    assertPlainObject(component, field);
    assertAllowedKeys(component, COMPONENT_KEYS, field);
    requireFields(component, COMPONENT_KEYS, field);
    const nullableString = (child, childField, maxLength = 4096) => (
      child === null ? null : requireString(child, childField, { maxLength })
    );
    return {
      path: requireString(component.path, `${field}.path`, { maxLength: 4096 }),
      type: requireString(component.type, `${field}.type`, { maxLength: 200 }),
      lines: boundedInteger(component.lines, `${field}.lines`),
      executable: requireBoolean(component.executable, `${field}.executable`),
      size_bytes: boundedInteger(component.size_bytes, `${field}.size_bytes`),
      source_url: nullableString(component.source_url, `${field}.source_url`),
      source_identity: nullableString(
        component.source_identity,
        `${field}.source_identity`,
        500,
      ),
      source_digest: component.source_digest === null
        ? null
        : requireSha256Ref(component.source_digest, `${field}.source_digest`),
    };
  });
  normalized.sort((left, right) => {
    const leftCanonical = canonicalize(left);
    const rightCanonical = canonicalize(right);
    if (leftCanonical < rightCanonical) return -1;
    if (leftCanonical > rightCanonical) return 1;
    return 0;
  });
  const rows = normalized.map((component) => canonicalize(component));
  if (new Set(rows).size !== rows.length) {
    throw new TypeError('SkillSpector component manifest contains duplicate rows');
  }
  return normalized;
}

export function hashSkillSpectorComponentManifest(value) {
  try {
    assertCanonicalJson(value);
    return sha256Ref(normalizeComponentManifest(value));
  } catch (error) {
    if (error instanceof SkillSpectorAdmissionError) throw error;
    throw admissionError(
      SKILLSPECTOR_ADMISSION_DIAGNOSTIC_CODES.INVALID_INPUT,
      'SkillSpector component manifest is invalid',
    );
  }
}

export function hashSkillSpectorRulesManifest(value) {
  try {
    assertCanonicalJson(value);
    assertAllowedKeys(value, ['schema', 'root_artifact_hash', 'files'], 'SkillSpector rules manifest');
    requireFields(value, ['schema', 'root_artifact_hash', 'files'], 'SkillSpector rules manifest');
    if (value.schema !== SKILLSPECTOR_RULES_MANIFEST_SCHEMA) {
      throw new TypeError('SkillSpector rules manifest schema is invalid');
    }
    const rootArtifactHash = requireEnum(
      value.root_artifact_hash,
      [SKILLSPECTOR_REVIEWED_ARTIFACT_HASH],
      'SkillSpector rules manifest.root_artifact_hash',
    );
    const files = requireArray(value.files, 'SkillSpector rules manifest.files')
      .map((entry, index) => {
        const field = `SkillSpector rules manifest.files[${index}]`;
        assertPlainObject(entry, field);
        assertAllowedKeys(entry, ['path', 'hash'], field);
        requireFields(entry, ['path', 'hash'], field);
        const path = requireString(entry.path, `${field}.path`, { maxLength: 500 });
        if (!/^skillspector\/(?:nodes\/analyzers\/static_[A-Za-z0-9_.-]+\.py|yara_rules\/[A-Za-z0-9_.-]+)$/.test(path)) {
          throw new TypeError('SkillSpector rules manifest path is outside the reviewed rule surfaces');
        }
        return {
          path,
          hash: requireSha256Ref(entry.hash, `${field}.hash`),
        };
      })
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    if (files.length === 0 || new Set(files.map((entry) => entry.path)).size !== files.length) {
      throw new TypeError('SkillSpector rules manifest must contain unique rule files');
    }
    return sha256Ref({
      schema: SKILLSPECTOR_RULES_MANIFEST_SCHEMA,
      root_artifact_hash: rootArtifactHash,
      files,
    });
  } catch (error) {
    if (error instanceof SkillSpectorAdmissionError) throw error;
    throw admissionError(
      SKILLSPECTOR_ADMISSION_DIAGNOSTIC_CODES.INVALID_INPUT,
      'SkillSpector rules manifest is invalid',
    );
  }
}

export function hashSkillSpectorRuntimeClosure(value) {
  try {
    assertCanonicalJson(value);
    assertAllowedKeys(value, [
      'schema',
      'python_implementation',
      'python_version',
      'platform_tag',
      'packages',
    ], 'SkillSpector runtime closure');
    requireFields(value, [
      'schema',
      'python_implementation',
      'python_version',
      'platform_tag',
      'packages',
    ], 'SkillSpector runtime closure');
    if (value.schema !== SKILLSPECTOR_RUNTIME_CLOSURE_SCHEMA) {
      throw new TypeError('SkillSpector runtime closure schema is invalid');
    }
    const packages = requireArray(value.packages, 'SkillSpector runtime closure.packages')
      .map((entry, index) => {
        const field = `SkillSpector runtime closure.packages[${index}]`;
        assertPlainObject(entry, field);
        assertAllowedKeys(entry, ['name', 'version', 'artifact_hash'], field);
        requireFields(entry, ['name', 'version', 'artifact_hash'], field);
        const rawName = requireString(entry.name, `${field}.name`, {
          maxLength: 200,
          pattern: /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,198}[A-Za-z0-9])?$/,
        });
        const name = rawName.toLowerCase().replace(/[-_.]+/g, '-');
        return {
          name,
          version: requireString(entry.version, `${field}.version`, { maxLength: 200 }),
          artifact_hash: requireSha256Ref(entry.artifact_hash, `${field}.artifact_hash`),
        };
      })
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    if (packages.length === 0
      || new Set(packages.map((entry) => entry.name)).size !== packages.length) {
      throw new TypeError('SkillSpector runtime closure must contain unique distributions');
    }
    const scanner = packages.find((entry) => entry.name === 'skillspector');
    if (!scanner
      || scanner.version !== SKILLSPECTOR_REVIEWED_VERSION
      || !safeEqual(scanner.artifact_hash, SKILLSPECTOR_REVIEWED_ARTIFACT_HASH)) {
      throw new TypeError('SkillSpector runtime closure does not contain the reviewed scanner wheel');
    }
    return sha256Ref({
      schema: SKILLSPECTOR_RUNTIME_CLOSURE_SCHEMA,
      python_implementation: requireString(
        value.python_implementation,
        'SkillSpector runtime closure.python_implementation',
        { maxLength: 100, pattern: /^[a-z0-9_-]+$/ },
      ),
      python_version: requireString(
        value.python_version,
        'SkillSpector runtime closure.python_version',
        { maxLength: 100, pattern: /^\d+\.\d+\.\d+(?:[A-Za-z0-9.+-]*)?$/ },
      ),
      platform_tag: requireString(
        value.platform_tag,
        'SkillSpector runtime closure.platform_tag',
        { maxLength: 300, pattern: /^\S+$/ },
      ),
      packages,
    });
  } catch (error) {
    if (error instanceof SkillSpectorAdmissionError) throw error;
    throw admissionError(
      SKILLSPECTOR_ADMISSION_DIAGNOSTIC_CODES.INVALID_INPUT,
      'SkillSpector runtime closure is invalid',
    );
  }
}

function normalizeCoverage(value, { componentCount, findingCount, suppressedCount }) {
  assertAllowedKeys(value, COMPLETENESS_KEYS, 'SkillSpector analysis_completeness');
  requireFields(value, [
    'total_components',
    'scanned_components',
    'coverage_percent',
    'is_complete',
    'status',
    'execution_successful',
    'fully_inspected_files',
    'partially_inspected_files',
    'entirely_uninspected_files',
    'ledger_exceptions',
    'scope_exclusions',
    'analyzer_statuses',
    'limitations',
    'findings_before_filtering',
    'findings_after_filtering',
  ], 'SkillSpector analysis_completeness');
  const totalComponents = boundedInteger(
    value.total_components,
    'SkillSpector coverage.total_components',
    { max: MAX_REPORT_ITEMS },
  );
  const scannedComponents = boundedInteger(
    value.scanned_components,
    'SkillSpector coverage.scanned_components',
    { max: MAX_REPORT_ITEMS },
  );
  const fullyInspected = boundedInteger(
    value.fully_inspected_files,
    'SkillSpector coverage.fully_inspected_files',
    { max: MAX_REPORT_ITEMS },
  );
  const partiallyInspected = boundedInteger(
    value.partially_inspected_files,
    'SkillSpector coverage.partially_inspected_files',
    { max: MAX_REPORT_ITEMS },
  );
  const entirelyUninspected = boundedInteger(
    value.entirely_uninspected_files,
    'SkillSpector coverage.entirely_uninspected_files',
    { max: MAX_REPORT_ITEMS },
  );
  const coveragePercent = requireBoundedNumber(
    value.coverage_percent,
    'SkillSpector coverage.coverage_percent',
  );
  const status = requireEnum(
    value.status,
    ['complete', 'partial', 'failed'],
    'SkillSpector coverage.status',
  );
  const isComplete = requireBoolean(value.is_complete, 'SkillSpector coverage.is_complete');
  const executionSuccessful = requireBoolean(
    value.execution_successful,
    'SkillSpector coverage.execution_successful',
  );
  const ledgerExceptions = requireArray(
    value.ledger_exceptions,
    'SkillSpector coverage.ledger_exceptions',
  );
  const scopeExclusions = requireArray(
    value.scope_exclusions,
    'SkillSpector coverage.scope_exclusions',
  );
  const analyzerStatuses = requireArray(
    value.analyzer_statuses,
    'SkillSpector coverage.analyzer_statuses',
  );
  let analyzerIncompleteCount = 0;
  let applicableStaticAnalyzerCount = 0;
  let staticCompletedWork = 0;
  const analyzerIds = new Set();
  for (let index = 0; index < analyzerStatuses.length; index += 1) {
    const status = analyzerStatuses[index];
    assertPlainObject(status, `SkillSpector coverage.analyzer_statuses[${index}]`);
    assertAllowedKeys(
      status,
      ANALYZER_STATUS_KEYS,
      `SkillSpector coverage.analyzer_statuses[${index}]`,
    );
    requireFields(
      status,
      ANALYZER_STATUS_REQUIRED_KEYS,
      `SkillSpector coverage.analyzer_statuses[${index}]`,
    );
    const analyzerId = requireString(
      status.analyzer_id,
      `SkillSpector coverage.analyzer_statuses[${index}].analyzer_id`,
      { maxLength: 200 },
    );
    if (analyzerIds.has(analyzerId)) {
      throw new TypeError('SkillSpector analyzer status identifiers must be unique');
    }
    analyzerIds.add(analyzerId);
    const statusName = requireEnum(
      status.status,
      ['completed', 'not_applicable', 'disabled', 'unavailable', 'degraded', 'failed'],
      `SkillSpector coverage.analyzer_statuses[${index}].status`,
    );
    const counts = ['planned_work', 'completed', 'partial', 'skipped', 'failed', 'unaccounted']
      .map((key) => boundedInteger(
        status[key],
        `SkillSpector coverage.analyzer_statuses[${index}].${key}`,
        { max: MAX_REPORT_ITEMS },
      ));
    if (counts[0] !== counts.slice(1).reduce((sum, count) => sum + count, 0)) {
      throw new TypeError('SkillSpector analyzer status accounting is inconsistent');
    }
    const [plannedWork, completedWork, partialWork, skippedWork, failedWork, unaccountedWork]
      = counts;
    if (status.reason_code !== undefined) {
      requireString(
        status.reason_code,
        `SkillSpector coverage.analyzer_statuses[${index}].reason_code`,
        { maxLength: 200 },
      );
    }
    if (status.message !== undefined) {
      requireString(
        status.message,
        `SkillSpector coverage.analyzer_statuses[${index}].message`,
        { maxLength: 2000 },
      );
    }
    const allowedNoLlmDisable = statusName === 'disabled'
      && NO_LLM_DISABLED_ANALYZERS.has(analyzerId);
    if (statusName === 'completed'
      && (plannedWork === 0 || completedWork !== plannedWork
        || partialWork > 0 || skippedWork > 0 || failedWork > 0 || unaccountedWork > 0)) {
      throw new TypeError('SkillSpector completed analyzer has no fully completed work');
    }
    if (statusName === 'not_applicable' && plannedWork !== 0) {
      throw new TypeError('SkillSpector not-applicable analyzer cannot carry planned work');
    }
    if (allowedNoLlmDisable && plannedWork !== 0) {
      throw new TypeError('SkillSpector no-LLM disabled analyzer cannot carry planned work');
    }
    if (REVIEWED_STATIC_ANALYZER_IDS.has(analyzerId) && statusName === 'completed') {
      applicableStaticAnalyzerCount += 1;
      staticCompletedWork += completedWork;
    }
    if (!['completed', 'not_applicable'].includes(statusName) && !allowedNoLlmDisable) {
      analyzerIncompleteCount += 1;
    }
  }
  const limitations = requireArray(value.limitations, 'SkillSpector coverage.limitations');
  if (value.references !== undefined) {
    requireArray(value.references, 'SkillSpector coverage.references');
  }
  const findingsBeforeFiltering = boundedInteger(
    value.findings_before_filtering,
    'SkillSpector coverage.findings_before_filtering',
    { max: MAX_REPORT_ITEMS },
  );
  const findingsAfterFiltering = boundedInteger(
    value.findings_after_filtering,
    'SkillSpector coverage.findings_after_filtering',
    { max: MAX_REPORT_ITEMS },
  );
  const expectedCoverage = totalComponents === 0
    ? 100
    : Math.round((fullyInspected / totalComponents) * 1000) / 10;
  if (totalComponents !== fullyInspected + partiallyInspected + entirelyUninspected
    || scannedComponents !== fullyInspected
    || componentCount !== totalComponents
    || findingsAfterFiltering > findingsBeforeFiltering
    || findingCount + suppressedCount > findingsAfterFiltering
    || Math.abs(coveragePercent - expectedCoverage) > 0.05
    || isComplete !== (status === 'complete')) {
    throw new TypeError('SkillSpector coverage accounting is inconsistent');
  }
  return {
    status,
    is_complete: isComplete,
    execution_successful: executionSuccessful,
    total_components: totalComponents,
    scanned_components: scannedComponents,
    coverage_percent: coveragePercent,
    fully_inspected_files: fullyInspected,
    partially_inspected_files: partiallyInspected,
    entirely_uninspected_files: entirelyUninspected,
    ledger_exception_count: ledgerExceptions.length,
    scope_exclusion_count: scopeExclusions.length,
    limitation_count: limitations.length,
    analyzer_status_count: analyzerStatuses.length,
    analyzer_incomplete_count: analyzerIncompleteCount,
    applicable_static_analyzer_count: applicableStaticAnalyzerCount,
    static_completed_work: staticCompletedWork,
    findings_before_filtering: findingsBeforeFiltering,
    findings_after_filtering: findingsAfterFiltering,
  };
}

function normalizeRiskAssessment(value, issues) {
  assertAllowedKeys(value, [
    'score',
    'severity',
    'recommendation',
    'max_issue_severity',
  ], 'SkillSpector risk_assessment');
  requireFields(value, [
    'score',
    'severity',
    'recommendation',
    'max_issue_severity',
  ], 'SkillSpector risk_assessment');
  const score = boundedInteger(value.score, 'SkillSpector risk_assessment.score', { max: 100 });
  const severity = requireEnum(
    value.severity,
    SEVERITIES.filter((item) => item !== 'NONE'),
    'SkillSpector risk_assessment.severity',
  );
  const recommendation = requireEnum(
    value.recommendation,
    RECOMMENDATIONS,
    'SkillSpector risk_assessment.recommendation',
  );
  const maxIssueSeverity = requireEnum(
    value.max_issue_severity,
    SEVERITIES,
    'SkillSpector risk_assessment.max_issue_severity',
  );
  const counts = Object.fromEntries(SEVERITIES.map((item) => [item, 0]));
  const findingSeverities = new Map();
  for (let index = 0; index < issues.length; index += 1) {
    const issue = issues[index];
    assertAllowedKeys(issue, ISSUE_KEYS, `SkillSpector issues[${index}]`);
    requireString(issue.id, `SkillSpector issues[${index}].id`, { maxLength: 200 });
    const findingId = requireString(
      issue.finding_id,
      `SkillSpector issues[${index}].finding_id`,
      { maxLength: 500 },
    );
    const issueSeverity = requireEnum(
      issue.severity,
      SEVERITIES.filter((item) => item !== 'NONE'),
      `SkillSpector issues[${index}].severity`,
    );
    const occurrences = requireArray(
      issue.occurrences,
      `SkillSpector issues[${index}].occurrences`,
    );
    if (occurrences.length !== 1) {
      throw new TypeError('SkillSpector JSON issues must be expanded to one occurrence each');
    }
    const existingSeverity = findingSeverities.get(findingId);
    if (existingSeverity !== undefined && existingSeverity !== issueSeverity) {
      throw new TypeError('SkillSpector occurrence severity is inconsistent for one finding');
    }
    findingSeverities.set(findingId, issueSeverity);
  }
  for (const issueSeverity of findingSeverities.values()) {
    counts[issueSeverity] += 1;
  }
  const derivedMax = [...SEVERITIES].reverse().find((item) => counts[item] > 0) ?? 'NONE';
  if (derivedMax !== maxIssueSeverity) {
    throw new TypeError('SkillSpector max_issue_severity does not match issues');
  }
  const minimumRecommendation = severity === 'LOW'
    ? 'SAFE'
    : severity === 'MEDIUM'
      ? 'CAUTION'
      : 'DO_NOT_INSTALL';
  if (RECOMMENDATIONS.indexOf(recommendation) < RECOMMENDATIONS.indexOf(minimumRecommendation)) {
    throw new TypeError('SkillSpector recommendation is less restrictive than severity');
  }
  return {
    score,
    severity,
    recommendation,
    max_issue_severity: maxIssueSeverity,
    severity_counts: counts,
    finding_count: findingSeverities.size,
  };
}

function deriveResult({
  riskAssessment,
  coverage,
  reportExecutionSuccessful,
  suppressedCount,
  findingCount,
  networkEnforcement,
}) {
  const reasons = new Set();
  const strictComplete = reportExecutionSuccessful
    && coverage.execution_successful
    && coverage.is_complete
    && coverage.status === 'complete'
    && coverage.coverage_percent === 100
    && coverage.total_components > 0
    && coverage.analyzer_status_count > 0
    && coverage.analyzer_incomplete_count === 0
    && coverage.applicable_static_analyzer_count > 0
    && coverage.static_completed_work > 0
    && !coverage.output_limit_reached
    && coverage.findings_before_filtering === coverage.findings_after_filtering
    && coverage.findings_after_filtering === findingCount + suppressedCount
    && coverage.partially_inspected_files === 0
    && coverage.entirely_uninspected_files === 0
    && coverage.ledger_exception_count === 0
    && coverage.scope_exclusion_count === 0
    && coverage.limitation_count === 0
    && networkEnforcement.mode === 'deny_all'
    && networkEnforcement.osv_mode === 'bundled_fallback_only';

  if (!reportExecutionSuccessful || !coverage.execution_successful) {
    reasons.add('skillspector_execution_failed');
  }
  if (!coverage.is_complete || coverage.status !== 'complete'
    || coverage.coverage_percent !== 100
    || coverage.partially_inspected_files > 0
    || coverage.entirely_uninspected_files > 0) {
    reasons.add('skillspector_incomplete_coverage');
  }
  if (coverage.total_components === 0 || coverage.analyzer_status_count === 0
    || coverage.applicable_static_analyzer_count === 0
    || coverage.static_completed_work === 0) {
    reasons.add('skillspector_empty_scope');
  }
  if (coverage.analyzer_incomplete_count > 0) {
    reasons.add('skillspector_analyzer_incomplete');
  }
  if (coverage.findings_before_filtering !== coverage.findings_after_filtering) {
    reasons.add('skillspector_filtered_findings');
  }
  if (coverage.output_limit_reached
    || coverage.findings_after_filtering > findingCount + suppressedCount) {
    reasons.add('skillspector_output_truncated');
  }
  if (coverage.ledger_exception_count > 0) reasons.add('skillspector_ledger_exception');
  if (coverage.scope_exclusion_count > 0) reasons.add('skillspector_scope_exclusion');
  if (coverage.limitation_count > 0) reasons.add('skillspector_limitations_present');
  if (networkEnforcement.mode !== 'deny_all') reasons.add('skillspector_network_unverified');
  if (suppressedCount > 0) reasons.add('skillspector_suppression_detected');
  if (findingCount > 0) reasons.add('skillspector_findings_present');
  if (riskAssessment.recommendation === 'CAUTION') reasons.add('skillspector_caution');
  if (riskAssessment.recommendation === 'DO_NOT_INSTALL') {
    reasons.add('skillspector_do_not_install');
  }
  if (['HIGH', 'CRITICAL'].includes(riskAssessment.max_issue_severity)) {
    reasons.add('skillspector_high_severity_finding');
  }

  let outcome = 'clear';
  if (!strictComplete) outcome = 'incomplete';
  if (riskAssessment.recommendation === 'CAUTION'
    || riskAssessment.severity === 'MEDIUM'
    || riskAssessment.max_issue_severity === 'MEDIUM'
    || findingCount > 0) {
    outcome = outcome === 'clear' ? 'review' : outcome;
  }
  if (suppressedCount > 0
    || riskAssessment.recommendation === 'DO_NOT_INSTALL'
    || ['HIGH', 'CRITICAL'].includes(riskAssessment.severity)
    || ['HIGH', 'CRITICAL'].includes(riskAssessment.max_issue_severity)) {
    outcome = 'block';
  }
  if (reasons.size === 0) reasons.add('skillspector_clear');
  return {
    outcome,
    reason_codes: [...reasons].sort(),
  };
}

function normalizedReportProjection({ riskAssessment, coverage, executionSuccessful, result }) {
  return {
    scanner_version: SKILLSPECTOR_REVIEWED_VERSION,
    risk_assessment: {
      score: riskAssessment.score,
      severity: riskAssessment.severity,
      recommendation: riskAssessment.recommendation,
      max_issue_severity: riskAssessment.max_issue_severity,
      severity_counts: riskAssessment.severity_counts,
    },
    execution_successful: executionSuccessful,
    coverage,
    finding_count: result.finding_count,
    suppressed_count: result.suppressed_count,
  };
}

function normalizeEvidence(value) {
  assertCanonicalJson(value);
  assertAllowedKeys(value, EVIDENCE_KEYS, 'SkillSpector admission evidence');
  requireFields(value, EVIDENCE_KEYS, 'SkillSpector admission evidence');
  if (value.schema !== SKILLSPECTOR_ADMISSION_EVIDENCE_SCHEMA) {
    throw new TypeError('SkillSpector admission evidence schema is invalid');
  }

  assertAllowedKeys(value.subject, [
    'package_ref',
    'package_hash',
    'source_revision',
    'prepared_artifact_hash',
  ], 'SkillSpector admission evidence.subject');
  requireFields(value.subject, [
    'package_ref',
    'package_hash',
    'source_revision',
    'prepared_artifact_hash',
  ], 'SkillSpector admission evidence.subject');
  const subject = {
    package_ref: requireOpaqueRef(value.subject.package_ref, 'SkillSpector subject.package_ref'),
    package_hash: requireSha256Ref(value.subject.package_hash, 'SkillSpector subject.package_hash'),
    source_revision: requireOpaqueRef(
      value.subject.source_revision,
      'SkillSpector subject.source_revision',
      { maxLength: 200 },
    ),
    prepared_artifact_hash: requireSha256Ref(
      value.subject.prepared_artifact_hash,
      'SkillSpector subject.prepared_artifact_hash',
    ),
  };
  if (!safeEqual(subject.package_hash, subject.prepared_artifact_hash)) {
    throw new TypeError('SkillSpector evidence is not bound to the resulting package bytes');
  }

  assertAllowedKeys(value.binding, [
    'descriptor_request_hash',
    'operation_hash',
    'configuration_hash',
  ], 'SkillSpector admission evidence.binding');
  requireFields(value.binding, [
    'descriptor_request_hash',
    'operation_hash',
    'configuration_hash',
  ], 'SkillSpector admission evidence.binding');
  const binding = {
    descriptor_request_hash: requireSha256Ref(
      value.binding.descriptor_request_hash,
      'SkillSpector binding.descriptor_request_hash',
    ),
    operation_hash: requireSha256Ref(
      value.binding.operation_hash,
      'SkillSpector binding.operation_hash',
    ),
    configuration_hash: requireSha256Ref(
      value.binding.configuration_hash,
      'SkillSpector binding.configuration_hash',
    ),
  };

  assertAllowedKeys(value.scanner, [
    'id',
    'version',
    'source_revision',
    'artifact_hash',
    'runtime_closure_hash',
    'rules_hash',
  ], 'SkillSpector admission evidence.scanner');
  requireFields(value.scanner, [
    'id',
    'version',
    'source_revision',
    'artifact_hash',
    'runtime_closure_hash',
    'rules_hash',
  ], 'SkillSpector admission evidence.scanner');
  const scanner = {
    id: requireEnum(value.scanner.id, ['skillspector'], 'SkillSpector scanner.id'),
    version: requireEnum(
      value.scanner.version,
      [SKILLSPECTOR_REVIEWED_VERSION],
      'SkillSpector scanner.version',
    ),
    source_revision: requireEnum(
      value.scanner.source_revision,
      [SKILLSPECTOR_REVIEWED_SOURCE_REVISION],
      'SkillSpector scanner.source_revision',
    ),
    artifact_hash: requireEnum(
      value.scanner.artifact_hash,
      [SKILLSPECTOR_REVIEWED_ARTIFACT_HASH],
      'SkillSpector scanner.artifact_hash',
    ),
    runtime_closure_hash: requireSha256Ref(
      value.scanner.runtime_closure_hash,
      'SkillSpector scanner.runtime_closure_hash',
    ),
    rules_hash: requireSha256Ref(value.scanner.rules_hash, 'SkillSpector scanner.rules_hash'),
  };

  const invocation = normalizeInvocation(value.invocation);
  const networkEnforcement = normalizeNetworkEnforcement(value.network_enforcement);

  assertAllowedKeys(value.report, [
    'ref',
    'raw_hash',
    'normalized_hash',
    'scanned_at',
    'valid_until',
  ], 'SkillSpector admission evidence.report');
  requireFields(value.report, [
    'ref',
    'raw_hash',
    'normalized_hash',
    'scanned_at',
    'valid_until',
  ], 'SkillSpector admission evidence.report');
  const report = {
    ref: requireOpaqueRef(value.report.ref, 'SkillSpector report.ref'),
    raw_hash: requireSha256Ref(value.report.raw_hash, 'SkillSpector report.raw_hash'),
    normalized_hash: requireSha256Ref(
      value.report.normalized_hash,
      'SkillSpector report.normalized_hash',
    ),
    scanned_at: requireIsoDate(value.report.scanned_at, 'SkillSpector report.scanned_at'),
    valid_until: requireIsoDate(value.report.valid_until, 'SkillSpector report.valid_until'),
  };
  const scannedAt = Date.parse(report.scanned_at);
  const validUntil = Date.parse(report.valid_until);
  if (validUntil <= scannedAt || validUntil - scannedAt > MAX_VALIDITY_MS) {
    throw new TypeError('SkillSpector evidence validity window is invalid');
  }

  assertAllowedKeys(value.coverage, [
    'status',
    'is_complete',
    'execution_successful',
    'total_components',
    'scanned_components',
    'coverage_percent',
    'fully_inspected_files',
    'partially_inspected_files',
    'entirely_uninspected_files',
    'ledger_exception_count',
    'scope_exclusion_count',
    'limitation_count',
    'analyzer_status_count',
    'analyzer_incomplete_count',
    'applicable_static_analyzer_count',
    'static_completed_work',
    'emitted_output_records',
    'output_limit_reached',
    'component_manifest_hash',
    'findings_before_filtering',
    'findings_after_filtering',
  ], 'SkillSpector admission evidence.coverage');
  requireFields(value.coverage, [
    'status',
    'is_complete',
    'execution_successful',
    'total_components',
    'scanned_components',
    'coverage_percent',
    'fully_inspected_files',
    'partially_inspected_files',
    'entirely_uninspected_files',
    'ledger_exception_count',
    'scope_exclusion_count',
    'limitation_count',
    'analyzer_status_count',
    'analyzer_incomplete_count',
    'applicable_static_analyzer_count',
    'static_completed_work',
    'emitted_output_records',
    'output_limit_reached',
    'component_manifest_hash',
    'findings_before_filtering',
    'findings_after_filtering',
  ], 'SkillSpector admission evidence.coverage');
  const coverage = {
    status: requireEnum(value.coverage.status, ['complete', 'partial', 'failed'], 'coverage.status'),
    is_complete: requireBoolean(value.coverage.is_complete, 'coverage.is_complete'),
    execution_successful: requireBoolean(
      value.coverage.execution_successful,
      'coverage.execution_successful',
    ),
    total_components: boundedInteger(value.coverage.total_components, 'coverage.total_components', { max: MAX_REPORT_ITEMS }),
    scanned_components: boundedInteger(value.coverage.scanned_components, 'coverage.scanned_components', { max: MAX_REPORT_ITEMS }),
    coverage_percent: requireBoundedNumber(value.coverage.coverage_percent, 'coverage.coverage_percent'),
    fully_inspected_files: boundedInteger(value.coverage.fully_inspected_files, 'coverage.fully_inspected_files', { max: MAX_REPORT_ITEMS }),
    partially_inspected_files: boundedInteger(value.coverage.partially_inspected_files, 'coverage.partially_inspected_files', { max: MAX_REPORT_ITEMS }),
    entirely_uninspected_files: boundedInteger(value.coverage.entirely_uninspected_files, 'coverage.entirely_uninspected_files', { max: MAX_REPORT_ITEMS }),
    ledger_exception_count: boundedInteger(value.coverage.ledger_exception_count, 'coverage.ledger_exception_count', { max: MAX_REPORT_ITEMS }),
    scope_exclusion_count: boundedInteger(value.coverage.scope_exclusion_count, 'coverage.scope_exclusion_count', { max: MAX_REPORT_ITEMS }),
    limitation_count: boundedInteger(value.coverage.limitation_count, 'coverage.limitation_count', { max: MAX_REPORT_ITEMS }),
    analyzer_status_count: boundedInteger(value.coverage.analyzer_status_count, 'coverage.analyzer_status_count', { max: MAX_REPORT_ITEMS }),
    analyzer_incomplete_count: boundedInteger(value.coverage.analyzer_incomplete_count, 'coverage.analyzer_incomplete_count', { max: MAX_REPORT_ITEMS }),
    applicable_static_analyzer_count: boundedInteger(value.coverage.applicable_static_analyzer_count, 'coverage.applicable_static_analyzer_count', { max: MAX_REPORT_ITEMS }),
    static_completed_work: boundedInteger(value.coverage.static_completed_work, 'coverage.static_completed_work', { max: MAX_REPORT_ITEMS }),
    emitted_output_records: boundedInteger(value.coverage.emitted_output_records, 'coverage.emitted_output_records', { max: SKILLSPECTOR_FINDING_OUTPUT_RECORD_LIMIT }),
    output_limit_reached: requireBoolean(value.coverage.output_limit_reached, 'coverage.output_limit_reached'),
    component_manifest_hash: requireSha256Ref(
      value.coverage.component_manifest_hash,
      'coverage.component_manifest_hash',
    ),
    findings_before_filtering: boundedInteger(value.coverage.findings_before_filtering, 'coverage.findings_before_filtering', { max: MAX_REPORT_ITEMS }),
    findings_after_filtering: boundedInteger(value.coverage.findings_after_filtering, 'coverage.findings_after_filtering', { max: MAX_REPORT_ITEMS }),
  };
  const expectedCoverage = coverage.total_components === 0
    ? 100
    : Math.round((coverage.fully_inspected_files / coverage.total_components) * 1000) / 10;
  if (coverage.total_components !== coverage.fully_inspected_files
      + coverage.partially_inspected_files + coverage.entirely_uninspected_files
    || coverage.scanned_components !== coverage.fully_inspected_files
    || coverage.analyzer_incomplete_count > coverage.analyzer_status_count
    || coverage.applicable_static_analyzer_count > coverage.analyzer_status_count
    || coverage.output_limit_reached !== (
      coverage.emitted_output_records === SKILLSPECTOR_FINDING_OUTPUT_RECORD_LIMIT
    )
    || coverage.findings_after_filtering > coverage.findings_before_filtering
    || Math.abs(coverage.coverage_percent - expectedCoverage) > 0.05
    || coverage.is_complete !== (coverage.status === 'complete')) {
    throw new TypeError('SkillSpector evidence coverage accounting is inconsistent');
  }

  assertAllowedKeys(value.result, [
    'execution_successful',
    'score',
    'severity',
    'recommendation',
    'max_issue_severity',
    'severity_counts',
    'finding_count',
    'suppressed_count',
    'outcome',
    'reason_codes',
  ], 'SkillSpector admission evidence.result');
  requireFields(value.result, [
    'execution_successful',
    'score',
    'severity',
    'recommendation',
    'max_issue_severity',
    'severity_counts',
    'finding_count',
    'suppressed_count',
    'outcome',
    'reason_codes',
  ], 'SkillSpector admission evidence.result');
  assertAllowedKeys(value.result.severity_counts, SEVERITIES, 'SkillSpector severity_counts');
  requireFields(value.result.severity_counts, SEVERITIES, 'SkillSpector severity_counts');
  const severityCounts = Object.fromEntries(SEVERITIES.map((severity) => [
    severity,
    boundedInteger(
      value.result.severity_counts[severity],
      `SkillSpector severity_counts.${severity}`,
      { max: MAX_REPORT_ITEMS },
    ),
  ]));
  const result = {
    execution_successful: requireBoolean(
      value.result.execution_successful,
      'SkillSpector result.execution_successful',
    ),
    score: boundedInteger(value.result.score, 'SkillSpector result.score', { max: 100 }),
    severity: requireEnum(
      value.result.severity,
      SEVERITIES.filter((item) => item !== 'NONE'),
      'SkillSpector result.severity',
    ),
    recommendation: requireEnum(
      value.result.recommendation,
      RECOMMENDATIONS,
      'SkillSpector result.recommendation',
    ),
    max_issue_severity: requireEnum(
      value.result.max_issue_severity,
      SEVERITIES,
      'SkillSpector result.max_issue_severity',
    ),
    severity_counts: severityCounts,
    finding_count: boundedInteger(value.result.finding_count, 'SkillSpector result.finding_count', { max: MAX_REPORT_ITEMS }),
    suppressed_count: boundedInteger(value.result.suppressed_count, 'SkillSpector result.suppressed_count', { max: MAX_REPORT_ITEMS }),
    outcome: requireEnum(value.result.outcome, OUTCOMES, 'SkillSpector result.outcome'),
    reason_codes: requireArray(value.result.reason_codes, 'SkillSpector result.reason_codes', { maxItems: REASON_CODES.length })
      .map((code, index) => requireEnum(code, REASON_CODES, `SkillSpector result.reason_codes[${index}]`)),
  };
  if (new Set(result.reason_codes).size !== result.reason_codes.length
    || canonicalize(result.reason_codes) !== canonicalize([...result.reason_codes].sort())
    || Object.values(severityCounts).reduce((total, count) => total + count, 0)
      !== result.finding_count) {
    throw new TypeError('SkillSpector result accounting is inconsistent');
  }
  if (result.finding_count + result.suppressed_count > coverage.findings_after_filtering) {
    throw new TypeError('SkillSpector finding coverage accounting is inconsistent');
  }

  assertAllowedKeys(value.authority_flags, [
    'advisory_only',
    'grants_trust',
    'grants_execution',
    'grants_commit',
    'grants_spend',
    'grants_settlement',
  ], 'SkillSpector admission evidence.authority_flags');
  requireFields(value.authority_flags, [
    'advisory_only',
    'grants_trust',
    'grants_execution',
    'grants_commit',
    'grants_spend',
    'grants_settlement',
  ], 'SkillSpector admission evidence.authority_flags');
  const authorityFlags = {
    advisory_only: requireBoolean(value.authority_flags.advisory_only, 'authority_flags.advisory_only'),
    grants_trust: requireBoolean(value.authority_flags.grants_trust, 'authority_flags.grants_trust'),
    grants_execution: requireBoolean(value.authority_flags.grants_execution, 'authority_flags.grants_execution'),
    grants_commit: requireBoolean(value.authority_flags.grants_commit, 'authority_flags.grants_commit'),
    grants_spend: requireBoolean(value.authority_flags.grants_spend, 'authority_flags.grants_spend'),
    grants_settlement: requireBoolean(value.authority_flags.grants_settlement, 'authority_flags.grants_settlement'),
  };
  if (!authorityFlags.advisory_only
    || authorityFlags.grants_trust
    || authorityFlags.grants_execution
    || authorityFlags.grants_commit
    || authorityFlags.grants_spend
    || authorityFlags.grants_settlement) {
    throw new TypeError('SkillSpector evidence cannot grant authority');
  }

  const derived = deriveResult({
    riskAssessment: {
      score: result.score,
      severity: result.severity,
      recommendation: result.recommendation,
      max_issue_severity: result.max_issue_severity,
      severity_counts: result.severity_counts,
    },
    coverage,
    reportExecutionSuccessful: result.execution_successful,
    suppressedCount: result.suppressed_count,
    findingCount: result.finding_count,
    networkEnforcement,
  });
  if (derived.outcome !== result.outcome
    || canonicalize(derived.reason_codes) !== canonicalize(result.reason_codes)) {
    throw new TypeError('SkillSpector outcome is not derived from the report evidence');
  }

  const normalized = {
    schema: SKILLSPECTOR_ADMISSION_EVIDENCE_SCHEMA,
    subject,
    binding,
    scanner,
    invocation,
    network_enforcement: networkEnforcement,
    report,
    coverage,
    result,
    authority_flags: authorityFlags,
    evidence_hash: requireSha256Ref(value.evidence_hash, 'SkillSpector evidence_hash'),
  };
  const configurationHash = sha256Ref({
    invocation,
    network_enforcement: networkEnforcement,
    runtime_closure_hash: scanner.runtime_closure_hash,
    rules_hash: scanner.rules_hash,
  });
  if (!safeEqual(binding.configuration_hash, configurationHash)) {
    throw new TypeError('SkillSpector configuration hash mismatch');
  }
  const expectedNormalizedReportHash = sha256Ref(normalizedReportProjection({
    riskAssessment: {
      score: result.score,
      severity: result.severity,
      recommendation: result.recommendation,
      max_issue_severity: result.max_issue_severity,
      severity_counts: result.severity_counts,
    },
    coverage,
    executionSuccessful: result.execution_successful,
    result,
  }));
  if (!safeEqual(report.normalized_hash, expectedNormalizedReportHash)) {
    throw new TypeError('SkillSpector normalized report hash mismatch');
  }
  const expectedEvidenceHash = sha256Ref({ ...normalized, evidence_hash: null });
  if (!safeEqual(normalized.evidence_hash, expectedEvidenceHash)) {
    throw admissionError(
      SKILLSPECTOR_ADMISSION_DIAGNOSTIC_CODES.EVIDENCE_HASH_MISMATCH,
      'SkillSpector admission evidence hash mismatch',
    );
  }
  return deepFreeze(JSON.parse(canonicalize(normalized)));
}

export function adaptSkillSpectorReport(input = {}) {
  try {
    assertCanonicalJson(input);
    assertAllowedKeys(input, [
      'report_bytes',
      'report_ref',
      'package_ref',
      'package_hash',
      'source_revision',
      'prepared_artifact_hash',
      'descriptor_request_hash',
      'operation_hash',
      'rules_hash',
      'runtime_closure_hash',
      'component_manifest_hash',
      'invocation',
      'network_enforcement',
      'valid_until',
    ], 'SkillSpector adapter input');
    requireFields(input, [
      'report_bytes',
      'report_ref',
      'package_ref',
      'package_hash',
      'source_revision',
      'prepared_artifact_hash',
      'descriptor_request_hash',
      'operation_hash',
      'rules_hash',
      'runtime_closure_hash',
      'component_manifest_hash',
      'invocation',
      'network_enforcement',
      'valid_until',
    ], 'SkillSpector adapter input');
    if (typeof input.report_bytes !== 'string'
      || Buffer.byteLength(input.report_bytes, 'utf8') > MAX_REPORT_BYTES) {
      throw new TypeError(`SkillSpector report_bytes exceeds ${MAX_REPORT_BYTES} bytes`);
    }
    let rawReport;
    try {
      rawReport = JSON.parse(input.report_bytes);
    } catch {
      throw admissionError(
        SKILLSPECTOR_ADMISSION_DIAGNOSTIC_CODES.REPORT_CONTRACT_INVALID,
        'SkillSpector report is not valid JSON',
      );
    }
    assertCanonicalJson(rawReport);
    assertAllowedKeys(rawReport, REPORT_TOP_LEVEL_KEYS, 'SkillSpector JSON report');
    requireFields(rawReport, REPORT_TOP_LEVEL_KEYS, 'SkillSpector JSON report');

    assertAllowedKeys(rawReport.skill, ['name', 'source', 'scanned_at'], 'SkillSpector report.skill');
    requireFields(rawReport.skill, ['name', 'source', 'scanned_at'], 'SkillSpector report.skill');
    requireString(rawReport.skill.name, 'SkillSpector report.skill.name', { maxLength: 500 });
    if (typeof rawReport.skill.source !== 'string' || rawReport.skill.source.length > 4096) {
      throw new TypeError('SkillSpector report.skill.source is invalid');
    }
    const scannedAt = requireIsoDate(rawReport.skill.scanned_at, 'SkillSpector report.skill.scanned_at');
    const validUntil = requireIsoDate(input.valid_until, 'SkillSpector adapter valid_until');
    if (Date.parse(validUntil) <= Date.parse(scannedAt)
      || Date.parse(validUntil) - Date.parse(scannedAt) > MAX_VALIDITY_MS) {
      throw new TypeError('SkillSpector adapter validity window is invalid');
    }

    const components = normalizeComponentManifest(rawReport.components);
    const componentManifestHash = sha256Ref(components);
    const expectedComponentManifestHash = requireSha256Ref(
      input.component_manifest_hash,
      'SkillSpector component_manifest_hash',
    );
    if (!safeEqual(componentManifestHash, expectedComponentManifestHash)) {
      throw admissionError(
        SKILLSPECTOR_ADMISSION_DIAGNOSTIC_CODES.EXPECTED_BINDING_MISMATCH,
        'SkillSpector report does not bind the expected package component manifest',
      );
    }
    requireArray(rawReport.structured_summaries, 'SkillSpector report.structured_summaries');
    const issues = requireArray(rawReport.issues, 'SkillSpector report.issues');
    const suppressed = requireArray(rawReport.suppressed, 'SkillSpector report.suppressed');
    const suppressedCount = boundedInteger(
      rawReport.suppressed_count,
      'SkillSpector report.suppressed_count',
      { max: MAX_REPORT_ITEMS },
    );
    if (suppressedCount !== suppressed.length) {
      throw new TypeError('SkillSpector suppressed finding count is inconsistent');
    }
    let emittedOutputRecords = issues.length;
    for (let index = 0; index < suppressed.length; index += 1) {
      const finding = suppressed[index];
      assertPlainObject(finding, `SkillSpector report.suppressed[${index}]`);
      const occurrences = requireArray(
        finding.occurrences,
        `SkillSpector report.suppressed[${index}].occurrences`,
      );
      if (occurrences.length === 0) {
        throw new TypeError('SkillSpector suppressed findings require an occurrence');
      }
      emittedOutputRecords += occurrences.length;
    }
    if (emittedOutputRecords > SKILLSPECTOR_FINDING_OUTPUT_RECORD_LIMIT) {
      throw new TypeError('SkillSpector report exceeds the reviewed output-record limit');
    }

    assertAllowedKeys(rawReport.metadata, METADATA_KEYS, 'SkillSpector report.metadata');
    requireFields(rawReport.metadata, [
      'has_executable_scripts',
      'skillspector_version',
      'llm_requested',
      'llm_available',
      'meta_analysis_applied',
      'inference_usage',
      'filtering_mode',
    ], 'SkillSpector report.metadata');
    requireBoolean(
      rawReport.metadata.has_executable_scripts,
      'SkillSpector metadata.has_executable_scripts',
    );
    if (rawReport.metadata.skillspector_version !== SKILLSPECTOR_REVIEWED_VERSION) {
      throw admissionError(
        SKILLSPECTOR_ADMISSION_DIAGNOSTIC_CODES.SCANNER_BINDING_MISMATCH,
        'SkillSpector report version does not match the reviewed scanner',
      );
    }
    if (rawReport.metadata.llm_requested !== false
      || rawReport.metadata.meta_analysis_applied !== false
      || rawReport.metadata.filtering_mode !== 'heuristic'
      || requireArray(rawReport.metadata.inference_usage, 'SkillSpector metadata.inference_usage').length > 0) {
      throw new TypeError('SkillSpector admission accepts static-only no-LLM reports');
    }
    requireBoolean(rawReport.metadata.llm_available, 'SkillSpector metadata.llm_available');

    const reportExecutionSuccessful = requireBoolean(
      rawReport.execution_successful,
      'SkillSpector report.execution_successful',
    );
    const riskAssessment = normalizeRiskAssessment(rawReport.risk_assessment, issues);
    const coverage = {
      ...normalizeCoverage(rawReport.analysis_completeness, {
        componentCount: components.length,
        findingCount: riskAssessment.finding_count,
        suppressedCount,
      }),
      emitted_output_records: emittedOutputRecords,
      output_limit_reached:
        emittedOutputRecords === SKILLSPECTOR_FINDING_OUTPUT_RECORD_LIMIT,
      component_manifest_hash: componentManifestHash,
    };
    if (coverage.execution_successful !== reportExecutionSuccessful) {
      throw new TypeError('SkillSpector report and coverage execution status disagree');
    }
    const invocation = normalizeInvocation(input.invocation);
    const networkEnforcement = normalizeNetworkEnforcement(input.network_enforcement);
    const derived = deriveResult({
      riskAssessment,
      coverage,
      reportExecutionSuccessful,
      suppressedCount,
      findingCount: riskAssessment.finding_count,
      networkEnforcement,
    });
    const result = {
      execution_successful: reportExecutionSuccessful,
      score: riskAssessment.score,
      severity: riskAssessment.severity,
      recommendation: riskAssessment.recommendation,
      max_issue_severity: riskAssessment.max_issue_severity,
      severity_counts: riskAssessment.severity_counts,
      finding_count: riskAssessment.finding_count,
      suppressed_count: suppressedCount,
      outcome: derived.outcome,
      reason_codes: derived.reason_codes,
    };
    const rulesHash = requireSha256Ref(input.rules_hash, 'SkillSpector rules_hash');
    const runtimeClosureHash = requireSha256Ref(
      input.runtime_closure_hash,
      'SkillSpector runtime_closure_hash',
    );
    const configurationHash = sha256Ref({
      invocation,
      network_enforcement: networkEnforcement,
      runtime_closure_hash: runtimeClosureHash,
      rules_hash: rulesHash,
    });
    const evidence = {
      schema: SKILLSPECTOR_ADMISSION_EVIDENCE_SCHEMA,
      subject: {
        package_ref: requireOpaqueRef(input.package_ref, 'SkillSpector package_ref'),
        package_hash: requireSha256Ref(input.package_hash, 'SkillSpector package_hash'),
        source_revision: requireOpaqueRef(
          input.source_revision,
          'SkillSpector source_revision',
          { maxLength: 200 },
        ),
        prepared_artifact_hash: requireSha256Ref(
          input.prepared_artifact_hash,
          'SkillSpector prepared_artifact_hash',
        ),
      },
      binding: {
        descriptor_request_hash: requireSha256Ref(
          input.descriptor_request_hash,
          'SkillSpector descriptor_request_hash',
        ),
        operation_hash: requireSha256Ref(input.operation_hash, 'SkillSpector operation_hash'),
        configuration_hash: configurationHash,
      },
      scanner: {
        id: 'skillspector',
        version: SKILLSPECTOR_REVIEWED_VERSION,
        source_revision: SKILLSPECTOR_REVIEWED_SOURCE_REVISION,
        artifact_hash: SKILLSPECTOR_REVIEWED_ARTIFACT_HASH,
        runtime_closure_hash: runtimeClosureHash,
        rules_hash: rulesHash,
      },
      invocation,
      network_enforcement: networkEnforcement,
      report: {
        ref: requireOpaqueRef(input.report_ref, 'SkillSpector report_ref'),
        raw_hash: rawSha256Ref(input.report_bytes),
        normalized_hash: sha256Ref(normalizedReportProjection({
          riskAssessment,
          coverage,
          executionSuccessful: reportExecutionSuccessful,
          result,
        })),
        scanned_at: scannedAt,
        valid_until: validUntil,
      },
      coverage,
      result,
      authority_flags: {
        advisory_only: true,
        grants_trust: false,
        grants_execution: false,
        grants_commit: false,
        grants_spend: false,
        grants_settlement: false,
      },
      evidence_hash: null,
    };
    if (!safeEqual(evidence.subject.package_hash, evidence.subject.prepared_artifact_hash)) {
      throw admissionError(
        SKILLSPECTOR_ADMISSION_DIAGNOSTIC_CODES.EXPECTED_BINDING_MISMATCH,
        'SkillSpector scan does not bind the resulting package bytes',
      );
    }
    evidence.evidence_hash = sha256Ref(evidence);
    return normalizeEvidence(evidence);
  } catch (error) {
    if (error instanceof SkillSpectorAdmissionError) throw error;
    throw admissionError(
      SKILLSPECTOR_ADMISSION_DIAGNOSTIC_CODES.REPORT_CONTRACT_INVALID,
      'SkillSpector report or binding does not satisfy the reviewed admission contract',
    );
  }
}

export function verifySkillSpectorAdmissionEvidence(value, expected = {}) {
  try {
    assertAllowedKeys(expected, [
      'descriptor_request_hash',
      'operation_hash',
      'configuration_hash',
      'package_ref',
      'package_hash',
      'prepared_artifact_hash',
      'source_revision',
      'rules_hash',
      'runtime_closure_hash',
      'component_manifest_hash',
      'report_ref',
      'report_hash',
      'network_enforcement',
      'requested_at',
    ], 'SkillSpector expected binding');
    const normalized = normalizeEvidence(value);
    const comparisons = [
      ['descriptor_request_hash', normalized.binding.descriptor_request_hash, requireSha256Ref],
      ['operation_hash', normalized.binding.operation_hash, requireSha256Ref],
      ['configuration_hash', normalized.binding.configuration_hash, requireSha256Ref],
      ['package_ref', normalized.subject.package_ref, requireOpaqueRef],
      ['package_hash', normalized.subject.package_hash, requireSha256Ref],
      ['prepared_artifact_hash', normalized.subject.prepared_artifact_hash, requireSha256Ref],
      ['source_revision', normalized.subject.source_revision, requireOpaqueRef],
      ['rules_hash', normalized.scanner.rules_hash, requireSha256Ref],
      ['runtime_closure_hash', normalized.scanner.runtime_closure_hash, requireSha256Ref],
      ['component_manifest_hash', normalized.coverage.component_manifest_hash, requireSha256Ref],
      ['report_ref', normalized.report.ref, requireOpaqueRef],
      ['report_hash', normalized.report.raw_hash, requireSha256Ref],
    ];
    for (const [key, actual, normalize] of comparisons) {
      if (expected[key] === undefined) continue;
      const required = normalize(expected[key], `SkillSpector expected.${key}`);
      if (!safeEqual(actual, required)) {
        throw admissionError(
          SKILLSPECTOR_ADMISSION_DIAGNOSTIC_CODES.EXPECTED_BINDING_MISMATCH,
          'SkillSpector evidence does not bind the expected operation or package',
        );
      }
    }
    if (expected.network_enforcement !== undefined) {
      const requiredNetworkEnforcement = normalizeNetworkEnforcement(
        expected.network_enforcement,
      );
      if (canonicalize(normalized.network_enforcement)
        !== canonicalize(requiredNetworkEnforcement)) {
        throw admissionError(
          SKILLSPECTOR_ADMISSION_DIAGNOSTIC_CODES.EXPECTED_BINDING_MISMATCH,
          'SkillSpector evidence does not bind the expected network enforcement proof',
        );
      }
    }
    if (expected.requested_at !== undefined) {
      const requestedAt = requireIsoDate(expected.requested_at, 'SkillSpector expected.requested_at');
      if (Date.parse(requestedAt) < Date.parse(normalized.report.scanned_at)
        || Date.parse(requestedAt) >= Date.parse(normalized.report.valid_until)) {
        throw admissionError(
          SKILLSPECTOR_ADMISSION_DIAGNOSTIC_CODES.EXPECTED_BINDING_MISMATCH,
          'SkillSpector evidence is not valid at the host request time',
        );
      }
    }
    return normalized;
  } catch (error) {
    if (error instanceof SkillSpectorAdmissionError) throw error;
    throw admissionError(
      SKILLSPECTOR_ADMISSION_DIAGNOSTIC_CODES.INVALID_INPUT,
      'SkillSpector admission evidence is invalid',
    );
  }
}
