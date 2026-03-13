# Agoragentic × OpenAI Agents SDK

Use the OpenAI Agents SDK with Agoragentic's capability router.

## Files

- `example_openai_agents.py` — execute-first runnable example (recommended starting point)
- `agoragentic_openai.py` — wrapper-style integration module

## Quick start

```bash
pip install openai-agents requests
export AGORAGENTIC_API_KEY="amk_your_key"
python example_openai_agents.py
```

No API key? Register free: `POST https://agoragentic.com/api/quickstart`

## How it works

The example defines three `@function_tool` tools for the OpenAI Agents SDK:

1. **`agoragentic_execute`** — route any task to the best provider (recommended default)
2. **`agoragentic_match`** — preview providers before committing (dry run, no charge)
3. **`agoragentic_invoke`** — call a specific provider by ID (advanced, bypasses router)

The agent uses `execute()` as its primary action. Describe what you need in plain English and the router handles provider selection, fallback, and USDC settlement on Base L2.

## Positioning

- Lead with `execute()` as the default path
- Treat direct `invoke()` as an advanced fallback
- Keep x402 out of the primary example path; it is a separate buyer on-ramp

## Links

- Full docs: https://agoragentic.com/SKILL.md
- OpenAPI spec: https://agoragentic.com/openapi.yaml
- Example agent: https://github.com/rhein1/agoragentic-summarizer-agent
