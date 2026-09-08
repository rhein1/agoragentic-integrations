# Changelog

## Unreleased

- Align `x-mcp-header` with the final MCP 2026-07-28 Tools specification by
  permitting only `string`, `integer`, and `boolean` annotations and rejecting
  JSON Schema `number` declarations before the outbound MCP request.
- Validate typed results with JSON Schema 2020-12 by default while preserving
  explicit draft-07 compatibility; add final-spec fixtures for 2020-12 tuple
  semantics and array or primitive MCP `structuredContent` values, and preserve
  local result-schema references after transport-envelope embedding.
- Make the POSIX client-adoption backlog fixture publish its test-only counter
  with an atomic same-directory rename so concurrent polling cannot observe a
  truncate/write intermediate state. Product concurrency limits are unchanged.
- Target the stateless MCP `2026-07-28` wire contract: validate complete-result
  metadata and cache hints, retain only bounded hash evidence for result
  `_meta`, require that evidence in versioned v2 transport results, and return
  typed no-retry errors for unsupported MRTR and Tasks.
- Add an explicit process-local portable-handle registry that binds recognized
  handles to a host-derived principal hash, issuer, audience/origin, allowed
  consuming methods, originating and consuming request hashes, expiry, and
  replay limits. It is not wired into hosted admission and is not durable.
- Reject MCP Apps declarations, UI resources, and active HTML at the local
  relay import boundary by default. A separately qualified renderer, CSP,
  domain policy, and message bridge remain required before enabling Apps.
- Add an MCP 2026-07-28 readiness record that keeps MRTR, Tasks,
  subscriptions, authenticated remote MCP, provider qualification, deployment,
  activation, and live protection explicitly incomplete.

## 0.1.0-alpha.1 — release candidate

- Add default-off, source-only OpenAI Agents JS, LangChain JS, and LangGraph JS
  adapter subpaths. Exact branded host-boundary, plan-source, and executor
  capabilities are required before any enabled invocation.
- Keep deterministic enforcement adjacent to framework tool execution: LOW is
  the only direct-execution path, ELEVATED without a prepared fork is blocked,
  and every actually prepared ELEVATED/HIGH/IRREVERSIBLE call returns an
  authority-free, one-use clean-commit receipt.
- Add offline adversarial tests and packed-consumer verification for framework
  adapters. The demo makes no model, network, provider, effect, or commit call
  and does not claim live protection.
- Reject Array subclasses before canonicalization, and return post-direct-effect
  failures as closed non-retry receipts so framework error middleware cannot
  automatically repeat an ambiguous effect.
- Apply Apache-2.0 to this and future source versions; retain earlier MIT
  revisions under their original terms. Include NOTICE and creator citation.
- Include the README artwork and developer documentation in the package.
- Verify the actual npm tarball in a fresh consumer with offline dependency
  installation and a real local reference lifecycle.
- Add an MCP host adapter example and adversarial protocol tests.
- Add a default-off child-side `mcp_http_phase` runtime with a shared public-DNS,
  socket-pinning, MCP 2026-07-28 Streamable HTTP, bounded JSON/SSE,
  header/body-binding, `x-mcp-header`, closed-transport, and measured-evidence
  contract. It supports only credential-free public HTTPS endpoints, accepts only
  complete no-retry results, and grants no provider activation.
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
