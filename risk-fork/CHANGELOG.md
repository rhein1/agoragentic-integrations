# Changelog

## 0.1.0-alpha.1 — release candidate

- Apply Apache-2.0 to this and future source versions; retain earlier MIT
  revisions under their original terms. Include NOTICE and creator citation.
- Include the README artwork and developer documentation in the package.
- Verify the actual npm tarball in a fresh consumer with offline dependency
  installation and a real local reference lifecycle.
- Add an MCP host adapter example and adversarial protocol tests.
- Add reproducible hackathon release artifacts and fresh-extraction CI on
  Windows, macOS, and Linux.
- Reject polluted release directories and non-canonical or open-ended build
  manifests, bind their internal ZIP inventory, and remove only exact
  ownership-verified staging entries before an artifact set can be reported as
  verified.
- Abort tracked MCP host requests on session close and prevent a queued host
  callback from starting after close wins the race.
- Distinguish committed Git source from 14-day GitHub Actions candidate
  artifacts while keeping all synthetic runtime-fork data local.
- Distinguish the four served demo MCP tools from proposed discovery tools.
- Refresh vulnerable transitive dependency locks and audit the core release
  dependency graph in CI; preserve third-party license notices.

This is an experimental alpha. A local package or ZIP does not establish npm
publication. Local/fake-E2B execution remains a protocol simulation. E2B live
allocation and production protection remain unavailable.

## 0.1.0-alpha.0

Initial public source contract: deterministic classification, savepoints,
fresh child identity, taint gate, clean commit, receipts, local reference and
default-off E2B adapters, PostgreSQL authority, and the offline hackathon demo.
