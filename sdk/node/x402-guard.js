/**
 * Agoragentic x402 buyer guard.
 *
 * Runtime policy checks for autonomous buyers before signing an x402 retry.
 * This helper is intentionally wallet-agnostic: callers provide signPayment().
 */

'use strict';

const BASE_MAINNET_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

const DEFAULT_X402_BUYER_POLICY = Object.freeze({
    max_usdc_per_call: 1,
    daily_usdc_limit: null,
    spent_usdc_today: 0,
    allowed_networks: ['base'],
    allowed_assets: ['USDC'],
    allowed_asset_addresses: [BASE_MAINNET_USDC],
    allowed_schemes: ['exact'],
    allowed_domains: [],
    blocked_domains: [],
    require_receipt_header: true,
    require_resource_match: true,
    max_retries_per_request: 1,
    max_retries_per_minute: 20,
});

function createPolicyError(code, message, details = {}) {
    const err = new Error(message || code);
    err.code = code;
    err.details = details;
    return err;
}

function normalizeArray(value) {
    if (value === undefined || value === null) return [];
    return Array.isArray(value) ? value : [value];
}

function normalizePolicy(policy = {}) {
    return {
        ...DEFAULT_X402_BUYER_POLICY,
        ...policy,
        allowed_networks: normalizeArray(policy.allowed_networks ?? DEFAULT_X402_BUYER_POLICY.allowed_networks).map((item) => String(item).toLowerCase()),
        allowed_assets: normalizeArray(policy.allowed_assets ?? DEFAULT_X402_BUYER_POLICY.allowed_assets).map((item) => String(item).toUpperCase()),
        allowed_asset_addresses: normalizeArray(policy.allowed_asset_addresses ?? DEFAULT_X402_BUYER_POLICY.allowed_asset_addresses).map((item) => String(item).toLowerCase()),
        allowed_schemes: normalizeArray(policy.allowed_schemes ?? DEFAULT_X402_BUYER_POLICY.allowed_schemes).map((item) => String(item).toLowerCase()),
        allowed_domains: normalizeArray(policy.allowed_domains),
        blocked_domains: normalizeArray(policy.blocked_domains),
        retry_timestamps: normalizeArray(policy.retry_timestamps),
    };
}

function decodePaymentRequired(headerValue) {
    if (!headerValue) {
        throw createPolicyError('missing_payment_required', 'Missing PAYMENT-REQUIRED challenge header');
    }

    const raw = String(headerValue).trim();
    const candidates = [raw];
    if (!raw.startsWith('{')) {
        const normalized = raw.replace(/-/g, '+').replace(/_/g, '/');
        candidates.push(Buffer.from(normalized, 'base64').toString('utf8'));
    }

    for (const candidate of candidates) {
        try {
            return JSON.parse(candidate);
        } catch {
            // try the next representation
        }
    }

    throw createPolicyError('invalid_payment_required', 'PAYMENT-REQUIRED challenge is not valid JSON or base64 JSON');
}

function parseUsdcAmount(requirement = {}) {
    const direct = requirement.price
        ?? requirement.amount_usdc
        ?? requirement.amountUsd
        ?? requirement.cost_usdc
        ?? requirement.cost;

    if (direct !== undefined && direct !== null) {
        const value = Number(String(direct).replace(/^\$/, ''));
        return Number.isFinite(value) ? value : NaN;
    }

    const raw = requirement.maxAmountRequired
        ?? requirement.max_amount_required
        ?? requirement.amount
        ?? requirement.value;
    if (raw === undefined || raw === null) return NaN;

    const numeric = Number(raw);
    if (!Number.isFinite(numeric)) return NaN;
    if (String(raw).includes('.')) return numeric;

    const decimals = Number.isFinite(Number(requirement.assetDecimals))
        ? Number(requirement.assetDecimals)
        : Number.isFinite(Number(requirement.decimals))
            ? Number(requirement.decimals)
            : 6;
    return numeric / (10 ** decimals);
}

function getRequirementNetwork(requirement = {}) {
    return String(requirement.network || requirement.chain || requirement.extra?.network || '').toLowerCase();
}

function getRequirementScheme(requirement = {}) {
    return String(requirement.scheme || requirement.type || '').toLowerCase();
}

function getRequirementAsset(requirement = {}) {
    return String(requirement.assetSymbol || requirement.asset || requirement.currency || 'USDC');
}

function assetAllowed(requirement = {}, policy) {
    const asset = getRequirementAsset(requirement);
    const upper = asset.toUpperCase();
    const lower = asset.toLowerCase();
    return policy.allowed_assets.includes(upper)
        || policy.allowed_asset_addresses.includes(lower);
}

function normalizeUrl(value) {
    if (!value) return '';
    try {
        const url = new URL(String(value));
        url.hash = '';
        return url.toString().replace(/\/$/, '');
    } catch {
        return String(value).replace(/\/$/, '');
    }
}

