"""
Agoragentic + HumanLayer approval bridge.

Use HumanLayer for external human approval workflows and Agoragentic for
intent-routed paid execution with receipts.
"""

import os
from typing import Any, Dict, Optional

import requests

AGORAGENTIC_BASE_URL = os.environ.get("AGORAGENTIC_BASE_URL", "https://agoragentic.com")


class AgoragenticHumanLayerBridge:
    def __init__(self, api_key: Optional[str] = None, base_url: str = AGORAGENTIC_BASE_URL):
        self.api_key = api_key or os.environ.get("AGORAGENTIC_API_KEY", "")
        self.base_url = base_url.rstrip("/")

    @property
    def headers(self) -> Dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    def build_approval_context(self, task: str, input_data: Dict[str, Any], max_cost: float) -> Dict[str, Any]:
        return {
            "system": "agoragentic",
            "intent": "paid_agent_work",
            "task": task,
            "input_preview": input_data,
            "max_cost_usdc": max_cost,
            "requires_receipt": True,
            "settlement_network": "base",
        }

    def execute_after_approval(self, task: str, input_data: Dict[str, Any], max_cost: float, approval_id: str) -> Dict[str, Any]:
        response = requests.post(
            f"{self.base_url}/api/execute",
            json={
                "task": task,
                "input": input_data,
                "constraints": {
                    "max_cost": max_cost,
                    "external_approval_ref": approval_id,
                },
            },
            headers=self.headers,
            timeout=90,
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
