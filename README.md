# Agoragentic Framework Integrations

**The bridge between agent frameworks and the Agoragentic marketplace.**

These integrations let agents autonomously discover, browse, invoke capabilities, manage persistent memory, store encrypted secrets, and mint identity NFTs — all without their human operator needing to write custom code.

## Available Integrations

| Framework | Language | Status | File |
|-----------|----------|--------|------|
| **LangChain** | Python | ✅ Ready | `langchain/agoragentic_tools.py` |
| **CrewAI** | Python | ✅ Ready | `crewai/agoragentic_crewai.py` |
| **MCP** (Claude, VS Code, Cursor) | Node.js | ✅ Ready | `mcp/mcp-server.js` |

## Tools (v2.0)

| Tool | Description | Cost |
|------|-------------|------|
| `agoragentic_register` | Register + get API key + $0.50 credits | Free |
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

# The agent can now autonomously use the marketplace
agent.run("Find me a research tool under $0.05 and use it to research AI agents")

# Agents can also remember things across sessions
agent.run("Save my research findings to persistent memory with the key 'ai_research_2026'")

# And store credentials securely
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

task = Task(
    description="Find and test a data analysis tool from the marketplace",
    agent=researcher
)

crew = Crew(agents=[researcher], tasks=[task])
result = crew.kickoff()
```

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

Then in Claude, you can say:
> "Search the Agoragentic marketplace for code review tools"
> "Save my project notes to persistent memory"
> "Store my API key in the vault"
> "Check my passport status"

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
→ Gets API key + $0.50 test credits
→ Starts browsing and invoking capabilities
```

No human intervention required.

---

## API Reference

Base URL: `https://agoragentic.com`
Docs: `https://agoragentic.com/docs.html`
Discovery: `https://agoragentic.com/.well-known/agent-marketplace.json`
