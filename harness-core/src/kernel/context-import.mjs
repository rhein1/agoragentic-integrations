import { promises as fs } from 'node:fs';
import path from 'node:path';
import { authorityBoundary, sanitizeForPublicEvidence, stableHash } from './events.mjs';
import { harnessDir } from './state.mjs';

export const CONTEXT_IMPORT_SCHEMA = 'agoragentic.harness.context-import.v1';

export const CONTEXT_SOURCE_PATHS = Object.freeze({
  'micro-ecf': [
    '.micro-ecf/context-packet.json',
    '.micro-ecf/policy-summary.json',
    '.micro-ecf/source-map.json',
    '.micro-ecf/harness-export.json',
    '.micro-ecf/deployment-preview.json',
    '.micro-ecf/handoff.md',
    '.micro-ecf/next-session.md',
  ],
  'ecf-core': [
    '.ecf-core/context-packet.json',
    '.ecf-core/source-map.json',
    '.ecf-core/policy-summary.json',
    '.ecf-core/evidence-units.json',
    '.ecf-core/context-evidence-units.json',
    '.ecf-core/retrieval-plan.json',
    '.ecf-core/eval-report.json',
    '.ecf-core/agent-os-import.json',
  ],
});

export async function importContext({ dir = process.cwd(), source } = {}) {
  if (!CONTEXT_SOURCE_PATHS[source]) {
    throw new Error('context import source must be micro-ecf or ecf-core');
  }
  const root = path.resolve(dir);
  const artifacts = [];
  for (const relPath of CONTEXT_SOURCE_PATHS[source]) {
    const filePath = path.join(root, relPath);
    const stat = await maybeStat(filePath);
    if (!stat?.isFile()) continue;
    const text = await fs.readFile(filePath, 'utf8');
    artifacts.push({
      path: relPath.replace(/\\/g, '/'),
      hash: stableHash(text),
      bytes: Buffer.byteLength(text),
      ...summarizePublicSafeArtifact(relPath, text),
    });
  }
  const importedAt = new Date().toISOString();
  const payload = {
    schema: CONTEXT_IMPORT_SCHEMA,
    source,
    imported_at: importedAt,
    mode: 'refs_and_hashes_only',
    artifact_count: artifacts.length,
    artifacts,
    raw_content_inlined: false,
    authority_boundary: authorityBoundary(),
  };
  const outputPath = await writeContextImport(dir, source, payload);
  return { payload, path: outputPath };
}

export async function contextStatus(dir = process.cwd()) {
  const root = path.join(harnessDir(dir), 'context-imports');
  let entries = [];
  try {
    entries = (await fs.readdir(root)).filter((file) => file.endsWith('.json')).sort();
  } catch {
    entries = [];
  }
  const imports = [];
  for (const file of entries) {
    try {
      const payload = JSON.parse(await fs.readFile(path.join(root, file), 'utf8'));
      imports.push({
        source: payload.source,
        imported_at: payload.imported_at,
        artifact_count: payload.artifact_count,
        path: `.agoragentic/context-imports/${file}`,
        raw_content_inlined: payload.raw_content_inlined === true,
      });
    } catch {
      // Ignore malformed local artifacts in status summaries.
    }
  }
  return {
    schema: 'agoragentic.harness.context-status.v1',
    generated_at: new Date().toISOString(),
    imports,
    authority_boundary: authorityBoundary(),
  };
}

async function writeContextImport(dir, source, payload) {
  const root = path.join(harnessDir(dir), 'context-imports');
  await fs.mkdir(root, { recursive: true });
  const filePath = path.join(root, `${source}.json`);
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return filePath;
}

async function maybeStat(filePath) {
  try {
    return await fs.stat(filePath);
  } catch {
    return null;
  }
}

function summarizePublicSafeArtifact(relPath, text) {
  if (relPath.endsWith('.md')) {
    const headings = text.split(/\r?\n/)
      .filter((line) => /^#{1,3}\s+/.test(line))
      .slice(0, 8)
      .map((line) => line.replace(/^#{1,3}\s+/, '').trim());
    return {
      kind: 'markdown',
      summary: sanitizeForPublicEvidence({ headings }),
    };
  }
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: 'unknown_text', summary: {} };
  }
  const citationIds = collectIds(json, /citation/i);
  const evidenceIds = collectIds(json, /evidence/i);
  const summary = {};
  for (const key of ['schema', '$schema', 'id', 'packet_id', 'policy_id', 'preview_id', 'status', 'mode', 'title', 'name']) {
    if (Object.hasOwn(json, key)) summary[key.replace('$', '')] = json[key];
  }
  return {
    kind: 'json',
    schema_ref: typeof json.schema === 'string' ? json.schema : typeof json.$schema === 'string' ? json.$schema : null,
    summary: sanitizeForPublicEvidence(summary),
    citation_ids: [...citationIds].slice(0, 50),
    evidence_ids: [...evidenceIds].slice(0, 50),
  };
}

function collectIds(value, keyPattern, out = new Set()) {
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const item of value) collectIds(item, keyPattern, out);
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    if (keyPattern.test(key)) {
      if (typeof child === 'string') out.add(child);
      if (Array.isArray(child)) {
        for (const item of child) {
          if (typeof item === 'string') out.add(item);
          else if (item && typeof item === 'object' && typeof item.id === 'string') out.add(item.id);
        }
      }
    }
    collectIds(child, keyPattern, out);
  }
  return out;
}
