import { createHash } from 'node:crypto';

export const HARNESS_EVALUATION_SCHEMA = 'agoragentic.harness.evaluation.v1';
export const SUPPORTED_IMPECCABLE_VERSION = '3.5.0';
export const SUPPORTED_IMPECCABLE_REVISION = '5d10bc842cbccd2ae7d3a88296d87d3be0b125b3';
export const SUPPORTED_SARIF_VERSION = '2.1.0';
export const SUPPORTED_SKILLOPT_VERSION = '0.2.0';
export const SUPPORTED_SKILLOPT_REVISION = '47fe269d75d3def79ffd90236261d26d84868ae5';

const SKILLOPT_ACCEPT_ACTIONS = new Set(['accept', 'accept_new_best']);
const SKILLOPT_REJECT_ACTIONS = new Set(['reject', 'reject_unverified']);

const MAX_FINDINGS = 1000;
const MAX_TOOLS = 20;
const SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'info']);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;

export function normalizeImpeccableFindings(input, options = {}) {
  const payload = Array.isArray(input) ? { findings: input } : requireObject(input, 'Impeccable payload');
  const version = requireExact(
    options.producer_version,
    SUPPORTED_IMPECCABLE_VERSION,
    'Unsupported Impeccable version',
  );
  const revision = requireExact(
    options.source_revision,
    SUPPORTED_IMPECCABLE_REVISION,
    'Unsupported Impeccable source revision',
  );
  const findings = requireArray(payload.findings, 'Impeccable findings');
  const suppressed = payload.suppressed_findings === undefined
    ? []
    : requireArray(payload.suppressed_findings, 'Impeccable suppressed_findings');

  return buildEvaluation({
    adapter: { name: 'impeccable-findings', version: '1' },
    source_tools: [{ name: 'impeccable', version, revision }],
    analyzed_revision: options.analyzed_revision,
    source_ref: options.source_ref,
    gate: options.gate,
    source_payload: payload,
    findings: [
      ...findings.map((finding) => normalizeImpeccableFinding(finding, false)),
      ...suppressed.map((finding) => normalizeImpeccableFinding(finding, true)),
    ],
    source_license: 'Apache-2.0',
  });
}

export function normalizeSarifReport(input, options = {}) {
  const report = requireObject(input, 'SARIF report');
  if (report.version !== SUPPORTED_SARIF_VERSION) {
    throw new TypeError(`Unsupported SARIF version: ${String(report.version || 'missing')}`);
  }
  const runs = requireArray(report.runs, 'SARIF runs');
  if (runs.length === 0 || runs.length > MAX_TOOLS) {
    throw new RangeError(`SARIF runs must contain between 1 and ${MAX_TOOLS} entries`);
  }

  const sourceTools = runs.map((run, index) => {
    const driver = requireObject(run?.tool?.driver, `SARIF run ${index} tool.driver`);
    return {
      name: safeIdentifier(driver.name, `SARIF run ${index} tool name`),
      version: safeIdentifier(
        driver.semanticVersion || driver.version || 'unknown',
        `SARIF run ${index} tool version`,
      ),
      revision: safeOptionalIdentifier(driver.dottedQuadFileVersion || null, `SARIF run ${index} tool revision`),
    };
  });

  const findings = [];
  for (let runIndex = 0; runIndex < runs.length; runIndex += 1) {
    const results = runs[runIndex].results === undefined
      ? []
      : requireArray(runs[runIndex].results, `SARIF run ${runIndex} results`);
    for (const result of results) {
      findings.push(normalizeSarifFinding(result, runIndex));
      if (findings.length > MAX_FINDINGS) {
        throw new RangeError(`Evaluation evidence cannot exceed ${MAX_FINDINGS} findings`);
      }
    }
  }

  return buildEvaluation({
    adapter: { name: 'sarif', version: SUPPORTED_SARIF_VERSION },
    source_tools: sourceTools,
    analyzed_revision: options.analyzed_revision,
    source_ref: options.source_ref,
    gate: options.gate,
    source_payload: report,
    findings,
    source_license: options.source_license || null,
  });
}

