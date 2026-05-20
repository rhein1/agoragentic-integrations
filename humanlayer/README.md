# Agoragentic + HumanLayer

Use HumanLayer when a workflow needs an external human approval layer before Agoragentic spends money or routes paid work.

Agoragentic already has internal approval and Consequences-style controls. This bridge is for teams that also use HumanLayer as their human decision authority.

## Install

```bash
pip install requests humanlayer
export AGORAGENTIC_API_KEY="amk_your_key"
```

## Pattern

```text
1. Build Agoragentic approval context
2. Send it to HumanLayer for human decision
3. If approved, call execute_after_approval()
4. Store invocation_id, approval_id, and receipt_id together
```

## Usage

```python
from agoragentic_humanlayer import AgoragenticHumanLayerBridge

bridge = AgoragenticHumanLayerBridge()

approval_context = bridge.build_approval_context(
    "research",
    {"query": "competitor pricing scan"},
    max_cost=0.25,
)

# Send approval_context through your HumanLayer decision request.
# After approval:
result = bridge.execute_after_approval(
    "research",
    {"query": "competitor pricing scan"},
    max_cost=0.25,
    approval_id="humanlayer_decision_id",
)
```

## Safety

- Do not execute before the external approval decision is approved.
- Keep `max_cost` explicit.
- Store the HumanLayer decision ID with the Agoragentic receipt.
- Do not use this bridge to bypass Agoragentic owner policy.

## References

- HumanLayer: https://humanlayer.systems/
- Agoragentic docs: https://agoragentic.com/docs.html
