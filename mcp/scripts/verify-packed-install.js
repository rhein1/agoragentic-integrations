'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { execFileSync, spawn } = require('child_process');
const {
    McpServer,
    createMcpHandler,
    fromJsonSchema,
} = require('@modelcontextprotocol/server');
const { toNodeHandler } = require('@modelcontextprotocol/node');
const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');

const MCP_V2_PROTOCOL_VERSION = '2026-07-28';
const PACKED_FIXTURE_API_KEY = 'amk_packed_fixture_key';

const npmCli = process.env.npm_execpath;
const npmCommand = npmCli
    ? process.execPath
    : process.platform === 'win32'
        ? process.env.ComSpec || 'cmd.exe'
        : 'npm';

function runNpm(args, options = {}) {
    const commandArgs = npmCli
        ? [npmCli, ...args]
        : process.platform === 'win32'
            ? ['/d', '/s', '/c', 'npm.cmd', ...args]
            : args;
    return execFileSync(npmCommand, commandArgs, {
        encoding: 'utf8',
        stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
        ...options,
    });
}

function verifyMcpFallback(entrypoint) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [entrypoint], {
            env: {
                ...process.env,
                AGORAGENTIC_MCP_URL: 'http://127.0.0.1:9/mcp',
                AGORAGENTIC_API_KEY: '',
            },
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        let stderr = '';
        let settled = false;
        const output = readline.createInterface({ input: child.stdout });
        const timeout = setTimeout(() => {
            finish(new Error(`packed MCP smoke timed out\n${stderr}`));
        }, 15000);

        function finish(error) {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            output.close();
            child.kill();
            if (error) reject(error);
            else resolve();
        }

        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });

        child.on('error', finish);
        child.on('exit', (code) => {
            if (!settled) {
                finish(new Error(`packed MCP exited before tools/list (code ${code})\n${stderr}`));
            }
        });

        output.on('line', (line) => {
            let message;
            try {
                message = JSON.parse(line);
            } catch {
                return;
            }

            if (message.id === 1 && message.result) {
                child.stdin.write(`${JSON.stringify({
                    jsonrpc: '2.0',
                    method: 'notifications/initialized',
                    params: {},
                })}\n`);
                child.stdin.write(`${JSON.stringify({
                    jsonrpc: '2.0',
                    id: 2,
                    method: 'tools/list',
                    params: {},
                })}\n`);
                return;
            }

            if (message.id === 2) {
                try {
                    const tools = message.result?.tools || [];
                    assert(tools.some((tool) => tool.name === 'agoragentic_preview_x402'));
                    assert(tools.some((tool) => tool.name === 'agoragentic_execute'));
                    child.stdin.write(`${JSON.stringify({
                        jsonrpc: '2.0',
                        id: 3,
                        method: 'tools/call',
                        params: {
                            name: 'agoragentic_execute',
                            arguments: { task: 'must remain blocked' },
                        },
                    })}\n`);
                } catch (error) {
                    finish(error);
                }
                return;
            }

            if (message.id === 3) {
                try {
                    assert.strictEqual(message.result?.isError, true);
                    assert.strictEqual(
                        JSON.parse(message.result?.content?.[0]?.text).error,
                        'risk_fork_enforcement_required',
                    );
                    finish();
                } catch (error) {
                    finish(error);
                }
            }
        });

        child.stdin.write(`${JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
                protocolVersion: '2025-06-18',
                capabilities: {},
                clientInfo: {
                    name: 'agoragentic-packed-install-smoke',
                    version: '1.0.0',
                },
            },
        })}\n`);
    });
}

