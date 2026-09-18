# Bankr: inspect Agoragentic Interchange

A no-spend client of the existing Interchange public contract. This is an installable Bankr **instruction skill** plus a separately runnable dependency-free Node inspector, not a wallet integration, marketplace launch, paid relay, or new package release. It extends the existing Interchange builder package; it does not promote a new framework integration in the root catalog before Bankr-host qualification.

## Test in Bankr this week

Open this folder on the PR branch. Copy its public GitHub folder URL and tell your Bankr agent:

> Install the skill at [paste this folder's public GitHub URL]. Then use agoragentic-interchange-inspector to inspect the public Interchange availability. Do not spend, sign, trade, launch tokens, create accounts, or invoke providers. Distinguish current observations from cached documents.

The installable root is **this folder**, containing [SKILL.md](SKILL.md), not the repository root. Before merging, use the PR branch URL rather than a main-branch URL that does not yet contain the skill. After merging, use the merged revision. Review updates before reinstalling.

Bankr documents installing SKILL.md and reference documents from a public folder: [install guide](https://docs.bankr.bot/skills/in-bankr/from-github/) and [format reference](https://docs.bankr.bot/skills/in-bankr/skill-format/). This code follows that format; actual installation and execution inside a Bankr account remain an external qualification step. No Bankr account was accessed to write it. No Agoragentic credentials are required. Bankr account/model usage may have its own charges.

Start with [five evaluation prompts](references/evaluation.md). The inspector does not have access to private receipts unless the user supplies an appropriate public receipt ID. It cannot promise that a particular production receipt is public or valid.

## Node inspector (independent of the Bankr host)

Node 20+; no npm install and no API keys.

```sh
node interchange/bankr/inspect.mjs plan
node --test test/bankr-interchange.test.mjs
node interchange/bankr/inspect.mjs status --live
node interchange/bankr/inspect.mjs verify-id areceipt2_demo_missing_read_only --live
```

`plan` and tests are offline. `status --live` makes at most two fixed public GET requests. `verify-id ... --live` sends one read-only POST to the existing receipt verifier. The missing-ID command is a **negative demonstration**, never a successful cryptographic verification.

The helper rejects URL overrides, unknown operations, credentials, redirects, oversized responses, unsupported schemas, payment challenges and automatic retries. Its ten-second deadline includes body reads. It projects known fields instead of forwarding remote instructions. It never loads a wallet SDK, reads secret environment variables, uploads user files or mutates production. The skill alone cannot constrain other tools in a Bankr session: use real host access controls.

Exit 0 means the requested observation completed; for `status` it additionally requires the expected no-money profile and recent HTTP metadata. Exit 2 means stop and inspect the failure or changed/stale profile. **Neither exit status certifies a whole platform, Bankr runtime compatibility, settlement, or task correctness.**

## What to report

Save command output and the exact source revision. Note the host, time, HTTP/cache evidence, prompt, observed result and any failure. Redact account/user details. Do not include credentials, private receipts or usable signatures. The report's no-effect claims describe this helper's request policy, not an independent audit of server internals.

The [former Interchange demo-day guide](../hackathon-2026-09/PRESENTER_GUIDE.md) and [evidence checklist](../hackathon-2026-09/READINESS.md) are archived rehearsal material, not the current Risk-Fork-only submission plan. No new custody, signing, paid execution, token, federation, deployment or production-activation authority is granted.
