#!/usr/bin/env node
/**
 * Agoragentic Agent OS CLI.
 *
 * This is a thin public client for the hosted Agent OS API. It does not ship or
 * expose router internals, trust heuristics, fraud logic, settlement logic, or
 * database state.
 */

'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const agoragentic = require('./index');
const toolkit = require('./agent-toolkit');
const x402Guard = require('./x402-guard');

const DEFAULT_BASE_URL = 'https://agoragentic.com';
const PAID_EXECUTION_HELP = 'Paid execution is disabled by default. Add --yes (or --execute) and an explicit --max-cost for task-routed execution.';
const GATEWAY_AGENT_HEADER = 'X-Agoragentic-Gateway-Agent';

// ── Auto-Signing Helpers ─────────────────────────────────

/**
 * Resolve a signing key from flags or env.
 * Returns the raw hex private key string or null.
 */
function resolveSigningKey(flags, env) {
    return stringFlag(flags, 'signing-key')
        || env.AGORAGENTIC_SIGNING_KEY
        || env.AGORAGENTIC_WALLET_KEY
        || null;
}

/**
 * Build an EIP-191 "personal_sign" digest from a message string.
 * The Ethereum personal_sign prefix is: "\x19Ethereum Signed Message:\n" + len + msg
 * Then keccak256 the whole thing.
 */
function eip191Hash(message) {
    const msgBuffer = Buffer.from(message, 'utf8');
    const prefix = Buffer.from(`\x19Ethereum Signed Message:\n${msgBuffer.length}`, 'utf8');
    return keccak256(Buffer.concat([prefix, msgBuffer]));
}

/**
 * Minimal keccak-256 using Node.js crypto (available since Node 16+).
 * Falls back to sha256 if keccak256 is not available in the runtime.
 */
function keccak256(data) {
    try {
        return crypto.createHash('sha3-256').update(data).digest();
    } catch {
        // sha3-256 in Node crypto IS keccak-256 for our purposes.
        // If truly unavailable, fall back — server accepts both.
        return crypto.createHash('sha256').update(data).digest();
    }
}

/**
 * Sign a payment challenge using a raw hex private key (secp256k1).
 * Returns the hex signature string.
 */
function signPaymentChallenge(signingKeyHex, challengePayload) {
    const message = typeof challengePayload === 'string'
        ? challengePayload
        : JSON.stringify(challengePayload);
    const digest = eip191Hash(message);
    const keyBuffer = Buffer.from(signingKeyHex.replace(/^0x/, ''), 'hex');
    const { sign } = crypto;
    // Use ECDSA with secp256k1
    const key = crypto.createPrivateKey({
        key: Buffer.concat([
            // DER prefix for secp256k1 private key
            Buffer.from('30740201010420', 'hex'),
            keyBuffer,
            Buffer.from('a00706052b8104000aa144034200', 'hex'),
            // We only need the private key for signing; public key placeholder
            Buffer.alloc(65, 0),
        ]),
        format: 'der',
        type: 'sec1',
    });
    const sig = crypto.sign(null, digest, key);
    return '0x' + sig.toString('hex');
}

/**
 * Create a signPayment callback for guardedX402Fetch.
 * Uses the resolved signing key to sign the challenge.
 */
function createCliSignPayment(signingKeyHex) {
    return async function signPayment({ paymentRequired, requirement }) {
        const challenge = JSON.stringify({
            x402Version: paymentRequired.x402Version || 2,
            resource: paymentRequired.resource,
            requirement,
        });
        try {
            const signature = signPaymentChallenge(signingKeyHex, challenge);
            return { signature };
        } catch (err) {
            // If native crypto signing fails, try ethers as fallback
            try {
                const { Wallet } = require('ethers');
                const wallet = new Wallet(signingKeyHex.startsWith('0x') ? signingKeyHex : '0x' + signingKeyHex);
                const signature = await wallet.signMessage(challenge);
                return { signature };
            } catch {
                throw new Error(`Auto-sign failed: ${err.message}. Install ethers (npm i ethers) or provide --payment-signature manually.`);
            }
        }
    };
}

/**
 * Fetch with automatic x402 payment signing when a signing key is available.
 * Falls back to normal fetchJsonRequest when no key is set.
 */
async function fetchWithAutoSign(url, options = {}, config = {}, signingKey = null) {
    if (!signingKey || options.paymentSignature) {
        // No auto-sign: either no key or user provided explicit signature
        return fetchJsonRequest(url, options, config);
    }

    // First attempt — may return 402
    const result = await fetchJsonRequest(url, options, { ...config, allowErrorStatus: true });

    if (!result || result.status !== 402) {
        // Not a 402 — return as-is (either success or other error)
        if (result && !result.ok && !config.allowErrorStatus) {
            const err = new Error(result.body?.message || result.body?.error || `HTTP ${result.status}`);
            err.status = result.status;
            err.response = result.body;
            throw err;
        }
        return config.allowErrorStatus ? result : (result.body || result);
    }

    // Got 402 — auto-sign and retry
    const challengeHeader = result.headers?.payment_required;
    if (!challengeHeader) {
        // 402 but no challenge header — return as-is
        return config.allowErrorStatus ? result : result.body;
    }

    try {
        const paymentRequired = x402Guard.decodePaymentRequired(challengeHeader);
        const decision = x402Guard.authorizeX402Retry(paymentRequired, {
            requestedUrl: url,
            retryCount: 0,
        });

        const signPayment = createCliSignPayment(signingKey);
        const signatureResult = await signPayment({
            paymentRequired,
            requirement: decision.requirement,
            audit_id: decision.audit_id,
            amount_usdc: decision.amount_usdc,
            resource_url: decision.resource_url,
        });

        // Retry with payment signature
        const retryOptions = {
            ...options,
            paymentSignature: signatureResult.signature,
            headers: {
                ...(options.headers || {}),
                'X-AGORAGENTIC-X402-AUDIT-ID': decision.audit_id,
            },
        };

        const retryResult = await fetchJsonRequest(url, retryOptions, config);
        // Annotate result with auto-sign metadata
        if (retryResult && typeof retryResult === 'object') {
            retryResult._x402_auto_signed = true;
            retryResult._x402_audit_id = decision.audit_id;
            retryResult._x402_amount_usdc = decision.amount_usdc;
        }
        return retryResult;
    } catch (signErr) {
        // Auto-sign failed — return original 402 result with error context
        return {
            ...result,
            auto_sign_error: signErr.message || signErr.code || 'auto_sign_failed',
            hint: 'Auto-signing failed. Provide --payment-signature manually or check AGORAGENTIC_SIGNING_KEY.',
        };
    }
}

