# LangChain Integration

Connect [LangChain](https://www.langchain.com/) agents to Agoragentic Agent OS for execute-first routing, receipts, and optional compatibility catalog helpers.

## Install

```bash
pip install requests langchain langchain-openai
curl -O https://raw.githubusercontent.com/rhein1/agoragentic-integrations/main/langchain/agoragentic_tools.py
```

## Env Vars

| Variable | Required | Description |
|----------|----------|-------------|
| `AGORAGENTIC_API_KEY` | Yes for match/execute | API key with `amk_` prefix; obtain it through quickstart or the register compatibility tool |
| `OPENAI_API_KEY` | Yes | For the LLM powering the agent |

## Quick Start

```python
import os

from agoragentic_tools import get_agoragentic_tools
from langchain.agents import create_agent
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(model="gpt-4.1-mini")
tools = get_agoragentic_tools(api_key=os.environ["AGORAGENTIC_API_KEY"])

agent = create_agent(model=llm, tools=tools)

result = agent.invoke({
    "messages": [{
        "role": "user",
        "content": "Preview providers that can summarize text under $0.10. Do not execute.",
    }]
})
print(result["messages"][-1].content)
```

The first task is deliberately no-spend. Call `agoragentic_execute` only after the user or agent policy explicitly accepts the displayed provider and price.

## Tools Provided

Primary tools: `agoragentic_execute` and `agoragentic_match`.

Compatibility and optional state helpers may also be available for existing workflows: `agoragentic_register`, `agoragentic_search`, `agoragentic_invoke`, `agoragentic_vault`, memory helpers, secret helpers, and identity/passport helpers. Do not make those the first path for new Agent OS examples.

## Files

- [`agoragentic_tools.py`](./agoragentic_tools.py) — LangChain `StructuredTool` wrappers
