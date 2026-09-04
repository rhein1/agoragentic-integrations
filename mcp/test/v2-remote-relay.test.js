'use strict';

/**
 * Loopback-only proof for the relay's remote MCP 2026-07-28 leg.
 *
 * The fixture never contacts Agoragentic, registers a real agent, invokes a
 * provider, signs a payment, or uses a wallet. It only records the protocol
 * headers emitted by the official v2 SDK and exercises the local legacy stdio
 * projection that current desktop hosts still use.
 */

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { test } = require('node:test');
const {
    McpServer,
    createMcpHandler,
    fromJsonSchema,
} = require('@modelcontextprotocol/server');
const { toNodeHandler } = require('@modelcontextprotocol/node');
const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');

const {
    MCP_ENFORCEMENT_SCHEMAS,
    MCP_V2_PROTOCOL_VERSION,
    closeRemoteSession,
    computeMcpCleanImportEvidenceHash,
    connectRemoteClient,
    createMcpEnforcementBoundary,
    createRemoteToolDirectory,
} = require('../mcp-server.js');

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const RELAY_ENTRYPOINT = path.join(PACKAGE_ROOT, 'mcp-server.js');
const ENFORCED_RELAY_ENTRYPOINT = path.join(__dirname, 'fixtures', 'enforced-relay-entry.js');
const FIXTURE_API_KEY = 'amk_loopback_fixture_key';
const REGISTERED_FIXTURE_API_KEY = 'amk_loopback_registered_key';

function createFixtureServer({ onRequest, onResponse } = {}) {
    const requests = [];
    const handler = createMcpHandler(async () => {
        const server = new McpServer({ name: 'agoragentic-mcp-loopback', version: '1.0.0' });

        server.registerTool('relay_safe_probe', {
            description: 'Loopback-only read tool.',
            inputSchema: fromJsonSchema({
                type: 'object',
                properties: {
                    value: { type: 'string' },
                },
                required: ['value'],
                additionalProperties: false,
            }),
        }, async (args) => ({
            content: [{ type: 'text', text: JSON.stringify({ ok: true, value: args.value }) }],
        }));

        server.registerTool('agoragentic_register', {
            description: 'Loopback-only registration-key fixture.',
            inputSchema: fromJsonSchema({ type: 'object', additionalProperties: false }),
        }, async () => ({
            content: [{ type: 'text', text: JSON.stringify({ api_key: REGISTERED_FIXTURE_API_KEY }) }],
        }));

        server.registerTool('relay_payment_probe', {
            description: 'Loopback-only payment-required fixture.',
            inputSchema: fromJsonSchema({ type: 'object', additionalProperties: false }),
        }, async () => ({
            isError: true,
            content: [{
                type: 'text',
                text: JSON.stringify({
                    error: 'payment_required',
                    legacy_jsonrpc_error_code: -32042,
                    payment: { protocol: 'x402', challenges: [{ scheme: 'exact', network: 'base' }] },
                }),
            }],
        }));

        server.registerResource('relay-fixture-resource', 'agoragentic://fixture/resource', {
            title: 'Relay fixture resource',
            mimeType: 'text/plain',
        }, async () => ({
            contents: [{
                uri: 'agoragentic://fixture/resource',
                mimeType: 'text/plain',
                text: 'loopback resource',
            }],
        }));

        server.registerPrompt('relay-fixture-prompt', {
            description: 'Loopback-only prompt fixture.',
        }, async () => ({
            messages: [{ role: 'user', content: { type: 'text', text: 'loopback prompt' } }],
        }));

        return server;
    }, {
        legacy: 'reject',
        responseMode: 'json',
    });
    const nodeHandler = toNodeHandler(handler);
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            const body = JSON.parse(raw);
            const request = { httpMethod: req.method, headers: { ...req.headers }, body };
            requests.push(request);
            onRequest?.(request);
            res.once('finish', () => onResponse?.(request));
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
        schema: MCP_ENFORCEMENT_SCHEMAS.cleanImportedResult,
        request_id: request.request_id,
        request_hash: request.request_hash,
        phase: request.phase,
        clean_imported: true,
        authority_granted: false,
        evidence_ref: evidenceRef,
        evidence_hash: computeMcpCleanImportEvidenceHash(
            request.request_hash,
            result,
            evidenceRef,
        ),
        result,
    };
}

