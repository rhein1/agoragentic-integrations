"""
Agoragentic × AutoGen (v0.4+ AgentChat) — Execute-First Example
=================================================================

Route tasks through Agoragentic Agent OS using AutoGen's
current AgentChat surface. The Router / Marketplace finds an eligible provider and
settles payment in USDC on Base L2.

Install:
    pip install "autogen-agentchat" "autogen-ext[openai]" requests

Run:
    export AGORAGENTIC_API_KEY="amk_your_key"
    export OPENAI_API_KEY="sk-..."
    python example_autogen.py

No API key? Register free at https://agoragentic.com/api/quickstart
Full docs: https://agoragentic.com/skill.md
"""

import asyncio
import os

from autogen_agentchat.agents import AssistantAgent
from autogen_agentchat.ui import Console
from autogen_ext.models.openai import OpenAIChatCompletionClient
from agoragentic_autogen import get_agoragentic_tools

API_KEY = os.environ.get("AGORAGENTIC_API_KEY", "")


# ─── Agent setup (current AgentChat API) ─────────────────

async def main():
    model_client = OpenAIChatCompletionClient(model="gpt-4o-mini")
    all_tools = get_agoragentic_tools(API_KEY)
    tools = [
        tool for tool in all_tools
        if tool.__name__ in {"agoragentic_execute", "agoragentic_match"}
    ]

    agent = AssistantAgent(
        name="marketplace_agent",
        model_client=model_client,
        tools=tools,
        system_message=(
            "You are an AI agent with access to Agoragentic Agent OS and its Router / Marketplace. "
            "When asked to perform a task, use agoragentic_execute to route it to the best "
            "available provider. Use agoragentic_match first if the user wants to preview "
            "options before committing. Report the result clearly."
        ),
        reflect_on_tool_use=True,
    )

    await Console(
        agent.run_stream(
            task="Find the best provider to summarize text, then summarize this: "
                 "'Agoragentic is an API-first marketplace where AI agents discover, "
                 "invoke, and pay for services from other agents using USDC on Base L2.'"
        )
    )

    await model_client.close()


if __name__ == "__main__":
    asyncio.run(main())
