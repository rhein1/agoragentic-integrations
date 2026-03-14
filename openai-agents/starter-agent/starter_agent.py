"""
Agoragentic Starter Agent for the OpenAI Agents SDK.

This example keeps the core loop simple:
1. Search vault memory before acting.
2. Use execute() for routed work.
3. Inspect the learning queue when seller feedback matters.
4. Save durable lessons back into memory.
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any, Dict

from agents import Agent, Runner, function_tool
from agoragentic import Agoragentic

AGORAGENTIC_BASE_URL = os.environ.get("AGORAGENTIC_BASE_URL", "https://agoragentic.com")
AGORAGENTIC_API_KEY = os.environ.get("AGORAGENTIC_API_KEY", "")

client = Agoragentic(api_key=AGORAGENTIC_API_KEY, base_url=AGORAGENTIC_BASE_URL)


def _json(data: Any) -> str:
    return json.dumps(data, indent=2, ensure_ascii=True)


@function_tool
def agoragentic_memory_search(query: str, namespace: str = "learning", limit: int = 5) -> str:
    """Search your vault memory before executing a new task or repeating a past fix."""
    return _json(client.memory_search(query, namespace=namespace, limit=limit, include_values=True))


@function_tool
def agoragentic_execute(task: str, input_json: str = "{}", max_cost: float = 1.0) -> str:
    """Route a task through Agoragentic's execute() API."""
    payload: Dict[str, Any] = json.loads(input_json or "{}")
    return _json(client.execute(task, payload, max_cost=max_cost))


@function_tool
def agoragentic_learning_queue(limit: int = 5) -> str:
    """Get the seller learning queue built from reviews, incidents, and open flags."""
    return _json(client.learning_queue(limit=limit))


@function_tool
def agoragentic_save_learning_note(
    title: str,
    lesson: str,
    source_type: str = "manual",
    source_id: str = "",
) -> str:
    """Save a durable lesson into the `learning` namespace of vault memory."""
    return _json(
        client.save_learning_note(
            title,
            lesson,
            source_type=source_type or None,
            source_id=source_id or None,
        )
    )


agent = Agent(
    name="agoragentic-starter-agent",
    instructions=(
        "You are an autonomous agent running on top of Agoragentic. "
        "Before paying for work, search vault memory for relevant prior context or lessons. "
        "Use agoragentic_execute for external marketplace work. "
        "If the task mentions seller feedback, failures, disputes, or improvements, inspect the learning queue. "
        "When you identify a reusable insight, save it with agoragentic_save_learning_note so it becomes durable memory."
    ),
    tools=[
        agoragentic_memory_search,
        agoragentic_execute,
        agoragentic_learning_queue,
        agoragentic_save_learning_note,
    ],
)


async def main() -> None:
    prompt = " ".join(sys.argv[1:]).strip() or (
        "Search my learning memory for prior seller lessons, then check my learning queue and tell me the highest-value lesson to save next."
    )
    result = await Runner.run(agent, input=prompt)
    print(result.final_output)


if __name__ == "__main__":
    import asyncio

    asyncio.run(main())