function createLoopbackBoundary({ apiKey = '', beforeOpen, onPhase, importResult } = {}) {
    return createMcpEnforcementBoundary({
        async openSession(openRequest) {
            onPhase?.(openRequest);
            await beforeOpen?.(openRequest);
            const transport = new StreamableHTTPClientTransport(new URL(openRequest.mcp_server_ref), {
                authProvider: { token: async () => apiKey || undefined },
                onInsufficientScope: 'throw',
                requestInit: {
                    redirect: 'error',
                    headers: { 'User-Agent': 'agoragentic-mcp-enforced-loopback-test' },
                },
            });
            const client = new Client(
                { name: 'agoragentic-mcp-enforced-loopback-test', version: '1.0.0' },
                { versionNegotiation: { mode: { pin: MCP_V2_PROTOCOL_VERSION } } },
            );
            try {
                await client.connect(transport);
                if (client.getProtocolEra() !== 'modern'
                    || client.getNegotiatedProtocolVersion() !== MCP_V2_PROTOCOL_VERSION
                    || transport.sessionId !== undefined) {
                    throw new Error('loopback host did not establish the pinned stateless protocol');
                }
            } catch (error) {
                try {
                    await client.close();
                } catch {
                    // Preserve the connection failure.
                }
                throw error;
            }

            return {
                schema: MCP_ENFORCEMENT_SCHEMAS.hostSession,
                discovery: cleanImported(openRequest, {
                    protocol_version: MCP_V2_PROTOCOL_VERSION,
                    stateless: true,
                }),
                async request(request) {
                    onPhase?.(request);
                    let raw;
                    if (request.phase === 'tools/list') raw = await client.listTools(request.params);
                    else if (request.phase === 'tools/call') raw = await client.callTool(request.params);
                    else if (request.phase === 'resources/list') raw = await client.listResources(request.params);
                    else if (request.phase === 'resources/read') raw = await client.readResource(request.params);
                    else if (request.phase === 'prompts/list') raw = await client.listPrompts(request.params);
                    else if (request.phase === 'prompts/get') raw = await client.getPrompt(request.params);
                    else throw new Error(`unsupported loopback phase ${request.phase}`);
                    const imported = importResult ? await importResult(request, raw) : raw;
                    return cleanImported(request, imported);
                },
                async close() {
                    await client.close();
                },
            };
        },
        async executeFallback(request) {
            throw new Error(`unexpected fallback request ${request.tool_name}`);
        },
    });
}

function assertModernRequest(request, expectedMethod, expectedName) {
    assert.equal(request.httpMethod, 'POST');
    assert.equal(request.body.method, expectedMethod);
    assert.equal(request.headers['mcp-protocol-version'], MCP_V2_PROTOCOL_VERSION);
    assert.equal(request.headers['mcp-method'], expectedMethod);
    assert.equal(request.headers['mcp-name'], expectedName);
    assert.equal(request.headers['mcp-session-id'], undefined);
    assert.equal(request.body.params._meta['io.modelcontextprotocol/protocolVersion'], MCP_V2_PROTOCOL_VERSION);
}