export function normalizeSkillOptSleepReport(input, options = {}) {
  const report = requireObject(input, 'SkillOpt-Sleep CLI summary');
  requireBoundedJson(report, 'SkillOpt-Sleep CLI summary');
  const version = requireExact(
    options.producer_version,
    SUPPORTED_SKILLOPT_VERSION,
    'Unsupported SkillOpt version',
  );
  const revision = requireExact(
    options.source_revision,
    SUPPORTED_SKILLOPT_REVISION,
    'Unsupported SkillOpt source revision',
  );
  requireBoundedInteger(report.night, 'SkillOpt night');
  const taskCount = requireBoundedInteger(report.n_tasks, 'SkillOpt task count');
  requireBoundedInteger(report.n_sessions, 'SkillOpt session count');
  const acceptedEditCount = requireBoundedInteger(report.n_accepted_edits, 'SkillOpt accepted edit count');
  requireBoundedInteger(report.n_rejected_edits, 'SkillOpt rejected edit count');
  const baseline = requireScore(report.baseline, 'SkillOpt baseline score');
  const candidate = requireScore(report.candidate, 'SkillOpt candidate score');
  const accepted = requireBoolean(report.accepted, 'SkillOpt accepted');
  const adopted = requireBoolean(report.adopted, 'SkillOpt adopted');
  const tasksReviewed = report.tasks_reviewed === true;
  if (report.tasks_reviewed !== undefined) requireBoolean(report.tasks_reviewed, 'SkillOpt tasks_reviewed');
  const holdoutReported = report.holdout_leaked !== undefined;
  const holdoutLeaked = holdoutReported
    ? requireBoolean(report.holdout_leaked, 'SkillOpt holdout_leaked')
    : null;
  const gateAction = safeIdentifier(report.gate_action, 'SkillOpt gate_action');
  const tasksFileReported = typeof report.tasks_file === 'string' && report.tasks_file.length > 0;

  const findings = [];
  if (!tasksReviewed) findings.push(skillOptFinding('tasks_not_owner_reviewed', 'high'));
  if (tasksReviewed && !tasksFileReported) findings.push(skillOptFinding('reviewed_tasks_file_not_reported', 'high'));
  if (adopted) findings.push(skillOptFinding('automatic_or_prior_adoption_observed', 'critical'));
  if (taskCount < 2) findings.push(skillOptFinding('insufficient_task_count', 'high'));
  if (!holdoutReported) findings.push(skillOptFinding('holdout_integrity_not_reported', 'medium'));
  if (holdoutLeaked === true) findings.push(skillOptFinding('holdout_integrity_leaked', 'critical'));
  if (candidate < baseline || (accepted && candidate <= baseline)) {
    findings.push(skillOptFinding('candidate_score_regressed_or_inconsistent', 'high'));
  }
  if (accepted && !SKILLOPT_ACCEPT_ACTIONS.has(gateAction)) {
    findings.push(skillOptFinding('non_gated_or_inconsistent_acceptance', 'high'));
  }
  if (!accepted && !SKILLOPT_REJECT_ACTIONS.has(gateAction)) {
    findings.push(skillOptFinding('unsupported_rejection_action', 'medium'));
  }
  if (!accepted && acceptedEditCount > 0) findings.push(skillOptFinding('rejected_candidate_retained_edits', 'high'));
  if (!accepted) findings.push(skillOptFinding('candidate_not_accepted', 'medium'));
  if (accepted && acceptedEditCount === 0) findings.push(skillOptFinding('accepted_without_recorded_edit', 'medium'));

  return buildEvaluation({
    adapter: { name: 'memory-skillopt-report', version: '1' },
    source_tools: [{ name: 'skillopt', version, revision }],
    analyzed_revision: options.analyzed_revision,
    source_ref: options.source_ref,
    gate: options.gate,
    source_payload: report,
    findings,
    source_license: 'MIT',
  });
}

export function attachEvaluationEvidenceToReceipt(receipt, entries) {
  const source = Array.isArray(entries) ? entries : [entries];
  if (source.length === 0) throw new TypeError('At least one evaluation entry is required');
  const attached = structuredClone(requireObject(receipt, 'Harness receipt'));
  if (attached.schema !== 'agoragentic.harness.local-receipt.v1') {
    throw new TypeError('Evaluation evidence can only attach to a Harness local receipt');
  }

  const existing = Array.isArray(attached.evaluations)
    ? attached.evaluations.map(verifyHarnessEvaluation)
    : [];
  attached.evaluations = [...existing, ...source.map(verifyHarnessEvaluation)];
  attached.evaluation_summary = summarizeHarnessEvaluations(attached.evaluations);
  attached.evidence = {
    ...requireObject(attached.evidence, 'Harness receipt evidence'),
    evaluation_count: attached.evaluations.length,
    evaluation_evidence_hashes: attached.evaluations.map((entry) => entry.evidence_hash),
  };
  if (attached.evaluation_summary.result === 'fail') attached.status = 'blocked';
  return attached;
}

