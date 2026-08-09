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

const MCP_V2_PROTOCOL_VERSION = '2026-07-28';
const PACKED_FIXTURE_API_KEY = 'amk_packed_fixture_key';

const npmCli = process.env.npm_execpath;
const npmCommand = npmCli ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';

function runNpm(args, options = {}) {
    const commandArgs = npmCli ? [npmCli, ...args] : args;
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

function verifyPackedMcpV2Relay(entrypoint, remoteUrl) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [entrypoint], {
            env: {
                ...process.env,
                AGORAGENTIC_MCP_URL: remoteUrl,
                AGORAGENTIC_API_KEY: PACKED_FIXTURE_API_KEY,
            },
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        let stderr = '';
        let settled = false;
        const output = readline.createInterface({ input: child.stdout });
        const timeout = setTimeout(() => {
            finish(new Error(`packed MCP v2 relay smoke timed out\n${stderr}`));
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
                finish(new Error(`packed MCP v2 relay exited before tools/call (code ${code})\n${stderr}`));
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
                    assert((message.result?.tools || []).some((tool) => tool.name === 'packed_v2_probe'));
                    child.stdin.write(`${JSON.stringify({
                        jsonrpc: '2.0',
                        id: 3,
                        method: 'tools/call',
                        params: { name: 'packed_v2_probe', arguments: { value: 'packed' } },
                    })}\n`);
                } catch (error) {
                    finish(error);
                }
                return;
            }

            if (message.id === 3) {
                try {
                    assert.deepStrictEqual(JSON.parse(message.result?.content?.[0]?.text), { ok: true, value: 'packed' });
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
                    name: 'agoragentic-packed-v2-relay-smoke',
                    version: '1.0.0',
                },
            },
        })}\n`);
    });
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

        const fixture = createMcpV2Fixture();
        const remoteUrl = await fixture.listen();
        try {
            await verifyPackedMcpV2Relay(entrypoint, remoteUrl);
            assertPackedMcpV2Requests(fixture.requests);
        } finally {
            await fixture.close();
        }

        console.log('packed consumer install verified: zero runtime dependencies, audit clean, legacy fallback and v2 relay ready');
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
