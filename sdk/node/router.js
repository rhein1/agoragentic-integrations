/**
 * Agoragentic Router — transparent fallback routing for agent frameworks.
 *
 * Use this when you want Agoragentic to resolve capabilities your agent
 * doesn't have locally. Local tools execute first; missing capabilities
 * route through the Agoragentic managed router.
 *
 * Revenue model: Agoragentic collects 3% on managed invocations.
 * Registry queries (match/search) are free.
 *
 * @example
 *   const { AgoragenticRouter } = require('agoragentic/router');
 *
 *   const router = new AgoragenticRouter({
 *     apiKey: 'amk_...',
 *     localTools: {
 *       summarize: async (input) => ({ summary: '...' }),
 *     },
 *   });
 *
 *   // Uses local tool if available, falls back to Agoragentic
 *   const result = await router.fallback('summarize', { text: '...' });
 *
 *   // Always routes through Agoragentic
 *   const result2 = await router.execute('translate', { text: '...', target: 'es' });
 */

'use strict';

const agoragentic = require('./index');
const { buildNativeHarnessDemoDeployment, buildDeploymentReadinessReport, validateNativeHarnessDemoSource } = require('./index');

const ROUTER_VERSION = '1.0.0';

class AgoragenticRouter {
    /**
     * Create a fallback-capable router.
     *
     * @param {Object} options
     * @param {string} [options.apiKey] - API key (amk_...). Required for paid execution.
     * @param {string} [options.baseUrl] - Base URL (default: https://agoragentic.com)
     * @param {number} [options.timeout] - Request timeout in ms (default: 30000)
     * @param {Object} [options.localTools] - Map of task name → async handler function
     * @param {Object} [options.policy] - Fallback policy options
     * @param {number} [options.policy.maxCostPerCall] - Max USDC per fallback call
     * @param {boolean} [options.policy.requireQuoteApproval] - If true, fallback() returns a quote instead of executing
     * @param {string[]} [options.policy.allowedTasks] - Whitelist of tasks allowed to fallback (empty = all)
     * @param {string[]} [options.policy.blockedTasks] - Blacklist of tasks blocked from fallback
     * @param {any} [options.owsWallet] - Optional OWS wallet for x402 payments
     * @param {boolean|Object} [options.langsmith] - Optional LangSmith tracing
     */
    constructor(options = {}) {
        this._client = agoragentic({
            apiKey: options.apiKey,
            baseUrl: options.baseUrl,
            timeout: options.timeout,
            owsWallet: options.owsWallet,
            langsmith: options.langsmith,
        });

        this._localTools = options.localTools || {};
        this._policy = {
            maxCostPerCall: options.policy?.maxCostPerCall ?? null,
            requireQuoteApproval: options.policy?.requireQuoteApproval ?? false,
            allowedTasks: options.policy?.allowedTasks ?? [],
            blockedTasks: options.policy?.blockedTasks ?? [],
        };
    }

    /**
     * Register a local tool handler.
     * Local tools always take precedence over marketplace routing.
     *
     * @param {string} task - Task name
     * @param {Function} handler - async (input) => output
     * @returns {AgoragenticRouter} this (chainable)
     */
    addLocalTool(task, handler) {
        if (typeof handler !== 'function') {
            throw new Error(`Handler for "${task}" must be a function`);
        }
        this._localTools[task] = handler;
        return this;
    }

    /**
     * Remove a local tool handler.
     * After removal, the task will route through Agoragentic.
     *
     * @param {string} task
     * @returns {AgoragenticRouter} this (chainable)
     */
    removeLocalTool(task) {
        delete this._localTools[task];
        return this;
    }

    /**
     * Check if a task has a local handler.
     *
     * @param {string} task
     * @returns {boolean}
     */
    hasLocalTool(task) {
        return typeof this._localTools[task] === 'function';
    }

    // ── Router contract ──────────────────────────────────

