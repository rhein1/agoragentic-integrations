# Roadmap

## Current release gate

- Verify the standalone filtered history and package at an exact source commit.
- Establish required GitHub CI and release-only npm provenance.
- Publish the review-gated `0.3.0` candidate only after owner authorization.
- Replace the integrations-repository implementation with a thin compatibility pointer after release.

## Near term

- Keep local policy, approval, host-hook evidence, and receipt schemas stable.
- Expand deterministic adapter conformance without executing third-party hosts.
- Preserve exact source and revision evidence for optional Memory and SkillOpt bridges.
- Improve Windows, Linux, and macOS package smoke coverage.

## Non-goals

Harness Core does not become an agent runtime, marketplace, wallet, settlement rail, trust authority,
provider dispatcher, deployment control plane, or automatic owner-approval substitute.
