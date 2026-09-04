import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const testRoot = path.dirname(fileURLToPath(import.meta.url));
const guardUrl = pathToFileURL(path.resolve(testRoot, '../scripts/network-guard.mjs')).href;
const scopeUrl = pathToFileURL(path.resolve(testRoot, '../scripts/network-scope.mjs')).href;

function minimalEnvironment() {
  return {
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    RISK_FORK_DEMO_ALLOW_LOOPBACK: '1',
  };
}

test('command scope permits only exact loopback hosts and remains isolated across async branches', async () => {
  const source = `
    import dns from 'node:dns';
    import http from 'node:http';
    import net from 'node:net';
    const { runWithRiskForkDemoLoopback } = await import(${JSON.stringify(scopeUrl)});
    const guard = await runWithRiskForkDemoLoopback(() => import(${JSON.stringify(guardUrl)}));
    const status = globalThis[Symbol.for('agoragentic.risk-fork.demo.network-guard.v1')];

    const predicateCases = [
      ['127.0.0.1', undefined],
      ['::1', undefined],
      ['[::1]', undefined],
      ['[::1]', { allowUrlBrackets: true }],
      ['127.0.0.2', undefined],
      ['127.255.255.254', undefined],
      ['::ffff:127.0.0.1', undefined],
      ['::ffff:127.0.0.2', undefined],
      ['[::ffff:127.0.0.1]', { allowUrlBrackets: true }],
      [' 127.0.0.1', undefined],
      ['127.0.0.1 ', undefined],
    ];
    const predicates = predicateCases.map(([host, options]) => [
      host,
      options?.allowUrlBrackets === true,
      guard.isLoopbackHost(host, options),
    ]);

    function syncBlock(operation) {
      try {
        const value = operation();
        value?.destroy?.();
        return 'unexpected';
      } catch (error) {
        return error.code;
      }
    }

    async function asyncBlock(operation) {
      try {
        const value = await operation();
        value?.body?.cancel?.();
        return 'unexpected';
      } catch (error) {
        return error.code;
      }
    }

    const blocked = await runWithRiskForkDemoLoopback(async () => {
      const socketHosts = [
        '127.0.0.2',
        '127.255.255.254',
        '::ffff:127.0.0.1',
        '::ffff:127.0.0.2',
        '[::1]',
      ];
      const urlTricks = [
        'http://127.0.0.2:9/',
        'http://127.255.255.254:9/',
        'http://[::ffff:127.0.0.1]:9/',
        'http://[::ffff:127.0.0.2]:9/',
        'http://127.0.0.1@example.invalid/',
        'http://example.invalid@127.0.0.1:9/',
        'http://127.0.0.1.example.invalid/',
        'http://2130706433:9/',
        'http://0177.0.0.1:9/',
        ' http://127.0.0.1:9/',
      ];
      const dnsHosts = [
        '127.0.0.2',
        '127.255.255.254',
        '::ffff:127.0.0.1',
        '::ffff:127.0.0.2',
        'example.invalid',
      ];
      return {
        sockets: socketHosts.map((host) => [
          host,
          syncBlock(() => net.connect({ host, port: 9 })),
        ]),
        urls: urlTricks.map((url) => [url, syncBlock(() => http.get(url))]),
        fetches: await Promise.all(urlTricks.map(async (url) => [
          url,
          await asyncBlock(() => fetch(url)),
        ])),
        dns: dnsHosts.map((host) => [host, syncBlock(() => dns.lookup(host, () => {}))]),
        options: [
          ['127.0.0.2', syncBlock(() => http.get({ hostname: '127.0.0.2', port: 9 }))],
          ['::ffff:127.0.0.1', syncBlock(() => http.get({ hostname: '::ffff:127.0.0.1', port: 9 }))],
          ['[::1]', syncBlock(() => http.get({ hostname: '[::1]', port: 9 }))],
        ],
      };
    });

    const ipv6Lookup = await runWithRiskForkDemoLoopback(() => new Promise((resolve, reject) => {
      dns.lookup('::1', (error, address, family) => {
        if (error) reject(error);
        else resolve({ address, family });
      });
    }));

    let readyResolve;
    let releaseResolve;
    const ready = new Promise((resolve) => { readyResolve = resolve; });
    const release = new Promise((resolve) => { releaseResolve = resolve; });
    const scopedRequest = runWithRiskForkDemoLoopback(async () => {
      const server = http.createServer((_request, response) => response.end('REPLAY'));
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const port = server.address().port;
      readyResolve({ server, port });
      await release;
      const body = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port }, (response) => {
          let value = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => { value += chunk; });
          response.on('end', () => resolve(value));
        }).once('error', reject);
      });
      return { body, server };
    });
    const { port } = await ready;
    const outsideScope = syncBlock(() => http.get({ host: '127.0.0.1', port }));
    releaseResolve();
    const allowed = await scopedRequest;
    await new Promise((resolve) => allowed.server.close(resolve));

    process.stdout.write(JSON.stringify({
      status,
      predicates,
      blocked,
      ipv6Lookup,
      outsideScope,
      allowedBody: allowed.body,
    }));
  `;
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    '--input-type=module',
    '--eval',
    source,
  ], {
    cwd: testRoot,
    env: minimalEnvironment(),
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(stderr, '');
  const result = JSON.parse(stdout);
  assert.equal(result.status.loopback_allowed, true);
  assert.deepEqual(result.status.loopback_scope, ['127.0.0.1', '::1']);
  assert.deepEqual(result.predicates, [
    ['127.0.0.1', false, true],
    ['::1', false, true],
    ['[::1]', false, false],
    ['[::1]', true, true],
    ['127.0.0.2', false, false],
    ['127.255.255.254', false, false],
    ['::ffff:127.0.0.1', false, false],
    ['::ffff:127.0.0.2', false, false],
    ['[::ffff:127.0.0.1]', true, false],
    [' 127.0.0.1', false, false],
    ['127.0.0.1 ', false, false],
  ]);
  for (const group of Object.values(result.blocked)) {
    assert.ok(group.every(([, code]) => code === 'RISK_FORK_DEMO_NETWORK_BLOCKED'));
  }
  assert.deepEqual(result.ipv6Lookup, { address: '::1', family: 6 });
  assert.equal(result.outsideScope, 'RISK_FORK_DEMO_NETWORK_BLOCKED');
  assert.equal(result.allowedBody, 'REPLAY');
});
