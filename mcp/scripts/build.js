'use strict';

const path = require('path');
const { build } = require('esbuild');

const packageRoot = path.resolve(__dirname, '..');

build({
    entryPoints: [path.join(packageRoot, 'mcp-server.js')],
    outfile: path.join(packageRoot, 'dist', 'mcp-server.cjs'),
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    legalComments: 'none',
}).catch((error) => {
    console.error(error);
    process.exit(1);
});
