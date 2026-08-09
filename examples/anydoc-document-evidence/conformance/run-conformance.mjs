#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AnyDocEvidenceError,
  convertFileToEvidence,
} from '../agoragentic-anydoc.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(HERE);
const require = createRequire(import.meta.url);
const NO_AUTHORITY = Object.freeze({
  grants_spend: false,
  grants_wallet_access: false,
  grants_deployment: false,
  grants_publication: false,
  grants_memory_write: false,
  grants_trust: false,
});
const PUBLIC_BOUNDARY = Object.freeze({
  parse_receipt_only: true,
  parser_executed_by_schema: false,
  memory_written: false,
  marketplace_publication_triggered: false,
  x402_route_created: false,
  settlement_triggered: false,
  trust_mutated: false,
  private_context_exposed: false,
});
const PINNED_FIXTURE_DEPENDENCIES = Object.freeze({
  'charset-normalizer': '3.4.9',
  'et-xmlfile': '2.0.0',
  lxml: '6.1.1',
  openpyxl: '3.1.5',
  Pillow: '12.3.0',
  'python-docx': '1.2.0',
  'python-pptx': '1.0.2',
  reportlab: '4.4.3',
  'typing-extensions': '4.16.0',
  xlsxwriter: '3.2.9',
});

function parseArgs(argv) {
  let reportPath = join(HERE, 'report.json');
  let reportPathSeen = false;
  let requireOsSandbox = false;
  for (const value of argv) {
    if (value === '--require-os-sandbox') {
      requireOsSandbox = true;
    } else if (String(value).startsWith('-')) {
      throw new Error(`Unknown option: ${value}`);
    } else if (!reportPathSeen) {
      reportPath = value;
      reportPathSeen = true;
    } else {
      throw new Error(`Unexpected argument: ${value}`);
    }
  }
  return { reportPath, requireOsSandbox };
}

