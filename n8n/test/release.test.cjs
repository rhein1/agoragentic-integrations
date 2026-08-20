'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const readJson = (relativePath) =>
	JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));

test('0.1.3 release metadata is locked to the stable n8n toolchain', () => {
	const pkg = readJson('package.json');
	const lock = readJson('package-lock.json');

	assert.equal(pkg.version, '0.1.3');
	assert.equal(pkg.devDependencies['@n8n/node-cli'], '0.44.4');
	assert.equal(pkg.devDependencies.eslint, '9.32.0');
	assert.equal(pkg.devDependencies.prettier, '3.9.6');
	assert.equal(pkg.devDependencies.typescript, '5.9.2');
	assert.equal(pkg.devDependencies['n8n-workflow'], '2.35.3');
	assert.equal(pkg.devDependencies.zod, '3.25.76');
	assert.equal(pkg.peerDependencies['n8n-workflow'], '*');
	assert.equal(pkg.devDependencies['release-it'], '21.0.2');
	assert.equal(pkg.engines.node, '>=20.19.0');
	assert.equal(pkg.repository.directory, 'n8n');
	assert.equal(lock.packages[''].version, pkg.version);
	assert.equal(lock.packages[''].devDependencies['@n8n/node-cli'], '0.44.4');
	assert.equal(lock.packages[''].devDependencies.eslint, '9.32.0');
	assert.equal(lock.packages[''].devDependencies.prettier, '3.9.6');
	assert.equal(lock.packages[''].devDependencies.typescript, '5.9.2');
	assert.equal(lock.packages[''].devDependencies['n8n-workflow'], '2.35.3');
	assert.equal(lock.packages[''].devDependencies['release-it'], '21.0.2');
	assert.equal(lock.packages[''].devDependencies.zod, '3.25.76');
	assert.equal(lock.packages[''].peerDependencies['n8n-workflow'], '*');
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

	assert.match(nodeSource, /subtitle:/);
	assert.match(nodeSource, /light: 'file:agoragentic\.svg'/);
	assert.match(nodeSource, /dark: 'file:agoragentic\.dark\.svg'/);
	assert.match(credentialSource, /light: 'file:agoragentic\.svg'/);
	assert.match(credentialSource, /dark: 'file:agoragentic\.dark\.svg'/);
	assert.equal(fs.existsSync(path.join(root, 'credentials', 'agoragentic.dark.svg')), true);
	assert.equal(readJson('tsconfig.json').compilerOptions.incremental, false);
});
