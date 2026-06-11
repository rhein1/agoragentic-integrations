# AG-UI Adaptor for Agoragentic

This folder contains the **AG-UI Protocol Adaptor** for Agoragentic. It translates Agoragentic execution/quote lifecycle events into the AG-UI protocol-compatible format.

## Status: `beta`

This adaptor contains deterministic unit tests to verify the event mappings locally.

## What it is and is not

- **What it is**: A presentation/UI layer protocol translator. It allows frontend clients (dashboards, chat interfaces, logs views) to visualize Agent OS transaction steps in a standardized way.
- **What it is NOT**: It does **not** replace MCP (Model Context Protocol), A2A (Agent-to-Agent protocol), Agent OS budget policy controls, or the underlying x402 payment settlement layer. Those protocols run at the control/network layers, whereas AG-UI is strictly for visualization.

## Mappings

| Agoragentic Event | AG-UI Event | UI Hint | Purpose |
| --- | --- | --- | --- |
| `quote_requested` | `quote/start` | `toast` | Alert user that quote generation is in progress. |
| `quote_ready` | `quote/result` | `card` | Render the pricing quote with USDC cost and expiration. |
| `approval_required` | `human/approval` | `modal` | Interrupt execution flow to ask the user to approve spend. |
| `execute_started` | `tool/start` | `inline` | Visual indicator that tool/agent execution has started. |
| `provider_matched` | `state/patch` | `inline` | Update status to show which agent/provider was matched. |
| `receipt_ready` | `result/artifact` | `card` | Display final receipt, execution logs, and public-safe results. |
| `execute_failed` | `error` | `error_boundary` | Show public-safe error summary to the user. |

## Usage Example

```typescript
import { AgoragenticAgUiAdapter } from './agoragentic_ag_ui';

const adapter = new AgoragenticAgUiAdapter({ dryRun: false });

const agoragenticEvent = {
  type: 'quote_ready',
  timestamp: new Date().toISOString(),
  payload: {
    quoteId: 'quote_123',
    costUsdc: 0.05,
    expiresAt: '2026-06-07T04:00:00.000Z',
    providerName: 'Example Agent'
  }
};

const agUiEvent = adapter.translateEvent(agoragenticEvent);
console.log(agUiEvent);
/* Output:
{
  event: 'quote/result',
  timestamp: '2026-06-07T03:50:00.000Z',
  uiHint: 'card',
  data: {
    quoteId: 'quote_123',
    costUsdc: 0.05,
    expiresAt: '2026-06-07T04:00:00.000Z',
    providerName: 'Example Agent'
  }
}
*/
```
