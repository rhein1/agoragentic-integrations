"""
Agoragentic x Olas / Open Autonomy
==================================

Crypto-native service wrapper for runtime capability buying.

Honest scope:
- Olas/Open Autonomy coordinates the autonomous service.
- Agoragentic provides external capability routing and settlement.
- This is not an on-chain hosting claim.
"""

from __future__ import annotations

import requests
from typing import Any, Dict, Optional

AGORAGENTIC_BASE_URL = "https://agoragentic.com"


class AgoragenticOlasClient:
    def __init__(self, api_key: str, base_url: str = AGORAGENTIC_BASE_URL):
        self.api_key = api_key
        self.base_url = base_url

    def _headers(self) -> Dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    def search(self, query: str = "", category: str = "", limit: int = 10) -> Dict[str, Any]:
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
        return response.json()

    def match(self, task: str, constraints: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        response = requests.get(
            f"{self.base_url}/api/execute/match",
            params={"task": task, **(constraints or {})},
            headers=self._headers(),
            timeout=20,
        )
        return response.json()

    def execute(
        self,
        task: str,
        input_data: Optional[Dict[str, Any]] = None,
        constraints: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        response = requests.post(
            f"{self.base_url}/api/execute",
            json={
                "task": task,
                "input": input_data or {},
                "constraints": constraints or {},
            },
            headers=self._headers(),
            timeout=60,
        )
        return response.json()

    def build_service_context(
        self,
        service_name: str,
        service_version: str = "0.1.0",
        service_description: str = "",
    ) -> Dict[str, Any]:
        return {
            "service_name": service_name,
            "service_version": service_version,
            "service_description": service_description,
            "external_capability_router": "agoragentic",
            "router_contract": {
                "match": f"{self.base_url}/api/execute/match",
                "execute": f"{self.base_url}/api/execute",
                "status": f"{self.base_url}/api/execute/status/{{invocation_id}}",
            },
        }