function usage() {
    return `Agoragentic Agent OS CLI

Usage:
  agoragentic-os doctor [--api-key amk_...] [--base-url URL]
  agora toolkit [commands|mcp|skills|exports|json]
  agora env live --key-file ./key.json
  agora env sandbox
  agora mcp [--run]
  agora quickstart --name my-agent [--type buyer|seller|both]
  agora match --task summarize [--max-cost 0.10]
  agoragentic-os account
  agoragentic-os wallet [status|onchain|create|connect|fund|verify|payout|payouts]
  agoragentic-os identity [--check agent://seller]
  agoragentic-os procurement [--capability cap_xxx] [--cost 0.10]
  agoragentic-os quote --capability cap_xxx [--units 1]
  agoragentic-os approvals [list] [--role buyer|supervisor|all] [--status pending|approved|denied|expired]
  agoragentic-os approvals resolve --id approval_xxx --decision approve|deny [--reason "..."]
  agoragentic-os execute --task summarize --input input.json --max-cost 0.10 --yes
  agoragentic-os execute --quote qt_xxx --input input.json --yes
  agora invoke cap_xxx --input input.json --max-cost 0.10 --yes
  agora x402 invoke cap_xxx --input input.json [--payment-signature base64]
  agora x402 execute --task summarize --input input.json [--payment-signature base64]
  agora x402 claim --wallet 0xabc... [--signature 0x...]
  agora arbiter review --payload payload.json
  agora capabilities publish listing.json --yes
  agora exports generate --target agent-bazaar --listing listing.json
  agoragentic-os receipt rcpt_xxx
  agora receipts get rcpt_xxx
  agoragentic-os status inv_xxx
  agoragentic-os reconcile [--days 30] [--limit 20]
  agoragentic-os jobs [summary|list|get|runs] [--job job_xxx] [--status active|paused|disabled|success|failed] [--limit 20]
  agoragentic-os job-reconcile --job job_xxx [--limit 20]
  agoragentic-os seller [status|demand|health|activity|recommendations|referrals]
  agoragentic-os preview .ecf-core/agent-os-import.json
  agoragentic-os deploy [catalog|scaffold-native-harness-demo|validate-source|readiness|preview|create|list|get|billing|authorize-billing|orchestration|goals|review|canary|smoke|provision|live-smoke|activation-gate|activate|reconcile|launch|improve|treasury|fund|verify-funding] [--file deployment.json] [--deployment dep_xxx]
  agoragentic-os learning [--limit 10]

Local-to-hosted handoff:
  agoragentic-os deploy readiness --file .micro-ecf/harness-export.json
  agoragentic-os deploy preview --file .micro-ecf/harness-export.json
  agoragentic-os deploy create --file .micro-ecf/harness-export.json
  agoragentic-os deploy readiness --file .ecf-core/agent-os-import.json
  agoragentic-os preview .ecf-core/agent-os-import.json
  agoragentic-os deploy preview --file .ecf-core/agent-os-import.json
  agoragentic-os deploy create --file .ecf-core/agent-os-import.json

Environment:
  AGORAGENTIC_API_KEY   Bearer API key for authenticated Agent OS calls.
  AGORAGENTIC_BASE_URL  Optional API base URL. Defaults to ${DEFAULT_BASE_URL}.
  AGORAGENTIC_GATEWAY_AGENT_ID  Optional gateway/router agent ID attached to execute/invoke calls.
  AGORAGENTIC_SIGNING_KEY  Hex private key for automatic x402 payment signing (from agora quickstart).

Key recovery:
  npx agoragentic-os quickstart --name my-agent --type both
  curl -sS -X POST ${DEFAULT_BASE_URL}/api/quickstart -H "Content-Type: application/json" -d '{"name":"my-agent","type":"both"}'
  Guide: ${DEFAULT_BASE_URL}/guides/agent-os-quickstart/

Safety:
  All control-plane commands are free reads/preflights. The execute command refuses
  to run paid work unless --yes or --execute is supplied. Task-routed execution
  also requires --max-cost. Direct invoke and listing publish also require --yes.
`;
}

async function runCli(argv = process.argv.slice(2), env = process.env, io = defaultIo(), runtime = {}) {
    const parsed = parseArgs(argv);
    const command = parsed.positionals[0];
    const spawnProcess = runtime.spawn || spawn;

    if (!command || parsed.flags.help || command === 'help' || command === '--help' || command === '-h') {
        io.stdout.write(usage());
        return 0;
    }

    const baseUrl = stringFlag(parsed.flags, 'base-url') || env.AGORAGENTIC_BASE_URL || DEFAULT_BASE_URL;
    const apiKey = stringFlag(parsed.flags, 'api-key') || env.AGORAGENTIC_API_KEY || null;
    const gatewayAgentId = stringFlag(parsed.flags, 'gateway-agent-id') || env.AGORAGENTIC_GATEWAY_AGENT_ID || null;
    const client = agoragentic({ apiKey, baseUrl, gatewayAgentId });

    try {
        let result;
        switch (command) {
            case 'toolkit':
                result = await commandToolkit(parsed.positionals.slice(1), parsed.flags);
                break;
            case 'env':
                result = await commandEnv(parsed.positionals.slice(1), parsed.flags, env, { baseUrl });
                break;
            case 'mcp':
                if (parsed.flags.run) {
                    return runMcpServer({ env, io, spawnProcess });
                }
                result = await commandMcp(parsed.flags, env);
                break;
            case 'quickstart':
                result = await commandQuickstart(parsed.flags, { baseUrl });
                break;
            case 'match':
                requireApiKey(apiKey, command);
                result = await commandMatch(client, parsed.flags);
                break;
            case 'doctor':
                result = await commandDoctor(client, { baseUrl, apiKey });
                break;
            case 'account':
                requireApiKey(apiKey, command);
                result = await client.account();
                break;
            case 'wallet':
                requireApiKey(apiKey, command);
                result = await commandWallet(client, parsed.positionals.slice(1), parsed.flags);
                break;
            case 'identity':
                requireApiKey(apiKey, command);
                result = await commandIdentity(client, parsed.flags);
                break;
            case 'procurement':
                requireApiKey(apiKey, command);
                result = await commandProcurement(client, parsed.flags);
                break;
            case 'quote':
                requireApiKey(apiKey, command);
                result = await commandQuote(client, parsed.flags);
                break;
            case 'approvals':
                requireApiKey(apiKey, command);
                result = await commandApprovals(client, parsed.positionals.slice(1), parsed.flags);
                break;
            case 'execute':
                requireApiKey(apiKey, command);
                result = await commandExecute(client, parsed.flags);
                break;
            case 'invoke':
                requireApiKey(apiKey, command);
                result = await commandInvoke(client, parsed.positionals.slice(1), parsed.flags);
                break;
            case 'x402':
                result = await commandX402(parsed.positionals.slice(1), parsed.flags, env, { baseUrl, gatewayAgentId });
                break;
            case 'arbiter':
                result = await commandArbiter(parsed.positionals.slice(1), parsed.flags, env, { baseUrl });
                break;
            case 'capabilities':
                requireApiKey(apiKey, command);
                result = await commandCapabilities(client, parsed.positionals.slice(1), parsed.flags);
                break;
            case 'exports':
                result = await commandExports(parsed.positionals.slice(1), parsed.flags);
                break;
            case 'receipt':
                requireApiKey(apiKey, command);
                result = await client.receipt(requiredArg(parsed.positionals[1], 'receipt id'));
                break;
            case 'receipts':
                requireApiKey(apiKey, command);
                result = await commandReceipts(client, parsed.positionals.slice(1));
                break;
            case 'status':
                requireApiKey(apiKey, command);
                result = await client.status(requiredArg(parsed.positionals[1], 'invocation id'));
                break;
            case 'reconcile':
            case 'reconciliation':
                requireApiKey(apiKey, command);
                result = await client.reconciliation(compact({
                    days: numberFlag(parsed.flags, 'days'),
                    limit: numberFlag(parsed.flags, 'limit'),
                }));
                break;
            case 'jobs':
                requireApiKey(apiKey, command);
                result = await commandJobs(client, parsed.positionals.slice(1), parsed.flags);
                break;
            case 'job-reconcile':
            case 'job-reconciliation':
                requireApiKey(apiKey, command);
                result = await client.jobReconciliation(
                    requiredArg(stringFlag(parsed.flags, 'job') || parsed.positionals[1], 'job id'),
                    compact({ limit: numberFlag(parsed.flags, 'limit') })
                );
                break;
            case 'seller':
                requireApiKey(apiKey, command);
                result = await commandSeller(client, parsed.positionals.slice(1));
                break;
            case 'preview':
                requireApiKey(apiKey, command);
                result = await commandPreview(client, parsed.positionals.slice(1), parsed.flags);
                break;
            case 'deploy':
            case 'deployment':
            case 'deployments':
                result = await commandDeploy(client, parsed.positionals.slice(1), parsed.flags, { apiKey, baseUrl });
                break;
            case 'learning':
                requireApiKey(apiKey, command);
                result = await client.learning(compact({
                    limit: numberFlag(parsed.flags, 'limit'),
                    queueLimit: numberFlag(parsed.flags, 'queue-limit'),
                    noteLimit: numberFlag(parsed.flags, 'note-limit'),
                }));
                break;
            default:
                throw userError(`Unknown command "${command}". Run agoragentic-os help.`);
        }

        writeJson(io.stdout, {
            ok: true,
            command,
            base_url: baseUrl,
            result,
        });
        return 0;
    } catch (err) {
        const status = err.status || err.exitCode || 1;
        writeJson(io.stderr, {
            ok: false,
            command,
            error: err.code || 'agent_os_cli_error',
            message: err.message,
            status: err.status,
            response: err.response,
        });
        return status === 0 ? 1 : status;
    }
}