async function verifyPackedAcpInputGuards(entrypoint) {
    const child = spawn(process.execPath, [entrypoint, '--acp'], {
        env: {
            ...process.env,
            AGORAGENTIC_MCP_URL: 'http://127.0.0.1:9/api/mcp',
            AGORAGENTIC_API_KEY: '',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    const output = readline.createInterface({ input: child.stdout });
    const pending = new Map();
    const rawWaiters = [];
    let nextId = 1;
    let stderr = '';
    child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
    });
    output.on('line', (line) => {
        const message = JSON.parse(line);
        const pendingRequest = pending.get(message.id);
        if (pendingRequest) {
            pending.delete(message.id);
            pendingRequest.resolve(message);
            return;
        }
        const rawIndex = rawWaiters.findIndex((candidate) => candidate.predicate(message));
        if (rawIndex === -1) return;
        const [rawWaiter] = rawWaiters.splice(rawIndex, 1);
        rawWaiter.resolve(message);
    });

    function request(method, params = {}) {
        const id = nextId;
        nextId += 1;
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                pending.delete(id);
                reject(new Error(`packed ACP request timed out: ${method}\n${stderr}`));
            }, 5000);
            pending.set(id, {
                resolve(message) {
                    clearTimeout(timeout);
                    resolve(message);
                },
            });
            child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
        });
    }

    function requestRaw(line) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                const index = rawWaiters.findIndex((candidate) => candidate.resolve === resolveMessage);
                if (index !== -1) rawWaiters.splice(index, 1);
                reject(new Error(`packed raw ACP request timed out\n${stderr}`));
            }, 5000);
            function resolveMessage(message) {
                clearTimeout(timeout);
                resolve(message);
            }
            rawWaiters.push({
                predicate: (message) => message.id === null && message.error,
                resolve: resolveMessage,
            });
            child.stdin.write(`${line}\n`, (error) => {
                if (!error) return;
                clearTimeout(timeout);
                const index = rawWaiters.findIndex((candidate) => candidate.resolve === resolveMessage);
                if (index !== -1) rawWaiters.splice(index, 1);
                reject(error);
            });
        });
    }

    const exit = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    try {
        assert.strictEqual((await requestRaw('{')).error.code, -32700);
        assert.strictEqual((await requestRaw('null')).error.code, -32600);
        assert.strictEqual((await requestRaw(
            '{"jsonrpc":"2.0","id":41,"method":"initialize","method":"tools/list","params":{}}',
        )).error.code, -32600);

        const deepParams = {};
        let deepCursor = deepParams;
        for (let depth = 0; depth < 52; depth += 1) {
            deepCursor.child = {};
            deepCursor = deepCursor.child;
        }
        assert.strictEqual((await requestRaw(JSON.stringify({
            jsonrpc: '2.0',
            id: 42,
            method: 'initialize',
            params: deepParams,
        }))).error.code, -32600);
        assert.strictEqual((await requestRaw(JSON.stringify({
            jsonrpc: '2.0',
            id: 43,
            method: 'initialize',
            padding: 'x'.repeat((4 * 1024 * 1024) + 1),
        }))).error.code, -32600);

        const initialized = await request('initialize', {
            protocolVersion: 1,
            clientInfo: { name: 'packed-bounded-parser-control', version: '1.0.0' },
        });
        assert.strictEqual(initialized.error, undefined);
        assert.strictEqual(initialized.result.protocolVersion, 1);

        const oversizedCwd = await request('session/new', {
            cwd: 'x'.repeat(4097),
        });
        assert.strictEqual(oversizedCwd.error.code, -32602);

        const session = await request('session/new', {
            cwd: 'C:\\synthetic-packed-acp-session',
        });
        assert.strictEqual(session.error, undefined);
        assert.strictEqual(typeof session.result.sessionId, 'string');
        assert.ok(session.result.sessionId.length > 0);

        const shutdown = await request('shutdown');
        assert.strictEqual(shutdown.error, undefined);
        assert.strictEqual(shutdown.result.ok, true);
        const afterShutdown = await request('tools/call', {
            name: 'agoragentic_execute',
            arguments: { task: 'must remain terminally blocked' },
        });
        assert.strictEqual(afterShutdown.error.code, -32000);
        assert.match(afterShutdown.error.message, /adapter is shut down/i);
        assert.strictEqual(
            afterShutdown.error.data.enforcement_code,
            'MCP_ACP_ADAPTER_SHUT_DOWN',
        );
    } finally {
        child.stdin.end();
        const outcome = await Promise.race([
            exit.then((value) => ({ exited: true, value })),
            new Promise((resolve) => setTimeout(() => resolve({ exited: false }), 5000)),
        ]);
        if (!outcome.exited) {
            child.kill();
            await exit;
            throw new Error(`packed ACP process did not exit after stdin EOF\n${stderr}`);
        }
        output.close();
        assert.strictEqual(outcome.value.code, 0, stderr);
    }
}

