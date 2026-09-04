'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const readJson = (relativePath) =>
	JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));

test('0.1.4 release metadata is locked to the audited direct toolchain', () => {
	const pkg = readJson('package.json');
	const lock = readJson('package-lock.json');
	const expectedDevDependencies = {
		'@eslint/js': '9.29.0',
		'@n8n/eslint-plugin-community-nodes': '0.29.0',
		eslint: '9.29.0',
		'eslint-import-resolver-typescript': '4.4.5',
		'eslint-plugin-import-x': '4.17.1',
		'eslint-plugin-n8n-nodes-base': '1.16.7',
		'n8n-workflow': '2.36.4',
		prettier: '3.9.6',
		typescript: '5.9.2',
		'typescript-eslint': '8.65.0',
		zod: '3.25.76',
	};

	assert.equal(pkg.version, '0.1.4');
	assert.deepEqual(pkg.devDependencies, expectedDevDependencies);
	assert.equal(pkg.peerDependencies['n8n-workflow'], '*');
	assert.equal(pkg.overrides, undefined);
	assert.equal(pkg.devDependencies['@n8n/node-cli'], undefined);
	assert.equal(pkg.devDependencies['release-it'], undefined);
	assert.equal(pkg.scripts.build, 'node scripts/build.mjs');
	assert.equal(pkg.scripts.lint, 'eslint .');
	assert.equal(pkg.engines.node, '>=20.19.0');
	assert.equal(pkg.repository.directory, 'n8n');
	assert.equal(lock.version, pkg.version);
	assert.equal(lock.packages[''].version, pkg.version);
	assert.deepEqual(lock.packages[''].devDependencies, expectedDevDependencies);
	assert.equal(lock.packages[''].peerDependencies['n8n-workflow'], '*');
	assert.equal(lock.packages['node_modules/@n8n/node-cli'], undefined);
	assert.equal(lock.packages['node_modules/@langchain/classic'], undefined);
	assert.equal(lock.packages['node_modules/@langchain/community'], undefined);
	assert.equal(lock.packages['node_modules/n8n-workflow/node_modules/uuid'].version, '11.1.1');
});

test('current n8n metadata includes required subtitle and themed icons', () => {
	const nodeSource = fs.readFileSync(
		path.join(root, 'nodes', 'Agoragentic', 'Agoragentic.node.ts'),
		'utf8',
	);
	const credentialSource = fs.readFileSync(
		path.join(root, 'credentials', 'AgoragenticApi.credentials.ts'),
		'utf8',
	);
	const eslintConfig = fs.readFileSync(path.join(root, 'eslint.config.mjs'), 'utf8');

	assert.match(nodeSource, /subtitle:/);
	assert.match(nodeSource, /light: 'file:agoragentic\.svg'/);
	assert.match(nodeSource, /dark: 'file:agoragentic\.dark\.svg'/);
	assert.match(credentialSource, /light: 'file:agoragentic\.svg'/);
	assert.match(credentialSource, /dark: 'file:agoragentic\.dark\.svg'/);
	assert.equal(fs.existsSync(path.join(root, 'credentials', 'agoragentic.dark.svg')), true);
	assert.equal(readJson('tsconfig.json').compilerOptions.incremental, false);
	assert.match(eslintConfig, /@n8n\/eslint-plugin-community-nodes/);
	assert.match(eslintConfig, /n8nCommunityNodesPlugin\.configs\.recommended/);
	assert.doesNotMatch(eslintConfig, /configWithoutCloudSupport/);
});

test('lockfile retains cross-platform optional dependencies required on Linux', () => {
	const lock = readJson('package-lock.json');

	assert.ok(lock.packages['node_modules/@emnapi/core']);
	assert.ok(lock.packages['node_modules/@emnapi/runtime']);
});
