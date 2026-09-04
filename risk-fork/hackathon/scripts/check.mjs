import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(packageRoot, '..', '..');

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (['node_modules', '.risk-fork-demo-data'].includes(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(absolute));
    else if (entry.isFile()) files.push(absolute);
    else throw new Error(`Unsupported entry in hackathon source: ${entry.name}`);
  }
  return files;
}

function runNodeCheck(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--check', file], {
      cwd: packageRoot,
      env: {},
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Syntax check failed for ${path.relative(packageRoot, file)}: ${stderr.trim()}`));
    });
  });
}

const files = await filesBelow(packageRoot);
for (const file of files.filter((value) => value.endsWith('.mjs'))) await runNodeCheck(file);
for (const file of files.filter((value) => value.endsWith('.json'))) JSON.parse(await readFile(file, 'utf8'));

const trackedText = (await Promise.all(files
  .filter((file) => /\.(?:mjs|js|json|md|html|css)$/.test(file))
  .map((file) => readFile(file, 'utf8')))).join('\n');
if (/\bnpx(?:\.cmd)?\s+(?:--yes\s+|-y\s+)?agoragentic-mcp\b/i.test(trackedText)) {
  throw new Error('Hackathon guidance resolves the forbidden legacy agoragentic-mcp registry package');
}
const forbiddenModelOptInTool = ['risk', 'fork', 'now'].join('_');
const runtimeText = (await Promise.all(files
  .filter((file) => /\.(?:mjs|js|json|md|html|css)$/.test(file))
  .filter((file) => {
    const relative = path.relative(packageRoot, file).replaceAll('\\', '/');
    return !relative.startsWith('test/') && relative !== 'scripts/check.mjs';
  })
  .map((file) => readFile(file, 'utf8')))).join('\n');
if (runtimeText.includes(forbiddenModelOptInTool)) {
  throw new Error('The forbidden model-opt-in risk_fork_now tool is present');
}
if (!trackedText.includes('DEMO ONLY — LOCAL PROTOCOL SIMULATOR — NOT AN ISOLATION BOUNDARY — NO LIVE PROTECTION')) {
  throw new Error('The exact demo-only banner is missing');
}

const inventory = JSON.parse(await readFile(path.join(repositoryRoot, 'integrations.json'), 'utf8'));
const inventoryCount = inventory.integrations?.length;
if (
  typeof inventory.version !== 'string'
  || typeof inventory.updated_at !== 'string'
  || !Number.isSafeInteger(inventoryCount)
) {
  throw new Error('Canonical integration inventory metadata is invalid');
}
const [thinLlmContext, fullLlmContext] = await Promise.all([
  readFile(path.join(repositoryRoot, 'llms.txt'), 'utf8'),
  readFile(path.join(repositoryRoot, 'llms-full.txt'), 'utf8'),
]);
const thinInventoryClaim = `Canonical inventory: \`integrations.json\` (${inventoryCount} indexed surfaces as of ${inventory.updated_at}).`;
const fullInventoryClaim = `The canonical inventory is \`integrations.json\` and contains ${inventoryCount} integration surfaces as of ${inventory.updated_at}.`;
if (!thinLlmContext.includes(thinInventoryClaim) || !fullLlmContext.includes(fullInventoryClaim)) {
  throw new Error('LLM inventory snapshot claims do not match integrations.json');
}
const ecosystem = JSON.parse(await readFile(path.join(repositoryRoot, 'ecosystem.json'), 'utf8'));
if (
  ecosystem.updated_at !== inventory.updated_at
  || ecosystem.inventory?.integration_count !== inventoryCount
) {
  throw new Error('Ecosystem inventory metadata does not match integrations.json');
}

process.stdout.write(`${JSON.stringify({
  schema: 'agoragentic.risk-fork.demo-source-check.v1',
  status: 'passed',
  syntax_files: files.filter((file) => file.endsWith('.mjs')).length,
  json_files: files.filter((file) => file.endsWith('.json')).length,
  provider_calls: 0,
  network_used: false,
  credentials_used: false,
})}\n`);
