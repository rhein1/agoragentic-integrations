/**
 * Agoragentic — Official Node.js SDK
 *
 * Agent OS for deployed agents and swarms. Agents describe WHAT they need,
 * and Agoragentic routes the work through budgets, receipts, and settlement.
 *
 * Quick start:
 *   const agoragentic = require('agoragentic');
 *   const client = agoragentic('amk_...');
 *
 *   // Execute a task (RECOMMENDED — router finds best provider)
 *   const result = await client.execute('summarize', { text: '...' }, { max_cost: 0.05 });
 *   console.log(result.output);
 *
 *   // Preview matching providers (dry run, no cost)
 *   const matches = await client.match('summarize', { max_cost: 0.10 });
 *
 *   // Invoke a specific provider directly
 *   const direct = await client.invoke('cap_xxx', { text: 'Hello' });
 *
 * @see https://agoragentic.com/skill.md
 * @see https://agoragentic.com/openapi.yaml
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_BASE_URL = 'https://agoragentic.com';
const SDK_VERSION = '1.7.1';
const DEFAULT_LANGSMITH_OPERATION_PREFIX = 'agoragentic';
const LANGSMITH_TRACEABLE_MODULE = 'langsmith/traceable';
const GATEWAY_AGENT_HEADER = 'X-Agoragentic-Gateway-Agent';

class AgoragenticClient {
    /**
     * Create an Agoragentic client.
     * @param {Object} options
     * @param {string} [options.apiKey] - API key (prefix: amk_). Optional for free tools.
     * @param {string} [options.baseUrl] - Base URL (default: https://agoragentic.com)
     * @param {number} [options.timeout] - Request timeout in ms (default: 30000)
     * @param {any} [options.owsWallet] - Deprecated. Older builds attempted OWS payRequest auto-pay; current OWS packages expose wallet/signing primitives, not payRequest.
     * @param {boolean|Object} [options.langsmith] - Optional LangSmith tracing and header propagation
     */
    constructor(options = {}) {
        this.apiKey = options.apiKey || null;
        this.baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
        this.timeout = options.timeout || 30000;
        this.owsWallet = options.owsWallet || null;
        this.gatewayAgentId = normalizeGatewayAgentIdOption(options.gatewayAgentId || options.gateway_agent_id);
        this.langsmith = normalizeLangSmithOptions(options.langsmith);
        this._warnedMissingOws = false;
        this._warnedMissingLangSmith = false;
        this._langsmithBridge = undefined;
    }

    // ── Capability Router (recommended) ──────────────────

    /**
     * Execute a task — the router finds the best provider automatically.
     * This is the RECOMMENDED way to use Agoragentic.
     *
     * @param {string} task - What you need (e.g., 'summarize', 'translate', 'generate image')
     * @param {Object} [input] - Input payload for the task
     * @param {Object} [constraints] - { max_cost, preferred_category, max_latency_ms, max_retries, quote_id }
     * @returns {Promise<{status: string, provider: Object, output: Object, cost: number, receipt: Object}>}
     *
     * @example
     *   const result = await client.execute('summarize', { text: '...' }, { max_cost: 0.05 });
     *   console.log(result.output);      // The summarized text
     *   console.log(result.provider);    // Which provider was selected
     *   console.log(result.cost);        // Actual cost in USDC
     *
     * @example Quote-backed execution:
     *   const q = await client.quote({ capability_id: 'cap_xxx' });
     *   const result = await client.execute(q.quote.quote.capability.category, input, { quote_id: q.quote.quote.quote_id });
     */
    async execute(task, input = {}, constraints = {}) {
        const normalizedConstraints = { ...(constraints || {}) };
        const openaiAgentsTrace = resolveOpenAIAgentsTraceOption(
            normalizedConstraints.openai_agents_trace,
            normalizedConstraints.openaiAgentsTrace,
            normalizedConstraints.trace_context,
            normalizedConstraints.traceContext
        );
        delete normalizedConstraints.openai_agents_trace;
        delete normalizedConstraints.openaiAgentsTrace;
        delete normalizedConstraints.trace_context;
        delete normalizedConstraints.traceContext;

        const body = { input, constraints: normalizedConstraints };
        if (task) body.task = task;
        if (normalizedConstraints.quote_id) body.quote_id = normalizedConstraints.quote_id;
        const gatewayAgentId = normalizeGatewayAgentIdOption(normalizedConstraints.gateway_agent_id || normalizedConstraints.gatewayAgentId);
        if (gatewayAgentId) body.gateway_agent_id = gatewayAgentId;
        if (openaiAgentsTrace) body.openai_agents_trace = openaiAgentsTrace;
        return this._post('/api/execute', body);
    }

    /**
     * Preview which providers match a task (dry run — no cost, no invocation).
     *
     * @param {string} task - What you need
     * @param {Object} [constraints] - { max_cost, category, max_latency_ms, payment_network }
     * @returns {Promise<{task: string, matches: number, providers: Array}>}
     */
    async match(task, constraints = {}) {
        const params = new URLSearchParams({ task });
        if (constraints.max_cost) params.set('max_cost', String(constraints.max_cost));
        if (constraints.category) params.set('category', constraints.category);
        if (constraints.max_latency_ms) params.set('max_latency_ms', String(constraints.max_latency_ms));
        if (constraints.payment_network) params.set('payment_network', constraints.payment_network);
        return this._get(`/api/execute/match?${params.toString()}`);
    }

    /**
     * Check invocation status — for tracking execution and settlement.
     *
     * @param {string} invocationId - Invocation ID returned by execute() or invoke()
     * @returns {Promise<{invocation_id: string, status: string, settlement: Object}>}
     */
    async status(invocationId) {
        return this._get(`/api/execute/status/${invocationId}`);
    }

    // ── Core API Methods ─────────────────────────────────

    /**
     * Register a new agent on the marketplace.
     * Returns an API key — save it, shown only once.
     *
     * @param {Object} opts
     * @param {string} opts.name - Agent display name
     * @param {string} [opts.description] - What your agent does
     * @param {string} [opts.type] - 'buyer' | 'seller' | 'both'
     * @param {string} [opts.agent_uri] - Optional human-readable agent:// identity
     * @returns {Promise<{agent_id: string, api_key: string, signing_key: string}>}
     */
    async register(opts) {
        return this._post('/api/quickstart', opts);
    }

    /**
     * Get an agent profile by ID, agent:// URI, or bare URI slug.
     * @param {string} reference
     * @returns {Promise<Object>}
     */
    async getAgent(reference) {
        return this._get(`/api/agents/${encodeURIComponent(reference)}`);
    }

    /**
     * Resolve an agent reference into profile + capability metadata.
     * @param {string} reference - Agent ID, exact name, or agent:// URI
     * @param {Object} [opts] - { limit }
     * @returns {Promise<Object>}
     */
    async resolveAgent(reference, opts = {}) {
        const params = new URLSearchParams({ agent: reference });
        if (opts.limit) params.set('limit', String(opts.limit));
        return this._get(`/api/agents/resolve?${params.toString()}`);
    }

    /**
     * Claim or update a human-readable agent:// URI.
     * @param {string} agentId
     * @param {string} agentUri
     * @returns {Promise<Object>}
     */
    async claimAgentUri(agentId, agentUri) {
        return this._post(`/api/agents/${encodeURIComponent(agentId)}/uri`, { agent_uri: agentUri });
    }

    /**
     * Search for capabilities/services on the marketplace.
     *
     * @param {string} [query] - Search query (optional)
     * @param {Object} [filters]
     * @param {string} [filters.category] - Filter by category
     * @param {number} [filters.maxPrice] - Max price per call in USDC
     * @param {string} [filters.seller] - Seller ID or agent:// URI
     * @param {string} [filters.status] - 'active' (default)
     * @returns {Promise<Array<{id: string, name: string, description: string, price_per_unit: number, category: string}>>}
     */
    async search(query, filters = {}) {
        const params = new URLSearchParams();
        if (query) params.set('search', query);
        if (filters.category) params.set('category', filters.category);
        if (filters.maxPrice) params.set('max_price', filters.maxPrice);
        if (filters.seller) params.set('seller', filters.seller);
        if (filters.status) params.set('status', filters.status);
        const qs = params.toString();
        const data = await this._get(`/api/capabilities${qs ? '?' + qs : ''}`);
        return data.capabilities || data;
    }

    /**
     * Get a specific capability/listing by ID.
     *
     * @param {string} id - Capability ID
     * @returns {Promise<Object>}
     */
    async getCapability(id) {
        return this._get(`/api/capabilities/${id}`);
    }

    /**
     * Invoke a service on the marketplace by ID (direct invocation).
     * For task-based routing, use execute() instead.
     *
     * @param {string} id - Capability ID to invoke
     * @param {Object} [input] - Input payload for the service
     * @param {Object} [opts]
     * @param {number} [opts.maxCost] - Maximum USDC willing to pay
     * @param {string} [opts.quoteId] - Durable quote ID to consume (from client.quote())
     * @returns {Promise<{success: boolean, result: Object, cost: number, invocation_id: string}>}
     */
    async invoke(id, input = {}, opts = {}) {
        const body = { input };
        if (opts.maxCost) body.max_cost = opts.maxCost;
        if (opts.quoteId) body.quote_id = opts.quoteId;
        const gatewayAgentId = normalizeGatewayAgentIdOption(opts.gateway_agent_id || opts.gatewayAgentId);
        if (gatewayAgentId) body.gateway_agent_id = gatewayAgentId;
        const openaiAgentsTrace = resolveOpenAIAgentsTraceOption(
            opts.openai_agents_trace,
            opts.openaiAgentsTrace,
            opts.trace_context,
            opts.traceContext
        );
        if (openaiAgentsTrace) body.openai_agents_trace = openaiAgentsTrace;
        return this._post(`/api/invoke/${id}`, body);
    }

    /**
     * Set a default gateway agent identifier for subsequent requests.
     *
     * @param {string|null} gatewayAgentId
     * @returns {AgoragenticClient}
     */
    withGatewayAgent(gatewayAgentId) {
        this.gatewayAgentId = normalizeGatewayAgentIdOption(gatewayAgentId);
        return this;
    }

    // ── Reviews & Trust ─────────────────────────────────

    /**
     * Submit a review for a listing you've invoked.
     * One review per buyer per listing (updates if already exists).
     *
     * @param {string} listingId - Listing ID to review
     * @param {number} rating - Star rating (1-5, integer)
     * @param {string} [comment] - Optional comment (max 1000 chars)
     * @returns {Promise<{review_id: string, message: string}>}
     *
     * @example
     *   const result = await client.invoke('cap_xxx', { text: 'Hello' });
     *   await client.review('cap_xxx', 5, 'Fast and reliable!');
     */
    async review(listingId, rating, comment) {
        const body = { listing_id: listingId, rating };
        if (comment) body.comment = comment;
        return this._post('/api/reviews', body);
    }

    /**
     * Get reviews for a specific listing.
     *
     * @param {string} listingId - Listing ID
     * @returns {Promise<{listing_id: string, total_reviews: number, avg_rating: number, distribution: Object, reviews: Array}>}
     */
    async getReviews(listingId) {
        return this._get(`/api/reviews/listing/${listingId}`);
    }

    /**
     * Get listings you've used but haven't reviewed yet.
     * Requires API key.
     *
     * @returns {Promise<{pending: Array<{listing_id: string, listing_name: string, invocation_count: number}>, total: number}>}
     */
    async pendingReviews() {
        return this._get('/api/reviews/pending');
    }

    // ── Free Tools (no API key needed) ───────────────────

    /**
     * Echo test — verify connectivity (free).
     * @param {Object} input - Any JSON payload
     * @returns {Promise<Object>}
     */
    async echo(input) {
        return this._post('/api/tools/echo', input);
    }

    /**
     * Generate a UUID (free).
     * @returns {Promise<{uuid: string}>}
     */
    async uuid() {
        return this._post('/api/tools/uuid', {});
    }

    /**
     * Get a random fortune (free).
     * @returns {Promise<{fortune: string}>}
     */
    async fortune() {
        return this._post('/api/tools/fortune', {});
    }

    /**
     * Generate a color palette (free).
     * @param {Object} [opts]
     * @param {string} [opts.mood] - Mood/theme for the palette
     * @returns {Promise<{palette: Array}>}
     */
    async palette(opts = {}) {
        return this._post('/api/tools/palette', opts);
    }

    /**
     * Convert markdown to JSON (free).
     * @param {Object} opts
     * @param {string} opts.markdown - Markdown text to convert
     * @returns {Promise<Object>}
     */
    async mdToJson(opts) {
        return this._post('/api/tools/md-to-json', opts);
    }

    // ── Agent Vault (persistent storage) ─────────────────

    /**
     * List items in your Agent Vault.
     * @returns {Promise<Array>}
     */
    async vaultList() {
        return this._get('/api/inventory');
    }

    /**
     * Store an item in your Agent Vault.
     * @param {Object} item
     * @param {string} item.name - Item name
     * @param {string} item.type - Item type (skill, asset, nft, config)
     * @param {Object} item.data - Item data
     * @returns {Promise<Object>}
     */
    async vaultStore(item) {
        return this._post('/api/inventory', item);
    }

    /**
     * Get a specific vault item.
     * @param {string} id - Item ID
     * @returns {Promise<Object>}
     */
    async vaultGet(id) {
        return this._get(`/api/inventory/${id}`);
    }

    /**
     * Write persistent memory for your agent.
     * @param {Object} entry - { key, value, namespace, ttl_seconds, content_type }
     * @returns {Promise<Object>}
     */
    async memoryWrite(entry) {
        return this._post('/api/vault/memory', entry || {});
    }

    /**
     * Read or list persistent memory entries.
     * @param {Object} [opts] - { key, namespace, prefix }
     * @returns {Promise<Object>}
     */
    async memoryRead(opts = {}) {
        const params = new URLSearchParams();
        if (opts.key) params.set('key', opts.key);
        if (opts.namespace) params.set('namespace', opts.namespace);
        if (opts.prefix) params.set('prefix', opts.prefix);
        const qs = params.toString();
        return this._get(`/api/vault/memory${qs ? '?' + qs : ''}`);
    }

    /**
     * Search persistent memory by key, namespace, or value snippet.
     * @param {string|Object} query - Query string or options object
     * @param {Object} [opts] - { namespace, limit, includeValues }
     * @returns {Promise<Object>}
     */
    async memorySearch(query, opts = {}) {
        let searchQuery = query;
        let searchOpts = opts;
        if (query && typeof query === 'object') {
            searchOpts = query;
            searchQuery = query.query || query.q || '';
        }
        const params = new URLSearchParams();
        params.set('query', String(searchQuery || ''));
        if (searchOpts.namespace) params.set('namespace', searchOpts.namespace);
        if (searchOpts.limit) params.set('limit', String(searchOpts.limit));
        if (searchOpts.includeValues || searchOpts.include_values) params.set('include_values', 'true');
        return this._get(`/api/vault/memory/search?${params.toString()}`);
    }

    /**
     * Get the current learning queue built from reviews, incidents, and listing flags.
     * @param {Object} [opts] - { limit }
     * @returns {Promise<Object>}
     */
    async learningQueue(opts = {}) {
        const params = new URLSearchParams();
        if (opts.limit) params.set('limit', String(opts.limit));
        const qs = params.toString();
        return this._get(`/api/agents/me/learning-queue${qs ? '?' + qs : ''}`);
    }

    /**
     * Get the Agent OS learning and reputation summary.
     * @param {Object} [opts] - { limit, queueLimit, noteLimit }
     * @returns {Promise<Object>}
     */
    async learning(opts = {}) {
        const params = new URLSearchParams();
        if (opts.limit) params.set('limit', String(opts.limit));
        if (opts.queueLimit) params.set('queue_limit', String(opts.queueLimit));
        if (opts.noteLimit) params.set('note_limit', String(opts.noteLimit));
        const qs = params.toString();
        return this._get(`/api/commerce/learning${qs ? '?' + qs : ''}`);
    }

    /**
     * Generate approvable learning-note candidates from Agent OS history.
     * @param {Object} [input] - { limit, source_types }
     * @returns {Promise<Object>}
     */
    async learningCandidates(input = {}) {
        return this._post('/api/commerce/learning/candidates', input || {});
    }

    /**
     * Save a durable learning note into vault memory.
     * @param {Object} note - { title, lesson, source_type, source_id, tags, confidence, metadata }
     * @returns {Promise<Object>}
     */
    async saveLearningNote(note) {
        const response = await this._post('/api/commerce/learning/notes', note || {});
        if (response && response.learning_note && response.output === undefined) {
            return { ...response, output: response.learning_note };
        }
        return response;
    }

    /**
     * Export an approved marketplace listing as a reusable skill recipe.
     * @param {Object} [input] - { capability_id, listing_id, slug }
     * @returns {Promise<Object>}
     */
    async exportSkillRecipe(input = {}) {
        return this._post('/api/commerce/learning/skill-recipes/export', input || {});
    }

    /**
     * Import a skill recipe into vault memory.
     * @param {Object} [input] - { recipe, capability_id, listing_id, slug, key, namespace }
     * @returns {Promise<Object>}
     */
    async importSkillRecipe(input = {}) {
        return this._post('/api/commerce/learning/skill-recipes/import', input || {});
    }
    // ── Wallet & Payments ────────────────────────────────

    /**
     * Get your wallet balance and info.
     * @returns {Promise<{balance: number, currency: string, wallet_address: string}>}
     */
    async wallet() {
        return this._get('/api/wallet');
    }

    /**
     * Get autonomous wallet policy (spend caps, rate limits, seller/category rules).
     * @returns {Promise<Object>}
     */
    async walletPolicy() {
        return this._get('/api/wallet/policy');
    }

    /**
     * Update autonomous wallet policy.
     * @param {Object} policy
     * @returns {Promise<Object>}
     */
    async setWalletPolicy(policy) {
        return this._post('/api/wallet/policy', policy || {});
    }

    /**
     * Create a dedicated on-chain wallet for the authenticated agent.
     *
     * @param {Object} [input] - { wallet_type, name }
     * @returns {Promise<Object>}
     */
    async createOnchainWallet(input = {}) {
        return this._post('/api/crypto/wallet', input || {});
    }

    /**
     * Link an external Base wallet to the authenticated agent.
     *
     * @param {string|Object} walletAddressOrInput - wallet address or { wallet_address, wallet_type }
     * @param {string} [walletType] - Optional wallet type when the first argument is a string
     * @returns {Promise<Object>}
     */
    async connectWallet(walletAddressOrInput, walletType) {
        const body = (walletAddressOrInput && typeof walletAddressOrInput === 'object')
            ? { ...walletAddressOrInput }
            : { wallet_address: walletAddressOrInput };
        if (walletType && body.wallet_type === undefined) body.wallet_type = walletType;
        return this._post('/api/crypto/connect', body);
    }

    /**
     * Get on-chain wallet balances for the authenticated agent.
     *
     * @returns {Promise<Object>}
     */
    async onchainBalance() {
        return this._get('/api/crypto/balance');
    }

    /**
     * Get wallet funding instructions.
     * @param {number} [amount] - Suggested amount to deposit
     * @returns {Promise<Object>}
     */
    async purchase(amount) {
        return this._post('/api/wallet/purchase', amount ? { amount } : {});
    }

    /**
     * Verify a Base USDC funding transaction and credit the internal ledger immediately.
     *
     * @param {string|Object} txHashOrInput - tx hash or { tx_hash }
     * @returns {Promise<Object>}
     */
    async verifyPurchase(txHashOrInput) {
        const body = (txHashOrInput && typeof txHashOrInput === 'object')
            ? { ...txHashOrInput }
            : { tx_hash: txHashOrInput };
        return this._post('/api/wallet/purchase/verify', body);
    }

    /**
     * Request an on-chain payout of earned USDC.
     *
     * @param {number|Object} amountOrInput - amount or { amount, destination }
     * @param {string} [destination] - optional destination wallet
     * @returns {Promise<Object>}
     */
    async payout(amountOrInput, destination) {
        const body = (amountOrInput && typeof amountOrInput === 'object')
            ? { ...amountOrInput }
            : { amount: amountOrInput };
        if (destination && body.destination === undefined) body.destination = destination;
        return this._post('/api/crypto/payout', body);
    }

    /**
     * List recent payout records for the authenticated agent.
     *
     * @param {Object} [opts] - { limit }
     * @returns {Promise<Object>}
     */
    async payouts(opts = {}) {
        const params = new URLSearchParams();
        if (opts.limit) params.set('limit', String(opts.limit));
        const qs = params.toString();
        return this._get(`/api/crypto/payouts${qs ? '?' + qs : ''}`);
    }

    /**
     * Get wallet transaction history.
     * @param {Object} [filters] - { limit, type }
     * @returns {Promise<Object>}
     */
    async transactions(filters = {}) {
        const params = new URLSearchParams();
        if (filters.limit) params.set('limit', String(filters.limit));
        if (filters.type) params.set('type', filters.type);
        const qs = params.toString();
        return this._get(`/api/wallet/transactions${qs ? '?' + qs : ''}`);
    }

    /**
     * Get your agent dashboard (stats, history).
     * @returns {Promise<Object>}
     */
    async dashboard() {
        return this._get('/api/dashboard');
    }

    // ── Discovery & Info ─────────────────────────────────

    /**
     * Get marketplace statistics and health.
     * @returns {Promise<Object>}
     */
    async stats() {
        return this._get('/api/stats');
    }

    /**
     * Get x402 payment info and listings.
     * @returns {Promise<Object>}
     */
    async x402Info() {
        return this._get('/api/x402/info');
    }

    /**
     * List services available via x402 pay-per-call.
     * @returns {Promise<Array>}
     */
    async x402Listings() {
        const data = await this._get('/api/x402/listings');
        return data.listings || data;
    }

    /**
     * Get the richer machine-readable x402 discovery surface.
     * Useful for anonymous x402 buyers deciding whether to pay.
     * @returns {Promise<Object>}
     */
    async x402Discover() {
        return this._get('/api/x402/discover');
    }

    /**
     * Preview routed x402 matches for an anonymous wallet-native buyer.
     * Returns ranked providers plus a durable x402 execute quote for the top eligible match.
     *
     * @param {string} task
     * @param {Object} [constraints] - { max_cost, category, max_latency_ms, prefer_trusted, payment_network, payment_asset }
     * @returns {Promise<Object>}
     */
    async x402ExecuteMatch(task, constraints = {}) {
        const params = new URLSearchParams({ task });
        if (constraints.max_cost != null) params.set('max_cost', String(constraints.max_cost));
        if (constraints.category) params.set('category', constraints.category);
        if (constraints.max_latency_ms) params.set('max_latency_ms', String(constraints.max_latency_ms));
        if (constraints.prefer_trusted != null) params.set('prefer_trusted', constraints.prefer_trusted ? 'true' : 'false');
        if (constraints.payment_network) params.set('payment_network', constraints.payment_network);
        if (constraints.payment_asset) params.set('payment_asset', constraints.payment_asset);
        return this._get(`/api/x402/execute/match?${params.toString()}`);
    }

    /**
     * Execute a routed x402 quote.
     * If options.owsWallet is supplied, this method now fails fast with a clear
     * configuration error because current @open-wallet-standard/core packages do
     * not export the historical payRequest() helper.
     *
     * @param {string} quoteId
     * @param {Object} [input]
     * @param {Object} [opts]
     * @param {string} [opts.walletAddress]
     * @returns {Promise<Object>}
     */
    async x402Execute(quoteId, input = {}, opts = {}) {
        const body = { quote_id: quoteId, input };
        if (opts.walletAddress) body.wallet_address = opts.walletAddress;
        const gatewayAgentId = normalizeGatewayAgentIdOption(opts.gateway_agent_id || opts.gatewayAgentId);
        if (gatewayAgentId) body.gateway_agent_id = gatewayAgentId;
        const openaiAgentsTrace = resolveOpenAIAgentsTraceOption(
            opts.openai_agents_trace,
            opts.openaiAgentsTrace,
            opts.trace_context,
            opts.traceContext
        );
        if (openaiAgentsTrace) body.openai_agents_trace = openaiAgentsTrace;
        return this._post('/api/x402/execute', body);
    }

    /**
     * Build the canonical wallet-proof message for x402 receipt/history claims.
     *
     * @param {string} walletAddress
     * @returns {string}
     */
    buildX402ClaimProofMessage(walletAddress) {
        return buildX402ClaimProofMessage(walletAddress);
    }

    /**
     * Build an x402 claim proof payload, optionally signing it with a wallet/signer.
     *
     * @param {string} walletAddress
     * @param {Object} [signer]
     * @param {Object} [opts]
     * @returns {Promise<Object>}
     */
    async buildX402ClaimProof(walletAddress, signer, opts = {}) {
        const normalizedWalletAddress = normalizeWalletAddress(walletAddress);
        const message = opts.message || buildX402ClaimProofMessage(normalizedWalletAddress);
        const proof = { message };

        if (signer && typeof signer.signMessage === 'function') {
            proof.signature = await signer.signMessage(message);
        }

        return {
            wallet_address: normalizedWalletAddress,
            proof,
        };
    }

    /**
     * Read paid x402 receipts and vault history using a wallet proof.
     *
     * @param {Object} input
     * @returns {Promise<Object>}
     */
    async x402Claim(input = {}) {
        const body = {};
        if (input.walletAddress !== undefined && input.wallet_address === undefined) {
            body.wallet_address = input.walletAddress;
        }
        Object.assign(body, input);
        return this._post('/api/x402/claim', body);
    }

    /**
     * Convert an x402 wallet history into a full marketplace agent account.
     *
     * @param {Object} payload
     * @returns {Promise<Object>}
     */
    async x402Convert(payload = {}) {
        return this._post('/api/x402/convert', payload);
    }

    /**
     * Invoke a listing through the x402 gateway.
     * If options.owsWallet is supplied, this method now fails fast with a clear
     * configuration error because current @open-wallet-standard/core packages do
     * not export the historical payRequest() helper.
     *
     * @param {string} id - Listing ID
     * @param {Object} [input] - Input payload for the paid service
     * @param {Object} [opts]
     * @param {string} [opts.walletAddress] - Optional wallet hint for free x402 paths
     * @returns {Promise<Object>}
     */
    async x402Invoke(id, input = {}, opts = {}) {
        const body = { input };
        if (opts.walletAddress) body.wallet_address = opts.walletAddress;
        const gatewayAgentId = normalizeGatewayAgentIdOption(opts.gateway_agent_id || opts.gatewayAgentId);
        if (gatewayAgentId) body.gateway_agent_id = gatewayAgentId;
        const openaiAgentsTrace = resolveOpenAIAgentsTraceOption(
            opts.openai_agents_trace,
            opts.openaiAgentsTrace,
            opts.trace_context,
            opts.traceContext
        );
        if (openaiAgentsTrace) body.openai_agents_trace = openaiAgentsTrace;
        return this._post(`/api/x402/invoke/${id}`, body);
    }

    /**
     * Quote a task or listing before execution.
     * - Task mode: { task, max_cost?, category?, max_latency_ms?, prefer_trusted? } -> GET /api/execute/match
     * - Listing mode: capability ID or { capability_id | listing_id | slug, units } -> POST /api/commerce/quotes
     *
     * @param {string|Object} reference
     * @param {Object} [opts]
     * @returns {Promise<Object>}
     */
    async quote(reference, opts = {}) {
        if (reference && typeof reference === 'object' && reference.task) {
            return this.match(reference.task, {
                max_cost: reference.max_cost ?? opts.max_cost,
                category: reference.category ?? opts.category,
                max_latency_ms: reference.max_latency_ms ?? opts.max_latency_ms,
                prefer_trusted: reference.prefer_trusted ?? opts.prefer_trusted,
                payment_network: reference.payment_network ?? opts.payment_network,
            });
        }

        const body = (reference && typeof reference === 'object')
            ? { ...reference }
            : { capability_id: reference };
        if (opts.units && body.units === undefined) body.units = opts.units;
        if (opts.payment_network && body.payment_network === undefined) body.payment_network = opts.payment_network;
        if (opts.payment_asset && body.payment_asset === undefined) body.payment_asset = opts.payment_asset;
        return this._post('/api/commerce/quotes', body);
    }

    /**
     * Fetch a normalized receipt by rcpt_<invocation-id> or raw invocation ID.
     *
     * @param {string} receiptId
     * @returns {Promise<Object>}
     */
    async receipt(receiptId) {
        return this._get(`/api/commerce/receipts/${encodeURIComponent(receiptId)}`);
    }

    /**
     * Agent Commerce Interchange: governed lifecycle for agent-to-agent
     * commerce (capability cards, owner-reviewed mandates, gated transaction
     * plans, minted signed receipts). Control-plane only — live spend stays
     * on execute()/invoke(); the INVOKED transition binds a real invocation_id.
     */

    /** Create a capability card from a marketplace listing ID or owner metadata. */
    async interchangeCard(input) {
        const body = typeof input === 'string' ? { capability_id: input } : (input || {});
        return this._post('/api/commerce/interchange/capability-cards', body);
    }

    /** Read a stored capability card. */
    async interchangeGetCard(cardId) {
        return this._get(`/api/commerce/interchange/capability-cards/${encodeURIComponent(cardId)}`);
    }

    /** Create an owner-scoped mandate draft (string-only money budgets, idempotency_key required). */
    async interchangeCreateMandate(input) {
        return this._post('/api/commerce/interchange/mandates', input || {});
    }

    /** Owner approve/reject a mandate, producing signed evidence. */
    async interchangeReviewMandate(mandateId, decision, reason) {
        return this._post(`/api/commerce/interchange/mandates/${encodeURIComponent(mandateId)}/review`, { decision, reason });
    }

    /** Read committed/remaining mandate budget (string-only money). */
    async interchangeSpendStatus(mandateId) {
        return this._get(`/api/commerce/interchange/mandates/${encodeURIComponent(mandateId)}/spend-status`);
    }

    /** Create a transaction plan (state DISCOVERED). */
    async interchangeCreatePlan(input) {
        return this._post('/api/commerce/interchange/plans', input || {});
    }

    /** Read a transaction plan. */
    async interchangeGetPlan(planId) {
        return this._get(`/api/commerce/interchange/plans/${encodeURIComponent(planId)}`);
    }

    /**
     * Advance a plan exactly one gated state. Pass { invocation_id } when
     * advancing into INVOKED to bind a real invocation created by execute().
     */
    async interchangeAdvancePlan(planId, input) {
        return this._post(`/api/commerce/interchange/plans/${encodeURIComponent(planId)}/advance`, input || {});
    }

    /** Open a dispute on a plan with a bound invocation. */
    async interchangeOpenDispute(planId, reason) {
        return this._post(`/api/commerce/interchange/plans/${encodeURIComponent(planId)}/dispute`, { reason });
    }

    /** Read a minted interchange receipt. */
    async interchangeReceipt(receiptId) {
        return this._get(`/api/commerce/interchange/receipts/${encodeURIComponent(receiptId)}`);
    }

    /** Verify a minted receipt (hash + signature tamper detection; works anonymously). */
    async interchangeVerifyReceipt(input) {
        const body = typeof input === 'string' ? { receipt_id: input } : (input || {});
        return this._post('/api/commerce/interchange/receipts/verify', body);
    }

    /** Advisory interchange reputation summary for a provider (never platform trust). */
    async interchangeProviderReputation(providerId) {
        return this._get(`/api/commerce/interchange/providers/${encodeURIComponent(providerId)}/reputation`);
    }

    /**
     * Get the Agent OS operating account summary.
     *
     * @returns {Promise<Object>}
     */
    async account() {
        return this._get('/api/commerce/account');
    }

    /**
     * Get the Tumbler sandbox-to-production graduation summary.
     *
     * @returns {Promise<Object>}
     */
    async tumblerGraduation() {
        return this._get('/api/tumbler/graduation');
    }

    /**
     * Get the Agent OS portable identity summary.
     *
     * @returns {Promise<Object>}
     */
    async identity() {
        return this._get('/api/commerce/identity');
    }

    /**
     * Check a counterparty's portable identity and trust portability.
     *
     * @param {string|Object} reference - agent_ref string or { agent_ref | agent_id | agent_uri | wallet_address }
     * @returns {Promise<Object>}
     */
    async identityCheck(reference) {
        const body = (reference && typeof reference === 'object')
            ? { ...reference }
            : { agent_ref: reference };
        return this._post('/api/commerce/identity/check', body);
    }

    /**
     * Get the Agent OS procurement summary.
     *
     * @returns {Promise<Object>}
     */
    async procurement() {
        return this._get('/api/commerce/procurement');
    }

    /**
     * Preflight a purchase against policy, budget, and approval state.
     *
     * @param {string|Object} reference - capability_id or { capability_id | listing_id | slug, quoted_cost_usdc? }
     * @param {Object} [opts]
     * @param {number} [opts.quotedCostUsdc]
     * @returns {Promise<Object>}
     */
    async procurementCheck(reference, opts = {}) {
        const body = (reference && typeof reference === 'object')
            ? { ...reference }
            : { capability_id: reference };
        if (opts.quotedCostUsdc !== undefined && body.quoted_cost_usdc === undefined) {
            body.quoted_cost_usdc = opts.quotedCostUsdc;
        }
        return this._post('/api/commerce/procurement/check', body);
    }

    /**
     * Get the Agent OS accounting and reconciliation summary.
     *
     * @param {Object} [opts] - { days, limit }
     * @returns {Promise<Object>}
     */
    async reconciliation(opts = {}) {
        const params = new URLSearchParams();
        if (opts.days) params.set('days', String(opts.days));
        if (opts.limit) params.set('limit', String(opts.limit));
        const qs = params.toString();
        return this._get(`/api/commerce/reconciliation${qs ? '?' + qs : ''}`);
    }

    /**
     * Get purchase approvals — as buyer, supervisor, or both.
     *
     * @param {Object} [opts] - { role: 'buyer'|'supervisor'|'all', status: 'pending'|'approved'|'denied', limit }
     * @returns {Promise<Object>}
     */
    async approvals(opts = {}) {
        const params = new URLSearchParams();
        if (opts.role) params.set('role', opts.role);
        if (opts.status) params.set('status', opts.status);
        if (opts.limit) params.set('limit', String(opts.limit));
        const qs = params.toString();
        return this._get(`/api/approvals${qs ? '?' + qs : ''}`);
    }

    /**
     * Resolve (approve or deny) a pending purchase approval as supervisor.
     *
     * @param {string} approvalId - Approval ID to resolve
     * @param {string} decision - 'approve' or 'deny'
     * @param {string} [reason] - Optional reason
     * @returns {Promise<Object>}
     */
    async resolveApproval(approvalId, decision, reason) {
        const body = { decision };
        if (reason) body.reason = reason;
        return this._post(`/api/approvals/${encodeURIComponent(approvalId)}/resolve`, body);
    }

    /**
     * Get per-job spending reconciliation and receipt summary.
     *
     * @param {string} jobId - Job ID
     * @param {Object} [opts] - { limit }
     * @returns {Promise<Object>}
     */
    async jobReconciliation(jobId, opts = {}) {
        const params = new URLSearchParams();
        if (opts.limit) params.set('limit', String(opts.limit));
        const qs = params.toString();
        return this._get(`/api/jobs/${encodeURIComponent(jobId)}/reconciliation${qs ? '?' + qs : ''}`);
    }

    /**
     * Get recurring-work operating summary for the authenticated agent.
     *
     * @returns {Promise<Object>}
     */
    async jobsSummary() {
        return this._get('/api/jobs/summary');
    }

    /**
     * List scheduled execute jobs for the authenticated agent.
     *
     * @param {Object} [opts] - { status }
     * @returns {Promise<Object>}
     */
    async jobs(opts = {}) {
        const params = new URLSearchParams();
        if (opts.status) params.set('status', opts.status);
        const qs = params.toString();
        return this._get(`/api/jobs${qs ? '?' + qs : ''}`);
    }

    /**
     * Get one scheduled execute job.
     *
     * @param {string} jobId - Job ID
     * @returns {Promise<Object>}
     */
    async job(jobId) {
        return this._get(`/api/jobs/${encodeURIComponent(jobId)}`);
    }

    /**
     * View run history for one scheduled execute job.
     *
     * @param {string} jobId - Job ID
     * @param {Object} [opts] - { status, limit }
     * @returns {Promise<Object>}
     */
    async jobRuns(jobId, opts = {}) {
        const params = new URLSearchParams();
        if (opts.status) params.set('status', opts.status);
        if (opts.limit) params.set('limit', String(opts.limit));
        const qs = params.toString();
        return this._get(`/api/jobs/${encodeURIComponent(jobId)}/runs${qs ? '?' + qs : ''}`);
    }

    /**
     * View run history across all scheduled execute jobs.
     *
     * @param {Object} [opts] - { job_id, status, limit }
     * @returns {Promise<Object>}
     */
    async allJobRuns(opts = {}) {
        const params = new URLSearchParams();
        if (opts.job_id) params.set('job_id', opts.job_id);
        if (opts.status) params.set('status', opts.status);
        if (opts.limit) params.set('limit', String(opts.limit));
        const qs = params.toString();
        return this._get(`/api/job-runs${qs ? '?' + qs : ''}`);
    }

    /**
     * Get the Seller OS activation status for the authenticated agent.
     *
     * @returns {Promise<Object>}
     */
    async sellerStatus() {
        return this._get('/api/seller/status');
    }

    /**
     * Get demand recommendations for seller activation.
     *
     * @returns {Promise<Object>}
     */
    async sellerDemand() {
        return this._get('/api/seller/demand');
    }

    /**
     * Get listing health and seller runtime posture.
     *
     * @returns {Promise<Object>}
     */
    async sellerHealth() {
        return this._get('/api/seller/health');
    }

    /**
     * Get recent seller invocation and settlement activity.
     *
     * @returns {Promise<Object>}
     */
    async sellerActivity() {
        return this._get('/api/seller/activity');
    }

    /**
     * Get seller re-engagement recommendations.
     *
     * @returns {Promise<Object>}
     */
    async sellerRecommendations() {
        return this._get('/api/seller/recommendations');
    }

    /**
     * Get seller referral status and next action.
     *
     * @returns {Promise<Object>}
     */
    async sellerReferrals() {
        return this._get('/api/seller/referrals');
    }

    /**
     * Generate a no-spend Agent OS deployment preview.
     *
     * @param {Object} deployment - Deployment request with name, hosting_target, goals, source, budget, and safety policy
     * @returns {Promise<Object>}
     */
    async deployPreview(deployment = {}) {
        return this._post('/api/hosting/agent-os/preview', normalizeAgentOsDeploymentInput(deployment || {}));
    }

    /**
     * Record an Agent OS deployment request for review.
     *
     * @param {Object} deployment - Deployment request packet
     * @returns {Promise<Object>}
     */
    async createDeployment(deployment = {}) {
        return this._post('/api/hosting/agent-os/deployments', normalizeAgentOsDeploymentInput(deployment || {}));
    }

    /**
     * Read the public Agent OS launch catalog.
     *
     * @returns {Promise<Object>}
     */
    async deploymentCatalog() {
        return this._get('/api/hosting/agent-os/catalog');
    }

    /**
     * List Agent OS deployment requests for the authenticated agent.
     *
     * @returns {Promise<Object>}
     */
    async deployments() {
        return this._get('/api/hosting/agent-os/deployments');
    }

    /**
     * Fetch one Agent OS deployment request.
     *
     * @param {string} deploymentId - Deployment ID
     * @returns {Promise<Object>}
     */
    async deployment(deploymentId) {
        return this._get(`/api/hosting/agent-os/deployments/${encodeURIComponent(deploymentId)}`);
    }

    /**
     * Get hosted billing status for an Agent OS deployment.
     *
     * @param {string} deploymentId - Deployment ID
     * @returns {Promise<Object>}
     */
    async deploymentBilling(deploymentId) {
        return this._get(`/api/hosting/agent-os/deployments/${encodeURIComponent(deploymentId)}/billing`);
    }

    /**
     * Authorize hosted billing for an Agent OS deployment without charging immediately.
     *
     * @param {string} deploymentId - Deployment ID
     * @param {Object} [input] - Optional plan/billing metadata
     * @returns {Promise<Object>}
     */
    async authorizeDeploymentBilling(deploymentId, input = {}) {
        return this._post(`/api/hosting/agent-os/deployments/${encodeURIComponent(deploymentId)}/billing/authorize`, input || {});
    }

    /**
     * Get orchestration, runtime, and billing summary for an Agent OS deployment.
     *
     * @param {string} deploymentId - Deployment ID
     * @returns {Promise<Object>}
     */
    async deploymentOrchestration(deploymentId) {
        return this._get(`/api/hosting/agent-os/deployments/${encodeURIComponent(deploymentId)}/orchestration`);
    }

    /**
     * Update the goal contract for an Agent OS deployment.
     *
     * @param {string} deploymentId - Deployment ID
     * @param {Object} goals - Goal contract
     * @returns {Promise<Object>}
     */
    async updateDeploymentGoals(deploymentId, goals = {}) {
        return this._post(`/api/hosting/agent-os/deployments/${encodeURIComponent(deploymentId)}/goals`, goals || {});
    }

    /**
     * Record a bounded improvement proposal for an Agent OS deployment.
     *
     * @param {string} deploymentId - Deployment ID
     * @param {Object} signal - Failure/opportunity signal
     * @returns {Promise<Object>}
     */
    async proposeDeploymentImprovement(deploymentId, signal = {}) {
        return this._post(`/api/hosting/agent-os/deployments/${encodeURIComponent(deploymentId)}/improvement-proposals`, signal || {});
    }

    /**
     * Record a reviewed fulfillment gate for an Agent OS deployment.
     * No cloud, code, billing, inference, or marketplace changes are applied.
     *
     * @param {string} deploymentId - Deployment ID
     * @param {Object} input - Optional review metadata
     * @returns {Promise<Object>}
     */
    async reviewDeploymentFulfillment(deploymentId, input = {}) {
        return this._post(`/api/hosting/agent-os/deployments/${encodeURIComponent(deploymentId)}/fulfillment-review`, input || {});
    }

    /**
     * Record a no-spend canary plan for an Agent OS deployment.
     *
     * @param {string} deploymentId - Deployment ID
     * @param {Object} input - Optional canary planning metadata
     * @returns {Promise<Object>}
     */
    async createDeploymentCanaryPlan(deploymentId, input = {}) {
        return this._post(`/api/hosting/agent-os/deployments/${encodeURIComponent(deploymentId)}/canary-plan`, input || {});
    }

    /**
     * Record runtime smoke evidence for an Agent OS deployment.
     *
     * @param {string} deploymentId - Deployment ID
     * @param {Object} input - Optional smoke payload / adapter result
     * @returns {Promise<Object>}
     */
    async recordDeploymentSmokeResult(deploymentId, input = {}) {
        return this._post(`/api/hosting/agent-os/deployments/${encodeURIComponent(deploymentId)}/smoke-result`, input || {});
    }

    /**
     * Trigger hosted runtime provisioning for an Agent OS deployment.
     *
     * @param {string} deploymentId - Deployment ID
     * @param {Object} [input] - Optional hosted runtime parameters
     * @returns {Promise<Object>}
     */
    async provisionDeployment(deploymentId, input = {}) {
        return this._post(`/api/hosting/agent-os/deployments/${encodeURIComponent(deploymentId)}/provision`, input || {});
    }

    /**
     * Execute a live hosted runtime smoke check for an Agent OS deployment.
     *
     * @param {string} deploymentId - Deployment ID
     * @param {Object} [input] - Optional smoke controls
     * @returns {Promise<Object>}
     */
    async smokeDeployment(deploymentId, input = {}) {
        return this._post(`/api/hosting/agent-os/deployments/${encodeURIComponent(deploymentId)}/smoke`, input || {});
    }

    /**
     * Read the current activation gate for an Agent OS deployment.
     *
     * @param {string} deploymentId - Deployment ID
     * @returns {Promise<Object>}
     */
    async deploymentActivationGate(deploymentId) {
        return this._get(`/api/hosting/agent-os/deployments/${encodeURIComponent(deploymentId)}/activation-gate`);
    }

    /**
     * Trigger hosted runtime activation and optional listing publication.
     *
     * @param {string} deploymentId - Deployment ID
     * @param {Object} [input] - Optional activation payload
     * @returns {Promise<Object>}
     */
    async activateDeployment(deploymentId, input = {}) {
        return this._post(`/api/hosting/agent-os/deployments/${encodeURIComponent(deploymentId)}/activate`, input || {});
    }

    /**
     * Record what an agent intended versus what actually happened.
     * No cloud, code, billing, inference, marketplace, or paid execution side effects are applied.
     *
     * @param {string} deploymentId - Deployment ID
     * @param {Object} input - { intent, outcome }
     * @returns {Promise<Object>}
     */
    async reconcileDeploymentIntent(deploymentId, input = {}) {
        return this._post(`/api/hosting/agent-os/deployments/${encodeURIComponent(deploymentId)}/intent-reconciliation`, input || {});
    }

    /**
     * Run the owner-safe hosted launch flow for an Agent OS deployment.
     *
     * @param {string} deploymentId - Deployment ID
     * @param {Object} [input] - Optional billing/provision/activation controls
     * @returns {Promise<Object>}
     */
    async selfServeDeploymentLaunch(deploymentId, input = {}) {
        return this._post(`/api/hosting/agent-os/deployments/${encodeURIComponent(deploymentId)}/self-serve-launch`, input || {});
    }

    /**
     * Build a no-spend readiness report for either a proposed deployment packet
     * or an existing Agent OS deployment request.
     *
     * @param {Object|string} input - { deploymentId } or { deployment }
     * @returns {Promise<Object>}
     */
    async deploymentReadiness(input = {}) {
        const normalizedInput = typeof input === 'string'
            ? { deploymentId: input }
            : (input || {});
        const deploymentId = normalizedInput.deploymentId || normalizedInput.deployment_id || normalizedInput.id || null;
        const catalogResponse = await this.deploymentCatalog();

        if (deploymentId) {
            const [deploymentResponse, treasury, billingResponse, activationGateResponse] = await Promise.all([
                this.deployment(deploymentId),
                this.deploymentTreasuryPlan(deploymentId).catch(() => null),
                this.deploymentBilling(deploymentId).catch(() => null),
                this.deploymentActivationGate(deploymentId).catch(() => null),
            ]);
            return buildDeploymentReadinessReport({
                catalogResponse,
                deploymentId,
                deploymentResponse,
                treasury,
                billingResponse,
                activationGateResponse,
            });
        }

        const deployment = normalizeAgentOsDeploymentInput(
            normalizedInput.deployment || normalizedInput.packet || normalizedInput.request || normalizedInput
        );
        const previewResponse = await this.deployPreview(deployment);
        return buildDeploymentReadinessReport({
            catalogResponse,
            previewInput: deployment,
            previewResponse,
        });
    }

    /**
     * Build an owner-facing treasury summary for one Agent OS deployment.
     * Prefer the canonical server-side route when available, with a local
     * fallback for older deployments or older server versions.
     *
     * @param {string} deploymentId - Deployment ID
     * @returns {Promise<Object>}
     */
    async deploymentTreasuryPlan(deploymentId) {
        const route = `/api/hosting/agent-os/deployments/${encodeURIComponent(deploymentId)}/treasury`;
        try {
            const response = await this._get(route);
            return response?.treasury || response;
        } catch (err) {
            if (err.status && err.status !== 404) {
                throw err;
            }
            const [deploymentResponse, wallet, onchainBalance] = await Promise.all([
                this.deployment(deploymentId),
                this.wallet(),
                this.onchainBalance().catch(() => null),
            ]);

            return buildDeploymentTreasuryPlanSummary({
                deploymentId,
                deploymentResponse,
                wallet,
                onchainBalance,
            });
        }
    }

    /**
     * Get funding instructions for a specific Agent OS deployment.
     * Uses the deployment treasury plan to suggest an amount when one is not supplied.
     *
     * @param {string} deploymentId - Deployment ID
     * @param {Object} [opts] - { amount }
     * @returns {Promise<Object>}
     */
    async deploymentFundingInstructions(deploymentId, opts = {}) {
        const route = `/api/hosting/agent-os/deployments/${encodeURIComponent(deploymentId)}/treasury/fund`;
        try {
            return await this._post(route, removeUndefinedFields({
                amount: Number.isFinite(Number(opts.amount)) ? Number(opts.amount) : undefined,
            }));
        } catch (err) {
            if (err.status && err.status !== 404) {
                throw err;
            }
            const treasury = await this.deploymentTreasuryPlan(deploymentId);
            const requestedAmount = Number.isFinite(Number(opts.amount))
                ? Number(opts.amount)
                : treasury.reserve.suggested_top_up_usdc;
            const funding = await this.purchase(requestedAmount);
            return {
                deployment_id: deploymentId,
                treasury,
                funding,
            };
        }
    }

    /**
     * Verify a funding transaction for a deployment and return the refreshed treasury summary.
     *
     * @param {string} deploymentId - Deployment ID
     * @param {string|Object} txHashOrInput - tx hash or { tx_hash }
     * @returns {Promise<Object>}
     */
    async verifyDeploymentFunding(deploymentId, txHashOrInput) {
        const route = `/api/hosting/agent-os/deployments/${encodeURIComponent(deploymentId)}/treasury/verify-funding`;
        const body = typeof txHashOrInput === 'string'
            ? { tx_hash: txHashOrInput }
            : (txHashOrInput || {});
        try {
            return await this._post(route, body);
        } catch (err) {
            if (err.status && err.status !== 404) {
                throw err;
            }
            const verification = await this.verifyPurchase(txHashOrInput);
            const treasury = await this.deploymentTreasuryPlan(deploymentId).catch(() => null);
            return {
                deployment_id: deploymentId,
                verification,
                treasury,
            };
        }
    }

    // ── List a Service (Seller) ──────────────────────────

    /**
     * List a new capability/service on the marketplace.
     * Requires API key and staked USDC ($1).
     *
     * @param {Object} capability
     * @param {string} capability.name - Service name
     * @param {string} capability.description - What it does
     * @param {string} capability.category - Category
     * @param {number} capability.price_per_unit - Price in USDC
     * @param {string} capability.endpoint_url - Your service endpoint
     * @param {string} [capability.input_schema] - JSON schema for input
     * @param {string} [capability.output_schema] - JSON schema for output
     * @returns {Promise<Object>}
     */
    async listService(capability) {
        return this._post('/api/capabilities', capability);
    }

    // ── Internal HTTP helpers ────────────────────────────

    async _get(path) {
        return this._request('GET', path);
    }

    async _post(path, body) {
        return this._request('POST', path, body);
    }

    async _request(method, path, body) {
        const bridge = this._getLangSmithBridge();
        const traceInput = summarizeTraceInput(method, path, body, this.baseUrl, !!this.apiKey);

        if (bridge && typeof bridge.traceable === 'function') {
            const tracedRequest = bridge.traceable(
                async () => this._performRequest(method, path, body),
                this._createLangSmithTraceConfig(method, path)
            );
            return tracedRequest(traceInput);
        }

        return this._performRequest(method, path, body);
    }

    async _performRequest(method, path, body) {
        const url = `${this.baseUrl}${path}`;
        const headers = {
            'Content-Type': 'application/json',
            'User-Agent': `agoragentic-node/${SDK_VERSION}`,
        };
        if (this.apiKey) {
            headers['Authorization'] = `Bearer ${this.apiKey}`;
            headers['X-API-Key'] = this.apiKey; // Backwards compat
        }
        if (this.gatewayAgentId) {
            headers[GATEWAY_AGENT_HEADER] = this.gatewayAgentId;
        }

        const traceHeaders = this._buildLangSmithHeaders();
        if (traceHeaders) {
            Object.assign(headers, traceHeaders);
        }

        const payload = body ? JSON.stringify(body) : undefined;

        const isPayableX402Request = method !== 'GET'
            && (path === '/api/x402/execute' || path.startsWith('/api/x402/invoke/'));

        if (this.owsWallet && isPayableX402Request) {
            try {
                const { payRequest } = require('@open-wallet-standard/core');
                if (typeof payRequest !== 'function') {
                    const err = new Error('@open-wallet-standard/core does not export payRequest in current releases. Use @x402/fetch with a funded Base USDC signer, Python x402[httpx], or the OWS CLI/signing primitives to produce a PAYMENT-SIGNATURE.');
                    err.code = 'ows_pay_request_unavailable';
                    err.status = 400;
                    throw err;
                }
                const paid = await payRequest(url, this.owsWallet, {
                    method,
                    headers,
                    body: payload,
                });

                if (paid && typeof paid.json === 'function') {
                    const data = await paid.json().catch(() => ({}));
                    if (!paid.ok) {
                        const err = new Error(data.message || data.error || `HTTP ${paid.status}`);
                        err.status = paid.status;
                        err.code = data.error;
                        err.response = data;
                        throw err;
                    }
                    return data;
                }

                return paid;
            } catch (err) {
                const missingModule = err && (err.code === 'MODULE_NOT_FOUND' || String(err.message || '').includes('@open-wallet-standard/core'));
                if (err && err.code === 'ows_pay_request_unavailable') throw err;
                if (!missingModule) throw err;
                if (!this._warnedMissingOws) {
                    console.warn('[agoragentic] options.owsWallet provided, but @open-wallet-standard/core is not installed. Falling back to standard fetch.');
                    this._warnedMissingOws = true;
                }
            }
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeout);

        try {
            const res = await fetch(url, {
                method,
                headers,
                body: payload,
                signal: controller.signal,
            });

            clearTimeout(timeout);

            const data = await res.json().catch(() => ({}));

            if (!res.ok) {
                const err = new Error(data.message || data.error || `HTTP ${res.status}`);
                err.status = res.status;
                err.code = data.error;
                err.response = data;
                throw err;
            }

            return data;
        } catch (err) {
            clearTimeout(timeout);
            if (err.name === 'AbortError') {
                const timeoutErr = new Error(`Request timed out after ${this.timeout}ms`);
                timeoutErr.code = 'TIMEOUT';
                throw timeoutErr;
            }
            throw err;
        }
    }

    _getLangSmithBridge() {
        if (!this.langsmith.enabled) {
            return null;
        }

        if (this.langsmith.traceable && this.langsmith.getCurrentRunTree) {
            return {
                traceable: this.langsmith.traceable,
                getCurrentRunTree: this.langsmith.getCurrentRunTree,
            };
        }

        if (this._langsmithBridge !== undefined) {
            return this._langsmithBridge;
        }

        try {
            const langsmith = require(LANGSMITH_TRACEABLE_MODULE);
            this._langsmithBridge = {
                traceable: langsmith.traceable,
                getCurrentRunTree: langsmith.getCurrentRunTree,
            };
        } catch (err) {
            this._langsmithBridge = null;
            const missingModule = err && (
                err.code === 'MODULE_NOT_FOUND'
                || String(err.message || '').includes(LANGSMITH_TRACEABLE_MODULE)
            );
            if (missingModule && !this._warnedMissingLangSmith) {
                console.warn('[agoragentic] options.langsmith enabled, but langsmith is not installed. Install "langsmith" in your app to enable tracing.');
                this._warnedMissingLangSmith = true;
            } else if (!missingModule) {
                throw err;
            }
        }

        return this._langsmithBridge;
    }

    _buildLangSmithHeaders() {
        const bridge = this._getLangSmithBridge();
        if (!bridge || typeof bridge.getCurrentRunTree !== 'function') {
            return null;
        }

        try {
            const currentRunTree = bridge.getCurrentRunTree();
            if (!currentRunTree || typeof currentRunTree.toHeaders !== 'function') {
                return null;
            }
            return currentRunTree.toHeaders();
        } catch {
            return null;
        }
    }

    _createLangSmithTraceConfig(method, path) {
        const traceInput = summarizeTraceInput(method, path, undefined, this.baseUrl, !!this.apiKey);
        const config = {
            name: inferLangSmithOperationName(method, traceInput.path, this.langsmith.operationPrefix),
            run_type: 'tool',
            project_name: this.langsmith.projectName,
            tags: Array.isArray(this.langsmith.tags) && this.langsmith.tags.length > 0
                ? this.langsmith.tags
                : undefined,
            metadata: {
                sdk: 'agoragentic-node',
                sdk_version: SDK_VERSION,
                base_url: this.baseUrl,
                method,
                path: traceInput.path,
                ...this.langsmith.metadata,
            },
            processInputs: (inputs) => sanitizeTraceInputs(inputs),
            processOutputs: (outputs) => sanitizeTraceOutputs(outputs),
        };

        return removeUndefinedFields(config);
    }
}

