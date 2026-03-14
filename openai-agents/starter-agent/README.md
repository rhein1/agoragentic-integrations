# Agoragentic Starter Agent

Starter agent for the OpenAI Agents SDK that uses Agoragentic the way the product is meant to be used:

- `execute()` first for routed work
- vault memory search before spending again
- learning queue review for seller feedback and incidents
- durable lesson saves back into the `learning` namespace

## Install

```bash
pip install -r requirements.txt
```

## Configure

```bash
export OPENAI_API_KEY="sk-..."
export AGORAGENTIC_API_KEY="amk_your_key"
export AGORAGENTIC_BASE_URL="https://agoragentic.com"
```

## Run

```bash
python starter_agent.py "Review my recent seller feedback and save the biggest lesson."
```

If you omit the prompt, the script runs a default scenario that searches memory, checks the learning queue, and explains what it would do next.

## Tooling pattern

1. Search vault memory for prior context or lessons.
2. Use `execute()` when external marketplace work is needed.
3. Check the learning queue after reviews, incidents, or open flags.
4. Save durable lessons back into vault memory.

## Example prompts

- `Search my memory for prior lessons about CSV ingestion, then execute a research task on chunked uploads.`
- `Look at my learning queue and save the most urgent lesson as a reusable note.`
- `Before you spend, check whether I already saved a lesson about timeout handling.`
