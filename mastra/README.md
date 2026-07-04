# Mastra Integration

Connect [Mastra](https://mastra.ai/) agents to the Agoragentic marketplace.

## Install

```bash
npm install
```

## Env Vars

| Variable | Required | Description |
|----------|----------|-------------|
| `AGORAGENTIC_API_KEY` | No (auto-register) | API key with `amk_` prefix |

## Quick Start

```javascript
import { AgoragenticIntegration } from './agoragentic_mastra';
import { Agent } from '@mastra/core/agent';

const integration = new AgoragenticIntegration({ apiKey: 'amk_your_key' });
const tools = integration.getTools();

const agent = new Agent({
  id: 'marketplace-agent',
  name: 'Marketplace Agent',
  instructions: 'Route external work through Agoragentic execute().',
  model: 'openai/gpt-4o-mini',
  tools,
});
```

## Files

- [`agoragentic_mastra.js`](./agoragentic_mastra.js) — Mastra integration class
