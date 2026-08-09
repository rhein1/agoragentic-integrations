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

const {
    MCP_V2_PROTOCOL_VERSION,
    closeRemoteSession,
    connectRemoteClient,
    createRemoteToolDirectory,
} = require('../mcp-server.js');

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const RELAY_ENTRYPOINT = path.join(PACKAGE_ROOT, 'mcp-server.js');
const FIXTURE_API_KEY = 'amk_loopback_fixture_key';
const REGISTERED_FIXTURE_API_KEY = 'amk_loopback_registered_key';

function createFixtureServer() {
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
            requests.push({ httpMethod: req.method, headers: { ...req.headers }, body });
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

function assertModernRequest(request, expectedMethod, expectedName) {
    assert.equal(request.httpMethod, 'POST');
    assert.equal(request.body.method, expectedMethod);
    assert.equal(request.headers['mcp-protocol-version'], MCP_V2_PROTOCOL_VERSION);
    assert.equal(request.headers['mcp-method'], expectedMethod);
    assert.equal(request.headers['mcp-name'], expectedName);
    assert.equal(request.headers['mcp-session-id'], undefined);
    assert.equal(request.body.params._meta['io.modelcontextprotocol/protocolVersion'], MCP_V2_PROTOCOL_VERSION);
}

function spawnLegacyStdioClient(remoteUrl, apiKey, fallbackBaseUrl = 'http://127.0.0.1:9') {
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
    const child = spawn(process.execPath, [RELAY_ENTRYPOINT], {
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

test('pins the remote MCP client to stateless 2026-07-28 and sends bearer auth per request', async () => {
    const fixture = createFixtureServer();
    const url = await fixture.listen();
    const remoteSession = await connectRemoteClient({ remoteUrl: url, apiKey: FIXTURE_API_KEY });

    try {
        assert.equal(remoteSession.client.getProtocolEra(), 'modern');
        assert.equal(remoteSession.client.getNegotiatedProtocolVersion(), MCP_V2_PROTOCOL_VERSION);
        assert.equal(remoteSession.transport.sessionId, undefined);
        await remoteSession.client.listTools();
        await remoteSession.client.callTool({
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

test('does not retain a registration-returned key for later stateless requests', async () => {
    const fixture = createFixtureServer();
    const url = await fixture.listen();
    const remoteSession = await connectRemoteClient({ remoteUrl: url, apiKey: '' });

    try {
        const registration = await remoteSession.client.callTool({
            name: 'agoragentic_register',
            arguments: {},
        });
        assert.equal(registration.isError, undefined);
        await remoteSession.client.listTools();

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

test('keeps fallback identity separate from explicit remote pagination', async () => {
    const calls = [];
    const client = {
        async listTools(params = {}) {
            calls.push(params);
            if (params.cursor === 'page-2') {
                return { tools: [{ name: 'remote_page_two' }] };
            }
            return {
                tools: [
                    { name: 'remote_page_one' },
                    { name: 'agoragentic_register' },
                    { name: 'remote_page_two' },
                ],
            };
        },
    };
    const directory = createRemoteToolDirectory(client);

    const page = await directory.list({ cursor: 'page-2' });
    assert.deepEqual(page.tools.map((tool) => tool.name), ['remote_page_two']);
    assert.equal(await directory.has('agoragentic_register'), true);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1], {});

    await directory.list({ cursor: 'page-2' });
    assert.equal(await directory.has('agoragentic_register'), true);
    assert.equal(calls.length, 3);

    const aggregate = await directory.list();
    assert.ok(aggregate.tools.some((tool) => tool.name === 'agoragentic_search'));
    assert.equal(aggregate.tools.filter((tool) => tool.name === 'agoragentic_register').length, 1);
});

test('derives fallback tools from a custom MCP origin instead of forwarding its key elsewhere', async () => {
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
        assert.deepEqual(JSON.parse(search.result.content[0].text), { capabilities: [] });

        const fallbackRequest = fixture.requests.find((request) => request.url.startsWith('/api/capabilities'));
        assert.ok(fallbackRequest);
        assert.equal(fallbackRequest.headers.authorization, `Bearer ${FIXTURE_API_KEY}`);
    } finally {
        await relay.close();
        await fixture.close();
    }
});

test('preserves legacy stdio host compatibility while proxying v2 tools, resources, prompts, and tool errors', async () => {
    const fixture = createFixtureServer();
    const url = await fixture.listen();
    const relay = spawnLegacyStdioClient(url, FIXTURE_API_KEY);

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
