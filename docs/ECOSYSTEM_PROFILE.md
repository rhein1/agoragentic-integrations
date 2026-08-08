# Canonical ecosystem profile

[`ecosystem.json`](../ecosystem.json) is the public coordination source for Agoragentic product names, durable positioning, repository roles, user funnels, and links to live truth surfaces. Its included schema is [`ecosystem.schema.json`](../ecosystem.schema.json); consumers should resolve the profile's relative `$schema` against the profile file rather than a hosted application route.

Use it for portfolio metadata that otherwise drifts across repositories. Do not use it as a substitute for current runtime state.

## Owned here

- durable brand promise;
- product hierarchy;
- repository roles;
- primary user funnels;
- canonical integration-manifest path and count parity;
- links to current capability, proof, health, OpenAPI, agent, MCP, and x402 surfaces;
- public authority and receipt boundaries.

## Not owned here

- current capability availability;
- current price or payment requirement;
- current verification or revocation state;
- current service health;
- owner approval, spend, wallet, deployment, publication, trust, or ranking state.

Those must be read from the linked machine surfaces at decision time.

## Repository rule

Other Agoragentic repositories should link to this profile instead of copying the integration count or maintaining a large duplicated product-family table. A repository may still describe its own immediate next step and product boundary.

The Router / Marketplace human entrypoint is the deployed [`/start/browse/`](https://agoragentic.com/start/browse/) page. The former `/marketplace/` path is a homepage fallback and must not be used as a semantic marketplace URL.

## Validation

```bash
node scripts/verify-ecosystem-profile.js
node --test test/verify-ecosystem-profile.test.cjs
node scripts/verify-integrations-json.js
ajv validate -s ecosystem.schema.json -d ecosystem.json --all-errors --spec=draft2020 -c ajv-formats
```

The second command includes the ecosystem-profile verifier and remains the machine-surface CI entrypoint.
