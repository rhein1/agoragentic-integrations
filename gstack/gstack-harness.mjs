import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  buildAgentOsExport,
  checkListingReadiness,
  createLocalProof,
  createLocalReceipt,
  loadProject,
  runValidation,
  trapScan,
  writeJsonArtifact,
} from 'agoragentic-harness-core';

export const GSTACK_SOURCE_REVISION = '94993f74012782fd94416dd44b8314f6363a13a4';
export const REQUIRED_STAGES = Object.freeze(['planning', 'review', 'qa', 'release']);
export const MAX_ARTIFACT_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;

export class GstackHarnessError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GstackHarnessError';
    this.code = code;
  }
}

export async function compileGstackArtifacts({
  projectDir,
  outDir,
  artifacts,
  createdAt = new Date().toISOString(),
} = {}) {
  const projectRoot = path.resolve(requiredString(projectDir, 'projectDir'));
  const outputRoot = path.resolve(requiredString(outDir, 'outDir'));
  assertIsoTimestamp(createdAt);
  await assertOutputAbsent(outputRoot);

  const findings = [];
  const evidenceRefs = [];
  let totalBytes = 0;

  for (const stage of REQUIRED_STAGES) {
    const suppliedPath = artifacts?.[stage];
    if (!suppliedPath) {
      findings.push(finding('required_artifact_missing', stage, `A ${stage} artifact path is required.`));
      continue;
    }
    try {
      const evidence = await readArtifact({ stage, suppliedPath, projectRoot });
      totalBytes += evidence.bytes;
      if (totalBytes > MAX_TOTAL_BYTES) {
        findings.push(finding('artifact_total_too_large', stage, `Combined artifacts exceed ${MAX_TOTAL_BYTES} bytes.`));
        continue;
      }
      evidenceRefs.push(evidence);
      if (evidence.trap_scan.blocked) {
        findings.push(finding(
          'artifact_instruction_trap_detected',
          stage,
          'Supplied workflow content matched a blocked instruction pattern and remains data only.',
          { matches: evidence.trap_scan.matches.map((entry) => entry.id) },
        ));
      }
    } catch (error) {
      findings.push(finding(
        error instanceof GstackHarnessError ? error.code : 'artifact_read_failed',
        stage,
        error instanceof GstackHarnessError ? error.message : `The ${stage} artifact could not be read.`,
      ));
    }
  }

  let project;
  try {
    project = await loadProject(projectRoot);
  } catch {
    findings.push(finding(
      'harness_project_invalid',
      'project',
      'The project must contain readable Harness Core agent.yaml and policy.yaml files.',
    ));
    project = blockedFallbackProject(projectRoot);
  }

  const validation = runValidation(project);
  for (const issue of validation.issues) {
    findings.push(finding(issue.code, 'project', issue.message));
  }

  const proof = createLocalProof(project, { created_at: createdAt });
  const uniqueFindings = dedupeFindings(findings);
  proof.gstack_evidence = buildEvidenceSummary(evidenceRefs);
  proof.checks.gstack_artifacts_complete = REQUIRED_STAGES.every(stage => (
    evidenceRefs.some(entry => entry.stage === stage)
  ));
  proof.checks.gstack_artifacts_trap_scan_clear = evidenceRefs.every(entry => !entry.trap_scan.blocked);
  proof.checks.gstack_content_retained = false;
  proof.checks.gstack_executed_by_bridge = false;
  if (uniqueFindings.length > 0) {
    proof.status = 'blocked';
    proof.blocked_reasons = [...new Set([
      ...(proof.blocked_reasons || []),
      ...uniqueFindings.map(entry => entry.code),
    ])].sort();
  }

  const receipt = createLocalReceipt(project, proof, { created_at: createdAt });
  receipt.evidence.gstack_artifacts = buildEvidenceSummary(evidenceRefs);
  receipt.evidence.local_artifacts = [
    '.agoragentic/local-proof.json',
    '.agoragentic/policy-findings.json',
    ...(proof.status === 'passed' ? ['.agoragentic/agent-os-harness.json'] : []),
  ];
  receipt.receipt_boundary.gstack_executed = false;
  receipt.receipt_boundary.raw_gstack_content_retained = false;

  const policyFindings = {
    schema: 'agoragentic.gstack-policy-findings.v1',
    generated_at: createdAt,
    status: uniqueFindings.length === 0 ? 'pass' : 'blocked',
    source: {
      upstream: 'https://github.com/garrytan/gstack',
      revision: GSTACK_SOURCE_REVISION,
      compatibility_claim: 'explicit_artifact_bridge_only',
      gstack_execution_observed: false,
    },
    evidence: buildEvidenceSummary(evidenceRefs),
    findings: uniqueFindings,
    authority: noAuthority(),
  };

  const parent = path.dirname(outputRoot);
  const stagingRoot = path.join(parent, `.${path.basename(outputRoot)}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  await fs.mkdir(parent, { recursive: true });
  try {
    await fs.mkdir(stagingRoot, { recursive: false });
    await writeJsonArtifact(stagingRoot, 'local-proof.json', proof);
    await writeJsonArtifact(stagingRoot, 'local-receipt.json', receipt);
    await writeJsonArtifact(stagingRoot, 'policy-findings.json', policyFindings);

    let agentOsExport = null;
    if (proof.status === 'passed') {
      agentOsExport = buildAgentOsExport(project, { generated_at: createdAt });
      agentOsExport.gstack_evidence = buildEvidenceSummary(evidenceRefs);
      agentOsExport.gstack_boundary = {
        bridge_executed_gstack: false,
        raw_content_retained: false,
        hosted_authority_granted: false,
      };
      await writeJsonArtifact(stagingRoot, 'agent-os-harness.json', agentOsExport);
    }

    const readiness = await checkListingReadiness(project, stagingRoot);
    readiness.generated_at = createdAt;
    readiness.gstack_evidence = buildEvidenceSummary(evidenceRefs);
    readiness.gstack_boundary = {
      artifact_bridge_only: true,
      gstack_runtime_compatibility_verified: false,
      owner_approval_required: true,
    };
    if (uniqueFindings.length > 0) {
      readiness.status = 'blocked';
      readiness.blockers = dedupeBlockers([
        ...readiness.blockers,
        ...uniqueFindings.map(entry => ({ code: entry.code, message: entry.message })),
      ]);
      readiness.next_actions = ['Correct the blocked local evidence and run the bridge into a new output directory.'];
    }
    await writeJsonArtifact(stagingRoot, 'listing-readiness.json', readiness);

    await fs.rename(stagingRoot, outputRoot);
    return {
      ok: proof.status === 'passed',
      status: proof.status,
      output_dir: outputRoot,
      files: [
        '.agoragentic/local-proof.json',
        '.agoragentic/local-receipt.json',
        '.agoragentic/policy-findings.json',
        ...(agentOsExport ? ['.agoragentic/agent-os-harness.json'] : []),
        '.agoragentic/listing-readiness.json',
      ],
      finding_codes: uniqueFindings.map(entry => entry.code),
    };
  } catch (error) {
    await fs.rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

async function readArtifact({ stage, suppliedPath, projectRoot }) {
  const absolutePath = path.resolve(String(suppliedPath));
  const stat = await fs.lstat(absolutePath).catch(() => null);
  if (!stat) throw new GstackHarnessError('artifact_not_found', `The ${stage} artifact does not exist.`);
  if (stat.isSymbolicLink()) throw new GstackHarnessError('artifact_symlink_rejected', `The ${stage} artifact must not be a symbolic link.`);
  if (!stat.isFile()) throw new GstackHarnessError('artifact_not_regular_file', `The ${stage} artifact must be a regular file.`);
  if (stat.size === 0) throw new GstackHarnessError('artifact_empty', `The ${stage} artifact is empty.`);
  if (stat.size > MAX_ARTIFACT_BYTES) {
    throw new GstackHarnessError('artifact_too_large', `The ${stage} artifact exceeds ${MAX_ARTIFACT_BYTES} bytes.`);
  }

  const bytes = await fs.readFile(absolutePath);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new GstackHarnessError('artifact_not_utf8', `The ${stage} artifact must be valid UTF-8 text.`);
  }
  if (!text.trim()) throw new GstackHarnessError('artifact_empty', `The ${stage} artifact contains no non-whitespace content.`);

  const extension = path.extname(absolutePath).toLowerCase();
  const format = extension === '.json' ? 'json' : extension === '.md' ? 'markdown' : 'text';
  let shape;
  if (format === 'json') {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new GstackHarnessError('artifact_json_invalid', `The ${stage} JSON artifact is malformed.`);
    }
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new GstackHarnessError('artifact_json_invalid', `The ${stage} JSON artifact must be an object.`);
    }
    shape = { top_level_key_count: Object.keys(parsed).length };
  } else {
    shape = { line_count: text.split(/\r?\n/).length };
  }

  return {
    schema: 'agoragentic.gstack-artifact-ref.v1',
    stage,
    ref: safeReference(absolutePath, projectRoot),
    media_type: format === 'json' ? 'application/json' : format === 'markdown' ? 'text/markdown' : 'text/plain',
    bytes: bytes.length,
    sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    shape,
    trap_scan: trapScan(text),
    raw_content_retained: false,
    claim_extracted: false,
  };
}

function safeReference(absolutePath, projectRoot) {
  const relative = path.relative(projectRoot, absolutePath);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return `project:${relative.replace(/\\/g, '/')}`;
  }
  return `external:${path.basename(absolutePath)}`;
}

function blockedFallbackProject(dir) {
  return {
    dir,
    agent: { name: 'blocked-gstack-import', framework: 'gstack', primary_goal: '' },
    policy: {
      context_policy: { allowed_sources: [], denied_sources: [] },
      tool_policy: { allowed_tools: [], denied_tools: [] },
      budget_policy: { max_daily_spend_usdc: 0 },
      approval_policy: { human_gated: [] },
      deployment_policy: { exposure_mode: 'private_only', first_proof_required: false },
    },
  };
}

function buildEvidenceSummary(entries) {
  return {
    schema: 'agoragentic.gstack-evidence-summary.v1',
    required_stages: [...REQUIRED_STAGES],
    observed_stages: entries.map(entry => entry.stage).sort(),
    artifacts: entries.map(entry => ({
      schema: entry.schema,
      stage: entry.stage,
      ref: entry.ref,
      media_type: entry.media_type,
      bytes: entry.bytes,
      sha256: entry.sha256,
      shape: entry.shape,
      trap_scan: entry.trap_scan,
      raw_content_retained: false,
      claim_extracted: false,
    })),
    complete: REQUIRED_STAGES.every(stage => entries.some(entry => entry.stage === stage)),
    raw_content_retained: false,
  };
}

function finding(code, stage, message, detail = undefined) {
  return { code, stage, message, ...(detail ? { detail } : {}) };
}

function dedupeFindings(findings) {
  const seen = new Set();
  return findings.filter(entry => {
    const key = `${entry.code}:${entry.stage}:${entry.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeBlockers(blockers) {
  const seen = new Set();
  return blockers.filter(entry => {
    const key = `${entry.code}:${entry.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function noAuthority() {
  return {
    execute_gstack: false,
    call_network: false,
    call_provider: false,
    spend: false,
    settle: false,
    deploy: false,
    publish_listing: false,
    mutate_trust: false,
    write_memory: false,
  };
}

async function assertOutputAbsent(outputRoot) {
  try {
    await fs.lstat(outputRoot);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new GstackHarnessError('output_exists', 'The output directory already exists; choose a new path to preserve prior evidence.');
}

function requiredString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new GstackHarnessError('invalid_argument', `${name} is required.`);
  }
  return value;
}

function assertIsoTimestamp(value) {
  const parsed = typeof value === 'string' ? new Date(value) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new GstackHarnessError('invalid_created_at', 'createdAt must be an ISO timestamp.');
  }
}