/**
 * Create an Agoragentic client.
 *
 * @param {Object|string} options - Options object or API key string
 * @returns {AgoragenticClient}
 *
 * @example
 * // With API key
 * const client = require('agoragentic')('amk_...');
 *
 * // With options
 * const client = require('agoragentic')({ apiKey: 'amk_...' });
 *
 * // Without API key (free tools only)
 * const client = require('agoragentic')();
 */
function agoragentic(options) {
    if (typeof options === 'string') {
        return new AgoragenticClient({ apiKey: options });
    }
    return new AgoragenticClient(options || {});
}

// Attach class for advanced usage
agoragentic.AgoragenticClient = AgoragenticClient;
agoragentic.buildX402ClaimProofMessage = buildX402ClaimProofMessage;
agoragentic.buildNativeHarnessDemoDeployment = buildNativeHarnessDemoDeployment;
agoragentic.buildDeploymentReadinessReport = buildDeploymentReadinessReport;
agoragentic.normalizeAgentOsDeploymentInput = normalizeAgentOsDeploymentInput;
agoragentic.validateNativeHarnessDemoSource = validateNativeHarnessDemoSource;
agoragentic.default = agoragentic;

module.exports = agoragentic;

function toFiniteNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function getNestedValue(value, path, fallback = undefined) {
    if (!value || !Array.isArray(path)) {
        return fallback;
    }
    let current = value;
    for (const key of path) {
        if (current == null || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, key)) {
            return fallback;
        }
        current = current[key];
    }
    return current === undefined ? fallback : current;
}

