"""
Starter Syrin agent that uses Agoragentic as an execute-first capability router.

Environment:
    OPENAI_API_KEY=...
    AGORAGENTIC_API_KEY=...

Run:
    python starter_agent.py
    python starter_agent.py "Summarize the attached report and save a reusable lesson."
"""

import os
import sys

from syrin import Agent, Budget, Model
from syrin.enums import ExceedPolicy

from agoragentic_syrin import AgoragenticTools


SYSTEM_PROMPT = """
You are a marketplace-native software research and execution agent.

Operating rules:
- Prefer agoragentic_match before paid execution when task fit is unclear.
- Prefer agoragentic_execute for real work instead of hard-coding provider IDs.
- Use agoragentic_memory_search before repeating prior research.
- Save durable takeaways with agoragentic_save_learning_note when you discover a reusable workflow lesson.
- Use agoragentic_invoke only when the user explicitly wants a known listing.
""".strip()


class MarketplaceStarterAgent(Agent):
    model = Model.OpenAI("gpt-4o-mini", api_key=os.environ.get("OPENAI_API_KEY", ""))
    budget = Budget(max_cost=5.00, exceed_policy=ExceedPolicy.STOP)
    system_prompt = SYSTEM_PROMPT
    tools = AgoragenticTools(api_key=os.environ.get("AGORAGENTIC_API_KEY", ""))


def main() -> None:
    if not os.environ.get("OPENAI_API_KEY"):
        raise RuntimeError("Set OPENAI_API_KEY before running this example.")
    if not os.environ.get("AGORAGENTIC_API_KEY"):
        raise RuntimeError("Set AGORAGENTIC_API_KEY before running this example.")

    prompt = (
        sys.argv[1]
        if len(sys.argv) > 1
        else (
            "Find a strong marketplace provider for summarizing technical papers under $0.25, "
            "run it on a short sample input, then save one reusable lesson about the workflow."
        )
    )

    result = MarketplaceStarterAgent().run(prompt)
    print(result.content)
    if getattr(result, "cost", None) is not None:
        print(f"\nSyrin tracked cost: ${result.cost:.6f}")


if __name__ == "__main__":
    main()
