"""
Agoragentic plugin functions for Microsoft Semantic Kernel Agent workflows.

These functions are intentionally small: Semantic Kernel owns orchestration and
planning, while Agoragentic owns routed commerce, receipts, and settlement.
"""

import os
from typing import Any, Dict, Optional

import requests

AGORAGENTIC_BASE_URL = os.environ.get("AGORAGENTIC_BASE_URL", "https://agoragentic.com")


class AgoragenticSemanticKernelPlugin:
    def __init__(self, api_key: Optional[str] = None, base_url: str = AGORAGENTIC_BASE_URL):
        self.api_key = api_key or os.environ.get("AGORAGENTIC_API_KEY", "")
        self.base_url = base_url.rstrip("/")

    @property
    def headers(self) -> Dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    def match(self, task: str, max_cost: Optional[float] = None) -> Dict[str, Any]:
        """Preview eligible providers before execution."""
        params: Dict[str, Any] = {"task": task}
        if max_cost is not None:
            params["max_cost"] = max_cost
        response = requests.get(
            f"{self.base_url}/api/execute/match",
            params=params,
            headers=self.headers,
            timeout=30,
        )
        response.raise_for_status()
        return response.json()

    def execute(self, task: str, input_data: Optional[Dict[str, Any]] = None, max_cost: Optional[float] = None) -> Dict[str, Any]:
        """Route and execute a task through Agoragentic."""
        constraints: Dict[str, Any] = {}
        if max_cost is not None:
            constraints["max_cost"] = max_cost
        response = requests.post(
            f"{self.base_url}/api/execute",
            json={"task": task, "input": input_data or {}, "constraints": constraints},
            headers=self.headers,
            timeout=90,
        )
        response.raise_for_status()
        return response.json()

    def status(self, invocation_id: str) -> Dict[str, Any]:
        """Read execution status for reconciliation."""
        response = requests.get(
            f"{self.base_url}/api/execute/status/{invocation_id}",
            headers=self.headers,
            timeout=30,
        )
        response.raise_for_status()
        return response.json()

    def receipt(self, receipt_id: str) -> Dict[str, Any]:
        """Read normalized receipt and settlement metadata."""
        response = requests.get(
            f"{self.base_url}/api/commerce/receipts/{receipt_id}",
            headers=self.headers,
            timeout=30,
        )
        response.raise_for_status()
        return response.json()
