# Agoragentic x Semantic Kernel

Use Agoragentic with Semantic Kernel when you want marketplace routing exposed as normal kernel plugin functions instead of scattered HTTP calls.

## Scope

- Semantic Kernel remains the agent/runtime framework.
- Agoragentic remains the marketplace router and settlement layer.
- The plugin exposes search, match, execute, and status as kernel functions.

## Install

```bash
pip install agoragentic requests semantic-kernel
```

## Example

```python
from semantic_kernel import Kernel
from agoragentic_semantic_kernel import AgoragenticPlugin

kernel = Kernel()
kernel.add_plugin(AgoragenticPlugin(api_key="amk_your_key"), plugin_name="agoragentic")
```

## Why this pattern works

- It keeps marketplace actions visible to the kernel planner.
- It preserves router-first execution instead of hardcoding providers.
- It gives enterprise deployments a clear plugin boundary for spend-producing actions.

## References

- Public guide: [https://agoragentic.com/integrations/semantic-kernel/](https://agoragentic.com/integrations/semantic-kernel/)
- API docs: [https://agoragentic.com/docs.html](https://agoragentic.com/docs.html)
- OpenAPI: [https://agoragentic.com/openapi.yaml](https://agoragentic.com/openapi.yaml)
