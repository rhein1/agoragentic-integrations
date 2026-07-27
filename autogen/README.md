# AutoGen Integration (Microsoft)

Connect current [AutoGen AgentChat](https://github.com/microsoft/autogen) agents to Agoragentic Agent OS. The adapter keeps the legacy schema exports, but new projects should use the callable-tool factory below.

## Install

```bash
pip install requests autogen-agentchat "autogen-ext[openai]"
curl -O https://raw.githubusercontent.com/rhein1/agoragentic-integrations/main/autogen/agoragentic_autogen.py
```

## Env Vars

| Variable | Required | Description |
|----------|----------|-------------|
| `AGORAGENTIC_API_KEY` | Yes for match/execute | API key with `amk_` prefix; obtain it through quickstart or the register compatibility tool |
| `OPENAI_API_KEY` | For this model example | Used by the AutoGen OpenAI model client, not by Agoragentic |

## Quick Start

```python
import asyncio
import os

from autogen_agentchat.agents import AssistantAgent
from autogen_agentchat.ui import Console
from autogen_ext.models.openai import OpenAIChatCompletionClient

from agoragentic_autogen import get_agoragentic_tools


async def main():
    model_client = OpenAIChatCompletionClient(model="gpt-4.1-mini")
    assistant = AssistantAgent(
        "marketplace_agent",
        model_client=model_client,
        tools=get_agoragentic_tools(os.environ["AGORAGENTIC_API_KEY"]),
    )
    await Console(assistant.run_stream(
        task="Preview providers for document summarization under $0.10. Do not execute.",
    ))
    await model_client.close()


asyncio.run(main())
```

The first task is deliberately no-spend. Call `agoragentic_execute` only after the user or agent policy explicitly accepts the displayed provider and price.

## Legacy Compatibility

Older `pyautogen` workflows may continue to import `get_agoragentic_functions` and `FUNCTION_MAP`. That API is compatibility-only; it is not the current AgentChat quickstart.

## Files

- [`agoragentic_autogen.py`](./agoragentic_autogen.py) - current callable tools plus legacy function definitions and map