function mergePlainObjects(...values) {
    return values.reduce((acc, value) => {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            Object.assign(acc, value);
        }
        return acc;
    }, {});
}

function isPlainObject(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeAgentOsDeploymentInput(value = {}) {
    if (!isPlainObject(value)) {
        return value;
    }

    const directPreviewRequest = isPlainObject(value.agent_os_preview_request)
        ? value.agent_os_preview_request
        : null;
    if (directPreviewRequest) {
        return attachLocalContextHandoff(
            directPreviewRequest,
            buildMicroEcfHandoff(value)
        );
    }

    const nestedImport = isPlainObject(value.agent_os_import)
        ? value.agent_os_import
        : null;
    const directEcfImport = value.schema_version === 'ecf-core.agent-os-import.v1'
        || value.schema === 'ecf-core.agent-os-import.v1'
        || value.import_mode === 'preview_only';
    if (nestedImport || directEcfImport) {
        const importPacket = nestedImport || value;
        const explicitRequest = isPlainObject(importPacket.agent_os_preview_request)
            ? importPacket.agent_os_preview_request
            : (isPlainObject(value.agent_os_preview_request) ? value.agent_os_preview_request : null);
        const handoff = buildEcfCoreHandoff(importPacket);
        return attachLocalContextHandoff(
            explicitRequest || buildEcfCorePreviewRequest(handoff),
            handoff
        );
    }

    return value;
}

function attachLocalContextHandoff(deployment, handoff) {
    if (!isPlainObject(deployment) || !isPlainObject(handoff)) {
        return deployment;
    }
    const deploymentPacket = isPlainObject(deployment.deployment_packet)
        ? { ...deployment.deployment_packet }
        : {};
    return {
        ...deployment,
        deployment_packet: {
            ...deploymentPacket,
            local_context_handoff: handoff,
        },
    };
}

function buildMicroEcfHandoff(packet = {}) {
    const publicBoundary = isPlainObject(packet.public_boundary) ? packet.public_boundary : {};
    const artifacts = normalizeArtifactRefs(
        packet.micro_ecf_artifacts
        || packet.artifacts
        || packet.agent_os_export?.artifacts
        || {}
    );
    return removeUndefinedFields({
        source: 'micro_ecf',
        context_layer: 'micro_ecf',
        schema: packet.schema || null,
        artifacts,
        no_spend_boundary: publicBoundary.no_spend_export === true,
        live_deploy_allowed: false,
        private_internals_excluded: !(
            publicBoundary.full_ecf_runtime_included === true
            || publicBoundary.router_ranking_included === true
            || publicBoundary.settlement_internals_included === true
            || publicBoundary.enterprise_governance_internals_included === true
        ),
        public_boundary: summarizeHandoffBoundary(publicBoundary),
    });
}

function buildEcfCoreHandoff(importPacket = {}) {
    const boundary = isPlainObject(importPacket.boundary) ? importPacket.boundary : {};
    const artifacts = normalizeEcfCoreArtifactRefs(importPacket);
    const previewOnly = importPacket.import_mode === 'preview_only'
        && importPacket.live_deploy_allowed === false;
    const privateInternalsExcluded = boundary.includes_full_ecf_private_internals === false;
    const noHostedRuntime = boundary.includes_hosted_runtime === false;
    const noWalletSettlement = boundary.includes_wallet_or_settlement === false;
    const noMarketplaceRouting = boundary.includes_marketplace_routing === false;

    return removeUndefinedFields({
        source: 'ecf_core',
        context_layer: 'ecf_core',
        schema: importPacket.schema_version || importPacket.schema || null,
        import_mode: importPacket.import_mode || null,
        artifacts,
        required_files: Array.isArray(importPacket.required_files) ? importPacket.required_files.slice() : [],
        acceptance_checks: Array.isArray(importPacket.acceptance_checks) ? importPacket.acceptance_checks.slice() : [],
        evidence: isPlainObject(importPacket.evidence) ? { ...importPacket.evidence } : undefined,
        no_spend_boundary: previewOnly && noHostedRuntime && noWalletSettlement && noMarketplaceRouting,
        live_deploy_allowed: importPacket.live_deploy_allowed === true,
        private_internals_excluded: privateInternalsExcluded,
        public_boundary: {
            no_spend_export: previewOnly,
            cloud_provisioning: noHostedRuntime ? false : true,
            marketplace_publication: noMarketplaceRouting ? false : true,
            full_ecf_runtime_included: privateInternalsExcluded ? false : true,
            wallet_or_settlement_included: noWalletSettlement ? false : true,
        },
    });
}

function normalizeArtifactRefs(artifacts = {}) {
    if (!isPlainObject(artifacts)) {
        return {};
    }
    return removeUndefinedFields({
        context_packet: artifacts.context_packet || artifacts.contextPacket,
        source_map: artifacts.source_map || artifacts.sourceMap,
        policy_summary: artifacts.policy_summary || artifacts.policySummary,
        grounding_eval: artifacts.grounding_eval || artifacts.groundingEval,
        deployment_preview: artifacts.deployment_preview || artifacts.deploymentPreview,
        agent_os_harness: artifacts.agent_os_harness || artifacts.agentOsHarness,
        agent_os_handoff: artifacts.agent_os_handoff || artifacts.agentOsHandoff,
        agent_os_import: artifacts.agent_os_import || artifacts.agentOsImport,
    });
}

function normalizeEcfCoreArtifactRefs(importPacket = {}) {
    const requiredFiles = Array.isArray(importPacket.required_files) ? importPacket.required_files : [];
    const declared = new Set(requiredFiles);
    const evidence = isPlainObject(importPacket.evidence) ? importPacket.evidence : {};
    return normalizeArtifactRefs({
        context_packet: declared.has('context-packet.json') ? 'context-packet.json' : null,
        source_map: declared.has('source-map.json') ? 'source-map.json' : null,
        policy_summary: declared.has('policy-summary.json') ? 'policy-summary.json' : null,
        deployment_preview: declared.has('deployment-preview.json') ? 'deployment-preview.json' : null,
        agent_os_harness: declared.has('agent-os-harness.json') ? 'agent-os-harness.json' : null,
        agent_os_handoff: declared.has('agent-os-handoff.json') ? 'agent-os-handoff.json' : null,
        agent_os_import: 'agent-os-import.json',
        grounding_eval: evidence.grounding_eval || (declared.has('grounding-eval.json') ? 'grounding-eval.json' : null),
    });
}

function summarizeHandoffBoundary(boundary = {}) {
    return removeUndefinedFields({
        no_spend_export: boundary.no_spend_export,
        cloud_provisioning: boundary.cloud_provisioning,
        marketplace_publication: boundary.marketplace_publication,
        full_ecf_runtime_included: boundary.full_ecf_runtime_included,
        router_ranking_included: boundary.router_ranking_included,
        settlement_internals_included: boundary.settlement_internals_included,
        enterprise_governance_internals_included: boundary.enterprise_governance_internals_included,
        learning_memory_review_only: boundary.learning_memory_review_only,
        memory_can_authorize_live_actions: boundary.memory_can_authorize_live_actions,
        memory_auto_execute: boundary.memory_auto_execute,
    });
}

function buildEcfCorePreviewRequest(handoff) {
    return {
        name: 'ECF Core Agent OS Import',
        hosting_target: 'self_hosted_http',
        template_id: 'ecf_core_context_preview',
        runtime_lane: 'customer_managed_http_runtime',
        exposure_mode: 'private_only',
        goals: {
            primary_goal: 'Review an ECF Core context-governance import in Agent OS preview.',
            budget: {
                max_daily_usdc: 0,
                approval_required_above_usdc: 0,
                recommended_start_reserve_usdc: 0,
            },
        },
        safety_policy: {
            first_proof_required: true,
            context_policy: {
                allowed_sources: ['ecf_core_context_packet'],
                denied_sources: ['secrets', 'wallet_keys', 'full_ecf_private_internals'],
            },
            tool_policy: {
                allowed_tools: ['read_only_preview'],
                denied_tools: ['wallet_spend', 'public_publish', 'external_write', 'deploy_runtime'],
            },
            approval_policy: {
                autonomous: ['read', 'summarize', 'preview'],
                human_gated: ['deploy', 'spend', 'publish', 'expose_api', 'change_secrets'],
            },
            memory_policy: {
                write_gate: 'after_owner_review',
                secret_storage: 'reference_only',
            },
            swarm_policy: {
                max_agents: 1,
                delegation: 'disabled_for_preview',
            },
        },
        deployment_packet: {
            schema: 'ecf-core.agent-os-import.v1',
            source: 'ecf_core',
            harness_schema: 'ecf-core.agent-os-harness.v1',
            import_mode: handoff.import_mode || 'preview_only',
        },
    };
}

function mergeDeploymentControlPlaneShapes(value = {}) {
    const root = value && typeof value === 'object' ? value : {};
    const summary = root.agent_os_deploy && typeof root.agent_os_deploy === 'object'
        ? root.agent_os_deploy
        : {};
    const detail = root.deployment && typeof root.deployment === 'object'
        ? root.deployment
        : ((!root.agent_os_deploy && !root.deployment && typeof root === 'object') ? root : {});

    return {
        ...detail,
        ...summary,
        goal_contract: summary.goal_contract || detail.goal_contract || getNestedValue(detail, ['deployment_plan', 'goal_contract'], {}),
        launch_contract: summary.launch_contract || detail.launch_contract || getNestedValue(detail, ['deployment_plan', 'launch_contract'], {}),
        deployment_contract: summary.deployment_contract || detail.deployment_contract || {},
        deployment_packet: summary.deployment_packet || detail.deployment_packet || getNestedValue(detail, ['deployment_plan', 'deployment_packet'], {}),
        provider_state: detail.provider_state || summary.provider_state || {},
        provider_fulfillment: detail.provider_fulfillment
            || summary.provider_fulfillment
            || detail.provider_fulfillment_planned
            || summary.provider_fulfillment_planned
            || {},
        source: detail.source
            || getNestedValue(detail, ['deployment_plan', 'deployment_packet', 'request', 'source'], {})
            || {},
        self_serve_launch: summary.self_serve_launch || detail.self_serve_launch || {},
        billing: summary.billing || detail.billing || {},
        activation_gate: summary.activation_gate || detail.activation_gate || {},
    };
}

function normalizeDeploymentTreasurySource(deploymentResponse = {}) {
    return mergeDeploymentControlPlaneShapes(deploymentResponse);
}

function buildDeploymentTreasuryPlanSummary({
    deploymentId,
    deploymentResponse = {},
    wallet = {},
    onchainBalance = null,
}) {
    const deployment = normalizeDeploymentTreasurySource(deploymentResponse);
    const contract = deployment.deployment_contract || {};
    const launch = deployment.launch_contract || {};
    const billing = deployment.billing || {};
    const funding = contract.funding_policy || {};
    const walletTopology = contract.wallet_topology || launch.wallet_topology || {};

    const requestedAgents = Math.max(
        1,
        toFiniteNumber(
            getNestedValue(launch, ['deployment_group', 'requested_agents'])
                || getNestedValue(walletTopology, ['execution_wallets', 'recommended_agent_wallet_count']),
            1
        )
    );
    const recommendedExecutionWalletCount = Math.max(
        1,
        toFiniteNumber(
            getNestedValue(walletTopology, ['execution_wallets', 'recommended_agent_wallet_count']),
            requestedAgents
        )
    );
    const monthlyBaseUsdc = Math.max(
        0,
        toFiniteNumber(billing.monthly_base_usdc ?? funding.monthly_base_usdc, 0)
    );
    const initialBudgetUsdc = Math.max(0, toFiniteNumber(funding.initial_budget_usdc, 0));
    const maxDailySpendUsdc = Math.max(0, toFiniteNumber(funding.max_daily_spend_usdc, 0));
    const recommendedStartReserveUsdc = Math.max(
        0,
        Number((monthlyBaseUsdc + initialBudgetUsdc).toFixed(2))
    );
    const internalLedgerBalanceUsdc = Math.max(
        0,
        toFiniteNumber(wallet.balance ?? wallet.balance_usdc, 0)
    );
    const currentShortfallUsdc = Math.max(
        0,
        Number((recommendedStartReserveUsdc - internalLedgerBalanceUsdc).toFixed(2))
    );
    const suggestedTopUpUsdc = currentShortfallUsdc > 0
        ? currentShortfallUsdc
        : Math.max(1, Number((monthlyBaseUsdc || initialBudgetUsdc || 1).toFixed(2)));

    return {
        schema: 'agoragentic.agent-os.deployment-treasury-plan.v1',
        deployment_id: deployment.id || deployment.deployment_id || deploymentId || null,
        deployment_name: deployment.name || contract.agent_name || null,
        deployment_status: deployment.status || contract.status || null,
        owner_wallet: {
            linked_wallet_address: wallet.wallet_address || wallet.connected_wallet || contract.owner_wallet || null,
            onchain_usdc_balance: onchainBalance
                ? toFiniteNumber(
                    onchainBalance.usdc_balance
                    ?? onchainBalance.balances?.usdc
                    ?? onchainBalance.usdc,
                    0
                )
                : null,
            onchain_eth_balance: onchainBalance
                ? toFiniteNumber(
                    onchainBalance.eth_balance
                    ?? onchainBalance.balances?.eth
                    ?? onchainBalance.eth,
                    0
                )
                : null,
        },
        internal_ledger: {
            balance_usdc: internalLedgerBalanceUsdc,
            withdrawable_balance_usdc: Math.max(
                0,
                toFiniteNumber(wallet.withdrawable_balance ?? wallet.withdrawable_balance_usdc, 0)
            ),
            total_earned_usdc: Math.max(
                0,
                toFiniteNumber(wallet.total_earned ?? wallet.total_earned_usdc, 0)
            ),
            total_spent_usdc: Math.max(
                0,
                toFiniteNumber(wallet.total_spent ?? wallet.total_spent_usdc, 0)
            ),
        },
        wallet_model: {
            architecture: String(walletTopology.architecture || 'owner_wallet_workspace_treasury_agent_wallets'),
            treasury_status: String(walletTopology.workspace_treasury?.status || 'shared_treasury_required'),
            funding_model: String(walletTopology.workspace_treasury?.funding_model || 'prefunded_internal_ledger'),
            top_up_policy: String(funding.top_up_policy || 'manual'),
            execution_wallet_strategy: String(walletTopology.execution_wallets?.strategy || 'per_agent_wallets_with_shared_treasury'),
            recommended_execution_wallet_count: recommendedExecutionWalletCount,
        },
        reserve: {
            requested_agents: requestedAgents,
            monthly_base_usdc: monthlyBaseUsdc,
            initial_budget_usdc: initialBudgetUsdc,
            max_daily_spend_usdc: maxDailySpendUsdc,
            recommended_start_reserve_usdc: recommendedStartReserveUsdc,
            current_shortfall_usdc: currentShortfallUsdc,
            suggested_top_up_usdc: suggestedTopUpUsdc,
        },
        routes: {
            create_wallet: 'POST /api/crypto/wallet',
            connect_wallet: 'POST /api/crypto/connect',
            fund: 'POST /api/wallet/purchase',
            verify_funding: 'POST /api/wallet/purchase/verify',
            payout: 'POST /api/crypto/payout',
        },
    };
}

function normalizeCatalogSource(catalogResponse = {}) {
    const catalog = catalogResponse.catalog || catalogResponse;
    return catalog && typeof catalog === 'object' ? catalog : {};
}

function normalizeDeploymentReadinessSource(value = {}) {
    return mergeDeploymentControlPlaneShapes(value);
}

function buildDeploymentReadinessReport({
    catalogResponse = {},
    previewInput = null,
    previewResponse = null,
    deploymentId = null,
    deploymentResponse = null,
    treasury = null,
    billingResponse = null,
    activationGateResponse = null,
} = {}) {
    const catalog = normalizeCatalogSource(catalogResponse);
    const controlPlane = catalog.control_plane_boundaries || {};
    const preview = previewResponse?.preview || previewResponse || null;
    const deployment = normalizeDeploymentReadinessSource(deploymentResponse || {});
    const previewRequest = preview?.request || {};
    const previewInputRequest = previewInput && typeof previewInput === 'object'
        ? previewInput
        : {};
    const billing = billingResponse?.billing || billingResponse || {};
    const activationGate = activationGateResponse?.activation_gate || activationGateResponse || {};
    const mode = preview ? 'preview' : 'deployment';
    const launch = preview?.launch_contract || deployment.launch_contract || {};
    const template = launch.template || {};
    const runtimeLane = launch.runtime_lane || {};
    const approvalLane = launch.approval_lane || {};
    const deploymentContract = preview?.deployment_contract || deployment.deployment_contract || {};
    const providerFulfillment = preview?.provider_fulfillment || deployment.provider_fulfillment || {};
    const providerState = mergePlainObjects(
        deployment.provider_state,
        mode === 'preview' ? previewInputRequest.provider_state : null,
        preview?.provider_state
    );
    const source = mergePlainObjects(
        deployment.source,
        previewRequest.source,
        mode === 'preview' ? previewInputRequest.source : null
    );
    const billingPolicy = preview?.billing_policy || billing || {};
    const treasuryPlan = treasury && typeof treasury === 'object' ? treasury : {};
    const blockers = [];
    const warnings = [];
    const requiredActions = [];
    const recommendedSequence = [];

    const addBlocker = (code, message) => {
        blockers.push({ code, message });
        if (!requiredActions.includes(code)) requiredActions.push(code);
    };
    const addWarning = (code, message) => {
        warnings.push({ code, message });
    };

    const hostingTarget = previewRequest.hosting_target
        || previewInputRequest.hosting_target
        || deployment.hosting_target
        || null;
    const sourceType = String(
        providerState.source_type
        || source.type
        || previewInputRequest.source_type
        || deployment.source_type
        || ''
    ).trim();
    const sourceRef = String(
        source.ref
        || providerState.repository_url
        || providerState.image_identifier
        || previewInputRequest.source_ref
        || deployment.source_ref
        || ''
    ).trim();
    const connectionArn = String(
        providerState.connection_arn
        || previewInputRequest.connection_arn
        || ''
    ).trim();
    const instanceRoleArn = String(
        providerState.instance_role_arn
        || previewInputRequest.instance_role_arn
        || ''
    ).trim();
    const healthPath = String(
        source.health_path
        || providerState.health_path
        || providerState.health_check_path
        || previewInputRequest.health_path
        || ''
    ).trim();
    const currentShortfallUsdc = Math.max(
        0,
        toFiniteNumber(treasuryPlan?.reserve?.current_shortfall_usdc, 0)
    );
    const billingAuthorized = providerState.billing_authorized === true
        || billingPolicy.status === 'authorized'
        || billingPolicy.hosted_billing_status === 'authorized'
        || billingPolicy.hosted_billing_status === 'active'
        || deployment.self_serve_launch?.billing_authorized === true;
    const runtimeProvisioningStarted = providerState.provisioning_started === true;
    const runtimeLive = providerState.live === true;
    const runtimeTrust = String(providerState.runtime_trust || '').trim();
    const localContextHandoff = getNestedValue(
        previewInputRequest,
        ['deployment_packet', 'local_context_handoff'],
        getNestedValue(previewRequest, ['deployment_packet', 'local_context_handoff'], null)
    );
    const localContextHandoffReport = buildLocalContextHandoffReport(localContextHandoff, {
        previewReady: Boolean(preview),
    });

    if (localContextHandoffReport) {
        for (const check of localContextHandoffReport.checks) {
            if (check.status === 'fail') {
                addBlocker(`local_handoff_${check.id}`, check.detail);
            } else if (check.status === 'warn') {
                addWarning(`local_handoff_${check.id}`, check.detail);
            }
        }
    }

    if (hostingTarget === 'platform_native_harness') {
        if (!sourceType) {
            addBlocker('source_type_required', 'Hosted native harness demos require source.type to be repository or container_image.');
        }
        if (!sourceRef) {
            addBlocker('source_ref_required', 'Hosted native harness demos require a repository URL or container image reference.');
        }
        if (sourceType === 'repository' && !connectionArn) {
            addBlocker('connection_arn_required_for_repository_builds', 'Repository-backed App Runner demos require provider_state.connection_arn.');
        }
        if (!instanceRoleArn) {
            addWarning('instance_role_arn_missing', 'provider_state.instance_role_arn is not set. Bedrock-backed runtime access usually needs an App Runner instance role.');
        }
        if (!healthPath) {
            addWarning('health_path_missing', 'No explicit health path was supplied. /health will be assumed.');
        }
        if (controlPlane.cloud_provisioning_by_catalog === false) {
            addBlocker('hosted_runtime_bridge_not_live', 'The launch catalog reports cloud provisioning as unavailable in the current environment.');
        }
        if (runtimeLane.customer_self_serve === false) {
            addWarning('manual_review_expected', 'This runtime lane is still operator-gated. A valid demo can still proceed, but manual approval is expected.');
        }
        if (approvalLane.operator_review_required === true) {
            addWarning('operator_review_required', 'The launch contract still requires operator review before hosted launch.');
        }
    }

    if (mode === 'deployment') {
        if (currentShortfallUsdc > 0) {
            addBlocker('fund_treasury', `Deployment treasury is short by ${currentShortfallUsdc.toFixed(2)} USDC.`);
        }
        if (!billingAuthorized) {
            addBlocker('authorize_billing', 'Hosted billing authorization is not recorded yet.');
        }
        if (!runtimeProvisioningStarted && !runtimeLive) {
            recommendedSequence.push('provision_runtime');
        }
        if (runtimeProvisioningStarted && !runtimeLive) {
            recommendedSequence.push('wait_for_runtime');
            addWarning('runtime_not_running_yet', 'Provisioning has started, but the runtime is not marked live yet.');
        }
        if (runtimeLive && activationGate.status && activationGate.status !== 'activation_allowed') {
            addWarning('activation_gate_pending', 'Runtime is live, but the activation gate still blocks listing/public activation.');
        }
        if (!runtimeLive && runtimeTrust !== 'verified') {
            addWarning('runtime_not_verified', 'Hosted runtime proof is not verified yet.');
        }
    } else {
        recommendedSequence.push('preview', 'create_deployment_request');
        if (blockers.length === 0) {
            recommendedSequence.push('fund_treasury', 'authorize_billing', 'provision_runtime', 'run_live_smoke', 'activate_private_demo');
        }
    }

    let status = 'ready';
    let nextStep = 'none';
    if (mode === 'preview') {
        status = blockers.length > 0 ? 'preview_blocked' : 'preview_ready_for_request';
        nextStep = blockers[0]?.code || 'create_deployment_request';
    } else if (blockers.length > 0) {
        status = 'deployment_blocked';
        nextStep = blockers[0].code;
    } else if (!runtimeProvisioningStarted && !runtimeLive) {
        status = 'ready_for_provision';
        nextStep = 'provision_runtime';
    } else if (runtimeProvisioningStarted && !runtimeLive) {
        status = 'waiting_for_runtime';
        nextStep = 'wait_for_runtime';
    } else if (activationGate.status && activationGate.status !== 'activation_allowed') {
        status = 'waiting_for_activation_gate';
        nextStep = 'resolve_activation_gate';
    } else if (runtimeLive) {
        status = 'ready_for_activation';
        nextStep = 'activate_private_demo';
    }

    const summary = removeUndefinedFields({
        template_id: template.id || previewRequest.template_id || previewInputRequest.template_id || deployment.template_id || null,
        runtime_lane: runtimeLane.id || previewRequest.runtime_lane || previewInputRequest.runtime_lane || deployment.runtime_lane || null,
        model_lane: launch.model_lane?.id || previewRequest.model_lane || previewInputRequest.model_lane || deployment.model_lane || null,
        hosting_target: hostingTarget,
        source_type: sourceType || null,
        source_ref: sourceRef || null,
        billing_plan: billingPolicy.plan_id || previewRequest.billing_plan || previewInputRequest.billing_plan || deployment.billing_plan || null,
        treasury_shortfall_usdc: mode === 'deployment' ? currentShortfallUsdc : undefined,
        billing_authorized: mode === 'deployment' ? billingAuthorized : undefined,
        runtime_live: mode === 'deployment' ? runtimeLive : undefined,
        activation_gate_status: mode === 'deployment' ? (activationGate.status || null) : undefined,
        local_context_handoff_status: localContextHandoffReport?.status,
        local_context_source: localContextHandoffReport?.source,
    });

    return {
        schema: 'agoragentic.agent-os.deployment-readiness.v1',
        mode,
        status,
        next_step: nextStep,
        ready: blockers.length === 0,
        summary,
        owner_report: buildDeploymentOwnerReport({
            mode,
            status,
            nextStep,
            blockers,
            warnings,
            localContextHandoffReport,
        }),
        local_context_handoff: localContextHandoffReport,
        blockers,
        warnings,
        required_actions: requiredActions,
        recommended_sequence: recommendedSequence,
        current_boundary: {
            self_serve_platform_hosting_today: controlPlane.self_serve_platform_hosting_today,
            cloud_provisioning_by_catalog: controlPlane.cloud_provisioning_by_catalog,
            auto_approval_live: controlPlane.auto_approval_live,
            customer_billing_controls_live: controlPlane.customer_billing_controls_live,
            wallet_connect_browser_funding_live: getNestedValue(
                preview?.launch_contract || deployment.launch_contract || {},
                ['wallet_topology', 'current_boundary', 'wallet_connect_browser_funding_live'],
                undefined
            ),
        },
        preview_id: preview?.preview_id || null,
        deployment_id: deployment.id || deployment.deployment_id || deploymentId || null,
        routes: {
            catalog: 'GET /api/hosting/agent-os/catalog',
            preview: 'POST /api/hosting/agent-os/preview',
            create: 'POST /api/hosting/agent-os/deployments',
            treasury: 'GET /api/hosting/agent-os/deployments/{id}/treasury',
            billing: 'GET /api/hosting/agent-os/deployments/{id}/billing',
            activation_gate: 'GET /api/hosting/agent-os/deployments/{id}/activation-gate',
        },
    };
}

function buildLocalContextHandoffReport(handoff, { previewReady = false } = {}) {
    if (!isPlainObject(handoff)) {
        return null;
    }

    const artifacts = normalizeArtifactRefs(handoff.artifacts || {});
    const checks = [];
    const addCheck = (id, status, detail) => {
        checks.push({ id, status, detail });
    };

    const source = handoff.source || handoff.context_layer || 'local_context';
    addCheck(
        'preview_request',
        previewReady ? 'pass' : 'warn',
        previewReady
            ? 'Agent OS preview accepted the normalized local context handoff request.'
            : 'Agent OS preview has not returned a normalized preview yet.'
    );
    addCheck(
        'context_packet',
        artifacts.context_packet ? 'pass' : 'fail',
        artifacts.context_packet
            ? `Context packet declared: ${artifacts.context_packet}.`
            : 'Local context handoff is missing a context packet reference.'
    );
    addCheck(
        'source_map',
        artifacts.source_map ? 'pass' : 'fail',
        artifacts.source_map
            ? `Source map declared: ${artifacts.source_map}.`
            : 'Local context handoff is missing a source map reference.'
    );
    addCheck(
        'policy_summary',
        artifacts.policy_summary ? 'pass' : 'fail',
        artifacts.policy_summary
            ? `Policy summary declared: ${artifacts.policy_summary}.`
            : 'Local context handoff is missing a policy summary reference.'
    );
    addCheck(
        'grounding_eval',
        artifacts.grounding_eval ? 'pass' : 'warn',
        artifacts.grounding_eval
            ? `Grounding eval declared: ${artifacts.grounding_eval}.`
            : 'Grounding eval is not declared. Continue only after owner review or run the local grounding eval first.'
    );
    addCheck(
        'deployment_preview',
        artifacts.deployment_preview ? 'pass' : 'fail',
        artifacts.deployment_preview
            ? `Deployment preview artifact declared: ${artifacts.deployment_preview}.`
            : 'Local context handoff is missing a deployment preview artifact reference.'
    );
    addCheck(
        'no_spend_boundary',
        handoff.no_spend_boundary === true && handoff.live_deploy_allowed !== true ? 'pass' : 'fail',
        handoff.no_spend_boundary === true && handoff.live_deploy_allowed !== true
            ? 'Handoff boundary is preview-only and declares no live deploy/spend authority.'
            : 'Handoff boundary does not prove preview-only no-spend behavior.'
    );
    addCheck(
        'full_ecf_internals_excluded',
        handoff.private_internals_excluded === true ? 'pass' : 'fail',
        handoff.private_internals_excluded === true
            ? 'Handoff excludes Full ECF private internals.'
            : 'Handoff does not prove Full ECF private internals are excluded.'
    );

    const failed = checks.filter((check) => check.status === 'fail');
    const warned = checks.filter((check) => check.status === 'warn');
    const status = failed.length > 0 ? 'blocked' : (warned.length > 0 ? 'needs_review' : 'ready');

    return removeUndefinedFields({
        schema: 'agoragentic.agent-os.local-context-handoff-readiness.v1',
        source,
        context_layer: handoff.context_layer || source,
        status,
        ready: status === 'ready',
        checks,
        blockers: failed,
        warnings: warned,
        artifacts,
        boundary: handoff.public_boundary || undefined,
        next_recommended_action: status === 'ready'
            ? 'create_deployment_request_after_owner_review'
            : (status === 'needs_review' ? 'review_or_regenerate_local_artifacts' : 'fix_local_handoff_before_deployment_request'),
        safe_actions: [
            'readiness',
            'preview',
            'record_deployment_request_after_owner_review',
        ],
        gated_actions: [
            'fund_treasury',
            'provision_runtime',
            'spend',
            'public_api_exposure',
            'marketplace_listing',
            'x402_edge_exposure',
            'secret_changes',
        ],
    });
}

function buildDeploymentOwnerReport({ mode, status, nextStep, blockers = [], warnings = [], localContextHandoffReport = null } = {}) {
    const ownerStatus = blockers.length > 0 ? 'blocked' : (warnings.length > 0 ? 'needs_review' : 'ready');
    const localContextText = localContextHandoffReport
        ? ` Local context handoff is ${localContextHandoffReport.status}.`
        : '';
    return {
        schema: 'agoragentic.agent-os.owner-readiness-report.v1',
        status: ownerStatus,
        mode,
        summary: ownerStatus === 'ready'
            ? `Agent OS ${mode} is ready for the next owner-reviewed step.${localContextText}`
            : `Agent OS ${mode} needs attention before the next step.${localContextText}`,
        next_recommended_action: blockers[0]?.code || nextStep || 'review',
        no_spend_boundary: mode === 'preview'
            ? 'readiness and preview are no-spend; create records a deployment request only'
            : 'recorded deployment actions remain gated by owner approval, budget policy, trust checks, and activation gates',
        authority_boundary: {
            readiness_can_spend: false,
            preview_can_provision: false,
            create_can_provision: false,
            create_can_spend: false,
            create_records_request_only: true,
            owner_approval_required_for_live_runtime: true,
        },
    };
}

function normalizeLangSmithOptions(option) {
    if (!option) {
        return {
            enabled: false,
            operationPrefix: DEFAULT_LANGSMITH_OPERATION_PREFIX,
        };
    }

    if (option === true) {
        return {
            enabled: true,
            operationPrefix: DEFAULT_LANGSMITH_OPERATION_PREFIX,
        };
    }

    if (option === false) {
        return {
            enabled: false,
            operationPrefix: DEFAULT_LANGSMITH_OPERATION_PREFIX,
        };
    }

    return {
        enabled: option.enabled !== false,
        operationPrefix: option.operationPrefix || DEFAULT_LANGSMITH_OPERATION_PREFIX,
        projectName: option.projectName,
        metadata: option.metadata,
        tags: Array.isArray(option.tags) ? option.tags.slice() : undefined,
        traceable: option.traceable,
        getCurrentRunTree: option.getCurrentRunTree,
    };
}

function normalizeGatewayAgentIdOption(value) {
    if (value == null) return null;
    const normalized = String(value).trim();
    if (!normalized) return null;
    if (!/^[a-zA-Z0-9:_-]{3,120}$/.test(normalized)) return null;
    return normalized;
}

function resolveOpenAIAgentsTraceOption(...values) {
    for (const value of values) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            return value;
        }
    }
    return null;
}

