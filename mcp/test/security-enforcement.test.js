'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const readline = require('node:readline');
const { test } = require('node:test');
const {
    McpServer,
    createMcpHandler,
    fromJsonSchema,
} = require('@modelcontextprotocol/server');
const { toNodeHandler } = require('@modelcontextprotocol/node');

process.env.AGORAGENTIC_API_KEY = 'amk_security_enforcement_fixture_key';
const mcp = require('../mcp-server.js');
const MCP_ENTRYPOINT = path.resolve(__dirname, '..', 'mcp-server.js');
const SYNTHETIC_AMK_KEY = `amk_${'a'.repeat(64)}`;
const EMBEDDED_SYNTHETIC_AMK_KEY = `prefix${SYNTHETIC_AMK_KEY}suffix`;
const GENERIC_CREDENTIAL_TOKENS = Object.freeze([
    'sk_abcdefghijklmnop',
    'ghr-abcdefghijklmnop',
    'github_pat_abcdefghijklmnop',
    'xoxs-abcdefghijklmnop',
]);
const EMBEDDED_DISTINCTIVE_CREDENTIAL_TOKENS = Object.freeze([
    'prefixghr-abcdefghijklmnop',
    '_github_pat_abcdefghijklmnop',
    'prefixxoxb_abcdefghijklmnop',
    `xAKIA${'A'.repeat(16)}`,
    '_sk-proj-abcdefghijklmnop',
    `xsk-${'a'.repeat(32)}`,
    'prefixBearer abcdefghijklmnop',
]);
const DOCUMENTED_AMK_PLACEHOLDERS = Object.freeze([
    'amk_your_key_here',
    'amk_your_api_key_here',
]);
const OPAQUE_IDENTIFIER_CONTROLS = Object.freeze([
    'risk_fork_security_boundary_documentation',
    'prefixsk_abcdefghijklmnop',
    'e2b_cleanup_12345678-1234-4123-8123-123456789abc',
    'e2b_cleanup_ref_12345678-1234-4123-8123-123456789abc',
    'e2b_export_12345678-1234-4123-8123-123456789abc',
]);

function createFixtureServer() {
    const requests = [];
    const handler = createMcpHandler(async () => {
        const server = new McpServer({ name: 'risk-fork-enforcement-fixture', version: '1.0.0' });
        server.registerTool('safe_probe', {
            description: 'Loopback-only enforcement probe.',
            inputSchema: fromJsonSchema({
                type: 'object',
                properties: { value: { type: 'string' } },
                additionalProperties: false,
            }),
        }, async (args) => ({
            content: [{ type: 'text', text: JSON.stringify({ raw: true, value: args.value }) }],
        }));
        return server;
    }, { legacy: 'reject', responseMode: 'json' });
    const nodeHandler = toNodeHandler(handler);
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            requests.push(body);
            nodeHandler(req, res, body);
        });
    });
    return {
        requests,
        async listen() {
            await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
            return `http://127.0.0.1:${server.address().port}`;
        },
        async close() {
            await new Promise((resolve) => server.close(resolve));
        },
    };
}

function cleanImported(request, result) {
    const evidenceRef = `loopback:${request.request_id}`;
    return {
        schema: mcp.MCP_ENFORCEMENT_SCHEMAS.cleanImportedResult,
        request_id: request.request_id,
        request_hash: request.request_hash,
        phase: request.phase,
        clean_imported: true,
        authority_granted: false,
        evidence_ref: evidenceRef,
        evidence_hash: mcp.computeMcpCleanImportEvidenceHash(
            request.request_hash,
            result,
            evidenceRef,
        ),
        result,
    };
}

function cleanImportedWithUncheckedResult(request, result) {
    return {
        ...cleanImported(request, { tools: [] }),
        result,
    };
}

function spawnAcpClient(remoteUrl) {
    const child = spawn(process.execPath, [MCP_ENTRYPOINT, '--acp'], {
        env: {
            ...process.env,
            AGORAGENTIC_MCP_URL: remoteUrl,
            AGORAGENTIC_API_KEY: 'amk_acp_security_fixture_key',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    const output = readline.createInterface({ input: child.stdout });
    const pending = new Map();
    const rawWaiters = [];
    let nextId = 1;
    output.on('line', (line) => {
        const message = JSON.parse(line);
        const waiter = pending.get(message.id);
        if (waiter) {
            pending.delete(message.id);
            waiter.resolve(message);
            return;
        }
        const rawIndex = rawWaiters.findIndex((candidate) => candidate.predicate(message));
        if (rawIndex === -1) return;
        const [rawWaiter] = rawWaiters.splice(rawIndex, 1);
        rawWaiter.resolve(message);
    });
    return {
        async request(method, params = {}) {
            const id = nextId++;
            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    pending.delete(id);
                    reject(new Error(`ACP request timed out: ${method}`));
                }, 5000);
                pending.set(id, {
                    resolve(message) {
                        clearTimeout(timeout);
                        resolve(message);
                    },
                });
                child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
            });
        },
        async requestRaw(line, predicate = (message) => message.id === null) {
            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    const index = rawWaiters.findIndex((candidate) => candidate.resolve === resolveMessage);
                    if (index !== -1) rawWaiters.splice(index, 1);
                    reject(new Error('Raw ACP request timed out'));
                }, 5000);
                function resolveMessage(message) {
                    clearTimeout(timeout);
                    resolve(message);
                }
                rawWaiters.push({ predicate, resolve: resolveMessage });
                child.stdin.write(`${line}\n`, (error) => {
                    if (!error) return;
                    clearTimeout(timeout);
                    const index = rawWaiters.findIndex((candidate) => candidate.resolve === resolveMessage);
                    if (index !== -1) rawWaiters.splice(index, 1);
                    reject(error);
                });
            });
        },
        async close() {
            output.close();
            child.stdin.end();
            if (child.exitCode !== null || child.signalCode !== null) return;
            if (!child.killed) child.kill();
            await new Promise((resolve) => child.once('exit', resolve));
        },
    };
}

