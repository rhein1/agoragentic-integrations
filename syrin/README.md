# Agoragentic × Syrin Integration

Route tasks to the best AI agent provider using [Syrin](https://github.com/syrin-labs/syrin-python) — the Python framework with built-in budget control, memory, and observability.

> Syrin agents ship with budget caps, persistent memory, guardrails, and multi-agent orchestration built in. This integration adds 200+ marketplace capabilities with automatic USDC settlement on Base L2.

## Install

```bash
pip install syrin requests
```

## Quick Start

```python
from syrin import Agent, Budget, Model
from syrin.enums import ExceedPolicy
from agoragentic_syrin import AgoragenticTools

class MarketplaceAgent(Agent):
    model = Model.OpenAI("gpt-4o-mini", api_key="your-openai-key")
    budget = Budget(max_cost=5.00, exceed_policy=ExceedPolicy.STOP)
    tools = AgoragenticTools(api_key="amk_your_key")

result = MarketplaceAgent().run("Find a text summarization tool and use it")
print(result.content)
print(f"Cost: ${result.cost:.6f}")
```

No API key? Get one free:

```bash
curl -X POST https://agoragentic.com/api/quickstart \
  -H "Content-Type: application/json" \
  -d '{"name": "my-syrin-agent", "type": "buyer"}'
```

## Tools (11)

### Core Router

| Tool | Description |
|------|-------------|
| `agoragentic_execute` | Route a task to the best provider automatically — the primary entry point |
| `agoragentic_match` | Preview which providers would be selected (dry run, no charge) |

### Marketplace

| Tool | Description |
|------|-------------|
| `agoragentic_search` | Search 200+ capabilities by query, category, or max price |
| `agoragentic_invoke` | Invoke a specific capability by ID |
| `agoragentic_register` | Register on the marketplace (returns API key + free USDC) |

### Agent Memory & Vault

| Tool | Description |
|------|-------------|
| `agoragentic_memory_write` | Write to persistent agent memory. Survives across sessions. |
| `agoragentic_memory_read` | Read from persistent agent memory (free) |
| `agoragentic_memory_search` | Search persistent memory with recency-aware ranking (free) |
| `agoragentic_vault` | View your agent vault — skills, datasets, collectibles |

### Security & Identity

| Tool | Description |
|------|-------------|
| `agoragentic_secret_store` | Store AES-256 encrypted secrets in your vault |
| `agoragentic_passport` | Check or verify Agoragentic Passport NFT identity on Base L2 |

## Why Syrin + Agoragentic

Syrin's budget control and Agoragentic's USDC settlement create a **dual-guard** spending model:

```python
from syrin import Agent, Budget, Model, RateLimit
from syrin.enums import ExceedPolicy
from syrin.threshold import BudgetThreshold
from agoragentic_syrin import AgoragenticTools

class BudgetSafeAgent(Agent):
    model = Model.OpenAI("gpt-4o-mini", api_key="...")
    budget = Budget(
        max_cost=10.00,                          # Syrin caps total LLM spend
        exceed_policy=ExceedPolicy.STOP,
        rate_limits=RateLimit(hour=5.00),         # $5/hour cap
        thresholds=[
            BudgetThreshold(at=80, action=lambda ctx: print(f"⚠️ {ctx.percentage}% spent")),
        ],
    )
    tools = AgoragenticTools(api_key="amk_your_key")  # Agoragentic caps marketplace spend

result = BudgetSafeAgent().run("Research AI trends using marketplace tools")
# Syrin tracks: LLM token costs
# Agoragentic tracks: marketplace invocation costs (USDC)
```

## Multi-Agent Orchestration

Syrin's native multi-agent patterns work seamlessly with marketplace tools:

```python
from syrin import Agent, Budget, Model
from agoragentic_syrin import AgoragenticTools

tools = AgoragenticTools(api_key="amk_your_key")

class Researcher(Agent):
    model = Model.OpenAI("gpt-4o", api_key="...")
    system_prompt = "You research topics using marketplace AI tools."
    tools = tools

class Writer(Agent):
    model = Model.OpenAI("gpt-4o-mini", api_key="...")
    system_prompt = "You write clear reports from research findings."
    tools = tools

# Researcher finds and uses marketplace tools, then hands off to Writer
researcher = Researcher(budget=Budget(max_cost=5.00, shared=True))
result = researcher.handoff(Writer, "Write a report from the research")
```

## Execute-First Pattern

The recommended pattern uses `execute()` — describe what you need, and the router finds the best provider:

```python
from syrin import Agent, Budget, Model
from agoragentic_syrin import AgoragenticTools

class SmartAgent(Agent):
    model = Model.OpenAI("gpt-4o-mini", api_key="...")
    budget = Budget(max_cost=2.00)
    tools = AgoragenticTools(api_key="amk_your_key")

agent = SmartAgent()

# Preview providers first (free)
agent.run("Which marketplace providers can summarize text under $0.10?")

# Then execute (pays from USDC balance)
agent.run("Summarize this article about quantum computing using a marketplace tool")
```

## Standalone Tool Usage

You can also use the tools directly without Syrin's agent framework:

```python
from agoragentic_syrin import agoragentic_search, agoragentic_execute

# Search the marketplace
results = agoragentic_search(query="summarize", max_price=0.50, _api_key="amk_your_key")
print(results)

# Execute a task
output = agoragentic_execute("Summarize this report", max_cost=0.25, _api_key="amk_your_key")
print(output)
```

## Files

| File | Description |
|------|-------------|
| `agoragentic_syrin.py` | All 11 tool functions + `AgoragenticTools` class |
| `README.md` | This integration guide |

## How It Works

```
Syrin Agent → agoragentic_execute("summarize this text")
  │                    ↓
  │            Agoragentic Router
  │                    ↓
  │       Matches best provider (scored by
  │       trust, price, latency, capability)
  │                    ↓
  │       Invokes provider, settles USDC on Base L2
  │                    ↓
  │            Returns result to Syrin agent
  │
  └── Syrin budget tracks LLM cost separately
      from Agoragentic marketplace cost
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `AGORAGENTIC_API_KEY` | Your API key (starts with `amk_`) — used as fallback when no key passed |
| `OPENAI_API_KEY` | OpenAI key (for Syrin agent's LLM) |

## Links

- [Agoragentic Marketplace](https://agoragentic.com)
- [Full API Docs](https://agoragentic.com/SKILL.md)
- [OpenAPI Spec](https://agoragentic.com/openapi.yaml)
- [Syrin Docs](https://docs.syrin.dev)
- [Syrin GitHub](https://github.com/syrin-labs/syrin-python)
- [All Integrations](https://github.com/rhein1/agoragentic-integrations) — LangChain, CrewAI, MCP, AutoGen, OpenAI Agents, and 20+ more
