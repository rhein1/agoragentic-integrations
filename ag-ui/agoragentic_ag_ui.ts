/**
 * Agoragentic AG-UI Event Bridge
 * 
 * Translates Agoragentic lifecycle events (quotes, execution progress, approvals,
 * and x402 challenges) into AG-UI protocol-compliant events for frontend interfaces.
 * 
 * AG-UI is a presentation/UI layer protocol and does not replace the underlying
 * MCP, Agent Client Protocol (ACP), Agent OS policy controls, or x402 settlement layers.
 */

export interface AgoragenticEvent {
  type: 
    | 'quote_requested'
    | 'quote_ready'
    | 'execute_started'
    | 'provider_matched'
    | 'approval_required'
    | 'receipt_ready'
    | 'execute_failed';
  timestamp: string;
  payload: Record<string, any>;
  invocationId?: string;
  jobId?: string;
}

export interface AgUiEvent {
  event: 'quote/start' | 'quote/result' | 'tool/start' | 'state/patch' | 'human/approval' | 'result/artifact' | 'error';
  timestamp: string;
  uiHint: 'modal' | 'toast' | 'card' | 'inline' | 'error_boundary';
  data: Record<string, any>;
}

export class AgoragenticAgUiAdapter {
  private dryRun: boolean;

  constructor(options: { dryRun?: boolean } = {}) {
    this.dryRun = options.dryRun ?? false;
  }

  /**
   * Translates an Agoragentic execution event into an AG-UI compatible structure.
   */
  public translateEvent(event: AgoragenticEvent): AgUiEvent {
    const timestamp = event.timestamp || new Date().toISOString();
    const data = { ...event.payload };

    if (this.dryRun) {
      data._dryRun = true;
    }

    switch (event.type) {
      case 'quote_requested':
        return {
          event: 'quote/start',
          timestamp,
          uiHint: 'toast',
          data: {
            message: 'Generating transaction quote...',
            taskId: data.taskId,
            constraints: data.constraints,
          },
        };

      case 'quote_ready':
        return {
          event: 'quote/result',
          timestamp,
          uiHint: 'card',
          data: {
            quoteId: data.quoteId,
            costUsdc: data.costUsdc,
            expiresAt: data.expiresAt,
            providerName: data.providerName,
            recommended: data.recommended ?? true,
          },
        };

      case 'execute_started':
        return {
          event: 'tool/start',
          timestamp,
          uiHint: 'inline',
          data: {
            invocationId: event.invocationId || data.invocationId,
            task: data.task,
            runningSince: timestamp,
          },
        };

      case 'provider_matched':
        return {
          event: 'state/patch',
          timestamp,
          uiHint: 'inline',
          data: {
            invocationId: event.invocationId || data.invocationId,
            matchedProvider: {
              id: data.providerId,
              name: data.providerName,
              trustLevel: data.trustLevel || 'reachable',
            },
            progress: 50,
          },
        };

      case 'approval_required':
        return {
          event: 'human/approval',
          timestamp,
          uiHint: 'modal',
          data: {
            approvalId: data.approvalId,
            costUsdc: data.costUsdc,
            policyKey: data.policyKey,
            promptMessage: data.promptMessage || 'This operation requires spend approval.',
            actions: ['approve', 'deny'],
          },
        };

      case 'receipt_ready':
        return {
          event: 'result/artifact',
          timestamp,
          uiHint: 'card',
          data: {
            receiptId: data.receiptId,
            status: 'completed',
            executionTimeMs: data.executionTimeMs,
            costUsdc: data.costUsdc,
            receiptUrl: data.receiptUrl,
            artifact: data.artifact, // Public-safe result only
          },
        };

      case 'execute_failed':
        return {
          event: 'error',
          timestamp,
          uiHint: 'error_boundary',
          data: {
            errorType: data.errorType || 'execution_failed',
            message: data.publicMessage || 'An error occurred during execution.',
            code: data.code || 'UNKNOWN_ERROR',
          },
        };

      default:
        // Fallback for unknown/custom event types
        return {
          event: 'state/patch',
          timestamp,
          uiHint: 'inline',
          data: {
            rawType: event.type,
            ...data,
          },
        };
    }
  }
}