function sha256Bytes(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function sha256Text(value) {
  return sha256Bytes(Buffer.from(String(value), 'utf8'));
}

async function readOptional(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

function finiteLimit(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  if (!normalized || normalized === 'max' || normalized === '-1') return null;
  const number = Number(normalized.split(/\s+/, 1)[0]);
  return Number.isFinite(number) && number > 0 ? number : null;
}

async function detectNetworkNamespace() {
  if (process.platform !== 'linux') {
    return {
      enforced: false,
      reason: 'network_namespace_observation_is_linux_only',
      interfaces: null,
      default_route_present: null,
    };
  }
  const interfaces = (await readdir('/sys/class/net')).sort();
  const route = await readOptional('/proc/net/route');
  const defaultRoutePresent = String(route || '')
    .split(/\r?\n/)
    .slice(1)
    .some((line) => line.trim().split(/\s+/)[1] === '00000000');
  const nonLoopback = interfaces.filter((name) => name !== 'lo');
  return {
    enforced: nonLoopback.length === 0 && !defaultRoutePresent,
    reason: nonLoopback.length === 0 && !defaultRoutePresent
      ? 'only_loopback_interface_and_no_default_route'
      : 'non_loopback_interface_or_default_route_present',
    interfaces,
    default_route_present: defaultRoutePresent,
  };
}

async function detectCgroupLimits() {
  if (process.platform !== 'linux') {
    return {
      memory_limit_bytes: null,
      pids_limit: null,
      cpu_quota: null,
      finite: false,
    };
  }

  const memoryV2 = await readOptional('/sys/fs/cgroup/memory.max');
  const memoryV1 = await readOptional('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  const pidsV2 = await readOptional('/sys/fs/cgroup/pids.max');
  const pidsV1 = await readOptional('/sys/fs/cgroup/pids/pids.max');
  const cpuV2 = await readOptional('/sys/fs/cgroup/cpu.max');
  const cpuQuotaV1 = await readOptional('/sys/fs/cgroup/cpu/cpu.cfs_quota_us');
  const memoryLimit = finiteLimit(memoryV2 ?? memoryV1);
  const pidsLimit = finiteLimit(pidsV2 ?? pidsV1);
  const cpuQuota = cpuV2
    ? cpuV2.trim().startsWith('max ')
      ? null
      : cpuV2.trim()
    : finiteLimit(cpuQuotaV1);
  return {
    memory_limit_bytes: memoryLimit,
    pids_limit: pidsLimit,
    cpu_quota: cpuQuota,
    finite: memoryLimit !== null && pidsLimit !== null && cpuQuota !== null,
  };
}

async function detectProcessHardening() {
  if (process.platform !== 'linux') {
    return { no_new_privileges: false, effective_capabilities_zero: false };
  }
  const status = await readOptional('/proc/self/status');
  const noNewPrivileges = /^NoNewPrivs:\s+1$/m.test(status || '');
  const capabilities = (status || '').match(/^CapEff:\s+([0-9a-f]+)$/mi)?.[1] || null;
  return {
    no_new_privileges: noNewPrivileges,
    effective_capabilities_zero: capabilities !== null && /^0+$/.test(capabilities),
  };
}

function decodeMountPath(value) {
  return value.replace(/\\([0-7]{3})/g, (_match, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
}

async function sourceMountEvidence() {
  if (process.platform !== 'linux') return null;
  const mountInfo = await readOptional('/proc/self/mountinfo');
  if (!mountInfo) return null;
  const sourcePath = resolve(HERE);
  let best = null;
  for (const line of mountInfo.split(/\r?\n/)) {
    const separator = line.indexOf(' - ');
    if (separator < 0) continue;
    const before = line.slice(0, separator).split(' ');
    const after = line.slice(separator + 3).split(' ');
    if (before.length < 6 || after.length < 3) continue;
    const mountPoint = decodeMountPath(before[4]);
    const sourceWithinMount = mountPoint === '/'
      ? sourcePath.startsWith('/')
      : sourcePath === mountPoint || sourcePath.startsWith(`${mountPoint}/`);
    if (!sourceWithinMount) continue;
    if (!best || mountPoint.length > best.mount_point.length) {
      best = {
        mount_point: mountPoint,
        mount_options: before[5].split(','),
        filesystem: after[0],
        super_options: after[2].split(','),
      };
    }
  }
  return best;
}

async function detectReadOnlySource() {
  const mount = await sourceMountEvidence();
  const probe = join(HERE, `.sandbox-write-probe-${process.pid}`);
  let writeProbeDenied = false;
  let writeProbeCode = null;
  try {
    await writeFile(probe, 'probe', { encoding: 'utf8', flag: 'wx' });
    await unlink(probe);
  } catch (error) {
    writeProbeCode = error?.code || 'unknown';
    writeProbeDenied = ['EROFS', 'EACCES', 'EPERM', 'ERR_ACCESS_DENIED'].includes(error?.code);
  }
  const mountReadOnly = mount?.mount_options?.includes('ro') === true;
  const enforced = mountReadOnly && writeProbeDenied;
  return {
    enforced,
    reason: enforced
      ? 'read_only_mount_and_write_probe_denied'
      : !mountReadOnly
        ? 'source_mount_not_verified_read_only'
        : `write_probe_not_denied_${writeProbeCode || 'writable'}`,
    mount_point: mount?.mount_point || null,
    mount_options: mount?.mount_options || null,
    filesystem: mount?.filesystem || null,
    write_probe_denied: writeProbeDenied,
    write_probe_code: writeProbeCode,
  };
}

async function detectOsSandbox(required) {
  const [network, cgroups, hardening, sourceMount] = await Promise.all([
    detectNetworkNamespace(),
    detectCgroupLimits(),
    detectProcessHardening(),
    detectReadOnlySource(),
  ]);
  const enforced = network.enforced
    && cgroups.finite
    && hardening.no_new_privileges
    && hardening.effective_capabilities_zero
    && sourceMount.enforced;
  return {
    required,
    enforced,
    network,
    cgroups,
    process_hardening: hardening,
    source_mount: sourceMount,
  };
}

function packageIntegrity(lockText, expectedVersion) {
  const lock = JSON.parse(lockText);
  const anydoc = lock.packages?.['node_modules/@firecrawl/anydoc'];
  assert(anydoc, 'package-lock.json is missing @firecrawl/anydoc');
  assert.equal(anydoc.version, expectedVersion);
  assert.match(anydoc.integrity || '', /^sha512-[A-Za-z0-9+/=]+$/);
  const nativeBindings = Object.entries(lock.packages || {})
    .filter(([path]) => /^node_modules\/@firecrawl\/anydoc-.+/.test(path))
    .map(([path, value]) => ({
      package: path.replace(/^node_modules\//, ''),
      version: value.version,
      integrity: value.integrity,
    }));
  assert(nativeBindings.length > 0, 'package-lock.json has no pinned AnyDoc native bindings');
  for (const binding of nativeBindings) {
    assert.equal(binding.version, expectedVersion);
    assert.match(binding.integrity || '', /^sha512-[A-Za-z0-9+/=]+$/);
  }
  return {
    lockfile_version: lock.lockfileVersion,
    lockfile_hash: sha256Text(lockText),
    anydoc: {
      version: anydoc.version,
      integrity: anydoc.integrity,
    },
    native_bindings: nativeBindings,
  };
}

function verifyAuthority(result) {
  assert.deepEqual(result.authority, NO_AUTHORITY);
  assert.equal(result.ecf_handoff.context_packet_ready, false);
  assert.equal(result.ecf_handoff.memory_write_allowed, false);
  assert.equal(result.ecf_handoff.marketplace_publication_allowed, false);
  assert.equal(result.ecf_handoff.x402_activation_allowed, false);
  assert.deepEqual(result.ecf_handoff.receipt.public_boundary, PUBLIC_BOUNDARY);
}

function verifyEvidenceCoverage(result, item) {
  const units = result.output.evidence_units;
  assert(units.length > 0, `${item.id} emitted no evidence units`);
  const maximum = item.options?.chunkChars || 4_000;
  let cursor = 0;
  for (const unit of units) {
    assert(unit.markdown.length <= maximum, `${item.id} emitted an oversized evidence unit`);
    assert.deepEqual(unit.source_char_range, [cursor, cursor + unit.markdown.length]);
    cursor += unit.markdown.length;
  }
  const covered = units.map((unit) => unit.markdown).join('');
  assert.equal(covered, result.output.markdown.slice(0, covered.length));
  assert.equal(result.output.evidence_coverage.covered_chars, covered.length);
  assert.equal(result.output.evidence_coverage.total_chars, result.output.markdown.length);
  assert.equal(result.output.evidence_coverage.omitted_chars, result.output.markdown.length - covered.length);
  assert.equal(result.output.evidence_coverage.covered_output_hash, sha256Text(covered));
  assert.equal(result.output.evidence_coverage.complete, item.expected_coverage_complete);
  if (item.expected_coverage_complete) {
    assert.equal(covered, result.output.markdown);
    assert.equal(result.output.evidence_coverage.covered_output_hash, result.output.output_hash);
  } else {
    assert(result.output.evidence_coverage.omitted_chars > 0);
    assert(result.output.completeness.blockers.includes('evidence_unit_coverage_incomplete'));
  }
}

function verifyConvertedResult(result, item, context, sourceBytes) {
  assert.equal(result.parser.package, '@firecrawl/anydoc');
  assert.equal(result.parser.package_version, context.cases.anydoc_version);
  assert.equal(result.parser.provenance.attested, true);
  assert.equal(result.parser.provenance.version_verified_at_runtime, true);
  assert.equal(result.parser.provenance.native_binding.package_version, context.cases.anydoc_version);
  assert.equal(result.parser.format, item.expected_canonical_format);
  assert.equal(result.parser.requested_format, item.format);
  assert.equal(result.parser.format_alias_applied, item.expected_format_alias_applied === true);
  assert.equal(result.parser.execution, 'isolated_child_process');
  assert.equal(result.parser.boundary.killable_by_parent, true);
  assert.equal(result.parser.boundary.termination_confirmed, true);
  assert.equal(result.parser.boundary.deadline_enforced, true);
  assert.equal(result.parser.boundary.network_enforcement, 'node_api_guard');
  assert.equal(result.parser.boundary.network_verified_absent, false);
  assert.equal(result.parser.boundary.native_memory_limit_enforced, false);
  assert.equal(result.parser.boundary.native_syscall_isolation, false);
  assert.equal(result.parser.network.status, 'not_observed');
  assert.equal(result.parser.network.attempted_node_api_calls, 0);
  assert.equal(result.parser.network.verified_absent, false);
  assert.equal(result.parser.environment_boundary.sensitive_key_count, 0);
  assert.equal(result.parser.ocr_used, false);
  assert.equal(result.risk.source_exact, false);
  assert.equal(result.risk.semantic_risk, item.expected_risk);
  assert.equal(result.ecf_handoff.trap_scan_status, 'not_scanned');
  assert.equal(result.ecf_handoff.receipt.status, item.expected_receipt_status);
  assert.equal(result.source.source_hash, sha256Bytes(sourceBytes));
  assert.equal(result.source.size_bytes, sourceBytes.byteLength);
  assert.equal(result.output.output_hash, sha256Text(result.output.markdown));
  assert.match(result.output.parser_output_hash, /^sha256:[a-f0-9]{64}$/);
  if (result.output.original_markdown_chars === result.output.markdown_chars) {
    assert.equal(result.output.parser_output_hash, result.output.output_hash);
  }
  verifyEvidenceCoverage(result, item);
  verifyAuthority(result);

  for (const limitation of item.expected_limitations || []) {
    assert(
      result.risk.limitations.includes(limitation),
      `${item.id} missing limitation ${limitation}`,
    );
  }
  for (const token of item.expected_markdown_tokens || []) {
    assert(
      result.output.markdown.includes(token),
      `${item.id} missing expected Markdown token ${JSON.stringify(token)}`,
    );
  }
  for (const blocker of item.expected_blockers || []) {
    assert(result.output.completeness.blockers.includes(blocker), `${item.id} missing blocker ${blocker}`);
    assert(result.ecf_handoff.blockers.includes(blocker), `${item.id} handoff missing blocker ${blocker}`);
  }
}

function publicFailure(error) {
  const rawCode = typeof error?.code === 'string' ? error.code : null;
  const code = rawCode && /^[A-Za-z0-9_:-]{1,80}$/.test(rawCode) ? rawCode : null;
  const messages = {
    ERR_ASSERTION: 'Semantic conformance assertion failed; compared values are omitted.',
    os_sandbox_unverified: 'Required OS sandbox evidence was incomplete.',
    ENOENT: 'A required conformance input was unavailable.',
    EACCES: 'A required conformance input was not readable.',
    EPERM: 'A required conformance operation was denied.',
  };
  return {
    error: messages[code] || 'The conformance operation failed; details are omitted from the public report.',
    error_code: code,
    error_name: ['AssertionError', 'AnyDocEvidenceError', 'Error'].includes(error?.name)
      ? error.name
      : 'Error',
  };
}

async function loadContext(requireOsSandbox) {
  const casesText = await readFile(join(HERE, 'cases.json'), 'utf8');
  const fixtureManifestText = await readFile(join(HERE, 'generated', 'fixture-manifest.json'), 'utf8');
  const fixtureRequirementsText = await readFile(join(HERE, 'requirements.txt'), 'utf8');
  const lockText = await readFile(join(PACKAGE_ROOT, 'package-lock.json'), 'utf8');
  const cases = JSON.parse(casesText);
  const fixtureManifest = JSON.parse(fixtureManifestText);
  const installedPackage = require('@firecrawl/anydoc/package.json');
  assert.equal(installedPackage.name, '@firecrawl/anydoc');
  assert.equal(installedPackage.version, cases.anydoc_version);
  assert.deepEqual(fixtureManifest.generator_dependencies, PINNED_FIXTURE_DEPENDENCIES);
  assert.equal(fixtureManifest.requirements_lock?.path, 'requirements.txt');
  assert.equal(fixtureManifest.requirements_lock?.hashes_required, true);
  assert.equal(fixtureManifest.requirements_lock?.source_hash, sha256Text(fixtureRequirementsText));
  const osSandbox = await detectOsSandbox(requireOsSandbox);
  if (requireOsSandbox && !osSandbox.enforced) {
    throw Object.assign(new Error('Required OS sandbox evidence is incomplete.'), { code: 'os_sandbox_unverified' });
  }
  return {
    cases,
    cases_hash: sha256Text(casesText),
    fixture_manifest: fixtureManifest,
    fixture_manifest_hash: sha256Text(fixtureManifestText),
    fixture_requirements_hash: sha256Text(fixtureRequirementsText),
    package_integrity: packageIntegrity(lockText, cases.anydoc_version),
    installed_package: { name: installedPackage.name, version: installedPackage.version },
    os_sandbox: osSandbox,
  };
}

async function runCases(context) {
  const results = [];
  let failures = 0;

  for (const item of context.cases.cases) {
    const startedAt = Date.now();
    const fixture = join(HERE, 'generated', item.file);
    const sourceBytes = await readFile(fixture);
    const fixtureRecord = context.fixture_manifest.fixtures?.[item.file];
    try {
      assert(fixtureRecord, `${item.id} is missing from fixture-manifest.json`);
      assert.equal(sourceBytes.byteLength, fixtureRecord.size_bytes);
      assert.equal(sha256Bytes(sourceBytes), fixtureRecord.source_hash);

      let result;
      try {
        result = await convertFileToEvidence(fixture, {
          format: item.format,
          maxInputBytes: 10 * 1024 * 1024,
          maxMarkdownChars: 500_000,
          maxEvidenceUnits: 128,
          ...(item.options || {}),
        });
      } catch (error) {
        if (item.expect_conversion === false
          && error instanceof AnyDocEvidenceError
          && error.code === item.expected_error_code) {
          results.push({
            id: item.id,
            file: item.file,
            status: 'pass',
            conversion: 'failed_closed_as_expected',
            source_hash: fixtureRecord.source_hash,
            source_facts: fixtureRecord.verified_source_facts,
            error_code: error.code,
            cause_code: error.causeCode,
            retryable: error.retryable,
            ocr_fallback_automatically_used: false,
            authority_evaluated: false,
            duration_ms: Date.now() - startedAt,
          });
          continue;
        }
        throw error;
      }

      assert.equal(item.expect_conversion, true, `${item.id} unexpectedly converted`);
      verifyConvertedResult(result, item, context, sourceBytes);
      results.push({
        id: item.id,
        file: item.file,
        status: 'pass',
        conversion: 'completed_with_declared_limits',
        source_hash: result.source.source_hash,
        source_facts: fixtureRecord.verified_source_facts,
        output_hash: result.output.output_hash,
        parser_output_hash: result.output.parser_output_hash,
        semantic_risk: result.risk.semantic_risk,
        limitations: result.risk.limitations,
        evidence_units: result.output.evidence_units.length,
        evidence_coverage: result.output.evidence_coverage,
        completeness: result.output.completeness,
        structure: result.output.structure,
        context_packet_ready: result.ecf_handoff.context_packet_ready,
        no_authority_grants_verified: true,
        parser_boundary: result.parser.boundary,
        parser_network_observation: result.parser.network,
        semantic_observation_labels: item.semantic_observation_labels || [],
        content_embedded_in_report: false,
        duration_ms: Date.now() - startedAt,
      });
    } catch (error) {
      failures += 1;
      results.push({
        id: item.id,
        file: item.file,
        status: 'fail',
        ...publicFailure(error),
        no_authority_grants_verified: false,
        content_embedded_in_report: false,
        duration_ms: Date.now() - startedAt,
      });
    }
  }
  return { results, failures };
}

function buildReport({ context, results, failures, harnessErrors, requireOsSandbox }) {
  const sandbox = context?.os_sandbox || {
    required: requireOsSandbox,
    enforced: false,
    unavailable_due_to_harness_error: true,
  };
  return {
    schema: 'agoragentic.anydoc-semantic-conformance-report.v1',
    generated_at: new Date().toISOString(),
    upstream: {
      repository: 'https://github.com/firecrawl/anydoc',
      package: '@firecrawl/anydoc',
      version: context?.cases?.anydoc_version || null,
      installed_package: context?.installed_package || null,
      package_integrity: context?.package_integrity || null,
      partnership_claimed: false,
    },
    fixtures: context ? {
      cases_hash: context.cases_hash,
      manifest_hash: context.fixture_manifest_hash,
      requirements_lock_hash: context.fixture_requirements_hash,
      generator_dependencies: context.fixture_manifest.generator_dependencies,
      source_facts_verified_before_parser_execution: true,
    } : null,
    sandbox,
    scope: {
      local_fixture_files_only: true,
      os_network_isolation_enforced: sandbox.enforced === true && sandbox.network?.enforced === true,
      no_network: sandbox.enforced === true && sandbox.network?.enforced === true,
      parser_node_network_api_guard: true,
      native_network_absence_claimed_without_os_sandbox: false,
      no_ocr_provider_exercised: true,
      paid_paths_exercised: false,
      publication_paths_exercised: false,
      trust_mutation_paths_exercised: false,
      report_contains_document_content: false,
    },
    summary: {
      cases: results.length,
      passed: results.filter((result) => result.status === 'pass').length,
      failed: failures + harnessErrors.length,
      harness_failures: harnessErrors.length,
      production_listing_ready: false,
    },
    harness_errors: harnessErrors,
    results,
    non_claims: [
      'A passing report is not source-exactness certification.',
      'A passing report is not universal document safety.',
      'A conversion success is not semantic fidelity proof.',
      'The in-process Node network guard is not native syscall isolation.',
      'No OCR, paid provider, marketplace publication, x402 path, or trust mutation was exercised.',
    ],
  };
}

const args = parseArgs(process.argv.slice(2));
let context = null;
let results = [];
let failures = 0;
const harnessErrors = [];

try {
  context = await loadContext(args.requireOsSandbox);
  ({ results, failures } = await runCases(context));
} catch (error) {
  harnessErrors.push(publicFailure(error));
}

const report = buildReport({
  context,
  results,
  failures,
  harnessErrors,
  requireOsSandbox: args.requireOsSandbox,
});
await mkdir(dirname(args.reportPath), { recursive: true });
await writeFile(args.reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report.summary));
if (report.summary.failed > 0) process.exitCode = 1;
