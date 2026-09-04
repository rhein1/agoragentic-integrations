import { spawnSync } from 'node:child_process';
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(projectRoot, 'dist');

function isStaticFile(relativePath) {
	const extension = path.extname(relativePath).toLowerCase();
	if (extension === '.png' || extension === '.svg') return true;
	return extension === '.json' && relativePath.split(path.sep).includes('__schema__');
}

async function copyStaticFiles(relativeDirectory) {
	const sourceDirectory = path.join(projectRoot, relativeDirectory);
	const entries = await readdir(sourceDirectory, { withFileTypes: true });
	entries.sort((left, right) => left.name.localeCompare(right.name));

	for (const entry of entries) {
		const relativePath = path.join(relativeDirectory, entry.name);
		if (entry.isDirectory()) {
			await copyStaticFiles(relativePath);
			continue;
		}
		if (!entry.isFile() || !isStaticFile(relativePath)) continue;

		const destination = path.join(distRoot, relativePath);
		await mkdir(path.dirname(destination), { recursive: true });
		await cp(path.join(projectRoot, relativePath), destination);
	}
}

await rm(distRoot, { recursive: true, force: true });

const tscPath = require.resolve('typescript/bin/tsc');
const build = spawnSync(process.execPath, [tscPath], {
	cwd: projectRoot,
	stdio: 'inherit',
});
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

await Promise.all(['credentials', 'nodes'].map(copyStaticFiles));
