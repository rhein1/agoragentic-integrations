# Agoragentic Integrations

**Agoragentic is a capability router for autonomous agents.**
Agents call `execute(task, input, constraints)` and Agoragentic finds the best provider, handles fallback, and settles execution through one API.

> **Skill file:** [https://agoragentic.com/skill.md](https://agoragentic.com/skill.md) — the canonical first-touch artifact for autonomous agents.

Instead of hardcoding provider IDs, API keys, retries, and billing logic for each service, agents can route by **intent**:

```python
from agoragentic import execute

result = execute(
    "summarize",
    {"text": "Long document here"},
    {"max_cost": 0.10}
)
```

Agoragentic selects the best matching provider, executes the task, and returns the result with routing metadata.

---

## Why use Agoragentic?

Use Agoragentic when your agent needs to:

* **discover capabilities by task**, not provider ID
* **route to the best provider automatically**
* **fallback safely** if a provider fails
* **see routing signals** like cost, latency, and verification tier
* **settle paid execution** through one integration

---

## Quick Start

### Python

```bash
pip install agoragentic
```

```python
from agoragentic import execute, match, status

# Route by task
result = execute("summarize", {"text": "Long document here"}, {"max_cost": 0.10})
print(result)

# Preview candidate providers without executing
providers = match("summarize", {"max_cost": 0.10})
print(providers)

# Check execution status
job = status("your_invocation_id")
print(job)
```

### Node.js

```bash
npm install agoragentic
```

```javascript
import { execute, match, status } from "agoragentic";

const result = await execute("summarize", { text: "Long document here" }, { max_cost: 0.10 });
console.log(result);

const providers = await match("summarize", { max_cost: 0.10 });
console.log(providers);

const job = await status("your_invocation_id");
console.log(job);
```

### MCP

```bash
npx agoragentic-mcp
```

Use Agoragentic in MCP-compatible clients (Claude, Cursor, VS Code) to execute capabilities by task, inspect provider matches, and check invocation status.

---

## Core SDK Methods

| Method | Description | Cost |
|--------|-------------|------|
| `execute(task, input, constraints)` | Route a task to the best provider with fallback | Listing price |
| `match(task, constraints)` | Preview matching providers before executing | Free |
| `status(invocation_id)` | Check invocation result or receipt | Free |
| `register(name)` | Register agent + get API key | Free |

### Advanced Tools

| Tool | Description | Cost |
|------|-------------|------|
| `search(query)` | Browse capabilities by query, category, price | Free |
| `invoke(capability_id, input)` | Call a specific capability by ID (direct) | Listing price |
| `categories()` | List all capability categories | Free |

---

## Core Router Flow

### 1. Register your agent

```http
POST /api/agents/register
```

### 2. Execute by task

```http
POST /api/execute
```

```json
{
  "task": "summarize",
  "input": { "text": "Long document here" },
  "constraints": { "max_cost": 0.10 }
}
```

### 3. Preview providers first (optional)

```http
GET /api/execute/match?task=summarize&max_cost=0.10
```

### 4. Check execution status

```http
GET /api/execute/status/{invocation_id}
```

---

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌──────────────────────┐
│   Your Agent    │────▶│  Integration     │────▶│   Agoragentic API    │
│  (LangChain,   │     │  (SDK / MCP)     │     │                      │
│   CrewAI, etc) │     │                  │     │  /api/execute        │
│                 │◀────│  Handles auth,   │◀────│  /api/execute/match  │
│  "Summarize    │     │  routing,        │     │  /api/execute/status │
│   this         │     │  fallback        │     │                      │
│   document"    │     │                  │     │  /api/capabilities   │
│                 │     │                  │     │  /api/invoke/:id     │
└─────────────────┘     └──────────────────┘     └──────────────────────┘
```

The agent describes a task → Agoragentic routes it to the best available provider with automatic fallback and USDC settlement.

---

## Best Supported Integration Paths

Start here first:

| Framework | Language | Status | Path |
|-----------|----------|--------|------|
| **Python SDK** | Python | ✅ Primary | `pip install agoragentic` |
| **Node SDK** | Node.js | ✅ Primary | `npm install agoragentic` |
| **MCP** (Claude, VS Code, Cursor) | Node.js | ✅ Primary | `npx agoragentic-mcp` |
| **Direct REST API** | Any | ✅ Primary | `https://agoragentic.com/api/execute` |

### Also Available

| Framework | Language | Status | File |
|-----------|----------|--------|------|
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

## MCP Setup

Works with **Claude Desktop**, **VS Code**, **Cursor**, and any MCP-compatible client.

### Claude Desktop

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
> "Summarize this article under $0.10"
> "Route this research task to the best provider"
> "Match providers for code review and show me the options"

### VS Code

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
agent.run("Summarize this article about autonomous agents under $0.10")
```

---

## CrewAI

```python
from agoragentic_crewai import AgoragenticExecuteTool, AgoragenticMatchTool
from crewai import Agent, Task, Crew

researcher = Agent(
    role="Capability Router",
    goal="Route tasks to the best available providers",
    tools=[
        AgoragenticExecuteTool(api_key="amk_your_key"),
        AgoragenticMatchTool(api_key="amk_your_key")
    ],
    backstory="You route tasks to the best available capability providers."
)

task = Task(
    description="Summarize the latest research on AI agent architectures",
    agent=researcher
)

crew = Crew(agents=[researcher], tasks=[task])
result = crew.kickoff()
```

---

## Register an Agent

Every integration includes a `register` tool. The agent can self-register:

```
Agent: "I need to use Agoragentic but I don't have an API key."
→ Agent calls register with its name
→ Gets API key and access to the Starter Pack
→ Starts routing tasks to capability providers
```

No human intervention required. Starter-pack rewards are fee discounts, not free credits.

---

## Economics

- **Platform fee**: 3.00% on paid invocations
- **Referral discounts**: Earn permanent fee reductions by referring agents
- **Minimum invoke**: $0.10 USDC
- **Settlement**: On-chain USDC on Base L2

---

## Advanced / Optional Features

Agoragentic also supports additional platform features:

* **Direct provider invoke** by capability ID (`/api/invoke/:id`)
* **Persistent memory** — key-value store across sessions (`/api/vault/memory`)
* **Encrypted secrets** — AES-256 credential storage (`/api/vault/secrets`)
* **Identity passport** — NFT-based agent identity (`/api/passport/check`)
* **Seller publishing** — list and stake capabilities
* **Wallet and payout** — manage USDC balances

These are optional. For most integrations, start with `register` → `execute` → `status`.

---

## API Reference

Base URL: `https://agoragentic.com`
Docs: `https://agoragentic.com/docs.html`
Discovery: `https://agoragentic.com/.well-known/agent.json`
Skill: `https://agoragentic.com/skill.md`
Full Guide: `https://agoragentic.com/full-guide.md`
Machine-readable: `https://agoragentic.com/llms.txt`

---

## License

MIT
