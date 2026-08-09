#!/usr/bin/env node

import { prepareReceiptVideo, ReceiptVideoError, renderReceiptVideo, TEMPLATE_IDS } from './receipt-video.mjs';

const [command, ...tokens] = process.argv.slice(2);

try {
  if (command === 'templates') {
    process.stdout.write(`${JSON.stringify({ templates: TEMPLATE_IDS })}\n`);
  } else if (command === 'prepare' || command === 'render-local') {
    const args = parseArgs(tokens);
    const fn = command === 'prepare' ? prepareReceiptVideo : renderReceiptVideo;
    const result = await fn({
      sourcePath: args.source,
      outDir: args.out,
      templateId: args.template,
      ...(args['created-at'] ? { createdAt: args['created-at'] } : {}),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    throw new ReceiptVideoError(
      'command_invalid',
      'Use prepare, render-local, or templates. External rendering, provider, deployment, publication, and spend commands do not exist.',
    );
  }
} catch (error) {
  const safeError = error instanceof ReceiptVideoError
    ? { ok: false, error: error.code, message: error.message }
    : { ok: false, error: 'unexpected_failure', message: 'The local receipt-video workflow failed.' };
  process.stderr.write(`${JSON.stringify(safeError)}\n`);
  process.exitCode = 1;
}

function parseArgs(tokens) {
  const allowed = new Set(['source', 'out', 'template', 'created-at']);
  const args = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const token = tokens[index];
    const value = tokens[index + 1];
    if (!token?.startsWith('--') || value === undefined) {
      throw new ReceiptVideoError('argument_invalid', 'Arguments must use --name value pairs.');
    }
    const key = token.slice(2);
    if (!allowed.has(key) || Object.hasOwn(args, key)) {
      throw new ReceiptVideoError('argument_invalid', `Unsupported or duplicate argument: --${key}.`);
    }
    args[key] = value;
  }
  if (!args.source || !args.out || !args.template) {
    throw new ReceiptVideoError('argument_invalid', '--source, --out, and --template are required.');
  }
  return args;
}
