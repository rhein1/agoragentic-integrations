#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(root, 'skills', 'skill-pack.v2.json');
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function normalizeLf(value) {
  return String(value).replace(/\r\n/g, '\n');
}

function readText(relativePath) {
  return normalizeLf(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

export function parseSkill(text, expectedId = null) {
  const normalized = normalizeLf(text);
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(match, 'SKILL.md must have one leading YAML frontmatter block');
  const fields = {};
  for (const line of match[1].split('\n')) {
    const field = line.match(/^([a-z][a-z0-9_-]*):\s*(.+)$/);
    assert.ok(field, `unsupported or malformed frontmatter line: ${line}`);
    fields[field[1]] = field[2].trim();
  }
  assert.match(fields.name || '', SKILL_NAME_PATTERN, 'skill name must be lowercase kebab-case');
  assert.ok(fields.description, 'skill description is required');
  assert.ok(fields.description.length <= 1024, 'skill description must be at most 1024 characters');
  if (expectedId) assert.equal(fields.name, expectedId, 'skill name must match its directory id');
  return { fields, body: match[2], text: normalized };
}

function loadManifest() {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

function renderRouter(title, host, skills) {
  const entries = skills
    .map(({ id, parsed, contract }) => {
      const contractPin = contract
        ? ` Contract pin: \`${contract.package}\` \`${contract.version}\`; source \`${contract.source}\`; schemas ${contract.schemas.map((schema) => `\`${schema}\``).join(', ')}; network \`${contract.network}\`; authority granted \`${contract.authority_granted}\`.`
        : '';
      return `- \`${id}\`: ${parsed.fields.description}${contractPin}`;
    })
    .join('\n');
  return `# ${title}\n\nThis ${host} surface uses Agoragentic Skill Pack v2. For an Agoragentic request, load or read only the smallest matching skill before acting:\n\n${entries}\n\nStart with \`agoragentic\` when the route is unclear. Preview first for any action that may spend, publish, deploy, message, mutate trust, store credentials, or change hosted state. Missing policy, identity, cost, approval, or evidence means blocked. These instructions grant no authority by themselves.\n`;
}

function renderCursorRule(parsed) {
  return `---\ndescription: ${JSON.stringify(parsed.fields.description)}\nglobs:\nalwaysApply: false\n---\n\n${parsed.body}`;
}

function renderSkillsReadme(skills) {
  const installFlags = skills.map(({ id }) => ` --skill ${id}`).join('');
  const rows = skills.map(({ id, parsed }) => `| \`${id}\` | ${parsed.fields.description} |`).join('\n');
  return `# Agoragentic Skill Pack v2\n\nThe directories in this folder are the canonical, host-neutral Agent Skills source. Generated host copies are checked in so installs do not depend on symlink support; run \`node scripts/generate-skill-pack.mjs --check\` to detect drift.\n\nThe repository preserves a root \`SKILL.md\` compatibility entry. skills.sh therefore needs \`--full-depth\` when listing or installing the focused sibling skills; without it, the root router intentionally shadows deeper discovery.\n\n## Install with skills.sh\n\nList the available skills:\n\n\`\`\`bash\nnpx skills add rhein1/agoragentic-integrations --list --full-depth\n\`\`\`\n\nInstall the router only:\n\n\`\`\`bash\nnpx skills add rhein1/agoragentic-integrations --skill agoragentic\n\`\`\`\n\nInstall the complete focused pack:\n\n\`\`\`bash\nnpx skills add rhein1/agoragentic-integrations --full-depth${installFlags}\n\`\`\`\n\nChoose a host explicitly with \`--agent codex\`, \`--agent claude-code\`, \`--agent cursor\`, \`--agent opencode\`, \`--agent github-copilot\`, or another skills.sh-supported Agent Skills host. Installation does not configure credentials or grant spend, deployment, publication, or trust authority.\n\n## Skills\n\n| Skill | Purpose |\n|---|---|\n${rows}\n`;
}

export function buildExpectedOutputs(manifest = loadManifest()) {
  assert.equal(manifest.schema, 'agoragentic.skill-pack.v2');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.ok(Array.isArray(manifest.skills) && manifest.skills.length > 1);
  assert.ok(Object.values(manifest.authority).every((value) => value === false));

  const seen = new Set();
  const skills = manifest.skills.map((entry) => {
    assert.match(entry.id, SKILL_NAME_PATTERN);
    assert.ok(!seen.has(entry.id), `duplicate skill id: ${entry.id}`);
    seen.add(entry.id);
    assert.equal(entry.source, `skills/${entry.id}/SKILL.md`);
    assert.ok(Array.isArray(entry.advanced_context) && entry.advanced_context.length > 0);
    if (entry.contract) {
      assert.match(entry.contract.package || '', /^@[a-z0-9-]+\/[a-z0-9-]+$/);
      assert.match(entry.contract.version || '', /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
      assert.match(entry.contract.source || '', /^[a-z0-9][a-z0-9/-]*$/);
      assert.equal(entry.contract.network, 'none');
      assert.equal(entry.contract.authority_granted, false);
      assert.ok(Array.isArray(entry.contract.schemas) && entry.contract.schemas.length > 0);
      const packageJson = JSON.parse(readText(`${entry.contract.source}/package.json`));
      assert.equal(packageJson.name, entry.contract.package, `${entry.id}: package name drift`);
      assert.equal(packageJson.version, entry.contract.version, `${entry.id}: package version drift`);
      for (const schema of entry.contract.schemas) {
        assert.ok(fs.existsSync(path.join(root, schema)), `${entry.id}: missing schema ${schema}`);
      }
    }
    const parsed = parseSkill(readText(entry.source), entry.id);
    assert.match(parsed.body, /## Advanced Context/);
    return { ...entry, parsed };
  });

  const outputs = new Map();
  for (const target of Object.values(manifest.targets)) {
    if (target.kind !== 'agent_skills') continue;
    for (const skill of skills) {
      outputs.set(`${target.root}/${skill.id}/SKILL.md`, skill.parsed.text);
    }
  }
  for (const skill of skills) {
    outputs.set(
      `${manifest.targets.cursor.root}/${skill.id}.mdc`,
      renderCursorRule(skill.parsed),
    );
  }
  outputs.set(
    manifest.targets.github_copilot.path,
    renderRouter('Agoragentic GitHub Copilot Instructions', 'GitHub Copilot', skills),
  );
  outputs.set(
    manifest.targets.gemini_cli.path,
    renderRouter('Agoragentic Gemini CLI Extension', 'Gemini CLI', skills),
  );
  const rootSkill = skills.find(({ id }) => id === manifest.targets.compatibility_root.skill);
  assert.ok(rootSkill, 'compatibility root skill must exist');
  outputs.set(manifest.targets.compatibility_root.path, rootSkill.parsed.text);
  outputs.set('skills/README.md', renderSkillsReadme(skills));
  return { manifest, outputs, skills };
}

function managedExistingFiles(manifest) {
  const files = [];
  for (const target of Object.values(manifest.targets)) {
    if (target.kind === 'agent_skills') {
      const absolute = path.join(root, target.root);
      if (!fs.existsSync(absolute)) continue;
      for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith('agoragentic')) {
          files.push(`${target.root}/${entry.name}/SKILL.md`);
        }
      }
    } else if (target.kind === 'cursor_rules') {
      const absolute = path.join(root, target.root);
      if (!fs.existsSync(absolute)) continue;
      for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
        if (entry.isFile() && /^agoragentic.*\.mdc$/.test(entry.name)) {
          files.push(`${target.root}/${entry.name}`);
        }
      }
    }
  }
  return files;
}

export function synchronize({ check = false } = {}) {
  const { manifest, outputs } = buildExpectedOutputs();
  const failures = [];
  for (const [relativePath, content] of outputs) {
    const absolutePath = path.join(root, relativePath);
    const current = fs.existsSync(absolutePath) ? readText(relativePath) : null;
    if (current === content) continue;
    if (check) {
      failures.push(`stale or missing generated file: ${relativePath}`);
      continue;
    }
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content, 'utf8');
  }

  for (const relativePath of managedExistingFiles(manifest)) {
    if (outputs.has(relativePath)) continue;
    if (check) {
      failures.push(`unexpected stale generated file: ${relativePath}`);
    } else {
      fs.rmSync(path.join(root, relativePath), { force: true });
    }
  }

  if (failures.length > 0) {
    throw new Error(failures.join('\n'));
  }
  return { checked: check, generated_files: outputs.size };
}

function main() {
  const result = synchronize({ check: process.argv.includes('--check') });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
