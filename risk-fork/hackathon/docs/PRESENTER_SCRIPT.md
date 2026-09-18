# Runtime: Risk Fork

> **DEMO ONLY — LOCAL PROTOCOL SIMULATOR — NOT AN ISOLATION BOUNDARY — NO LIVE PROTECTION**

Presentation scope updated September 18, 2026, at the owner's direction. Submit
and present Risk Fork only, using two existing scenarios from its demo engine.
Interchange, Governed Agent, Governed Signals, Flash, Bankr and Dynamic are not
part of this submission. This script changes the presentation sequence; it does
not add a new runtime, Next-button UI, provider integration or live run.

## The show, in one sentence

**Risk Fork shows how risky work can be prepared without handing it the trusted
parent's authority.**

Do not narrate an Interchange-to-Risk-Fork flow. An Interchange policy check,
capability verification sandbox, or signed receipt is not a Risk Fork lifecycle
by itself and is outside this submission.

## What already exists

The [fixture catalog](../src/scenarios.mjs), [demo engine](../src/demo-engine.mjs),
[malicious MCP fixture](../fixtures/malicious-stdio-mcp.mjs), and
[Flight Recorder](../recorder/app.js) are the implementation, not this document.
The source inspected for this revision was integrations commit
`2befa77af316e91797d1aaf933d266d250ee2a48`.

| Main case | Existing scenario | Actual boundary |
| --- | --- | --- |
| Hostile tool interaction | `e2b-malicious-mcp-containment` | Real controller and E2B adapter; injected fake SDK and local malicious stdio subprocess. No real E2B provider allocation or OS-isolation proof. |
| Consequential action | `irreversible-deployment-proposal` | Existing local-reference protocol; IRREVERSIBLE work leaves only as a consequential-action proposal. No deployment or clean commit. |

The first case is explicitly **FAKE E2B — LOCAL CONTRACT SIMULATION — NOT AN
ISOLATION BOUNDARY**. Do not call it a live cloud attack, live MicroVM, or general
prompt-injection detector. The fixture submits eight named adversarial requests;
its modeled denials are not eight confirmed cloud exploits prevented.

## Preparation: run the existing implementation

Use either a clean checkout pinned to the exact approved 40-character commit or
a verified commit-bound offline kit. For a source checkout, require a successful
`Risk Fork Release Candidate` workflow for that exact commit and record the
commit with the rehearsal evidence. For an offline kit, verify its `.sha256` and
`.build.json` as specified by the [release runbook](RELEASE_RUNBOOK.md), then run
`verify-offline-kit`; the manifest's `source_commit` is the source of truth. Use
the [quickstart](QUICKSTART.md) for installation. Do not reinstall dependencies
inside an extracted offline kit. Use a credential-free environment; do not load
production `.env` files, wallet keys, or an E2B key.

For a source checkout, fail closed before rehearsal:

```powershell
$reviewedCommit = 'REPLACE_WITH_APPROVED_40_CHARACTER_COMMIT'
$currentCommit = git rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $reviewedCommit -notmatch '^[0-9a-f]{40}$' -or $currentCommit -ne $reviewedCommit) {
  throw 'Checkout is not pinned to the approved source commit.'
}
$checkoutChanges = @(git status --porcelain)
if ($LASTEXITCODE -ne 0) { throw 'Unable to verify checkout cleanliness.' }
if ($checkoutChanges.Count -ne 0) { throw 'Checkout has unreviewed changes.' }
```

From the repository root, first inspect `doctor` and the plans:

```powershell
node risk-fork/hackathon/bin/risk-fork-demo.mjs doctor
if ($LASTEXITCODE -ne 0) { throw 'Local readiness check failed.' }
node risk-fork/hackathon/bin/risk-fork-demo.mjs plan --scenario e2b-malicious-mcp-containment
if ($LASTEXITCODE -ne 0) { throw 'Malicious-MCP plan failed.' }
node risk-fork/hackathon/bin/risk-fork-demo.mjs plan --scenario irreversible-deployment-proposal
if ($LASTEXITCODE -ne 0) { throw 'Deployment-proposal plan failed.' }
```

Then record both cases and start the existing recorder:

```powershell
node risk-fork/hackathon/bin/risk-fork-demo.mjs run --scenario e2b-malicious-mcp-containment
if ($LASTEXITCODE -ne 0) { throw 'Malicious-MCP run needs investigation. Do not claim success.' }
node risk-fork/hackathon/bin/risk-fork-demo.mjs run --scenario irreversible-deployment-proposal
if ($LASTEXITCODE -ne 0) { throw 'Deployment-proposal run needs investigation. Do not claim success.' }
node risk-fork/hackathon/bin/risk-fork-demo.mjs serve
```

Open the exact token-bearing loopback launch URL printed by `serve`. Keep its
local token private. The recorder loads retained records at startup; it is a
**REPLAY**, not a newly executing provider session. Match the scenario and run ID
with the output of the two commands above; do not silently select an older good
run after a new failure. Restart the recorder after recording a new run.

The existing ten-run quota includes earlier runs. If exhausted, preserve needed
evidence and follow [owned-root cleanup instructions](CLEANUP_TROUBLESHOOTING.md).
Do not delete other workspaces or modify the quota to make a rehearsal pass.

## Case 1 — The tool wants more than the task

