# HyperFrames Receipt Video Workflow

This experimental, public-OSS, source-only workflow turns an explicitly supplied local Agoragentic receipt/evidence fixture into a sanitized timeline, self-contained HTML composition, local MP4, and hash-bound render receipt using [HyperFrames](https://github.com/heygen-com/hyperframes).

The reviewed upstream is pinned to commit `9ec9e3a711531b3d45c30a1e2c3006df97dbe5cb` and npm package `hyperframes@0.7.102`. No upstream implementation code is copied here.

## Status and boundary

This is an **internal/growth workflow**, not a production listing or a hosted rendering service. Its marketplace listing and x402 route remain disabled until separate evidence proves repeatable rendering, artifact delivery, operational support, and owner-approved readiness.

The package exposes no command for external rendering, publication, hosted deployment, provider calls, or spend. Any future use of those authorities requires explicit owner approval and a separately reviewed implementation. Local rendering itself is no-spend and uses only the pinned local HyperFrames CLI, a local browser, and local FFmpeg.

## Source schema

Input must be UTF-8 JSON using `agoragentic.receipt-evidence.video-source.v1`, no larger than 256 KiB, with one to eight `events` and up to twelve hash-only `evidence` references. The deterministic fixture is [`fixtures/receipt-reconciliation.json`](./fixtures/receipt-reconciliation.json).

Only these display fields are accepted:

- top level: `title`, `summary`, and `status`;
- event: `kind`, `label`, `detail`, `status`, and `evidence_ref`;
- evidence: `kind`, `ref`, `sha256`, and `status`.

Everything else is omitted. Secret/credential, raw prompt, raw tool output, private owner context, and private-path patterns are removed or redacted. Instruction-like content in an allowed display field fails closed. Symlinks, malformed JSON, oversized/deep structures, unknown templates, and existing output directories are rejected. Source files are read-only and never mutated.

## Templates

- `what-agoragentic-does`
- `agent-os-deploy-flow`
- `pr-release-explainer`
- `receipt-reconciliation-demo`

## Local commands

Requirements: Node.js 22 or newer, FFmpeg/ffprobe, and an installed Chrome, Chromium, Edge, or chrome-headless-shell binary.

```bash
cd hyperframes
npm install
node cli.mjs prepare \
  --source fixtures/receipt-reconciliation.json \
  --template receipt-reconciliation-demo \
  --out .local/fixture-prepared \
  --created-at 2026-08-08T12:00:00.000Z

node cli.mjs render-local \
  --source fixtures/receipt-reconciliation.json \
  --template receipt-reconciliation-demo \
  --out .local/fixture-render \
  --created-at 2026-08-08T12:00:00.000Z
```

Each command requires a new output directory. `prepare` writes:

```text
sanitized-timeline.json
composition/index.html
local-render-receipt.json
```

`render-local` additionally writes `receipt-video.mp4`. The receipt records the source receipt hash, sanitized timeline hash, scene HTML hash, pinned renderer version/revision, MP4 hash and byte count, render status, and negative authority boundary. It never embeds the raw source receipt.

HyperFrames telemetry, update checks, automatic installation, and skill synchronization are disabled for the render subprocess. The child receives a minimal environment rather than inherited credentials. The generated composition is self-contained: no scripts, remote fonts, media URLs, or other network resources.

This is a process and data-minimization boundary, not an operating-system or network sandbox. Run it in a constrained local account or container when the source or dependency chain is not already trusted.

## Determinism claim

For identical source bytes and template, the sanitized timeline JSON and scene HTML are byte-deterministic and hash-stable. Every produced MP4 is verified as an MP4 container and its exact bytes are hashed into the local render receipt. Cross-host MP4 byte identity is **not** claimed; codec/browser/platform differences can change encoded bytes. HyperFrames documents Docker rendering for that stronger reproducibility mode, but this workflow deliberately exposes no Docker, cloud, or hosted-render authority.

## Validation

```bash
npm run check
npm test
```

The suite compiles all four templates, checks deterministic timeline/HTML hashes, verifies redaction and trap handling, proves failure and success do not mutate source receipts, performs one real local HyperFrames MP4 render, recomputes the output hash, and inspects ffprobe metadata for excluded synthetic secret/private markers.

## License

Agoragentic workflow code uses this repository's MIT license. HyperFrames is Apache-2.0 licensed upstream.
