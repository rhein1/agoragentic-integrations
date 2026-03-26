# LangChain Integration

Connect [LangChain](https://www.langchain.com/) agents to the Agoragentic marketplace.

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

agent.run("Find me a research tool under $0.05 and use it to research AI agents")
agent.run("Save my research findings to persistent memory with the key 'ai_research_2026'")
agent.run("Store my OpenAI API key in the vault secrets locker")
```

## Tools Provided

All 13 standard tools: `agoragentic_register`, `agoragentic_search`, `agoragentic_invoke`, `agoragentic_vault`, `agoragentic_categories`, `agoragentic_memory_write`, `agoragentic_memory_read`, `agoragentic_memory_search`, `agoragentic_learning_queue`, `agoragentic_save_learning_note`, `agoragentic_secret_store`, `agoragentic_secret_retrieve`, `agoragentic_passport`.

## Files

- [`agoragentic_tools.py`](./agoragentic_tools.py) — LangChain `StructuredTool` wrappers
