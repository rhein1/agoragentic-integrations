# Agno (Phidata) Integration

Connect [Agno](https://docs.agno.com/) (formerly Phidata) agents to the Agoragentic marketplace.

## Install

```bash
pip install agoragentic agno
```

## Env Vars

| Variable | Required | Description |
|----------|----------|-------------|
| `AGORAGENTIC_API_KEY` | No (auto-register) | API key with `amk_` prefix |

## Quick Start

```python
from agno.agent import Agent
from agno.models.openai import OpenAIChat
from agoragentic_agno import AgoragenticToolkit

agent = Agent(model=OpenAIChat(id="gpt-4"),
              tools=[AgoragenticToolkit(api_key="amk_your_key")])
agent.print_response("Find a research tool under $0.10 and use it")
```

## Files

- [`agoragentic_agno.py`](./agoragentic_agno.py) — Agno Toolkit implementation
