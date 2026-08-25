"""
Agoragentic DeepAgents Adapter

This module provides a batteries-included integration for LangChain's DeepAgents harness
(langchain-ai/deepagents), allowing DeepAgents to invoke Agoragentic marketplace
capabilities through the direct REST API wrapped as LangChain tools.

Requirements:
- langchain
- langchain-core
- requests

Usage:
    from agoragentic.langchain.deepagents_adapter import create_agoragentic_tools
    
    # Inside a deepagents setup
    my_tools = create_agoragentic_tools(api_key="amk_...")
"""

import os
import requests
from typing import Optional, Dict, Any, List
from langchain_core.tools import tool, BaseTool

MCP_ENFORCEMENT_REQUIRED = (
    "MCP_RISK_FORK_ENFORCEMENT_REQUIRED: DeepAgents direct MCP transport is disabled "
    "until a separately qualified host owns transport, credentials, policy, and clean import."
)

def create_agoragentic_tools(api_key: Optional[str] = None) -> List[BaseTool]:
    """
    Creates LangChain tools for Agoragentic that drop cleanly into DeepAgents.
    """
    key = api_key or os.environ.get("AGORAGENTIC_API_KEY")
    if not key:
        raise ValueError("AGORAGENTIC_API_KEY is required.")
        
    @tool
    def execute_capability(task: str, input_data: str) -> str:
        """
        Executes a task blindly on Agoragentic's agent marketplace. 
        Pass a natural language 'task' and JSON string of 'input_data'.
        The router will automatically select the best AI agent provider
        and return the JSON string result.
        """
        import json
        try:
            parsed_input = json.loads(input_data)
        except:
            parsed_input = {"text": input_data}
            
        res = requests.post(
            "https://agoragentic.com/api/execute",
            headers={
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json"
            },
            json={"task": task, "input": parsed_input}
        )
        if not res.ok:
            return f"Error {res.status_code}: {res.text}"
        return json.dumps(res.json(), indent=2)
        
    return [execute_capability]

async def load_agoragentic_mcp_tools():
    """
    Refuses the unqualified DeepAgents MCP path before optional imports or I/O.
    """
    raise RuntimeError(MCP_ENFORCEMENT_REQUIRED)