test('remote discovery requires the exact factory-created host capability before any I/O', async () => {
    const fixture = createFixtureServer();
    const remoteUrl = await fixture.listen();
    let unexpectedSession;
    let missingError;

    try {
        try {
            unexpectedSession = await mcp.connectRemoteClient({ remoteUrl });
        } catch (error) {
            missingError = error;
        }
        assert.equal(unexpectedSession, undefined);
        assert.equal(missingError?.code, 'MCP_RISK_FORK_ENFORCEMENT_REQUIRED');
        assert.equal(fixture.requests.length, 0);

        await assert.rejects(
            mcp.connectRemoteClient({
                remoteUrl,
                enforcementBoundary: {
                    schema: mcp.MCP_ENFORCEMENT_SCHEMAS.boundary,
                    mode: 'host_owns_network_and_clean_import',
                },
            }),
            (error) => error?.code === 'MCP_RISK_FORK_ENFORCEMENT_REQUIRED',
        );
        assert.equal(fixture.requests.length, 0);

        await assert.rejects(
            mcp.connectRemoteClient({
                remoteUrl,
                riskForkPlanner: async () => ({ directive: 'DENY' }),
            }),
            /riskForkPlanner is not a supported enforcement boundary/,
        );
        assert.equal(fixture.requests.length, 0);
    } finally {
        await mcp.closeRemoteSession(unexpectedSession);
        await fixture.close();
    }
});

test('MCP session targets reject authority-bearing URL components before the host can perform I/O', async () => {
    let openCalls = 0;
    const boundary = mcp.createMcpEnforcementBoundary({
        async openSession() {
            openCalls += 1;
            throw new Error('invalid MCP target must not reach the host');
        },
        async executeFallback() {
            throw new Error('fallback must not run');
        },
    });

    for (const remoteUrl of [
        'https://relay.example.invalid/api/mcp?apikey=raw-authority-value-not-pattern',
        'https://relay.example.invalid/api/mcp#fragment',
        'https://user:password@relay.example.invalid/api/mcp',
    ]) {
        await assert.rejects(
            mcp.connectRemoteClient({ remoteUrl, enforcementBoundary: boundary }),
            /credential-free HTTP\(S\) URL without query, fragment, or userinfo/,
            remoteUrl,
        );
    }
    for (const { remoteUrl, secret } of [
        {
            remoteUrl: `https://relay.example.invalid/api/${SYNTHETIC_AMK_KEY}/mcp`,
            secret: SYNTHETIC_AMK_KEY,
        },
        {
            remoteUrl: `https://relay.example.invalid/api/amk_%61${'a'.repeat(63)}/mcp`,
            secret: SYNTHETIC_AMK_KEY,
        },
        ...[
            ...GENERIC_CREDENTIAL_TOKENS,
            ...EMBEDDED_DISTINCTIVE_CREDENTIAL_TOKENS.filter((secret) => !secret.includes(' ')),
        ].map((secret) => ({
            remoteUrl: `https://relay.example.invalid/api/${secret}/mcp`,
            secret,
        })),
    ]) {
        await assert.rejects(
            mcp.connectRemoteClient({ remoteUrl, enforcementBoundary: boundary }),
            (error) => {
                assert.equal(error?.code, 'MCP_CREDENTIAL_MATERIAL_REJECTED');
                assert.match(error?.message ?? '', /must not contain credential material/);
                assert.equal(error?.message?.includes(secret), false);
                return true;
            },
            remoteUrl,
        );
    }
    assert.equal(openCalls, 0);
});

test('a factory-created host capability owns discovery and every request and exposes no raw client', async () => {
    assert.equal(typeof mcp.createMcpEnforcementBoundary, 'function');
    const phases = [];
    const boundary = mcp.createMcpEnforcementBoundary({
        async openSession(request) {
            phases.push(request.phase);
            assert.doesNotMatch(
                JSON.stringify(request),
                /amk_security_enforcement_fixture_key|Bearer|authorization/i,
            );
            return {
                schema: mcp.MCP_ENFORCEMENT_SCHEMAS.hostSession,
                discovery: cleanImported(request, {
                    protocol_version: mcp.MCP_V2_PROTOCOL_VERSION,
                    stateless: true,
                }),
                async request(phaseRequest) {
                    phases.push(phaseRequest.phase);
                    assert.doesNotMatch(
                        JSON.stringify(phaseRequest),
                        /amk_security_enforcement_fixture_key|Bearer|authorization/i,
                    );
                    assert.match(phaseRequest.session_binding_hash, /^sha256:[a-f0-9]{64}$/);
                    assert.equal(phaseRequest.mcp_server_ref, 'https://relay.example.invalid/api/mcp');
                    assert.equal(Object.isFrozen(phaseRequest), true);
                    assert.equal(Object.isFrozen(phaseRequest.params), true);
                    if (phaseRequest.phase === 'tools/list') {
                        return cleanImported(phaseRequest, {
                            tools: [{
                                name: 'safe_probe',
                                description: 'clean imported',
                                inputSchema: {
                                    type: 'object',
                                    properties: {
                                        apiKey: {
                                            type: 'string',
                                            description: 'Credential-shaped schema names are metadata only.',
                                        },
                                    },
                                },
                            }],
                        });
                    }
                    if (phaseRequest.phase === 'tools/call') {
                        return cleanImported(phaseRequest, {
                            content: [{ type: 'text', text: JSON.stringify({ imported: true }) }],
                        });
                    }
                    if (phaseRequest.phase === 'resources/list') {
                        return cleanImported(phaseRequest, { resources: [] });
                    }
                    if (phaseRequest.phase === 'resources/read') {
                        return cleanImported(phaseRequest, { contents: [] });
                    }
                    if (phaseRequest.phase === 'prompts/list') {
                        return cleanImported(phaseRequest, { prompts: [] });
                    }
                    if (phaseRequest.phase === 'prompts/get') {
                        return cleanImported(phaseRequest, { messages: [] });
                    }
                    throw new Error(`unexpected phase ${phaseRequest.phase}`);
                },
                async close() {},
            };
        },
        async executeFallback(request) {
            return cleanImported(request, { ok: true });
        },
    });

    const session = await mcp.connectRemoteClient({
        remoteUrl: 'https://relay.example.invalid/api/mcp',
        enforcementBoundary: boundary,
    });
    try {
        assert.equal(Object.hasOwn(session, 'client'), false);
        assert.equal(Object.hasOwn(session, 'transport'), false);
        const directory = mcp.createRemoteToolDirectory(session);
        await directory.list();
        assert.equal(await directory.has('safe_probe'), true);
        const importedCall = await session.callTool({ name: 'safe_probe', arguments: {} });
        assert.deepEqual(importedCall, {
            content: [{ type: 'text', text: JSON.stringify({ imported: true }) }],
        });
        assert.equal(Object.isFrozen(importedCall), true);
        assert.equal(Object.isFrozen(importedCall.content), true);
        assert.equal(Object.isFrozen(importedCall.content[0]), true);
        await session.listResources();
        await session.readResource({ uri: 'agoragentic://fixture' });
        await session.listPrompts();
        await session.getPrompt({ name: 'fixture' });
        assert.deepEqual(phases, [
            'server/discover',
            'tools/list',
            'tools/list',
            'tools/call',
            'resources/list',
            'resources/read',
            'prompts/list',
            'prompts/get',
        ]);
    } finally {
        await mcp.closeRemoteSession(session);
    }
});