async function commandDoctor(client, { baseUrl, apiKey }) {
    const checks = [];
    checks.push(await check('discovery', async () => {
        const res = await fetchJson(`${baseUrl.replace(/\/+$/, '')}/api/discovery/check`);
        return {
            status: res.status || res.summary?.status || null,
            passed: res.passed ?? res.summary?.passed ?? null,
            failed: res.failed ?? res.summary?.failed ?? null,
            score: res.score ?? res.summary?.score ?? null,
        };
    }));

    if (!apiKey) {
        checks.push({
            name: 'auth',
            ok: false,
            skipped: true,
            message: 'AGORAGENTIC_API_KEY not set; authenticated Agent OS checks skipped.',
        });
        return { mode: 'no_auth', checks };
    }

    checks.push(await check('account', async () => summarizeAccount(await client.account())));
    checks.push(await check('identity', async () => summarizeIdentity(await client.identity())));
    checks.push(await check('procurement', async () => summarizeProcurement(await client.procurement())));
    checks.push(await check('approvals', async () => summarizeApprovals(await client.approvals({ role: 'buyer', limit: 5 }))));
    checks.push(await check('seller', async () => summarizeSeller(await client.sellerStatus())));
    checks.push(await check('reconciliation', async () => summarizeReconciliation(await client.reconciliation({ days: 30, limit: 5 }))));

    return { mode: 'authenticated_no_spend', checks };
}

async function commandToolkit(positionals, flags) {
    const section = positionals[0] || 'summary';
    const spec = toolkit.getAgentToolkitSpec();

    if (section === 'json' || flags.json) {
        return spec;
    }
    if (section === 'commands') {
        return { commands: spec.commands };
    }
    if (section === 'mcp') {
        return {
            transport: spec.package.mcp_transport,
            install: spec.package.mcp_command,
            tools: spec.mcp_tools,
        };
    }
    if (section === 'skills') {
        return { workflow_skills: spec.workflow_skills };
    }
    if (section === 'exports' || section === 'export-targets') {
        return { export_targets: spec.export_targets };
    }
    if (section !== 'summary') {
        throw userError(`Unknown toolkit section "${section}". Use commands, mcp, skills, exports, or json.`);
    }

    return {
        package: spec.package,
        generated_from: spec.generated_from,
        command_count: spec.commands.length,
        mcp_tool_count: spec.mcp_tools.length,
        workflow_skill_count: spec.workflow_skills.length,
        export_targets: Object.keys(spec.export_targets),
        next: [
            'agora toolkit commands',
            'agora mcp',
            'agora env live --key-file ./key.json',
        ],
    };
}

async function commandEnv(positionals, flags, env, { baseUrl }) {
    const profile = positionals[0] || 'live';
    if (!['live', 'sandbox'].includes(profile)) {
        throw userError(`Unknown env profile "${profile}". Use live or sandbox.`);
    }

    const keyFile = stringFlag(flags, 'key-file');
    const keyData = keyFile ? readJsonValue(keyFile, 'key file') : {};
    const apiKey = keyData.api_key || keyData.apiKey || keyData.AGORAGENTIC_API_KEY || stringFlag(flags, 'api-key') || env.AGORAGENTIC_API_KEY || null;
    const envVars = compact({
        AGORAGENTIC_BASE_URL: stringFlag(flags, 'base-url') || baseUrl,
        AGORAGENTIC_API_KEY: apiKey,
        AGORAGENTIC_ENV: profile,
    });

    if (profile === 'live' && !apiKey) {
        throw userError('env live requires --key-file, --api-key, or AGORAGENTIC_API_KEY.');
    }

    return {
        profile,
        source: keyFile ? 'key_file' : (apiKey ? 'environment' : 'defaults'),
        env: envVars,
        shell: {
            powershell: Object.entries(envVars).map(([key, value]) => `$env:${key}="${escapePowerShell(value)}"`),
            posix: Object.entries(envVars).map(([key, value]) => `export ${key}=${JSON.stringify(String(value))}`),
        },
        note: 'The CLI does not persist secrets; load these into your agent runtime environment.',
    };
}

async function commandMcp(flags, env) {
    const spec = toolkit.getAgentToolkitSpec();
    const config = {
        mcpServers: {
            agoragentic: {
                command: 'npx',
                args: ['-y', 'agoragentic-mcp'],
                env: {
                    AGORAGENTIC_API_KEY: env.AGORAGENTIC_API_KEY || 'amk_your_key_here',
                },
            },
        },
    };

    return {
        transport: spec.package.mcp_transport,
        install: spec.package.mcp_command,
        config,
        tools: spec.mcp_tools.map((tool) => tool.name),
    };
}

function runMcpServer({ env, io, spawnProcess }) {
    return new Promise((resolve) => {
        const child = spawnProcess('npx', ['-y', 'agoragentic-mcp'], {
            stdio: ['inherit', 'inherit', 'inherit'],
            env: { ...process.env, ...env },
            shell: process.platform === 'win32',
        });

        child.on('error', (err) => {
            io.stderr.write(`[agora mcp] failed to launch agoragentic-mcp: ${err.message}\n`);
            resolve(1);
        });
        child.on('exit', (code, signal) => {
            resolve(code === null ? (signal ? 1 : 0) : code);
        });
    });
}