    /**
     * Fallback router — try local first, then route through Agoragentic.
     *
     * This is the primary integration point for framework authors.
     *
     * Behavior:
     * 1. If a local tool exists for the task → execute locally (free, no network)
     * 2. If no local tool exists → route through `POST /api/execute` (3% fee on paid)
     * 3. If policy.requireQuoteApproval is true and no local tool → return a quote object
     *    instead of executing, so the caller can inspect price before committing
     *
     * @param {string} task - What you need (e.g., 'summarize', 'translate')
     * @param {Object} [input] - Input payload
     * @param {Object} [constraints] - { max_cost, preferred_category, max_latency_ms }
     * @returns {Promise<{ source: 'local' | 'agoragentic' | 'quote', output?: any, cost?: number, quote?: Object }>}
     */
    async fallback(task, input = {}, constraints = {}) {
        // 1. Try local tool
        if (this.hasLocalTool(task)) {
            try {
                const output = await this._localTools[task](input);
                return {
                    source: 'local',
                    task,
                    output,
                    cost: 0,
                };
            } catch (localErr) {
                // Local tool failed — fall through to marketplace
            }
        }

        // 2. Policy gate
        if (!this._isTaskAllowed(task)) {
            const err = new Error(`Task "${task}" is blocked by router policy`);
            err.code = 'POLICY_BLOCKED';
            throw err;
        }

        // Apply policy max cost
        const effectiveConstraints = { ...constraints };
        if (this._policy.maxCostPerCall != null && !effectiveConstraints.max_cost) {
            effectiveConstraints.max_cost = this._policy.maxCostPerCall;
        }

        // 3. Quote-only mode: create durable quote for the top match
        if (this._policy.requireQuoteApproval) {
            // First, preview providers via match
            const matchResult = await this._client.match(task, effectiveConstraints);
            const topProvider = matchResult?.providers?.[0] || null;

            // If a specific listing is available, create a durable commerce quote
            let durableQuote = null;
            if (topProvider?.id) {
                try {
                    const quoteResponse = await this._client.quote({ capability_id: topProvider.id });
                    durableQuote = quoteResponse?.quote || null;
                } catch {
                    // quote creation may fail for anonymous users — fall back to match-only
                }
            }

            return {
                source: 'quote',
                task,
                match: matchResult,
                quote: durableQuote,
                quote_id: durableQuote?.quote_id || null,
                cost: durableQuote?.quoted_price_usdc ?? null,
                output: null,
                message: durableQuote?.quote_id
                    ? `Policy requires quote approval. Call router.executeQuote("${durableQuote.quote_id}", input) to proceed.`
                    : 'Policy requires quote approval. No durable quote available — match preview only.',
            };
        }

        // 4. Execute through managed router
        const result = await this._client.execute(task, input, effectiveConstraints);
        return {
            source: 'agoragentic',
            task,
            output: result.output ?? result.result,
            cost: result.cost ?? 0,
            provider: result.provider,
            invocation_id: result.invocation_id,
            receipt: result.receipt,
            settlement: {
                managed: true,
                platform_fee: '3%',
                currency: 'USDC',
                network: 'base',
            },
        };
    }

    /**
     * Execute using a durable quote_id obtained from a previous fallback(requireQuoteApproval=true) call.
     *
     * @param {string} quoteId - The durable quote_id from a quote-approval fallback
     * @param {Object} [input] - Input payload
     * @returns {Promise<Object>}
     */
    async executeQuote(quoteId, input = {}) {
        const result = await this._client.execute(null, input, { quote_id: quoteId });
        return {
            source: 'agoragentic',
            quote_id: quoteId,
            output: result.output ?? result.result,
            cost: result.cost ?? 0,
            provider: result.provider,
            invocation_id: result.invocation_id,
            receipt: result.receipt,
            settlement: {
                managed: true,
                platform_fee: '3%',
                currency: 'USDC',
                network: 'base',
            },
        };
    }

    /**
     * Execute a task through Agoragentic (always remote, bypasses local tools).
     * Wraps client.execute() with the router's policy constraints.
     *
     * @param {string} task
     * @param {Object} [input]
     * @param {Object} [constraints]
     * @returns {Promise<Object>}
     */
    async execute(task, input = {}, constraints = {}) {
        if (!this._isTaskAllowed(task)) {
            const err = new Error(`Task "${task}" is blocked by router policy`);
            err.code = 'POLICY_BLOCKED';
            throw err;
        }

        const effectiveConstraints = { ...constraints };
        if (this._policy.maxCostPerCall != null && !effectiveConstraints.max_cost) {
            effectiveConstraints.max_cost = this._policy.maxCostPerCall;
        }

        return this._client.execute(task, input, effectiveConstraints);
    }

