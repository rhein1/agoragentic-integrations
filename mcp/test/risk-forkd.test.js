'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');
const test = require('node:test');

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const MCP_SOURCE_ENTRYPOINT = path.join(PACKAGE_ROOT, 'mcp-server.js');
const MCP_PACKED_ENTRYPOINT = path.join(PACKAGE_ROOT, 'dist', 'mcp-server.cjs');
const RISK_FORKD_ENTRYPOINT = path.join(PACKAGE_ROOT, 'risk-forkd.js');
const RISK_FORKD_FIXTURE = path.join(PACKAGE_ROOT, 'test', 'fixtures', 'risk-forkd-entry.js');

function createFakeAdapter() {
    return {
        async openSession() {
            throw new Error('unit-only boundary must not be opened');
        },
        async executeFallback() {
            throw new Error('unit-only boundary must not execute fallback');
        },
    };
}

test('risk-forkd refuses missing, structural, foreign, and accessor configuration', () => {
    const mcp = require(MCP_PACKED_ENTRYPOINT);
    const sourceMcp = require(MCP_SOURCE_ENTRYPOINT);
    const riskForkd = require(RISK_FORKD_ENTRYPOINT);
    const exactBoundary = mcp.createMcpEnforcementBoundary(createFakeAdapter());
    const foreignBoundary = sourceMcp.createMcpEnforcementBoundary(createFakeAdapter());
    let accessorReads = 0;
    let proxyTraps = 0;
    const accessorOptions = {};
    Object.defineProperty(accessorOptions, 'enforcementBoundary', {
        enumerable: true,
        get() {
            accessorReads += 1;
            return exactBoundary;
        },
    });
    const proxyOptions = new Proxy({ enforcementBoundary: exactBoundary }, {
        getOwnPropertyDescriptor() {
            proxyTraps += 1;
            throw new Error('proxy descriptor trap must not run');
        },
        getPrototypeOf() {
            proxyTraps += 1;
            throw new Error('proxy prototype trap must not run');
        },
        ownKeys() {
            proxyTraps += 1;
            throw new Error('proxy ownKeys trap must not run');
        },
    });

    assert.equal(Object.isFrozen(mcp), true);
    assert.throws(() => {
        mcp.isMcpEnforcementBoundary = () => true;
    }, TypeError);
    assert.throws(() => {
        mcp.runMcpRelay = async () => {};
    }, TypeError);
    assert.equal(mcp.isMcpEnforcementBoundary(exactBoundary), true);
    assert.equal(mcp.isMcpEnforcementBoundary({ ...exactBoundary }), false);
    assert.throws(
        () => riskForkd.createRiskForkdService(),
        (error) => error?.code === 'RISK_FORKD_CONFIGURATION_INVALID',
    );
    assert.throws(
        () => riskForkd.createRiskForkdService({}),
        (error) => error?.code === 'RISK_FORKD_CONFIGURATION_INVALID',
    );
    assert.throws(
        () => riskForkd.createRiskForkdService({
            enforcementBoundary: { ...exactBoundary },
        }),
        (error) => error?.code === 'RISK_FORKD_ENFORCEMENT_BOUNDARY_REQUIRED',
    );
    assert.throws(
        () => riskForkd.createRiskForkdService({ enforcementBoundary: foreignBoundary }),
        (error) => error?.code === 'RISK_FORKD_ENFORCEMENT_BOUNDARY_REQUIRED',
    );
    assert.throws(
        () => riskForkd.createRiskForkdService(accessorOptions),
        (error) => error?.code === 'RISK_FORKD_CONFIGURATION_INVALID',
    );
    assert.throws(
        () => riskForkd.createRiskForkdService(proxyOptions),
        (error) => error?.code === 'RISK_FORKD_CONFIGURATION_INVALID',
    );
    assert.equal(accessorReads, 0);
    assert.equal(proxyTraps, 0);
});