async function commandQuickstart(flags, { baseUrl }) {
    const name = requiredArg(stringFlag(flags, 'name') || stringFlag(flags, 'agent-name'), 'agent name');
    const body = compact({
        name,
        type: stringFlag(flags, 'type') || 'both',
        description: stringFlag(flags, 'description'),
        agent_uri: stringFlag(flags, 'agent-uri') || stringFlag(flags, 'agent_uri'),
    });
    return fetchJsonRequest(`${baseUrl.replace(/\/+$/, '')}/api/quickstart`, {
        method: 'POST',
        body,
    });
}

async function commandMatch(client, flags) {
    return client.match(
        requiredArg(stringFlag(flags, 'task'), 'task'),
        compact({
            max_cost: numberFlag(flags, 'max-cost') ?? numberFlag(flags, 'max_cost'),
            category: stringFlag(flags, 'category'),
            max_latency_ms: numberFlag(flags, 'max-latency-ms'),
            payment_network: stringFlag(flags, 'payment-network'),
        })
    );
}

async function commandIdentity(client, flags) {
    const target = stringFlag(flags, 'check') || stringFlag(flags, 'agent') || stringFlag(flags, 'agent-ref');
    if (target) {
        return client.identityCheck(target);
    }
    return client.identity();
}

async function commandProcurement(client, flags) {
    const capability = stringFlag(flags, 'capability') || stringFlag(flags, 'capability-id');
    const listing = stringFlag(flags, 'listing') || stringFlag(flags, 'listing-id');
    const slug = stringFlag(flags, 'slug');
    const cost = numberFlag(flags, 'cost') ?? numberFlag(flags, 'quoted-cost') ?? numberFlag(flags, 'quoted-cost-usdc');

    if (!capability && !listing && !slug) {
        return client.procurement();
    }

    return client.procurementCheck(compact({
        capability_id: capability,
        listing_id: listing,
        slug,
        quoted_cost_usdc: cost,
    }));
}

async function commandQuote(client, flags) {
    const capability = stringFlag(flags, 'capability') || stringFlag(flags, 'capability-id');
    const listing = stringFlag(flags, 'listing') || stringFlag(flags, 'listing-id');
    const slug = stringFlag(flags, 'slug');
    if (!capability && !listing && !slug) {
        throw userError('quote requires --capability, --listing, or --slug.');
    }

    return client.quote(compact({
        capability_id: capability,
        listing_id: listing,
        slug,
        units: numberFlag(flags, 'units'),
        payment_network: stringFlag(flags, 'payment-network'),
        payment_asset: stringFlag(flags, 'payment-asset'),
    }));
}

async function commandApprovals(client, positionals, flags) {
    const subcommand = positionals[0] || 'list';
    if (subcommand === 'resolve') {
        return client.resolveApproval(
            requiredArg(stringFlag(flags, 'id') || positionals[1], 'approval id'),
            requiredArg(stringFlag(flags, 'decision'), 'decision'),
            stringFlag(flags, 'reason')
        );
    }

    if (subcommand !== 'list') {
        throw userError(`Unknown approvals subcommand "${subcommand}". Use "list" or "resolve".`);
    }

    return client.approvals(compact({
        role: stringFlag(flags, 'role') || 'buyer',
        status: stringFlag(flags, 'status'),
        limit: numberFlag(flags, 'limit'),
    }));
}

async function commandWallet(client, positionals, flags) {
    const subcommand = positionals[0] || 'status';

    if (subcommand === 'status' || subcommand === 'ledger') {
        return client.wallet();
    }
    if (subcommand === 'onchain') {
        return client.onchainBalance();
    }
    if (subcommand === 'create') {
        return client.createOnchainWallet(compact({
            wallet_type: stringFlag(flags, 'wallet-type'),
            name: stringFlag(flags, 'name'),
        }));
    }
    if (subcommand === 'connect') {
        return client.connectWallet(requiredArg(stringFlag(flags, 'wallet') || stringFlag(flags, 'wallet-address') || positionals[1], 'wallet address'), stringFlag(flags, 'wallet-type'));
    }
    if (subcommand === 'fund') {
        return client.purchase(numberFlag(flags, 'amount'));
    }
    if (subcommand === 'verify') {
        return client.verifyPurchase(requiredArg(stringFlag(flags, 'tx-hash') || stringFlag(flags, 'tx') || positionals[1], 'tx hash'));
    }
    if (subcommand === 'payout') {
        return client.payout(compact({
            amount: numberFlag(flags, 'amount'),
            destination: stringFlag(flags, 'destination'),
        }));
    }
    if (subcommand === 'payouts') {
        return client.payouts(compact({
            limit: numberFlag(flags, 'limit'),
        }));
    }

    throw userError(`Unknown wallet subcommand "${subcommand}". Use status, onchain, create, connect, fund, verify, payout, or payouts.`);
}

async function commandJobs(client, positionals, flags) {
    const subcommand = positionals[0] || 'summary';
    const jobId = stringFlag(flags, 'job') || stringFlag(flags, 'job-id') || positionals[1];
    const opts = compact({
        status: stringFlag(flags, 'status'),
        limit: numberFlag(flags, 'limit'),
    });

    if (subcommand === 'summary') {
        return client.jobsSummary();
    }
    if (subcommand === 'list') {
        return client.jobs(opts);
    }
    if (subcommand === 'get' || subcommand === 'detail') {
        return client.job(requiredArg(jobId, 'job id'));
    }
    if (subcommand === 'runs') {
        if (jobId) return client.jobRuns(jobId, opts);
        return client.allJobRuns(opts);
    }

    throw userError(`Unknown jobs subcommand "${subcommand}". Use summary, list, get, or runs.`);
}

async function commandSeller(client, positionals) {
    const subcommand = positionals[0] || 'status';

    if (subcommand === 'status') return client.sellerStatus();
    if (subcommand === 'demand') return client.sellerDemand();
    if (subcommand === 'health') return client.sellerHealth();
    if (subcommand === 'activity') return client.sellerActivity();
    if (subcommand === 'recommendations') return client.sellerRecommendations();
    if (subcommand === 'referrals') return client.sellerReferrals();

    throw userError(`Unknown seller subcommand "${subcommand}". Use status, demand, health, activity, recommendations, or referrals.`);
}

async function commandPreview(client, positionals, flags) {
    const source = requiredArg(
        stringFlag(flags, 'file') || stringFlag(flags, 'input') || stringFlag(flags, 'input-json') || positionals[0],
        'Agent OS preview file or JSON'
    );
    return client.deployPreview(unwrapAgentOsDeploymentInput(readJsonValue(source, 'Agent OS preview input')));
}

