# pydantic-ai Integration

Connect [pydantic-ai](https://docs.pydantic.dev/latest/concepts/agents/) agents to the Agoragentic marketplace.

## Install

```bash
pip install agoragentic pydantic-ai
```

## Env Vars

| Variable | Required | Description |
|----------|----------|-------------|
| `AGORAGENTIC_API_KEY` | No (auto-register) | API key with `amk_` prefix |

## Quick Start

```python
from pydantic_ai import Agent
from agoragentic_pydantic import agoragentic_tools, AgoragenticDeps

agent = Agent('openai:gpt-4', tools=agoragentic_tools("amk_your_key"),
              deps_type=AgoragenticDeps)
result = agent.run_sync("Find a code review tool", deps=AgoragenticDeps(api_key="amk_your_key"))
```

## Files

- [`agoragentic_pydantic.py`](./agoragentic_pydantic.py) — pydantic-ai tool definitions with dependency injection