export function summarizeHarnessEvaluations(entries = []) {
  const verified = requireArray(entries, 'Evaluation entries').map(verifyHarnessEvaluation);
  const result = verified.some((entry) => entry.result === 'fail')
    ? 'fail'
    : verified.some((entry) => entry.result === 'review')
      ? 'review'
      : 'pass';
  return {
    schema: 'agoragentic.harness.evaluation-summary.v1',
    result,
    evaluation_count: verified.length,
    finding_count: verified.reduce((sum, entry) => sum + entry.summary.total, 0),
    active_finding_count: verified.reduce((sum, entry) => sum + entry.summary.active, 0),
    suppressed_finding_count: verified.reduce((sum, entry) => sum + entry.summary.suppressed, 0),
    blocks_listing_readiness: result === 'fail',
    certification_claimed: false,
  };
}

export function computeHarnessEvaluationHash(evaluation) {
  const clone = structuredClone(requireObject(evaluation, 'Evaluation evidence'));
  clone.evidence_hash = null;
  return hashValue(clone);
}

export function verifyHarnessEvaluation(evaluation) {
  const entry = requireObject(evaluation, 'Evaluation evidence');
  if (entry.schema !== HARNESS_EVALUATION_SCHEMA) {
    throw new TypeError(`Evaluation evidence must use ${HARNESS_EVALUATION_SCHEMA}`);
  }
  if (entry.evidence_hash !== computeHarnessEvaluationHash(entry)) {
    throw new TypeError('Evaluation evidence hash mismatch');
  }
  assertExactKeys(entry, [
    'schema', 'evaluation_id', 'adapter', 'source_tools', 'source', 'configured_gate',
    'findings', 'summary', 'result', 'evidence_hash', 'truth_boundary', 'authority_boundary',
  ], 'Evaluation evidence');
  safeIdentifier(entry.evaluation_id, 'evaluation_id');
  validateAdapter(entry.adapter);
  validateSourceTools(entry.source_tools);
  validateSource(entry.source);
  const gate = normalizeGate(entry.configured_gate);
  if (stableStringify(gate) !== stableStringify(entry.configured_gate)) {
    throw new TypeError('Evaluation gate is not canonical');
  }
  const findings = requireArray(entry.findings, 'Evaluation findings');
  if (findings.length > MAX_FINDINGS) throw new RangeError(`Evaluation evidence cannot exceed ${MAX_FINDINGS} findings`);
  for (const finding of findings) {
    if (finding.producer_index >= entry.source_tools.length) {
      throw new TypeError('finding producer_index exceeds source_tools');
    }
    validateCanonicalFinding(finding);
  }
  const summary = summarizeFindings(findings);
  if (stableStringify(summary) !== stableStringify(entry.summary)) {
    throw new TypeError('Evaluation summary is not canonical');
  }
  const expectedResult = decideResult(findings, gate);
  if (entry.result !== expectedResult) throw new TypeError('Evaluation result does not match configured gate');
  const expectedId = buildEvaluationId(entry.adapter, entry.source_tools, entry.source, findings, gate);
  if (entry.evaluation_id !== expectedId) throw new TypeError('evaluation_id is not canonical');
  validateBoundaries(entry);
  return structuredClone(entry);
}

function buildEvaluation({
  adapter,
  source_tools,
  analyzed_revision,
  source_ref,
  gate,
  source_payload,
  findings,
  source_license,
}) {
  if (findings.length > MAX_FINDINGS) {
    throw new RangeError(`Evaluation evidence cannot exceed ${MAX_FINDINGS} findings`);
  }
  const normalizedGate = normalizeGate(gate);
  const source = {
    analyzed_revision: safeIdentifier(analyzed_revision, 'analyzed_revision'),
    source_ref_hash: hashString(requireString(source_ref, 'source_ref')),
    input_hash: hashValue(source_payload),
    source_license: source_license ? safeIdentifier(source_license, 'source_license') : null,
    raw_input_retained: false,
  };
  const summary = summarizeFindings(findings);
  const record = {
    schema: HARNESS_EVALUATION_SCHEMA,
    evaluation_id: buildEvaluationId(adapter, source_tools, source, findings, normalizedGate),
    adapter,
    source_tools,
    source,
    configured_gate: normalizedGate,
    findings,
    summary,
    result: decideResult(findings, normalizedGate),
    evidence_hash: null,
    truth_boundary: {
      structural_parse_only: true,
      scanner_execution_verified: false,
      finding_accuracy_verified: false,
      vulnerability_absence_claimed: false,
      certification_claimed: false,
      endorsement_claimed: false,
    },
    authority_boundary: {
      execute_tools: false,
      deploy: false,
      publish: false,
      spend: false,
      mutate_trust: false,
      bypass_owner_review: false,
    },
  };
  record.evidence_hash = computeHarnessEvaluationHash(record);
  return verifyHarnessEvaluation(record);
}

