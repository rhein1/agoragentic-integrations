import './network-deny.mjs';

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { extname } from 'node:path';
import { networkBoundaryState } from './network-deny.mjs';

const require = createRequire(import.meta.url);
let handled = false;

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(String(value), 'utf8').digest('hex')}`;
}

function canonicalFormat(value, job) {
  if (value === undefined || value === null || value === '') return null;
  const requested = String(value).trim().toLowerCase();
  const format = job.formatAliases[requested] || requested;
  if (!job.supportedFormats.includes(format)) {
    throw codedError('unsupported_format', 'The parser returned an unsupported document format.');
  }
  return { requested, format, aliased: requested !== format };
}

async function resolveFormat(anydoc, bytes, job) {
  if (job.explicitFormat) {
    return {
      format: job.explicitFormat,
      requested_format: job.requestedFormat,
      alias_applied: job.requestedFormat !== job.explicitFormat,
      detected_by: 'caller',
    };
  }

  const content = canonicalFormat(await anydoc.formatFromBytes(bytes), job);
  if (content) {
    return {
      format: content.format,
      requested_format: content.requested,
      alias_applied: content.aliased,
      detected_by: 'content',
    };
  }

  const fromPath = job.filename
    ? canonicalFormat(await anydoc.formatFromPath(job.filename), job)
    : null;
  if (fromPath) {
    return {
      format: fromPath.format,
      requested_format: fromPath.requested,
      alias_applied: fromPath.aliased,
      detected_by: 'filename',
    };
  }

  const extension = job.extensionToFormat[extname(job.filename).toLowerCase()] || null;
  if (extension) {
    const requested = extname(job.filename).slice(1).toLowerCase();
    return {
      format: extension,
      requested_format: requested,
      alias_applied: requested !== extension,
      detected_by: 'extension_map',
    };
  }

  throw codedError(
    'unsupported_format',
    'The document format could not be detected. Signature-less input requires a filename or explicit format.',
  );
}

function validateParserModule(anydoc) {
  for (const name of ['formatFromBytes', 'formatFromPath', 'toMarkdownBytes', 'toDocument']) {
    if (typeof anydoc?.[name] !== 'function') {
      throw codedError('incompatible_anydoc_api', `The parser module does not export ${name}().`);
    }
  }
}

function installedNativeBinding(packageJson) {
  for (const packageName of Object.keys(packageJson.optionalDependencies || {})) {
    try {
      const binding = require(`${packageName}/package.json`);
      return { package: binding.name, package_version: binding.version };
    } catch {
      // Optional native packages for other platforms are expected to be absent.
    }
  }
  return { package: 'bundled_or_unresolved_native_binding', package_version: null };
}

async function loadParser(job) {
  if (job.parserKind === 'pinned_anydoc') {
    const packageJson = require(`${job.expectedPackage}/package.json`);
    if (packageJson.name !== job.expectedPackage || packageJson.version !== job.expectedVersion) {
      throw codedError('parser_version_mismatch', 'The installed AnyDoc package does not match the adapter pin.');
    }
    const anydoc = await import(job.expectedPackage);
    validateParserModule(anydoc);
    return {
      anydoc,
      provenance: {
        package: packageJson.name,
        package_version: packageJson.version,
        native_binding: installedNativeBinding(packageJson),
        engine: 'firecrawl_anydoc',
        module_kind: 'pinned_dependency',
        attested: true,
        version_verified_at_runtime: true,
      },
    };
  }

  const anydoc = await import(job.parserSpecifier);
  validateParserModule(anydoc);
  return {
    anydoc,
    provenance: {
      package: 'custom_parser_module',
      package_version: null,
      native_binding: null,
      engine: 'custom_parser_module',
      module_kind: 'test_only_custom_module',
      module_reference: job.parserLabel,
      attested: false,
      version_verified_at_runtime: false,
    },
  };
}

function addNested(queue, value, limit) {
  if (!value) return true;
  if (queue.length >= limit + 1) return false;
  queue.push(value);
  return true;
}

function unavailableStructure(status = 'unavailable') {
  return {
    status,
    block_count: 0,
    table_count: 0,
    note_count: 0,
    asset_count: 0,
    asset_bytes: 0,
    traversal_truncated: false,
  };
}

function inspectDocumentModel(document, limit) {
  if (!document || !Array.isArray(document.blocks)) return unavailableStructure();

  const queue = document.blocks.slice(0, limit + 1);
  let traversalTruncated = document.blocks.length > limit;
  let cursor = 0;
  let blockCount = 0;
  let tableCount = 0;

  while (cursor < queue.length && blockCount < limit) {
    const block = queue[cursor];
    cursor += 1;
    blockCount += 1;

    if (block?.kind === 'table' && block.table) {
      tableCount += 1;
      tableRows:
      for (const row of block.table.grid || []) {
        for (const slot of row || []) {
          for (const nested of slot?.cell?.blocks || []) {
            if (!addNested(queue, nested, limit)) {
              traversalTruncated = true;
              break tableRows;
            }
          }
        }
      }
    }

    for (const nested of block?.blocks || []) {
      if (!addNested(queue, nested, limit)) {
        traversalTruncated = true;
        break;
      }
    }
    for (const item of block?.list?.items || []) {
      for (const nested of item?.blocks || []) {
        if (!addNested(queue, nested, limit)) {
          traversalTruncated = true;
          break;
        }
      }
      if (traversalTruncated && queue.length >= limit + 1) break;
    }
  }

  if (cursor < queue.length) traversalTruncated = true;

  const assets = Array.isArray(document.assets) ? document.assets : [];
  const inspectedAssetCount = Math.min(assets.length, limit);
  let assetBytes = 0;
  for (let index = 0; index < inspectedAssetCount; index += 1) {
    assetBytes += Number(assets[index]?.data?.byteLength || 0);
  }
  if (assets.length > inspectedAssetCount) traversalTruncated = true;

  return {
    status: 'available',
    block_count: blockCount,
    table_count: tableCount,
    note_count: Array.isArray(document.notes) ? document.notes.length : 0,
    asset_count: assets.length,
    asset_bytes: assetBytes,
    traversal_truncated: traversalTruncated,
  };
}

function boundedString(value, maximum) {
  if (value.length <= maximum) return value;
  let end = maximum;
  const previous = value.charCodeAt(end - 1);
  const next = value.charCodeAt(end);
  if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
  return value.slice(0, end);
}

function environmentBoundary() {
  const keys = Object.keys(process.env).sort();
  return {
    inherited_keys: keys,
    sensitive_key_count: keys.filter((key) => /key|token|secret|password|credential|wallet|cookie|auth/i.test(key)).length,
  };
}

async function parse(job) {
  if (!Buffer.isBuffer(job.bytes) || job.bytes.byteLength === 0) {
    throw codedError('invalid_worker_input', 'The parser process requires non-empty document bytes.');
  }

  const { anydoc, provenance } = await loadParser(job);
  const resolved = await resolveFormat(anydoc, job.bytes, job);
  const markdown = await anydoc.toMarkdownBytes(job.bytes, resolved.format);
  if (typeof markdown !== 'string' || !/\S/.test(markdown)) {
    throw codedError('empty_output', 'The parser returned no meaningful Markdown.');
  }

  let structure;
  let documentModelStatus;
  let documentModelError = null;
  if (resolved.format === 'pdf') {
    structure = unavailableStructure();
    documentModelStatus = 'unsupported_for_pdf';
  } else if (!job.inspectStructure) {
    structure = unavailableStructure();
    documentModelStatus = 'disabled_by_caller';
  } else {
    try {
      const document = await anydoc.toDocument(job.bytes, resolved.format);
      structure = inspectDocumentModel(document, job.maxTraversalBlocks);
      documentModelStatus = structure.status;
    } catch (error) {
      documentModelError = error?.code ? String(error.code) : 'document_model_failed';
      structure = unavailableStructure('failed');
      documentModelStatus = 'failed';
    }
  }

  const boundedMarkdown = boundedString(markdown, job.maxMarkdownChars);
  return {
    format: resolved.format,
    requested_format: resolved.requested_format,
    format_alias_applied: resolved.alias_applied,
    detected_by: resolved.detected_by,
    markdown: boundedMarkdown,
    original_markdown_chars: markdown.length,
    original_markdown_hash: sha256(markdown),
    markdown_truncated: boundedMarkdown.length < markdown.length,
    structure,
    document_model_status: documentModelStatus,
    document_model_error: documentModelError,
    provenance,
    network_boundary: networkBoundaryState(),
    environment_boundary: environmentBoundary(),
    resource_usage: process.resourceUsage(),
  };
}

function publicError(error) {
  let current = error;
  while (current) {
    if (current.code === 'network_disabled') {
      return { code: 'network_disabled', cause_code: null };
    }
    if (current.code === 'ERR_ACCESS_DENIED') {
      return {
        code: 'permission_boundary_violation',
        cause_code: null,
        permission: typeof current.permission === 'string' ? current.permission : null,
      };
    }
    current = current.cause;
  }
  return {
    code: typeof error?.code === 'string' ? error.code : 'parser_worker_failed',
    cause_code: typeof error?.cause?.code === 'string' ? error.cause.code : null,
  };
}

function respond(message) {
  if (!process.send) process.exit(1);
  process.send(message, () => process.disconnect());
}

process.once('message', async (job) => {
  if (handled) return;
  handled = true;
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    respond({ ok: true, result: await parse(job) });
  } catch (error) {
    respond({ ok: false, error: publicError(error) });
  } finally {
    clearInterval(keepAlive);
  }
});
