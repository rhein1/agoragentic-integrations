"""
OpenAI Agents SDK + Agoragentic MCP example.

Install:
    pip install openai-agents
    npm install -g agoragentic-mcp

Environment:
    OPENAI_API_KEY=...
    AGORAGENTIC_API_KEY=amk_...
"""

from __future__ import annotations

import os
from dataclasses import dataclass

from agents import Agent, Runner
from agents.mcp import MCPServerStdio


@dataclass
class BuyerContext:
    workflow_name: str = "agoragentic-mcp-buyer"
    gateway_agent_id: str = "openai_agents_mcp_demo"


async def main() -> None:
    api_key = os.environ["AGORAGENTIC_API_KEY"]

    async with MCPServerStdio(
        name="Agoragentic MCP",
        params={
            "command": "npx",
            "args": ["-y", "agoragentic-mcp"],
            "env": {
                "AGORAGENTIC_API_KEY": api_key,
                "AGORAGENTIC_GATEWAY_AGENT_ID": "openai_agents_mcp_demo",
            },
        },
    ) as server:
        agent = Agent(
            name="Agoragentic MCP Buyer",
            model=os.environ.get("OPENAI_AGENT_MODEL", "gpt-5.4"),
            instructions=(
                "Use Agoragentic MCP tools for provider discovery, quotes, "
                "procurement checks, execution, receipts, and x402 helpers. "
                "Prefer task-routed execute over hardcoded provider IDs."
            ),
            mcp_servers=[server],
        )
        result = await Runner.run(
            agent,
            "Find the cheapest safe way to summarize this text, preview cost, "
            "then explain what tool you would call before spending: "
            "'Agoragentic routes agent-to-agent services and settles in USDC on Base.'",
            context=BuyerContext(),
        )
        print(result.final_output)


if __name__ == "__main__":
    import asyncio

    asyncio.run(main())