    /**
     * Preview matching providers (dry run — no cost).
     * Free registry query.
     *
     * @param {string} task
     * @param {Object} [constraints]
     * @returns {Promise<Object>}
     */
    async match(task, constraints = {}) {
        return this._client.match(task, constraints);
    }

    /**
     * Quote a task or listing before execution.
     * Free registry query.
     *
     * @param {string|Object} reference
     * @param {Object} [opts]
     * @returns {Promise<Object>}
     */
    async quote(reference, opts = {}) {
        return this._client.quote(reference, opts);
    }

    /**
     * Check invocation status.
     *
     * @param {string} invocationId
     * @returns {Promise<Object>}
     */
    async status(invocationId) {
        return this._client.status(invocationId);
    }

    /**
     * Fetch a normalized receipt.
     *
     * @param {string} receiptId
     * @returns {Promise<Object>}
     */
    async receipt(receiptId) {
        return this._client.receipt(receiptId);
    }

    /**
     * Get the Agent OS operating account summary.
     *
     * @returns {Promise<Object>}
     */
    async account() {
        return this._client.account();
    }

    /**
     * Get the authenticated Agent OS wallet ledger summary.
     *
     * @returns {Promise<Object>}
     */
    async wallet() {
        return this._client.wallet();
    }

    /**
     * Create a dedicated on-chain wallet for the authenticated agent.
     *
     * @param {Object} [input]
     * @returns {Promise<Object>}
     */
    async createOnchainWallet(input = {}) {
        return this._client.createOnchainWallet(input);
    }

    /**
     * Link an external Base wallet to the authenticated agent.
     *
     * @param {string|Object} walletAddressOrInput
     * @param {string} [walletType]
     * @returns {Promise<Object>}
     */
    async connectWallet(walletAddressOrInput, walletType) {
        return this._client.connectWallet(walletAddressOrInput, walletType);
    }

    /**
     * Read on-chain wallet balances for the authenticated agent.
     *
     * @returns {Promise<Object>}
     */
    async onchainBalance() {
        return this._client.onchainBalance();
    }

    /**
     * Request Base USDC funding instructions for the authenticated wallet.
     *
     * @param {number} [amount]
     * @returns {Promise<Object>}
     */
    async purchase(amount) {
        return this._client.purchase(amount);
    }

    /**
     * Verify a Base funding transfer and credit the internal ledger.
     *
     * @param {string|Object} txHashOrInput
     * @returns {Promise<Object>}
     */
    async verifyPurchase(txHashOrInput) {
        return this._client.verifyPurchase(txHashOrInput);
    }

    /**
     * Request an on-chain payout of earned USDC.
     *
     * @param {number|Object} amountOrInput
     * @param {string} [destination]
     * @returns {Promise<Object>}
     */
    async payout(amountOrInput, destination) {
        return this._client.payout(amountOrInput, destination);
    }

    /**
     * List recent payout records for the authenticated agent.
     *
     * @param {Object} [opts]
     * @returns {Promise<Object>}
     */
    async payouts(opts = {}) {
        return this._client.payouts(opts);
    }

    /**
     * Get the Tumbler sandbox-to-production graduation summary.
     *
     * @returns {Promise<Object>}
     */
    async tumblerGraduation() {
        return this._client.tumblerGraduation();
    }

    /**
     * Get the Agent OS portable identity summary.
     *
     * @returns {Promise<Object>}
     */
    async identity() {
        return this._client.identity();
    }

    /**
     * Check a counterparty's portable identity and trust portability.
     *
     * @param {string|Object} reference
     * @returns {Promise<Object>}
     */
    async identityCheck(reference) {
        return this._client.identityCheck(reference);
    }

    /**
     * Get the Agent OS procurement summary.
     *
     * @returns {Promise<Object>}
     */
    async procurement() {
        return this._client.procurement();
    }

    /**
     * Preflight a purchase against policy, budget, and approval state.
     *
     * @param {string|Object} reference
     * @param {Object} [opts]
     * @returns {Promise<Object>}
     */
    async procurementCheck(reference, opts = {}) {
        return this._client.procurementCheck(reference, opts);
    }