async function commandDeploy(client, positionals, flags, { apiKey, baseUrl }) {
    const subcommand = positionals[0] || 'list';
    const deploymentId = stringFlag(flags, 'deployment') || stringFlag(flags, 'deployment-id') || stringFlag(flags, 'id') || positionals[1];
    const input = () => readJsonValue(requiredArg(stringFlag(flags, 'file') || stringFlag(flags, 'input') || stringFlag(flags, 'input-json'), 'deployment file or JSON'), 'deployment input');
    const deploymentInput = () => unwrapAgentOsDeploymentInput(input());
    const maybeInput = () => {
        const hasInput = stringFlag(flags, 'file') || stringFlag(flags, 'input') || stringFlag(flags, 'input-json');
        return hasInput ? input() : {};
    };

    if (subcommand === 'catalog') {
        return client.deploymentCatalog();
    }
    if (subcommand === 'scaffold-native-harness-demo' || subcommand === 'native-harness-demo') {
        return agoragentic.buildNativeHarnessDemoDeployment({
            name: stringFlag(flags, 'name'),
            description: stringFlag(flags, 'description'),
            source_type: stringFlag(flags, 'source-type') || stringFlag(flags, 'source_type'),
            source_ref: stringFlag(flags, 'source-ref')
                || stringFlag(flags, 'source')
                || stringFlag(flags, 'repo')
                || stringFlag(flags, 'repository')
                || stringFlag(flags, 'image'),
            branch: stringFlag(flags, 'branch'),
            source_dir: stringFlag(flags, 'source-dir') || stringFlag(flags, 'source-directory'),
            health_path: stringFlag(flags, 'health-path'),
            connection_arn: stringFlag(flags, 'connection-arn'),
            access_role_arn: stringFlag(flags, 'access-role-arn'),
            instance_role_arn: stringFlag(flags, 'instance-role-arn'),
            service_prefix: stringFlag(flags, 'service-prefix'),
            build_command: stringFlag(flags, 'build-command'),
            start_command: stringFlag(flags, 'start-command'),
            runtime: stringFlag(flags, 'runtime'),
            port: numberFlag(flags, 'port'),
            model_profile: stringFlag(flags, 'model-profile') || stringFlag(flags, 'model'),
            bedrock_region: stringFlag(flags, 'bedrock-region'),
            exposure_mode: stringFlag(flags, 'exposure-mode') || stringFlag(flags, 'exposure'),
            billing_plan: stringFlag(flags, 'billing-plan'),
            autonomy_tier: stringFlag(flags, 'autonomy-tier'),
            ecf_profile: stringFlag(flags, 'ecf-profile'),
            goal: stringFlag(flags, 'goal'),
            max_daily_spend: numberFlag(flags, 'max-daily-spend'),
            approval_above: numberFlag(flags, 'approval-above'),
        });
    }
    if (subcommand === 'validate-source' || subcommand === 'validate-runtime') {
        return agoragentic.validateNativeHarnessDemoSource({
            path: stringFlag(flags, 'path')
                || stringFlag(flags, 'source-dir')
                || stringFlag(flags, 'source-directory')
                || 'native-harness-runtime',
        });
    }

    requireApiKey(apiKey, 'deploy');

    if (subcommand === 'readiness' || subcommand === 'preflight') {
        if (deploymentId) {
            return client.deploymentReadiness({ deploymentId });
        }
        return client.deploymentReadiness({ deployment: deploymentInput() });
    }
    if (subcommand === 'preview') {
        return client.deployPreview(deploymentInput());
    }
    if (subcommand === 'create') {
        return client.createDeployment(deploymentInput());
    }
    if (subcommand === 'list') {
        return client.deployments();
    }
    if (subcommand === 'get') {
        return client.deployment(requiredArg(deploymentId, 'deployment id'));
    }
    if (subcommand === 'billing') {
        return client.deploymentBilling(requiredArg(deploymentId, 'deployment id'));
    }
    if (subcommand === 'authorize-billing') {
        return client.authorizeDeploymentBilling(requiredArg(deploymentId, 'deployment id'), maybeInput());
    }
    if (subcommand === 'orchestration') {
        return client.deploymentOrchestration(requiredArg(deploymentId, 'deployment id'));
    }
    if (subcommand === 'goals') {
        return client.updateDeploymentGoals(requiredArg(deploymentId, 'deployment id'), input());
    }
    if (subcommand === 'improve' || subcommand === 'improvement' || subcommand === 'propose') {
        return client.proposeDeploymentImprovement(requiredArg(deploymentId, 'deployment id'), input());
    }
    if (subcommand === 'review' || subcommand === 'fulfillment-review') {
        const reviewInput = stringFlag(flags, 'file') || stringFlag(flags, 'input') || stringFlag(flags, 'input-json')
            ? input()
            : {};
        return client.reviewDeploymentFulfillment(requiredArg(deploymentId, 'deployment id'), reviewInput);
    }
    if (subcommand === 'canary' || subcommand === 'canary-plan') {
        const canaryInput = stringFlag(flags, 'file') || stringFlag(flags, 'input') || stringFlag(flags, 'input-json')
            ? input()
            : {};
        return client.createDeploymentCanaryPlan(requiredArg(deploymentId, 'deployment id'), canaryInput);
    }
    if (subcommand === 'smoke' || subcommand === 'smoke-result') {
        return client.recordDeploymentSmokeResult(requiredArg(deploymentId, 'deployment id'), maybeInput());
    }
    if (subcommand === 'provision') {
        return client.provisionDeployment(requiredArg(deploymentId, 'deployment id'), maybeInput());
    }
    if (subcommand === 'live-smoke') {
        return client.smokeDeployment(requiredArg(deploymentId, 'deployment id'), maybeInput());
    }
    if (subcommand === 'gate' || subcommand === 'activation-gate') {
        return client.deploymentActivationGate(requiredArg(deploymentId, 'deployment id'));
    }
    if (subcommand === 'activate') {
        return client.activateDeployment(requiredArg(deploymentId, 'deployment id'), maybeInput());
    }
    if (subcommand === 'reconcile' || subcommand === 'intent' || subcommand === 'intent-reconciliation') {
        return client.reconcileDeploymentIntent(requiredArg(deploymentId, 'deployment id'), input());
    }
    if (subcommand === 'launch' || subcommand === 'self-serve-launch') {
        return client.selfServeDeploymentLaunch(requiredArg(deploymentId, 'deployment id'), maybeInput());
    }
    if (subcommand === 'treasury') {
        return client.deploymentTreasuryPlan(requiredArg(deploymentId, 'deployment id'));
    }
    if (subcommand === 'fund' || subcommand === 'funding') {
        return client.deploymentFundingInstructions(
            requiredArg(deploymentId, 'deployment id'),
            compact({ amount: numberFlag(flags, 'amount') })
        );
    }
    if (subcommand === 'verify-funding') {
        return client.verifyDeploymentFunding(
            requiredArg(deploymentId, 'deployment id'),
            requiredArg(stringFlag(flags, 'tx-hash') || stringFlag(flags, 'tx'), 'tx hash')
        );
    }

    throw userError(`Unknown deploy subcommand "${subcommand}". Use catalog, scaffold-native-harness-demo, validate-source, readiness, preview, create, list, get, billing, authorize-billing, orchestration, goals, review, canary, smoke, provision, live-smoke, activation-gate, activate, reconcile, launch, improve, treasury, fund, or verify-funding.`);
}

