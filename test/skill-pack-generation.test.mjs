import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildExpectedOutputs,
  parseSkill,
} from '../scripts/generate-skill-pack.mjs';
import { hashCanonicalSvgSource } from '../scripts/generate-client-banner.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bAKIA[A-Z0-9]{16}\b/,
  /\bamk_[A-Za-z0-9_-]{12,}\b/,
];

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8').replace(/\r\n/g, '\n');
}

test('generated skill pack is current and authority remains disabled', () => {
  const result = spawnSync(process.execPath, ['scripts/generate-skill-pack.mjs', '--check'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const { manifest, outputs } = buildExpectedOutputs();
  assert.ok(Object.values(manifest.authority).every((value) => value === false));
  for (const [relativePath, expected] of outputs) {
    assert.equal(read(relativePath), expected, relativePath);
  }
});

test('every host receives each reachable skill exactly once', () => {
  const { manifest, outputs, skills } = buildExpectedOutputs();
  const ids = skills.map(({ id }) => id);
  for (const target of Object.values(manifest.targets)) {
    if (target.kind !== 'agent_skills') continue;
    const targetPaths = [...outputs.keys()].filter((file) => file.startsWith(`${target.root}/`));
    assert.equal(targetPaths.length, ids.length, target.root);
    for (const id of ids) {
      assert.ok(outputs.has(`${target.root}/${id}/SKILL.md`), `${target.root}: ${id}`);
    }
  }

  const router = read('skills/agoragentic/SKILL.md');
  for (const id of ids.filter((id) => id !== 'agoragentic')) {
    assert.match(router, new RegExp(`\\*\\*${id}\\*\\*`));
  }
});

test('skill frontmatter is portable and generated bodies are not duplicated', () => {
  const { manifest, skills } = buildExpectedOutputs();
  const canonicalBodies = new Set();
  for (const skill of skills) {
    const parsed = parseSkill(read(skill.source), skill.id);
    assert.ok(!canonicalBodies.has(parsed.body), `duplicate skill body: ${skill.id}`);
    canonicalBodies.add(parsed.body);
  }
  for (const target of Object.values(manifest.targets)) {
    if (target.kind !== 'agent_skills') continue;
    for (const skill of skills) {
      parseSkill(read(`${target.root}/${skill.id}/SKILL.md`), skill.id);
    }
  }
  assert.throws(() => parseSkill('---\nname: Bad Name\n---\nbody'), /frontmatter|name/);
  assert.throws(() => parseSkill('---\nname: valid-name\n---\nbody'), /description/);
});

test('generated artifacts contain no host leakage or secret-like examples', () => {
  const { manifest, outputs } = buildExpectedOutputs();
  const hostNames = {
    codex: ['Claude Code', 'Cursor', 'OpenCode', 'GitHub Copilot', 'Gemini CLI'],
    claude_code: ['Codex', 'Cursor', 'OpenCode', 'GitHub Copilot', 'Gemini CLI'],
    opencode: ['Codex', 'Claude Code', 'Cursor', 'GitHub Copilot', 'Gemini CLI'],
  };
  for (const [relativePath, content] of outputs) {
    for (const pattern of SECRET_PATTERNS) assert.doesNotMatch(content, pattern, relativePath);
  }
  for (const [targetId, forbiddenNames] of Object.entries(hostNames)) {
    const rootPath = manifest.targets[targetId].root;
    const content = [...outputs]
      .filter(([file]) => file.startsWith(`${rootPath}/`))
      .map(([, value]) => value)
      .join('\n');
    for (const forbidden of forbiddenNames) assert.doesNotMatch(content, new RegExp(forbidden, 'i'));
  }
});

test('skills.sh instructions expose router-only and complete-pack installs', () => {
  const { skills } = buildExpectedOutputs();
  const readme = read('skills/README.md');
  assert.match(readme, /--list --full-depth/);
  assert.match(readme, /--full-depth --skill agoragentic/);
  assert.match(readme, /npx skills add rhein1\/agoragentic-integrations --skill agoragentic/);
  for (const { id } of skills) assert.match(readme, new RegExp(`--skill ${id}(?:\\s|$)`));
});

test('transaction assurance host outputs share one package and schema contract', () => {
  const { manifest, outputs, skills } = buildExpectedOutputs();
  const assurance = skills.find(({ id }) => id === 'agoragentic-assure');
  assert.ok(assurance?.contract);
  const markers = [
    assurance.contract.package,
    assurance.contract.version,
    assurance.contract.source,
    ...assurance.contract.schemas,
  ];
  const hostFiles = [
    `${manifest.targets.codex.root}/agoragentic-assure/SKILL.md`,
    `${manifest.targets.claude_code.root}/agoragentic-assure/SKILL.md`,
    `${manifest.targets.opencode.root}/agoragentic-assure/SKILL.md`,
    `${manifest.targets.cursor.root}/agoragentic-assure.mdc`,
    manifest.targets.github_copilot.path,
    manifest.targets.gemini_cli.path,
  ];
  for (const relativePath of hostFiles) {
    const content = outputs.get(relativePath);
    assert.ok(content, relativePath);
    for (const marker of markers) assert.ok(content.includes(marker), `${relativePath}: ${marker}`);
    assert.match(content, /authority granted (?:by installation or evaluation: false|`false`)/i, relativePath);
  }
});

test('social banner source binding is stable across Git line-ending checkouts', () => {
  const lf = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">\n  <title>Agoragentic</title>\n</svg>\n');
  const crlf = Buffer.from(lf.toString('utf8').replaceAll('\n', '\r\n'));
  assert.equal(hashCanonicalSvgSource(crlf), hashCanonicalSvgSource(lf));
});