function createMcpV2Fixture() {
    const requests = [];
    const handler = createMcpHandler(async () => {
        const server = new McpServer({ name: 'agoragentic-mcp-packed-fixture', version: '1.0.0' });
        server.registerTool('packed_v2_probe', {
            description: 'Loopback-only packed relay probe.',
            inputSchema: fromJsonSchema({
                type: 'object',
                properties: { value: { type: 'string' } },
                required: ['value'],
                additionalProperties: false,
            }),
        }, async (args) => ({
            content: [{ type: 'text', text: JSON.stringify({ ok: true, value: args.value }) }],
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
            let body;
            try {
                body = JSON.parse(raw);
            } catch {
                res.statusCode = 400;
                res.end('invalid JSON');
                return;
            }
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

function cleanImported(api, request, result) {
    const evidenceRef = `packed-loopback:${request.request_id}`;
    return {
        schema: api.MCP_ENFORCEMENT_SCHEMAS.cleanImportedResult,
        request_id: request.request_id,
        request_hash: request.request_hash,
        phase: request.phase,
        clean_imported: true,
        authority_granted: false,
        evidence_ref: evidenceRef,
        evidence_hash: api.computeMcpCleanImportEvidenceHash(
            request.request_hash,
            result,
            evidenceRef,
        ),
        result,
    };
}

function createPackedLoopbackBoundary(api) {
    return api.createMcpEnforcementBoundary({
        async openSession(openRequest) {
            const transport = new StreamableHTTPClientTransport(new URL(openRequest.mcp_server_ref), {
                authProvider: { token: async () => PACKED_FIXTURE_API_KEY },
                onInsufficientScope: 'throw',
                requestInit: {
                    redirect: 'error',
                    headers: { 'User-Agent': 'agoragentic-mcp-packed-enforced-loopback' },
                },
            });
            const client = new Client(
                { name: 'agoragentic-mcp-packed-enforced-loopback', version: '1.0.0' },
                { versionNegotiation: { mode: { pin: MCP_V2_PROTOCOL_VERSION } } },
            );
            await client.connect(transport);
            assert.strictEqual(client.getProtocolEra(), 'modern');
            assert.strictEqual(client.getNegotiatedProtocolVersion(), MCP_V2_PROTOCOL_VERSION);
            assert.strictEqual(transport.sessionId, undefined);

            return {
                schema: api.MCP_ENFORCEMENT_SCHEMAS.hostSession,
                discovery: cleanImported(api, openRequest, {
                    protocol_version: MCP_V2_PROTOCOL_VERSION,
                    stateless: true,
                }),
                async request(request) {
                    let result;
                    if (request.phase === 'tools/list') result = await client.listTools(request.params);
                    else if (request.phase === 'tools/call') result = await client.callTool(request.params);
                    else throw new Error(`unexpected packed enforcement phase: ${request.phase}`);
                    return cleanImported(api, request, result);
                },
                async close() {
                    await client.close();
                },
            };
        },
        async executeFallback(request) {
            throw new Error(`unexpected packed fallback request: ${request.tool_name}`);
        },
    });
}

async function verifyPackedSecurityGuards(api, remoteUrl) {
    let targetOpenCalls = 0;
    const targetBoundary = api.createMcpEnforcementBoundary({
        async openSession() {
            targetOpenCalls += 1;
            throw new Error('query-bearing MCP target must not reach the host');
        },
        async executeFallback() {
            throw new Error('fallback must not run');
        },
    });
    await assert.rejects(
        api.connectRemoteClient({
            remoteUrl: `${remoteUrl}?apikey=raw-authority-value-not-pattern`,
            enforcementBoundary: targetBoundary,
        }),
        /credential-free HTTP\(S\) URL without query, fragment, or userinfo/,
    );
    assert.strictEqual(targetOpenCalls, 0, 'packed query rejection must happen before host I/O');

    const requestHash = `sha256:${'0'.repeat(64)}`;
    assert.throws(
        () => api.computeMcpCleanImportEvidenceHash(requestHash, {}, undefined),
        /canonical evidence reference/,
    );
    assert.throws(
        () => api.computeMcpCleanImportEvidenceHash(requestHash, {}, ' evidence:noncanonical'),
        /canonical evidence reference/,
    );

    let discoveryCloses = 0;
    const discoveryBoundary = api.createMcpEnforcementBoundary({
        async openSession(openRequest) {
            const discovery = cleanImported(api, openRequest, {
                protocol_version: MCP_V2_PROTOCOL_VERSION,
                stateless: true,
            });
            discovery.evidence_ref = `substituted:${openRequest.request_id}`;
            return {
                schema: api.MCP_ENFORCEMENT_SCHEMAS.hostSession,
                discovery,
                async request() {
                    throw new Error('request must not run after substituted packed discovery evidence');
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
        api.connectRemoteClient({ remoteUrl, enforcementBoundary: discoveryBoundary }),
        (error) => error?.code === 'MCP_RISK_FORK_IMPORT_INVALID',
    );
    assert.strictEqual(discoveryCloses, 1, 'packed discovery evidence substitution must close');

    let requestCloses = 0;
    const requestBoundary = api.createMcpEnforcementBoundary({
        async openSession(openRequest) {
            return {
                schema: api.MCP_ENFORCEMENT_SCHEMAS.hostSession,
                discovery: cleanImported(api, openRequest, {
                    protocol_version: MCP_V2_PROTOCOL_VERSION,
                    stateless: true,
                }),
                async request(request) {
                    const result = request.phase === 'tools/list'
                        ? { tools: [{ name: 'packed_evidence_probe' }] }
                        : { content: [{ type: 'text', text: 'clean result' }] };
                    const envelope = cleanImported(api, request, result);
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
    const requestSession = await api.connectRemoteClient({
        remoteUrl,
        enforcementBoundary: requestBoundary,
    });
    await assert.rejects(
        requestSession.callTool({ name: 'packed_evidence_probe', arguments: {} }),
        (error) => error?.code === 'MCP_RISK_FORK_IMPORT_INVALID',
    );
    assert.strictEqual(requestCloses, 1, 'packed request evidence substitution must close');

    let releaseClose;
    const closeGate = new Promise((resolve) => {
        releaseClose = resolve;
    });
    let markCloseStarted;
    const closeStarted = new Promise((resolve) => {
        markCloseStarted = resolve;
    });
    let closes = 0;
    const closeBoundary = api.createMcpEnforcementBoundary({
        async openSession(openRequest) {
            return {
                schema: api.MCP_ENFORCEMENT_SCHEMAS.hostSession,
                discovery: cleanImported(api, openRequest, {
                    protocol_version: MCP_V2_PROTOCOL_VERSION,
                    stateless: true,
                }),
                async request(request) {
                    return cleanImported(api, request, { tools: [] });
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
    const closeSession = await api.connectRemoteClient({ remoteUrl, enforcementBoundary: closeBoundary });
    const firstClose = closeSession.close();
    await closeStarted;
    const secondClose = closeSession.close();
    assert.strictEqual(secondClose, firstClose, 'packed concurrent closes must share one promise');
    let secondCloseSettled = false;
    void secondClose.finally(() => {
        secondCloseSettled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(secondCloseSettled, false, 'packed repeated close must await host cleanup');
    releaseClose();
    await Promise.all([firstClose, secondClose]);
    assert.strictEqual(closes, 1, 'packed concurrent closes must invoke host cleanup once');

    let failedCloses = 0;
    const failedCloseBoundary = api.createMcpEnforcementBoundary({
        async openSession(openRequest) {
            return {
                schema: api.MCP_ENFORCEMENT_SCHEMAS.hostSession,
                discovery: cleanImported(api, openRequest, {
                    protocol_version: MCP_V2_PROTOCOL_VERSION,
                    stateless: true,
                }),
                async request(request) {
                    return cleanImported(api, request, { tools: [] });
                },
                async close() {
                    failedCloses += 1;
                    throw new Error('packed synthetic host cleanup failed');
                },
            };
        },
        async executeFallback() {
            throw new Error('fallback must not run');
        },
    });
    const failedCloseSession = await api.connectRemoteClient({
        remoteUrl,
        enforcementBoundary: failedCloseBoundary,
    });
    const firstCloseFailure = failedCloseSession.close();
    const repeatedCloseFailure = failedCloseSession.close();
    assert.strictEqual(repeatedCloseFailure, firstCloseFailure);
    await assert.rejects(firstCloseFailure, /packed synthetic host cleanup failed/);
    await assert.rejects(repeatedCloseFailure, /packed synthetic host cleanup failed/);
    assert.strictEqual(failedCloses, 1, 'packed failed cleanup must not be reported as later success');

    const paginationCalls = [];
    const paginationBoundary = api.createMcpEnforcementBoundary({
        async openSession(openRequest) {
            return {
                schema: api.MCP_ENFORCEMENT_SCHEMAS.hostSession,
                discovery: cleanImported(api, openRequest, {
                    protocol_version: MCP_V2_PROTOCOL_VERSION,
                    stateless: true,
                }),
                async request(request) {
                    paginationCalls.push(request.params);
                    const result = request.params.cursor === 'packed-page-2'
                        ? { tools: [{ name: 'agoragentic_register' }] }
                        : { tools: [{ name: 'packed-page-1' }], nextCursor: 'packed-page-2' };
                    return cleanImported(api, request, result);
                },
                async close() {},
            };
        },
        async executeFallback() {
            throw new Error('fallback must not run');
        },
    });
    const paginationSession = await api.connectRemoteClient({
        remoteUrl,
        enforcementBoundary: paginationBoundary,
    });
    const paginationDirectory = api.createRemoteToolDirectory(paginationSession);
    assert.strictEqual(await paginationDirectory.has('agoragentic_register'), true);
    assert.deepStrictEqual(paginationCalls, [{}, { cursor: 'packed-page-2' }]);
    await paginationSession.close();

    function deferred() {
        let resolve;
        const promise = new Promise((settle) => {
            resolve = settle;
        });
        return { promise, resolve };
    }
    const oldRacePage = deferred();
    const oldRacePageRequested = deferred();
    const newRacePage = deferred();
    const newRacePageRequested = deferred();
    let raceRootPages = 0;
    let raceFallbackSelections = 0;
    const raceBoundary = api.createMcpEnforcementBoundary({
        async openSession(openRequest) {
            return {
                schema: api.MCP_ENFORCEMENT_SCHEMAS.hostSession,
                discovery: cleanImported(api, openRequest, {
                    protocol_version: MCP_V2_PROTOCOL_VERSION,
                    stateless: true,
                }),
                async request(request) {
                    let result;
                    if (request.params.cursor === 'packed-old-page-2') {
                        oldRacePageRequested.resolve();
                        result = await oldRacePage.promise;
                    } else if (request.params.cursor === 'packed-new-page-2') {
                        newRacePageRequested.resolve();
                        result = await newRacePage.promise;
                    } else {
                        raceRootPages += 1;
                        result = raceRootPages === 1
                            ? {
                                tools: [{ name: 'agoragentic_register' }],
                                nextCursor: 'packed-old-page-2',
                            }
                            : {
                                tools: [{ name: 'packed-new-page-one' }],
                                nextCursor: 'packed-new-page-2',
                            };
                    }
                    return cleanImported(api, request, result);
                },
                async close() {},
            };
        },
        async executeFallback() {
            throw new Error('packed pagination race must not select fallback');
        },
    });
    const raceSession = await api.connectRemoteClient({ remoteUrl, enforcementBoundary: raceBoundary });
    const raceDirectory = api.createRemoteToolDirectory(raceSession);
    let raceDecision;
    let raceList;
    try {
        raceDecision = (async () => {
            const existsRemotely = await raceDirectory.has('agoragentic_register');
            if (!existsRemotely) raceFallbackSelections += 1;
            return existsRemotely;
        })();
        await oldRacePageRequested.promise;
        raceList = raceDirectory.list();
        await newRacePageRequested.promise;
        oldRacePage.resolve({ tools: [{ name: 'packed-old-page-two' }] });
        assert.strictEqual(await raceDecision, true);
        newRacePage.resolve({ tools: [{ name: 'packed-new-page-two' }] });
        const refreshError = await raceList.then(() => null, (error) => error);
        assert.strictEqual(raceFallbackSelections, 0);
        assert.strictEqual(refreshError?.code, 'MCP_REMOTE_TOOL_DESCRIPTOR_DRIFT');
        await assert.rejects(
            raceDirectory.has('agoragentic_register'),
            (error) => [
                'MCP_REMOTE_TOOL_DESCRIPTOR_DRIFT',
                'MCP_ENFORCED_SESSION_CLOSED',
            ].includes(error?.code),
        );
    } finally {
        oldRacePage.resolve({ tools: [] });
        newRacePage.resolve({ tools: [] });
        await Promise.allSettled([raceDecision, raceList].filter(Boolean));
        await raceSession.close();
    }

    let incompleteFallbackCalls = 0;
    const incompleteBoundary = api.createMcpEnforcementBoundary({
        async openSession(openRequest) {
            return {
                schema: api.MCP_ENFORCEMENT_SCHEMAS.hostSession,
                discovery: cleanImported(api, openRequest, {
                    protocol_version: MCP_V2_PROTOCOL_VERSION,
                    stateless: true,
                }),
                async request(request) {
                    return cleanImported(api, request, {
                        tools: [{ name: 'packed-page-1' }],
                        nextCursor: 'packed-repeated-cursor',
                    });
                },
                async close() {},
            };
        },
        async executeFallback() {
            incompleteFallbackCalls += 1;
            throw new Error('fallback must not run while pagination is incomplete');
        },
    });
    const incompleteSession = await api.connectRemoteClient({
        remoteUrl,
        enforcementBoundary: incompleteBoundary,
    });
    const incompleteDirectory = api.createRemoteToolDirectory(incompleteSession);
    await assert.rejects(
        incompleteDirectory.has('agoragentic_register'),
        (error) => error?.code === 'MCP_REMOTE_TOOL_DIRECTORY_INCOMPLETE',
    );
    assert.strictEqual(incompleteFallbackCalls, 0);

    const jsonControls = [
        JSON.stringify({ groups: [{ value: 'one' }, { value: 'two' }], nested: { ok: true } }),
        '{"message":"escaped quote: \\"authorization\\" is documentation","nested":{"list":[1,{"ok":true}]}}',
        '{"\\u006dessage":"escaped object key is benign"}',
        '[["display_name","ordinary-value"]]',
        '{"name":"display_name","value":"ordinary-value"}',
        'The api_key is resolved out of band by the host.',
        'api_key="demo"',
        'api_key_ref="host-store/reference-123"',
    ];
    let nextJsonControl = 0;
    const jsonControlBoundary = api.createMcpEnforcementBoundary({
        async openSession(openRequest) {
            return {
                schema: api.MCP_ENFORCEMENT_SCHEMAS.hostSession,
                discovery: cleanImported(api, openRequest, {
                    protocol_version: MCP_V2_PROTOCOL_VERSION,
                    stateless: true,
                    }),
                    async request(request) {
                        if (request.phase === 'tools/list') {
                            return cleanImported(api, request, {
                                tools: [{
                                    name: 'packed_json_control',
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
                        }
                    const text = jsonControls[nextJsonControl];
                    nextJsonControl += 1;
                    return cleanImported(api, request, { content: [{ type: 'text', text }] });
                },
                async close() {},
            };
        },
        async executeFallback() {
            throw new Error('fallback must not run');
        },
    });
    const jsonControlSession = await api.connectRemoteClient({
        remoteUrl,
        enforcementBoundary: jsonControlBoundary,
    });
    try {
        for (const text of jsonControls) {
            const result = await jsonControlSession.callTool({
                name: 'packed_json_control',
                arguments: {},
            });
            assert.strictEqual(result.content[0].text, text);
        }
    } finally {
        await jsonControlSession.close();
    }

    const accessorResult = {};
    Object.defineProperty(accessorResult, 'tools', {
        enumerable: true,
        get() {
            throw new Error('packed accessor must not execute');
        },
    });
    const deepResult = { tools: [] };
    let deepCursor = deepResult;
    for (let depth = 0; depth < 52; depth += 1) {
        deepCursor.child = {};
        deepCursor = deepCursor.child;
    }

    const cases = [
        {
            label: 'joined credential alias',
            result: { tools: [], metadata: { apikey: 'raw-authority-value-not-pattern' } },
            error: (value) => value?.code === 'MCP_CREDENTIAL_MATERIAL_REJECTED',
        },
        {
            label: 'header object',
            result: {
                tools: [],
                headers: [{ name: 'authorization', value: 'raw-authority-value-not-pattern' }],
            },
            error: (value) => value?.code === 'MCP_CREDENTIAL_MATERIAL_REJECTED',
        },
        {
            label: 'header tuple',
            result: { tools: [], headers: [['authorization', 'raw-authority-value-not-pattern']] },
            error: (value) => value?.code === 'MCP_CREDENTIAL_MATERIAL_REJECTED',
        },
        {
            label: 'JSON text credential',
            result: {
                tools: [],
                content: [{
                    type: 'text',
                    text: JSON.stringify({ authorization: 'raw-authority-value-not-pattern' }),
                }],
            },
            error: (value) => value?.code === 'MCP_CREDENTIAL_MATERIAL_REJECTED',
        },
        {
            label: 'duplicate escaped JSON credential key',
            result: {
                tools: [],
                content: [{
                    type: 'text',
                    text: '{"authorization":"raw-authority-value-not-pattern","authoriz\\u0061tion":null}',
                }],
            },
            error: (value) => value?.code === 'MCP_CREDENTIAL_MATERIAL_REJECTED',
        },
        {
            label: 'top-level JSON header tuple',
            result: {
                tools: [],
                content: [{
                    type: 'text',
                    text: '[["authorization","raw-authority-value-not-pattern"]]',
                }],
            },
            error: (value) => value?.code === 'MCP_CREDENTIAL_MATERIAL_REJECTED',
        },
        {
            label: 'top-level JSON header object',
            result: {
                tools: [],
                content: [{
                    type: 'text',
                    text: '{"name":"authorization","value":"raw-authority-value-not-pattern"}',
                }],
            },
            error: (value) => value?.code === 'MCP_CREDENTIAL_MATERIAL_REJECTED',
        },
        {
            label: 'nested JSON header tuple',
            result: {
                tools: [],
                content: [{
                    type: 'text',
                    text: '{"metadata":[["authorization","raw-authority-value-not-pattern"]]}',
                }],
            },
            error: (value) => value?.code === 'MCP_CREDENTIAL_MATERIAL_REJECTED',
        },
        {
            label: 'schema default property-map smuggle',
            result: {
                tools: [{
                    name: 'packed_schema_smuggle',
                    inputSchema: {
                        type: 'object',
                        default: {
                            properties: {
                                apiKey: { value: 'raw-authority-value-not-pattern' },
                            },
                        },
                    },
                }],
            },
            error: (value) => value?.code === 'MCP_CREDENTIAL_MATERIAL_REJECTED',
        },
        {
            label: 'quoted shell credential assignment text',
            result: {
                tools: [],
                content: [{ type: 'text', text: 'api_key="syntheticvalue123456"' }],
            },
            error: (value) => value?.code === 'MCP_CREDENTIAL_MATERIAL_REJECTED',
        },
        {
            label: 'unquoted shell credential assignment text',
            result: {
                tools: [],
                content: [{ type: 'text', text: 'API_KEY = syntheticvalue123456' }],
            },
            error: (value) => value?.code === 'MCP_CREDENTIAL_MATERIAL_REJECTED',
        },
        {
            label: 'malformed JSON credential assignment text',
            result: {
                tools: [],
                content: [{ type: 'text', text: '{"api_key" = "syntheticvalue123456"}' }],
            },
            error: (value) => value?.code === 'MCP_CREDENTIAL_MATERIAL_REJECTED',
        },
        { label: 'accessor', result: accessorResult, error: /accessor-backed/ },
        { label: 'Proxy', result: new Proxy({ tools: [] }, {}), error: /Proxy/ },
        { label: 'depth', result: deepResult, error: /depth limit/ },
        {
            label: 'size',
            result: { tools: [], padding: 'x'.repeat((4 * 1024 * 1024) + 1) },
            error: /byte limit/,
        },
    ];

    for (const fixture of cases) {
        let closes = 0;
        const boundary = api.createMcpEnforcementBoundary({
            async openSession(openRequest) {
                return {
                    schema: api.MCP_ENFORCEMENT_SCHEMAS.hostSession,
                    discovery: cleanImported(api, openRequest, {
                        protocol_version: MCP_V2_PROTOCOL_VERSION,
                        stateless: true,
                    }),
                    async request(request) {
                        if (['accessor', 'Proxy', 'depth', 'size'].includes(fixture.label)) {
                            return {
                                ...cleanImported(api, request, { tools: [] }),
                                result: fixture.result,
                            };
                        }
                        return cleanImported(api, request, fixture.result);
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
            api.connectRemoteClient({ remoteUrl, enforcementBoundary: boundary }),
            fixture.error,
            fixture.label,
        );
        assert.strictEqual(closes, 1, `${fixture.label} must close the packed host session`);
    }
}

async function verifyPackedEofCleanup(entrypoint) {
    const probeSource = `
        const mcp = require(${JSON.stringify('__PACKED_ENTRYPOINT__')});
        function cleanImported(request, result) {
            const evidenceRef = 'packed-eof:' + request.request_id;
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
                        console.error('PACKED_EOF_HOST_CLOSE_CALLED');
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
    `.replace('__PACKED_ENTRYPOINT__', entrypoint.replace(/\\/g, '\\\\'));
    const child = spawn(process.execPath, ['-e', probeSource], {
        cwd: path.dirname(entrypoint),
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    const ready = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`packed EOF probe did not start\n${stderr}`)), 5000);
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
            if (stderr.includes('stdio relay')) {
                clearTimeout(timeout);
                resolve();
            }
        });
        child.once('exit', (code) => {
            clearTimeout(timeout);
            reject(new Error(`packed EOF probe exited before readiness with code ${code}\n${stderr}`));
        });
    });
    const exit = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));

    await ready;
    child.stdin.end();
    const outcome = await Promise.race([
        exit.then((value) => ({ exited: true, value })),
        new Promise((resolve) => setTimeout(() => resolve({ exited: false }), 1000)),
    ]);
    if (!outcome.exited) {
        child.kill();
        await exit;
    }
    assert.strictEqual(outcome.exited, true, `packed relay remained alive after stdin EOF\n${stderr}`);
    assert.strictEqual(outcome.value.code, 0, stderr);
    assert.match(stderr, /PACKED_EOF_HOST_CLOSE_CALLED/);
}

async function verifyPackedMcpV2Relay(entrypoint, remoteUrl, requests) {
    const api = require(entrypoint);
    assert.strictEqual(typeof api.createMcpEnforcementBoundary, 'function');
    assert.strictEqual(typeof api.connectRemoteClient, 'function');

    await assert.rejects(
        api.connectRemoteClient({ remoteUrl }),
        (error) => error?.code === 'MCP_RISK_FORK_ENFORCEMENT_REQUIRED',
    );
    assert.strictEqual(requests.length, 0, 'missing enforcement must produce zero remote I/O');

    await verifyPackedSecurityGuards(api, remoteUrl);
    assert.strictEqual(requests.length, 0, 'packed security guards must produce zero remote I/O');
    await verifyPackedEofCleanup(entrypoint);

    const session = await api.connectRemoteClient({
        remoteUrl,
        enforcementBoundary: createPackedLoopbackBoundary(api),
    });
    try {
        assert.strictEqual(Object.hasOwn(session, 'client'), false);
        assert.strictEqual(Object.hasOwn(session, 'transport'), false);
        const tools = await session.listTools();
        assert(tools.tools.some((tool) => tool.name === 'packed_v2_probe'));
        const result = await session.callTool({
            name: 'packed_v2_probe',
            arguments: { value: 'packed' },
        });
        assert.deepStrictEqual(JSON.parse(result.content[0].text), { ok: true, value: 'packed' });
    } finally {
        await api.closeRemoteSession(session);
    }
}

function assertPackedMcpV2Requests(requests) {
    for (const method of ['server/discover', 'tools/list', 'tools/call']) {
        assert(requests.some((request) => request.body.method === method), `packed relay must send ${method}`);
    }

    for (const request of requests) {
        assert.strictEqual(request.httpMethod, 'POST');
        assert.strictEqual(request.headers['mcp-protocol-version'], MCP_V2_PROTOCOL_VERSION);
        assert.strictEqual(request.headers['mcp-method'], request.body.method);
        assert.strictEqual(request.headers['mcp-session-id'], undefined);
        assert.strictEqual(request.headers.authorization, `Bearer ${PACKED_FIXTURE_API_KEY}`);
    }

    const toolCall = requests.find((request) => request.body.method === 'tools/call');
    assert.strictEqual(toolCall.headers['mcp-name'], 'packed_v2_probe');
}

async function main() {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agoragentic-mcp-packed-'));
    const packDir = path.join(tempRoot, 'pack');
    const consumerDir = path.join(tempRoot, 'consumer');
    fs.mkdirSync(packDir);
    fs.mkdirSync(consumerDir);

    try {
        const packed = JSON.parse(
            runNpm(['pack', '--pack-destination', packDir, '--json'], { capture: true })
        );
        assert(Array.isArray(packed) && packed.length === 1, 'npm pack must produce one tarball');

        const tarball = path.join(packDir, packed[0].filename);
        runNpm(['install', '--prefix', consumerDir, '--ignore-scripts', tarball]);
        runNpm(['audit', '--prefix', consumerDir, '--omit=dev', '--audit-level=moderate']);

        const installedRoot = path.join(consumerDir, 'node_modules', 'agoragentic-mcp');
        const installedPackage = JSON.parse(
            fs.readFileSync(path.join(installedRoot, 'package.json'), 'utf8')
        );
        assert.deepStrictEqual(
            installedPackage.dependencies || {},
            {},
            'packed consumers must not install runtime dependencies'
        );

        const entrypoint = path.join(installedRoot, 'dist', 'mcp-server.cjs');
        assert(fs.existsSync(entrypoint), 'packed MCP bundle is missing');
        await verifyMcpFallback(entrypoint);
        await verifyPackedAcpInputGuards(entrypoint);

        const fixture = createMcpV2Fixture();
        const remoteUrl = await fixture.listen();
        try {
            await verifyPackedMcpV2Relay(entrypoint, remoteUrl, fixture.requests);
            assertPackedMcpV2Requests(fixture.requests);
        } finally {
            await fixture.close();
        }

        console.log('packed consumer install verified: zero runtime dependencies, audit clean, fail-closed default and factory-created loopback host capability verified');
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