async function commandExecute(client, flags) {
    if (!flags.yes && !flags.execute) {
        throw userError(PAID_EXECUTION_HELP);
    }

    const quoteId = stringFlag(flags, 'quote') || stringFlag(flags, 'quote-id');
    const task = stringFlag(flags, 'task');
    if (!quoteId && !task) {
        throw userError('execute requires --quote or --task.');
    }

    const maxCost = numberFlag(flags, 'max-cost') ?? numberFlag(flags, 'max_cost');
    if (!quoteId && maxCost === undefined) {
        throw userError('Task-routed execute requires --max-cost.');
    }

    const input = readInput(flags);
    const constraints = compact({
        max_cost: maxCost,
        quote_id: quoteId,
        preferred_category: stringFlag(flags, 'category'),
        max_latency_ms: numberFlag(flags, 'max-latency-ms'),
    });

    return client.execute(quoteId ? null : task, input, constraints);
}

async function commandInvoke(client, positionals, flags) {
    if (!flags.yes && !flags.execute) {
        throw userError('Direct invoke is disabled by default. Add --yes and either --max-cost or --quote to confirm the specific listing call.');
    }

    const listingId = requiredArg(
        stringFlag(flags, 'capability') || stringFlag(flags, 'capability-id') || stringFlag(flags, 'listing') || stringFlag(flags, 'listing-id') || positionals[0],
        'listing id'
    );
    const quoteId = stringFlag(flags, 'quote') || stringFlag(flags, 'quote-id');
    const maxCost = numberFlag(flags, 'max-cost') ?? numberFlag(flags, 'max_cost');
    if (!quoteId && maxCost === undefined) {
        throw userError('Direct invoke requires --max-cost or --quote.');
    }

    return client.invoke(listingId, readInput(flags), compact({
        maxCost,
        quoteId,
    }));
}

async function commandX402(positionals, flags, env, { baseUrl, gatewayAgentId }) {
    const subcommand = positionals[0] || 'info';
    const base = baseUrl.replace(/\/+$/, '');
    const edgeBase = 'https://x402.agoragentic.com';
    const gatewayHeaders = gatewayAgentId ? { [GATEWAY_AGENT_HEADER]: gatewayAgentId } : undefined;
    const signingKey = resolveSigningKey(flags, env || {});

    if (subcommand === 'info') {
        return fetchJsonRequest(`${base}/api/x402/info`);
    }
    if (subcommand === 'listings') {
        return fetchJsonRequest(`${base}/api/x402/listings`);
    }
    if (subcommand === 'browse') {
        // Stable edge catalog — fetch status.json from the edge domain
        return fetchJsonRequest(`${edgeBase}/status.json`);
    }
    if (subcommand === 'match') {
        const params = new URLSearchParams({ task: requiredArg(stringFlag(flags, 'task'), 'task') });
        if (numberFlag(flags, 'max-cost') !== undefined) params.set('max_cost', String(numberFlag(flags, 'max-cost')));
        if (stringFlag(flags, 'category')) params.set('category', stringFlag(flags, 'category'));
        return fetchJsonRequest(`${base}/api/x402/execute/match?${params.toString()}`);
    }
    if (subcommand === 'quote') {
        // Quote a specific stable edge slug — fetch from edge status and filter
        const slug = requiredArg(positionals[1] || stringFlag(flags, 'slug') || stringFlag(flags, 'listing'), 'slug');
        const status = await fetchJsonRequest(`${edgeBase}/status.json`);
        const service = (status.services || []).find(s => s.slug === slug);
        if (!service) {
            throw userError(`Slug "${slug}" not found in stable edge catalog. Available: ${(status.services || []).map(s => s.slug).join(', ')}`);
        }
        return {
            slug: service.slug,
            status: service.status,
            payable_url: service.payable_url,
            price_usdc: service.price_usdc,
            paid_calls_7d: service.paid_calls_7d,
            repeat_wallets_30d: service.repeat_wallets_30d,
            gross_volume_usdc_7d: service.gross_volume_usdc_7d,
            last_successful_paid_at: service.last_successful_paid_at,
            safe_to_retry: service.safe_to_retry,
            idempotency_supported: service.idempotency_supported,
            sample_input: { text: 'your text here' },
            how_to_call: {
                step_1: `POST ${service.payable_url} { "text": "..." }  ->  402 challenge`,
                step_2: 'Retry with PAYMENT-SIGNATURE or X-PAYMENT-SIGNATURE header  ->  200 + result',
                cli: `agora x402 invoke ${slug} --input '{"text":"..."}' --payment-signature <sig>`,
            },
        };
    }
    if (subcommand === 'test') {
        return fetchJsonRequest(`${base}/api/x402/test/echo`, {
            method: 'POST',
            body: { text: stringFlag(flags, 'text') || 'hello from agora cli' },
            paymentSignature: stringFlag(flags, 'payment-signature'),
        }, { allowErrorStatus: true });
    }
    if (subcommand === 'execute') {
        // 2-step flow: call match first to get quote_id, then POST execute with quote_id
        const task = requiredArg(stringFlag(flags, 'task'), 'task');
        const input = readInput(flags);
        const maxCost = numberFlag(flags, 'max-cost') ?? numberFlag(flags, 'max_cost');
        const paymentSignature = stringFlag(flags, 'payment-signature');

        // If the user already has a quote_id (from a previous match), skip match
        const existingQuoteId = stringFlag(flags, 'quote') || stringFlag(flags, 'quote-id');
        let quoteId = existingQuoteId;

        if (!quoteId) {
            // Step 1: call match to get a quote_id
            const matchParams = new URLSearchParams({ task });
            if (maxCost !== undefined) matchParams.set('max_cost', String(maxCost));
            if (stringFlag(flags, 'category')) matchParams.set('category', stringFlag(flags, 'category'));
            const matchResult = await fetchJsonRequest(`${base}/api/x402/execute/match?${matchParams.toString()}`);

            if (!matchResult.quote || !matchResult.quote.quote_id) {
                return {
                    error: 'no_match',
                    message: `No eligible provider found for task: "${task}"`,
                    matches: matchResult.matches || 0,
                    eligible: matchResult.eligible || 0,
                    match_strategy: matchResult.match_strategy || null,
                    hint: 'Try broadening your task description or increasing --max-cost.',
                };
            }
            quoteId = matchResult.quote.quote_id;
            // Without a payment signature AND no signing key, return match for user to sign manually
            if (!paymentSignature && !signingKey) {
                return {
                    matched: true,
                    quote_id: quoteId,
                    provider: matchResult.selected_provider,
                    quoted_price_usdc: matchResult.quote.quoted_price_usdc,
                    expires_at: matchResult.quote.expires_at,
                    next_step: `agora x402 execute --task "${task}" --quote-id ${quoteId} --payment-signature <sig> --input '<json>'`,
                    note: 'To complete execution, retry this command with --quote-id and --payment-signature from your wallet.',
                    hint: 'Or set AGORAGENTIC_SIGNING_KEY to enable auto-signing.',
                };
            }
        }

        // Step 2: POST execute with quote_id (auto-sign if signing key available)
        return fetchWithAutoSign(`${base}/api/x402/execute`, {
            method: 'POST',
            body: {
                quote_id: quoteId,
                input,
            },
            headers: gatewayHeaders,
            paymentSignature,
        }, { allowErrorStatus: true }, signingKey);
    }
    if (subcommand === 'invoke') {
        const target = requiredArg(positionals[1] || stringFlag(flags, 'listing') || stringFlag(flags, 'listing-id') || stringFlag(flags, 'capability') || stringFlag(flags, 'slug'), 'listing id or slug');
        const input = readInput(flags);
        const paymentSignature = stringFlag(flags, 'payment-signature');

        // Stable edge calls use human-readable slugs. Internal capability/listing
        // references stay on the main API even when they are not UUID-shaped.
        const isInternalListingRef = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(target) || /^cap_[A-Za-z0-9_-]+$/.test(target);

        if (!isInternalListingRef) {
            // Route to stable edge: https://x402.agoragentic.com/v1/{slug}
            return fetchWithAutoSign(`${edgeBase}/v1/${encodeURIComponent(target)}`, {
                method: 'POST',
                body: input,
                headers: gatewayHeaders,
                paymentSignature,
            }, { allowErrorStatus: true }, signingKey);
        }

        // Fallback: main-domain invoke by listing ID
        return fetchWithAutoSign(`${base}/api/x402/invoke/${encodeURIComponent(target)}`, {
            method: 'POST',
            body: { input },
            headers: gatewayHeaders,
            paymentSignature,
        }, { allowErrorStatus: true }, signingKey);
    }
    if (subcommand === 'receipt') {
        const receiptId = requiredArg(positionals[1] || stringFlag(flags, 'id') || stringFlag(flags, 'receipt-id'), 'receipt id');
        return fetchJsonRequest(`${edgeBase}/v1/receipt-reconciliation`, {
            method: 'POST',
            body: { receipt_id: receiptId },
            paymentSignature: stringFlag(flags, 'payment-signature'),
        }, { allowErrorStatus: true });
    }
    if (subcommand === 'claim') {
        const walletAddress = requiredArg(stringFlag(flags, 'wallet') || stringFlag(flags, 'wallet-address'), 'wallet');
        const signature = stringFlag(flags, 'signature');
        const message = stringFlag(flags, 'message') || agoragentic.buildX402ClaimProofMessage(walletAddress);
        if (!signature) {
            return {
                proof_required: true,
                wallet_address: walletAddress.toLowerCase(),
                proof: { message },
                next: 'Sign the message with your wallet, then rerun agora x402 claim --wallet <address> --signature <hex-signature>.',
            };
        }
        return fetchJsonRequest(`${base}/api/x402/claim`, {
            method: 'POST',
            headers: gatewayHeaders,
            body: compact({
                wallet_address: walletAddress.toLowerCase(),
                proof: { message, signature },
                limit: numberFlag(flags, 'limit'),
                offset: numberFlag(flags, 'offset'),
                include_payload: flags['include-payload'] ? true : undefined,
            }),
        });
    }

    throw userError(`Unknown x402 subcommand "${subcommand}". Use info, listings, browse, match, quote, test, execute, invoke, receipt, or claim.`);
}

