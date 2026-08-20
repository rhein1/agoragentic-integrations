#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(root, 'integrations.json');

const surfaceRules = [
  {
    path: 'README.md',
    replacements: [
      {
        label: 'root README inventory count',
        pattern: /At this revision, the canonical `integrations\.json` manifest contains \*\*\d+\*\* surfaces\./g,
        render: ({ count }) => `At this revision, the canonical \`integrations.json\` manifest contains **${count}** surfaces.`,
      },
    ],
  },
  {
    path: 'llms.txt',
    replacements: [
      {
        label: 'LLM bootstrap inventory count',
        pattern: /- Canonical inventory: `integrations\.json` \(\d+ indexed surfaces as of \d{4}-\d{2}-\d{2}\)\./g,
        render: ({ count, date }) => `- Canonical inventory: \`integrations.json\` (${count} indexed surfaces as of ${date}).`,
      },
    ],
  },
  {
    path: 'llms-full.txt',
    replacements: [
      {
        label: 'LLM full-context inventory count',
        pattern: /The canonical inventory is `integrations\.json` and contains \d+ integration surfaces as of \d{4}-\d{2}-\d{2}\./g,
        render: ({ count, date }) => `The canonical inventory is \`integrations.json\` and contains ${count} integration surfaces as of ${date}.`,
      },
    ],
  },
  {
    path: 'INTEGRATION_CATALOG_GUIDE.md',
    replacements: [
      {
        label: 'catalog hero inventory count',
        pattern: /\*\*\d+ public integration surfaces for Triptych OS/g,
        render: ({ count }) => `**${count} public integration surfaces for Triptych OS`,
      },
      {
        label: 'catalog family inventory count',
        pattern: /\| \*\*\[agoragentic-integrations\]\(https:\/\/github\.com\/rhein1\/agoragentic-integrations\)\*\* \| \d+ indexed surfaces/g,
        render: ({ count }) => `| **[agoragentic-integrations](https://github.com/rhein1/agoragentic-integrations)** | ${count} indexed surfaces`,
      },
      {
        label: 'catalog featured-path inventory count',
        pattern: /The complete canonical inventory contains \*\*\d+\*\* surfaces in/g,
        render: ({ count }) => `The complete canonical inventory contains **${count}** surfaces in`,
      },
    ],
  },
  {
    path: 'assets/agoragentic-agent-commerce-banner.svg',
    replacements: [
      {
        label: 'social banner inventory count',
        pattern: />\d+ public surfaces  \|  one governed router</g,
        render: ({ count }) => `>${count} public surfaces  |  one governed router<`,
      },
    ],
  },
  {
    path: 'ecosystem.json',
    replacements: [
      {
        label: 'ecosystem profile date',
        pattern: /"updated_at": "\d{4}-\d{2}-\d{2}"/g,
        render: ({ date }) => `"updated_at": "${date}"`,
      },
      {
        label: 'ecosystem profile inventory count',
        pattern: /"integration_count": \d+/g,
        render: ({ count }) => `"integration_count": ${count}`,
      },
    ],
  },
];

function replaceExactlyOnce(text, rule, context, relativePath) {
  const matches = [...text.matchAll(rule.pattern)];
  if (matches.length !== 1) {
    throw new Error(`${relativePath}: expected one ${rule.label} marker, found ${matches.length}`);
  }
  return text.replace(rule.pattern, rule.render(context));
}

export function planIntegrationCountSync({ manifest, readFile = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8') }) {
  const count = Array.isArray(manifest.integrations) ? manifest.integrations.length : -1;
  const date = manifest.updated_at;
  if (count < 1) throw new Error('integrations.json must contain at least one integration');
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('integrations.json updated_at must be an ISO date');
  }

  const context = { count, date };
  return surfaceRules.map((surface) => {
    const before = readFile(surface.path);
    const after = surface.replacements.reduce(
      (text, rule) => replaceExactlyOnce(text, rule, context, surface.path),
      before,
    );
    return { path: surface.path, before, after, changed: before !== after };
  });
}

export function verifyIntegrationCountSync() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const updates = planIntegrationCountSync({ manifest });
  return { ok: updates.every((update) => !update.changed), updates };
}

function main() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const updates = planIntegrationCountSync({ manifest });
  const stale = updates.filter((update) => update.changed);

  if (process.argv.includes('--write')) {
    for (const update of stale) {
      fs.writeFileSync(path.join(root, update.path), update.after, 'utf8');
      console.log(`Updated ${update.path}`);
    }
    if (!stale.length) console.log('Integration count surfaces are already current.');
    return;
  }

  if (stale.length) {
    console.error(`Integration count surfaces are stale: ${stale.map((update) => update.path).join(', ')}`);
    console.error('Run: node scripts/sync-integration-counts.mjs --write');
    process.exitCode = 1;
    return;
  }
  console.log('Integration count surfaces are current.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
