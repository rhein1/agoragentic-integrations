#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRepository = ['rhein1', 'agoragentic-integrations'].join('/');
const markdownPath = 'docs/REPOSITORY_RENAME_PREFLIGHT.md';
const jsonPath = 'docs/repository-rename-preflight.json';
const generatedPaths = new Set([markdownPath, jsonPath]);

function countOccurrences(text, needle) {
  return text.split(needle).length - 1;
}

function categoryForLine(filePath, line) {
  const categories = new Set();
  const lowerPath = filePath.toLowerCase();
  const lowerLine = line.toLowerCase();

  if (/\buses:\s*[^\s]+/.test(line)) categories.add('reusable_action');
  if (lowerLine.includes('raw.githubusercontent.com/')) categories.add('raw_content_url');
  if (/git clone|git\+https|npm (?:install|i)|pnpm (?:add|install)|yarn add|uv tool install|pipx install/.test(lowerLine)) {
    categories.add('installer_or_clone');
  }
  if (/package\.json$|pyproject\.toml$|cargo\.toml$|\.nuspec$/.test(lowerPath)
    || /"(?:repository|homepage|bugs|funding)"\s*:/.test(line)) {
    categories.add('package_registry_metadata');
  }
  if (/provenance|release|evidence|attestation/.test(lowerPath)
    || /source_(?:repository|url)|release_url|provenance/.test(lowerLine)) {
    categories.add('release_or_provenance');
  }
  if (/^(?:integrations|ecosystem)\.json$|^(?:llms|llms-full)\.txt$|\.ya?ml$|\.json$/.test(lowerPath)) {
    categories.add('machine_discovery');
  }
  if (/\.md$|\.txt$|\.html?$/.test(lowerPath)) categories.add('public_documentation');
  if (!categories.size) categories.add('source_or_test');
  return [...categories];
}

function lineRecords(filePath, text, repositorySlug) {
  const records = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const occurrences = countOccurrences(line, repositorySlug);
    if (!occurrences) continue;
    records.push({
      line: index + 1,
      occurrences,
      categories: categoryForLine(filePath, line),
      text: line.trim(),
    });
  }
  return records;
}

export function buildRepositoryRenamePreflight({ manifest, files, repositorySlug = sourceRepository }) {
  const records = [];
  const reusableActionReferences = [];
  const rawContentUrls = [];

  for (const file of files) {
    if (generatedPaths.has(file.path) || !file.text.includes(repositorySlug)) continue;
    const lines = lineRecords(file.path, file.text, repositorySlug);
    const categories = [...new Set(lines.flatMap((line) => line.categories))].sort();
    const occurrences = lines.reduce((sum, line) => sum + line.occurrences, 0);
    records.push({
      path: file.path,
      occurrences,
      line_numbers: lines.map((line) => line.line),
      categories,
    });

    for (const line of lines) {
      if (line.categories.includes('reusable_action')) {
        reusableActionReferences.push({ path: file.path, line: line.line, reference: line.text });
      }
      if (line.categories.includes('raw_content_url')) {
        rawContentUrls.push({ path: file.path, line: line.line, reference: line.text });
      }
    }
  }

  records.sort((left, right) => left.path.localeCompare(right.path));
  reusableActionReferences.sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line);
  rawContentUrls.sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line);

  const categoryCounts = {};
  for (const record of records) {
    for (const category of record.categories) categoryCounts[category] = (categoryCounts[category] ?? 0) + 1;
  }

  return {
    schema_version: '1.0.0',
    source_manifest_version: manifest.version,
    as_of: manifest.updated_at,
    source_repository: repositorySlug,
    safe_to_rename: false,
    target_repository: null,
    summary: {
      file_count: records.length,
      occurrence_count: records.reduce((sum, record) => sum + record.occurrences, 0),
      category_file_counts: Object.fromEntries(Object.entries(categoryCounts).sort(([left], [right]) => left.localeCompare(right))),
    },
    reusable_action_references: reusableActionReferences,
    raw_content_urls: rawContentUrls,
    owner_decisions: [
      'Choose the final owner and repository name; no target is authorized by this packet.',
      'Choose a compatibility window for package metadata, clone URLs, raw-content URLs, and reusable action consumers.',
      'Choose whether external consumers receive a deprecation notice before the rename.',
    ],
    rollout: [
      'Freeze unrelated changes and capture the current default-branch SHA.',
      'Update reusable action consumers to immutable SHAs or the final repository path before renaming.',
      'Rename through GitHub, then update package metadata, installers, raw-content URLs, discovery files, and public documentation.',
      'Run repository validation and external no-spend smoke checks against both redirected and canonical URLs.',
      'Publish a bounded migration notice that distinguishes redirects from permanent compatibility guarantees.',
    ],
    rollback: {
      trigger: 'Any broken reusable action, installer, raw-content URL, package metadata, discovery surface, or external no-spend smoke check.',
      steps: [
        'Restore the previous GitHub repository name while the redirect remains uncontested.',
        'Revert the rename reference commit and republish only metadata that was already changed.',
        'Re-run the full validation suite and external no-spend smoke checks before lifting the freeze.',
      ],
    },
    files: records,
  };
}

