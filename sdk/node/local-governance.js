'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const POLICY_SCHEMA = 'agoragentic.local-governance-policy.v1';
const RECEIPT_SCHEMA = 'agoragentic.local-action-receipt.v1';
const DEFAULT_POLICY_FILE = 'agoragentic.yaml';
const DECISIONS = new Set(['allow', 'ask', 'deny']);

const ADAPTERS = Object.freeze([
    {
        id: 'process',
        label: 'Local subprocess',
        markers: [],
        integration_level: 'pre_action_enforcement',
        proof_class: 'local_process_evidence',
        boundary: 'Only the directly spawned process is governed; descendants and provider-side effects are not intercepted.',
    },
    {
        id: 'mcp',
        label: 'MCP host',
        markers: ['.mcp.json', 'mcp.json', '.cursor/mcp.json'],
        integration_level: 'manifest_mapping',
        proof_class: 'configuration_presence',
        boundary: 'Configuration detection only; generic MCP tool calls are not intercepted by this CLI.',
    },
    {
        id: 'claude-code',
        label: 'Claude Code',
        markers: ['.claude/settings.json', '.claude/settings.local.json'],
        integration_level: 'manifest_mapping',
        proof_class: 'configuration_presence',
        boundary: 'Host configuration detection only; use a reviewed host hook or Harness adapter for in-path enforcement.',
    },
    {
        id: 'opencode',
        label: 'OpenCode',
        markers: ['opencode.json', 'opencode.jsonc', '.opencode'],
        integration_level: 'manifest_mapping',
        proof_class: 'configuration_presence',
        boundary: 'Host configuration detection only; plugin activation and live interception remain separate evidence.',
    },
    {
        id: 'node',
        label: 'Node.js project',
        markers: ['package.json'],
        integration_level: 'framework_mapping',
        proof_class: 'project_marker',
        boundary: 'Project detection only; wrap a specific tool or use the governed subprocess command for enforcement.',
    },
    {
        id: 'python',
        label: 'Python project',
        markers: ['pyproject.toml', 'requirements.txt', 'setup.py'],
        integration_level: 'framework_mapping',
        proof_class: 'project_marker',
        boundary: 'Project detection only; Python in-process governance is a separate adapter surface.',
    },
]);

function createDefaultPolicy() {
    return {
        schema: POLICY_SCHEMA,
        default_decision: 'ask',
        receipts: {
            enabled: true,
            directory: '.agoragentic/receipts',
        },
        actions: {
            'process.run': {
                decision: 'ask',
                approval: 'explicit_cli_yes',
            },
        },
        authority: {
            spend: 'owner_only',
            retry: 'owner_only',
        },
    };
}

function detectAdapters(cwd = process.cwd(), fsImpl = fs) {
    const root = path.resolve(cwd);
    return ADAPTERS.map((adapter) => {
        const evidence = adapter.markers.filter((marker) => fsImpl.existsSync(path.join(root, marker)));
        return {
            id: adapter.id,
            label: adapter.label,
            detected: adapter.id === 'process' || evidence.length > 0,
            evidence,
            integration_level: adapter.integration_level,
            proof_class: adapter.proof_class,
            boundary: adapter.boundary,
        };
    });
}

