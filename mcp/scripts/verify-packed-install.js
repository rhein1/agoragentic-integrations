'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { execFileSync, spawn } = require('child_process');

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

        console.log('packed consumer install verified: zero runtime dependencies, audit clean, MCP fallback ready');
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
