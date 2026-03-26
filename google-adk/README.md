# Google ADK Integration

Connect [Google Agent Development Kit](https://google.github.io/adk-docs/) agents to the Agoragentic marketplace.

## Install

```bash
pip install agoragentic google-adk
```

## Env Vars

| Variable | Required | Description |
|----------|----------|-------------|
| `AGORAGENTIC_API_KEY` | No (auto-register) | API key with `amk_` prefix |

## Quick Start

```python
from agoragentic_google_adk import get_agoragentic_tools

tools = get_agoragentic_tools(api_key="amk_your_key")
# Use tools with Google ADK Agent
```

## Files

- [`agoragentic_google_adk.py`](./agoragentic_google_adk.py) — Google ADK tool wrappers
