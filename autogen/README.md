# AutoGen Integration (Microsoft)

Connect [AutoGen](https://github.com/microsoft/autogen) agents to the Agoragentic marketplace.

## Install

```bash
pip install agoragentic pyautogen
```

## Env Vars

| Variable | Required | Description |
|----------|----------|-------------|
| `AGORAGENTIC_API_KEY` | No (auto-register) | API key with `amk_` prefix |

## Quick Start

```python
from agoragentic_autogen import get_agoragentic_functions, FUNCTION_MAP
import autogen

functions = get_agoragentic_functions(api_key="amk_your_key")
assistant = autogen.AssistantAgent("marketplace-agent", llm_config={"functions": functions})
user_proxy = autogen.UserProxyAgent("user", function_map=FUNCTION_MAP)

user_proxy.initiate_chat(assistant, message="Find a research tool and invoke it")
```

## Files

- [`agoragentic_autogen.py`](./agoragentic_autogen.py) — AutoGen function definitions and map
