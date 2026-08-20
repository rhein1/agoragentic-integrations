export type GovernanceDecision = 'allow' | 'ask' | 'deny';

export const POLICY_SCHEMA: 'agoragentic.local-governance-policy.v1';
export const RECEIPT_SCHEMA: 'agoragentic.local-action-receipt.v1';
export const DEFAULT_POLICY_FILE: 'agoragentic.yaml';

export interface LocalGovernancePolicy {
  schema: 'agoragentic.local-governance-policy.v1';
  default_decision: GovernanceDecision;
  receipts?: { enabled?: boolean; directory?: string };
  actions: Record<string, { decision: GovernanceDecision; approval?: string }>;
  authority?: { spend?: 'owner_only'; retry?: 'owner_only' };
}

export interface GovernOptions<TResult = unknown> {
  action: string;
  policy?: string | LocalGovernancePolicy;
  cwd?: string;
  approved?: boolean;
  receipts?: boolean;
  approve?: (request: { action: string; argument_count: number }) => boolean | Promise<boolean>;
  evidence?: (result: TResult) => unknown | Promise<unknown>;
  onReceipt?: (receipt: unknown) => void | Promise<void>;
}

export function createDefaultPolicy(): LocalGovernancePolicy;
export function detectAdapters(cwd?: string): unknown[];
export function initializeProject(options?: { cwd?: string; policyPath?: string; write?: boolean; force?: boolean }): unknown;
export function loadPolicy(policy?: string | LocalGovernancePolicy, options?: { cwd?: string }): LocalGovernancePolicy;
export function evaluatePolicy(policy: LocalGovernancePolicy, action: string, options?: { approved?: boolean }): unknown;
export function govern<TArgs extends unknown[], TResult>(
  tool: (...args: TArgs) => TResult | Promise<TResult>,
  options: GovernOptions<TResult>
): (...args: TArgs) => Promise<TResult>;
export function runGovernedCommand(
  executable: string,
  args?: string[],
  options?: {
    cwd?: string;
    policy?: string | LocalGovernancePolicy;
    approved?: boolean;
    env?: Record<string, string | undefined>;
    stdio?: unknown;
  }
): Promise<unknown>;
