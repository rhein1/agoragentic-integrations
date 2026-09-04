#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeManifest } from './profile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(root, 'source', 'manifest.source.json');
const targets = [
  path.join(root, 'generated', 'ard.json'),
  path.join(root, 'generated', 'ai-catalog.json'),
];
const exampleNames = ['interchange', 'mcp', 'a2a', 'risk-fork'];

function render(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function buildArtifacts() {
  const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  const manifest = { specVersion: source.specVersion, entries: source.entries };
  normalizeManifest(manifest);
  const body = render(manifest);
  return {
    body,
    examples: Object.fromEntries(exampleNames.map((name, index) => [name, render(source.entries[index])])),
  };
}

function main() {
  const mode = process.argv[2] ?? '--check';
  if (!['--check', '--write'].includes(mode) || process.argv.length > 3) {
    throw new Error('usage: node src/generate.mjs [--check|--write]');
  }
  const artifacts = buildArtifacts();
  const expected = [
    ...targets.map((file) => ({ file, body: artifacts.body })),
    ...exampleNames.map((name) => ({ file: path.join(root, 'examples', `${name}.entry.json`), body: artifacts.examples[name] })),
  ];
  if (mode === '--write') {
    for (const item of expected) {
      fs.mkdirSync(path.dirname(item.file), { recursive: true });
      fs.writeFileSync(item.file, item.body, 'utf8');
      console.log(`Wrote ${path.relative(root, item.file)}`);
    }
    return;
  }
  const stale = expected.filter((item) => !fs.existsSync(item.file) || fs.readFileSync(item.file, 'utf8') !== item.body);
  if (stale.length) {
    throw new Error(`generated ARD artifacts are stale: ${stale.map((item) => path.relative(root, item.file)).join(', ')}`);
  }
  console.log('ARD generated artifacts are current.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