export function renderRepositoryRenamePreflight(report) {
  const categoryRows = Object.entries(report.summary.category_file_counts)
    .map(([category, count]) => `| \`${category}\` | ${count} |`)
    .join('\n');
  const actionRows = report.reusable_action_references.length
    ? report.reusable_action_references.map((item) => `| \`${item.path}:${item.line}\` | \`${item.reference.replaceAll('|', '\\|')}\` |`).join('\n')
    : '| None found | None |';
  const rawRows = report.raw_content_urls.length
    ? report.raw_content_urls.map((item) => `| \`${item.path}:${item.line}\` | \`${item.reference.replaceAll('|', '\\|')}\` |`).join('\n')
    : '| None found | None |';
  const decisions = report.owner_decisions.map((item) => `- ${item}`).join('\n');
  const rollout = report.rollout.map((item, index) => `${index + 1}. ${item}`).join('\n');
  const rollback = report.rollback.steps.map((item, index) => `${index + 1}. ${item}`).join('\n');

  return `# Repository Rename Preflight\n\n` +
    `> **No repository rename has been executed or authorized.** This is a deterministic dependency inventory and rollback plan.\n\n` +
    `- Source repository: \`${report.source_repository}\`\n` +
    `- Canonical manifest: \`${report.source_manifest_version}\` as of \`${report.as_of}\`\n` +
    `- Safe to rename now: **${report.safe_to_rename}**\n` +
    `- Authorized target: **none**\n` +
    `- Affected tracked files: **${report.summary.file_count}**\n` +
    `- Exact repository references: **${report.summary.occurrence_count}**\n\n` +
    `## Reference Classes\n\n| Class | Files |\n|---|---:|\n${categoryRows}\n\n` +
    `## Reusable Action Blockers\n\nThese consumers can fail immediately after a rename and must be migrated first.\n\n| Location | Reference |\n|---|---|\n${actionRows}\n\n` +
    `## Raw Content URLs\n\n| Location | Reference |\n|---|---|\n${rawRows}\n\n` +
    `## Owner Decisions\n\n${decisions}\n\n` +
    `## Rollout\n\n${rollout}\n\n` +
    `## Rollback\n\nTrigger: ${report.rollback.trigger}\n\n${rollback}\n\n` +
    `The complete per-file inventory is in [\`repository-rename-preflight.json\`](./repository-rename-preflight.json).\n`;
}

function trackedTextFiles() {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
    .filter((filePath) => !generatedPaths.has(filePath));
  const files = [];
  for (const filePath of tracked) {
    const buffer = fs.readFileSync(path.join(root, filePath));
    if (buffer.includes(0)) continue;
    files.push({ path: filePath.replaceAll('\\', '/'), text: buffer.toString('utf8') });
  }
  return files;
}

export function generateRepositoryRenamePreflight() {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'integrations.json'), 'utf8'));
  const report = buildRepositoryRenamePreflight({ manifest, files: trackedTextFiles() });
  return {
    report,
    json: `${JSON.stringify(report, null, 2)}\n`,
    markdown: renderRepositoryRenamePreflight(report),
  };
}

export function verifyRepositoryRenamePreflight() {
  const generated = generateRepositoryRenamePreflight();
  const expectedJson = fs.readFileSync(path.join(root, jsonPath), 'utf8');
  const expectedMarkdown = fs.readFileSync(path.join(root, markdownPath), 'utf8');
  return {
    ok: generated.json === expectedJson && generated.markdown === expectedMarkdown,
    json_current: generated.json === expectedJson,
    markdown_current: generated.markdown === expectedMarkdown,
    report: generated.report,
  };
}

function main() {
  const generated = generateRepositoryRenamePreflight();
  if (process.argv.includes('--write')) {
    fs.writeFileSync(path.join(root, jsonPath), generated.json, 'utf8');
    fs.writeFileSync(path.join(root, markdownPath), generated.markdown, 'utf8');
    console.log(`Wrote ${jsonPath} and ${markdownPath}`);
    return;
  }

  const result = verifyRepositoryRenamePreflight();
  if (!result.ok) {
    console.error(`Repository rename preflight is stale (json=${result.json_current}, markdown=${result.markdown_current}).`);
    console.error('Run: node scripts/generate-repository-rename-preflight.mjs --write');
    process.exitCode = 1;
    return;
  }
  console.log(`Repository rename preflight is current (${result.report.summary.file_count} files, ${result.report.summary.occurrence_count} references).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
