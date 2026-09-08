import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { E2B_TEMPLATE_BUILD_READY_PATH } from './lib/runtime-contract.mjs';

export const E2B_TEMPLATE_RUNTIME_ROOT = '/opt/agoragentic/risk-fork';
export const E2B_TEMPLATE_WORKSPACE_ROOT = '/workspace/agoragentic-risk-fork-v1';
export const E2B_TEMPLATE_READY_PATH = E2B_TEMPLATE_BUILD_READY_PATH;

function defaultContextRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function createRiskForkE2BTemplate(options = {}) {
  const Template = options.Template;
  const waitForFile = options.waitForFile;
  if (typeof Template !== 'function') throw new TypeError('E2B Template factory is required');
  if (typeof waitForFile !== 'function') throw new TypeError('E2B waitForFile helper is required');
  const contextRoot = path.resolve(options.contextRoot ?? defaultContextRoot());
  const runtime = E2B_TEMPLATE_RUNTIME_ROOT;
  const builder = Template({
    fileContextPath: contextRoot,
    fileIgnorePatterns: [
      '**/node_modules/**',
      '**/.git/**',
      '**/*.env',
      '**/.env*',
    ],
  })
    .fromNodeImage('24')
    .setUser('root')
    .makeDir([
      '/opt/agoragentic/risk-fork/e2b-template',
      '/opt/agoragentic/risk-fork/src',
      '/opt/agoragentic/risk-fork/bin',
      '/opt/agoragentic/transaction-assurance/src',
      E2B_TEMPLATE_WORKSPACE_ROOT,
    ], { user: 'root', mode: 0o755 })
    .copyItems([
      {
        src: 'risk-fork/e2b-template',
        dest: '/opt/agoragentic/risk-fork/e2b-template',
        user: 'root',
        mode: 0o555,
        resolveSymlinks: false,
      },
      {
        src: [
          'risk-fork/src/child-operation.mjs',
          'risk-fork/src/canonical.mjs',
          'risk-fork/src/mcp-transport-contract.mjs',
          'risk-fork/src/util.mjs',
        ],
        dest: '/opt/agoragentic/risk-fork/src/',
        user: 'root',
        mode: 0o444,
        resolveSymlinks: false,
      },
      {
        src: 'transaction-assurance/src/canonical.mjs',
        dest: '/opt/agoragentic/transaction-assurance/src/',
        user: 'root',
        mode: 0o444,
        resolveSymlinks: false,
      },
    ])
    .runCmd([
      `chown -R root:root ${runtime} /opt/agoragentic/transaction-assurance`,
      `find ${runtime}/e2b-template -type d -exec chmod 0555 {} +`,
      `find ${runtime}/e2b-template -type f -exec chmod 0444 {} +`,
      `chmod 0555 ${runtime}/e2b-template/bin/boot-guard.mjs ${runtime}/e2b-template/bin/bootstrap.mjs ${runtime}/e2b-template/bin/run.mjs`,
      `ln -s ${runtime}/e2b-template/bin/bootstrap.mjs ${runtime}/bin/bootstrap`,
      `ln -s ${runtime}/e2b-template/bin/run.mjs ${runtime}/bin/run`,
      'chown user:user /workspace/agoragentic-risk-fork-v1',
      'chmod 0700 /workspace/agoragentic-risk-fork-v1',
    ], { user: 'root' })
    .setUser('user')
    .setWorkdir(E2B_TEMPLATE_WORKSPACE_ROOT);

  return builder.setStartCmd(
    '/usr/bin/env -i HOME=/home/user USER=user LOGNAME=user SHELL=/bin/sh PATH=/usr/local/bin:/usr/bin:/bin node /opt/agoragentic/risk-fork/e2b-template/bin/boot-guard.mjs',
    waitForFile(E2B_TEMPLATE_READY_PATH),
  );
}
