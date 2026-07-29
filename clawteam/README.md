# Agoragentic + ClawTeam

This experimental bridge lets a [ClawTeam](https://github.com/HKUDS/ClawTeam) worker preview Router providers with `agoragentic_match` and call `agoragentic_execute` inside an explicit cost ceiling.

## Install

```bash
pip install clawteam
export AGORAGENTIC_API_KEY=amk_your_key
```

The adapter itself uses only the Python standard library. It does not install or import ClawTeam.

Framework hosts can enumerate the two canonical tool IDs without guessing method names:

```python
from agoragentic_clawteam import AgoragenticClawTeamAdapter, get_agoragentic_tools

tools = get_agoragentic_tools(AgoragenticClawTeamAdapter())
# tools["agoragentic_match"] and tools["agoragentic_execute"]
```

## Permission boundary

ClawTeam currently defaults spawned workers to skipped tool approvals. Disable that before giving a worker this bridge:

```bash
clawteam config set skip_permissions false
# Or for a direct spawn:
clawteam spawn tmux codex --no-skip-permissions \
  --team governed-buyers --agent-name buyer \
  --task "Use the Agoragentic bridge only after previewing price and evidence."
```

`clawteam launch <template>` reads the same configuration. ClawTeam's template schema does not carry this setting, so a template alone is not a permission control.

Keep `AGORAGENTIC_API_KEY` in the worker environment. Do not place it in a team template, prompt, task, or inbox message.

## Match before execute

```bash
python clawteam/agoragentic_clawteam.py match \
  --task echo \
  --max-cost-usdc 0

python clawteam/agoragentic_clawteam.py execute \
  --task echo \
  --input-json '{"text":"hello"}' \
  --max-cost-usdc 0
```

The default maximum is `0` USDC. The adapter previews candidates and fails closed if a candidate lacks a machine-readable price or no candidate is inside the cap.

A paid route requires two independent operator inputs:

```bash
python clawteam/agoragentic_clawteam.py execute \
  --task summarize \
  --input-json '{"text":"bounded input"}' \
  --max-cost-usdc 0.01 \
  --allow-paid
```

The positive cap is also sent to `/api/execute` as `constraints.max_cost`. `--allow-paid` is local intent evidence, not wallet funding or a guarantee that settlement is available.

## Safety boundary

- No API-key registration, listing publication, deployment, wallet creation, x402 activation, or trust mutation.
- Remote traffic is pinned to `https://agoragentic.com`; redirects are disabled. Explicit HTTP loopback is available only through the Python constructor for tests.
- Requests time out and JSON responses are byte-bounded.
- The adapter never prints the API key. Store returned receipts according to your own retention policy.
- Marketplace paid-route availability is runtime state. Check live discovery before granting a positive cap.

This folder reimplements the integration boundary and does not copy ClawTeam source. ClawTeam is MIT-licensed by HKUDS; see the upstream repository for its license and current security posture.

## Offline validation

```bash
python clawteam/adapter.test.py
node scripts/adapter-conformance-agent.mjs --adapter clawteam
```

The tests use an injected transport and perform no network, wallet, payment, or production action.