Opening narration:

> "Connecting a useful tool also exposes an agent to somebody else's code and
> instructions. This tool asks for parent-only information, tries to change the
> parent's workspace, and claims permission it was never given. The question is
> not whether the tool says it is safe. It is what the risky worker can actually
> carry back to the trusted agent."

State the execution scope once, before showing the result:

> "The Risk Fork controller and malicious MCP subprocess run locally. The E2B
> API is simulated in this reproducible test; I am not claiming live cloud
> containment."

Follow one order through the existing recorder, opening detailed evidence only
when needed. Do not turn the eight attack rows into eight scenario buttons.

| Beat | Point to | What to say |
| --- | --- | --- |
| 1. Classify before the risky interaction | HIGH, `BLOCK_DIRECT_ROUTE_TO_RISK_FORK`, `before_remote_connect` in the plan | "The host chooses the boundary. The tool cannot declare itself safe." |
| 2. Preserve the parent | Parent-before hash and Savepoint Capsule hash | "We retain bounded state references, not a copy of the owner's credentials or permission." |
| 3. Show three concrete attempts | `read_parent_only_credential_path`, `mutate_parent_workspace`, `smuggle_authority_shaped_fields` and their actual recorded outcomes | "It asks for a parent-only canary, a parent write, and forged approval. Read the recorded result for each; none is a real customer secret." |
| 4. Show controlled return | TAINTED evidence, accepted typed result, raw-narrative inclusion fields | "A bounded result may be accepted. The hostile conversation and its claimed authority do not become parent memory or policy." |
| 5. Show cleanup and state | Destruction request, separate absence observation, parent-after hash | "A kill request and an absence observation are different facts. Here both are evaluated against the local provider model." |
| 6. End on the outcome | Validated result, unchanged parent comparison, `prepared_not_committed`, no external commit | "The useful artifact is prepared. The trusted parent is unchanged in the recorded comparison. The child has not gained authority to act for the owner." |

Also retain the full table of eight synthetic attempts for technical questions:
tool-description injection, policy bypass, parent environment, parent-only
credential path, parent workspace mutation, external-network request, raw
narrative import, and authority-shaped fields. Parent hashes cover the modeled
state; they do not prove the absence of every possible machine effect. A typed
JSON result alone is not a guarantee of semantic safety.

**Takeaway: "Risky work gets a separate place to run, not a copy of your authority."**

## Case 2 — A useful proposal is not permission to deploy

Transition:

> "Malicious tools are one reason for Risk Fork. Ordinary useful work is another.
> A trusted helper can still propose a consequential action. Now the requested
> operation is a deployment. Preparing it must not mean publishing it."

Use `irreversible-deployment-proposal`, not a newly invented money-transfer
fixture. The existing fixture binds a synthetic release, target, provider and
arguments, with commit type `CONSEQUENTIAL_ACTION_PROPOSAL`.

| Beat | Point to | What to say |
| --- | --- | --- |
| 1. Identify the consequence | IRREVERSIBLE classification and deployment reason | "Trusting the helper does not make deploying its result a read-only action." |
| 2. Prepare under the boundary | Savepoint/fork lifecycle and constrained candidate | "The child prepares a proposal; it does not receive a deploy credential." |
| 3. Validate the permitted return | Proposal type and binding evidence | "Only the allowed proposal crosses back. It is not a token granting execution." |
| 4. Verify cleanup separately | Recorded request, absence and cleanup status | "Preparation is not complete merely because a worker says it finished." |
| 5. Stop before the real effect | `prepared_not_committed` and `clean_commit_performed: false` | "Nothing was deployed. A separate clean-side authorization would be needed to perform the action." |

**Takeaway: "Ready to review is not authorized to deploy."**

Do not animate a production release or say an authorized deployment completed.
The current demo deliberately has no clean commit. For a technical question about
actual bounded file work, `high-filesystem-write` already writes a synthetic file
inside the local-reference copy. For a question about stale authority,
`stale-governance-binding` is an existing negative fixture. These are optional
rehearsal/Q&A checks, not more chapters or a new product to build before the show.

## Presenter acceptance and stop conditions

Before the event, rehearse both commands on the actual laptop and inspect the
current retained evidence. This document does not record a fresh successful run.
Keep the simulation banner and replay label visible. Never infer success from
an exit code or screenshot alone: inspect the scenario, decision, validation,
cleanup and receipt binding in the same run. A missing artifact, recorder failure,
unknown cleanup or contradictory result is a hold, not an invitation to repair
the JSON or borrow a previous run's outcome.

Do not set `RISK_FORK_DEMO_E2B_ENABLED`, supply credentials, contact live MCP
servers, weaken the source gate, or replace fake-provider flags with live claims.
Actual E2B qualification remains a separate task under the
[live-canary plan](E2B_LIVE_CANARY_PLAN.json); this show does not authorize it.
The word "fork" does not mean an external payment, disclosure or deployment can
be undone afterward. Consequential authority stays on the clean side.

## Submission scope

The current owner direction is a Risk-Fork-only submission. Do not include or
claim Bankr, Dynamic, Interchange, Flash, Governed Agent or Governed Signals in
the submitted demo or narration. Their presence elsewhere in the repository is
not submission evidence. If the owner changes the plan later, update and review
the submission artifacts explicitly; do not widen this script by inference.