test('a close racing a pending host request discards the late clean result', async () => {
    let releaseLateResult;
    const lateGate = new Promise((resolve) => {
        releaseLateResult = resolve;
    });
    let markPending;
    const pendingStarted = new Promise((resolve) => {
        markPending = resolve;
    });
    let closes = 0;
    const boundary = mcp.createMcpEnforcementBoundary({
        async openSession(openRequest) {
            return {
                schema: mcp.MCP_ENFORCEMENT_SCHEMAS.hostSession,
                discovery: cleanImported(openRequest, {
                    protocol_version: mcp.MCP_V2_PROTOCOL_VERSION,
                    stateless: true,
                }),
                async request(request) {
                    if (request.phase === 'tools/list') {
                        return cleanImported(request, { tools: [{ name: 'late_probe' }] });
                    }
                    markPending();
                    await lateGate;
                    return cleanImported(request, {
                        content: [{ type: 'text', text: 'late result must be discarded' }],
                    });
                },
                async close() {
                    closes += 1;
                },
            };
        },
        async executeFallback() {
            throw new Error('fallback must not run');
        },
    });
    const session = await mcp.connectRemoteClient({
        remoteUrl: 'https://late-result.example.invalid/api/mcp',
        enforcementBoundary: boundary,
    });
    const pending = session.callTool({ name: 'late_probe', arguments: {} });
    await pendingStarted;
    await session.close();
    releaseLateResult();
    await assert.rejects(
        pending,
        (error) => error?.code === 'MCP_ENFORCED_SESSION_CLOSED',
    );
    assert.equal(closes, 1);
});

test('concurrent and repeated close calls share truthful host-cleanup completion', async () => {
    let releaseClose;
    const closeGate = new Promise((resolve) => {
        releaseClose = resolve;
    });
    let markCloseStarted;
    const closeStarted = new Promise((resolve) => {
        markCloseStarted = resolve;
    });
    let closes = 0;
    const boundary = mcp.createMcpEnforcementBoundary({
        async openSession(openRequest) {
            return {
                schema: mcp.MCP_ENFORCEMENT_SCHEMAS.hostSession,
                discovery: cleanImported(openRequest, {
                    protocol_version: mcp.MCP_V2_PROTOCOL_VERSION,
                    stateless: true,
                }),
                async request(request) {
                    return cleanImported(request, { tools: [] });
                },
                async close() {
                    closes += 1;
                    markCloseStarted();
                    await closeGate;
                },
            };
        },
        async executeFallback() {
            throw new Error('fallback must not run');
        },
    });
    const session = await mcp.connectRemoteClient({
        remoteUrl: 'https://close-completion.example.invalid/api/mcp',
        enforcementBoundary: boundary,
    });

    const firstClose = session.close();
    await closeStarted;
    const secondClose = session.close();
    assert.strictEqual(secondClose, firstClose);
    let secondSettled = false;
    void secondClose.finally(() => {
        secondSettled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(secondSettled, false, 'a repeated close must await the active host cleanup');
    releaseClose();
    await Promise.all([firstClose, secondClose]);
    assert.equal(closes, 1);

    let failedCloses = 0;
    const failedBoundary = mcp.createMcpEnforcementBoundary({
        async openSession(openRequest) {
            return {
                schema: mcp.MCP_ENFORCEMENT_SCHEMAS.hostSession,
                discovery: cleanImported(openRequest, {
                    protocol_version: mcp.MCP_V2_PROTOCOL_VERSION,
                    stateless: true,
                }),
                async request(request) {
                    return cleanImported(request, { tools: [] });
                },
                async close() {
                    failedCloses += 1;
                    throw new Error('synthetic host cleanup failed');
                },
            };
        },
        async executeFallback() {
            throw new Error('fallback must not run');
        },
    });
    const failedSession = await mcp.connectRemoteClient({
        remoteUrl: 'https://close-failure.example.invalid/api/mcp',
        enforcementBoundary: failedBoundary,
    });
    const firstFailure = failedSession.close();
    const repeatedFailure = failedSession.close();
    assert.strictEqual(repeatedFailure, firstFailure);
    await assert.rejects(firstFailure, /synthetic host cleanup failed/);
    await assert.rejects(repeatedFailure, /synthetic host cleanup failed/);
    assert.equal(failedCloses, 1);
});

test('stdio EOF closes the enforced host session before the relay exits', async () => {
    const probeSource = `
        const mcp = require(${JSON.stringify(MCP_ENTRYPOINT)});
        function cleanImported(request, result) {
            const evidenceRef = 'eof-probe:' + request.request_id;
            return {
                schema: mcp.MCP_ENFORCEMENT_SCHEMAS.cleanImportedResult,
                request_id: request.request_id,
                request_hash: request.request_hash,
                phase: request.phase,
                clean_imported: true,
                authority_granted: false,
                evidence_ref: evidenceRef,
                evidence_hash: mcp.computeMcpCleanImportEvidenceHash(
                    request.request_hash,
                    result,
                    evidenceRef,
                ),
                result,
            };
        }
        let hold;
        const boundary = mcp.createMcpEnforcementBoundary({
            async openSession(openRequest) {
                hold = setInterval(() => {}, 1000);
                return {
                    schema: mcp.MCP_ENFORCEMENT_SCHEMAS.hostSession,
                    discovery: cleanImported(openRequest, {
                        protocol_version: mcp.MCP_V2_PROTOCOL_VERSION,
                        stateless: true,
                    }),
                    async request(request) {
                        return cleanImported(request, { tools: [] });
                    },
                    async close() {
                        clearInterval(hold);
                        console.error('EOF_HOST_CLOSE_CALLED');
                    },
                };
            },
            async executeFallback() {
                throw new Error('fallback must not run');
            },
        });
        mcp.runMcpRelay({ enforcementBoundary: boundary }).catch((error) => {
            console.error(error);
            process.exit(1);
        });
    `;
    const child = spawn(process.execPath, ['-e', probeSource], {
        cwd: path.resolve(__dirname, '..'),
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    const relayReady = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`EOF probe did not start\n${stderr}`)), 5000);
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
            if (stderr.includes('stdio relay')) {
                clearTimeout(timeout);
                resolve();
            }
        });
        child.once('exit', (code) => {
            clearTimeout(timeout);
            reject(new Error(`EOF probe exited before readiness with code ${code}\n${stderr}`));
        });
    });
    const exit = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));

    await relayReady;
    child.stdin.end();
    const outcome = await Promise.race([
        exit.then((value) => ({ exited: true, value })),
        new Promise((resolve) => setTimeout(() => resolve({ exited: false }), 1000)),
    ]);
    if (!outcome.exited) {
        child.kill();
        await exit;
    }
    assert.equal(outcome.exited, true, `relay remained alive after stdin EOF\n${stderr}`);
    assert.equal(outcome.value.code, 0, stderr);
    assert.match(stderr, /EOF_HOST_CLOSE_CALLED/);
});