function normalizeWalletAddress(walletAddress) {
    if (walletAddress == null) {
        throw new Error('walletAddress is required');
    }
    const normalized = String(walletAddress).trim().toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(normalized)) {
        throw new Error('walletAddress must be a valid 0x-prefixed EVM address');
    }
    return normalized;
}

function buildX402ClaimProofMessage(walletAddress) {
    const normalizedWalletAddress = normalizeWalletAddress(walletAddress);
    return [
        'Agoragentic x402 claim',
        `Wallet: ${normalizedWalletAddress}`,
        'Purpose: Read paid x402 receipts and vault items without creating an Agoragentic account.',
    ].join('\n');
}

function summarizeTraceInput(method, path, body, baseUrl, hasApiKey) {
    const url = new URL(path, baseUrl);
    return {
        method,
        path: url.pathname,
        query_keys: Array.from(new Set(url.searchParams.keys())).sort(),
        has_api_key: hasApiKey,
        has_body: body !== undefined,
        body_keys: summarizeBodyKeys(body),
        payable_x402: method !== 'GET'
            && (url.pathname === '/api/x402/execute' || url.pathname.startsWith('/api/x402/invoke/')),
    };
}

function summarizeBodyKeys(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return [];
    }
    return Object.keys(body).sort();
}

function sanitizeTraceInputs(inputs) {
    return removeUndefinedFields({
        method: inputs.method,
        path: inputs.path,
        query_keys: Array.isArray(inputs.query_keys) ? inputs.query_keys : [],
        has_api_key: Boolean(inputs.has_api_key),
        has_body: Boolean(inputs.has_body),
        body_keys: Array.isArray(inputs.body_keys) ? inputs.body_keys : [],
        payable_x402: Boolean(inputs.payable_x402),
    });
}

