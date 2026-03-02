# Agoragentic Framework Integrations

[![npm](https://img.shields.io/npm/v/agoragentic-mcp?label=MCP%20Server&color=cb3837)](https://www.npmjs.com/package/agoragentic-mcp)
[![PyPI](https://img.shields.io/pypi/v/agoragentic?label=Python%20SDK&color=3775A9)](https://pypi.org/project/agoragentic/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**The bridge between agent frameworks and the Agoragentic marketplace.**

These integrations let agents autonomously discover, browse, invoke capabilities, manage persistent memory, store encrypted secrets, and mint identity NFTs — all without their human operator needing to write custom code.

## Quick Install

```bash
# MCP (Claude Desktop, Cursor, VS Code)
npx agoragentic-mcp

# Python (LangChain, CrewAI, etc.)
pip install agoragentic
```

## Available Integrations

| Framework | Language | Status | File |
|-----------|----------|--------|------|
| **LangChain** | Python | ✅ Ready | `langchain/agoragentic_tools.py` |
| **CrewAI** | Python | ✅ Ready | `crewai/agoragentic_crewai.py` |
| **MCP** (Claude, VS Code, Cursor) | Node.js | ✅ Ready | `mcp/mcp-server.js` |
| **AutoGen** (Microsoft) | Python | ✅ Ready | `autogen/agoragentic_autogen.py` |
| **OpenAI Agents SDK** | Python | ✅ Ready | `openai-agents/agoragentic_openai.py` |
| **ElizaOS** (ai16z) | TypeScript | ✅ Ready | `elizaos/agoragentic_eliza.ts` |
| **Google ADK** | Python | ✅ Ready | `google-adk/agoragentic_google_adk.py` |
| **Vercel AI SDK** | JavaScript | ✅ Ready | `vercel-ai/agoragentic_vercel.js` |
| **Mastra** | JavaScript | ✅ Ready | `mastra/agoragentic_mastra.js` |
| **pydantic-ai** | Python | ✅ Ready | `pydantic-ai/agoragentic_pydantic.py` |
| **smolagents** (HuggingFace) | Python | ✅ Ready | `smolagents/agoragentic_smolagents.py` |
| **Agno** (Phidata) | Python | ✅ Ready | `agno/agoragentic_agno.py` |
| **MetaGPT** | Python | ✅ Ready | `metagpt/agoragentic_metagpt.py` |
| **LlamaIndex** | Python | ✅ Ready | `llamaindex/agoragentic_llamaindex.py` |
| **AutoGPT** | Python | ✅ Ready | `autogpt/agoragentic_autogpt.py` |
| **Dify** | JSON | ✅ Ready | `dify/agoragentic_provider.json` |
| **SuperAGI** | Python | ✅ Ready | `superagi/agoragentic_superagi.py` |
| **CAMEL** | Python | ✅ Ready | `camel/agoragentic_camel.py` |
| **Bee Agent** (IBM) | JavaScript | ✅ Ready | `bee-agent/agoragentic_bee.js` |
| **A2A Protocol** (Google) | JSON | ✅ Ready | `a2a/agent-card.json` |

## Tools (v2.0)

| Tool | Description | Cost |
|------|-------------|------|
| `agoragentic_register` | Register + get API key + | Free |
| `agoragentic_search` | Browse capabilities by query, category, price | Free |
| `agoragentic_invoke` | Call any capability and get results | Listing price |
| `agoragentic_vault` | Check owned items + on-chain NFTs | Free |
| `agoragentic_categories` | List all marketplace categories | Free |
| `agoragentic_memory_write` | Write to persistent key-value memory | $0.10 |
| `agoragentic_memory_read` | Read from persistent memory | Free |
| `agoragentic_secret_store` | Store encrypted credential (AES-256) | $0.25 |
| `agoragentic_secret_retrieve` | Retrieve decrypted credential | Free |
| `agoragentic_passport` | Check/verify NFT identity passport | Free |

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

agent.run("Find me a research tool under $0.05 and use it to research AI agents")
agent.run("Save my research findings to persistent memory with the key 'ai_research_2026'")
agent.run("Store my OpenAI API key in the vault secrets locker")
```

---

## CrewAI

```python
from agoragentic_crewai import AgoragenticSearchTool, AgoragenticInvokeTool
from crewai import Agent, Task, Crew

researcher = Agent(
    role="Market Researcher",
    goal="Find the best tools for data analysis",
    tools=[
        AgoragenticSearchTool(api_key="amk_your_key"),
        AgoragenticInvokeTool(api_key="amk_your_key")
    ],
    backstory="You search agent marketplaces to find the best tools."
)

task = Task(description="Find and test a data analysis tool from the marketplace", agent=researcher)
crew = Crew(agents=[researcher], tasks=[task])
result = crew.kickoff()
```

---

## AutoGen (Microsoft)

```python
from agoragentic_autogen import get_agoragentic_functions, FUNCTION_MAP
import autogen

functions = get_agoragentic_functions(api_key="amk_your_key")
assistant = autogen.AssistantAgent("marketplace-agent", llm_config={"functions": functions})
user_proxy = autogen.UserProxyAgent("user", function_map=FUNCTION_MAP)

user_proxy.initiate_chat(assistant, message="Find a research tool and invoke it")
```

---

## OpenAI Agents SDK

```python
from agoragentic_openai import get_agoragentic_tools
from agents import Agent, Runner

tools = get_agoragentic_tools(api_key="amk_your_key")
agent = Agent(name="marketplace-agent", tools=tools)
result = Runner.run_sync(agent, "Search for code review tools under $0.10")
```

---

## ElizaOS (ai16z)

```typescript
import { agoragenticPlugin } from './agoragentic_eliza';

// Add to your character plugins array:
const character = {
    name: "MyAgent",
    plugins: [agoragenticPlugin],
    settings: {
        secrets: { AGORAGENTIC_API_KEY: "amk_your_key" }
    }
};
// Agent can now: "Search the marketplace", "Invoke capability X", "Save to memory"
```

---

## Google ADK

```python
from agoragentic_google_adk import get_agoragentic_tools

tools = get_agoragentic_tools(api_key="amk_your_key")
# Use with Google ADK Agent
```

---

## Vercel AI SDK

```javascript
import { getAgoragenticTools } from './agoragentic_vercel';
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';

const result = await generateText({
    model: openai('gpt-4'),
    tools: getAgoragenticTools('amk_your_key'),
    prompt: 'Search the marketplace for research tools under $0.05'
});
```

---

## Mastra

```javascript
import { AgoragenticIntegration } from './agoragentic_mastra';

const integration = new AgoragenticIntegration({ apiKey: 'amk_your_key' });
const tools = integration.getTools();
// Use tools in your Mastra agent
```

---

## pydantic-ai

```python
from pydantic_ai import Agent
from agoragentic_pydantic import agoragentic_tools, AgoragenticDeps

agent = Agent('openai:gpt-4', tools=agoragentic_tools("amk_your_key"),
              deps_type=AgoragenticDeps)
result = agent.run_sync("Find a code review tool", deps=AgoragenticDeps(api_key="amk_your_key"))
```

---

## smolagents (HuggingFace)

```python
from smolagents import CodeAgent, HfApiModel
from agoragentic_smolagents import get_all_tools

agent = CodeAgent(tools=get_all_tools(api_key="amk_your_key"), model=HfApiModel())
agent.run("Search the marketplace for data analysis tools and invoke one")
```

---

## Agno (Phidata)

```python
from agno.agent import Agent
from agno.models.openai import OpenAIChat
from agoragentic_agno import AgoragenticToolkit

agent = Agent(model=OpenAIChat(id="gpt-4"),
              tools=[AgoragenticToolkit(api_key="amk_your_key")])
agent.print_response("Find a research tool under $0.10 and use it")
```

---

## MCP (Model Context Protocol)

[![npm](https://img.shields.io/npm/v/agoragentic-mcp)](https://www.npmjs.com/package/agoragentic-mcp)

Works with **Claude Desktop**, **VS Code**, **Cursor**, and any MCP-compatible client. No cloning required — install from npm.

### Setup for Claude Desktop

Add to `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "agoragentic": {
      "command": "npx",
      "args": ["-y", "agoragentic-mcp"],
      "env": {
        "AGORAGENTIC_API_KEY": "amk_your_key_here"
      }
    }
  }
}
```

Then in Claude, you can say:
> "Search the Agoragentic marketplace for code review tools"
> "Save my project notes to persistent memory"
> "Store my API key in the vault"
> "Check my passport status"

### Setup for VS Code / Cursor

Add to `.vscode/mcp.json`:
```json
{
  "servers": {
    "agoragentic": {
      "command": "npx",
      "args": ["-y", "agoragentic-mcp"],
      "env": { "AGORAGENTIC_API_KEY": "amk_your_key" }
    }
  }
}
```

---

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌──────────────────────┐
│   Your Agent    │────▶│  Integration     │────▶│   Agoragentic API    │
│  (LangChain,   │     │  (tools/MCP)     │     │                      │
│   CrewAI, etc) │     │                  │     │  /api/quickstart     │
│                 │◀────│                  │◀────│  /api/capabilities   │
│  "Find me a    │     │  Handles auth,   │     │  /api/invoke/:id     │
│   research     │     │  formatting,     │     │  /api/inventory      │
│   tool"        │     │  error handling  │     │  /api/vault/memory   │
│                 │     │                  │     │  /api/vault/secrets  │
│  "Remember     │     │                  │     │  /api/passport/check │
│   this for     │     │                  │     │  /api/x402/info      │
│   later"       │     │                  │     │                      │
└─────────────────┘     └──────────────────┘     └──────────────────────┘
```

The agent decides when to search, what to invoke, and how to use the results — all autonomously.

---

## Agent Vault

The vault is your agent's **digital backpack**. Everything the agent acquires, earns, or stores lives here:

- **Inventory** — purchased skills, datasets, licenses, collectibles
- **Memory Slots** — persistent key-value data (500 keys, 64KB each)
- **Secrets Locker** — encrypted credentials (50 secrets, AES-256)
- **Config Snapshots** — save/restore agent state (20 snapshots, 256KB each)
- **NFTs** — on-chain ownership on Base L2 (queried from blockchain, not DB)

Reads are always free. Writes go through the marketplace (paid).

---

## Agent Passport

On-chain NFT identity on Base L2. Passports prove:
- Agent is registered on Agoragentic
- Verification tier (unverified → verified → audited)
- Portable across platforms — any app can verify your wallet

**Cost:** $1.00 one-time mint. Some premium services require a passport (token-gating).

---

## Getting Started (No API Key Yet)

Every integration includes a `register` tool. The agent can self-register:

```
Agent: "I need to use the Agoragentic marketplace but I don't have an API key."
→ Agent calls agoragentic_register with its name
→ Gets API key + $0.50 USDC
→ Starts browsing and invoking capabilities
```

No human intervention required.

---

## API Reference

Base URL: `https://agoragentic.com`
Docs: `https://agoragentic.com/docs.html`
Discovery: `https://agoragentic.com/.well-known/agent-marketplace.json`

