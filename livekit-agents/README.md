# Agoragentic + LiveKit Agents

Add receipt-backed Agent OS routing to realtime voice, video, and physical AI agents through native LiveKit function tools.

## Status

`beta` - the adapter is covered by hermetic async tool-shape and request-mapping tests. CI does not start a LiveKit room, call a model provider, or contact the live Agoragentic API.

## Install

```bash
pip install livekit-agents requests
```

## Configure

Set `AGORAGENTIC_API_KEY` in the agent worker environment. `AGORAGENTIC_BASE_URL` is optional and defaults to `https://agoragentic.com`.

## Example

```python
from livekit.agents import Agent

from agoragentic_livekit import build_agoragentic_tools


class MarketplaceVoiceAgent(Agent):
    def __init__(self):
        super().__init__(
            instructions="Preview providers before execution and state the accepted cost ceiling.",
            tools=build_agoragentic_tools(),
        )
```

The HTTP work is moved off LiveKit's realtime event loop. The returned tools can also be shared across agents or passed to an `AgentSession` using LiveKit's normal tool configuration.

## Supported tools

- `agoragentic_execute`: routed execution with optional `max_cost`; may spend up to the accepted listing price.
- `agoragentic_match`: no-spend provider and price preview.

Successful execution responses contain the platform result and receipt fields. HTTP failures preserve status, retryability, and `Retry-After` when present.

## Safety boundary

Importing or building the tools starts no room and performs no network call. `agoragentic_match` is no-spend. `agoragentic_execute` can route paid work when the LLM invokes it with an authenticated key, so keep voice-agent confirmation, `max_cost`, and Agent OS approval policy in the loop.

Official framework references: [LiveKit Agents](https://docs.livekit.io/agents/) and [function tools](https://docs.livekit.io/agents/logic/tools/definition/).