function getResourceUrl(paymentRequired = {}, requirement = {}) {
    if (typeof paymentRequired.resource === 'string') return paymentRequired.resource;
    return paymentRequired.resource?.url
        || paymentRequired.resourceUrl
        || requirement.resource
        || requirement.resourceUrl
        || requirement.resource_url
        || '';
}

function hostnameOf(value) {
    try {
        return new URL(String(value)).hostname.toLowerCase();
    } catch {
        return '';
    }
}

function matchesDomainRule(hostname, rule) {
    const normalized = String(rule || '').toLowerCase();
    if (!hostname || !normalized) return false;
    if (normalized.startsWith('*.')) {
        const suffix = normalized.slice(1);
        return hostname.endsWith(suffix);
    }
    if (normalized.startsWith('.')) return hostname.endsWith(normalized);
    return hostname === normalized;
}

function assertDomainPolicy(requestedUrl, resourceUrl, policy) {
    const hosts = [hostnameOf(requestedUrl), hostnameOf(resourceUrl)].filter(Boolean);
    if (policy.blocked_domains.some((rule) => hosts.some((host) => matchesDomainRule(host, rule)))) {
        throw createPolicyError('x402_policy_blocked_domain', 'x402 challenge targets a blocked domain', { hosts });
    }
    const disallowedHosts = hosts.filter((host) => !policy.allowed_domains.some((rule) => matchesDomainRule(host, rule)));
    if (policy.allowed_domains.length > 0 && disallowedHosts.length > 0) {
        throw createPolicyError('x402_policy_domain_not_allowed', 'x402 challenge includes a domain outside the allowed policy', {
            hosts,
            disallowed_hosts: disallowedHosts,
        });
    }
}

function assertVelocityPolicy(policy, now = Date.now()) {
    const maxPerMinute = Number(policy.max_retries_per_minute);
    if (!Number.isFinite(maxPerMinute) || maxPerMinute <= 0) return;
    const recent = policy.retry_timestamps
        .map((value) => Number(value))
        .filter((timestamp) => Number.isFinite(timestamp) && now - timestamp < 60_000);
    if (recent.length >= maxPerMinute) {
        throw createPolicyError('x402_policy_velocity_exceeded', 'x402 retry velocity limit exceeded', {
            recent_retries: recent.length,
            max_retries_per_minute: maxPerMinute,
        });
    }
}

