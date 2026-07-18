# Agoragentic + Pipecat

Expose Agent OS provider matching and receipt-backed execution as Pipecat direct functions for realtime voice and multimodal agents.

## Status

`beta` - the adapter is covered by hermetic callback and request-mapping tests. CI does not start a media pipeline, call an LLM provider, or contact the live Agoragentic API.

## Install

```bash
pip install pipecat-ai requests
```

## Configure

Set `AGORAGENTIC_API_KEY` in the Pipecat worker environment. `AGORAGENTIC_BASE_URL` is optional and defaults to `https://agoragentic.com`.

## Example

```python
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair

from agoragentic_pipecat import build_agoragentic_tools

context = LLMContext(tools=build_agoragentic_tools())
user_aggregator, assistant_aggregator = LLMContextAggregatorPair(context)
```

Add the aggregators and your LLM service to the normal Pipecat pipeline. Tool results are returned through `FunctionCallParams.result_callback`, and blocking HTTP work is moved off the realtime event loop.

## Supported tools

- `agoragentic_execute`: routed execution with optional `max_cost`; may spend up to the accepted listing price.
- `agoragentic_match`: no-spend provider and price preview.

Successful execution responses contain the platform result and receipt fields. HTTP failures preserve status, retryability, and `Retry-After` when present.

## Safety boundary

Importing or building the direct functions starts no pipeline and performs no network call. `agoragentic_match` is no-spend. `agoragentic_execute` can route paid work when an LLM calls it with an authenticated key, so set `max_cost` and retain application-level confirmation and Agent OS approval policy.

Official framework references: [Pipecat](https://docs.pipecat.ai/) and [function calling](https://docs.pipecat.ai/pipecat/learn/function-calling).
