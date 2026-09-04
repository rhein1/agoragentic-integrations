'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    MCP_ENFORCEMENT_SCHEMAS,
    MCP_V2_PROTOCOL_VERSION,
    computeMcpCleanImportEvidenceHash,
    connectRemoteClient,
    createMcpEnforcementBoundary,
} = require('../mcp-server.js');

const CAPABILITY_KEYS = [
    'network_access',
    'filesystem_read',
    'filesystem_write',
    'credential_access',
    'wallet_or_payment',
    'deployment',
    'publication',
    'communication',
    'database_mutation',
    'trust_or_reputation_mutation',
    'external_side_effect',
    'unknown_or_unclassified',
];

function capabilities(overrides = {}) {
    return Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, overrides[key] === true]));
}

function descriptor(name, overrides = {}) {
    return {
        name,
        description: `${name} test descriptor`,
        inputSchema: { type: 'object', additionalProperties: false },
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
        capabilities: capabilities(),
        ...overrides,
    };
}

function cleanImported(request, result, suffix = 'result') {
    const evidenceRef = `activation-test:${suffix}:${request.request_id}`;
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

function createBoundary({ listPages, onCall, timeouts } = {}) {
    const state = {
        adapter: null,
        session: null,
        openRequests: [],
        phaseRequests: [],
        closes: 0,
    };
    const adapter = {
        async openSession(openRequest, context) {
            assert.equal(this, adapter, 'openSession receiver must be bound to the host adapter');
            assert.equal(context.operation, 'openSession');
            state.openRequests.push(openRequest);
            const session = {
                schema: MCP_ENFORCEMENT_SCHEMAS.hostSession,
                discovery: cleanImported(openRequest, {
                    protocol_version: MCP_V2_PROTOCOL_VERSION,
                    stateless: true,
                }, 'discovery'),
                async request(request, requestContext) {
                    assert.equal(this, session, 'request receiver must be bound to the host session');
                    assert.equal(requestContext.operation, request.phase);
                    state.phaseRequests.push(request);
                    if (request.phase === 'tools/list') {
                        const cursor = request.params.cursor ?? '__first__';
                        const result = listPages instanceof Function
                            ? await listPages(cursor, requestContext)
                            : listPages?.[cursor] ?? { tools: [] };
                        return cleanImported(request, result, `list-${cursor}`);
                    }
                    if (request.phase === 'tools/call') {
                        const result = onCall ? await onCall(request, requestContext) : { ok: true };
                        return cleanImported(request, result, 'call');
                    }
                    return cleanImported(request, {}, request.phase);
                },
                async close(closeContext) {
                    assert.equal(this, session, 'close receiver must be bound to the host session');
                    assert.equal(closeContext.operation, 'close');
                    state.closes += 1;
                },
            };
            state.session = session;
            return session;
        },
        async executeFallback() {
            assert.equal(this, adapter, 'executeFallback receiver must be bound to the host adapter');
            throw new Error('fallback execution is not expected');
        },
        ...(timeouts ? { timeouts } : {}),
    };
    state.adapter = adapter;
    return {
        boundary: createMcpEnforcementBoundary(adapter),
        state,
    };
}

test('tools/call is bound to the exact discovered descriptor and host method receivers', async () => {
    const risky = descriptor('arbitrary_remote_mutation', {
        annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: true,
        },
        capabilities: capabilities({ database_mutation: true, external_side_effect: true }),
    });
    let callRequest;
    const { boundary, state } = createBoundary({
        listPages: { __first__: { tools: [risky] } },
        onCall(request) {
            callRequest = request;
            return { ok: true };
        },
    });

    const session = await connectRemoteClient({
        remoteUrl: 'https://remote.example.invalid/mcp',
        enforcementBoundary: boundary,
    });
    const result = await session.callTool({ name: risky.name, arguments: { id: 7 } });

    assert.deepEqual(result, { ok: true });
    assert.deepEqual(callRequest.tool_descriptor, risky);
    assert.match(callRequest.tool_descriptor_hash, /^sha256:[a-f0-9]{64}$/);
    assert.deepEqual(callRequest.tool_annotations, risky.annotations);
    assert.deepEqual(callRequest.tool_capabilities, risky.capabilities);
    assert.equal(callRequest.tool_effect_status, 'irreversible');
    assert.equal(callRequest.risk_profile.minimum_level, 'IRREVERSIBLE');
    assert.equal(callRequest.risk_profile.prepare_only, true);

    await Promise.all([session.close(), session.close()]);
    assert.equal(state.closes, 1, 'close must be idempotent');
});

test('unknown effectfulness is treated as irreversible before host execution', async () => {
    const unknown = {
        name: 'unclassified_remote_tool',
        description: 'No effect annotations or capability declaration',
        inputSchema: { type: 'object' },
    };
    let callRequest;
    const { boundary } = createBoundary({
        listPages: { __first__: { tools: [unknown] } },
        onCall(request) {
            callRequest = request;
            return { ok: true };
        },
    });
    const session = await connectRemoteClient({
        remoteUrl: 'https://remote.example.invalid/mcp',
        enforcementBoundary: boundary,
    });

    await session.callTool({ name: unknown.name, arguments: {} });
    assert.equal(callRequest.tool_effect_status, 'unknown_effectfulness');
    assert.equal(callRequest.tool_capabilities.unknown_or_unclassified, true);
    assert.equal(callRequest.risk_profile.minimum_level, 'IRREVERSIBLE');
    assert.equal(callRequest.risk_profile.prepare_only, true);
    await session.close();
});

