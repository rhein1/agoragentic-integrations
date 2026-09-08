/** Local preflight + SDK callback shape. Never dispatches or authorizes paid work. */
export interface ClaudePermissionsConfig {
  max_spend_usdc_per_call: number | string;
  allow_file_access_before_execution: boolean;
  require_hitl_for_spend: boolean;
  publish_receipts_publicly: boolean;
}
export interface Decision { allowed: boolean; status: string; }
export interface PreToolHookResult {
  hookSpecificOutput?: { hookEventName: 'PreToolUse'; permissionDecision: 'deny'; permissionDecisionReason: string };
}
const READ_TOOLS = new Set(['agoragentic_match', 'agoragentic_search', 'agoragentic_categories']);
const EXECUTE_TOOLS = new Set(['agoragentic_execute', 'agoragentic_invoke']);
const DEFAULTS: ClaudePermissionsConfig = {
  max_spend_usdc_per_call: '0.25', allow_file_access_before_execution: false,
  require_hitl_for_spend: true, publish_receipts_publicly: false,
};
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
export function money(value: unknown): bigint {
  if (!['number', 'string'].includes(typeof value)) throw new Error('invalid_money');
  if (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0))) throw new Error('invalid_money');
  const text = String(value);
  if (text.trim() !== text || !/^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/.test(text)) throw new Error('invalid_money');
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'));
}
export class ClaudeAgentSdkGatingAdapter {
  private readonly permissions: Readonly<ClaudePermissionsConfig>;
  constructor(config: Partial<ClaudePermissionsConfig> = {}) {
    if (!object(config) || Object.keys(config).some(key => !Object.hasOwn(DEFAULTS, key))) throw new Error('unknown_permission');
    const merged = { ...DEFAULTS, ...config };
    money(merged.max_spend_usdc_per_call);
    for (const key of ['allow_file_access_before_execution', 'require_hitl_for_spend', 'publish_receipts_publicly'] as const) {
      if (typeof merged[key] !== 'boolean') throw new Error('permission_must_be_boolean');
    }
    this.permissions = Object.freeze(merged);
  }
  verifyToolPermission(toolName: unknown, args: unknown): Decision {
    const deny = (status: string): Decision => ({ allowed: false, status });
    if (typeof toolName !== 'string' || !object(args)) return deny('Invalid_Tool_Input');
    if (READ_TOOLS.has(toolName)) return { allowed: true, status: 'Read_Only_Preflight' };
    if (!EXECUTE_TOOLS.has(toolName)) return deny('Unsupported_Tool');
    if (!object(args.constraints) || !Object.hasOwn(args.constraints, 'max_cost_usdc')) return deny('Invalid_Spend_Cap');
    let requested: bigint;
    try { requested = money(args.constraints.max_cost_usdc); } catch { return deny('Invalid_Spend_Cap'); }
    if (requested > money(this.permissions.max_spend_usdc_per_call)) return deny('Denied_Spend_Limit_Exceeded');
    const data = args.input_data === undefined ? {} : args.input_data;
    if (!object(data)) return deny('Invalid_Tool_Input');
    if (Object.hasOwn(data, 'read_local_files')) {
      if (typeof data.read_local_files !== 'boolean') return deny('Invalid_Tool_Input');
      if (data.read_local_files && !this.permissions.allow_file_access_before_execution) return deny('Denied_File_Access_Blocked');
    }
    return deny(this.permissions.require_hitl_for_spend ? 'Approval_Required' : 'Paid_Execution_Unavailable');
  }
  /** A successful preflight does not override other host permissions. */
  async preToolUse(input: unknown, _toolUseID?: unknown, _context?: unknown): Promise<PreToolHookResult> {
    const decision = object(input) && input.hook_event_name === 'PreToolUse'
      ? this.verifyToolPermission(input.tool_name, input.tool_input)
      : { allowed: false, status: 'Invalid_Hook_Input' };
    if (decision.allowed) return {};
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: decision.status } };
  }
  /** Supply explicitly to the SDK options; no import-time SDK/network work. */
  sdkHooks() { return { PreToolUse: [{ hooks: [this.preToolUse.bind(this)] }] }; }
  /** Lossy display projection, not verification evidence or a general PII filter. */
  handlePostExecution(result: unknown): Record<string, unknown> {
    if (!object(result)) throw new Error('result_must_be_object');
    const receipt: Record<string, string> = { projection: 'receipt_display_only' };
    if (object(result.receipt) && typeof result.receipt.status === 'string'
      && ['recorded', 'blocked', 'failed', 'pending', 'completed'].includes(result.receipt.status)) {
      receipt.status = result.receipt.status;
    }
    return { ...result, receipt };
  }
}
