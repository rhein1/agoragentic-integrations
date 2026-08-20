import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildRepositoryRenamePreflight,
  renderRepositoryRenamePreflight,
  verifyRepositoryRenamePreflight,
} from '../scripts/generate-repository-rename-preflight.mjs';

const repositorySlug = ['rhein1', 'agoragentic-integrations'].join('/');
const manifest = { version: '9.9.9', updated_at: '2026-08-20' };

test('committed repository rename preflight matches tracked references', () => {
  const result = verifyRepositoryRenamePreflight();
  assert.equal(result.ok, true);
  assert.equal(result.report.safe_to_rename, false);
  assert.equal(result.report.target_repository, null);
});

test('preflight classifies action, raw URL, installer, and package references', () => {
  const report = buildRepositoryRenamePreflight({
    manifest,
    repositorySlug,
    files: [
      { path: '.github/workflows/reuse.yml', text: `uses: ${repositorySlug}/.github/actions/check@main\n` },
      { path: 'docs/raw.md', text: `https://raw.githubusercontent.com/${repositorySlug}/main/file.json\n` },
      { path: 'README.md', text: `git clone https://github.com/${repositorySlug}.git\n` },
      { path: 'package.json', text: `{"repository":"https://github.com/${repositorySlug}"}\n` },
    ],
  });

  assert.equal(report.summary.file_count, 4);
  assert.equal(report.reusable_action_references.length, 1);
  assert.equal(report.raw_content_urls.length, 1);
  assert.equal(report.summary.category_file_counts.reusable_action, 1);
  assert.equal(report.summary.category_file_counts.raw_content_url, 1);
  assert.equal(report.summary.category_file_counts.installer_or_clone, 1);
  assert.equal(report.summary.category_file_counts.package_registry_metadata, 1);
});

test('preflight remains a non-authorizing migration packet', () => {
  const report = buildRepositoryRenamePreflight({ manifest, repositorySlug, files: [] });
  const markdown = renderRepositoryRenamePreflight(report);
  assert.equal(report.safe_to_rename, false);
  assert.equal(report.target_repository, null);
  assert.match(markdown, /No repository rename has been executed or authorized/);
  assert.match(markdown, /## Rollback/);
});