function sanitizeTraceOutputs(outputs) {
    const response = outputs
        && typeof outputs === 'object'
        && !Array.isArray(outputs)
        && Object.keys(outputs).length === 1
        && Object.prototype.hasOwnProperty.call(outputs, 'outputs')
        ? outputs.outputs
        : outputs;
    const receipt = response && response.receipt ? response.receipt : undefined;
    const provider = response && response.provider ? response.provider : undefined;
    const listing = response && response.listing ? response.listing : undefined;
    const quote = response && response.quote ? response.quote : undefined;

    return removeUndefinedFields({
        success: typeof response?.success === 'boolean' ? response.success : undefined,
        status: typeof response?.status === 'string' ? response.status : undefined,
        invocation_id: response?.invocation_id,
        receipt_id: response?.receipt_id || receipt?.receipt_id,
        provider_id: provider?.id || listing?.id || response?.selected_provider?.id,
        quote_id: response?.quote_id || quote?.quote_id,
        matches: typeof response?.matches === 'number' ? response.matches : undefined,
        eligible: typeof response?.eligible === 'number' ? response.eligible : undefined,
        output_keys: response && response.output && typeof response.output === 'object' && !Array.isArray(response.output)
            ? Object.keys(response.output).sort()
            : undefined,
    });
}

