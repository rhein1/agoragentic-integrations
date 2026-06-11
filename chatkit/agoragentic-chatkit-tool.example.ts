/**
 * ChatKit Custom UI Component Example for Agoragentic.
 * 
 * Demonstrates how to render Agoragentic transaction events inside a ChatKit-compatible
 * chat interface, styling elements such as:
 * - Quote previews.
 * - Human-in-the-loop (spend approval required) modals or inline prompts.
 * - In-progress invocation status bars.
 * - Finalized receipt artifact cards (including public-safe provider metadata).
 */

export interface ChatKitCardProps {
  title: string;
  variant: 'info' | 'warning' | 'success' | 'error';
  body: string;
  metadata?: Record<string, any>;
  actions?: Array<{ label: string; actionId: string }>;
}

export class AgoragenticChatKitRenderer {
  /**
   * Renders the custom UI element for a given Agoragentic state.
   */
  public renderState(state: {
    phase: 'quote' | 'approval' | 'executing' | 'completed' | 'error';
    data: Record<string, any>;
  }): ChatKitCardProps {
    switch (state.phase) {
      case 'quote':
        return {
          title: 'Agoragentic Routed Quote Preview',
          variant: 'info',
          body: `Estimating task cost. Recommended provider: ${state.data.providerName || 'Auto-Match'}.`,
          metadata: {
            'Estimated Spend': `${state.data.costUsdc || 0.0} USDC`,
            'Expiration': state.data.expiresAt || '10 minutes',
          },
          actions: [
            { label: 'Proceed to Execution', actionId: 'accept_quote' }
          ]
        };

      case 'approval':
        return {
          title: 'Spend Approval Required',
          variant: 'warning',
          body: `Execution exceeds automatic limits. Policy gate: "${state.data.policyKey}".`,
          metadata: {
            'Required Authorization': `${state.data.costUsdc} USDC`,
            'Request ID': state.data.approvalId
          },
          actions: [
            { label: 'Approve Payment', actionId: 'approve_spend' },
            { label: 'Reject', actionId: 'reject_spend' }
          ]
        };

      case 'executing':
        return {
          title: 'Executing Capability Call',
          variant: 'info',
          body: `Routing task: "${state.data.task}". Matching verified providers on Base...`,
          metadata: {
            'Invocation ID': state.data.invocationId,
            'Status': 'matching_providers'
          }
        };

      case 'completed':
        return {
          title: 'Receipt Card',
          variant: 'success',
          body: 'Execution completed. Receipt settled on Base L2.',
          metadata: {
            'Receipt ID': state.data.receiptId,
            'Execution Cost': `${state.data.costUsdc} USDC`,
            'Settled Hash': state.data.transactionHash || '[HIDDEN_PUBLIC_SAFE]'
          },
          actions: [
            { label: 'View Full Audit Trail', actionId: 'view_receipt_audit' }
          ]
        };

      case 'error':
        return {
          title: 'Execution Interrupted',
          variant: 'error',
          body: state.data.publicMessage || 'The transaction failed to complete.',
          metadata: {
            'Reason Code': state.data.code || 'UNKNOWN_ERROR',
            'Context': 'Public-safe summary'
          }
        };

      default:
        return {
          title: 'Agoragentic Platform Adapter',
          variant: 'info',
          body: 'System idle.'
        };
    }
  }
}
