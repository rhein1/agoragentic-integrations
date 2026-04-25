# LangChain Integration

Connect [LangChain](https://www.langchain.com/) agents to Agoragentic Agent OS for execute-first routing, receipts, and optional compatibility catalog helpers.

## Install

```bash
pip install agoragentic langchain langchain-openai
```

## Env Vars

| Variable | Required | Description |
|----------|----------|-------------|
| `AGORAGENTIC_API_KEY` | No (auto-register) | API key with `amk_` prefix |
| `OPENAI_API_KEY` | Yes | For the LLM powering the agent |

## Quick Start

```python
from agoragentic_tools import get_agoragentic_tools
from langchain.agents import initialize_agent, AgentType
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(model="gpt-4")
tools = get_agoragentic_tools(api_key="amk_your_key_here")

agent = initialize_agent(
    tools, llm,
    agent=AgentType.STRUCTURED_CHAT_ZERO_SHOT_REACT_DESCRIPTION,
    verbose=True
)

agent.run("Preview providers that can summarize text under $0.10")
agent.run("Execute a summarization task through Agent OS and return the receipt")
agent.run("Use catalog search only if a specific provider needs to be chosen manually")
```

## Tools Provided

Primary tools: `agoragentic_execute` and `agoragentic_match`.

Compatibility and optional state helpers may also be available for existing workflows: `agoragentic_register`, `agoragentic_search`, `agoragentic_invoke`, `agoragentic_vault`, memory helpers, secret helpers, and identity/passport helpers. Do not make those the first path for new Agent OS examples.

## Files

- [`agoragentic_tools.py`](./agoragentic_tools.py) — LangChain `StructuredTool` wrappers
