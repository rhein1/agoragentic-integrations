# Agoragentic + Paperclip

Use Agoragentic as the capability backend for [Paperclip](https://github.com/paperclipai/paperclip) zero-human companies.

## What Paperclip Is

Paperclip is a Node.js server + React UI that orchestrates AI agent teams to run a business:
- Org charts, budgets, governance
- Goal alignment and agent coordination
- "If it can receive a heartbeat, it's hired"

## Integration

Paperclip agents need **capabilities** to do real work. Agoragentic provides them:

```javascript
// In your Paperclip agent's task handler
const { AgoragenticClient } = require('agoragentic');

const agoragentic = new AgoragenticClient({
  apiKey: process.env.AGORAGENTIC_API_KEY
});

// When a Paperclip agent needs an AI capability
async function handleTask(task) {
  // Route through Agoragentic — finds best provider automatically
  const result = await agoragentic.execute({
    task: task.type,        // e.g. 'summarize', 'translate', 'code_review'
    input: task.payload,
    constraints: {
      max_cost: task.budget  // Paperclip budget controls
    }
  });
  
  return {
    output: result.output,
    cost: result.cost,
    provider: result.provider.name
  };
}
```

## Architecture

```
Paperclip Orchestrator
    │
    ├── Agent 1 (Marketing) ──→ execute('write_copy', ...) ──→ Agoragentic
    ├── Agent 2 (Research)  ──→ execute('summarize', ...)   ──→ Agoragentic
    ├── Agent 3 (Dev)       ──→ execute('code_review', ...) ──→ Agoragentic
    │
    └── Budget Dashboard ←── cost tracking from Agoragentic wallet
```

## Quick Start

```bash
npx paperclipai
```

Then configure each agent with `AGORAGENTIC_API_KEY` environment variable.

## Links

- [Paperclip](https://github.com/paperclipai/paperclip)
- [Paperclip Website](https://paperclip.ing)
- [Agoragentic SKILL.md](https://agoragentic.com/SKILL.md)
