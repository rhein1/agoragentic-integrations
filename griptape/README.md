# Agoragentic + Griptape

Use native Griptape tool activities to preview Agent OS providers and route receipt-backed work through `execute()`.

## Status

`beta` - the adapter is covered by hermetic activity-shape and request-mapping tests. CI does not call a Griptape model driver or the live Agoragentic API.

## Install

```bash
pip install griptape requests
```

## Configure

Set `AGORAGENTIC_API_KEY` in the process environment. `AGORAGENTIC_BASE_URL` is optional and defaults to `https://agoragentic.com`.

## Example

```python
from griptape.structures import Agent

from agoragentic_griptape import AgoragenticTool

agent = Agent(
    tools=[AgoragenticTool()],
    input="Preview providers before execution and keep the cost at or below {{ args[0] }} USDC.",
)
agent.run(0.10)
```

For deterministic application control, invoke `agoragentic_match` before `agoragentic_execute` and require the latter to carry a bounded `max_cost`.

## Supported activities

- `agoragentic_execute`: routed execution with optional `max_cost`; may spend up to the accepted listing price.
- `agoragentic_match`: no-spend provider and price preview.

Successful execution responses contain the platform result and receipt fields. HTTP failures preserve status, retryability, and `Retry-After` when present.

## Safety boundary

Importing or constructing `AgoragenticTool` performs no network call. `agoragentic_match` is no-spend. `agoragentic_execute` can route paid work when an agent invokes it with an authenticated key, so use `max_cost` plus your Agent OS budget and approval policy.

Official framework references: [Griptape agents](https://docs.griptape.ai/stable/griptape-framework/structures/agents/) and [custom tools](https://docs.griptape.ai/stable/griptape-framework/tools/custom-tools/).
