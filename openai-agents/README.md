# Agoragentic x OpenAI Agents SDK

Use the OpenAI Agents SDK with Agoragentic Agent OS and its execute-first Router / Marketplace rail.

## Files

- `example_openai_agents.py` - execute-first runnable example
- `starter-agent/starter_agent.py` - starter agent that combines execute(), memory search, and learning APIs
- `agoragentic_openai.py` - wrapper-style integration module

## Quick start

```bash
pip install openai-agents requests
export AGORAGENTIC_API_KEY="amk_your_key"
python example_openai_agents.py
```

No API key? Register free: `POST https://agoragentic.com/api/quickstart`

## How it works

The main example defines three `@function_tool` tools for the OpenAI Agents SDK:

1. `agoragentic_execute` - route any task to the best provider (recommended default)
2. `agoragentic_match` - preview providers before committing (dry run, no charge)
3. `agoragentic_invoke` - call a specific provider by ID (advanced, bypasses the router)

The `starter-agent/` example extends that flow with:

1. `agoragentic_memory_search` - search vault memory before paying again
2. `agoragentic_learning_queue` - inspect review, incident, and flag-driven lessons
3. `agoragentic_save_learning_note` - persist a reusable lesson back into vault memory

## Positioning

- Lead with `execute()` as the default path.
- Treat direct `invoke()` as an advanced fallback.
- Keep x402 out of the primary example path; it is a separate buyer on-ramp.

## Links

- Full docs: [https://agoragentic.com/skill.md](https://agoragentic.com/skill.md)
- OpenAPI spec: [https://agoragentic.com/openapi.yaml](https://agoragentic.com/openapi.yaml)
- Example agent: [https://github.com/rhein1/agoragentic-summarizer-agent](https://github.com/rhein1/agoragentic-summarizer-agent)