test('invalid clean-import and negotiation claims close the host session before acceptance', async () => {
    for (const fixture of [
        {
            label: 'raw unimported discovery response',
            discoveryEnvelope: () => ({
                protocol_version: mcp.MCP_V2_PROTOCOL_VERSION,
                stateless: true,
            }),
            request: async () => {
                throw new Error('request must not run after raw discovery');
            },
            error: /clean imported result/,
        },
        {
            label: 'wrong negotiated version',
            discovery: {
                protocol_version: '2099-01-01',
                stateless: true,
            },
            request: async () => {
                throw new Error('request must not run after bad discovery');
            },
            error: (value) => value?.code === 'MCP_REMOTE_NEGOTIATION_REJECTED',
        },
        {
            label: 'raw unimported tools response',
            discovery: {
                protocol_version: mcp.MCP_V2_PROTOCOL_VERSION,
                stateless: true,
            },
            request: async () => ({ tools: [{ name: 'raw_bypass' }] }),
            error: /clean imported result/,
        },
        {
            label: 'credential-bearing imported response',
            discovery: {
                protocol_version: mcp.MCP_V2_PROTOCOL_VERSION,
                stateless: true,
            },
            request: async (request) => cleanImported(request, {
                tools: [{ name: 'credential_bypass', description: 'Bearer secret-token-value-12345' }],
            }),
            error: (value) => value?.code === 'MCP_CREDENTIAL_MATERIAL_REJECTED',
        },
        {
            label: 'embedded exact generated amk in imported response',
            discovery: {
                protocol_version: mcp.MCP_V2_PROTOCOL_VERSION,
                stateless: true,
            },
            request: async (request) => cleanImported(request, {
                tools: [{ name: 'generated_amk_bypass', description: EMBEDDED_SYNTHETIC_AMK_KEY }],
            }),
            error: (value) => value?.code === 'MCP_CREDENTIAL_MATERIAL_REJECTED'
                && !value?.message?.includes(SYNTHETIC_AMK_KEY),
        },
        {
            label: 'exact generated amk in imported object key',
            discovery: {
                protocol_version: mcp.MCP_V2_PROTOCOL_VERSION,
                stateless: true,
            },
            request: async (request) => cleanImported(request, {
                tools: [{
                    name: 'generated_amk_key_bypass',
                    metadata: { [SYNTHETIC_AMK_KEY]: 'opaque' },
                }],
            }),
            error: (value) => value?.code === 'MCP_CREDENTIAL_MATERIAL_REJECTED'
                && /<key>|object key/.test(value?.message ?? '')
                && !value?.message?.includes(SYNTHETIC_AMK_KEY),
        },
        ...[
            ...GENERIC_CREDENTIAL_TOKENS,
            ...EMBEDDED_DISTINCTIVE_CREDENTIAL_TOKENS,
        ].map((token, index) => ({
            label: `credential token variant ${index + 1} in imported object key`,
            discovery: {
                protocol_version: mcp.MCP_V2_PROTOCOL_VERSION,
                stateless: true,
            },
            request: async (request) => cleanImported(request, {
                tools: [{
                    name: 'generic_token_key_bypass',
                    metadata: { [token]: 'opaque' },
                }],
            }),
            error: (value) => value?.code === 'MCP_CREDENTIAL_MATERIAL_REJECTED'
                && /<key>|object key/.test(value?.message ?? '')
                && !value?.message?.includes(token),
        })),
        {
            label: 'generic token-bearing imported response',
            discovery: {
                protocol_version: mcp.MCP_V2_PROTOCOL_VERSION,
                stateless: true,
            },
            request: async (request) => cleanImported(request, {
                tools: [{ name: 'credential_bypass', token: 'opaque-but-authority-bearing' }],
            }),
            error: (value) => value?.code === 'MCP_CREDENTIAL_MATERIAL_REJECTED',
        },
        {
            label: 'nested authorization object in imported response',
            discovery: {
                protocol_version: mcp.MCP_V2_PROTOCOL_VERSION,
                stateless: true,
            },
            request: async (request) => cleanImported(request, {
                tools: [{
                    name: 'nested_credential_bypass',
                    metadata: { authorization: { value: 'raw-secret-value-not-pattern' } },
                }],
            }),
            error: (value) => value?.code === 'MCP_CREDENTIAL_MATERIAL_REJECTED',
        },
        {
            label: 'camel-case plural credential key in imported response',
            discovery: {
                protocol_version: mcp.MCP_V2_PROTOCOL_VERSION,
                stateless: true,
            },
            request: async (request) => cleanImported(request, {
                tools: [{
                    name: 'plural_credential_bypass',
                    apiKeys: { primary: 'raw-secret-value-not-pattern' },
                }],
            }),
            error: (value) => value?.code === 'MCP_CREDENTIAL_MATERIAL_REJECTED',
        },
        {
            label: 'credential schema default in imported tools list',
            discovery: {
                protocol_version: mcp.MCP_V2_PROTOCOL_VERSION,
                stateless: true,
            },
            request: async (request) => cleanImported(request, {
                tools: [{
                    name: 'schema_default_bypass',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            apiKey: { type: 'string', default: 'raw-secret-value-not-pattern' },
                        },
                    },
                }],
            }),
            error: (value) => value?.code === 'MCP_CREDENTIAL_MATERIAL_REJECTED',
        },
        {
            label: 'wrong request binding hash',
            discovery: {
                protocol_version: mcp.MCP_V2_PROTOCOL_VERSION,
                stateless: true,
            },
            request: async (request) => ({
                ...cleanImported(request, { tools: [{ name: 'hash_bypass' }] }),
                request_hash: `sha256:${'0'.repeat(64)}`,
            }),
            error: (value) => value?.code === 'MCP_RISK_FORK_IMPORT_INVALID',
        },
        {
            label: 'evidence hash does not bind imported result',
            discovery: {
                protocol_version: mcp.MCP_V2_PROTOCOL_VERSION,
                stateless: true,
            },
            request: async (request) => ({
                ...cleanImported(request, { tools: [{ name: 'evidence_bypass' }] }),
                evidence_hash: `sha256:${'0'.repeat(64)}`,
            }),
            error: (value) => value?.code === 'MCP_RISK_FORK_IMPORT_INVALID',
        },
        {
            label: 'sparse imported JSON array',
            discovery: {
                protocol_version: mcp.MCP_V2_PROTOCOL_VERSION,
                stateless: true,
            },
            request: async (request) => {
                const tools = [];
                tools.length = 1;
                return cleanImported(request, { tools });
            },
            error: /sparse/,
        },
    ]) {
        let closes = 0;
        const boundary = mcp.createMcpEnforcementBoundary({
            async openSession(openRequest) {
                return {
                    schema: mcp.MCP_ENFORCEMENT_SCHEMAS.hostSession,
                    discovery: fixture.discoveryEnvelope
                        ? fixture.discoveryEnvelope(openRequest)
                        : cleanImported(openRequest, fixture.discovery),
                    request: fixture.request,
                    async close() {
                        closes += 1;
                    },
                };
            },
            async executeFallback() {
                throw new Error('fallback must not run');
            },
        });
        await assert.rejects(
            mcp.connectRemoteClient({
                remoteUrl: 'https://invalid-import.example.invalid/api/mcp',
                enforcementBoundary: boundary,
            }),
            fixture.error,
            fixture.label,
        );
        assert.equal(closes, 1, fixture.label);
    }
});