function skillOptFinding(ruleId, severity) {
  return createFinding({
    producer_index: 0,
    rule_id: `skillopt_${ruleId}`,
    severity,
    category: 'skill_optimization',
    advisory: false,
    suppressed: false,
    suppression_kind: null,
    location: { path: null, line: null, column: null },
    message: ruleId,
  });
}

function normalizeImpeccableFinding(input, forcedSuppressed) {
  const finding = requireObject(input, 'Impeccable finding');
  return createFinding({
    producer_index: 0,
    rule_id: finding.antipattern,
    severity: normalizeSeverity(finding.severity || 'warning'),
    category: finding.category || null,
    advisory: finding.advisory === true,
    suppressed: forcedSuppressed || finding.suppressed === true,
    suppression_kind: forcedSuppressed || finding.suppressed === true ? 'external_or_inline' : null,
    location: {
      path: finding.file,
      line: finding.line,
      column: null,
    },
    message: [finding.name, finding.description, finding.snippet].filter(Boolean).join('\n'),
  });
}

function normalizeSarifFinding(input, producerIndex) {
  const result = requireObject(input, 'SARIF result');
  const location = result.locations?.[0]?.physicalLocation || {};
  const region = location.region || {};
  const suppressions = Array.isArray(result.suppressions) ? result.suppressions : [];
  return createFinding({
    producer_index: producerIndex,
    rule_id: result.ruleId || `rule-index-${Number.isInteger(result.ruleIndex) ? result.ruleIndex : 'unknown'}`,
    severity: normalizeSarifSeverity(result.level),
    category: result.properties?.category || null,
    advisory: result.properties?.advisory === true || result.level === 'note',
    suppressed: suppressions.length > 0,
    suppression_kind: suppressions.length > 0
      ? safeOptionalIdentifier(suppressions[0].kind || 'external', 'SARIF suppression kind')
      : null,
    location: {
      path: location.artifactLocation?.uri,
      line: region.startLine,
      column: region.startColumn,
    },
    message: result.message?.text || result.message?.markdown || '',
  });
}

function createFinding({
  producer_index,
  rule_id,
  severity,
  category,
  advisory,
  suppressed,
  suppression_kind,
  location,
  message,
}) {
  const normalizedRule = safeIdentifier(rule_id, 'finding rule_id');
  const pathRef = location.path ? hashString(String(location.path)) : null;
  const messageHash = hashString(String(message || ''));
  const record = {
    finding_id: '',
    producer_index,
    rule_id: normalizedRule,
    severity,
    category: category ? safeIdentifier(category, 'finding category') : null,
    advisory: Boolean(advisory),
    status: suppressed ? 'suppressed' : 'active',
    suppression_kind: suppression_kind || null,
    location: {
      path_ref_hash: pathRef,
      line: boundedInteger(location.line, 'finding line'),
      column: boundedInteger(location.column, 'finding column'),
      raw_path_retained: false,
    },
    message_hash: messageHash,
    raw_message_retained: false,
    raw_snippet_retained: false,
  };
  record.finding_id = `finding_${hashValue({ ...record, finding_id: null }).slice(7, 31)}`;
  return record;
}

function normalizeGate(input = {}) {
  const gate = input === undefined ? {} : requireObject(input, 'Evaluation gate');
  const block = normalizeSeverityList(gate.block_severities ?? ['critical', 'high'], 'block_severities');
  const review = normalizeSeverityList(gate.review_severities ?? ['medium'], 'review_severities');
  if (block.some((severity) => review.includes(severity))) {
    throw new TypeError('block_severities and review_severities must not overlap');
  }
  return {
    block_severities: block,
    review_severities: review,
    fail_on_advisory: gate.fail_on_advisory === true,
  };
}