function spawnLegacyStdioClient(
    remoteUrl,
    apiKey,
    fallbackBaseUrl = 'http://127.0.0.1:9',
    entrypoint = RELAY_ENTRYPOINT,
) {
    const env = {
        ...process.env,
        AGORAGENTIC_MCP_URL: remoteUrl,
        AGORAGENTIC_API_KEY: apiKey,
    };
    if (fallbackBaseUrl === null) {
        delete env.AGORAGENTIC_BASE_URL;
    } else {
        env.AGORAGENTIC_BASE_URL = fallbackBaseUrl;
    }
    const child = spawn(process.execPath, [entrypoint], {
        cwd: PACKAGE_ROOT,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    const pending = new Map();
    const stderr = [];
    let nextId = 1;
    const output = readline.createInterface({ input: child.stdout });

    output.on('line', (line) => {
        let message;
        try {
            message = JSON.parse(line);
        } catch {
            return;
        }
        const pendingRequest = pending.get(message.id);
        if (!pendingRequest) return;
        pending.delete(message.id);
        pendingRequest.resolve(message);
    });
    child.stderr.on('data', (chunk) => stderr.push(chunk.toString()));

    function request(method, params = {}) {
        const id = nextId++;
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                pending.delete(id);
                reject(new Error(`stdio relay timed out waiting for ${method}\n${stderr.join('')}`));
            }, 15000);
            pending.set(id, {
                resolve: (message) => {
                    clearTimeout(timeout);
                    resolve(message);
                },
            });
            child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
        });
    }

    return {
        child,
        request,
        getStderr() {
            return stderr.join('');
        },
        async initialize() {
            const initialized = await request('initialize', {
                protocolVersion: '2025-06-18',
                capabilities: {},
                clientInfo: { name: 'legacy-stdio-fixture', version: '1.0.0' },
            });
            child.stdin.write(`${JSON.stringify({
                jsonrpc: '2.0',
                method: 'notifications/initialized',
                params: {},
            })}\n`);
            return initialized;
        },
        async close() {
            output.close();
            if (!child.killed) child.kill();
            await new Promise((resolve) => child.once('exit', resolve));
        },
    };
}

function createUnavailableMcpWithFallbackFixture() {
    const requests = [];
    const server = http.createServer((req, res) => {
        requests.push({ url: req.url, headers: { ...req.headers } });
        if (req.url === '/api/mcp') {
            res.statusCode = 404;
            res.end('modern MCP unavailable');
            return;
        }
        if (req.url?.startsWith('/api/capabilities')) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ capabilities: [] }));
            return;
        }
        res.statusCode = 404;
        res.end('not found');
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

test('test-only host pins stateless 2026-07-28 and attaches bearer auth out of band per request', async () => {
    const fixture = createFixtureServer();
    const url = await fixture.listen();
    const remoteSession = await connectRemoteClient({
        remoteUrl: url,
        enforcementBoundary: createLoopbackBoundary({ apiKey: FIXTURE_API_KEY }),
    });

    try {
        assert.equal(remoteSession.protocol_version, MCP_V2_PROTOCOL_VERSION);
        assert.equal(remoteSession.stateless, true);
        assert.equal(Object.hasOwn(remoteSession, 'client'), false);
        assert.equal(Object.hasOwn(remoteSession, 'transport'), false);
        await remoteSession.listTools();
        await remoteSession.callTool({
            name: 'relay_safe_probe',
            arguments: { value: 'safe' },
        });

        const discover = fixture.requests.find((request) => request.body.method === 'server/discover');
        const listed = fixture.requests.find((request) => request.body.method === 'tools/list');
        const called = fixture.requests.find((request) => request.body.method === 'tools/call');
        assert.ok(discover);
        assert.ok(listed);
        assert.ok(called);
        assertModernRequest(discover, 'server/discover', undefined);
        assertModernRequest(listed, 'tools/list', undefined);
        assertModernRequest(called, 'tools/call', 'relay_safe_probe');
        for (const request of [discover, listed, called]) {
            assert.equal(request.headers.authorization, `Bearer ${FIXTURE_API_KEY}`);
        }
    } finally {
        await closeRemoteSession(remoteSession);
        await fixture.close();
    }
});