    /**
     * Get the Agent OS learning and reputation summary.
     *
     * @param {Object} [opts]
     * @returns {Promise<Object>}
     */
    async learning(opts = {}) {
        return this._client.learning(opts);
    }

    /**
     * Generate approvable Agent OS learning candidates.
     *
     * @param {Object} [input]
     * @returns {Promise<Object>}
     */
    async learningCandidates(input = {}) {
        return this._client.learningCandidates(input);
    }

    /**
     * Save an approved learning note into Agent OS memory.
     *
     * @param {Object} note
     * @returns {Promise<Object>}
     */
    async saveLearningNote(note) {
        return this._client.saveLearningNote(note);
    }

    /**
     * Get the Agent OS accounting and reconciliation summary.
     *
     * @param {Object} [opts]
     * @returns {Promise<Object>}
     */
    async reconciliation(opts = {}) {
        return this._client.reconciliation(opts);
    }

    /**
     * Get purchase approvals — as buyer, supervisor, or both.
     *
     * @param {Object} [opts]
     * @returns {Promise<Object>}
     */
    async approvals(opts = {}) {
        return this._client.approvals(opts);
    }

    /**
     * Resolve a pending purchase approval as supervisor.
     *
     * @param {string} approvalId
     * @param {'approve'|'deny'} decision
     * @param {string} [reason]
     * @returns {Promise<Object>}
     */
    async resolveApproval(approvalId, decision, reason) {
        return this._client.resolveApproval(approvalId, decision, reason);
    }

    /**
     * Get per-job spending reconciliation and receipt summary.
     *
     * @param {string} jobId
     * @param {Object} [opts]
     * @returns {Promise<Object>}
     */
    async jobReconciliation(jobId, opts = {}) {
        return this._client.jobReconciliation(jobId, opts);
    }

    /**
     * Get the recurring-work operating summary.
     *
     * @returns {Promise<Object>}
     */
    async jobsSummary() {
        return this._client.jobsSummary();
    }

    /**
     * List scheduled execute jobs.
     *
     * @param {Object} [opts]
     * @returns {Promise<Object>}
     */
    async jobs(opts = {}) {
        return this._client.jobs(opts);
    }

    /**
     * Get scheduled execute job details.
     *
     * @param {string} jobId
     * @returns {Promise<Object>}
     */
    async job(jobId) {
        return this._client.job(jobId);
    }

    /**
     * Get run history for a scheduled execute job.
     *
     * @param {string} jobId
     * @param {Object} [opts]
     * @returns {Promise<Object>}
     */
    async jobRuns(jobId, opts = {}) {
        return this._client.jobRuns(jobId, opts);
    }

    /**
     * Get cross-job run history.
     *
     * @param {Object} [opts]
     * @returns {Promise<Object>}
     */
    async allJobRuns(opts = {}) {
        return this._client.allJobRuns(opts);
    }

    /**
     * Get Seller OS activation status.
     *
     * @returns {Promise<Object>}
     */
    async sellerStatus() {
        return this._client.sellerStatus();
    }

    /**
     * Get Seller OS demand recommendations.
     *
     * @returns {Promise<Object>}
     */
    async sellerDemand() {
        return this._client.sellerDemand();
    }

    /**
     * Get Seller OS listing health.
     *
     * @returns {Promise<Object>}
     */
    async sellerHealth() {
        return this._client.sellerHealth();
    }

    /**
     * Get recent Seller OS activity.
     *
     * @returns {Promise<Object>}
     */
    async sellerActivity() {
        return this._client.sellerActivity();
    }

    /**
     * Get Seller OS recommendations.
     *
     * @returns {Promise<Object>}
     */
    async sellerRecommendations() {
        return this._client.sellerRecommendations();
    }

    /**
     * Get Seller OS referral status.
     *
     * @returns {Promise<Object>}
     */
    async sellerReferrals() {
        return this._client.sellerReferrals();
    }

    /**
     * Generate a no-spend Agent OS deployment preview.
     *
     * @param {Object} [deployment]
     * @returns {Promise<Object>}
     */
    async deployPreview(deployment = {}) {
        return this._client.deployPreview(deployment);
    }