function initializeProject(options = {}) {
    const cwd = path.resolve(options.cwd || process.cwd());
    const policyPath = resolveProjectPath(cwd, options.policyPath || DEFAULT_POLICY_FILE, 'policy');
    const exists = fs.existsSync(policyPath);
    const proposal = {
        schema: 'agoragentic.init-plan.v1',
        cwd_digest: digest(path.basename(cwd)),
        policy_path: relativeDisplayPath(cwd, policyPath),
        detected_adapters: detectAdapters(cwd).filter((adapter) => adapter.detected),
        proposed_policy: createDefaultPolicy(),
        writes_require_confirmation: true,
    };

    if (!options.write) {
        return { ...proposal, status: exists ? 'existing_policy_detected' : 'planned', written: false };
    }
    if (exists && !options.force) {
        throw governanceError('policy_exists', `Refusing to overwrite ${proposal.policy_path}; add --force with --yes to replace it.`, 2);
    }

    fs.mkdirSync(path.dirname(policyPath), { recursive: true });
    fs.writeFileSync(policyPath, `${JSON.stringify(createDefaultPolicy(), null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: options.force ? 'w' : 'wx',
    });
    return { ...proposal, status: exists ? 'replaced' : 'created', written: true };
}

function loadPolicy(policy = DEFAULT_POLICY_FILE, options = {}) {
    if (policy && typeof policy === 'object' && !Array.isArray(policy)) {
        return validatePolicy(policy);
    }
    const cwd = path.resolve(options.cwd || process.cwd());
    const policyPath = resolveProjectPath(cwd, policy || DEFAULT_POLICY_FILE, 'policy');
    if (!fs.existsSync(policyPath)) {
        throw governanceError('policy_missing', `No local governance policy found at ${relativeDisplayPath(cwd, policyPath)}. Run "agoragentic init --yes" first.`, 2);
    }
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
    } catch (err) {
        throw governanceError('policy_invalid', `Policy must use JSON-compatible YAML: ${err.message}`, 2);
    }
    return validatePolicy(parsed);
}

function validatePolicy(policy) {
    if (!policy || policy.schema !== POLICY_SCHEMA) {
        throw governanceError('policy_invalid', `Policy schema must be ${POLICY_SCHEMA}.`, 2);
    }
    validateDecision(policy.default_decision, 'default_decision');
    if (!policy.actions || typeof policy.actions !== 'object' || Array.isArray(policy.actions)) {
        throw governanceError('policy_invalid', 'Policy actions must be an object.', 2);
    }
    for (const [action, rule] of Object.entries(policy.actions)) {
        normalizeAction(action);
        if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
            throw governanceError('policy_invalid', `Policy rule for ${action} must be an object.`, 2);
        }
        validateDecision(rule.decision, `actions.${action}.decision`);
    }
    if (policy.receipts !== undefined) {
        if (!policy.receipts || typeof policy.receipts !== 'object' || Array.isArray(policy.receipts)) {
            throw governanceError('policy_invalid', 'Policy receipts must be an object.', 2);
        }
        if (policy.receipts.enabled !== undefined && typeof policy.receipts.enabled !== 'boolean') {
            throw governanceError('policy_invalid', 'receipts.enabled must be a boolean.', 2);
        }
        if (policy.receipts.directory !== undefined && (typeof policy.receipts.directory !== 'string' || !policy.receipts.directory.trim())) {
            throw governanceError('policy_invalid', 'receipts.directory must be a non-empty string.', 2);
        }
    }
    if (policy.authority?.spend !== undefined && policy.authority.spend !== 'owner_only') {
        throw governanceError('policy_invalid', 'authority.spend must remain owner_only.', 2);
    }
    if (policy.authority?.retry !== undefined && policy.authority.retry !== 'owner_only') {
        throw governanceError('policy_invalid', 'authority.retry must remain owner_only.', 2);
    }
    return policy;
}

function evaluatePolicy(policy, action, options = {}) {
    const normalizedAction = normalizeAction(action);
    const validated = validatePolicy(policy);
    const rule = validated.actions[normalizedAction] || validated.actions['*'] || {};
    const decision = rule.decision || validated.default_decision;
    const approved = options.approved === true;
    return {
        action: normalizedAction,
        decision,
        approval_required: decision === 'ask',
        approval_granted: decision === 'ask' ? approved : null,
        execute: decision === 'allow' || (decision === 'ask' && approved),
        reason: decision === 'deny'
            ? 'policy_denied'
            : (decision === 'ask' && !approved ? 'explicit_approval_required' : 'policy_boundary_passed'),
        authority: {
            spend: validated.authority?.spend || 'owner_only',
            retry: validated.authority?.retry || 'owner_only',
        },
    };
}

function govern(tool, options = {}) {
    if (typeof tool !== 'function') {
        throw new TypeError('govern(tool, options) requires a function.');
    }
    const action = normalizeAction(options.action);
    return async function governedTool(...args) {
        const cwd = path.resolve(options.cwd || process.cwd());
        const loadedPolicy = loadPolicy(options.policy || DEFAULT_POLICY_FILE, { cwd });
        const policy = options.receipts === undefined
            ? loadedPolicy
            : { ...loadedPolicy, receipts: { ...(loadedPolicy.receipts || {}), enabled: options.receipts === true } };
        prepareReceiptDirectory(policy, cwd);
        let approved = options.approved === true;
        const initial = evaluatePolicy(policy, action, { approved });
        if (initial.decision === 'ask' && !approved && typeof options.approve === 'function') {
            approved = await options.approve({ action, argument_count: args.length }) === true;
        }
        const decision = evaluatePolicy(policy, action, { approved });
        const startedAt = nowIso(options);
        if (!decision.execute) {
            const receipt = writeReceipt(policy, cwd, buildReceipt({
                options,
                action,
                classification: 'local_tool_evidence',
                decision,
                startedAt,
                finishedAt: startedAt,
                outcome: 'not_executed',
                evidence: { argument_count: args.length },
            }));
            throw governanceError(decision.reason, `Action ${action} was not executed: ${decision.reason}.`, 3, { receipt });
        }

        try {
            const result = await tool(...args);
            const finishedAt = nowIso(options);
            const evidence = typeof options.evidence === 'function'
                ? summarizeEvidence(await options.evidence(result))
                : summarizeEvidence(result);
            const receipt = writeReceipt(policy, cwd, buildReceipt({
                options,
                action,
                classification: 'local_tool_evidence',
                decision,
                startedAt,
                finishedAt,
                outcome: 'completed',
                evidence: { argument_count: args.length, result: evidence },
            }));
            if (typeof options.onReceipt === 'function') await options.onReceipt(receipt);
            return result;
        } catch (err) {
            const finishedAt = nowIso(options);
            const receipt = writeReceipt(policy, cwd, buildReceipt({
                options,
                action,
                classification: 'local_tool_evidence',
                decision,
                startedAt,
                finishedAt,
                outcome: 'failed',
                evidence: { argument_count: args.length, error_code: safeErrorCode(err) },
            }));
            err.agoragenticReceipt = receipt;
            throw err;
        }
    };
}

async function runGovernedCommand(executable, args = [], options = {}) {
    if (!executable || typeof executable !== 'string') {
        throw governanceError('command_missing', 'A command is required after "agoragentic run --".', 2);
    }
    const cwd = path.resolve(options.cwd || process.cwd());
    const policy = loadPolicy(options.policy || DEFAULT_POLICY_FILE, { cwd });
    prepareReceiptDirectory(policy, cwd);
    const decision = evaluatePolicy(policy, 'process.run', { approved: options.approved === true });
    const startedAt = nowIso(options);
    const shape = {
        executable: path.basename(executable),
        argument_count: args.length,
        command_shape_digest: digest(JSON.stringify([path.basename(executable), args.length])),
        cwd_digest: digest(path.basename(cwd)),
    };

    if (!decision.execute) {
        const receipt = writeReceipt(policy, cwd, buildReceipt({
            options,
            action: 'process.run',
            classification: 'local_process_evidence',
            decision,
            startedAt,
            finishedAt: startedAt,
            outcome: 'not_executed',
            evidence: shape,
        }));
        throw governanceError(decision.reason, `Command was not executed: ${decision.reason}.`, 3, { receipt });
    }

    const processResult = await waitForProcess(options.spawn || spawn, executable, args, {
        cwd,
        env: options.env || process.env,
        stdio: options.stdio || 'inherit',
        shell: false,
        windowsHide: true,
    });
    const finishedAt = nowIso(options);
    const receipt = writeReceipt(policy, cwd, buildReceipt({
        options,
        action: 'process.run',
        classification: 'local_process_evidence',
        decision,
        startedAt,
        finishedAt,
        outcome: processResult.error ? 'failed_to_start' : (processResult.exit_code === 0 ? 'completed' : 'failed'),
        evidence: {
            ...shape,
            exit_code: processResult.exit_code,
            signal: processResult.signal,
            error_code: processResult.error ? safeErrorCode(processResult.error) : null,
        },
    }));
    return { ...processResult, receipt };
}

function buildReceipt({ options, action, classification, decision, startedAt, finishedAt, outcome, evidence }) {
    const randomUUID = options.randomUUID || crypto.randomUUID;
    const id = `alr_${randomUUID().replace(/-/g, '')}`;
    return {
        schema: RECEIPT_SCHEMA,
        receipt_id: id,
        classification,
        action,
        decision,
        outcome,
        started_at: startedAt,
        finished_at: finishedAt,
        evidence,
        proof_scope: {
            local_boundary: true,
            host_execution: false,
            provider_execution: false,
            deployment: false,
            payment: false,
            settlement: false,
            on_chain_verification: false,
        },
    };
}

function writeReceipt(policy, cwd, receipt) {
    if (policy.receipts?.enabled === false) return null;
    const directory = prepareReceiptDirectory(policy, cwd);
    const receiptPath = path.join(directory, `${receipt.receipt_id}.json`);
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return { ...receipt, path: relativeDisplayPath(cwd, receiptPath) };
}

function prepareReceiptDirectory(policy, cwd) {
    if (policy.receipts?.enabled === false) return null;
    const directory = resolveProjectPath(cwd, policy.receipts?.directory || '.agoragentic/receipts', 'receipt directory');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    return directory;
}

function waitForProcess(spawnProcess, executable, args, options) {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawnProcess(executable, args, options);
        } catch (error) {
            resolve({ exit_code: null, signal: null, error });
            return;
        }
        child.once('error', (error) => resolve({ exit_code: null, signal: null, error }));
        child.once('exit', (code, signal) => resolve({ exit_code: code, signal: signal || null, error: null }));
    });
}

function summarizeEvidence(value) {
    if (value === null || value === undefined) return { type: String(value) };
    if (Array.isArray(value)) return { type: 'array', length: value.length };
    if (typeof value === 'object') return { type: 'object', keys: Object.keys(value).sort().slice(0, 32) };
    return { type: typeof value };
}

function normalizeAction(action) {
    const normalized = String(action || '').trim().toLowerCase();
    if (!/^(?:\*|[a-z0-9][a-z0-9._:-]{0,127})$/.test(normalized)) {
        throw governanceError('action_invalid', 'Action must use lowercase letters, numbers, dots, underscores, colons, or dashes.', 2);
    }
    return normalized;
}

function validateDecision(value, label) {
    if (!DECISIONS.has(value)) {
        throw governanceError('policy_invalid', `${label} must be allow, ask, or deny.`, 2);
    }
}

function resolveProjectPath(cwd, target, label) {
    const resolved = path.resolve(cwd, target);
    const relative = path.relative(cwd, resolved);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw governanceError('path_outside_project', `${label} must stay inside the current project.`, 2);
    }
    const realRoot = fs.realpathSync(cwd);
    let existingAncestor = resolved;
    while (!fs.existsSync(existingAncestor)) {
        const parent = path.dirname(existingAncestor);
        if (parent === existingAncestor) break;
        existingAncestor = parent;
    }
    const realAncestor = fs.realpathSync(existingAncestor);
    const realRelative = path.relative(realRoot, realAncestor);
    if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
        throw governanceError('path_outside_project', `${label} resolves outside the current project.`, 2);
    }
    return resolved;
}

function relativeDisplayPath(cwd, target) {
    const relative = path.relative(cwd, target) || '.';
    return relative.split(path.sep).join('/');
}

function digest(value) {
    return `sha256:${crypto.createHash('sha256').update(String(value)).digest('hex')}`;
}

function nowIso(options) {
    const now = options.now ? options.now() : new Date();
    return (now instanceof Date ? now : new Date(now)).toISOString();
}

function safeErrorCode(err) {
    return typeof err?.code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(err.code) ? err.code : 'error';
}

function governanceError(code, message, exitCode = 1, response) {
    const err = new Error(message);
    err.code = code;
    err.exitCode = exitCode;
    if (response) err.response = response;
    return err;
}

module.exports = {
    POLICY_SCHEMA,
    RECEIPT_SCHEMA,
    DEFAULT_POLICY_FILE,
    createDefaultPolicy,
    detectAdapters,
    initializeProject,
    loadPolicy,
    evaluatePolicy,
    govern,
    runGovernedCommand,
};
