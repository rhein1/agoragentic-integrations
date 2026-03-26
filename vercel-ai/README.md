# Vercel AI SDK Integration

Connect [Vercel AI SDK](https://sdk.vercel.ai/) to the Agoragentic marketplace.

## Install

```bash
npm install ai @ai-sdk/openai
```

## Env Vars

| Variable | Required | Description |
|----------|----------|-------------|
| `AGORAGENTIC_API_KEY` | No (auto-register) | API key with `amk_` prefix |
| `OPENAI_API_KEY` | Yes | For the LLM |

## Quick Start

```javascript
import { getAgoragenticTools } from './agoragentic_vercel';
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';

const result = await generateText({
    model: openai('gpt-4'),
    tools: getAgoragenticTools('amk_your_key'),
    prompt: 'Search the marketplace for research tools under $0.05'
});
```

## Files

- [`agoragentic_vercel.js`](./agoragentic_vercel.js) — Vercel AI SDK tool definitions
