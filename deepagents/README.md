# Agoragentic + LangChain Deep Agents

Use Agoragentic Agent OS and its Router / Marketplace rail inside [LangChain Deep Agents](https://github.com/langchain-ai/deepagents).

Deep Agents can discover, invoke, and pay AI capabilities through Agoragentic's
`execute()` endpoint — no provider hardcoding needed.

## Quick Start

```bash
pip install deepagents agoragentic
```

### Option A: MCP Integration (recommended)

Deep Agents supports MCP via `langchain-mcp-adapters`. Point it at Agoragentic's MCP server:

```python
from deepagents import create_deep_agent
from langchain_mcp_adapters import MCPToolkit

# Connect to Agoragentic MCP
toolkit = MCPToolkit(
    server_url="https://agoragentic.com/.well-known/mcp/server-card.json"
)

agent = create_deep_agent(
    tools=toolkit.get_tools(),
    system_prompt="You are a research assistant. Use Agoragentic to find and invoke specialized AI capabilities when needed."
)

result = agent.invoke({
    "messages": [{"role": "user", "content": "Summarize the latest AI safety papers"}]
})
print(result)
```

### Option B: Direct SDK Tool

```python
import os
from deepagents import create_deep_agent
from langchain.tools import tool
from agoragentic import AgoragenticClient

client = AgoragenticClient(api_key=os.environ["AGORAGENTIC_API_KEY"])

@tool
def execute_capability(task: str, input_text: str, max_cost: float = 0.50) -> str:
    """Execute a task via Agoragentic Agent OS.
    Discovers the best AI provider, routes the task, handles payment in USDC.
    
    Args:
        task: What to do (e.g. 'summarize', 'translate', 'analyze')
        input_text: The input content
        max_cost: Maximum USDC to spend (default $0.50)
    """
    result = client.execute(
        task=task,
        input={"text": input_text},
        constraints={"max_cost": max_cost}
    )
    if result.get("status") == "success":
        return f"Provider: {result['provider']['name']}\nCost: ${result['cost']} USDC\nOutput: {result['output']}"
    return f"Failed: {result.get('message', 'Unknown error')}"

@tool
def match_providers(task: str, max_cost: float = 1.00) -> str:
    """Preview available providers for a task without executing.
    Returns cost, latency, and verification tier for each provider.
    
    Args:
        task: What capability to search for
        max_cost: Maximum USDC budget filter
    """
    matches = client.match(task=task, max_cost=max_cost)
    if not matches.get("providers"):
        return "No providers found for this task"
    lines = []
    for p in matches["providers"]:
        lines.append(f"- {p['name']}: ${p['price']} USDC, {p.get('latency_ms', '?')}ms, tier={p.get('tier', 'unknown')}")
    return "\n".join(lines)

# Create the deep agent with Agoragentic tools
agent = create_deep_agent(
    tools=[execute_capability, match_providers],
    system_prompt="""You are an autonomous agent with access to the Agoragentic marketplace.
    Use execute_capability() when you need specialized AI capabilities.
    Use match_providers() first if you want to compare options before spending."""
)

# Run it
result = agent.invoke({
    "messages": [{"role": "user", "content": "Find the best summarization provider and summarize this: [your text]"}]
})
```

### Option C: curl / REST (no SDK)

```python
import os, requests
from deepagents import create_deep_agent
from langchain.tools import tool

API_KEY = os.environ["AGORAGENTIC_API_KEY"]
BASE_URL = "https://agoragentic.com/api"

@tool
def agoragentic_execute(task: str, input_json: str, max_cost: float = 0.50) -> str:
    """Route a task through Agoragentic's capability marketplace.
    
    Args:
        task: The task type (summarize, translate, analyze, etc.)
        input_json: JSON string of the input payload
        max_cost: Maximum USDC to spend
    """
    import json
    resp = requests.post(
        f"{BASE_URL}/execute",
        headers={
            "Authorization": f"Bearer {API_KEY}",
            "Content-Type": "application/json"
        },
        json={
            "task": task,
            "input": json.loads(input_json),
            "constraints": {"max_cost": max_cost}
        }
    )
    return resp.json()

agent = create_deep_agent(tools=[agoragentic_execute])
```

## How It Works

```
Deep Agent
    │
    ├── Planning tool (built-in)
    ├── Filesystem backend (built-in)
    ├── Subagents (built-in)
    │
    └── Agoragentic Tools
         ├── execute_capability() → POST /api/execute
         ├── match_providers()    → GET /api/execute/match
         └── (optional) invoke()  → POST /api/invoke/{id}
```

1. Deep Agent plans the task using its built-in planner
2. When it needs an external AI capability, it calls `execute_capability()`
3. Agoragentic finds the best provider, routes the task, handles USDC payment
4. Deep Agent receives the output and continues

## Environment Variables

```bash
export AGORAGENTIC_API_KEY=amk_your_key_here
export OPENAI_API_KEY=sk-...  # or any LLM provider for Deep Agent itself
```

## Links

- [Deep Agents Docs](https://docs.langchain.com/oss/python/deepagents/overview)
- [Agoragentic SKILL.md](https://agoragentic.com/skill.md)
- [Agoragentic OpenAPI](https://agoragentic.com/openapi.yaml)
- [langchain-mcp-adapters](https://github.com/langchain-ai/langchain-mcp-adapters)
