/**
 * Agoragentic — Official Node.js SDK
 * TypeScript type definitions
 */

export interface LangSmithBridge {
    traceable?: (...args: any[]) => any;
    getCurrentRunTree?: () => { toHeaders?: () => Record<string, string> } | undefined;
}

export interface LangSmithOptions extends LangSmithBridge {
    enabled?: boolean;
    projectName?: string;
    operationPrefix?: string;
    metadata?: Record<string, any>;
    tags?: string[];
}

export interface AgoragenticOptions {
    apiKey?: string;
    baseUrl?: string;
    timeout?: number;
    owsWallet?: any;
    gatewayAgentId?: string;
    langsmith?: boolean | LangSmithOptions;
}

export interface ExecuteConstraints {
    prefer_trusted?: boolean;
    max_cost?: number;
    preferred_category?: string;
    max_latency_ms?: number;
    max_retries?: number;
    quote_id?: string;
    gateway_agent_id?: string;
    gatewayAgentId?: string;
    openai_agents_trace?: Record<string, any>;
    openaiAgentsTrace?: Record<string, any>;
    trace_context?: Record<string, any>;
    traceContext?: Record<string, any>;
}

export interface MatchConstraints {
    prefer_trusted?: boolean;
    max_cost?: number;
    category?: string;
    max_latency_ms?: number;
    payment_network?: string;
    payment_asset?: string;
}

export interface SearchFilters {
    category?: string;
    maxPrice?: number;
    seller?: string;
    status?: string;
}

export interface Capability {
    id: string;
    name: string;
    description: string;
    category: string;
    price_per_unit: number;
    pricing_model?: string;
    seller_id?: string;
    seller_name?: string;
    seller_agent_uri?: string | null;
    seller_agent_uri_slug?: string | null;
    tags?: string[];
    status?: string;
    endpoint_url?: string;
    review_status?: string;
}

export interface InvocationResult {
    success?: boolean;
    status?: string;
    result?: any;
    output?: any;
    cost?: number;
    platform_fee?: number;
    seller_payout?: number;
    invocation_id?: string;
    listing?: { id: string; name: string };
    provider?: Record<string, any>;
    receipt?: Record<string, any>;
}

export interface RegisterResult {
    id?: string;
    agent_id?: string;
    name?: string;
    api_key: string;
    signing_key?: string;
    public_key?: string;
    agent_uri?: string | null;
    agent_uri_slug?: string | null;
}

export interface WalletInfo {
    balance: number;
    currency: string;
    withdrawable_balance?: number;
    total_deposited?: number;
    total_spent?: number;
    total_earned?: number;
    policy?: WalletPolicy;
}

export interface NativeHarnessDemoDeploymentInput {
    name?: string;
    description?: string;
    source_ref?: string;
    sourceRef?: string;
    repository?: string;
    repo?: string;
    image?: string;
    source_type?: 'repository' | 'container_image' | string;
    sourceType?: 'repository' | 'container_image' | string;
    branch?: string;
    source_dir?: string;
    sourceDirectory?: string;
    health_path?: string;
    healthPath?: string;
    connection_arn?: string;
    connectionArn?: string;
    access_role_arn?: string;
    accessRoleArn?: string;
    instance_role_arn?: string;
    instanceRoleArn?: string;
    service_prefix?: string;
    servicePrefix?: string;
    build_command?: string;
    buildCommand?: string;
    start_command?: string;
    startCommand?: string;
    runtime?: string;
    port?: number;
    model_profile?: string;
    modelProfile?: string;
    bedrock_region?: string;
    bedrockRegion?: string;
    exposure_mode?: string;
    exposureMode?: string;
    billing_plan?: string;
    billingPlan?: string;
    autonomy_tier?: string;
    autonomyTier?: string;
    ecf_profile?: string;
    ecfProfile?: string;
    goal?: string;
    success_metrics?: string[];
    max_daily_spend?: number;
    max_daily_spend_usdc?: number;
    approval_above?: number;
    approval_required_above_usdc?: number;
    tags?: string[];
}

export interface DeploymentReadinessInput {
    deploymentId?: string;
    deployment_id?: string;
    id?: string;
    deployment?: Record<string, any>;
    packet?: Record<string, any>;
    request?: Record<string, any>;
}

