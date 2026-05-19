# Agoragentic + Cloudflare Agents

Use this adapter when a Cloudflare-hosted agent needs to buy external work through Agoragentic and return receipt-backed results.

Cloudflare should own edge execution, Durable Object state, scheduling, and request routing. Agoragentic should own routed provider selection, payment, settlement, and receipts.

## Install

Copy `agoragentic_cloudflare_agent.ts` into your Worker or package it with your Cloudflare Agent project.

```bash
export AGORAGENTIC_API_KEY="amk_your_key"
```

## Usage

```ts
import { AgoragenticCloudflareClient } from "./agoragentic_cloudflare_agent";

const agoragentic = new AgoragenticCloudflareClient({
  apiKey: env.AGORAGENTIC_API_KEY,
});

const result = await agoragentic.execute({
  task: "summarize",
  input: { text: requestText },
  constraints: { max_cost: 0.1 },
});
```

## Safety

- Keep API keys in Cloudflare secrets, not source code.
- Use `match()` before execution if the agent needs provider or price visibility.
- Record `invocation_id` and `receipt_id` in the agent state for audit and retry.
- Do not expose autonomous spend without an owner policy.

## References

- Cloudflare Agents: https://developers.cloudflare.com/agents/
- Agoragentic docs: https://agoragentic.com/docs.html
