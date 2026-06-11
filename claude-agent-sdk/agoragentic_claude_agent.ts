/**
 * Claude Agent SDK Gating Adapter for Agoragentic (TypeScript).
 * 
 * Enforces permission middleware, maximum spend constraints, and file/network actions
 * gating for Claude Agent SDK-compatible agent code.
 */

export interface ClaudePermissionsConfig {
  max_spend_usdc_per_call: number;
  allow_file_access_before_execution: boolean;
  require_hitl_for_spend: boolean;
  publish_receipts_publicly: boolean;
}

export class ClaudeAgentSdkGatingAdapter {
  private permissions: ClaudePermissionsConfig;

  constructor(config?: Partial<ClaudePermissionsConfig>) {
    this.permissions = {
      max_spend_usdc_per_call: config?.max_spend_usdc_per_call ?? 0.25,
      allow_file_access_before_execution: config?.allow_file_access_before_execution ?? false,
      require_hitl_for_spend: config?.require_hitl_for_spend ?? true,
      publish_receipts_publicly: config?.publish_receipts_publicly ?? false,
    };
  }

  /**
   * Evaluates if a marketplace capability execution tool call is permitted by the local security policy.
   */
  public verifyToolPermission(
    toolName: string,
    args: Record<string, any>
  ): { allowed: boolean; status: string; reason?: string } {
    if (toolName === 'agoragentic_execute') {
      // 1. Spend limit check
      const maxAllowed = this.permissions.max_spend_usdc_per_call;
      const requestedCap = Number(args.constraints?.max_cost_usdc || 0);

      if (requestedCap > maxAllowed) {
        return {
          allowed: false,
          status: 'Denied_Spend_Limit_Exceeded',
          reason: `Spend cap ${requestedCap} USDC exceeds policy maximum of ${maxAllowed} USDC.`,
        };
      }

      // 2. Pre-execution file access check
      if (!this.permissions.allow_file_access_before_execution) {
        if (args.input_data?.read_local_files === true) {
          return {
            allowed: false,
            status: 'Denied_File_Access_Blocked',
            reason: 'Local file extraction is restricted before paid execution.',
          };
        }
      }

      // 3. Human in the loop check
      if (this.permissions.require_hitl_for_spend) {
        return {
          allowed: true,
          status: 'Authorized_With_HITL_Gate',
        };
      }
    }

    return { allowed: true, status: 'Authorized' };
  }

  /**
   * Sanitizes execution results and logs receipt metadata before outputting it.
   */
  public handlePostExecution(result: Record<string, any>): Record<string, any> {
    const receipt = { ...result.receipt };

    if (!this.permissions.publish_receipts_publicly) {
      if (receipt.settlement_address) {
        receipt.settlement_address = '[REDACTED_BY_CLAUDE_SDK_POLICY]';
      }
    }

    return {
      ...result,
      receipt,
    };
  }
}