export interface WalletPolicy {
    daily_spend_cap?: number;
    per_call_max_cost?: number;
    auto_approve_max_usdc?: number;
    rate_limit_per_minute?: number;
    max_price_per_call?: number | null;
    allowed_categories?: string[];
    allowed_sellers?: string[];
    blocked_sellers?: string[];
    approval?: {
        require_approval?: boolean;
        supervisor_id?: string | null;
    };
    updated_at?: string | null;
}

export interface AgentSummary {
    id?: string;
    agent_id?: string;
    name?: string;
    description?: string;
    type?: string;
    agent_uri?: string | null;
    agent_uri_slug?: string | null;
    verified?: boolean;
    verification_tier?: string;
    tags?: string[];
    created_at?: string;
}

export declare class AgoragenticClient {
    constructor(options?: AgoragenticOptions);

    register(opts: { name: string; description?: string; type?: 'buyer' | 'seller' | 'both'; agent_uri?: string; owner_email?: string }): Promise<RegisterResult>;
    execute(task: string | null, input?: Record<string, any>, constraints?: ExecuteConstraints): Promise<InvocationResult>;
    match(task: string, constraints?: MatchConstraints): Promise<Record<string, any>>;
    status(invocationId: string): Promise<Record<string, any>>;
    search(query?: string, filters?: SearchFilters): Promise<Capability[]>;
    getCapability(id: string): Promise<Capability>;
    invoke(id: string, input?: any, opts?: { maxCost?: number; quoteId?: string; gateway_agent_id?: string; gatewayAgentId?: string; openai_agents_trace?: Record<string, any>; openaiAgentsTrace?: Record<string, any>; trace_context?: Record<string, any>; traceContext?: Record<string, any> }): Promise<InvocationResult>;
    withGatewayAgent(gatewayAgentId: string | null): AgoragenticClient;

    getAgent(reference: string): Promise<AgentSummary | Record<string, any>>;
    resolveAgent(reference: string, opts?: { limit?: number }): Promise<Record<string, any>>;
    claimAgentUri(agentId: string, agentUri: string): Promise<Record<string, any>>;

    review(listingId: string, rating: number, comment?: string): Promise<Record<string, any>>;
    getReviews(listingId: string): Promise<Record<string, any>>;
    pendingReviews(): Promise<Record<string, any>>;

    echo(input: any): Promise<any>;
    uuid(): Promise<{ uuid: string }>;
    fortune(): Promise<{ fortune: string }>;
    palette(opts?: { mood?: string }): Promise<Record<string, any>>;
    mdToJson(opts: { markdown: string }): Promise<Record<string, any>>;

    vaultList(): Promise<any>;
    vaultStore(item: { name: string; type: string; data: any }): Promise<any>;
    vaultGet(id: string): Promise<any>;

    wallet(): Promise<WalletInfo>;
    walletPolicy(): Promise<{ policy: WalletPolicy; semantics?: Record<string, any> }>;
    setWalletPolicy(policy: WalletPolicy & { require_approval?: boolean; supervisor_id?: string | null }): Promise<Record<string, any>>;
    createOnchainWallet(input?: { wallet_type?: string; name?: string; [key: string]: any }): Promise<Record<string, any>>;
    connectWallet(walletAddressOrInput: string | { wallet_address?: string; wallet_type?: string; [key: string]: any }, walletType?: string): Promise<Record<string, any>>;
    onchainBalance(): Promise<Record<string, any>>;
    purchase(amount?: number): Promise<Record<string, any>>;
    verifyPurchase(txHashOrInput: string | { tx_hash?: string; [key: string]: any }): Promise<Record<string, any>>;
    payout(amountOrInput?: number | { amount?: number; destination?: string; [key: string]: any }, destination?: string): Promise<Record<string, any>>;
    payouts(opts?: { limit?: number }): Promise<Record<string, any>>;
    transactions(filters?: { limit?: number; type?: string }): Promise<Record<string, any>>;
    dashboard(): Promise<Record<string, any>>;

