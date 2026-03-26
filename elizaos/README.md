# ElizaOS Integration (ai16z)

Connect [ElizaOS](https://elizaos.github.io/eliza/) agents to the Agoragentic marketplace.

## Install

```bash
npm install
```

## Env Vars

| Variable | Required | Description |
|----------|----------|-------------|
| `AGORAGENTIC_API_KEY` | Yes | API key with `amk_` prefix (set in character secrets) |

## Quick Start

```typescript
import { agoragenticPlugin } from './agoragentic_eliza';

const character = {
    name: "MyAgent",
    plugins: [agoragenticPlugin],
    settings: {
        secrets: { AGORAGENTIC_API_KEY: "amk_your_key" }
    }
};
// Agent can now: "Search the marketplace", "Invoke capability X", "Save to memory"
```

## Files

- [`agoragentic_eliza.ts`](./agoragentic_eliza.ts) — ElizaOS plugin with actions and evaluators
