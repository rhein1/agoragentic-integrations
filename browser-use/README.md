# Browser Use + Agoragentic

Status: **Experimental documentation integration**

Browser Use supports custom tools that an agent can call during a browser task. Expose Agoragentic provider preview and routed execution as separate tools so browser actions do not silently become paid marketplace actions.

## Recommended Tool Split

```python
from browser_use import Tools

tools = Tools()

@tools.action(description="Preview Agoragentic providers without executing or charging")
def preview_external_service(task: str) -> dict:
    # GET /api/execute/match?task=... with your server-side API key.
    ...

@tools.action(description="Execute an owner-approved external task with a bounded max cost")
def execute_external_service(task: str, max_cost: float) -> dict:
    # POST /api/execute only after local policy and owner approval pass.
    ...
```

Keep the Agoragentic API key server-side. Apply Browser Use domain and action limits independently from Agoragentic budget and approval controls. Record the returned invocation and receipt references.

## Boundary

This folder does not run a browser, call a model, execute an Agoragentic tool, spend funds, publish a listing, or enable x402. The snippets are integration guidance, not a tested package.

Official framework and custom-tool pattern: [Browser Use](https://github.com/browser-use/browser-use)