test('evidence references are canonical and hash-bound for discovery and later requests', async () => {
    const requestHash = `sha256:${'0'.repeat(64)}`;
    assert.throws(
        () => mcp.computeMcpCleanImportEvidenceHash(requestHash, {}, undefined),
        /canonical evidence reference/,
    );
    assert.throws(
        () => mcp.computeMcpCleanImportEvidenceHash(requestHash, {}, ' evidence:noncanonical'),
        /canonical evidence reference/,
    );
    for (const secret of [
        SYNTHETIC_AMK_KEY,
        ...GENERIC_CREDENTIAL_TOKENS,
        ...EMBEDDED_DISTINCTIVE_CREDENTIAL_TOKENS.filter((value) => !value.includes(' ')),
    ]) {
        const embeddedEvidenceRef = `evidence:${secret}`;
        assert.throws(
            () => mcp.computeMcpCleanImportEvidenceHash(requestHash, {}, embeddedEvidenceRef),
            (error) => {
                assert.equal(error?.code, 'MCP_CREDENTIAL_MATERIAL_REJECTED');
                assert.equal(error?.message?.includes(secret), false);
                return true;
            },
            secret,
        );
    }

    let discoveryCloses = 0;
    const discoveryBoundary = mcp.createMcpEnforcementBoundary({
        async openSession(openRequest) {
            const discovery = cleanImported(openRequest, {
                protocol_version: mcp.MCP_V2_PROTOCOL_VERSION,
                stateless: true,
            });
            discovery.evidence_ref = `substituted:${openRequest.request_id}`;
            return {
                schema: mcp.MCP_ENFORCEMENT_SCHEMAS.hostSession,
                discovery,
                async request() {
                    throw new Error('request must not run after substituted discovery evidence');
                },
                async close() {
                    discoveryCloses += 1;
                },
            };
        },
        async executeFallback() {
            throw new Error('fallback must not run');
        },
    });
    await assert.rejects(
        mcp.connectRemoteClient({
            remoteUrl: 'https://evidence-discovery.example.invalid/api/mcp',
            enforcementBoundary: discoveryBoundary,
        }),
        (error) => error?.code === 'MCP_RISK_FORK_IMPORT_INVALID',
    );
    assert.equal(discoveryCloses, 1);

    let requestCloses = 0;
    const requestBoundary = mcp.createMcpEnforcementBoundary({
        async openSession(openRequest) {
            return {
                schema: mcp.MCP_ENFORCEMENT_SCHEMAS.hostSession,
                discovery: cleanImported(openRequest, {
                    protocol_version: mcp.MCP_V2_PROTOCOL_VERSION,
                    stateless: true,
                }),
                async request(request) {
                    const result = request.phase === 'tools/list'
                        ? { tools: [{ name: 'evidence_probe' }] }
                        : { content: [{ type: 'text', text: 'clean result' }] };
                    const envelope = cleanImported(request, result);
                    if (request.phase === 'tools/call') {
                        envelope.evidence_ref = `substituted:${request.request_id}`;
                    }
                    return envelope;
                },
                async close() {
                    requestCloses += 1;
                },
            };
        },
        async executeFallback() {
            throw new Error('fallback must not run');
        },
    });
    const session = await mcp.connectRemoteClient({
        remoteUrl: 'https://evidence-request.example.invalid/api/mcp',
        enforcementBoundary: requestBoundary,
    });
    await assert.rejects(
        session.callTool({ name: 'evidence_probe', arguments: {} }),
        (error) => error?.code === 'MCP_RISK_FORK_IMPORT_INVALID',
    );
    assert.equal(requestCloses, 1);
});

test('tool-schema exceptions do not treat default or example data as schema property maps', async () => {
    for (const fixture of [
        {
            label: 'default object',
            inputSchema: {
                type: 'object',
                default: {
                    properties: {
                        apiKey: { value: 'raw-authority-value-not-pattern' },
                    },
                },
            },
        },
        {
            label: 'example object',
            inputSchema: {
                type: 'object',
                examples: [{
                    properties: {
                        authorization: { value: 'raw-authority-value-not-pattern' },
                    },
                }],
            },
        },
    ]) {
        let closes = 0;
        const boundary = mcp.createMcpEnforcementBoundary({
            async openSession(openRequest) {
                return {
                    schema: mcp.MCP_ENFORCEMENT_SCHEMAS.hostSession,
                    discovery: cleanImported(openRequest, {
                        protocol_version: mcp.MCP_V2_PROTOCOL_VERSION,
                        stateless: true,
                    }),
                    async request(request) {
                        return cleanImported(request, {
                            tools: [{
                                name: 'schema_context_probe',
                                inputSchema: fixture.inputSchema,
                            }],
                        });
                    },
                    async close() {
                        closes += 1;
                    },
                };
            },
            async executeFallback() {
                throw new Error('fallback must not run');
            },
        });
        await assert.rejects(
            mcp.connectRemoteClient({
                remoteUrl: 'https://schema-context.example.invalid/api/mcp',
                enforcementBoundary: boundary,
            }),
            (error) => error?.code === 'MCP_CREDENTIAL_MATERIAL_REJECTED',
            fixture.label,
        );
        assert.equal(closes, 1, fixture.label);
    }

    const benignBoundary = mcp.createMcpEnforcementBoundary({
        async openSession(openRequest) {
            return {
                schema: mcp.MCP_ENFORCEMENT_SCHEMAS.hostSession,
                discovery: cleanImported(openRequest, {
                    protocol_version: mcp.MCP_V2_PROTOCOL_VERSION,
                    stateless: true,
                }),
                async request(request) {
                    return cleanImported(request, {
                        tools: [{
                            name: 'nested_schema_control',
                            inputSchema: {
                                type: 'object',
                                properties: {
                                    connection: {
                                        type: 'object',
                                        properties: {
                                            apiKey: {
                                                type: 'string',
                                                description: 'Resolved out of band by a qualified host.',
                                            },
                                        },
                                    },
                                },
                            },
                        }],
                    });
                },
                async close() {},
            };
        },
        async executeFallback() {
            throw new Error('fallback must not run');
        },
    });
    const benignSession = await mcp.connectRemoteClient({
        remoteUrl: 'https://schema-control.example.invalid/api/mcp',
        enforcementBoundary: benignBoundary,
    });
    await benignSession.close();
});