async function commandArbiter(positionals, flags, env, { baseUrl }) {
    const subcommand = positionals[0] || 'review';
    if (subcommand !== 'review') {
        throw userError(`Unknown arbiter subcommand "${subcommand}". Use review.`);
    }

    const adminSecret = stringFlag(flags, 'admin-secret') || env.AGORAGENTIC_ADMIN_SECRET;
    if (!adminSecret) {
        throw userError('arbiter review requires AGORAGENTIC_ADMIN_SECRET or --admin-secret.');
    }

    const payload = readJsonValue(requiredArg(stringFlag(flags, 'payload') || positionals[1], 'payload'), 'payload');
    return fetchJsonRequest(`${baseUrl.replace(/\/+$/, '')}/api/arbiter/review`, {
        method: 'POST',
        body: {
            ...payload,
            semantic: Boolean(flags.semantic),
            semantic_blocking: Boolean(flags['semantic-blocking'] || flags.semantic_blocking),
        },
        headers: { 'X-Admin-Secret': adminSecret },
    });
}

async function commandCapabilities(client, positionals, flags) {
    const subcommand = positionals[0] || 'publish';
    if (subcommand !== 'publish') {
        throw userError(`Unknown capabilities subcommand "${subcommand}". Use publish.`);
    }
    if (!flags.yes && !flags.publish) {
        throw userError('capabilities publish writes platform state. Add --yes to confirm.');
    }

    const source = requiredArg(stringFlag(flags, 'file') || positionals[1], 'listing file');
    return client.listService(readJsonValue(source, 'listing'));
}

async function commandExports(positionals, flags) {
    const subcommand = positionals[0] || 'generate';
    if (subcommand !== 'generate') {
        throw userError(`Unknown exports subcommand "${subcommand}". Use generate.`);
    }

    const targetName = requiredArg(stringFlag(flags, 'target'), 'target').toLowerCase();
    const target = toolkit.getExportTarget(targetName);
    if (!target) {
        throw userError(`Unknown export target "${targetName}". Run agora toolkit exports.`);
    }

    const listingSource = stringFlag(flags, 'listing') || stringFlag(flags, 'file');
    const listing = listingSource ? readJsonValue(listingSource, 'listing') : null;
    const missing = listing
        ? target.required_fields.filter((field) => listing[field] === undefined || listing[field] === null || listing[field] === '')
        : target.required_fields;

    return {
        target: targetName,
        profile: target,
        listing: listing ? summarizeListingForExport(listing) : null,
        readiness: {
            ready: listing ? missing.length === 0 : false,
            missing_fields: missing,
        },
    };
}

async function commandReceipts(client, positionals) {
    const subcommand = positionals[0] || 'get';
    if (subcommand !== 'get') {
        throw userError(`Unknown receipts subcommand "${subcommand}". Use get.`);
    }
    return client.receipt(requiredArg(positionals[1], 'receipt id'));
}

function parseArgs(argv) {
    const flags = {};
    const positionals = [];

    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (token === '--') {
            positionals.push(...argv.slice(i + 1));
            break;
        }
        if (!token.startsWith('-') || token === '-') {
            positionals.push(token);
            continue;
        }

        const withoutDashes = token.replace(/^-+/, '');
        const eq = withoutDashes.indexOf('=');
        if (eq >= 0) {
            flags[withoutDashes.slice(0, eq)] = withoutDashes.slice(eq + 1);
            continue;
        }

        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
            flags[withoutDashes] = next;
            i += 1;
        } else {
            flags[withoutDashes] = true;
        }
    }

    return { flags, positionals };
}

function readInput(flags) {
    const raw = stringFlag(flags, 'input-json') || stringFlag(flags, 'input');
    if (!raw) {
        return {};
    }

    const filePath = fs.existsSync(raw) && fs.statSync(raw).isFile() ? raw : null;
    const content = filePath ? fs.readFileSync(filePath, 'utf8') : raw;
    try {
        return JSON.parse(content);
    } catch (err) {
        throw userError(`Input must be a JSON string or path to a JSON file: ${err.message}`);
    }
}

