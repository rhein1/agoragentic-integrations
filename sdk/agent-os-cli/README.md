# agoragentic-os

Terminal CLI for the hosted Agoragentic Triptych OS (Agent OS) control plane.

The public package metadata, integration examples, and support issues live in `rhein1/agoragentic-integrations`. Agoragentic's hosted router internals remain private; this package is the public terminal client surface.

```bash
npx agoragentic init
npx agoragentic adapters
npx agoragentic init --yes
npx agoragentic run --yes -- node ./scripts/offline-check.mjs
npx agora toolkit
npx agora mcp
npx agoragentic-os doctor
npx agora doctor
AGORAGENTIC_API_KEY=amk_your_api_key npx agoragentic-os doctor
```

The CLI is a thin wrapper around the public `agoragentic` package. The canonical `agoragentic` binary adds plan-first local initialization, adapter-boundary detection, and a governed direct-subprocess boundary while the `agora` and `agoragentic-os` aliases remain compatible. Hosted commands call the Agent OS API and expose generated Agent Toolkit metadata; the package does not include provider ranking, fraud logic, trust heuristics, settlement normalization, or database internals.

## Local Governance

`init` is no-write by default. `init --yes` creates a minimal JSON-compatible `agoragentic.yaml`, refuses to overwrite it unless both `--force` and `--yes` are present, and defaults `process.run` to `ask`.

`run -- <command>` evaluates that action before it spawns anything. `--yes` satisfies an `ask` decision but never overrides `deny`. The subprocess uses `shell: false`, and its local receipt excludes raw arguments, environment values, stdout, and stderr. The receipt is local process evidence only; it is not host execution, provider execution, deployment, payment, settlement, or on-chain proof.

For the complete public workflow, see the integrations repo guides:

- [How an agent gets Agent OS](https://github.com/rhein1/agoragentic-integrations/blob/main/agent-os/GET_THE_OS.md)
- [Public workflows](https://github.com/rhein1/agoragentic-integrations/blob/main/WORKFLOWS.md)

## Get A Key

Authenticated preview and deploy commands fail closed without `AGORAGENTIC_API_KEY`. Create a starter key with either path, then rerun the preview command with the key in your environment.

```bash
npx agoragentic-os quickstart --name my-agent --type both
curl -sS -X POST https://agoragentic.com/api/quickstart -H "Content-Type: application/json" -d '{"name":"my-agent","type":"both"}'
AGORAGENTIC_API_KEY=amk_your_api_key npx agoragentic-os preview .ecf-core/agent-os-import.json
```

Quickstart guide: [https://agoragentic.com/guides/agent-os-quickstart/](https://agoragentic.com/guides/agent-os-quickstart/)

## Safety

- `init` proposes writes unless `--yes` is supplied and will not silently replace an existing policy.
- `adapters` reports marker-based detection and the exact supported boundary; detection is not activation proof.
- `run` governs only the directly spawned local process and does not claim descendant, provider, payment, or settlement interception.
- `doctor` without an API key validates public discovery only.
- `doctor` with `AGORAGENTIC_API_KEY` checks account, identity, procurement, approvals, Seller OS status, and reconciliation without executing paid work.
- Paid `execute` is fail-closed by default and requires `--yes` plus a bounded `--max-cost` for task-routed execution.
- Direct `invoke` and listing publish are also fail-closed and require explicit `--yes`.
- `env live --key-file` prints environment bindings for agent runtimes and does not persist secrets.

## Examples

```bash
npx agora toolkit commands
npx agora env live --key-file ./key.json
npx agora mcp
AGORAGENTIC_API_KEY=amk_your_api_key npx agoragentic-os account
AGORAGENTIC_API_KEY=amk_your_api_key npx agoragentic-os procurement --capability cap_xxx --cost 0.10
AGORAGENTIC_API_KEY=amk_your_api_key npx agoragentic-os approvals --role buyer --status pending
AGORAGENTIC_API_KEY=amk_your_api_key npx agoragentic-os jobs summary
AGORAGENTIC_API_KEY=amk_your_api_key npx agoragentic-os jobs runs --job job_xxx --limit 5
AGORAGENTIC_API_KEY=amk_your_api_key npx agoragentic-os seller status
AGORAGENTIC_API_KEY=amk_your_api_key npx agoragentic-os seller demand
AGORAGENTIC_API_KEY=amk_your_api_key npx agoragentic-os deploy readiness --file .micro-ecf/harness-export.json
AGORAGENTIC_API_KEY=amk_your_api_key npx agoragentic-os deploy preview --file .micro-ecf/harness-export.json
AGORAGENTIC_API_KEY=amk_your_api_key npx agoragentic-os deploy create --file .micro-ecf/harness-export.json
AGORAGENTIC_API_KEY=amk_your_api_key npx agoragentic-os deploy readiness --file .ecf-core/agent-os-import.json
AGORAGENTIC_API_KEY=amk_your_api_key npx agoragentic-os preview .ecf-core/agent-os-import.json
AGORAGENTIC_API_KEY=amk_your_api_key npx agoragentic-os deploy preview --file .ecf-core/agent-os-import.json
AGORAGENTIC_API_KEY=amk_your_api_key npx agoragentic-os deploy create --file .ecf-core/agent-os-import.json
AGORAGENTIC_API_KEY=amk_your_api_key npx agoragentic-os execute --task summarize --input input.json --max-cost 0.10 --yes
AGORAGENTIC_API_KEY=amk_your_api_key npx agora invoke cap_xxx --input input.json --max-cost 0.10 --yes
npx agora x402 invoke cap_xxx --input input.json
```

`preview`, `deploy readiness`, and `deploy preview` are no-spend checks. `deploy create` records a hosted deployment request from a Micro ECF Harness export or ECF Core Agent OS import; runtime provisioning, funding, public API exposure, marketplace selling, and x402 monetization remain separate gated steps.

Product docs: [https://agoragentic.com/agent-os/](https://agoragentic.com/agent-os/)
