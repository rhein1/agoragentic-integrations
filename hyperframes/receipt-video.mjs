import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const moduleRoot = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

export const HYPERFRAMES_VERSION = '0.7.102';
export const HYPERFRAMES_SOURCE_REVISION = '9ec9e3a711531b3d45c30a1e2c3006df97dbe5cb';
export const MAX_SOURCE_BYTES = 256 * 1024;
export const TEMPLATE_IDS = Object.freeze([
  'what-agoragentic-does',
  'agent-os-deploy-flow',
  'pr-release-explainer',
  'receipt-reconciliation-demo',
]);

const SOURCE_SCHEMA = 'agoragentic.receipt-evidence.video-source.v1';
const TIMELINE_SCHEMA = 'agoragentic.hyperframes.sanitized-timeline.v1';
const RECEIPT_SCHEMA = 'agoragentic.hyperframes.local-render-receipt.v1';
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SAFE_KINDS = new Set(['request', 'quote', 'policy', 'execution', 'receipt', 'reconciliation', 'deploy', 'release']);
const SENSITIVE_KEY = /(?:secret|credential|password|passphrase|api[_-]?key|private[_-]?key|signing[_-]?key|wallet[_-]?(?:key|seed)|seed[_-]?phrase|mnemonic|authorization|cookie|raw[_-]?(?:prompt|output|response|content)|tool[_-]?(?:output|result)|owner[_-]?(?:context|notes?))/i;
const INSTRUCTION_TRAPS = Object.freeze([
  ['ignore_previous_instructions', /ignore\s+(?:all\s+)?previous\s+instructions?/i],
  ['system_prompt_request', /(?:reveal|print|return|show)\s+(?:the\s+)?system\s+prompt/i],
  ['secret_exfiltration', /(?:exfiltrate|reveal|print|return|send)\s+(?:all\s+)?(?:secrets?|credentials?|private\s+keys?)/i],
  ['shell_execution_request', /(?:run|execute)\s+(?:this\s+)?(?:shell|powershell|bash|terminal)\s+(?:command|script)/i],
  ['instruction_override', /(?:developer|system)\s+message\s*:/i],
]);
const SECRET_PATTERNS = Object.freeze([
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi,
  /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9_-]{8,}\b/g,
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b0x[a-fA-F0-9]{64}\b/g,
]);
const PRIVATE_PATH_PATTERNS = Object.freeze([
  /\b[A-Za-z]:\\Users\\[^\\\s]+(?:\\[^\s<>"']*)?/g,
  /\/(?:home|Users)\/[^/\s]+(?:\/[^\s<>"']*)?/g,
  /\b[A-Za-z]:\\projects\\[^\s<>"']*/gi,
]);

export class ReceiptVideoError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReceiptVideoError';
    this.code = code;
  }
}

export async function compileReceiptTimeline({ sourcePath, templateId = 'receipt-reconciliation-demo' } = {}) {
  const source = await readSource(sourcePath);
  const template = await readTemplate(templateId);
  const inspection = inspectTree(source.parsed);
  const redactions = { secret_values: 0, private_paths: 0 };
  const trapCodes = new Set();

  const clean = (value, name, maxLength, fallback = '') => sanitizeText({
    value,
    name,
    maxLength,
    fallback,
    redactions,
    trapCodes,
  });

  const events = requireArray(source.parsed.events, 'events', 1, 8);
  const scenes = events.map((event, index) => {
    if (!event || Array.isArray(event) || typeof event !== 'object') {
      throw new ReceiptVideoError('event_invalid', `events[${index}] must be an object.`);
    }
    return {
      index,
      kind: SAFE_KINDS.has(event.kind) ? event.kind : 'request',
      label: clean(event.label, `events[${index}].label`, 80, template.fallback_labels[index % 4]),
      detail: clean(event.detail, `events[${index}].detail`, 180, 'Bounded evidence recorded.'),
      status: clean(event.status, `events[${index}].status`, 40, 'recorded'),
      evidence_ref: clean(event.evidence_ref, `events[${index}].evidence_ref`, 120, `evidence:event:${index + 1}`),
      start_seconds: index,
      duration_seconds: 1,
    };
  });

  const evidence = Array.isArray(source.parsed.evidence)
    ? source.parsed.evidence.slice(0, 12).map((entry, index) => sanitizeEvidence(entry, index, clean))
    : [];

  if (trapCodes.size > 0) {
    throw new ReceiptVideoError(
      'instruction_trap_detected',
      `Allowed display content matched blocked instruction patterns: ${[...trapCodes].sort().join(', ')}.`,
    );
  }

  const timeline = {
    schema: TIMELINE_SCHEMA,
    template: {
      id: template.id,
      title: template.title,
      subtitle: template.subtitle,
      accent: template.accent,
    },
    source: {
      schema: SOURCE_SCHEMA,
      ref: `local:${path.basename(source.absolutePath)}`,
      sha256: source.sha256,
      bytes: source.bytes.length,
      raw_retained: false,
    },
    title: clean(source.parsed.title, 'title', 120, template.title),
    summary: clean(source.parsed.summary, 'summary', 280, template.subtitle),
    status: clean(source.parsed.status, 'status', 40, 'recorded'),
    scenes,
    evidence,
    sanitization: {
      allowlist_only: true,
      unknown_fields_omitted: inspection.unknownFields,
      sensitive_fields_omitted: inspection.sensitiveFields,
      secret_values_redacted: redactions.secret_values,
      private_paths_redacted: redactions.private_paths,
      instruction_trap_scan: 'pass',
      raw_prompts_retained: false,
      raw_tool_outputs_retained: false,
      private_owner_context_retained: false,
    },
    authority: noAuthority(),
  };
  const timelineJson = `${stableStringify(timeline)}\n`;
  const html = renderTimelineHtml(timeline);
  return {
    timeline,
    timelineJson,
    timelineSha256: sha256(timelineJson),
    html,
    htmlSha256: sha256(html),
    sourceSha256: source.sha256,
  };
}

export async function prepareReceiptVideo({
  sourcePath,
  outDir,
  templateId,
  createdAt = new Date().toISOString(),
} = {}) {
  return writeReceiptVideoBundle({ sourcePath, outDir, templateId, createdAt, render: false });
}

export async function renderReceiptVideo({
  sourcePath,
  outDir,
  templateId,
  createdAt = new Date().toISOString(),
} = {}) {
  return writeReceiptVideoBundle({ sourcePath, outDir, templateId, createdAt, render: true });
}

async function writeReceiptVideoBundle({ sourcePath, outDir, templateId, createdAt, render }) {
  assertIsoTimestamp(createdAt);
  const outputRoot = path.resolve(requiredString(outDir, 'outDir'));
  await assertOutputAbsent(outputRoot);
  const compiled = await compileReceiptTimeline({ sourcePath, templateId });
  const parent = path.dirname(outputRoot);
  const stagingRoot = path.join(parent, `.${path.basename(outputRoot)}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  const compositionRoot = path.join(stagingRoot, 'composition');

  await fs.mkdir(parent, { recursive: true });
  try {
    await fs.mkdir(compositionRoot, { recursive: true });
    await fs.writeFile(path.join(stagingRoot, 'sanitized-timeline.json'), compiled.timelineJson, { encoding: 'utf8', flag: 'wx' });
    await fs.writeFile(path.join(compositionRoot, 'index.html'), compiled.html, { encoding: 'utf8', flag: 'wx' });

    let output = null;
    if (render) {
      const videoPath = path.join(stagingRoot, 'receipt-video.mp4');
      await runLocalRenderer({ compositionRoot, videoPath });
      const videoBytes = await fs.readFile(videoPath);
      assertMp4(videoBytes);
      output = {
        path: 'receipt-video.mp4',
        media_type: 'video/mp4',
        bytes: videoBytes.length,
        sha256: sha256(videoBytes),
      };
    }

    const receipt = buildRenderReceipt({ compiled, createdAt, output });
    await fs.writeFile(
      path.join(stagingRoot, 'local-render-receipt.json'),
      `${stableStringify(receipt)}\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
    await fs.rename(stagingRoot, outputRoot);
    return {
      ok: true,
      status: receipt.status,
      files: [
        'sanitized-timeline.json',
        'composition/index.html',
        ...(output ? ['receipt-video.mp4'] : []),
        'local-render-receipt.json',
      ],
      source_receipt_sha256: compiled.sourceSha256,
      sanitized_timeline_sha256: compiled.timelineSha256,
      scene_html_sha256: compiled.htmlSha256,
      output_sha256: output?.sha256 ?? null,
    };
  } catch (error) {
    await fs.rm(stagingRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    throw error;
  }
}

function buildRenderReceipt({ compiled, createdAt, output }) {
  return {
    schema: RECEIPT_SCHEMA,
    status: output ? 'completed' : 'prepared',
    created_at: createdAt,
    source_receipt_sha256: compiled.sourceSha256,
    sanitized_timeline_sha256: compiled.timelineSha256,
    scene_html_sha256: compiled.htmlSha256,
    renderer: {
      name: 'hyperframes',
      version: HYPERFRAMES_VERSION,
      upstream_revision: HYPERFRAMES_SOURCE_REVISION,
      mode: 'local_cli',
      telemetry_disabled: true,
      update_checks_disabled: true,
    },
    output,
    safety: {
      deterministic_timeline: true,
      self_contained_html: true,
      raw_source_retained: false,
      raw_prompts_retained: false,
      raw_tool_outputs_retained: false,
      private_owner_context_retained: false,
      inherited_secret_environment: false,
      source_receipt_mutated: false,
    },
    authority: noAuthority(),
  };
}

async function runLocalRenderer({ compositionRoot, videoPath }) {
  await assertExecutable('ffmpeg', ['-version'], 'ffmpeg_unavailable');
  const browserPath = await findSystemBrowser();
  if (!browserPath) {
    throw new ReceiptVideoError(
      'browser_unavailable',
      'A local Chrome, Chromium, or chrome-headless-shell executable is required; automatic browser download is not allowed.',
    );
  }
  const packagePath = require.resolve('hyperframes/package.json');
  const packageJson = JSON.parse(await fs.readFile(packagePath, 'utf8'));
  if (packageJson.version !== HYPERFRAMES_VERSION) {
    throw new ReceiptVideoError('renderer_version_mismatch', `Expected HyperFrames ${HYPERFRAMES_VERSION}.`);
  }
  const cliPath = path.resolve(path.dirname(packagePath), packageJson.bin.hyperframes);
  const env = localRenderEnvironment({ browserPath });
  try {
    await execFileAsync(process.execPath, [
      cliPath,
      'render',
      compositionRoot,
      '--composition', 'index.html',
      '--output', videoPath,
      '--fps', '10',
      '--quality', 'draft',
      '--workers', '1',
      '--no-browser-gpu',
      '--strict',
    ], {
      cwd: compositionRoot,
      env,
      maxBuffer: 2 * 1024 * 1024,
      timeout: 120_000,
      windowsHide: true,
    });
  } catch {
    throw new ReceiptVideoError('local_render_failed', 'The pinned local HyperFrames render failed; no output bundle was retained.');
  }
}

function localRenderEnvironment({ browserPath }) {
  return {
    ...localChildEnvironment(),
    CI: '1',
    DO_NOT_TRACK: '1',
    HYPERFRAMES_NO_TELEMETRY: '1',
    HYPERFRAMES_NO_UPDATE_CHECK: '1',
    HYPERFRAMES_NO_AUTO_INSTALL: '1',
    HYPERFRAMES_SKIP_SKILLS: '1',
    HYPERFRAMES_BROWSER_PATH: browserPath,
    AGORAGENTIC_NO_SPEND: '1',
    AGORAGENTIC_ALLOW_REAL_SPEND: '0',
    AGORAGENTIC_ALLOW_NETWORK_CANARIES: '0',
  };
}

function localChildEnvironment() {
  const allowed = [
    'PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT',
    'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'LD_LIBRARY_PATH',
    'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP',
  ];
  const env = {};
  for (const key of allowed) {
    if (typeof process.env[key] === 'string') env[key] = process.env[key];
  }
  return env;
}

async function findSystemBrowser() {
  const candidates = process.platform === 'win32'
    ? [
        path.join(process.env.ProgramFiles || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env['ProgramFiles(x86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env.ProgramFiles || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ]
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/chrome-headless-shell'];
  for (const candidate of candidates.filter(Boolean)) {
    const stat = await fs.stat(candidate).catch(() => null);
    if (stat?.isFile()) return candidate;
  }
  return null;
}

async function assertExecutable(command, args, code) {
  try {
    await execFileAsync(command, args, {
      env: localChildEnvironment(),
      timeout: 10_000,
      windowsHide: true,
    });
  } catch {
    throw new ReceiptVideoError(code, `${command} is required for local rendering.`);
  }
}

async function readSource(sourcePath) {
  const absolutePath = path.resolve(requiredString(sourcePath, 'sourcePath'));
  const stat = await fs.lstat(absolutePath).catch(() => null);
  if (!stat) throw new ReceiptVideoError('source_not_found', 'The source receipt does not exist.');
  if (stat.isSymbolicLink()) throw new ReceiptVideoError('source_symlink_rejected', 'The source receipt must not be a symbolic link.');
  if (!stat.isFile()) throw new ReceiptVideoError('source_not_regular_file', 'The source receipt must be a regular file.');
  if (stat.size === 0 || stat.size > MAX_SOURCE_BYTES) {
    throw new ReceiptVideoError('source_size_invalid', `The source receipt must be between 1 and ${MAX_SOURCE_BYTES} bytes.`);
  }
  const bytes = await fs.readFile(absolutePath);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ReceiptVideoError('source_not_utf8', 'The source receipt must be valid UTF-8 JSON.');
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ReceiptVideoError('source_json_invalid', 'The source receipt must be valid JSON.');
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new ReceiptVideoError('source_json_invalid', 'The source receipt must be a JSON object.');
  }
  if (parsed.schema !== SOURCE_SCHEMA) {
    throw new ReceiptVideoError('source_schema_invalid', `The source schema must be ${SOURCE_SCHEMA}.`);
  }
  return { absolutePath, bytes, parsed, sha256: sha256(bytes) };
}

async function readTemplate(templateId) {
  if (!TEMPLATE_IDS.includes(templateId)) {
    throw new ReceiptVideoError('template_invalid', `templateId must be one of: ${TEMPLATE_IDS.join(', ')}.`);
  }
  const template = JSON.parse(await fs.readFile(path.join(moduleRoot, 'templates', `${templateId}.json`), 'utf8'));
  if (template.schema !== 'agoragentic.hyperframes.template.v1' || template.id !== templateId) {
    throw new ReceiptVideoError('template_invalid', 'The selected template failed its local identity check.');
  }
  return template;
}

function sanitizeEvidence(entry, index, clean) {
  if (!entry || Array.isArray(entry) || typeof entry !== 'object') {
    throw new ReceiptVideoError('evidence_invalid', `evidence[${index}] must be an object.`);
  }
  if (!HASH_PATTERN.test(entry.sha256 || '')) {
    throw new ReceiptVideoError('evidence_hash_invalid', `evidence[${index}].sha256 must be a SHA-256 reference.`);
  }
  return {
    kind: clean(entry.kind, `evidence[${index}].kind`, 40, 'evidence'),
    ref: clean(entry.ref, `evidence[${index}].ref`, 120, `evidence:item:${index + 1}`),
    sha256: entry.sha256,
    status: clean(entry.status, `evidence[${index}].status`, 40, 'recorded'),
  };
}

function sanitizeText({ value, name, maxLength, fallback, redactions, trapCodes }) {
  const input = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  if (typeof input !== 'string') throw new ReceiptVideoError('field_invalid', `${name} must be a string.`);
  for (const [code, pattern] of INSTRUCTION_TRAPS) {
    if (pattern.test(input)) trapCodes.add(code);
  }
  let output = input;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, () => {
      redactions.secret_values += 1;
      return '[REDACTED]';
    });
  }
  for (const pattern of PRIVATE_PATH_PATTERNS) {
    output = output.replace(pattern, () => {
      redactions.private_paths += 1;
      return '[PRIVATE_PATH]';
    });
  }
  output = output.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return output.slice(0, maxLength);
}

function inspectTree(root) {
  let nodes = 0;
  let sensitiveFields = 0;
  let unknownFields = 0;
  const allowedTop = new Set(['schema', 'receipt_id', 'title', 'summary', 'status', 'created_at', 'completed_at', 'events', 'evidence']);
  const allowedEvent = new Set(['kind', 'label', 'detail', 'status', 'evidence_ref', 'at']);
  const allowedEvidence = new Set(['kind', 'ref', 'sha256', 'status']);
  const allowedByContext = { top: allowedTop, event: allowedEvent, evidence: allowedEvidence };
  const visit = (value, depth, context = null) => {
    nodes += 1;
    if (nodes > 2_000 || depth > 8) throw new ReceiptVideoError('source_shape_unbounded', 'The source JSON exceeds bounded shape limits.');
    if (Array.isArray(value)) {
      if (value.length > 32) throw new ReceiptVideoError('source_shape_unbounded', 'A source array exceeds 32 entries.');
      const itemContext = context === 'events' ? 'event' : context === 'evidence-list' ? 'evidence' : null;
      value.forEach(entry => visit(entry, depth + 1, itemContext));
      return;
    }
    if (!value || typeof value !== 'object') return;
    const allowed = allowedByContext[context] || null;
    for (const [key, child] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key)) sensitiveFields += 1;
      if (allowed && !allowed.has(key)) unknownFields += 1;
      const childContext = context === 'top' && key === 'events'
        ? 'events'
        : context === 'top' && key === 'evidence'
          ? 'evidence-list'
          : null;
      visit(child, depth + 1, childContext);
    }
  };
  visit(root, 0, 'top');
  return { sensitiveFields, unknownFields };
}

function renderTimelineHtml(timeline) {
  const duration = timeline.scenes.length;
  const scenes = timeline.scenes.map(scene => `
    <section id="scene-${scene.index + 1}" class="clip scene" data-start="${scene.start_seconds}" data-duration="${scene.duration_seconds}" data-track-index="0">
      <div class="step">STEP ${String(scene.index + 1).padStart(2, '0')} / ${String(duration).padStart(2, '0')}</div>
      <div class="kind">${escapeHtml(scene.kind.toUpperCase())}</div>
      <h2>${escapeHtml(scene.label)}</h2>
      <p>${escapeHtml(scene.detail)}</p>
      <div class="evidence"><span>${escapeHtml(scene.status)}</span><code>${escapeHtml(scene.evidence_ref)}</code></div>
    </section>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(timeline.template.title)}</title>
  <style>
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: #0b1220; }
    body { font-family: sans-serif; color: #f7f9fc; }
    #receipt-video { position: relative; width: 640px; height: 360px; overflow: hidden; background: #0b1220; }
    .brand { position: absolute; top: 24px; left: 30px; z-index: 20; font-size: 14px; font-weight: 700; color: ${timeline.template.accent}; }
    .template { position: absolute; top: 24px; right: 30px; z-index: 20; font-size: 11px; color: #a8b4c7; }
    .scene { position: absolute; inset: 0; padding: 74px 54px 38px; background: #0b1220; }
    .scene::after { content: ""; position: absolute; left: 0; bottom: 0; width: 100%; height: 7px; background: ${timeline.template.accent}; }
    .step { color: #a8b4c7; font-size: 12px; margin-bottom: 20px; }
    .kind { display: inline-block; padding: 5px 9px; border: 1px solid ${timeline.template.accent}; color: ${timeline.template.accent}; font-size: 11px; font-weight: 700; }
    h2 { margin: 16px 0 10px; max-width: 530px; font-size: 34px; line-height: 1.08; letter-spacing: 0; }
    p { margin: 0; max-width: 510px; color: #c8d1df; font-size: 18px; line-height: 1.35; letter-spacing: 0; }
    .evidence { position: absolute; left: 54px; right: 54px; bottom: 35px; display: flex; justify-content: space-between; align-items: center; color: #a8b4c7; font-size: 11px; }
    .evidence span { color: #78d09f; text-transform: uppercase; }
    .evidence code { max-width: 330px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  </style>
</head>
<body>
  <main id="receipt-video" data-composition-id="receipt-video" data-width="640" data-height="360" data-start="0" data-duration="${duration}" data-fps="10" data-no-timeline>
    <div class="brand">AGORAGENTIC / LOCAL EVIDENCE</div>
    <div class="template">${escapeHtml(timeline.template.title)}</div>${scenes}
  </main>
</body>
</html>
`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function noAuthority() {
  return {
    external_render: false,
    hosted_deploy: false,
    call_provider: false,
    publish: false,
    publish_listing: false,
    create_x402_route: false,
    spend: false,
    settle: false,
    move_funds: false,
    owner_approval_required_for_external_action: true,
  };
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function assertMp4(bytes) {
  if (bytes.length < 16 || bytes.subarray(4, 8).toString('ascii') !== 'ftyp') {
    throw new ReceiptVideoError('render_output_invalid', 'The local renderer did not produce a valid MP4 container.');
  }
}

function requireArray(value, name, min, max) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new ReceiptVideoError('field_invalid', `${name} must contain between ${min} and ${max} entries.`);
  }
  return value;
}

function requiredString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new ReceiptVideoError('invalid_argument', `${name} is required.`);
  return value;
}

function assertIsoTimestamp(value) {
  const parsed = typeof value === 'string' ? new Date(value) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new ReceiptVideoError('created_at_invalid', 'createdAt must be an ISO timestamp.');
  }
}

async function assertOutputAbsent(outputRoot) {
  const stat = await fs.lstat(outputRoot).catch(error => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (stat) throw new ReceiptVideoError('output_exists', 'The output directory already exists; choose a new path.');
}