function createX402AuditId() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
        return `x402_audit_${globalThis.crypto.randomUUID()}`;
    }
    return `x402_audit_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function selectRequirement(paymentRequired, policy, requestedUrl) {
    const requirements = normalizeArray(paymentRequired.accepts || paymentRequired.requirements);
    if (requirements.length === 0) {
        throw createPolicyError('x402_no_requirements', 'x402 challenge has no accepted payment requirements');
    }

    const selected = requirements.find((requirement) => {
        const scheme = getRequirementScheme(requirement);
        const network = getRequirementNetwork(requirement);
        const amount = parseUsdcAmount(requirement);
        return policy.allowed_schemes.includes(scheme)
            && policy.allowed_networks.includes(network)
            && assetAllowed(requirement, policy)
            && Number.isFinite(amount)
            && amount <= Number(policy.max_usdc_per_call);
    });

    if (!selected) {
        throw createPolicyError('x402_no_policy_approved_requirement', 'No x402 requirement passed local buyer policy');
    }

    const resourceUrl = getResourceUrl(paymentRequired, selected);
    if (policy.require_resource_match && normalizeUrl(resourceUrl) !== normalizeUrl(requestedUrl)) {
        throw createPolicyError('x402_resource_mismatch', 'x402 challenge resource does not match the request URL', {
            requested_url: requestedUrl,
            resource_url: resourceUrl,
        });
    }

    return selected;
}

function authorizeX402Retry(paymentRequired, options = {}) {
    const policy = normalizePolicy(options.policy || {});
    const requestedUrl = options.requestedUrl || options.url;
    const retryCount = Number(options.retryCount || 0);
    if (retryCount >= Number(policy.max_retries_per_request || 1)) {
        throw createPolicyError('x402_retry_limit_exceeded', 'x402 retry limit exceeded for this request');
    }

    if (paymentRequired.x402Version !== undefined && Number(paymentRequired.x402Version) !== 2) {
        throw createPolicyError('unsupported_x402_version', 'Unsupported x402 challenge version', {
            x402Version: paymentRequired.x402Version,
        });
    }

    assertVelocityPolicy(policy, options.now || Date.now());

    const requirement = selectRequirement(paymentRequired, policy, requestedUrl);
    const amountUsdc = parseUsdcAmount(requirement);
    const resourceUrl = getResourceUrl(paymentRequired, requirement);
    assertDomainPolicy(requestedUrl, resourceUrl, policy);

    const dailyLimit = policy.daily_usdc_limit === null || policy.daily_usdc_limit === undefined
        ? null
        : Number(policy.daily_usdc_limit);
    const spentToday = Number(policy.spent_usdc_today || 0);
    if (dailyLimit !== null && Number.isFinite(dailyLimit) && dailyLimit >= 0 && spentToday + amountUsdc > dailyLimit) {
        throw createPolicyError('x402_policy_daily_budget_exceeded', 'x402 retry would exceed daily buyer budget', {
            spent_usdc_today: spentToday,
            amount_usdc: amountUsdc,
            daily_usdc_limit: dailyLimit,
        });
    }

    return {
        approved: true,
        audit_id: options.auditId || createX402AuditId(),
        amount_usdc: amountUsdc,
        resource_url: resourceUrl,
        requirement,
        policy: {
            max_usdc_per_call: policy.max_usdc_per_call,
            daily_usdc_limit: policy.daily_usdc_limit,
            allowed_networks: policy.allowed_networks,
            allowed_assets: policy.allowed_assets,
            require_receipt_header: policy.require_receipt_header,
            require_resource_match: policy.require_resource_match,
        },
    };
}

function getHeader(headers, name) {
    if (!headers) return null;
    if (typeof headers.get === 'function') return headers.get(name);
    const target = String(name).toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
        if (String(key).toLowerCase() === target) return value;
    }
    return null;
}

function cloneHeaders(headers) {
    const result = {};
    if (!headers) return result;
    if (typeof headers.forEach === 'function') {
        headers.forEach((value, key) => {
            result[key] = value;
        });
        return result;
    }
    if (Array.isArray(headers)) {
        for (const [key, value] of headers) result[key] = value;
        return result;
    }
    return { ...headers };
}

function extractSignatureHeaders(signatureResult) {
    if (typeof signatureResult === 'string') {
        return {
            'PAYMENT-SIGNATURE': signatureResult,
            'X-PAYMENT-SIGNATURE': signatureResult,
        };
    }
    if (signatureResult && typeof signatureResult === 'object') {
        if (signatureResult.headers) return { ...signatureResult.headers };
        if (signatureResult.signature) {
            return {
                'PAYMENT-SIGNATURE': signatureResult.signature,
                'X-PAYMENT-SIGNATURE': signatureResult.signature,
            };
        }
        if (signatureResult.payment) {
            return {
                'PAYMENT-SIGNATURE': signatureResult.payment,
                'X-PAYMENT-SIGNATURE': signatureResult.payment,
            };
        }
    }
    throw createPolicyError('x402_missing_signature', 'signPayment() did not return a payment signature');
}

async function guardedX402Fetch(fetchImpl, url, init = {}, signPayment, policy = {}, options = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
    if (typeof signPayment !== 'function') throw new TypeError('signPayment must be a function');

    const first = await fetchImpl(url, init);
    if (!first || first.status !== 402) return first;

    const challengeHeader = getHeader(first.headers, 'PAYMENT-REQUIRED')
        || getHeader(first.headers, 'X-PAYMENT-REQUIRED');
    const paymentRequired = decodePaymentRequired(challengeHeader);
    const decision = authorizeX402Retry(paymentRequired, {
        ...options,
        policy,
        requestedUrl: url,
        retryCount: options.retryCount || 0,
    });

    const signatureResult = await signPayment({
        paymentRequired,
        requirement: decision.requirement,
        audit_id: decision.audit_id,
        amount_usdc: decision.amount_usdc,
        resource_url: decision.resource_url,
    });
    const retryHeaders = {
        ...cloneHeaders(init.headers),
        ...extractSignatureHeaders(signatureResult),
        'X-AGORAGENTIC-X402-AUDIT-ID': decision.audit_id,
    };
    const retry = await fetchImpl(url, { ...init, headers: retryHeaders });

    const effectivePolicy = normalizePolicy(policy);
    if (retry && retry.ok && effectivePolicy.require_receipt_header) {
        const hasReceipt = getHeader(retry.headers, 'PAYMENT-RESPONSE')
            || getHeader(retry.headers, 'X-PAYMENT-RESPONSE')
            || getHeader(retry.headers, 'Payment-Receipt');
        if (!hasReceipt) {
            throw createPolicyError('missing_payment_receipt', 'x402 retry succeeded without a receipt header', {
                audit_id: decision.audit_id,
            });
        }
    }

    retry.x402 = decision;
    return retry;
}

module.exports = {
    BASE_MAINNET_USDC,
    DEFAULT_X402_BUYER_POLICY,
    decodePaymentRequired,
    parseUsdcAmount,
    normalizePolicy,
    selectRequirement,
    authorizeX402Retry,
    guardedX402Fetch,
    guardedX402Retry: guardedX402Fetch,
    createX402AuditId,
};
