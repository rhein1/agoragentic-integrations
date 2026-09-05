'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const packageRoot = path.resolve(__dirname, '..');
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agoragentic-risk-forkd-pack-'));
const packRoot = path.join(temporaryRoot, 'pack');
const consumerRoot = path.join(temporaryRoot, 'consumer');
const npmCli = process.env.npm_execpath;
const npmCommand = npmCli
    ? process.execPath
    : process.platform === 'win32'
        ? process.env.ComSpec || 'cmd.exe'
        : 'npm';

function runNpm(args, cwd) {
    const commandArgs = npmCli
        ? [npmCli, ...args]
        : process.platform === 'win32'
            ? ['/d', '/s', '/c', 'npm.cmd', ...args]
            : args;
    return execFileSync(npmCommand, commandArgs, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

try {
    fs.mkdirSync(packRoot, { recursive: true });
    fs.mkdirSync(consumerRoot, { recursive: true });
    fs.writeFileSync(path.join(consumerRoot, 'package.json'), JSON.stringify({
        name: 'risk-forkd-packed-consumer',
        version: '1.0.0',
        private: true,
    }, null, 2));

    const packed = JSON.parse(runNpm([
        'pack',
        '--json',
        '--pack-destination',
        packRoot,
    ], packageRoot));
    assert.equal(packed.length, 1);
    const tarball = path.join(packRoot, packed[0].filename);
    runNpm([
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        tarball,
    ], consumerRoot);

    const installedRoot = path.join(consumerRoot, 'node_modules', 'agoragentic-mcp');
    const installedPackage = JSON.parse(fs.readFileSync(
        path.join(installedRoot, 'package.json'),
        'utf8',
    ));
    assert.equal(installedPackage.private, true);
    assert.equal(installedPackage.exports['./risk-forkd'], './risk-forkd.js');
    assert.equal(installedPackage.bin['risk-forkd'], 'risk-forkd.js');
    assert.equal(fs.existsSync(path.join(installedRoot, 'risk-forkd.js')), true);
    assert.equal(fs.existsSync(path.join(
        consumerRoot,
        'node_modules',
        '.bin',
        process.platform === 'win32' ? 'risk-forkd.cmd' : 'risk-forkd',
    )), true);

    const consumerProbe = `
        const assert = require('assert');
        const mcp = require('agoragentic-mcp');
        const riskForkd = require('agoragentic-mcp/risk-forkd');
        const adapter = {
            async openSession() { throw new Error('packed probe must not start'); },
            async executeFallback() { throw new Error('packed probe must not execute fallback'); },
        };
        const boundary = mcp.createMcpEnforcementBoundary(adapter);
        assert.equal(mcp.isMcpEnforcementBoundary(boundary), true);
        const service = riskForkd.createRiskForkdService({ enforcementBoundary: boundary });
        assert.deepEqual(Reflect.ownKeys(service), ['schema', 'mode', 'status', 'start']);
        assert.equal(service.status.mcp_enforcement_boundary_bound, true);
        assert.equal(service.status.mcp_http_phase_executor_bound, false);
        assert.equal(service.status.risk_fork_provider_qualified, false);
        assert.equal(service.status.provider_authority_granted, false);
        assert.equal(service.status.hosted_runtime_qualified, false);
        assert.equal(service.status.hosted_authority_granted, false);
        assert.equal(service.status.e2b_live_qualified, false);
        assert.equal(service.status.e2b_authority_granted, false);
        assert.equal(service.status.production_authority_granted, false);
        assert.equal(service.status.authority_granted, false);
        assert.throws(
            () => riskForkd.createRiskForkdService({ enforcementBoundary: { ...boundary } }),
            (error) => error && error.code === 'RISK_FORKD_ENFORCEMENT_BOUNDARY_REQUIRED',
        );
        process.stdout.write('RISK_FORKD_PACKED_CONSUMER_OK\\n');
    `;
    const probeOutput = execFileSync(process.execPath, ['-e', consumerProbe], {
        cwd: consumerRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(probeOutput.trim(), 'RISK_FORKD_PACKED_CONSUMER_OK');

    const cli = spawnSync(process.execPath, [path.join(installedRoot, 'risk-forkd.js')], {
        cwd: consumerRoot,
        encoding: 'utf8',
    });
    assert.equal(cli.status, 78, cli.stderr);
    assert.equal(cli.stdout, '');
    const diagnostic = JSON.parse(cli.stderr.trim());
    assert.equal(diagnostic.startup, 'refused');
    assert.equal(diagnostic.reason_code, 'RISK_FORKD_IN_PROCESS_BOUNDARY_REQUIRED');
    assert.equal(diagnostic.mcp_enforcement_boundary_bound, false);
    assert.equal(diagnostic.mcp_http_phase_executor_bound, false);
    assert.equal(diagnostic.provider_authority_granted, false);
    assert.equal(diagnostic.hosted_authority_granted, false);
    assert.equal(diagnostic.e2b_authority_granted, false);
    assert.equal(diagnostic.production_authority_granted, false);

    console.log('risk-forkd packed install verification passed');
} finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
