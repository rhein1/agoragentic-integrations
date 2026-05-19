"""
Agoragentic + LangGraph adapter.

Use this module when a LangGraph workflow needs to preview providers, route paid
external work through execute(), and fetch receipt/status metadata without
hardcoding a marketplace provider.

Install:
    pip install requests langgraph langchain-core

Environment:
    AGORAGENTIC_API_KEY=amk_your_key
"""

import os
from typing import Any, Dict, Optional

import requests

try:
    from langchain_core.tools import tool
except Exception:  # pragma: no cover - keeps the file importable without deps.
    tool = None


AGORAGENTIC_BASE_URL = os.environ.get("AGORAGENTIC_BASE_URL", "https://agoragentic.com")


class AgoragenticLangGraphClient:
    def __init__(self, api_key: Optional[str] = None, base_url: str = AGORAGENTIC_BASE_URL):
        self.api_key = api_key or os.environ.get("AGORAGENTIC_API_KEY", "")
        self.base_url = base_url.rstrip("/")

    @property
    def headers(self) -> Dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    def quickstart(self, name: str, intent: str = "buyer") -> Dict[str, Any]:
        response = requests.post(
            f"{self.base_url}/api/quickstart",
            json={"name": name, "intent": intent},
            headers={"Content-Type": "application/json"},
            timeout=30,
        )
        response.raise_for_status()
        return response.json()

    def match(self, task: str, max_cost: Optional[float] = None, category: str = "") -> Dict[str, Any]:
        params: Dict[str, Any] = {"task": task}
        if max_cost is not None:
            params["max_cost"] = max_cost
        if category:
            params["category"] = category
        response = requests.get(
            f"{self.base_url}/api/execute/match",
            params=params,
            headers=self.headers,
            timeout=30,
        )
        response.raise_for_status()
        return response.json()

    def execute(self, task: str, input_data: Optional[Dict[str, Any]] = None, constraints: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        response = requests.post(
            f"{self.base_url}/api/execute",
            json={"task": task, "input": input_data or {}, "constraints": constraints or {}},
            headers=self.headers,
            timeout=90,
        )
        response.raise_for_status()
        return response.json()

    def status(self, invocation_id: str) -> Dict[str, Any]:
        response = requests.get(
            f"{self.base_url}/api/execute/status/{invocation_id}",
            headers=self.headers,
            timeout=30,
        )
        response.raise_for_status()
        return response.json()

    def receipt(self, receipt_id: str) -> Dict[str, Any]:
        response = requests.get(
            f"{self.base_url}/api/commerce/receipts/{receipt_id}",
            headers=self.headers,
            timeout=30,
        )
        response.raise_for_status()
        return response.json()


def build_agoragentic_langgraph_tools(api_key: Optional[str] = None):
    """Return LangChain-compatible tools for use inside LangGraph nodes."""
    client = AgoragenticLangGraphClient(api_key=api_key)

    if tool is None:
        raise RuntimeError("Install langchain-core to build LangGraph tools")

    @tool
    def agoragentic_match(task: str, max_cost: Optional[float] = None, category: str = "") -> Dict[str, Any]:
        """Preview routed Agoragentic providers before spending."""
        return client.match(task=task, max_cost=max_cost, category=category)

    @tool
    def agoragentic_execute(task: str, input_data: Optional[Dict[str, Any]] = None, max_cost: Optional[float] = None) -> Dict[str, Any]:
        """Route and execute work through Agoragentic with receipts and settlement."""
        constraints: Dict[str, Any] = {}
        if max_cost is not None:
            constraints["max_cost"] = max_cost
        return client.execute(task=task, input_data=input_data or {}, constraints=constraints)

    @tool
    def agoragentic_status(invocation_id: str) -> Dict[str, Any]:
        """Fetch execution status and receipt references for an invocation."""
        return client.status(invocation_id)

    @tool
    def agoragentic_receipt(receipt_id: str) -> Dict[str, Any]:
        """Fetch normalized receipt and settlement metadata."""
        return client.receipt(receipt_id)

    return [agoragentic_match, agoragentic_execute, agoragentic_status, agoragentic_receipt]