function summarizeFindings(findings) {
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  let active = 0;
  let suppressed = 0;
  let advisory = 0;
  for (const finding of findings) {
    bySeverity[finding.severity] += 1;
    if (finding.status === 'suppressed') suppressed += 1;
    else active += 1;
    if (finding.advisory) advisory += 1;
  }
  return {
    total: findings.length,
    active,
    suppressed,
    advisory,
    by_severity: bySeverity,
  };
}

function decideResult(findings, gate) {
  const active = findings.filter((finding) => finding.status === 'active');
  const gateEligible = active.filter((finding) => gate.fail_on_advisory || !finding.advisory);
  if (gateEligible.some((finding) => gate.block_severities.includes(finding.severity))) return 'fail';
  if (gateEligible.some((finding) => gate.review_severities.includes(finding.severity))) return 'review';
  return 'pass';
}

function validateCanonicalFinding(finding) {
  const entry = requireObject(finding, 'Evaluation finding');
  assertExactKeys(entry, [
    'finding_id', 'producer_index', 'rule_id', 'severity', 'category', 'advisory',
    'status', 'suppression_kind', 'location', 'message_hash', 'raw_message_retained',
    'raw_snippet_retained',
  ], 'Evaluation finding');
  safeIdentifier(entry.finding_id, 'finding_id');
  if (!Number.isInteger(entry.producer_index) || entry.producer_index < 0 || entry.producer_index >= MAX_TOOLS) {
    throw new TypeError('finding producer_index is invalid');
  }
  safeIdentifier(entry.rule_id, 'finding rule_id');
  if (!SEVERITIES.has(entry.severity)) throw new TypeError('finding severity is invalid');
  if (entry.category !== null) safeIdentifier(entry.category, 'finding category');
  if (typeof entry.advisory !== 'boolean') throw new TypeError('finding advisory must be boolean');
  if (!['active', 'suppressed'].includes(entry.status)) throw new TypeError('finding status is invalid');
  if (entry.status === 'suppressed' && !entry.suppression_kind) throw new TypeError('suppressed finding requires suppression_kind');
  if (entry.status === 'active' && entry.suppression_kind !== null) throw new TypeError('active finding cannot carry suppression_kind');
  if (entry.suppression_kind !== null) safeIdentifier(entry.suppression_kind, 'suppression_kind');
  validateLocation(entry.location);
  requireSha256(entry.message_hash, 'message_hash');
  if (entry.raw_message_retained !== false || entry.raw_snippet_retained !== false) {
    throw new TypeError('raw evaluation details must not be retained');
  }
  const expectedId = `finding_${hashValue({ ...entry, finding_id: null }).slice(7, 31)}`;
  if (entry.finding_id !== expectedId) throw new TypeError('finding_id is not canonical');
}

function validateAdapter(adapter) {
  const entry = requireObject(adapter, 'Evaluation adapter');
  assertExactKeys(entry, ['name', 'version'], 'Evaluation adapter');
  safeIdentifier(entry.name, 'adapter name');
  safeIdentifier(entry.version, 'adapter version');
}

function validateSourceTools(tools) {
  const entries = requireArray(tools, 'source_tools');
  if (entries.length === 0 || entries.length > MAX_TOOLS) throw new RangeError(`source_tools must contain 1-${MAX_TOOLS} entries`);
  for (const tool of entries) {
    const entry = requireObject(tool, 'source tool');
    assertExactKeys(entry, ['name', 'version', 'revision'], 'source tool');
    safeIdentifier(entry.name, 'source tool name');
    safeIdentifier(entry.version, 'source tool version');
    if (entry.revision !== null) safeIdentifier(entry.revision, 'source tool revision');
  }
}

function validateSource(source) {
  const entry = requireObject(source, 'Evaluation source');
  assertExactKeys(entry, [
    'analyzed_revision', 'source_ref_hash', 'input_hash', 'source_license', 'raw_input_retained',
  ], 'Evaluation source');
  safeIdentifier(entry.analyzed_revision, 'analyzed_revision');
  requireSha256(entry.source_ref_hash, 'source_ref_hash');
  requireSha256(entry.input_hash, 'input_hash');
  if (entry.source_license !== null) safeIdentifier(entry.source_license, 'source_license');
  if (entry.raw_input_retained !== false) throw new TypeError('raw evaluation input must not be retained');
}