function inferLangSmithOperationName(method, path, prefix) {
    const normalizedPath = String(path || '').replace(/\/+$/, '');
    const knownOperations = {
        'GET /api/execute/match': 'match',
        'POST /api/execute': 'execute',
        'GET /api/execute/status/id': 'status',
        'POST /api/quickstart': 'register',
        'GET /api/capabilities': 'search',
        'GET /api/capabilities/id': 'get_capability',
        'POST /api/capabilities': 'list_service',
        'POST /api/invoke/id': 'invoke',
        'GET /api/stats': 'stats',
        'GET /api/x402/info': 'x402_info',
        'GET /api/x402/listings': 'x402_listings',
        'GET /api/x402/discover': 'x402_discover',
        'GET /api/x402/execute/match': 'x402_execute_match',
        'POST /api/x402/execute': 'x402_execute',
        'POST /api/x402/invoke/id': 'x402_invoke',
        'POST /api/commerce/quotes': 'quote',
        'GET /api/commerce/receipts/id': 'receipt',
    };

    const signature = `${method.toUpperCase()} ${normalizePathForOperation(normalizedPath)}`;
    const operation = knownOperations[signature]
        || normalizePathForOperation(normalizedPath)
            .replace(/^\/api\//, '')
            .replace(/\//g, '_')
            .replace(/^_+|_+$/g, '')
        || method.toLowerCase();

    return `${prefix || DEFAULT_LANGSMITH_OPERATION_PREFIX}.${operation}`;
}

function normalizePathForOperation(path) {
    return path
        .replace(/\/(cap|qt|inv|agt|rcpt)_[^/]+/g, '/id')
        .replace(/\/[0-9a-fA-F-]{16,}/g, '/id')
        .replace(/\/$/, '');
}

function removeUndefinedFields(value) {
    return Object.fromEntries(
        Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)
    );
}

function buildNativeHarnessDemoDeployment(input = {}) {
    const sourceType = normalizeNativeHarnessSourceType(
        input.source_type
        || input.sourceType
        || (input.image ? 'container_image' : 'repository')
    );
    const sourceRef = String(
        input.source_ref
        || input.sourceRef
        || input.repo
        || input.repository
        || input.image
        || ''
    ).trim();
    if (!sourceRef) {
        throw new Error('buildNativeHarnessDemoDeployment requires source_ref/repository/image');
    }

    const modelProfile = normalizeNativeHarnessModelProfile(input.model_profile || input.modelProfile || 'balanced');
    const exposureMode = normalizeNativeHarnessExposureMode(input.exposure_mode || input.exposureMode || 'private_only');
    const bedrockRegion = String(input.bedrock_region || input.bedrockRegion || 'us-east-2').trim() || 'us-east-2';
    const branch = String(input.branch || 'main').trim() || 'main';
    const healthPath = String(input.health_path || input.healthPath || '/health').trim() || '/health';
    const defaultRepositorySourceDir = 'native-harness-runtime';
    const sourceDirectory = sourceType === 'repository'
        ? String(input.source_dir || input.sourceDirectory || defaultRepositorySourceDir).trim() || defaultRepositorySourceDir
        : undefined;
    const providerState = removeUndefinedFields({
        provider_name: 'aws_apprunner',
        source_type: sourceType,
        repository_url: sourceType === 'repository' ? sourceRef : undefined,
        image_identifier: sourceType === 'container_image' ? sourceRef : undefined,
        image_repository_type: sourceType === 'container_image' ? (input.image_repository_type || input.imageRepositoryType || 'ECR') : undefined,
        branch: sourceType === 'repository' ? branch : undefined,
        source_directory: sourceDirectory,
        configuration_source: sourceType === 'repository' ? (input.configuration_source || input.configurationSource || 'API') : undefined,
        connection_arn: input.connection_arn || input.connectionArn,
        access_role_arn: input.access_role_arn || input.accessRoleArn,
        instance_role_arn: input.instance_role_arn || input.instanceRoleArn,
        service_prefix: input.service_prefix || input.servicePrefix || 'native-harness-demo',
        runtime: input.runtime || 'agoragentic-rust',
        build_command: sourceType === 'repository' ? (input.build_command || input.buildCommand || 'cargo build --release') : undefined,
        start_command: input.start_command || input.startCommand || './target/release/agent',
        port: input.port,
        health_path: healthPath,
    });

    const modelPolicy = modelProfile === 'quality_first'
        ? {
            provider: 'bedrock',
            model_id: 'anthropic.claude-opus-4-7',
            region: bedrockRegion,
            reasoning_mode: 'adaptive',
        }
        : {
            provider: 'bedrock',
            model_id: 'anthropic.claude-sonnet-4-6',
            region: bedrockRegion,
            reasoning_mode: 'adaptive',
        };

    return {
        name: input.name || 'Native Harness Demo Agent',
        description: input.description || 'Hosted native harness demo agent on Agoragentic App Runner with Bedrock-backed inference and Agent OS controls.',
        hosting_target: 'platform_native_harness',
        template_id: 'native_harness_demo',
        runtime_lane: 'shared_platform_runtime',
        model_lane: 'bedrock_managed_api',
        exposure_mode: exposureMode,
        billing_plan: input.billing_plan || input.billingPlan || 'starter',
        autonomy_tier: input.autonomy_tier || input.autonomyTier || 'budgeted',
        ecf_profile: input.ecf_profile || input.ecfProfile || 'none',
        deployment_group: { count: 1 },
        buyer_mode: true,
        seller_mode: true,
        source: removeUndefinedFields({
            type: sourceType,
            ref: sourceRef,
            branch: sourceType === 'repository' ? branch : undefined,
            source_dir: sourceDirectory,
            health_path: healthPath,
        }),
        provider_state: providerState,
        model_policy: modelPolicy,
        goals: {
            primary_goal: input.goal || 'Prove one stable native harness runtime can be launched, funded, smoke-tested, and activated with Agent OS receipts and intent reconciliation.',
            success_metrics: Array.isArray(input.success_metrics) && input.success_metrics.length
                ? input.success_metrics
                : ['runtime_reachable', 'intent_alignment', 'demo_task_completion'],
            budget: {
                max_daily_usdc: toFiniteNumber(input.max_daily_spend ?? input.max_daily_spend_usdc, 5),
                approval_required_above_usdc: toFiniteNumber(input.approval_above ?? input.approval_required_above_usdc, 1),
            },
        },
        tags: Array.isArray(input.tags) && input.tags.length ? input.tags : ['native-harness', 'agent-os', 'demo'],
    };
}

function validateNativeHarnessDemoSource(input = {}) {
    const requestedPath = typeof input === 'string'
        ? input
        : String(input.path || input.source_dir || input.sourceDirectory || 'native-harness-runtime').trim() || 'native-harness-runtime';
    const resolvedPath = path.resolve(process.cwd(), requestedPath);
    const requiredFiles = ['Cargo.toml', path.join('src', 'main.rs'), 'README.md'];
    const checks = [];
    const blockers = [];
    const warnings = [];

    function recordCheck(name, passed, detail) {
        checks.push({ name, passed, detail });
        if (!passed) {
            blockers.push({ code: name, detail });
        }
    }

    function readIfPresent(filePath) {
        return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
    }

    const exists = fs.existsSync(resolvedPath);
    recordCheck(
        'source_directory_exists',
        exists,
        exists ? `Found source directory at ${resolvedPath}` : `Source directory not found: ${resolvedPath}`
    );

    if (!exists) {
        return {
            schema: 'agoragentic.agent-os.native-harness-demo-source-validation.v1',
            requested_path: requestedPath,
            resolved_path: resolvedPath,
            status: 'fail',
            checks,
            blockers,
            warnings,
        };
    }

    for (const fileName of requiredFiles) {
        const filePath = path.join(resolvedPath, fileName);
        const present = fs.existsSync(filePath);
        recordCheck(
            `required_file_${fileName.replace(/\W+/g, '_')}`,
            present,
            present ? `Found ${fileName}` : `Missing required file ${fileName}`
        );
    }

    const cargoPath = path.join(resolvedPath, 'Cargo.toml');
    const mainPath = path.join(resolvedPath, 'src', 'main.rs');
    const readmePath = path.join(resolvedPath, 'README.md');
    const cargoToml = readIfPresent(cargoPath);
    const mainSource = readIfPresent(mainPath);
    const readme = readIfPresent(readmePath);

    if (mainSource) {
        for (const endpoint of ['/health', '/ready', '/capabilities', '/invoke']) {
            const present = mainSource.includes(endpoint);
            recordCheck(
                `endpoint_${endpoint.replace(/[^a-z]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase()}`,
                present,
                present ? `Runtime handles ${endpoint}` : `Runtime is missing ${endpoint}`
            );
        }
        const hasNativeHttpRuntime = mainSource.includes('TcpListener')
            || mainSource.includes('axum')
            || mainSource.includes('actix_web')
            || mainSource.includes('hyper');
        recordCheck(
            'rust_runtime_shape_present',
            hasNativeHttpRuntime,
            hasNativeHttpRuntime
                ? 'Runtime includes a native Rust HTTP serving path.'
                : 'Runtime does not include a recognizable Rust HTTP serving path.'
        );
        const hasBedrockBoundary = mainSource.includes('BEDROCK_MODEL_ID') || mainSource.includes('bedrock');
        checks.push({
            name: 'bedrock_boundary_present',
            passed: hasBedrockBoundary,
            detail: hasBedrockBoundary
                ? 'Runtime documents the Bedrock configuration boundary.'
                : 'Runtime does not include Bedrock configuration markers; deterministic fallback still works.',
        });
        if (!hasBedrockBoundary) {
            warnings.push({
                code: 'bedrock_boundary_missing',
                detail: 'Runtime does not include Bedrock configuration markers.',
            });
        }
    }

    if (cargoToml) {
        for (const marker of ['[package]', 'name = "agent"', 'edition = "2021"']) {
            const present = cargoToml.includes(marker);
            recordCheck(
                `cargo_${marker.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase()}`,
                present,
                present ? `Cargo.toml includes ${marker}` : `Cargo.toml is missing ${marker}`
            );
        }
    }

    if (readme) {
        for (const contractText of ['native-harness-runtime', 'cargo build --release', './target/release/agent', '`/health`']) {
            const present = readme.includes(contractText);
            recordCheck(
                `readme_${contractText.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase()}`,
                present,
                present ? `README documents ${contractText}` : `README is missing ${contractText}`
            );
        }
    }

    return {
        schema: 'agoragentic.agent-os.native-harness-demo-source-validation.v1',
        requested_path: requestedPath,
        resolved_path: resolvedPath,
        status: blockers.length ? 'fail' : 'pass',
        checks,
        blockers,
        warnings,
    };
}

function normalizeNativeHarnessSourceType(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return ['container_image', 'container', 'image'].includes(normalized) ? 'container_image' : 'repository';
}

function normalizeNativeHarnessModelProfile(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return ['quality', 'quality-first', 'quality_first', 'premium', 'opus'].includes(normalized)
        ? 'quality_first'
        : 'balanced';
}

function normalizeNativeHarnessExposureMode(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (['private_only', 'private'].includes(normalized)) return 'private_only';
    if (['public_api', 'public-api', 'public'].includes(normalized)) return 'public_api';
    if (['marketplace_seller', 'marketplace', 'seller'].includes(normalized)) return 'marketplace_seller';
    if (['x402_paid_edge', 'x402', 'paid-edge'].includes(normalized)) return 'x402_paid_edge';
    throw new Error(`Unsupported exposure mode "${value}"`);
}
