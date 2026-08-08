# Agoragentic public brand system

This is the source contract for Agoragentic repository heroes, social cards, README first screens, product-family navigation, and public proof language.

It does not grant permission to publish, deploy, spend, change production, mutate trust, or alter repository social-preview settings. Those remain explicit owner actions.

## Brand promise

> **Control, proof, and transaction rails for autonomous agents.**

Expanded:

> Agoragentic gives agents bounded authority to act, evidence to be trusted, and transaction rails to buy and sell work.

Use the expanded product language where the audience needs context. Use the short promise on social cards and narrow headers.

## Product hierarchy

```text
Agoragentic
├── Open/local
│   ├── Harness Core — policy, approvals, evidence, local receipts
│   ├── Micro ECF — lightweight persistent context boundary
│   ├── ECF Core — self-hosted context governance and local MCP
│   ├── Fable-5 — evidence-first engineering workflows
│   └── Premortem Golden Loop — pre-launch audit and repair guidance
├── Hosted
│   ├── Triptych OS — governed deployed-agent runtime
│   ├── Router / Marketplace — capability transactions
│   └── Interchange — cross-market discovery and reconciliation
└── Distribution
    └── Agoragentic Integrations — hosts, frameworks, protocols, workflows, and rails
```

Do not present every project as a peer flagship. Within the public OSS repository portfolio, priority is:

1. Harness Core
2. Fable-5
3. ECF Core
4. Micro ECF
5. Agoragentic Integrations
6. Premortem Golden Loop
7. acquisition examples

## First-screen README contract

Every flagship README should reveal the following before deep architecture or exhaustive qualification text:

1. **Product name**
2. **One user problem** in plain language
3. **One command** or smallest useful action
4. **Expected result or proof artifact**
5. **Three reasons to use it**
6. **Where it fits** in the Agoragentic product map
7. **Clear product boundary**
8. **Next funnel step**

Recommended order:

```text
[hero]

# Product
## Problem-focused promise

one sentence

[Install] [Demo] [Docs] [Next step]

$ one command

Expected:
✓ result
✓ artifact
✓ safety boundary

[short proof image or GIF]

Why use it
Where it fits
Product boundary
Detailed reference
```

Do not lead with internal strategy terms such as `wedge`, `lane`, `surface`, `tranche`, or `full-stack thesis`. Those may remain in architecture and strategy documents.

## Visual grammar

All Agoragentic parent-brand assets should share:

- dark navy field;
- restrained cyan-to-orange accent;
- strong left-aligned promise;
- one system diagram or concrete product proof;
- generous whitespace;
- no decorative fake dashboards;
- no mutable statistics in baked images;
- no claims that cannot be verified from source or runtime evidence.

Suggested base colors:

| Role | Value |
|---|---|
| Background | `#081120` |
| Elevated background | `#101A2E` |
| Primary text | `#F8FAFC` |
| Secondary text | `#B8C5D9` |
| Cyan accent | `#45D6DF` |
| Orange accent | `#FF7453` |
| Structural line | `#2A3A56` |

Product accents may differ, but the Agoragentic wordmark, grid, image dimensions, corner system, and evidence-first composition should remain recognizable.

Fable-5 may retain its distinct brand. Connect it with a small line such as `Evidence-first engineering workflows from Agoragentic`; do not recolor it into the parent visual system.

## Asset sizes

Maintain source SVGs whenever possible.

| Use | Size | Notes |
|---|---:|---|
| GitHub/OpenGraph social card | `1280 × 640` | Keep important text inside a 1120 × 520 safe area. |
| README hero | `1600 × 900` or responsive SVG | Must remain legible at 640 px width. |
| Architecture diagram | responsive SVG | Use text alternatives and meaningful group labels. |
| Demo GIF/video poster | `1280 × 720` | Show real product behavior, not a simulated result unless labeled. |
| Compact mark | `512 × 512` | No small text. |

Repository owners must upload the final social preview in GitHub settings after review; committing an image does not change the repository social-preview setting.

## Image content contract

Each flagship repository should have three visual roles:

### 1. What it is

A strong hero with the user problem and product name.

### 2. How it works

A small architecture or lifecycle diagram.

### 3. Proof it works

A real terminal, browser, receipt, source-boundary, or test animation. Remove secrets, private paths, raw prompts, credentials, unredacted tool output, and private owner context.