test('clean import rejects joined credential aliases, header serializations, and JSON text payloads', async () => {
    const cases = [
        ...['apikey', 'accesskey', 'clientsecret', 'signingkey'].map((key) => ({
            label: `joined credential alias ${key}`,
            result: {
                content: [{ type: 'text', text: 'unsafe' }],
                metadata: { [key]: 'raw-authority-value-not-pattern' },
            },
        })),
        {
            label: 'header name/value object',
            result: {
                content: [{ type: 'text', text: 'unsafe' }],
                headers: [{ name: 'authorization', value: 'raw-authority-value-not-pattern' }],
            },
        },
        {
            label: 'header tuple',
            result: {
                content: [{ type: 'text', text: 'unsafe' }],
                headers: [['authorization', 'raw-authority-value-not-pattern']],
            },
        },
        {
            label: 'JSON object in standard MCP content text',
            result: {
                content: [{
                    type: 'text',
                    text: JSON.stringify({ authorization: { value: 'raw-authority-value-not-pattern' } }),
                }],
            },
        },
        {
            label: 'duplicate escaped sensitive key in standard MCP content text',
            result: {
                content: [{
                    type: 'text',
                    text: '{"authorization":"raw-authority-value-not-pattern","authoriz\\u0061tion":null}',
                }],
            },
        },
        {
            label: 'top-level JSON header tuple in standard MCP content text',
            result: {
                content: [{
                    type: 'text',
                    text: '[["authorization","raw-authority-value-not-pattern"]]',
                }],
            },
        },
        {
            label: 'top-level JSON header object in standard MCP content text',
            result: {
                content: [{
                    type: 'text',
                    text: '{"name":"authorization","value":"raw-authority-value-not-pattern"}',
                }],
            },
        },
        {
            label: 'nested JSON header tuple in standard MCP content text',
            result: {
                content: [{
                    type: 'text',
                    text: '{"metadata":[["authorization","raw-authority-value-not-pattern"]]}',
                }],
            },
        },
    ];

    for (const fixture of cases) {
        let closes = 0;
        const boundary = mcp.createMcpEnforcementBoundary({
            async openSession(openRequest) {
                return {
                    schema: mcp.MCP_ENFORCEMENT_SCHEMAS.hostSession,
                    discovery: cleanImported(openRequest, {
                        protocol_version: mcp.MCP_V2_PROTOCOL_VERSION,
                        stateless: true,
                    }),
                    async request(request) {
                        if (request.phase === 'tools/list') {
                            return cleanImported(request, { tools: [{ name: 'credential_probe' }] });
                        }
                        return cleanImported(request, fixture.result);
                    },
                    async close() {
                        closes += 1;
                    },
                };
            },
            async executeFallback() {
                throw new Error('fallback must not run');
            },
        });
        const session = await mcp.connectRemoteClient({
            remoteUrl: 'https://credential-probe.example.invalid/api/mcp',
            enforcementBoundary: boundary,
        });
        await assert.rejects(
            session.callTool({ name: 'credential_probe', arguments: {} }),
            (error) => error?.code === 'MCP_CREDENTIAL_MATERIAL_REJECTED',
            fixture.label,
        );
        assert.equal(closes, 1, fixture.label);
    }
});

test('clean import accepts benign nested JSON and escaped-string content controls', async () => {
    const controls = [
        JSON.stringify({
            groups: [
                { value: 'one', nested: { ok: true } },
                { value: 'two', nested: { ok: false } },
            ],
        }),
        '{"message":"escaped quote: \\"authorization\\" is documentation","nested":{"list":[1,{"ok":true}]}}',
        '{"\\u006dessage":"escaped object key is benign"}',
        '[["display_name","ordinary-value"]]',
        '{"name":"display_name","value":"ordinary-value"}',
    ];
    let nextControl = 0;
    const boundary = mcp.createMcpEnforcementBoundary({
        async openSession(openRequest) {
            return {
                schema: mcp.MCP_ENFORCEMENT_SCHEMAS.hostSession,
                discovery: cleanImported(openRequest, {
                    protocol_version: mcp.MCP_V2_PROTOCOL_VERSION,
                    stateless: true,
                }),
                async request(request) {
                    if (request.phase === 'tools/list') {
                        return cleanImported(request, { tools: [{ name: 'json_control' }] });
                    }
                    const text = controls[nextControl];
                    nextControl += 1;
                    return cleanImported(request, { content: [{ type: 'text', text }] });
                },
                async close() {},
            };
        },
        async executeFallback() {
            throw new Error('fallback must not run');
        },
    });
    const session = await mcp.connectRemoteClient({
        remoteUrl: 'https://json-controls.example.invalid/api/mcp',
        enforcementBoundary: boundary,
    });
    try {
        for (const text of controls) {
            const result = await session.callTool({ name: 'json_control', arguments: {} });
            assert.equal(result.content[0].text, text);
        }
    } finally {
        await session.close();
    }
});