test('the factory-created host capability owns server/discover before remote I/O or response acceptance', async () => {
    const events = [];
    const fixture = createFixtureServer({
        onRequest(request) {
            if (request.body.method === 'server/discover') events.push('server:discover-received');
        },
        onResponse(request) {
            if (request.body.method === 'server/discover') events.push('server:discover-response-finished');
        },
    });
    const url = await fixture.listen();
    let releasePlanner;
    let markPlannerStarted;
    let remoteSession;
    const plannerGate = new Promise((resolve) => {
        releasePlanner = resolve;
    });
    const plannerStarted = new Promise((resolve) => {
        markPlannerStarted = resolve;
    });
    let enforcementInput;

    const boundary = createLoopbackBoundary({
        beforeOpen: async (input) => {
            enforcementInput = input;
            events.push('enforcer:started');
            markPlannerStarted();
            await plannerGate;
            events.push('enforcer:completed');
        },
    });

    const connection = connectRemoteClient({
        remoteUrl: url,
        enforcementBoundary: boundary,
    });

    try {
        await plannerStarted;
        await new Promise((resolve) => setTimeout(resolve, 25));
        assert.deepEqual(events, ['enforcer:started']);
        assert.equal(enforcementInput.phase, 'server/discover');
        assert.equal(enforcementInput.mcp_server_ref, new URL(url).href);
        assert.equal(enforcementInput.mcp_server_origin, new URL(url).origin);
        assert.equal(enforcementInput.transport_constraints.direct_network_permitted, false);
        assert.equal(enforcementInput.transport_constraints.redirects, 'error');
        assert.equal(enforcementInput.transport_constraints.response_acceptance, 'clean_import_only');

        releasePlanner();
        remoteSession = await connection;
        events.push(`client:accepted-${remoteSession.protocol_version}`);

        assert.deepEqual(events, [
            'enforcer:started',
            'enforcer:completed',
            'server:discover-received',
            'server:discover-response-finished',
            `client:accepted-${MCP_V2_PROTOCOL_VERSION}`,
        ]);
    } finally {
        releasePlanner();
        await closeRemoteSession(remoteSession);
        await fixture.close();
    }
});

test('does not retain a registration-returned key for later stateless requests', async () => {
    const fixture = createFixtureServer();
    const url = await fixture.listen();
    const remoteSession = await connectRemoteClient({
        remoteUrl: url,
        enforcementBoundary: createLoopbackBoundary({
            importResult(request, raw) {
                if (request.phase === 'tools/call'
                    && request.params.name === 'agoragentic_register') {
                    return {
                        ...raw,
                        content: [{
                            type: 'text',
                            text: JSON.stringify({ api_key_ref: 'stored-out-of-band-by-test-host' }),
                        }],
                    };
                }
                return raw;
            },
        }),
    });

    try {
        const registration = await remoteSession.callTool({
            name: 'agoragentic_register',
            arguments: {},
        });
        assert.equal(registration.isError, undefined);
        await remoteSession.listTools();

        const registerRequest = fixture.requests.find((request) => (
            request.body.method === 'tools/call'
            && request.body.params.name === 'agoragentic_register'
        ));
        const postRegistrationList = fixture.requests.filter((request) => request.body.method === 'tools/list').at(-1);
        assert.ok(registerRequest);
        assert.equal(registerRequest.headers.authorization, undefined);
        assert.ok(postRegistrationList);
        assert.equal(postRegistrationList.headers.authorization, undefined);
    } finally {
        await closeRemoteSession(remoteSession);
        await fixture.close();
    }
});

