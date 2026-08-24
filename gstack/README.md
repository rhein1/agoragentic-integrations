# gstack Harness Bridge

This experimental, source-only bridge converts four **explicitly supplied** local gstack workflow artifacts into bounded Harness Core evidence. It does not search undocumented gstack output directories and does not run gstack.

The reviewed upstream source is [`garrytan/gstack`](https://github.com/garrytan/gstack) at commit `94993f74012782fd94416dd44b8314f6363a13a4`. The upstream README describes planning, review, QA, and release workflow stages. This adapter claims only compatibility with owner-supplied files representing those stages; it does not claim an end-to-end gstack runtime integration or a partnership with gstack.

## One local command

From a source checkout:

```bash
cd gstack
npm install
node cli.mjs \
  --project ./fixtures/project \
  --plan ./fixtures/artifacts/plan.md \
  --review ./fixtures/artifacts/review.md \
  --qa ./fixtures/artifacts/qa.json \
  --release ./fixtures/artifacts/release.md \
  --out ./fixture-evidence
```

`--project` must contain valid Harness Core `agent.yaml` and `policy.yaml` files. Every workflow artifact path is explicit. Markdown, JSON objects, and UTF-8 text are accepted. Each file is capped at 256 KiB and the four-file bundle is capped at 1 MiB.

The command creates a new output directory and writes:

```text
fixture-evidence/.agoragentic/local-proof.json
fixture-evidence/.agoragentic/local-receipt.json
fixture-evidence/.agoragentic/policy-findings.json
fixture-evidence/.agoragentic/listing-readiness.json
fixture-evidence/.agoragentic/agent-os-harness.json
```

The Agent OS export is omitted when any gate blocks. Missing, empty, oversized, non-UTF-8, malformed JSON, symlinked, or instruction-trap-matching artifacts produce `blocked` proof/receipt/readiness artifacts and a nonzero CLI exit. Existing output directories are never overwritten.

## Evidence semantics

The bridge retains, per supplied artifact:

- the caller-assigned workflow stage;
- a project-relative or basename-only reference;
- media type, byte length, and SHA-256;
- bounded shape metadata such as line count or JSON top-level key count;
- Harness trap-scan findings.

It does **not** retain raw workflow content, extract a success claim from the content, or infer that gstack actually ran. A `proposal_ready` listing-readiness artifact means only that the supplied local evidence bundle and Harness project passed these local gates. It still requires owner review and does not publish anything.

## Harness Core compatibility evidence

The canonical Harness Core source is the standalone
[`rhein1/agoragentic-harness-core`](https://github.com/rhein1/agoragentic-harness-core)
repository. This bridge pins published package `0.3.1`. `npm run test:core-compat` installs that exact npm
version into a temporary clean consumer, verifies standalone repository metadata and all four CLI aliases,
then runs the bridge fixture suite against it. The targeted regression keeps the zero-spend,
no-gstack-execution, no-hosted-billing, and no-marketplace-publication boundaries intact.

This is published-package compatibility evidence only. It does not publish Harness Core, execute gstack,
call a provider, deploy a runtime, or grant any hosted authority.

## Authority boundary

The bridge has no tool to:

- execute gstack or a provider;
- call the network;
- deploy a runtime;
- publish a marketplace listing;
- create an x402 route;
- spend, settle, or move funds;
- mutate trust or write memory.

Harness receipts remain clearly labeled local/no-spend receipts. They are not settlement receipts, certifications, endorsements, or proof that a release was deployed.

## Validation

```bash
npm run check
npm test
npm run test:core-compat
```

The deterministic suite covers the complete fixture flow, absent evidence, hostile instruction-like content, malformed JSON, overwrite refusal, raw-content exclusion, the documented CLI command, and a clean-room published Harness Core `0.3.1` compatibility regression. The repository CI executes that regression on Node 20, 22, and 24.

## License

Bridge code uses the repository MIT license. gstack is MIT-licensed upstream; no upstream implementation code is copied here.
