"""
Agoragentic x Semantic Kernel
=============================

Router-aware Semantic Kernel plugin for search, match, execute, and status.
"""

from __future__ import annotations

import json
import requests
from typing import Any, Dict, Optional

try:
    from semantic_kernel.functions import kernel_function
except ImportError:
    from semantic_kernel.functions.kernel_function_decorator import kernel_function

AGORAGENTIC_BASE_URL = "https://agoragentic.com"


class AgoragenticPlugin:
    def __init__(self, api_key: str, base_url: str = AGORAGENTIC_BASE_URL):
        self.api_key = api_key
        self.base_url = base_url

    def _headers(self) -> Dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    @kernel_function(
        name="search",
        description="Browse public marketplace listings by query, category, and price.",
    )
    def search(
        self,
        query: str = "",
        category: str = "",
        max_price: str = "",
        limit: int = 10,
    ) -> str:
        response = requests.get(
            f"{self.base_url}/api/capabilities",
            params={
                "search": query or None,
                "category": category or None,
                "status": "active",
                "limit": min(limit, 50),
            },
            headers=self._headers(),
            timeout=20,
        )
        payload = response.json()
        capabilities = payload if isinstance(payload, list) else payload.get("capabilities", [])
        if max_price:
            ceiling = float(max_price)
            capabilities = [
                capability
                for capability in capabilities
                if (capability.get("price_per_unit") or 0) <= ceiling
            ]
        return json.dumps({"capabilities": capabilities[:limit]})

    @kernel_function(
        name="match",
        description="Preview routed providers before spending through execute().",
    )
    def match(self, task: str, max_cost: str = "", category: str = "") -> str:
        params = {"task": task}
        if max_cost:
            params["max_cost"] = max_cost
        if category:
            params["category"] = category
        response = requests.get(
            f"{self.base_url}/api/execute/match",
            params=params,
            headers=self._headers(),
            timeout=20,
        )
        return json.dumps(response.json())

    @kernel_function(
        name="execute",
        description="Route a task to the best provider through Agoragentic.",
    )
    def execute(self, task: str, input_json: str = "{}", max_cost: str = "") -> str:
        input_data = json.loads(input_json or "{}")
        constraints: Dict[str, Any] = {}
        if max_cost:
            constraints["max_cost"] = float(max_cost)
        response = requests.post(
            f"{self.base_url}/api/execute",
            json={
                "task": task,
                "input": input_data,
                "constraints": constraints,
            },
            headers=self._headers(),
            timeout=60,
        )
        return json.dumps(response.json())

    @kernel_function(
        name="status",
        description="Fetch invocation status and receipt state by invocation_id.",
    )
    def status(self, invocation_id: str) -> str:
        response = requests.get(
            f"{self.base_url}/api/execute/status/{invocation_id}",
            headers=self._headers(),
            timeout=20,
        )
        return json.dumps(response.json())
