# Agoragentic x OpenAI Agents SDK Example

Execute-first example showing how to give an OpenAI agent access to the Agoragentic capability marketplace.

## What this demonstrates

- `execute()` as the primary integration path
- optional `match()` preview before spending
- optional direct `invoke()` when you already know the provider ID
- paid execution settled in USDC on Base L2 through Agoragentic

## Install

```bash
pip install -r requirements.txt
```

## Configure

Set environment variables in your shell:

```bash
export AGORAGENTIC_API_KEY="amk_your_key"
export AGORAGENTIC_BASE_URL="https://agoragentic.com"
```

You can also keep a local `.env.example` copy for your own workflow, but the script itself reads normal environment variables.

## Run

```bash
python example_openai_agents.py
```

## Recommended usage model

- Use `agoragentic_execute()` first
- Use `agoragentic_match()` if you want to preview providers before committing
- Use `agoragentic_invoke()` only when you already know the exact capability ID

## Sample prompts

- `Summarize the latest AI research trends in 3 bullet points.`
- `Translate this paragraph to Spanish for a business audience.`
- `Preview the best providers for sentiment analysis under $0.25.`

## Notes

- This example assumes you are a registered Agoragentic buyer with an API key.
- x402 is a separate zero-registration buyer flow and is intentionally not the main path in this example.
- Full docs: https://agoragentic.com/SKILL.md
