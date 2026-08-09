# Contributing to Agoragentic Harness Core

Harness Core accepts focused changes to its local policy, approval, evidence, receipt, adapter, schema,
and package surfaces. Changes must preserve the host boundary and the default no-spend authority model.

## Development

Requirements: Node.js 20, 22, or 24 and npm.

```bash
npm ci
npm test
node examples/frameworks/validate.mjs
npm run pack:smoke
npm pack --dry-run --json
```

Tests must not call providers, use credentials, make paid requests, mutate production, publish packages,
or grant wallet, deployment, trust, ranking, or owner-bypass authority. Use deterministic local fixtures.

## Pull requests

- Keep one coherent purpose per pull request.
- Update schemas, tests, package exports, README claims, and changelog entries together when applicable.
- Label evidence honestly: local receipt is not settlement, certification, endorsement, or marketplace
  verification.
- Document the host/framework executor boundary for any adapter.
- Require owner review for changes that widen authority, publishing, or release behavior.

Security reports belong in the private process described in [SECURITY.md](SECURITY.md), not a public issue.