test('resolves the complete paginated remote tool directory before fallback decisions', async () => {
    const calls = [];
    const boundary = createMcpEnforcementBoundary({
        async openSession(openRequest) {
            return {
                schema: MCP_ENFORCEMENT_SCHEMAS.hostSession,
                discovery: cleanImported(openRequest, {
                    protocol_version: MCP_V2_PROTOCOL_VERSION,
                    stateless: true,
                }),
                async request(request) {
                    assert.equal(request.phase, 'tools/list');
                    calls.push(request.params);
                    const result = request.params.cursor === 'page-2'
                        ? {
                            tools: [
                                { name: 'remote_page_two' },
                                { name: 'agoragentic_register' },
                            ],
                        }
                        : {
                            tools: [{ name: 'remote_page_one' }],
                            nextCursor: 'page-2',
                        };
                    return cleanImported(request, result);
                },
                async close() {},
            };
        },
        async executeFallback() {
            throw new Error('fallback must not run');
        },
    });
    const session = await connectRemoteClient({
        remoteUrl: 'https://pagination.example.invalid/api/mcp',
        enforcementBoundary: boundary,
    });
    const directory = createRemoteToolDirectory(session);

    try {
        assert.deepEqual(calls, [{}], 'connect preflight must be the first gated tools/list');
        assert.equal(await directory.has('agoragentic_register'), true);
        assert.deepEqual(calls, [{}, { cursor: 'page-2' }]);

        const page = await directory.list({ cursor: 'page-2' });
        assert.deepEqual(
            page.tools.map((tool) => tool.name),
            ['remote_page_two', 'agoragentic_register'],
        );
        assert.equal(await directory.has('agoragentic_register'), true);
        assert.equal(calls.length, 3);

        const aggregate = await directory.list();
        assert.deepEqual(calls.slice(-2), [{}, { cursor: 'page-2' }]);
        assert.equal(Object.hasOwn(aggregate, 'nextCursor'), false);
        assert.ok(aggregate.tools.some((tool) => tool.name === 'remote_page_two'));
        assert.ok(aggregate.tools.some((tool) => tool.name === 'agoragentic_search'));
        assert.equal(aggregate.tools.filter((tool) => tool.name === 'agoragentic_register').length, 1);
    } finally {
        await closeRemoteSession(session);
    }
});

test('keeps an in-flight pagination epoch isolated and rejects a drifting refresh', async () => {
    function deferred() {
        let resolve;
        const promise = new Promise((settle) => {
            resolve = settle;
        });
        return { promise, resolve };
    }

    const oldPageTwo = deferred();
    const oldPageTwoRequested = deferred();
    const newPageTwo = deferred();
    const newPageTwoRequested = deferred();
    const calls = [];
    let rootPageCalls = 0;
    let fallbackSelections = 0;
    const boundary = createMcpEnforcementBoundary({
        async openSession(openRequest) {
            return {
                schema: MCP_ENFORCEMENT_SCHEMAS.hostSession,
                discovery: cleanImported(openRequest, {
                    protocol_version: MCP_V2_PROTOCOL_VERSION,
                    stateless: true,
                }),
                async request(request) {
                    assert.equal(request.phase, 'tools/list');
                    calls.push(request.params);
                    let result;
                    if (request.params.cursor === 'old-page-2') {
                        oldPageTwoRequested.resolve();
                        result = await oldPageTwo.promise;
                    } else if (request.params.cursor === 'new-page-2') {
                        newPageTwoRequested.resolve();
                        result = await newPageTwo.promise;
                    } else {
                        rootPageCalls += 1;
                        result = rootPageCalls === 1
                            ? {
                                tools: [{ name: 'agoragentic_register' }],
                                nextCursor: 'old-page-2',
                            }
                            : {
                                tools: [{ name: 'new-page-one' }],
                                nextCursor: 'new-page-2',
                            };
                    }
                    return cleanImported(request, result);
                },
                async close() {},
            };
        },
        async executeFallback() {
            throw new Error('the directory decision must not select fallback');
        },
    });
    const session = await connectRemoteClient({
        remoteUrl: 'https://pagination-race.example.invalid/api/mcp',
        enforcementBoundary: boundary,
    });
    const directory = createRemoteToolDirectory(session);
    let routingDecision;
    let refreshedList;

    try {
        routingDecision = (async () => {
            const existsRemotely = await directory.has('agoragentic_register');
            if (!existsRemotely) fallbackSelections += 1;
            return existsRemotely;
        })();
        await oldPageTwoRequested.promise;

        refreshedList = directory.list();
        await newPageTwoRequested.promise;

        oldPageTwo.resolve({ tools: [{ name: 'old-page-two' }] });
        const oldEpochDecision = await routingDecision;
        newPageTwo.resolve({ tools: [{ name: 'new-page-two' }] });
        const refreshError = await refreshedList.then(() => null, (error) => error);

        assert.equal(oldEpochDecision, true);
        assert.equal(fallbackSelections, 0);
        assert.equal(refreshError?.code, 'MCP_REMOTE_TOOL_DESCRIPTOR_DRIFT');
        await assert.rejects(
            directory.has('agoragentic_register'),
            (error) => [
                'MCP_REMOTE_TOOL_DESCRIPTOR_DRIFT',
                'MCP_ENFORCED_SESSION_CLOSED',
            ].includes(error?.code),
        );
        assert.deepEqual(calls, [
            {},
            { cursor: 'old-page-2' },
            {},
            { cursor: 'new-page-2' },
        ]);
    } finally {
        oldPageTwo.resolve({ tools: [] });
        newPageTwo.resolve({ tools: [] });
        await Promise.allSettled([routingDecision, refreshedList].filter(Boolean));
        await closeRemoteSession(session);
    }
});

