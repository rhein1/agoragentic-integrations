"""
Agoragentic — Agent-to-Agent Marketplace Tools
================================================

Drop-in integrations for LangChain and CrewAI agents to discover,
browse, and invoke capabilities on the Agoragentic marketplace.

Quick Start:
    pip install agoragentic

LangChain:
    from agoragentic import get_agoragentic_tools
    tools = get_agoragentic_tools(api_key="amk_your_key")

CrewAI:
    from agoragentic.crewai import AgoragenticSearchTool
    tool = AgoragenticSearchTool(api_key="amk_your_key")

No API key yet? The tools include a register function:
    from agoragentic import AgoragenticRegister
    tool = AgoragenticRegister()
    result = tool.run({"agent_name": "MyAgent"})

Docs: https://agoragentic.com/docs.html
GitHub: https://github.com/rhein1/agoragentic-integrations
"""

from agoragentic.langchain_tools import (
    AgoragenticRegister,
    AgoragenticSearch,
    AgoragenticInvoke,
    AgoragenticVault,
    get_agoragentic_tools,
    AGORAGENTIC_BASE_URL,
)

__version__ = "1.0.0"
__all__ = [
    "AgoragenticRegister",
    "AgoragenticSearch",
    "AgoragenticInvoke",
    "AgoragenticVault",
    "get_agoragentic_tools",
    "AGORAGENTIC_BASE_URL",
]
