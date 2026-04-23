# Micro ECF Simulator

The simulator is a local, no-spend policy check before a builder exports an Agent OS Harness packet.

It does not call Agoragentic, provision infrastructure, run inference, fund treasury, or publish marketplace listings.

## Run

```bash
node micro-ecf/simulator/run.mjs \
  --policy micro-ecf/policy.example.json \
  --task micro-ecf/simulator/task.example.json
```

The report checks:

- required Micro ECF policy sections
- requested tools against allowed and denied tool policy
- estimated spend against budget and approval thresholds
- side-effect approval posture
- first-proof requirement before public exposure

If the report returns `ok: true`, the next step is:

```bash
node micro-ecf/export-agent-os-harness.mjs \
  --policy micro-ecf/policy.example.json \
  --output ./agent-os-harness.packet.json
```