test('rejects credential assignments in imported text without blocking prose, short values, or references', async () => {
    const cases = [
        { text: 'api_key="syntheticvalue123456"', rejected: true },
        { text: 'API_KEY = syntheticvalue123456', rejected: true },
        { text: '{"api_key" = "syntheticvalue123456"}', rejected: true },
        { text: '{"Api-Key": "syntheticvalue123456"', rejected: true },
        { text: "'authorization' : 'syntheticvalue123456'", rejected: true },
        { text: 'The api_key is resolved out of band by the host.', rejected: false },
        { text: 'api_key="demo"', rejected: false },
        { text: 'api_key_ref="host-store/reference-123"', rejected: false },
    ];

    for (const fixture of cases) {
        let closes = 0;
        const boundary = createMcpEnforcementBoundary({
            async openSession(openRequest) {
                return {
                    schema: MCP_ENFORCEMENT_SCHEMAS.hostSession,
                    discovery: cleanImported(openRequest, {
                        protocol_version: MCP_V2_PROTOCOL_VERSION,
                        stateless: true,
                    }),
                    async request(request) {
                        const result = request.phase === 'tools/list'
                            ? { tools: [{ name: 'assignment_text_probe' }] }
                            : { content: [{ type: 'text', text: fixture.text }] };
                        return cleanImported(request, result);
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
        const session = await connectRemoteClient({
            remoteUrl: 'https://assignment-text.example.invalid/api/mcp',
            enforcementBoundary: boundary,
        });
        try {
            const call = session.callTool({ name: 'assignment_text_probe', arguments: {} });
            if (fixture.rejected) {
                await assert.rejects(
                    call,
                    (error) => error?.code === 'MCP_CREDENTIAL_MATERIAL_REJECTED',
                    fixture.text,
                );
            } else {
                const result = await call;
                assert.equal(result.content[0].text, fixture.text);
            }
        } finally {
            await closeRemoteSession(session);
        }
        assert.equal(closes, 1, fixture.text);
    }
});

test('refuses fallback decisions when remote tool pagination cannot be completed', async () => {
    let fallbackCalls = 0;
    const boundary = createMcpEnforcementBoundary({
        async openSession(openRequest) {
            return {
                schema: MCP_ENFORCEMENT_SCHEMAS.hostSession,
                discovery: cleanImported(openRequest, {
                    protocol_version: MCP_V2_PROTOCOL_VERSION,
                    stateless: true,
                }),
                async request(request) {
                    assert.equal(request.phase, 'tools/list');
                    return cleanImported(request, {
                        tools: [{ name: 'remote_page_one' }],
                        nextCursor: 'repeated-cursor',
                    });
                },
                async close() {},
            };
        },
        async executeFallback() {
            fallbackCalls += 1;
            throw new Error('fallback must not run while the remote directory is incomplete');
        },
    });
    const session = await connectRemoteClient({
        remoteUrl: 'https://pagination-cycle.example.invalid/api/mcp',
        enforcementBoundary: boundary,
    });
    const directory = createRemoteToolDirectory(session);

    try {
        await assert.rejects(
            directory.has('agoragentic_register'),
            (error) => error?.code === 'MCP_REMOTE_TOOL_DIRECTORY_INCOMPLETE',
        );
        assert.equal(fallbackCalls, 0);
    } finally {
        await closeRemoteSession(session);
    }
});

test('the default CLI exposes owned fallback metadata but performs no remote or fallback I/O', async () => {
    const fixture = createUnavailableMcpWithFallbackFixture();
    const origin = await fixture.listen();
    const relay = spawnLegacyStdioClient(`${origin}/api/mcp`, FIXTURE_API_KEY, null);

    try {
        const initialized = await relay.initialize();
        assert.equal(initialized.error, undefined);

        const search = await relay.request('tools/call', {
            name: 'agoragentic_search',
            arguments: { query: 'safe fallback' },
        });
        assert.equal(search.error, undefined, JSON.stringify({
            search,
            requests: fixture.requests,
            stderr: relay.getStderr(),
        }));
        assert.equal(search.result.isError, true);
        assert.equal(
            JSON.parse(search.result.content[0].text).error,
            'risk_fork_enforcement_required',
        );
        assert.deepEqual(fixture.requests, [], 'missing enforcement must block discover and fallback HTTP');
    } finally {
        await relay.close();
        await fixture.close();
    }
});

test('preserves legacy stdio host compatibility while proxying v2 tools, resources, prompts, and tool errors', async () => {
    const fixture = createFixtureServer();
    const url = await fixture.listen();
    const relay = spawnLegacyStdioClient(
        url,
        FIXTURE_API_KEY,
        'http://127.0.0.1:9',
        ENFORCED_RELAY_ENTRYPOINT,
    );

    try {
        const initialized = await relay.initialize();
        assert.equal(initialized.error, undefined);

        const tools = await relay.request('tools/list');
        assert.ok(tools.result.tools.some((tool) => tool.name === 'relay_safe_probe'));

        const call = await relay.request('tools/call', {
            name: 'relay_safe_probe',
            arguments: { value: 'projected' },
        });
        assert.deepEqual(JSON.parse(call.result.content[0].text), { ok: true, value: 'projected' });

        const resources = await relay.request('resources/list');
        assert.ok(resources.result.resources.some((resource) => resource.uri === 'agoragentic://fixture/resource'));
        const resource = await relay.request('resources/read', { uri: 'agoragentic://fixture/resource' });
        assert.equal(resource.result.contents[0].text, 'loopback resource');

        const prompts = await relay.request('prompts/list');
        assert.ok(prompts.result.prompts.some((prompt) => prompt.name === 'relay-fixture-prompt'));
        const prompt = await relay.request('prompts/get', { name: 'relay-fixture-prompt' });
        assert.equal(prompt.result.messages[0].content.text, 'loopback prompt');

        const payment = await relay.request('tools/call', {
            name: 'relay_payment_probe',
            arguments: {},
        });
        assert.equal(payment.error, undefined, 'payment remains a tool result, never a JSON-RPC transport error');
        assert.equal(payment.result.isError, true);
        assert.equal(JSON.parse(payment.result.content[0].text).error, 'payment_required');

        const methods = new Set(fixture.requests.map((request) => request.body.method));
        for (const method of ['server/discover', 'tools/list', 'tools/call', 'resources/list', 'resources/read', 'prompts/list', 'prompts/get']) {
            assert.ok(methods.has(method), `expected remote v2 ${method}`);
        }
        for (const request of fixture.requests) {
            assert.equal(request.headers['mcp-protocol-version'], MCP_V2_PROTOCOL_VERSION);
            assert.equal(request.headers['mcp-session-id'], undefined);
            assert.equal(request.headers.authorization, `Bearer ${FIXTURE_API_KEY}`);
        }
    } finally {
        await relay.close();
        await fixture.close();
    }
});
