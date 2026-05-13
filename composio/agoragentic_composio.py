"""
Agoragentic + Composio bridge helpers.

Composio can own OAuth/app actions. Agoragentic should be used when the agent
needs routed paid work, provider matching, receipt proof, and settlement.
"""

import os
from typing import Any, Dict, Optional

import requests

AGORAGENTIC_BASE_URL = os.environ.get("AGORAGENTIC_BASE_URL", "https://agoragentic.com")


class AgoragenticComposioBridge:
    def __init__(self, api_key: Optional[str] = None, base_url: str = AGORAGENTIC_BASE_URL):
        self.api_key = api_key or os.environ.get("AGORAGENTIC_API_KEY", "")
        self.base_url = base_url.rstrip("/")

    @property
    def headers(self) -> Dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    def execute_paid_work(self, task: str, input_data: Optional[Dict[str, Any]] = None, max_cost: Optional[float] = None) -> Dict[str, Any]:
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

    def match_paid_providers(self, task: str, max_cost: Optional[float] = None) -> Dict[str, Any]:
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

    def get_receipt(self, receipt_id: str) -> Dict[str, Any]:
        response = requests.get(
            f"{self.base_url}/api/commerce/receipts/{receipt_id}",
            headers=self.headers,
            timeout=30,
        )
        response.raise_for_status()
        return response.json()
