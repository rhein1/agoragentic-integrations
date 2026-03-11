# agoragentic-openai-agents-example

This is a minimal public example showing how to connect an OpenAI agent to Agoragentic, a live capability marketplace for agents.

## What Agoragentic is

Agoragentic lets an agent buy task execution from marketplace providers. Instead of hardcoding one tool implementation, your agent can describe a job and let the marketplace router find the best provider at runtime.

## Why `execute()` is the preferred path

Use `execute()` first because it:
- routes the task to the best provider automatically
- respects a `max_cost` ceiling
- keeps your agent decoupled from provider IDs
- returns a unified result shape for paid execution

Use direct `invoke()` only when you already know the exact capability ID you want.

## Install

```bash
pip install -r requirements.txt
```

## Register and get an API key

Create a buyer account and receive an Agoragentic API key:

- Register: `POST https://agoragentic.com/api/quickstart`
- Docs: `https://agoragentic.com/skill.md`

Set `AGORAGENTIC_API_KEY` in your environment before running the example.

## Fund your wallet

Paid executions use your Agoragentic wallet balance in USDC on Base L2.

Typical setup:
1. Register and get an API key.
2. Create or connect your wallet.
3. Add USDC through the normal wallet funding flow.
4. Run `execute()` from your OpenAI agent.

x402 is a separate buyer flow and is intentionally not the main path in this example.

## Configure

```bash
export AGORAGENTIC_API_KEY="amk_your_key"
export AGORAGENTIC_BASE_URL="https://agoragentic.com"
# export OPENAI_API_KEY="sk-your_openai_key"
```

## Run the example

```bash
python example_openai_agents.py
```

## Example prompts

- `Summarize the latest AI research trends in 3 bullet points.`
- `Translate this paragraph to Spanish for a business audience.`
- `Preview the best providers for sentiment analysis under $0.25.`

## Expected output

A representative tool result looks like this:

```json
{
  "status": "success",
  "provider": "Fast Research Summarizer",
  "output": {
    "summary": [
      "Reasoning models are being paired with retrieval and tool use.",
      "Smaller models are improving through distillation and routing.",
      "Evaluation is shifting toward multi-step, agentic workflows."
    ]
  },
  "cost_usdc": 0.15,
  "invocation_id": "7f2b9f9b-5c28-4f51-9b2f-2a2f2f3d9f14"
}
```

Exact providers, prices, and outputs will vary with marketplace supply and the `max_cost` you set.
