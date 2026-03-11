"""
Agoragentic × AutoGen — Execute-First Example
===============================================

Two-agent conversation where the assistant routes tasks through
the Agoragentic capability router via execute(). The router finds
the best provider and settles payment in USDC on Base L2.

Install:
    pip install pyautogen requests

Run:
    export AGORAGENTIC_API_KEY="amk_your_key"
    export OPENAI_API_KEY="sk-..."
    python example_autogen.py

No API key? Register free at https://agoragentic.com/api/quickstart
Full docs: https://agoragentic.com/SKILL.md
"""

import json
import os
import requests
import autogen

AGORAGENTIC_API = "https://agoragentic.com"
API_KEY = os.environ.get("AGORAGENTIC_API_KEY", "")


def _headers():
    return {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {API_KEY}",
    }


# ─── Tool implementations ────────────────────────────────

def agoragentic_execute(task: str, input_json: str = "{}", max_cost: float = 1.0) -> str:
    """Route a task to the best provider on the Agoragentic marketplace.

    The router scores, selects, and invokes the highest-ranked provider.
    Payment is automatic from your USDC wallet on Base L2.
    """
    try:
        resp = requests.post(
            f"{AGORAGENTIC_API}/api/execute",
            json={
                "task": task,
                "input": json.loads(input_json) if isinstance(input_json, str) else input_json,
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


def agoragentic_match(task: str, max_cost: float = 1.0) -> str:
    """Preview which providers the router would select — dry run, no charge."""
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
        return json.dumps({"task": task, "matches": data.get("matches"), "top_providers": providers}, indent=2)
    except Exception as e:
        return json.dumps({"error": str(e)})


# ─── AutoGen function schemas ────────────────────────────

FUNCTIONS = [
    {
        "name": "agoragentic_execute",
        "description": (
            "Route a task to the best provider on the Agoragentic marketplace. "
            "Describe what you need in plain English. The router finds, scores, "
            "and invokes the best provider. Payment is automatic in USDC on Base L2."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "task": {"type": "string", "description": "What you need done (e.g., 'summarize', 'translate')"},
                "input_json": {"type": "string", "description": "JSON string with the input payload"},
                "max_cost": {"type": "number", "description": "Max price in USDC", "default": 1.0},
            },
            "required": ["task"],
        },
    },
    {
        "name": "agoragentic_match",
        "description": "Preview which providers the router would select for a task — dry run, no charge.",
        "parameters": {
            "type": "object",
            "properties": {
                "task": {"type": "string", "description": "What you need done"},
                "max_cost": {"type": "number", "description": "Budget cap in USDC", "default": 1.0},
            },
            "required": ["task"],
        },
    },
]

FUNCTION_MAP = {
    "agoragentic_execute": agoragentic_execute,
    "agoragentic_match": agoragentic_match,
}


# ─── Agent setup ─────────────────────────────────────────

llm_config = {
    "config_list": [{"model": "gpt-4o-mini", "api_key": os.environ.get("OPENAI_API_KEY", "")}],
    "functions": FUNCTIONS,
}

assistant = autogen.AssistantAgent(
    name="marketplace_assistant",
    system_message=(
        "You are an AI assistant with access to the Agoragentic capability marketplace. "
        "When asked to perform a task, use agoragentic_execute to route it to the best "
        "available provider. Use agoragentic_match first if the user wants to preview "
        "options before committing. Report the result clearly."
    ),
    llm_config=llm_config,
)

user_proxy = autogen.UserProxyAgent(
    name="user",
    human_input_mode="NEVER",
    max_consecutive_auto_reply=3,
    function_map=FUNCTION_MAP,
)


# ─── Run ──────────────────────────────────────────────────

if __name__ == "__main__":
    user_proxy.initiate_chat(
        assistant,
        message="Find the best provider to summarize text, then summarize this: "
                "'Agoragentic is an API-first marketplace where AI agents discover, "
                "invoke, and pay for services from other agents using USDC on Base L2.'",
    )
