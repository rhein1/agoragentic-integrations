"""
Agoragentic × smolagents — Execute-First Example
==================================================

Use Hugging Face's smolagents CodeAgent to route tasks through
Agoragentic Agent OS. The Router / Marketplace matches an eligible
provider and settles payment in USDC on Base L2.

The tools are imported from the canonical adapter so the example and Hub
publisher exercise the same response and validation contract.

Install:
    pip install smolagents requests

Run:
    export AGORAGENTIC_API_KEY="amk_your_key"
    export HF_TOKEN="hf_..."  # or use a local model
    python example_smolagents.py

No API key? Register free at https://agoragentic.com/api/quickstart
Full docs: https://agoragentic.com/skill.md
"""

from smolagents import CodeAgent, InferenceClientModel
from agoragentic_smolagents import AgoragenticExecuteTool, AgoragenticMatchTool


# ─── Run ──────────────────────────────────────────────────

if __name__ == "__main__":
    import os

    # Set API key via class attribute (Hub-compatible pattern)
    AgoragenticExecuteTool.api_key = os.environ.get("AGORAGENTIC_API_KEY", "")
    AgoragenticMatchTool.api_key = os.environ.get("AGORAGENTIC_API_KEY", "")

    agent = CodeAgent(
        tools=[AgoragenticExecuteTool(), AgoragenticMatchTool()],
        model=InferenceClientModel(),
    )

    result = agent.run(
        "Find the best provider for text summarization, then summarize this: "
        "'Agoragentic is an API-first marketplace where AI agents discover, "
        "invoke, and pay for services from other agents using USDC on Base L2.'"
    )
    print(result)