test('risk-forkd exposes a closed source-only service with no direct executor or commit surface', async () => {
    const mcp = require(MCP_PACKED_ENTRYPOINT);
    const riskForkd = require(RISK_FORKD_ENTRYPOINT);
    const enforcementBoundary = mcp.createMcpEnforcementBoundary(createFakeAdapter());
    const service = riskForkd.createRiskForkdService({ enforcementBoundary });
    const source = fs.readFileSync(RISK_FORKD_ENTRYPOINT, 'utf8');

    assert.equal(Object.isFrozen(service), true);
    assert.deepEqual(Reflect.ownKeys(service), ['schema', 'mode', 'status', 'start']);
    assert.equal(service.mode, 'source_only_default_off');
    assert.equal(service.status.mcp_enforcement_boundary_bound, true);
    for (const field of [
        'mcp_http_phase_executor_bound',
        'risk_fork_provider_qualified',
        'provider_authority_granted',
        'hosted_runtime_qualified',
        'hosted_authority_granted',
        'e2b_live_qualified',
        'e2b_authority_granted',
        'production_authority_granted',
        'authority_granted',
        'live_traffic_protected',
        'network_implementation_included',
        'commit_prepared_supported',
    ]) {
        assert.equal(service.status[field], false, field);
    }
    assert.equal('enforcementBoundary' in service, false);
    assert.equal('executor' in service, false);
    assert.equal('adapter' in service, false);
    assert.equal('commitPrepared' in service, false);
    assert.doesNotMatch(source, /\b(?:fetch|https?\.request|connectRemoteClient|commitPrepared)\b/);
    assert.doesNotMatch(source, /require\(['"](?:node:)?(?:dns|http|https|net|tls|undici)['"]\)/);
    assert.match(source, /runMcpRelay/);
    await assert.rejects(
        service.start({ runMcpRelay() {} }),
        (error) => error?.code === 'RISK_FORKD_START_ARGUMENTS_UNSUPPORTED',
    );
});

test('standalone risk-forkd CLI is diagnostic-only and refuses startup', () => {
    const result = spawnSync(process.execPath, [RISK_FORKD_ENTRYPOINT], {
        cwd: PACKAGE_ROOT,
        encoding: 'utf8',
    });
    assert.equal(result.status, 78, result.stderr);
    assert.equal(result.stdout, '');
    const diagnostic = JSON.parse(result.stderr.trim());
    assert.equal(diagnostic.startup, 'refused');
    assert.equal(diagnostic.reason_code, 'RISK_FORKD_IN_PROCESS_BOUNDARY_REQUIRED');
    assert.equal(diagnostic.mode, 'source_only_default_off');
    assert.equal(diagnostic.mcp_enforcement_boundary_bound, false);
    assert.equal(diagnostic.mcp_http_phase_executor_bound, false);
    assert.equal(diagnostic.provider_authority_granted, false);
    assert.equal(diagnostic.hosted_authority_granted, false);
    assert.equal(diagnostic.e2b_authority_granted, false);
    assert.equal(diagnostic.production_authority_granted, false);
});

test('risk-forkd delegates every phase through the branded boundary and cleans up on EOF', async () => {
    const env = {
        ...process.env,
        AGORAGENTIC_MCP_URL: 'https://risk-forkd-loopback.example.invalid/api/mcp',
    };
    delete env.AGORAGENTIC_API_KEY;
    delete env.AGORAGENTIC_BASE_URL;
    const child = spawn(process.execPath, [RISK_FORKD_FIXTURE], {
        cwd: PACKAGE_ROOT,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    const pending = new Map();
    const stderr = [];
    const output = readline.createInterface({ input: child.stdout });
    let nextId = 1;

    output.on('line', (line) => {
        let message;
        try {
            message = JSON.parse(line);
        } catch {
            return;
        }
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        waiter.resolve(message);
    });
    child.stderr.on('data', (chunk) => stderr.push(chunk.toString()));
    const exit = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));

    function request(method, params = {}) {
        const id = nextId++;
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                pending.delete(id);
                reject(new Error(`risk-forkd timed out waiting for ${method}\n${stderr.join('')}`));
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

    try {
        const initialized = await request('initialize', {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'risk-forkd-test', version: '1.0.0' },
        });
        assert.equal(initialized.error, undefined, JSON.stringify(initialized));
        child.stdin.write(`${JSON.stringify({
            jsonrpc: '2.0',
            method: 'notifications/initialized',
            params: {},
        })}\n`);

        const listed = await request('tools/list');
        assert.equal(listed.error, undefined, JSON.stringify(listed));
        assert.equal(
            listed.result.tools.some((tool) => tool.name === 'risk_forkd_loopback_read'),
            true,
        );

        const called = await request('tools/call', {
            name: 'risk_forkd_loopback_read',
            arguments: { value: 'through-boundary' },
        });
        assert.equal(called.error, undefined, JSON.stringify(called));
        assert.deepEqual(
            JSON.parse(called.result.content[0].text),
            { ok: true, value: 'through-boundary' },
        );

        child.stdin.end();
        const outcome = await Promise.race([
            exit.then((value) => ({ exited: true, value })),
            new Promise((resolve) => setTimeout(() => resolve({ exited: false }), 2000)),
        ]);
        assert.equal(outcome.exited, true, `risk-forkd remained alive after EOF\n${stderr.join('')}`);
        assert.equal(outcome.value.code, 0, stderr.join(''));

        const events = stderr.join('')
            .split(/\r?\n/)
            .filter((line) => line.startsWith('RISK_FORKD_EVENT '))
            .map((line) => JSON.parse(line.slice('RISK_FORKD_EVENT '.length)));
        assert.deepEqual(
            events.filter((event) => event.event === 'host_request').map((event) => event.phase),
            ['server/discover', 'tools/list', 'tools/list', 'tools/call'],
        );
        assert.equal(events.some((event) => event.event === 'fallback_bypass'), false);
        assert.equal(events.filter((event) => event.event === 'host_close').length, 1);
        assert.equal(events.at(-1).event, 'host_close');
    } finally {
        output.close();
        if (child.exitCode === null && !child.killed) child.kill();
        if (child.exitCode === null) await exit;
    }
});
