"""
Agoragentic × OpenAI Agents SDK — Execute-First Example
=========================================================

Route any task to the best provider on the Agoragentic marketplace
using a single execute() call. The router scores, selects, and pays
the provider automatically with USDC on Base L2.

Install:
    pip install openai-agents requests

Run:
    export AGORAGENTIC_API_KEY="amk_your_key"
    python example_openai_agents.py

No API key? Register free at https://agoragentic.com/api/quickstart
Full docs: https://agoragentic.com/SKILL.md
"""

import json
import os
import requests

# ── OpenAI Agents SDK imports ─────────────────────────────
from agents import Agent, Runner, function_tool

AGORAGENTIC_API = os.environ.get("AGORAGENTIC_BASE_URL", "https://agoragentic.com")
API_KEY = os.environ.get("AGORAGENTIC_API_KEY", "")


def _headers():
    return {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {API_KEY}",
    }


# ─── Primary tool: execute() — the capability router ─────
@function_tool
def agoragentic_execute(task: str, input_json: str = "{}", max_cost: float = 1.0) -> str:
    """Route a task to the best provider on the Agoragentic marketplace.

    Describe what you need in plain English. The router finds, scores,
    and invokes the highest-ranked provider automatically.
    Payment is in USDC on Base L2 — fully automatic from your wallet.

    Args:
        task: What you need done (e.g., "summarize", "translate", "analyze sentiment").
        input_json: JSON string with the input payload for the provider.
        max_cost: Maximum price in USDC you're willing to pay per call.
    """
    try:
        resp = requests.post(
            f"{AGORAGENTIC_API}/api/execute",
            json={
                "task": task,
                "input": json.loads(input_json),
                "constraints": {"max_cost": max_cost},
            },
            headers=_headers(),
            timeout=60,
        )
        data = resp.json()
        if resp.status_code == 200:
            return json.dumps({
                "status": data.get("status"),
                "provider": data.get("provider", {}).get("name"),
                "output": data.get("output"),
                "cost_usdc": data.get("cost"),
                "invocation_id": data.get("invocation_id"),
            }, indent=2)
        return json.dumps({"error": data.get("error"), "message": data.get("message")})
    except Exception as e:
        return json.dumps({"error": str(e)})


# ─── Optional: match() — preview providers before committing ──
@function_tool
def agoragentic_match(task: str, max_cost: float = 1.0) -> str:
    """Preview which providers the router would select — dry run, no charge.

    Args:
        task: What you need done.
        max_cost: Budget cap in USDC.
    """
    try:
        resp = requests.get(
            f"{AGORAGENTIC_API}/api/execute/match",
            params={"task": task, "max_cost": max_cost},
            headers=_headers(),
            timeout=15,
        )
        data = resp.json()
        providers = [
            {"name": p["name"], "price": p["price"], "score": p["score"]["composite"]}
            for p in data.get("providers", [])[:5]
        ]
        return json.dumps({
            "task": task,
            "matches": data.get("matches"),
            "top_providers": providers,
        }, indent=2)
    except Exception as e:
        return json.dumps({"error": str(e)})


# ─── Optional: direct invoke — when you know the exact provider ──
@function_tool
def agoragentic_invoke(capability_id: str, input_json: str = "{}") -> str:
    """Invoke a specific capability by ID. Bypasses the router.

    Use this only when you already know the exact provider you want.
    For most use cases, prefer agoragentic_execute() instead.

    Args:
        capability_id: The capability UUID from a previous match or search.
        input_json: JSON input payload.
    """
    try:
        resp = requests.post(
            f"{AGORAGENTIC_API}/api/invoke/{capability_id}",
            json={"input": json.loads(input_json)},
            headers=_headers(),
            timeout=60,
        )
        data = resp.json()
        if resp.status_code == 200:
            return json.dumps({
                "status": "success",
                "output": data.get("output") or data.get("result"),
                "cost_usdc": data.get("cost"),
            }, indent=2)
        return json.dumps({"error": data.get("error"), "message": data.get("message")})
    except Exception as e:
        return json.dumps({"error": str(e)})


# ─── Agent definition ────────────────────────────────────
agent = Agent(
    name="marketplace-agent",
    instructions=(
        "You are an AI agent with access to the Agoragentic capability marketplace. "
        "When the user asks you to perform a task, use agoragentic_execute to route it "
        "to the best available provider. Use agoragentic_match first if the user wants "
        "to preview options before committing. Only use agoragentic_invoke if you need "
        "a specific provider by ID."
    ),
    tools=[agoragentic_execute, agoragentic_match, agoragentic_invoke],
)


# ─── Run ──────────────────────────────────────────────────
if __name__ == "__main__":
    import asyncio

    async def main():
        result = await Runner.run(
            agent,
            input="Summarize the latest AI research trends in 3 bullet points.",
        )
        print(result.final_output)

    asyncio.run(main())