test('clean import rejects accessor, Proxy, depth, and size boundary attacks', async () => {
    const accessorResult = {};
    Object.defineProperty(accessorResult, 'tools', {
        enumerable: true,
        get() {
            throw new Error('accessor must not execute');
        },
    });

    const deepResult = { tools: [] };
    let deepCursor = deepResult;
    for (let depth = 0; depth < 52; depth += 1) {
        deepCursor.child = {};
        deepCursor = deepCursor.child;
    }

    const cases = [
        { label: 'accessor', result: accessorResult, error: /accessor-backed/ },
        {
            label: 'Proxy',
            result: new Proxy({ tools: [] }, {}),
            error: /Proxy/,
        },
        { label: 'depth', result: deepResult, error: /depth limit/ },
        {
            label: 'size',
            result: { tools: [], padding: 'x'.repeat((4 * 1024 * 1024) + 1) },
            error: /byte limit/,
        },
    ];

    for (const fixture of cases) {
        let closes = 0;
        const boundary = mcp.createMcpEnforcementBoundary({
            async openSession(openRequest) {
                return {
                    schema: mcp.MCP_ENFORCEMENT_SCHEMAS.hostSession,
                    discovery: cleanImported(openRequest, {
                        protocol_version: mcp.MCP_V2_PROTOCOL_VERSION,
                        stateless: true,
                    }),
                    async request(request) {
                        return cleanImportedWithUncheckedResult(request, fixture.result);
                    },
                    async close() {
                        closes += 1;
                    },
                };
            },
            async executeFallback() {
                throw new Error('fallback must not run');
            },
        });
        await assert.rejects(
            mcp.connectRemoteClient({
                remoteUrl: 'https://structural-probe.example.invalid/api/mcp',
                enforcementBoundary: boundary,
            }),
            fixture.error,
            fixture.label,
        );
        assert.equal(closes, 1, fixture.label);
    }
});

test('fallback register/search/preview/match/execute/status all block with zero I/O without enforcement', async () => {
    const originalFetch = global.fetch;
    let fetchCalls = 0;
    global.fetch = async () => {
        fetchCalls += 1;
        throw new Error('unprotected fallback network must never run');
    };
    try {
        const cases = [
            ['agoragentic_register', { name: 'blocked-agent' }],
            ['agoragentic_search', { query: 'blocked search' }],
            ['agoragentic_preview_x402', { task: 'blocked preview' }],
            ['agoragentic_match', { task: 'blocked match' }],
            ['agoragentic_execute', { task: 'blocked execute', input: {}, constraints: {} }],
            ['agoragentic_execute_status', { invocation_id: 'inv_blocked' }],
        ];
        for (const [name, args] of cases) {
            const result = await mcp.executeFallbackTool(name, args);
            assert.equal(result.isError, true, name);
            assert.equal(
                JSON.parse(result.content[0].text).error,
                'risk_fork_enforcement_required',
                name,
            );
        }
        assert.equal(fetchCalls, 0);
    } finally {
        global.fetch = originalFetch;
    }
});

test('clean import permits documented placeholders and internal opaque identifiers', async () => {
    const boundary = mcp.createMcpEnforcementBoundary({
        async openSession(openRequest) {
            return {
                schema: mcp.MCP_ENFORCEMENT_SCHEMAS.hostSession,
                discovery: cleanImported(openRequest, {
                    protocol_version: mcp.MCP_V2_PROTOCOL_VERSION,
                    stateless: true,
                }),
                async request(request) {
                    return cleanImported(request, {
                        tools: [{
                            name: 'placeholder_probe',
                            description: [
                                ...DOCUMENTED_AMK_PLACEHOLDERS,
                                ...OPAQUE_IDENTIFIER_CONTROLS,
                            ].join(' and '),
                            metadata: {
                                examples: [
                                    ...DOCUMENTED_AMK_PLACEHOLDERS,
                                    ...OPAQUE_IDENTIFIER_CONTROLS,
                                ],
                                ...Object.fromEntries(
                                    OPAQUE_IDENTIFIER_CONTROLS.map((value) => [value, 'opaque']),
                                ),
                            },
                        }],
                    });
                },
                async close() {},
            };
        },
        async executeFallback() {
            throw new Error('fallback must not run');
        },
    });
    const session = await mcp.connectRemoteClient({
        remoteUrl: 'https://placeholder-control.example.invalid/api/mcp',
        enforcementBoundary: boundary,
    });
    try {
        const directory = mcp.createRemoteToolDirectory(session);
        assert.equal(await directory.has('placeholder_probe'), true);
    } finally {
        await session.close();
    }
});

test('fallback execution status rejects noncanonical invocation IDs before host I/O and preserves valid IDs', async () => {
    const statusTool = mcp.buildFallbackToolList().find(
        (tool) => tool.name === 'agoragentic_execute_status',
    );
    assert.deepEqual(statusTool.inputSchema.properties.invocation_id, {
        type: 'string',
        minLength: 1,
        maxLength: 256,
        pattern: '^[A-Za-z0-9_-]{1,256}$',
        description: 'The invocation_id string returned by a prior agoragentic_execute call, e.g. "inv_abc123def456"',
    });
    assert.deepEqual(statusTool.inputSchema.required, ['invocation_id']);

    const invalidIds = [
        '',
        'inv_a/b',
        ' inv_abc',
        'inv_abc ',
        'inv_abc\tdef',
        'inv_abc\ndef',
        'inv_\u00e9',
        'inv_e\u0301',
        'inv_\uff41',
        1234,
        true,
        null,
        { value: 'inv_object' },
        'x'.repeat(257),
    ];
    let fallbackCalls = 0;
    const boundary = mcp.createMcpEnforcementBoundary({
        async openSession() {
            throw new Error('remote session must not run');
        },
        async executeFallback(request) {
            fallbackCalls += 1;
            return cleanImported(request, { ok: true, path: request.fallback_http.path });
        },
    });

    const missing = await mcp.executeFallbackTool(
        'agoragentic_execute_status',
        {},
        { enforcementBoundary: boundary },
    );
    assert.deepEqual(JSON.parse(missing.content[0].text), {
        ok: false,
        error: 'invalid_invocation_id',
    });
    assert.equal(fallbackCalls, 0);

    for (const invocationId of invalidIds) {
        const result = await mcp.executeFallbackTool(
            'agoragentic_execute_status',
            { invocation_id: invocationId },
            { enforcementBoundary: boundary },
        );
        assert.deepEqual(JSON.parse(result.content[0].text), {
            ok: false,
            error: 'invalid_invocation_id',
        }, String(invocationId));
        assert.equal(fallbackCalls, 0, String(invocationId));
    }

    const validIds = [
        'inv_AbC-123_xyz',
        '_legacy-leading-underscore',
        '-legacy-leading-hyphen',
        'A',
        'Z'.repeat(256),
    ];
    for (const validId of validIds) {
        const accepted = await mcp.executeFallbackTool(
            'agoragentic_execute_status',
            { invocation_id: validId },
            { enforcementBoundary: boundary },
        );
        assert.deepEqual(JSON.parse(accepted.content[0].text), {
            ok: true,
            path: `/api/execute/status/${validId}`,
        });
    }
    assert.equal(fallbackCalls, validIds.length);
});

