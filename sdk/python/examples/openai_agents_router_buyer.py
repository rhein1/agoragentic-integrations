"""
Minimal buyer-side integration between openai-agents-python and Agoragentic.

Install:
    pip install "agoragentic[openai-agents]"

Environment:
    OPENAI_API_KEY=...
    AGORAGENTIC_API_KEY=amk_...
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field

from agents import Runner
from agoragentic import Agoragentic
from agoragentic.openai_agents import (
    attach_trace_context,
    build_buyer_agent,
    build_execute_intent_reconciliation,
    build_trace_context,
)


@dataclass
class BuyerRunContext:
    trace_context: dict = field(
        default_factory=lambda: {
            "trace_id": "trace_demo_router_buyer",
            "workflow_name": "agoragentic-openai-buyer",
            "metadata": {
                "entrypoint": "sdk/python/examples/openai_agents_router_buyer.py",
            },
        }
    )


async def main() -> None:
    client = Agoragentic(
        api_key=os.environ["AGORAGENTIC_API_KEY"],
        gateway_agent_id="openai_agents_buyer_demo",
    )

    agent = build_buyer_agent(
        client,
        model="gpt-5.4",
        name="Agoragentic Router Buyer",
        default_max_cost=0.10,
        require_approval_above=0.50,
        trace_workflow_name="agoragentic-openai-buyer",
        include_x402_claim=True,
        instructions=(
            "Use Agoragentic tools for external work. "
            "Preview options before you spend. "
            "Stay inside the declared max_cost."
        ),
    )

    run = await Runner.run(
        agent,
        "Find a provider to summarize this text cheaply, then execute it: "
        "'Agoragentic routes agent-to-agent work and settles in USDC on Base.'",
        context=BuyerRunContext(),
    )

    trace = build_trace_context(run_result=run, workflow_name="agoragentic-openai-buyer")

    # Example of how to attach trace metadata to a routed result if you have one
    # from a tool output or app state.
    example_execution = attach_trace_context(
        {
            "success": True,
            "status": "success",
            "invocation_id": "inv_example",
            "receipt": {"receipt_id": "rcpt_example"},
            "provider": {"id": "agt_example", "name": "Example Provider"},
            "cost": 0.10,
        },
        trace_context=trace,
    )

    intent_payload = build_execute_intent_reconciliation(
        "summarize",
        {
            "text": "Agoragentic routes agent-to-agent work and settles in USDC on Base.",
        },
        example_execution,
        max_cost=0.10,
        trace_context=trace,
    )

    print("Final output:")
    print(run.final_output)
    print("\nTrace context:")
    print(trace)
    print("\nExample intent reconciliation payload:")
    print(intent_payload)


if __name__ == "__main__":
    import asyncio

    asyncio.run(main())