    stats(): Promise<Record<string, any>>;
    x402Info(): Promise<Record<string, any>>;
    x402Listings(): Promise<any[]>;
    x402Discover(): Promise<Record<string, any>>;
    x402ExecuteMatch(task: string, constraints?: MatchConstraints): Promise<Record<string, any>>;
    x402Execute(quoteId: string, input?: any, opts?: { walletAddress?: string; gateway_agent_id?: string; gatewayAgentId?: string; openai_agents_trace?: Record<string, any>; openaiAgentsTrace?: Record<string, any>; trace_context?: Record<string, any>; traceContext?: Record<string, any> }): Promise<Record<string, any>>;
    buildX402ClaimProofMessage(walletAddress: string): string;
    buildX402ClaimProof(walletAddress: string, signer?: { signMessage?: (message: string) => Promise<string> | string }, opts?: { message?: string }): Promise<Record<string, any>>;
    x402Claim(input?: { walletAddress?: string; wallet_address?: string; proof?: { message?: string; signature?: string }; limit?: number; offset?: number; include_payload?: boolean }): Promise<Record<string, any>>;
    x402Invoke(id: string, input?: any, opts?: { walletAddress?: string; gateway_agent_id?: string; gatewayAgentId?: string; openai_agents_trace?: Record<string, any>; openaiAgentsTrace?: Record<string, any>; trace_context?: Record<string, any>; traceContext?: Record<string, any> }): Promise<Record<string, any>>;
    x402Convert(payload?: Record<string, any>): Promise<Record<string, any>>;
    quote(reference: string | { task?: string; capability_id?: string; listing_id?: string; slug?: string; units?: number; max_cost?: number; category?: string; max_latency_ms?: number; prefer_trusted?: boolean; payment_network?: string; payment_asset?: string }, opts?: { units?: number; max_cost?: number; category?: string; max_latency_ms?: number; prefer_trusted?: boolean; payment_network?: string; payment_asset?: string }): Promise<Record<string, any>>;
    receipt(receiptId: string): Promise<Record<string, any>>;
    /** Agent Commerce Interchange (control-plane only; live spend stays on execute()/invoke()). */
    interchangeCard(input: string | { capability_id?: string; name?: string; description?: string; source_ref?: string; pricing?: Record<string, any> }): Promise<Record<string, any>>;
    interchangeGetCard(cardId: string): Promise<Record<string, any>>;
    interchangeCreateMandate(input: { buyer_agent_id: string; deployment_id: string; idempotency_key: string; budget?: { max_per_call?: string; max_daily?: string; max_total?: string; currency?: string }; allowed_capability_card_refs?: string[]; allowed_actions?: string[]; expires_at?: string; allowed_categories?: string[]; blocked_categories?: string[]; allowed_providers?: string[]; blocked_providers?: string[] }): Promise<Record<string, any>>;
    interchangeReviewMandate(mandateId: string, decision: 'approve' | 'reject', reason?: string): Promise<Record<string, any>>;
    interchangeSpendStatus(mandateId: string): Promise<Record<string, any>>;
    interchangeCreatePlan(input: { capability_card_id: string; mandate_id: string; requested_action?: string; max_amount: string; idempotency_key: string }): Promise<Record<string, any>>;
    interchangeGetPlan(planId: string): Promise<Record<string, any>>;
    interchangeAdvancePlan(planId: string, input?: { invocation_id?: string; target_state?: string }): Promise<Record<string, any>>;
    interchangeOpenDispute(planId: string, reason: string): Promise<Record<string, any>>;
    interchangeReceipt(receiptId: string): Promise<Record<string, any>>;
    interchangeVerifyReceipt(input: string | { receipt_id?: string; receipt?: Record<string, any> }): Promise<Record<string, any>>;
    interchangeProviderReputation(providerId: string): Promise<Record<string, any>>;
    account(): Promise<Record<string, any>>;
    tumblerGraduation(): Promise<Record<string, any>>;
    identity(): Promise<Record<string, any>>;
    identityCheck(reference: string | { agent_ref?: string; agent_id?: string; agent_uri?: string; wallet_address?: string }): Promise<Record<string, any>>;
    procurement(): Promise<Record<string, any>>;
    procurementCheck(reference: string | { capability_id?: string; listing_id?: string; slug?: string; quoted_cost_usdc?: number }, opts?: { quotedCostUsdc?: number }): Promise<Record<string, any>>;
    learning(opts?: { limit?: number; queueLimit?: number; noteLimit?: number }): Promise<Record<string, any>>;
    learningCandidates(input?: { limit?: number; source_types?: string[]; [key: string]: any }): Promise<Record<string, any>>;
    reconciliation(opts?: { days?: number; limit?: number }): Promise<Record<string, any>>;
    approvals(opts?: { role?: 'buyer' | 'supervisor' | 'all'; status?: string; limit?: number }): Promise<Record<string, any>>;
    resolveApproval(approvalId: string, decision: 'approve' | 'deny', reason?: string): Promise<Record<string, any>>;
    jobReconciliation(jobId: string, opts?: { limit?: number }): Promise<Record<string, any>>;
    jobsSummary(): Promise<Record<string, any>>;
    jobs(opts?: { status?: 'active' | 'paused' | 'disabled' | string }): Promise<Record<string, any>>;
    job(jobId: string): Promise<Record<string, any>>;
    jobRuns(jobId: string, opts?: { status?: string; limit?: number }): Promise<Record<string, any>>;
    allJobRuns(opts?: { job_id?: string; status?: string; limit?: number }): Promise<Record<string, any>>;
    sellerStatus(): Promise<Record<string, any>>;
    sellerDemand(): Promise<Record<string, any>>;
    sellerHealth(): Promise<Record<string, any>>;
    sellerActivity(): Promise<Record<string, any>>;
    sellerRecommendations(): Promise<Record<string, any>>;
    sellerReferrals(): Promise<Record<string, any>>;
    deployPreview(deployment?: Record<string, any>): Promise<Record<string, any>>;
    createDeployment(deployment?: Record<string, any>): Promise<Record<string, any>>;
    deploymentCatalog(): Promise<Record<string, any>>;
    deployments(): Promise<Record<string, any>>;
    deployment(deploymentId: string): Promise<Record<string, any>>;
    deploymentBilling(deploymentId: string): Promise<Record<string, any>>;
    authorizeDeploymentBilling(deploymentId: string, input?: Record<string, any>): Promise<Record<string, any>>;
    deploymentOrchestration(deploymentId: string): Promise<Record<string, any>>;
    updateDeploymentGoals(deploymentId: string, goals?: Record<string, any>): Promise<Record<string, any>>;
    proposeDeploymentImprovement(deploymentId: string, signal?: Record<string, any>): Promise<Record<string, any>>;
    reviewDeploymentFulfillment(deploymentId: string, input?: Record<string, any>): Promise<Record<string, any>>;
    createDeploymentCanaryPlan(deploymentId: string, input?: Record<string, any>): Promise<Record<string, any>>;
    recordDeploymentSmokeResult(deploymentId: string, input?: Record<string, any>): Promise<Record<string, any>>;
    provisionDeployment(deploymentId: string, input?: Record<string, any>): Promise<Record<string, any>>;
    smokeDeployment(deploymentId: string, input?: Record<string, any>): Promise<Record<string, any>>;
    deploymentActivationGate(deploymentId: string): Promise<Record<string, any>>;
    activateDeployment(deploymentId: string, input?: Record<string, any>): Promise<Record<string, any>>;
    reconcileDeploymentIntent(deploymentId: string, input?: Record<string, any>): Promise<Record<string, any>>;
    selfServeDeploymentLaunch(deploymentId: string, input?: Record<string, any>): Promise<Record<string, any>>;
    deploymentReadiness(input?: string | DeploymentReadinessInput | Record<string, any>): Promise<Record<string, any>>;
    deploymentTreasuryPlan(deploymentId: string): Promise<Record<string, any>>;
    deploymentFundingInstructions(deploymentId: string, opts?: { amount?: number }): Promise<Record<string, any>>;
    verifyDeploymentFunding(deploymentId: string, txHashOrInput: string | { tx_hash?: string; [key: string]: any }): Promise<Record<string, any>>;
    exportSkillRecipe(input?: { capability_id?: string; listing_id?: string; slug?: string; [key: string]: any }): Promise<Record<string, any>>;
    importSkillRecipe(input?: { recipe?: Record<string, any>; capability_id?: string; listing_id?: string; slug?: string; key?: string; namespace?: string; [key: string]: any }): Promise<Record<string, any>>;

    listService(capability: {
        name: string;
        description: string;
        category: string;
        price_per_unit: number;
        endpoint_url: string;
        input_schema?: string | Record<string, any>;
        output_schema?: string | Record<string, any>;
    }): Promise<any>;
}

declare function agoragentic(options?: AgoragenticOptions | string): AgoragenticClient;

export default agoragentic;
export { agoragentic };
export declare function buildX402ClaimProofMessage(walletAddress: string): string;
export declare function buildNativeHarnessDemoDeployment(input?: NativeHarnessDemoDeploymentInput): Record<string, any>;
export declare function buildDeploymentReadinessReport(input?: Record<string, any>): Record<string, any>;
export declare function validateNativeHarnessDemoSource(input?: string | { path?: string; source_dir?: string; sourceDirectory?: string }): Record<string, any>;
