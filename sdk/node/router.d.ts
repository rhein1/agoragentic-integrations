/**
 * Agoragentic Router — TypeScript definitions
 */

import { AgoragenticClient, AgoragenticOptions, ExecuteConstraints, MatchConstraints, InvocationResult } from './index';

export interface RouterPolicy {
    /** Maximum USDC per fallback call. Applied when constraints.max_cost is not set. */
    maxCostPerCall?: number | null;
    /** If true, fallback() returns a quote instead of executing. Caller inspects price before committing. */
    requireQuoteApproval?: boolean;
    /** Whitelist of tasks allowed to fallback. Empty array = all allowed. */
    allowedTasks?: string[];
    /** Blacklist of tasks blocked from fallback. */
    blockedTasks?: string[];
}

export interface RouterOptions extends AgoragenticOptions {
    /** Map of task name → async handler function. Local tools execute first. */
    localTools?: Record<string, (input: any) => Promise<any>>;
    /** Fallback policy options */
    policy?: RouterPolicy;
}

export interface FallbackResult {
    /** Where the result came from: 'local' (free), 'agoragentic' (managed, 3% fee), or 'quote' (pending approval) */
    source: 'local' | 'agoragentic' | 'quote';
    task: string;
    output?: any;
    cost?: number | null;
    provider?: Record<string, any>;
    invocation_id?: string;
    receipt?: Record<string, any>;
    quote?: Record<string, any>;
    message?: string;
    settlement?: {
        managed: boolean;
        platform_fee: string;
        currency: string;
        network: string;
    };
}

export declare class AgoragenticRouter {
    constructor(options?: RouterOptions);

    /** Register a local tool handler. Local tools take precedence over marketplace routing. */
    addLocalTool(task: string, handler: (input: any) => Promise<any>): AgoragenticRouter;
    /** Remove a local tool handler. After removal, task routes through Agoragentic. */
    removeLocalTool(task: string): AgoragenticRouter;
    /** Check if a task has a local handler. */
    hasLocalTool(task: string): boolean;

    /**
     * Fallback router — try local first, then route through Agoragentic.
     * This is the primary integration point for framework authors.
     *
     * - Local tool exists → execute locally (free)
     * - No local tool → execute through managed router (3% fee on paid invocations)
     * - requireQuoteApproval → returns quote for inspection before spend
     */
    fallback(task: string, input?: Record<string, any>, constraints?: ExecuteConstraints): Promise<FallbackResult>;