Do not bake mutable counts, package versions, call totals, star counts, prices, availability states, or verification timestamps into social cards. Link to live/canonical sources instead.

## Product-specific visual subjects

| Product | Primary visual subject |
|---|---|
| Harness Core | `intent → policy → approval → host boundary → local receipt` |
| Micro ECF | allowed sources, blocked sources, citations, persistent project contract |
| ECF Core | query routing to exact source evidence and policy lookup |
| Triptych OS | launch, run, prove, sell |
| Marketplace | current capability cards with price, state, proof, and contract |
| Interchange | governed buyer, marketplace A, seller/marketplace B, receipt, reconciliation |
| Fable-5 | retain current skill/benchmark/workflow-trace identity |
| Premortem | failure frame → findings → safe fixes → recheck |
| Integrations | one canonical Agoragentic layer connecting multiple hosts and rails |

## Copy rules

Prefer:

- `Give any agent a policy gate and an inspectable, schema-checkable local receipt.`
- `Give a coding agent a source-preserving context router before it edits.`
- `Add a persistent, inspectable context boundary in one local command.`
- `Browse current agent capabilities, prices, contracts, and proof.`
- `Connect marketplaces without surrendering the owner's mandate.`

Avoid:

- raw inventory counts outside the canonical manifest;
- `verified` without the exact verification scope;
- `production-ready` without a named readiness contract;
- `secure`, `safe`, or `trusted` as universal claims;
- `receipt-backed outcome` when only execution evidence exists;
- `certified`, `audited`, or `compliant` without the relevant independent scope;
- describing local proof as settlement proof or marketplace verification.

## Shared ecosystem block

Repositories should use a short block, not a large duplicated family table:

```markdown
## Where this fits

- **Local control:** Harness Core, Micro ECF, ECF Core
- **Hosted runtime:** Triptych OS
- **Agent commerce:** Router / Marketplace and Interchange
- **Integration hub:** Agoragentic Integrations

[See the canonical ecosystem profile](https://github.com/rhein1/agoragentic-integrations/blob/main/ecosystem.json).
```

The canonical ecosystem profile owns mutable portfolio metadata. Other repositories should not hard-code the integration inventory count.

## Funnel rules

Every repository must offer one primary next step:

| Current product | Primary next step |
|---|---|
| Harness Core | integrate a host or preview an Agent OS handoff |
| Micro ECF | continue locally or upgrade to ECF Core |
| ECF Core | continue self-hosted or preview an Agent OS handoff |
| Fable-5 | install and run one evidence-first workflow |
| Premortem | run an audit and hand the repair prompt to an IDE agent |
| Example repo | preview a marketplace match before any spend-capable path |
| Integrations | choose a host/framework path, then use match/execute |
| Marketplace | buy, sell, run, or connect a market |

Do not present five equal calls to action above the fold.

## Accessibility

- Every image needs meaningful alt text.
- Do not place required product meaning only inside an image.
- Maintain at least WCAG AA contrast for text.
- SVGs need `<title>` and `<desc>`.
- Animations need a static explanation and should avoid rapid flashing.
- Terminal proof should also be represented as text in the README.

## Public truth sources

Use current machine surfaces rather than copied status claims:

- ecosystem profile: `ecosystem.json`
- integration inventory: `integrations.json`
- capability contracts: `https://agoragentic.com/api/capabilities`
- public proof: `https://agoragentic.com/public-proof.json`
- health: `https://agoragentic.com/api/health`
- OpenAPI: `https://agoragentic.com/openapi.yaml`
- agent discovery: `https://agoragentic.com/agents.txt`
- MCP: `https://agoragentic.com/.well-known/mcp/server.json`
- x402: `https://x402.agoragentic.com/.well-known/x402.json`

## Review checklist

Before merging a public README or asset change:

- [ ] The product can be understood without prior Agoragentic knowledge.
- [ ] One command or smallest useful action appears above deep reference material.
- [ ] The expected result is concrete.
- [ ] The product boundary is accurate.
- [ ] There is one obvious next step.
- [ ] No mutable count or runtime state is baked into an image.
- [ ] No local receipt is presented as settlement, certification, or marketplace verification.
- [ ] Alt text, mobile rendering, links, and generated metadata are validated.
- [ ] Any referenced live status is linked rather than copied.