test('ACP parsing is bounded, duplicate-safe, and remains usable after invalid input', async () => {
    const acp = spawnAcpClient('http://127.0.0.1:9/api/mcp');
    try {
        const malformed = await acp.requestRaw('{');
        assert.equal(malformed.error.code, -32700);

        const nonObject = await acp.requestRaw('null');
        assert.equal(nonObject.error.code, -32600);

        const duplicate = await acp.requestRaw(
            '{"jsonrpc":"2.0","id":41,"method":"initialize","method":"tools/list","params":{}}',
        );
        assert.equal(duplicate.error.code, -32600);

        const deepParams = {};
        let deepCursor = deepParams;
        for (let depth = 0; depth < 52; depth += 1) {
            deepCursor.child = {};
            deepCursor = deepCursor.child;
        }
        const excessiveDepth = await acp.requestRaw(JSON.stringify({
            jsonrpc: '2.0',
            id: 42,
            method: 'initialize',
            params: deepParams,
        }));
        assert.equal(excessiveDepth.error.code, -32600);

        const oversized = await acp.requestRaw(JSON.stringify({
            jsonrpc: '2.0',
            id: 43,
            method: 'initialize',
            padding: 'x'.repeat((4 * 1024 * 1024) + 1),
        }));
        assert.equal(oversized.error.code, -32600);

        const initialized = await acp.request('initialize', {
            protocolVersion: 1,
            clientInfo: { name: 'bounded-parser-control', version: '1.0.0' },
        });
        assert.equal(initialized.error, undefined);
        assert.equal(initialized.result.protocolVersion, 1);

        const oversizedCwd = await acp.request('session/new', {
            cwd: 'x'.repeat(4097),
        });
        assert.equal(oversizedCwd.error.code, -32602);

        const session = await acp.request('session/new', {
            cwd: 'C:\\synthetic-acp-session',
        });
        assert.equal(session.error, undefined);
        assert.equal(typeof session.result.sessionId, 'string');
        assert.ok(session.result.sessionId.length > 0);
    } finally {
        await acp.close();
    }
});

test('ACP rejects unadvertised tools and advertised calls before remote discovery without enforcement', async () => {
    let remoteRequests = 0;
    const server = http.createServer((_req, res) => {
        remoteRequests += 1;
        res.statusCode = 500;
        res.end('remote I/O is forbidden');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const remoteUrl = `http://127.0.0.1:${server.address().port}/api/mcp`;
    const acp = spawnAcpClient(remoteUrl);
    try {
        const unknown = await acp.request('tools/call', {
            name: 'not_advertised',
            arguments: {},
        });
        assert.equal(unknown.error.code, -32602);
        assert.match(unknown.error.message, /not advertised/i);

        const advertised = await acp.request('tools/call', {
            name: 'agoragentic_execute',
            arguments: { task: 'must remain blocked' },
        });
        assert.equal(advertised.error.code, -32000);
        assert.match(advertised.error.message, /enforcement host capability is required/i);
        assert.equal(remoteRequests, 0);

        const shutdown = await acp.request('shutdown');
        assert.equal(shutdown.error, undefined);
        assert.equal(shutdown.result.ok, true);

        const afterShutdown = await acp.request('tools/call', {
            name: 'agoragentic_execute',
            arguments: { task: 'must remain terminally blocked' },
        });
        assert.equal(afterShutdown.error.code, -32000);
        assert.match(afterShutdown.error.message, /adapter is shut down/i);
        assert.equal(afterShutdown.error.data.enforcement_code, 'MCP_ACP_ADAPTER_SHUT_DOWN');
        assert.equal(remoteRequests, 0);
    } finally {
        await acp.close();
        await new Promise((resolve) => server.close(resolve));
    }
});

test('redirect and malformed discovery fixtures fail before target content can be accepted', async () => {
    let redirectTargetRequests = 0;
    const redirectTarget = http.createServer((_req, res) => {
        redirectTargetRequests += 1;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ instructions: 'untrusted redirect target content' }));
    });
    await new Promise((resolve) => redirectTarget.listen(0, '127.0.0.1', resolve));
    const redirectTargetUrl = `http://127.0.0.1:${redirectTarget.address().port}/api/mcp`;
    let redirectSourceRequests = 0;
    const redirectSource = http.createServer((_req, res) => {
        redirectSourceRequests += 1;
        res.statusCode = 307;
        res.setHeader('Location', redirectTargetUrl);
        res.end();
    });
    await new Promise((resolve) => redirectSource.listen(0, '127.0.0.1', resolve));

    let malformedRequests = 0;
    const malformed = http.createServer((_req, res) => {
        malformedRequests += 1;
        res.setHeader('Content-Type', 'application/json');
        res.end('{"jsonrpc":"2.0","id":1,"result":');
    });
    await new Promise((resolve) => malformed.listen(0, '127.0.0.1', resolve));

    const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');
    function strictLoopbackBoundary() {
        return mcp.createMcpEnforcementBoundary({
            async openSession(openRequest) {
                assert.equal(openRequest.transport_constraints.redirects, 'error');
                const transport = new StreamableHTTPClientTransport(new URL(openRequest.mcp_server_ref), {
                    requestInit: { redirect: openRequest.transport_constraints.redirects },
                });
                const client = new Client(
                    { name: 'strict-boundary-test', version: '1.0.0' },
                    { versionNegotiation: { mode: { pin: mcp.MCP_V2_PROTOCOL_VERSION } } },
                );
                try {
                    await client.connect(transport);
                } catch (error) {
                    try {
                        await client.close();
                    } catch {
                        // Preserve the protocol failure.
                    }
                    throw error;
                }
                throw new Error('malicious discovery unexpectedly succeeded');
            },
            async executeFallback() {
                throw new Error('protocol failures must not trigger automatic fallback I/O');
            },
        });
    }

    try {
        await assert.rejects(mcp.connectRemoteClient({
            remoteUrl: `http://127.0.0.1:${redirectSource.address().port}/api/mcp`,
            enforcementBoundary: strictLoopbackBoundary(),
        }));
        assert.equal(redirectSourceRequests, 1);
        assert.equal(redirectTargetRequests, 0);

        await assert.rejects(mcp.connectRemoteClient({
            remoteUrl: `http://127.0.0.1:${malformed.address().port}/api/mcp`,
            enforcementBoundary: strictLoopbackBoundary(),
        }));
        assert.equal(malformedRequests, 1);
        assert.equal(redirectTargetRequests, 0);
    } finally {
        await new Promise((resolve) => redirectSource.close(resolve));
        await new Promise((resolve) => redirectTarget.close(resolve));
        await new Promise((resolve) => malformed.close(resolve));
    }
});