    /**
     * Record an Agent OS deployment request for review.
     *
     * @param {Object} [deployment]
     * @returns {Promise<Object>}
     */
    async createDeployment(deployment = {}) {
        return this._client.createDeployment(deployment);
    }

    /**
     * Read the public Agent OS launch catalog.
     *
     * @returns {Promise<Object>}
     */
    async deploymentCatalog() {
        return this._client.deploymentCatalog();
    }

    /**
     * List Agent OS deployment requests.
     *
     * @returns {Promise<Object>}
     */
    async deployments() {
        return this._client.deployments();
    }

    /**
     * Fetch one Agent OS deployment request.
     *
     * @param {string} deploymentId
     * @returns {Promise<Object>}
     */
    async deployment(deploymentId) {
        return this._client.deployment(deploymentId);
    }

    /**
     * Get hosted billing status for an Agent OS deployment.
     *
     * @param {string} deploymentId
     * @returns {Promise<Object>}
     */
    async deploymentBilling(deploymentId) {
        return this._client.deploymentBilling(deploymentId);
    }

    /**
     * Authorize hosted billing for an Agent OS deployment.
     *
     * @param {string} deploymentId
     * @param {Object} [input]
     * @returns {Promise<Object>}
     */
    async authorizeDeploymentBilling(deploymentId, input = {}) {
        return this._client.authorizeDeploymentBilling(deploymentId, input);
    }

    /**
     * Get orchestration, runtime, and billing summary for an Agent OS deployment.
     *
     * @param {string} deploymentId
     * @returns {Promise<Object>}
     */
    async deploymentOrchestration(deploymentId) {
        return this._client.deploymentOrchestration(deploymentId);
    }

    /**
     * Update the goal contract for an Agent OS deployment.
     *
     * @param {string} deploymentId
     * @param {Object} [goals]
     * @returns {Promise<Object>}
     */
    async updateDeploymentGoals(deploymentId, goals = {}) {
        return this._client.updateDeploymentGoals(deploymentId, goals);
    }

    /**
     * Record a bounded improvement proposal for an Agent OS deployment.
     *
     * @param {string} deploymentId
     * @param {Object} [signal]
     * @returns {Promise<Object>}
     */
    async proposeDeploymentImprovement(deploymentId, signal = {}) {
        return this._client.proposeDeploymentImprovement(deploymentId, signal);
    }

    /**
     * Record a reviewed fulfillment gate for an Agent OS deployment.
     *
     * @param {string} deploymentId
     * @param {Object} [input]
     * @returns {Promise<Object>}
     */
    async reviewDeploymentFulfillment(deploymentId, input = {}) {
        return this._client.reviewDeploymentFulfillment(deploymentId, input);
    }

    /**
     * Record a no-spend canary plan for an Agent OS deployment.
     *
     * @param {string} deploymentId
     * @param {Object} [input]
     * @returns {Promise<Object>}
     */
    async createDeploymentCanaryPlan(deploymentId, input = {}) {
        return this._client.createDeploymentCanaryPlan(deploymentId, input);
    }

    /**
     * Record runtime smoke evidence for an Agent OS deployment.
     *
     * @param {string} deploymentId
     * @param {Object} [input]
     * @returns {Promise<Object>}
     */
    async recordDeploymentSmokeResult(deploymentId, input = {}) {
        return this._client.recordDeploymentSmokeResult(deploymentId, input);
    }

    /**
     * Trigger hosted runtime provisioning for an Agent OS deployment.
     *
     * @param {string} deploymentId
     * @param {Object} [input]
     * @returns {Promise<Object>}
     */
    async provisionDeployment(deploymentId, input = {}) {
        return this._client.provisionDeployment(deploymentId, input);
    }

    /**
     * Execute a live hosted runtime smoke check for an Agent OS deployment.
     *
     * @param {string} deploymentId
     * @param {Object} [input]
     * @returns {Promise<Object>}
     */
    async smokeDeployment(deploymentId, input = {}) {
        return this._client.smokeDeployment(deploymentId, input);
    }

    /**
     * Read the current activation gate for an Agent OS deployment.
     *
     * @param {string} deploymentId
     * @returns {Promise<Object>}
     */
    async deploymentActivationGate(deploymentId) {
        return this._client.deploymentActivationGate(deploymentId);
    }

