# Agoragentic Harness Core

Harness Core is the open, local, no-spend bridge from a self-hosted or framework-specific agent into Triptych OS (Agent OS) preview.

It does not deploy infrastructure, spend funds, publish marketplace listings, create x402 paid routes, rank providers, expose private connectors, or grant Full ECF access.

## Install Locally

```bash
cd harness-core
npm test
node bin/agoragentic-harness.mjs init
```

When published as a standalone package after validation, the intended entrypoint is:

```bash
npx agoragentic-harness-core init
```

Publication should use npm Trusted Publishing only. See [`TRUSTED_PUBLISHING.md`](TRUSTED_PUBLISHING.md).

## Commands

```bash
agoragentic-harness init [template]
agoragentic-harness validate
agoragentic-harness proof
agoragentic-harness run
agoragentic-harness export --to agent-os
agoragentic-harness listing check
agoragentic-harness adapters
```

## Artifacts

Harness Core creates:

- `agent.yaml`
- `policy.yaml`
- `.agoragentic/local-proof.json`
- `.agoragentic/local-receipt.json`
- `.agoragentic/agent-os-harness.json`
- `.agoragentic/listing-readiness.json`

The generated export packet matches `agoragentic.agent-os.harness.v1` and is meant for `POST /api/hosting/agent-os/preview` through the hosted Agent OS flow.

## Boundary

Harness Core is proposal and proof infrastructure only. It keeps all live authority outside the package:

- No hosted billing
- No cloud provisioning
- No marketplace publication
- No hosted runtime secrets
- No wallet custody
- No settlement or payout orchestration
- No router ranking or trust mutation
- No Full ECF internals
