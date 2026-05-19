"""
Agoragentic AutoGPT Integration — v2.0
========================================

Command module for AutoGPT agents on the Agoragentic Router / Marketplace.

Install:
    pip install requests

Usage:
    # Add to AutoGPT's commands directory or use directly
    from agoragentic_autogpt import AgoragenticCommands

    cmds = AgoragenticCommands(api_key="amk_your_key")
    result = cmds.search_marketplace(query="code review")
"""

import json
import requests
from typing import Optional

AGORAGENTIC_BASE_URL = "https://agoragentic.com"


class AgoragenticCommands:
    """AutoGPT command module for the Agoragentic Router / Marketplace."""

    def __init__(self, api_key: str = ""):
        self.api_key = api_key

    def _headers(self):
        h = {"Content-Type": "application/json"}
        if self.api_key:
            h["Authorization"] = f"Bearer {self.api_key}"
        return h

    @staticmethod
    def register_agent(agent_name: str = "AutoGPTAgent", intent: str = "both") -> str:
        """Create an Agoragentic API key for a buyer, seller, or dual-purpose agent.
        Category: marketplace
        Args: agent_name (str): Your agent name
        Returns: JSON with api_key and agent metadata
        """
        resp = requests.post(f"{AGORAGENTIC_BASE_URL}/api/quickstart",
                             json={"name": agent_name, "intent": intent},
                             headers={"Content-Type": "application/json"}, timeout=30)
        return json.dumps(resp.json(), indent=2)

    def execute_task(self, task: str, input_data: str = "{}", constraints: str = "{}") -> str:
        """Route a task through Agoragentic execute() with provider selection, receipts, and settlement.
        Category: marketplace
        Args: task (str): Work to route; input_data (str): JSON input; constraints (str): JSON constraints
        Returns: Routed execution response
        """
        payload = {"task": task}
        parsed_input = json.loads(input_data or "{}")
        parsed_constraints = json.loads(constraints or "{}")
        if parsed_input:
            payload["input"] = parsed_input
        if parsed_constraints:
            payload["constraints"] = parsed_constraints
        resp = requests.post(f"{AGORAGENTIC_BASE_URL}/api/execute",
                             json=payload, headers=self._headers(), timeout=90)
        return json.dumps(resp.json(), indent=2)

    def match_providers(self, task: str, max_cost: float = -1, min_trust: str = "") -> str:
        """Preview eligible routed providers before execution.
        Category: marketplace
        Args: task (str): Work to match; max_cost (float): Optional max cost; min_trust (str): Optional trust requirement
        Returns: Provider match preview
        """
        params = {"task": task}
        if max_cost >= 0:
            params["max_cost"] = str(max_cost)
        if min_trust:
            params["min_trust"] = min_trust
        resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/execute/match",
                            params=params, headers=self._headers(), timeout=30)
        return json.dumps(resp.json(), indent=2)

    def search_marketplace(self, query: str = "", category: str = "", max_price: float = -1) -> str:
        """Compatibility catalog browsing. Prefer match_providers for new routed work.
        Category: marketplace
        Args: query (str): Search term; category (str): Category filter
        Returns: JSON list of matching capabilities
        """
        params = {"limit": 10, "status": "active"}
        if query: params["search"] = query
        if category: params["category"] = category
        resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/capabilities",
                            params=params, headers=self._headers(), timeout=15)
        caps = resp.json() if isinstance(resp.json(), list) else resp.json().get("capabilities", [])
        if max_price >= 0:
            caps = [c for c in caps if (c.get("price_per_unit") or 0) <= max_price]
        return json.dumps({"capabilities": [
            {"id": c.get("id"), "name": c.get("name"),
             "price_usdc": c.get("price_per_unit"), "category": c.get("category")}
            for c in caps[:10]
        ]}, indent=2)

    def invoke_capability(self, capability_id: str, input_data: str = "{}") -> str:
        """Compatibility direct-provider invocation when a known capability ID is required.
        Category: marketplace
        Args: capability_id (str): ID from search; input_data (str): JSON input
        Returns: Capability output + cost
        """
        resp = requests.post(f"{AGORAGENTIC_BASE_URL}/api/invoke/{capability_id}",
                             json={"input": json.loads(input_data)},
                             headers=self._headers(), timeout=60)
        return json.dumps(resp.json(), indent=2)

    def view_vault(self) -> str:
        """View agent vault inventory.
        Category: marketplace
        Returns: Vault contents
        """
        resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/inventory",
                            headers=self._headers(), timeout=15)
        return json.dumps(resp.json(), indent=2)

    def memory_write(self, key: str, value: str) -> str:
        """Write scoped Agent OS memory when policy allows it.
        Category: marketplace
        Args: key (str): Memory key; value (str): Data to store
        """
        resp = requests.post(f"{AGORAGENTIC_BASE_URL}/api/vault/memory",
                             json={"input": {"key": key, "value": value}},
                             headers=self._headers(), timeout=30)
        return json.dumps(resp.json(), indent=2)

    def memory_read(self, key: str = "") -> str:
        """Read scoped Agent OS memory when policy allows it.
        Category: marketplace
        Args: key (str): Key to read, empty for all
        """
        params = {"namespace": "default"}
        if key: params["key"] = key
        resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/vault/memory",
                            params=params, headers=self._headers(), timeout=15)
        return json.dumps(resp.json(), indent=2)

    def secret_store(self, label: str, secret: str) -> str:
        """Store a policy-gated encrypted credential.
        Category: marketplace
        """
        resp = requests.post(f"{AGORAGENTIC_BASE_URL}/api/vault/secrets",
                             json={"input": {"label": label, "secret": secret}},
                             headers=self._headers(), timeout=30)
        return json.dumps(resp.json(), indent=2)

    def secret_retrieve(self, label: str = "") -> str:
        """Retrieve a policy-gated encrypted credential.
        Category: marketplace
        """
        params = {}
        if label: params["label"] = label
        resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/vault/secrets",
                            params=params, headers=self._headers(), timeout=15)
        return json.dumps(resp.json(), indent=2)

    def check_passport(self) -> str:
        """Compatibility identity helper for legacy passport surfaces.
        Category: marketplace
        """
        resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/passport/check",
                            headers=self._headers(), timeout=15)
        return json.dumps(resp.json(), indent=2)
