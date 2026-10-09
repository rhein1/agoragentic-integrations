'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repositoryRoot = path.resolve(__dirname, '..', '..');
const sdkPin = '1.31.0';
const clientPin = '2.3.0';
const modernPins = Object.freeze({
    '@modelcontextprotocol/client': clientPin,
    '@modelcontextprotocol/node': '2.1.1',
    '@modelcontextprotocol/server': '2.3.0',
    '@modelcontextprotocol/core': '2.3.0',
});
const load = (directory, name) => JSON.parse(readFileSync(
    path.join(repositoryRoot, directory, name), 'utf8',
));

// These are source-checkout tooling contracts, not a live OAuth qualification.
// GHSA-6qxp-vccf-f47h was fixed at SDK 1.31.0 / client 2.2.0; retain that baseline.
// Scan every
// nested lock entry so a second vulnerable copy cannot hide behind a fixed root.
for (const directory of ['mcp', 'risk-fork-hosted-mcp', 'claude-agent-sdk']) {
    test(`${directory} locks only the reviewed patched MCP OAuth dependencies`, () => {
        const manifest = load(directory, 'package.json');
        const lock = load(directory, 'package-lock.json');
        assert.equal(lock.lockfileVersion, 3);
        assert.equal(manifest.private, true, 'qualification tooling stays unpublished');
        if (directory === 'claude-agent-sdk') {
            assert.equal(manifest.overrides?.['@modelcontextprotocol/sdk'], sdkPin);
        } else {
            assert.equal(manifest.devDependencies['@modelcontextprotocol/sdk'], sdkPin);
            assert.equal(manifest.devDependencies['@modelcontextprotocol/client'], clientPin);
            assert.equal(lock.packages[''].devDependencies['@modelcontextprotocol/sdk'], sdkPin);
            assert.equal(lock.packages[''].devDependencies['@modelcontextprotocol/client'], clientPin);
        }
        let sdkCount = 0;
        let clientCount = 0;
        for (const [entryPath, entry] of Object.entries(lock.packages)) {
            if (entryPath.endsWith('node_modules/@modelcontextprotocol/sdk')) {
                sdkCount += 1;
                assert.equal(entry.version, sdkPin, `${directory}/${entryPath}`);
                assert.equal(entry.dev, true, 'no new runtime dependency');
            }
            if (entryPath.endsWith('node_modules/@modelcontextprotocol/client')) {
                clientCount += 1;
                assert.equal(entry.version, clientPin, `${directory}/${entryPath}`);
                assert.equal(entry.dependencies['@modelcontextprotocol/core'], clientPin);
                assert.equal(entry.dev, true, 'no new runtime dependency');
            }
        }
        assert.ok(sdkCount > 0, 'the audited SDK must actually be present');
        if (directory !== 'claude-agent-sdk') assert.ok(clientCount > 0);
    });
}

for (const directory of ['mcp', 'risk-fork-hosted-mcp']) {
    test(`${directory} keeps the exact coordinated modern MCP dependency closure`, () => {
        const manifest = load(directory, 'package.json');
        const lock = load(directory, 'package-lock.json');
        for (const [name, pin] of Object.entries(modernPins)) {
            if (name !== '@modelcontextprotocol/core') {
                assert.equal(manifest.devDependencies[name], pin, `${directory}/${name}`);
                assert.equal(lock.packages[''].devDependencies[name], pin, `${directory}/${name}`);
            }
            const copies = Object.entries(lock.packages).filter(([entryPath]) => (
                entryPath.endsWith(`node_modules/${name}`)
            ));
            assert.ok(copies.length > 0, `${directory} must contain ${name}`);
            for (const [entryPath, entry] of copies) {
                assert.equal(entry.version, pin, `${directory}/${entryPath}`);
                assert.equal(entry.dev, true, 'qualification tooling adds no runtime dependency');
                if (name === '@modelcontextprotocol/client' || name === '@modelcontextprotocol/server') {
                    assert.equal(entry.dependencies['@modelcontextprotocol/core'], modernPins['@modelcontextprotocol/core']);
                }
            }
        }
    });
}