    /**
     * Trigger hosted runtime activation and optional listing publication.
     *
     * @param {string} deploymentId
     * @param {Object} [input]
     * @returns {Promise<Object>}
     */
    async activateDeployment(deploymentId, input = {}) {
        return this._client.activateDeployment(deploymentId, input);
    }

    /**
     * Record an intent/outcome reconciliation for an Agent OS deployment.
     *
     * @param {string} deploymentId
     * @param {Object} [input]
     * @returns {Promise<Object>}
     */
    async reconcileDeploymentIntent(deploymentId, input = {}) {
        return this._client.reconcileDeploymentIntent(deploymentId, input);
    }

    /**
     * Run the owner-safe hosted launch flow for an Agent OS deployment.
     *
     * @param {string} deploymentId
     * @param {Object} [input]
     * @returns {Promise<Object>}
     */
    async selfServeDeploymentLaunch(deploymentId, input = {}) {
        return this._client.selfServeDeploymentLaunch(deploymentId, input);
    }

    /**
     * Build a no-spend readiness report for a deployment packet or existing deployment.
     *
     * @param {Object|string} input
     * @returns {Promise<Object>}
     */
    async deploymentReadiness(input = {}) {
        return this._client.deploymentReadiness(input);
    }

    /**
     * Build an owner-facing treasury summary for one Agent OS deployment.
     *
     * @param {string} deploymentId
     * @returns {Promise<Object>}
     */
    async deploymentTreasuryPlan(deploymentId) {
        return this._client.deploymentTreasuryPlan(deploymentId);
    }

    /**
     * Get funding instructions for a specific Agent OS deployment.
     *
     * @param {string} deploymentId
     * @param {Object} [opts]
     * @returns {Promise<Object>}
     */
    async deploymentFundingInstructions(deploymentId, opts = {}) {
        return this._client.deploymentFundingInstructions(deploymentId, opts);
    }

    /**
     * Verify a funding transaction for an Agent OS deployment and return refreshed treasury state.
     *
     * @param {string} deploymentId
     * @param {string|Object} txHashOrInput
     * @returns {Promise<Object>}
     */
    async verifyDeploymentFunding(deploymentId, txHashOrInput) {
        return this._client.verifyDeploymentFunding(deploymentId, txHashOrInput);
    }

    /**
     * Build the recommended native harness demo deployment packet locally.
     *
     * @param {Object} [input]
     * @returns {Object}
     */
    buildNativeHarnessDemoDeployment(input = {}) {
        return buildNativeHarnessDemoDeployment(input);
    }

    buildDeploymentReadinessReport(input = {}) {
        return buildDeploymentReadinessReport(input);
    }

    validateNativeHarnessDemoSource(input = {}) {
        return validateNativeHarnessDemoSource(input);
    }

    /**
     * Export a marketplace listing as a reusable skill recipe.
     *
     * @param {Object} [input]
     * @returns {Promise<Object>}
     */
    async exportSkillRecipe(input = {}) {
        return this._client.exportSkillRecipe(input);
    }

    /**
     * Import a skill recipe into Agent OS memory.
     *
     * @param {Object} [input]
     * @returns {Promise<Object>}
     */
    async importSkillRecipe(input = {}) {
        return this._client.importSkillRecipe(input);
    }

    /**
     * Search the capability registry (free).
     * Use this to check what's available before routing.
     *
     * @param {string} [query]
     * @param {Object} [filters]
     * @returns {Promise<Array>}
     */
    async search(query, filters = {}) {
        return this._client.search(query, filters);
    }

    /**
     * Get the underlying AgoragenticClient for direct API access.
     * @returns {AgoragenticClient}
     */
    get client() {
        return this._client;
    }

    /**
     * Get the router version.
     * @returns {string}
     */
    get version() {
        return ROUTER_VERSION;
    }

    // ── Internal ──────────────────────────────────────────

    _isTaskAllowed(task) {
        if (this._policy.blockedTasks.length > 0 && this._policy.blockedTasks.includes(task)) {
            return false;
        }
        if (this._policy.allowedTasks.length > 0 && !this._policy.allowedTasks.includes(task)) {
            return false;
        }
        return true;
    }
}

module.exports = { AgoragenticRouter };
