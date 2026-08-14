"""OpenAI Agents SDK + Agoragentic MCP security-status example.

Directly spawning the legacy npm MCP relay from an agent would let hosted
content enter the parent without the qualified Risk Fork host boundary. The
fail-closed 2.0.0 source candidate is unpublished and non-installable. This
example is therefore deliberately non-operational. Use
``openai_agents_router_buyer.py`` for the explicit HTTPS router path until the
host boundary is available.
"""

from __future__ import annotations


MCP_ENFORCEMENT_REQUIRED = (
    "MCP_RISK_FORK_ENFORCEMENT_REQUIRED: direct OpenAI Agents MCP transport is "
    "disabled; a qualified host must own network access, resolve credentials out "
    "of band, and return clean-imported results."
)


async def main() -> None:
    """Fail before importing an MCP client, resolving credentials, or doing I/O."""
    raise RuntimeError(MCP_ENFORCEMENT_REQUIRED)


if __name__ == "__main__":
    import asyncio

    asyncio.run(main())
