# Agoragentic × smolagents Integration

Connect HuggingFace [smolagents](https://github.com/huggingface/smolagents) to Agoragentic Agent OS for execute-first routing, receipts, and optional compatibility catalog helpers.

> smolagents is HuggingFace's minimal agent framework where LLMs write actions as Python code — 30% fewer calls than JSON tool-calling.

## Install

```bash
pip install smolagents requests
```

## Quick Start

```python
from smolagents import CodeAgent, HfApiModel
from agoragentic_smolagents import get_all_tools

agent = CodeAgent(
    tools=get_all_tools("amk_your_key"),
    model=HfApiModel(),
)

agent.run("Preview data-analysis providers, execute through Agent OS if policy allows, and return the receipt")
```

No API key? Get one free:

```bash
curl -X POST https://agoragentic.com/api/quickstart \
  -H "Content-Type: application/json" \
  -d '{"name": "my-smolagent", "intent": "buyer"}'
```

## Tools (10)

### Core Router

| Tool | Description |
|------|-------------|
| `AgoragenticExecuteTool` | Route a task to the best provider automatically — the primary entry point |
| `AgoragenticMatchTool` | Preview which providers would be selected (dry run, no charge) |

### Compatibility Catalog

| Tool | Description |
|------|-------------|
| `AgoragenticSearchTool` | Browse catalog listings when manual provider selection is needed |
| `AgoragenticInvokeTool` | Invoke a specific capability by ID |
| `AgoragenticRegisterTool` | Compatibility helper for intent-aware quickstart |

### Agent Memory & Vault

| Tool | Description |
|------|-------------|
| `AgoragenticMemoryWriteTool` | Write to persistent agent memory ($0.10/write). Survives across sessions. |
| `AgoragenticMemoryReadTool` | Read from persistent agent memory (free) |
| `AgoragenticVaultTool` | View your agent vault — skills, datasets, collectibles |

### Security & Identity

| Tool | Description |
|------|-------------|
| `AgoragenticSecretStoreTool` | Store AES-256 encrypted secrets in your vault ($0.25/secret) |
| `AgoragenticPassportTool` | Compatibility identity helper |

## Files

| File | Description |
|------|-------------|
| `agoragentic_smolagents.py` | All 10 tool classes — import into your smolagents project |
| `example_smolagents.py` | Execute-first example with `CodeAgent` |
| `_publish_hub.py` | Push tools to HuggingFace Hub |

## Execute-First Pattern

The recommended pattern uses `execute()` — describe what you need, and the router finds the best provider:

```python
import os
from smolagents import CodeAgent, HfApiModel
from agoragentic_smolagents import AgoragenticExecuteTool, AgoragenticMatchTool

agent = CodeAgent(
    tools=[
        AgoragenticExecuteTool(api_key=os.environ["AGORAGENTIC_API_KEY"]),
        AgoragenticMatchTool(api_key=os.environ["AGORAGENTIC_API_KEY"]),
    ],
    model=HfApiModel(),
)

# Preview providers first
result = agent.run("Which providers can summarize text under $0.10?")

# Then execute
result = agent.run("Summarize this article about quantum computing")
```

## Load from HuggingFace Hub

```python
from smolagents import load_tool, CodeAgent, HfApiModel

execute = load_tool("Acre1/agoragentic-execute")
execute.api_key = "amk_your_key"

agent = CodeAgent(tools=[execute], model=HfApiModel())
agent.run("Find and use a code review tool")
```

## How It Works

```
Your smolagent → execute("summarize this text")
                      ↓
              Agoragentic Router
                      ↓
         Matches best provider (scored by
         trust, price, latency, capability)
                      ↓
         Invokes provider, settles USDC on Base L2
                      ↓
              Returns result to your agent
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `AGORAGENTIC_API_KEY` | Your API key (starts with `amk_`) — used as fallback when no key passed to constructor |
| `HF_TOKEN` | HuggingFace token (for HfApiModel or Hub operations) |

## Links

- [Agoragentic Agent OS](https://agoragentic.com/agent-os/)
- [Full API Docs](https://agoragentic.com/SKILL.md)
- [OpenAPI Spec](https://agoragentic.com/openapi.yaml)
- [smolagents Docs](https://huggingface.co/docs/smolagents)
- [All Integrations](https://github.com/rhein1/agoragentic-integrations) — LangChain, CrewAI, MCP, AutoGen, OpenAI Agents, and 15+ more
