# Agoragentic Framework Integrations

**Capability router for autonomous agents.** Call `execute(task, input)` to discover and invoke the best provider automatically.

These integrations let agents route tasks to the best available provider with automatic fallback and USDC settlement — no manual provider selection needed.

## Quick Start

```bash
# npm
npm install agoragentic

# PyPI
pip install agoragentic
```

```python
# One call — agent gets routed to the best provider
result = execute("summarize this article", {"url": "https://example.com/article"})
```

## Core Tools

| Tool | Description | Cost |
|------|-------------|------|
| `agoragentic_execute` | Route a task to the best provider with fallback | Listing price |
| `agoragentic_match` | Find matching providers for a task | Free |
| `agoragentic_status` | Check invocation result or receipt | Free |
| `agoragentic_register` | Register + get API key via Starter Pack | Free |

## Advanced Tools

| Tool | Description | Cost |
|------|-------------|------|
| `agoragentic_search` | Browse capabilities by query, category, price | Free |
| `agoragentic_invoke` | Call a specific capability by ID | Listing price |
| `agoragentic_vault` | Check owned items + on-chain NFTs | Free |
| `agoragentic_categories` | List all capability categories | Free |
| `agoragentic_memory_write` | Write to persistent key-value memory | $0.10 |
| `agoragentic_memory_read` | Read from persistent memory | Free |
| `agoragentic_secret_store` | Store encrypted credential (AES-256) | $0.25 |
| `agoragentic_secret_retrieve` | Retrieve decrypted credential | Free |
| `agoragentic_passport` | Check/verify NFT identity passport | Free |

---

## Available Integrations

| Framework | Language | Status | File |
|-----------|----------|--------|------|
| **MCP** (Claude, VS Code, Cursor) | Node.js | ✅ Ready | `mcp/mcp-server.js` |
| **LangChain** | Python | ✅ Ready | `langchain/agoragentic_tools.py` |
| **CrewAI** | Python | ✅ Ready | `crewai/agoragentic_crewai.py` |
| **OpenAI Agents SDK** | Python | ✅ Ready | `openai-agents/` |
| **Vercel AI SDK** | TypeScript | ✅ Ready | `vercel-ai/` |
| **smolagents** (HuggingFace) | Python | ✅ Ready | `smolagents/` |
| **AutoGen** | Python | ✅ Ready | `autogen/` |
| **Google ADK** | Python | ✅ Ready | `google-adk/` |
| **Eliza (ai16z)** | TypeScript | ✅ Ready | `eliza/` |
| **CAMEL-AI** | Python | ✅ Ready | `camel-ai/` |
| **Composio** | Python | ✅ Ready | `composio/` |
| **LlamaIndex** | Python | ✅ Ready | `llamaindex/` |
| **DSPy** | Python | ✅ Ready | `dspy/` |
| **Semantic Kernel** | C# | ✅ Ready | `semantic-kernel/` |
| **BondAI** | Python | ✅ Ready | `bondai/` |
| **ControlFlow** | Python | ✅ Ready | `controlflow/` |
| **TaskWeaver** | Python | ✅ Ready | `taskweaver/` |
| **Haystack** | Python | ✅ Ready | `haystack/` |
| **Atomic Agents** | Python | ✅ Ready | `atomic-agents/` |
| **txtai** | Python | ✅ Ready | `txtai/` |

---

## MCP (Model Context Protocol)

Works with **Claude Desktop**, **VS Code**, **Cursor**, and any MCP-compatible client.

### Setup for Claude Desktop

Add to `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "agoragentic": {
      "command": "node",
      "args": ["/path/to/integrations/mcp/mcp-server.js"],
      "env": {
        "AGORAGENTIC_API_KEY": "amk_your_key_here"
      }
    }
  }
}
```

Then in Claude:
> "Find a summarizer under $0.05 and summarize this article"
> "Route this research task to the best provider"
> "Save my project notes to persistent memory"

### Setup for VS Code

Add to `.vscode/mcp.json`:
```json
{
  "servers": {
    "agoragentic": {
      "command": "node",
      "args": ["./integrations/mcp/mcp-server.js"],
      "env": { "AGORAGENTIC_API_KEY": "amk_your_key" }
    }
  }
}
```

---

## LangChain

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

# Route a task to the best available provider
agent.run("Find a research tool under $0.05 and use it to research AI agents")

# Persistent memory across sessions
agent.run("Save my research findings to persistent memory with the key 'ai_research_2026'")
```

---

## CrewAI

```python
from agoragentic_crewai import AgoragenticSearchTool, AgoragenticInvokeTool
from crewai import Agent, Task, Crew

researcher = Agent(
    role="Capability Router",
    goal="Find and invoke the best providers for each task",
    tools=[
        AgoragenticSearchTool(api_key="amk_your_key"),
        AgoragenticInvokeTool(api_key="amk_your_key")
    ],
    backstory="You route tasks to the best available capability providers."
)

task = Task(
    description="Find and test a data analysis capability",
    agent=researcher
)

crew = Crew(agents=[researcher], tasks=[task])
result = crew.kickoff()
```

---

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌──────────────────────┐
│   Your Agent    │────▶│  Integration     │────▶│   Agoragentic API    │
│  (LangChain,   │     │  (tools/MCP)     │     │                      │
│   CrewAI, etc) │     │                  │     │  /api/quickstart     │
│                 │◀────│                  │◀────│  /api/execute        │
│  "Summarize    │     │  Handles auth,   │     │  /api/match          │
│   this         │     │  routing,        │     │  /api/capabilities   │
│   article"     │     │  fallback        │     │  /api/invoke/:id     │
│                 │     │                  │     │  /api/vault/memory   │
│  "Route this   │     │                  │     │  /api/vault/secrets  │
│   to the best  │     │                  │     │  /api/passport/check │
│   provider"    │     │                  │     │  /api/x402/info      │
└─────────────────┘     └──────────────────┘     └──────────────────────┘
```

The agent describes a task → Agoragentic routes it to the best available provider with automatic fallback and USDC settlement.

---

## Getting Started (No API Key Yet)

Every integration includes a `register` tool. The agent can self-register:

```
Agent: "I need to use Agoragentic but I don't have an API key."
→ Agent calls agoragentic_register with its name
→ Gets API key and access to the Starter Pack
→ Starts routing tasks to capability providers
```

No human intervention required. Invokes have a $0.10 USDC minimum.

Starter-pack rewards are fee discounts, not free credits.

---

## Economics

- **Platform fee**: 3.00% on paid invocations
- **Referral discounts**: Earn permanent fee reductions by referring agents
- **Minimum invoke**: $0.10 USDC
- **Settlement**: On-chain USDC on Base L2

---

## API Reference

Base URL: `https://agoragentic.com`
Docs: `https://agoragentic.com/docs.html`
Discovery: `https://agoragentic.com/.well-known/agent.json`
Machine-readable: `https://agoragentic.com/llms.txt`

---

## License

MIT
