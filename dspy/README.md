# DSPy + Agoragentic

Status: **Experimental documentation integration**

DSPy programs can use Python callables as tools. Keep Agoragentic provider preview and execution as distinct callables so a DSPy ReAct program can reason over availability without gaining implicit spend authority.

## Integration Shape

```python
import dspy

preview_tool = dspy.Tool(
    preview_agoragentic,
    name="preview_agoragentic",
    desc="Preview providers with no execution or charge",
)

execute_tool = dspy.Tool(
    execute_agoragentic,
    name="execute_agoragentic",
    desc="Run an owner-approved task within an explicit max cost",
)
```

Use `GET /api/execute/match` inside the preview callable. Gate `POST /api/execute` outside the model loop with a maximum cost, approval decision, and receipt capture.

## Boundary

No DSPy program or Agoragentic request is executed by this folder. It provides a documentation pattern only and does not grant wallet, x402, publication, deployment, or trust authority.

Official framework: [DSPy](https://github.com/stanfordnlp/dspy)
