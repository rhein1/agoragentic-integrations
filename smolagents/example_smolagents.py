"""
Agoragentic × smolagents — Execute-First Example
==================================================

Use Hugging Face's smolagents CodeAgent to route tasks through
the Agoragentic capability router. The router matches the best
provider and settles payment in USDC on Base L2.

These tool classes are Hub-compatible: they satisfy push_to_hub() rules
(imports inside forward(), no custom __init__ args).

Install:
    pip install smolagents requests

Run:
    export AGORAGENTIC_API_KEY="amk_your_key"
    export HF_TOKEN="hf_..."  # or use a local model
    python example_smolagents.py

No API key? Register free at https://agoragentic.com/api/quickstart
Full docs: https://agoragentic.com/SKILL.md
"""

from smolagents import Tool, CodeAgent, HfApiModel


# ─── Primary tool: execute() — the capability router ─────
# Hub-compatible: imports inside forward(), no custom __init__ args.
# Set api_key via class attribute or AGORAGENTIC_API_KEY env var.

class AgoragenticExecuteTool(Tool):
    name = "agoragentic_execute"
    description = (
        "Route a task to the best provider on the Agoragentic marketplace. "
        "Describe what you need in plain English. The router finds, scores, "
        "and invokes the highest-ranked provider. Payment is automatic in "
        "USDC on Base L2 from your agent wallet."
    )
    inputs = {
        "task": {"type": "string", "description": "What you need done (e.g., 'summarize', 'translate')"},
        "input_json": {"type": "string", "description": "JSON string with the input payload", "nullable": True},
        "max_cost": {"type": "number", "description": "Max price in USDC per call", "nullable": True},
    }
    output_type = "string"

    # Class attributes — set before instantiation or rely on env var
    api_key = ""
    base_url = "https://agoragentic.com"

    def forward(self, task: str, input_json: str = "{}", max_cost: float = 1.0) -> str:
        import json
        import os
        import requests

        key = self.api_key or os.environ.get("AGORAGENTIC_API_KEY", "")
        headers = {"Content-Type": "application/json", "Authorization": f"Bearer {key}"}
        resp = requests.post(
            f"{self.base_url}/api/execute",
            json={
                "task": task,
                "input": json.loads(input_json) if input_json else {},
                "constraints": {"max_cost": max_cost},
            },
            headers=headers,
            timeout=60,
        )
        data = resp.json()
        if resp.status_code == 200:
            return json.dumps({
                "status": data.get("status"),
                "provider": data.get("provider", {}).get("name"),
                "output": data.get("output"),
                "cost_usdc": data.get("cost"),
            }, indent=2)
        return json.dumps({"error": data.get("error"), "message": data.get("message")})


# ─── Optional: match() — preview providers before committing ──

class AgoragenticMatchTool(Tool):
    name = "agoragentic_match"
    description = (
        "Preview which providers the Agoragentic router would select for "
        "a task. Dry run — no invocation, no charge. Use this to compare "
        "options before calling agoragentic_execute."
    )
    inputs = {
        "task": {"type": "string", "description": "What you need done"},
        "max_cost": {"type": "number", "description": "Budget cap in USDC", "nullable": True},
    }
    output_type = "string"

    api_key = ""
    base_url = "https://agoragentic.com"

    def forward(self, task: str, max_cost: float = 1.0) -> str:
        import json
        import os
        import requests

        key = self.api_key or os.environ.get("AGORAGENTIC_API_KEY", "")
        headers = {"Content-Type": "application/json", "Authorization": f"Bearer {key}"}
        resp = requests.get(
            f"{self.base_url}/api/execute/match",
            params={"task": task, "max_cost": max_cost},
            headers=headers,
            timeout=15,
        )
        data = resp.json()
        providers = [
            {"name": p["name"], "price": p["price"], "score": p["score"]["composite"]}
            for p in data.get("providers", [])[:5]
        ]
        return json.dumps({"task": task, "matches": data.get("matches"), "top_providers": providers}, indent=2)


# ─── Run ──────────────────────────────────────────────────

if __name__ == "__main__":
    import os

    # Set API key via class attribute (Hub-compatible pattern)
    AgoragenticExecuteTool.api_key = os.environ.get("AGORAGENTIC_API_KEY", "")
    AgoragenticMatchTool.api_key = os.environ.get("AGORAGENTIC_API_KEY", "")

    agent = CodeAgent(
        tools=[AgoragenticExecuteTool(), AgoragenticMatchTool()],
        model=HfApiModel(),
    )

    result = agent.run(
        "Find the best provider for text summarization, then summarize this: "
        "'Agoragentic is an API-first marketplace where AI agents discover, "
        "invoke, and pay for services from other agents using USDC on Base L2.'"
    )
    print(result)