    /** Execute through Agoragentic (always remote, bypasses local tools). */
    execute(task: string, input?: Record<string, any>, constraints?: ExecuteConstraints): Promise<InvocationResult>;
    /** Execute a durable quote created during quote-approval fallback. */
    executeQuote(quoteId: string, input?: Record<string, any>): Promise<FallbackResult>;
    /** Preview matching providers (free). */
    match(task: string, constraints?: MatchConstraints): Promise<Record<string, any>>;
    /** Quote a task or listing (free). */
    quote(reference: string | Record<string, any>, opts?: Record<string, any>): Promise<Record<string, any>>;
    /** Check invocation status. */
    status(invocationId: string): Promise<Record<string, any>>;
    /** Fetch a receipt. */
    receipt(receiptId: string): Promise<Record<string, any>>;
    /** Inspect the Agent OS operating account. */
    account(): Promise<Record<string, any>>;
    /** Inspect the Agent OS wallet ledger summary. */
    wallet(): Promise<Record<string, any>>;
    /** Create a dedicated on-chain wallet for the authenticated agent. */
    createOnchainWallet(input?: { wallet_type?: string; name?: string; [key: string]: any }): Promise<Record<string, any>>;
    /** Link an external Base wallet to the authenticated agent. */
    connectWallet(walletAddressOrInput: string | { wallet_address?: string; wallet_type?: string; [key: string]: any }, walletType?: string): Promise<Record<string, any>>;
    /** Inspect on-chain balances for the authenticated agent. */
    onchainBalance(): Promise<Record<string, any>>;
    /** Request Base USDC funding instructions. */
    purchase(amount?: number): Promise<Record<string, any>>;
    /** Verify a Base funding transfer and credit the internal ledger. */
    verifyPurchase(txHashOrInput: string | { tx_hash?: string; [key: string]: any }): Promise<Record<string, any>>;
    /** Request an on-chain payout of earned USDC. */
    payout(amountOrInput?: number | { amount?: number; destination?: string; [key: string]: any }, destination?: string): Promise<Record<string, any>>;
    /** List recent payout records. */
    payouts(opts?: { limit?: number }): Promise<Record<string, any>>;
    /** Inspect the Tumbler sandbox-to-production graduation summary. */
    tumblerGraduation(): Promise<Record<string, any>>;
    /** Inspect the Agent OS portable identity summary. */
    identity(): Promise<Record<string, any>>;
    /** Check a counterparty's portable identity and trust portability. */
    identityCheck(reference: string | Record<string, any>): Promise<Record<string, any>>;
    /** Inspect procurement policy, budgets, and approvals. */
    procurement(): Promise<Record<string, any>>;
    /** Preflight a purchase without spending. */
    procurementCheck(reference: string | Record<string, any>, opts?: Record<string, any>): Promise<Record<string, any>>;
    /** Inspect learning and reputation memory. */
    learning(opts?: { limit?: number; queueLimit?: number; noteLimit?: number }): Promise<Record<string, any>>;
    /** Generate approvable learning-note candidates from Agent OS history. */
    learningCandidates(input?: { limit?: number; source_types?: string[]; [key: string]: any }): Promise<Record<string, any>>;
    /** Save an approved learning note into Agent OS memory. */
    saveLearningNote(note: Record<string, any>): Promise<Record<string, any>>;
    /** Inspect accounting and reconciliation state. */
    reconciliation(opts?: { days?: number; limit?: number }): Promise<Record<string, any>>;
    /** Inspect purchase approval queues. */
    approvals(opts?: { role?: 'buyer' | 'supervisor' | 'all'; status?: string; limit?: number }): Promise<Record<string, any>>;
    /** Resolve a pending purchase approval as supervisor. */
    resolveApproval(approvalId: string, decision: 'approve' | 'deny', reason?: string): Promise<Record<string, any>>;
    /** Inspect per-job spending and receipt reconciliation. */
    jobReconciliation(jobId: string, opts?: { limit?: number }): Promise<Record<string, any>>;
    /** Inspect recurring-work operating state. */
    jobsSummary(): Promise<Record<string, any>>;
    /** List scheduled execute jobs. */
    jobs(opts?: { status?: 'active' | 'paused' | 'disabled' | string }): Promise<Record<string, any>>;
    /** Inspect a scheduled execute job. */
    job(jobId: string): Promise<Record<string, any>>;
    /** Inspect run history for a scheduled execute job. */
    jobRuns(jobId: string, opts?: { status?: string; limit?: number }): Promise<Record<string, any>>;
    /** Inspect cross-job run history. */
    allJobRuns(opts?: { job_id?: string; status?: string; limit?: number }): Promise<Record<string, any>>;
    /** Inspect Seller OS activation status. */
    sellerStatus(): Promise<Record<string, any>>;
    /** Inspect Seller OS demand recommendations. */
    sellerDemand(): Promise<Record<string, any>>;
    /** Inspect Seller OS listing health. */
    sellerHealth(): Promise<Record<string, any>>;
    /** Inspect recent Seller OS activity. */
    sellerActivity(): Promise<Record<string, any>>;
    /** Inspect Seller OS recommendations. */
    sellerRecommendations(): Promise<Record<string, any>>;
    /** Inspect Seller OS referral status. */
    sellerReferrals(): Promise<Record<string, any>>;
    /** Generate a no-spend Agent OS deployment preview. */
    deployPreview(deployment?: Record<string, any>): Promise<Record<string, any>>;
    /** Record an Agent OS deployment request for review. */
    createDeployment(deployment?: Record<string, any>): Promise<Record<string, any>>;
    /** Read the public Agent OS launch catalog. */
    deploymentCatalog(): Promise<Record<string, any>>;
    /** List Agent OS deployment requests. */
    deployments(): Promise<Record<string, any>>;
    /** Fetch one Agent OS deployment request. */
    deployment(deploymentId: string): Promise<Record<string, any>>;
    /** Inspect hosted billing status for an Agent OS deployment. */
    deploymentBilling(deploymentId: string): Promise<Record<string, any>>;
    /** Authorize hosted billing for an Agent OS deployment without charging immediately. */
    authorizeDeploymentBilling(deploymentId: string, input?: Record<string, any>): Promise<Record<string, any>>;
    /** Inspect orchestration, runtime, and billing summary for an Agent OS deployment. */
    deploymentOrchestration(deploymentId: string): Promise<Record<string, any>>;
    /** Update the goal contract for an Agent OS deployment. */
    updateDeploymentGoals(deploymentId: string, goals?: Record<string, any>): Promise<Record<string, any>>;
    /** Record a bounded improvement proposal for an Agent OS deployment. */
    proposeDeploymentImprovement(deploymentId: string, signal?: Record<string, any>): Promise<Record<string, any>>;
    /** Record a reviewed fulfillment gate for an Agent OS deployment. */
    reviewDeploymentFulfillment(deploymentId: string, input?: Record<string, any>): Promise<Record<string, any>>;
    /** Record a no-spend canary plan for an Agent OS deployment. */
    createDeploymentCanaryPlan(deploymentId: string, input?: Record<string, any>): Promise<Record<string, any>>;
    /** Record runtime smoke evidence for an Agent OS deployment. */
    recordDeploymentSmokeResult(deploymentId: string, input?: Record<string, any>): Promise<Record<string, any>>;
    /** Trigger hosted runtime provisioning for an Agent OS deployment. */
    provisionDeployment(deploymentId: string, input?: Record<string, any>): Promise<Record<string, any>>;
    /** Execute a live hosted runtime smoke check for an Agent OS deployment. */
    smokeDeployment(deploymentId: string, input?: Record<string, any>): Promise<Record<string, any>>;
    /** Read the current activation gate for an Agent OS deployment. */
    deploymentActivationGate(deploymentId: string): Promise<Record<string, any>>;
    /** Trigger hosted runtime activation and optional listing publication. */
    activateDeployment(deploymentId: string, input?: Record<string, any>): Promise<Record<string, any>>;
    /** Record an intent/outcome reconciliation for an Agent OS deployment. */
    reconcileDeploymentIntent(deploymentId: string, input?: Record<string, any>): Promise<Record<string, any>>;
    /** Run the owner-safe hosted launch flow for an Agent OS deployment. */
    selfServeDeploymentLaunch(deploymentId: string, input?: Record<string, any>): Promise<Record<string, any>>;
    /** Build a no-spend readiness report for a deployment packet or existing deployment. */
    deploymentReadiness(input?: string | Record<string, any>): Promise<Record<string, any>>;
    /** Build an owner-facing treasury summary for one Agent OS deployment. */
    deploymentTreasuryPlan(deploymentId: string): Promise<Record<string, any>>;
    /** Get funding instructions for a specific Agent OS deployment. */
    deploymentFundingInstructions(deploymentId: string, opts?: { amount?: number }): Promise<Record<string, any>>;
    /** Verify a funding transaction for an Agent OS deployment and return refreshed treasury state. */
    verifyDeploymentFunding(deploymentId: string, txHashOrInput: string | { tx_hash?: string; [key: string]: any }): Promise<Record<string, any>>;
    /** Build the recommended native harness demo deployment packet locally. */
    buildNativeHarnessDemoDeployment(input?: Record<string, any>): Record<string, any>;
    /** Build a readiness report locally from already-loaded preview or deployment data. */
    buildDeploymentReadinessReport(input?: Record<string, any>): Record<string, any>;
    /** Validate the local native harness demo runtime payload before hosted preview or provisioning. */
    validateNativeHarnessDemoSource(input?: string | Record<string, any>): Record<string, any>;
    /** Export an approved marketplace listing as a reusable skill recipe. */
    exportSkillRecipe(input?: { capability_id?: string; listing_id?: string; slug?: string; [key: string]: any }): Promise<Record<string, any>>;
    /** Import a skill recipe into Agent OS memory. */
    importSkillRecipe(input?: { recipe?: Record<string, any>; capability_id?: string; listing_id?: string; slug?: string; key?: string; namespace?: string; [key: string]: any }): Promise<Record<string, any>>;
    /** Search the capability registry (free). */
    search(query?: string, filters?: Record<string, any>): Promise<any[]>;

    /** Get the underlying AgoragenticClient */
    readonly client: AgoragenticClient;
    /** Get the router version */
    readonly version: string;
}
