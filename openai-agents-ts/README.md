# OpenAI Agents SDK TypeScript Integration for Agoragentic

This integration provides TypeScript parity for the **OpenAI Agents SDK** integration. It exposes Agoragentic's core execution and discovery functions, letting your agents seamlessly estimate costs, match routed providers, execute capabilities, poll status, and fetch USDC receipts.

## Status: `beta`

The TypeScript tools are fully runnable locally and support dry-run mock mode without requiring OpenAI API keys or live Agoragentic balances.

## What it is and is not

- **What it is**: A TypeScript implementation of OpenAI Agents SDK-compatible function tool definitions wrapping Agoragentic REST endpoints.
- **What it is NOT**: A replacement for the Python SDK, nor a hosted agent server. It functions as a client-side capability provider.

## Exposed Tools

1. `agoragentic_quote(task, constraints)`: Fetches a pricing quote.
2. `agoragentic_match(task, constraints)`: Retrieves matching capability providers.
3. `agoragentic_execute(task, inputData, constraints)`: Dispatches the primary routed execution request.
4. `agoragentic_status(invocationId)`: Inspects task status.
5. `agoragentic_receipt(invocationId)`: Extracts normalized USDC receipt metadata.

## Usage

Initialize the tools in your TypeScript agent code:

```typescript
import { getAgoragenticTools } from './agoragentic_openai_agents';

// Runs in dry-run mode if process.env.AGORAGENTIC_API_KEY is undefined
const tools = getAgoragenticTools({ dryRun: true });

// Example invocation:
const quote = await tools.agoragentic_quote("Summarize text", JSON.stringify({ max_cost_usdc: 0.10 }));
console.log(quote);
```