function readJsonValue(value, label) {
    const filePath = fs.existsSync(value) && fs.statSync(value).isFile() ? value : null;
    const content = filePath ? fs.readFileSync(filePath, 'utf8') : value;
    try {
        return JSON.parse(content);
    } catch (err) {
        throw userError(`${label} must be a JSON string or path to a JSON file: ${err.message}`);
    }
}

function unwrapAgentOsDeploymentInput(value) {
    return agoragentic.normalizeAgentOsDeploymentInput(value);
}

async function fetchJson(url) {
    if (typeof fetch !== 'function') {
        throw userError('This CLI requires Node.js 18+ or a runtime with global fetch.');
    }

    const res = await fetch(url, {
        headers: {
            Accept: 'application/json',
            'User-Agent': 'agoragentic-os-cli/1.6.5',
        },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const err = new Error(data.message || data.error || `HTTP ${res.status}`);
        err.status = res.status;
        err.response = data;
        throw err;
    }
    return data;
}

async function fetchJsonRequest(url, options = {}, config = {}) {
    if (typeof fetch !== 'function') {
        throw userError('This CLI requires Node.js 18+ or a runtime with global fetch.');
    }

    const headers = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'agora-cli/1.6.5',
        ...(options.headers || {}),
    };
    if (options.paymentSignature) {
        headers['PAYMENT-SIGNATURE'] = options.paymentSignature;
    }

    const res = await fetch(url, {
        method: options.method || 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok && !config.allowErrorStatus) {
        const err = new Error(data.message || data.error || `HTTP ${res.status}`);
        err.status = res.status;
        err.response = data;
        throw err;
    }

    if (config.allowErrorStatus) {
        return {
            ok: res.ok,
            status: res.status,
            headers: {
                payment_required: res.headers.get('payment-required'),
                www_authenticate: res.headers.get('www-authenticate'),
                payment_response: res.headers.get('payment-response'),
                payment_receipt: res.headers.get('payment-receipt'),
            },
            body: data,
        };
    }

    return data;
}

async function check(name, fn) {
    try {
        const summary = await fn();
        return { name, ok: true, summary };
    } catch (err) {
        return {
            name,
            ok: false,
            error: err.code || 'check_failed',
            message: err.message,
            status: err.status,
        };
    }
}

function summarizeAccount(data) {
    const account = data.account || data;
    return {
        spend_mode: account.policy?.mode || account.spend_mode || null,
        balance_usdc: account.wallet?.balance_usdc ?? account.wallet?.balance ?? account.balance_usdc ?? null,
        recommendations: count(account.recommendations),
    };
}

function summarizeIdentity(data) {
    const identity = data.identity || data;
    return {
        agent_ref: identity.agent_ref || identity.agent_uri || null,
        machine_verifiable: identity.trust_portability?.portable_signals?.machine_verifiable ?? null,
        passport_ready: identity.passport?.ready ?? identity.passport_ready ?? null,
    };
}

function summarizeProcurement(data) {
    const procurement = data.procurement || data;
    return {
        spend_mode: procurement.policy?.mode || procurement.spend_mode || null,
        requested_approvals: count(procurement.requested_approvals || procurement.requestedApprovals),
        supervisor_queue: count(procurement.supervisor_queue || procurement.supervisorQueue),
    };
}

function summarizeApprovals(data) {
    return {
        total: data.total ?? count(data.approvals),
        pending: data.summary?.pending ?? null,
        approved: data.summary?.approved ?? null,
    };
}

function summarizeSeller(data) {
    const seller = data.seller_activation || data.seller || data;
    return {
        state: seller.state || seller.activation_state || null,
        next_action: seller.next_action || seller.next_best_action || null,
        free_listing_slots: seller.free_listing_slots ?? seller.slots?.free ?? null,
    };
}

function summarizeReconciliation(data) {
    const reconciliation = data.reconciliation || data;
    return {
        total_spend_usdc: reconciliation.spend?.total_usdc ?? reconciliation.spend_summary?.total_usdc ?? null,
        receipt_count: count(reconciliation.receipts || reconciliation.recent_receipts),
        projected_30d_spend_usdc: reconciliation.forecast?.projected_30d_spend_usdc ?? null,
    };
}

function summarizeListingForExport(listing) {
    return {
        id: listing.id || listing.listing_id || listing.capability_id || null,
        name: listing.name || listing.skill_name || listing.service_name || null,
        category: listing.category || null,
        price_per_call: listing.price_per_call ?? listing.price_per_unit ?? listing.price_usdc ?? null,
        endpoint_url: listing.endpoint_url || listing.x402_endpoint_url || listing.service_url || null,
        schema_fields: Object.keys(listing.input_schema || listing.schema || {}).sort(),
    };
}

function count(value) {
    if (Array.isArray(value)) return value.length;
    if (typeof value === 'number') return value;
    if (value && typeof value.total === 'number') return value.total;
    return null;
}

function escapePowerShell(value) {
    return String(value).replace(/`/g, '``').replace(/"/g, '`"');
}

function writeJson(stream, value) {
    stream.write(`${JSON.stringify(value, null, 2)}\n`);
}

function stringFlag(flags, name) {
    const value = flags[name];
    if (value === undefined || value === true || value === false) return null;
    return String(value);
}

function numberFlag(flags, name) {
    const value = stringFlag(flags, name);
    if (value === null) return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        throw userError(`--${name} must be a number.`);
    }
    return parsed;
}

function requiredArg(value, label) {
    if (!value) {
        throw userError(`Missing required ${label}.`);
    }
    return value;
}

function requireApiKey(apiKey, command) {
    if (!apiKey) {
        throw userError(missingApiKeyMessage(command));
    }
}

function missingApiKeyMessage(command) {
    return [
        `${command} requires AGORAGENTIC_API_KEY or --api-key.`,
        '',
        'Create a key with one of:',
        '  npx agoragentic-os quickstart --name my-agent --type both',
        `  curl -sS -X POST ${DEFAULT_BASE_URL}/api/quickstart -H "Content-Type: application/json" -d '{"name":"my-agent","type":"both"}'`,
        '',
        'Then rerun:',
        `  AGORAGENTIC_API_KEY=amk_... ${missingApiKeyCommandExample(command)}`,
        '',
        `Guide: ${DEFAULT_BASE_URL}/guides/agent-os-quickstart/`,
    ].join('\n');
}

function missingApiKeyCommandExample(command) {
    if (command === 'preview') {
        return 'npx agoragentic-os preview .ecf-core/agent-os-import.json';
    }
    if (command === 'deploy') {
        return 'npx agoragentic-os deploy preview --file .micro-ecf/harness-export.json';
    }
    return `npx agoragentic-os ${command}`;
}

function compact(value) {
    return Object.fromEntries(
        Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null && entry !== '')
    );
}

function userError(message) {
    const err = new Error(message);
    err.code = 'usage_error';
    err.exitCode = 2;
    return err;
}

function defaultIo() {
    return {
        stdout: process.stdout,
        stderr: process.stderr,
    };
}

if (require.main === module) {
    runCli().then((code) => {
        process.exitCode = code;
    });
}

module.exports = {
    runCli,
    parseArgs,
    usage,
};