function validateLocation(location) {
  const entry = requireObject(location, 'finding location');
  assertExactKeys(entry, ['path_ref_hash', 'line', 'column', 'raw_path_retained'], 'finding location');
  if (entry.path_ref_hash !== null) requireSha256(entry.path_ref_hash, 'path_ref_hash');
  boundedInteger(entry.line, 'finding line');
  boundedInteger(entry.column, 'finding column');
  if (entry.raw_path_retained !== false) throw new TypeError('raw finding path must not be retained');
}

function validateBoundaries(entry) {
  const truth = requireObject(entry.truth_boundary, 'truth_boundary');
  const authority = requireObject(entry.authority_boundary, 'authority_boundary');
  assertExactKeys(truth, [
    'structural_parse_only', 'scanner_execution_verified', 'finding_accuracy_verified',
    'vulnerability_absence_claimed', 'certification_claimed', 'endorsement_claimed',
  ], 'truth_boundary');
  assertExactKeys(authority, [
    'execute_tools', 'deploy', 'publish', 'spend', 'mutate_trust', 'bypass_owner_review',
  ], 'authority_boundary');
  for (const key of [
    'structural_parse_only', 'scanner_execution_verified', 'finding_accuracy_verified',
    'vulnerability_absence_claimed', 'certification_claimed', 'endorsement_claimed',
  ]) {
    if (typeof truth[key] !== 'boolean') throw new TypeError(`truth_boundary.${key} must be boolean`);
  }
  if (truth.structural_parse_only !== true || Object.entries(truth).some(([key, value]) => key !== 'structural_parse_only' && value !== false)) {
    throw new TypeError('Evaluation truth boundary overclaims verification');
  }
  for (const key of ['execute_tools', 'deploy', 'publish', 'spend', 'mutate_trust', 'bypass_owner_review']) {
    if (authority[key] !== false) throw new TypeError(`authority_boundary.${key} must remain false`);
  }
}

function normalizeSeverityList(values, label) {
  const list = requireArray(values, label).map((value) => normalizeSeverity(value));
  return [...new Set(list)].sort();
}

function normalizeSeverity(value) {
  const normalized = String(value || '').trim().toLowerCase();
  const mapped = {
    error: 'high',
    warning: 'medium',
    warn: 'medium',
    note: 'low',
    none: 'info',
    informational: 'info',
  }[normalized] || normalized;
  if (!SEVERITIES.has(mapped)) throw new TypeError(`Unsupported finding severity: ${normalized || 'missing'}`);
  return mapped;
}

function normalizeSarifSeverity(value) {
  return normalizeSeverity(value || 'warning');
}

function safeIdentifier(value, label) {
  const normalized = requireString(value, label).trim();
  if (!IDENTIFIER.test(normalized)) throw new TypeError(`${label} must be a bounded public-safe identifier`);
  return normalized;
}

function safeOptionalIdentifier(value, label) {
  return value === null || value === undefined || value === '' ? null : safeIdentifier(value, label);
}

function boundedInteger(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 1_000_000_000) {
    throw new TypeError(`${label} must be a non-negative bounded integer`);
  }
  return number;
}

function requireBoundedInteger(value, label) {
  const result = boundedInteger(value, label);
  if (result === null) throw new TypeError(`${label} is required`);
  return result;
}

function requireScore(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${label} must be a finite number from 0 through 1`);
  }
  return value;
}

function requireBoolean(value, label) {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be boolean`);
  return value;
}

function requireBoundedJson(value, label, maximum = 1024 * 1024) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new TypeError(`${label} must be JSON-serializable`);
  }
  if (Buffer.byteLength(serialized, 'utf8') > maximum) {
    throw new RangeError(`${label} exceeds ${maximum} bytes`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    throw new TypeError(`${label} must be a non-empty bounded string`);
  }
  return value;
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

function requireExact(value, expected, label) {
  if (value !== expected) throw new TypeError(`${label}; expected ${expected}`);
  return value;
}

function requireSha256(value, label) {
  if (!/^sha256:[a-f0-9]{64}$/.test(String(value || ''))) throw new TypeError(`${label} must be a sha256 reference`);
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (stableStringify(actual) !== stableStringify(wanted)) throw new TypeError(`${label} contains missing or unknown fields`);
}

function hashString(value) {
  return `sha256:${createHash('sha256').update(String(value), 'utf8').digest('hex')}`;
}

function hashValue(value) {
  return hashString(stableStringify(value));
}

function buildEvaluationId(adapter, sourceTools, source, findings, gate) {
  return `evaluation_${hashValue({ adapter, source_tools: sourceTools, source, findings, gate }).slice(7, 31)}`;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}