test('effectful capabilities override a misleading read-only annotation', async () => {
    const misleading = descriptor('misleading_read_only_tool', {
        capabilities: capabilities({ filesystem_write: true }),
    });
    let callRequest;
    const { boundary } = createBoundary({
        listPages: { __first__: { tools: [misleading] } },
        onCall(request) {
            callRequest = request;
            return { ok: true };
        },
    });
    const session = await connectRemoteClient({
        remoteUrl: 'https://remote.example.invalid/mcp',
        enforcementBoundary: boundary,
    });

    await session.callTool({ name: misleading.name, arguments: {} });
    assert.equal(callRequest.tool_annotations.readOnlyHint, true);
    assert.equal(callRequest.tool_capabilities.filesystem_write, true);
    assert.equal(callRequest.tool_effect_status, 'irreversible');
    assert.equal(callRequest.risk_profile.prepare_only, true);
    await session.close();
});

test('duplicate names across pagination fail before tools/call and close the host session', async () => {
    const repeated = descriptor('duplicate_name');
    const { boundary, state } = createBoundary({
        listPages: {
            __first__: { tools: [repeated], nextCursor: 'page-2' },
            'page-2': { tools: [repeated] },
        },
    });

    const session = await connectRemoteClient({
        remoteUrl: 'https://remote.example.invalid/mcp',
        enforcementBoundary: boundary,
    });
    await assert.rejects(
        session.callTool({ name: repeated.name, arguments: {} }),
        (error) => error?.code === 'MCP_REMOTE_TOOL_DIRECTORY_INCOMPLETE',
    );
    assert.equal(state.closes, 1);
});

test('descriptor drift after discovery is rejected before the changed directory is accepted', async () => {
    const initial = descriptor('stable_name');
    const changed = descriptor('stable_name', { description: 'substituted descriptor' });
    let listCount = 0;
    const { boundary, state } = createBoundary({
        listPages(cursor) {
            assert.equal(cursor, '__first__');
            listCount += 1;
            return { tools: [listCount === 1 ? initial : changed] };
        },
    });
    const session = await connectRemoteClient({
        remoteUrl: 'https://remote.example.invalid/mcp',
        enforcementBoundary: boundary,
    });
    await session.callTool({ name: initial.name, arguments: {} });

    await assert.rejects(
        session.listTools(),
        (error) => error?.code === 'MCP_REMOTE_TOOL_DESCRIPTOR_DRIFT',
    );
    assert.equal(state.closes, 1);
});

test('unadvertised tool calls are rejected without invoking the host request method', async () => {
    const advertised = descriptor('advertised_tool');
    let callCount = 0;
    const { boundary, state } = createBoundary({
        listPages: { __first__: { tools: [advertised] } },
        onCall() {
            callCount += 1;
            return { ok: true };
        },
    });
    const session = await connectRemoteClient({
        remoteUrl: 'https://remote.example.invalid/mcp',
        enforcementBoundary: boundary,
    });

    await assert.rejects(
        session.callTool({ name: 'substituted_tool', arguments: {} }),
        (error) => error?.code === 'MCP_REMOTE_TOOL_NOT_ADVERTISED',
    );
    assert.equal(callCount, 0);
    assert.equal(state.phaseRequests.filter((request) => request.phase === 'tools/call').length, 0);
    await session.close();
});

test('request deadlines abort host-owned work and close the session once', async () => {
    let observedSignal;
    const { boundary, state } = createBoundary({
        listPages(_cursor, context) {
            observedSignal = context.signal;
            return new Promise(() => {});
        },
        timeouts: {
            open_session_ms: 100,
            request_ms: 20,
            close_ms: 100,
            fallback_ms: 100,
        },
    });

    await assert.rejects(
        connectRemoteClient({
            remoteUrl: 'https://remote.example.invalid/mcp',
            enforcementBoundary: boundary,
        }),
        (error) => error?.code === 'MCP_ENFORCEMENT_HOST_DEADLINE_EXCEEDED',
    );
    assert.equal(observedSignal.aborted, true);
    assert.equal(state.closes, 1);
});

test('effect-capable fallback is rejected before an AbortSignal-ignoring callback can run', async () => {
    let invoked = 0;
    const adapter = {
        async openSession() { throw new Error('not used'); },
        async executeFallback() {
            invoked += 1;
            return new Promise(() => {});
        },
    };
    const boundary = createMcpEnforcementBoundary(adapter);
    const { executeFallbackTool } = require('../mcp-server.js');
    const result = await executeFallbackTool(
        'agoragentic_register',
        {},
        { enforcementBoundary: boundary },
    );
    assert.equal(invoked, 0);
    assert.equal(JSON.parse(result.content[0].text).error, 'risk_fork_effect_fence_required');
});

test('a host session resolving after the open deadline is closed once', async () => {
    let closes = 0;
    const adapter = {
        timeouts: {
            open_session_ms: 10,
            request_ms: 100,
            close_ms: 100,
            fallback_ms: 100,
        },
        async openSession() {
            await new Promise((resolve) => setTimeout(resolve, 25));
            const session = {
                schema: MCP_ENFORCEMENT_SCHEMAS.hostSession,
                discovery: {},
                async request() {},
                async close() { closes += 1; },
            };
            return session;
        },
        async executeFallback() { throw new Error('not used'); },
    };
    await assert.rejects(
        connectRemoteClient({
            remoteUrl: 'https://remote.example.invalid/mcp',
            enforcementBoundary: createMcpEnforcementBoundary(adapter),
        }),
        (error) => error?.code === 'MCP_ENFORCEMENT_HOST_DEADLINE_EXCEEDED',
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(closes, 1);
});
