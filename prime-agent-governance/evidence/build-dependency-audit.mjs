import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { sha256Ref } from '../../integration-qualification/src/index.mjs';

const EVIDENCE_ROOT = dirname(fileURLToPath(import.meta.url));
const LOCK_PATH = resolve(EVIDENCE_ROOT, 'prime-agent-v0.7.2-package-lock.json');
const OUTPUT_PATH = resolve(EVIDENCE_ROOT, 'prime-agent-v0.7.2-dependency-audit.v1.json');

function lockDigest() {
  return `sha256:${createHash('sha256').update(readFileSync(LOCK_PATH)).digest('hex')}`;
}

export function buildPrimeAgentV072DependencyAudit() {
  const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
  const requestedRange = lock.packages?.['']?.dependencies?.['extract-zip'];
  const resolvedVersion = lock.packages?.['node_modules/extract-zip']?.version;
  if (requestedRange !== '^2.0.1' || resolvedVersion !== '2.0.1') {
    throw new TypeError('pinned dependency lock no longer matches the observed extract-zip advisory input');
  }
  const body = {
    schema: 'agoragentic.prime-agent.dependency-audit.v1',
    observed_at: '2026-08-30T15:32:09.395Z',
    capture_method: 'npm_audit_omit_dev_json',
    package_manager: {
      name: 'npm',
      version: '11.6.2',
      audit_report_version: 2,
      command: 'npm audit --omit=dev --json',
      exit_code: 1,
    },
    dependency_closure: {
      lock_ref: 'prime-agent-governance/evidence/prime-agent-v0.7.2-package-lock.json',
      lock_digest: lockDigest(),
      dependency_name: 'extract-zip',
      dependency_direct: true,
      requested_range: requestedRange,
      resolved_version: resolvedVersion,
      affected_node: 'node_modules/extract-zip',
      production_dependency_count: 186,
      total_dependency_count: 200,
    },
    advisory: {
      id: 'GHSA-jmr9-qjv8-65gv',
      url: 'https://github.com/advisories/GHSA-jmr9-qjv8-65gv',
      title: 'extract-zip unvalidated symlink path traversal',
      severity: 'high',
      cwe: 'CWE-22',
      cvss_score: 8.1,
      cvss_vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:U/C:H/I:H/A:N',
      vulnerable_range: '<=2.0.1',
      first_patched_version: null,
      published_at: '2026-06-26T18:34:00Z',
      updated_at: '2026-08-12T19:22:04Z',
    },
    result: {
      info: 0,
      low: 0,
      moderate: 0,
      high: 1,
      critical: 0,
      total: 1,
      fix_available: false,
      promotion_blocking: true,
    },
  };
  return Object.freeze({ ...body, audit_hash: sha256Ref(body) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const rendered = `${JSON.stringify(buildPrimeAgentV072DependencyAudit(), null, 2)}\n`;
  if (process.argv.includes('--write')) {
    writeFileSync(OUTPUT_PATH, rendered, 'utf8');
  } else {
    process.stdout.write(rendered);
  }
}
