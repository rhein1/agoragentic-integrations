# Runtime / Dynamic requirements and evidence

Research date: 2026-09-13. No registration or submission has been made.

## User-supplied Dynamic track text

> Build: An agent that makes a meaningful decision, then pays, transacts or acts for a user. Ideas include API buyers, autonomous bots, delegated assistants and agent-owned products.
>
> Requirements: Use a documented Dynamic wallet pattern and SDK or API to power a working wallet or payment action by the agent.

Source: owner pasted the track text in the project conversation on 2026-09-13. https://runtime.nyc/tracks/dynamic returns a JavaScript shell through this session's web reader, so the wording above is owner-supplied, not independently re-extracted.

## Independently checked official event page

https://luma.com/47rsvjir identifies Runtime as a Bankr-hosted event, lists Dynamic and Definitive Flash as track sponsors, offers in-person and online registrations requiring approval, and labels a demo-night ticket September 19. It does **not** establish an exact submission deadline, judging rubric, slide/video length, repository visibility rule, pre-existing-code rule, or testnet acceptance. Do not borrow rules from unrelated hackathons.

## Acceptance mapping

| Criterion | Entry implementation | Current evidence / gate |
|---|---|---|
| Meaningful decision | Goal-sensitive utility planner selects adequate information at lowest cost; can select a free source or refuse | Dependency-free tests executed; deterministic planner, no LLM claim |
| Acts for a user | Prepared source-selection proposal; separate exact-action owner approval | Working local prototype; data/services are synthetic |
| Documented Dynamic pattern | Developer-owned Server Wallet; pinned SDK sample API, no provider-managed relabel | Source inspected; actual package install/native behavior still unverified |
| Working wallet/payment action | One Base Sepolia native-token transfer; verify recipient/value/signature/receipt before report release | Runner implemented, injected SDK/RPC tests only; live action remains unperformed |
| Risk Fork integration | Existing local-reference savepoint/child/taint/cleanup lifecycle | All three actual-reference tests passed in hosted Risk Fork run 34779683264 at source 9603f222; no production isolation claim |
| Live demo URL | Static rehearsal supports ordinary HTTPS hosting; local server supports real reference lifecycle | No public deployment; connected Netlify account has no projects, and creating one requires owner confirmation |
| Presentation | HTML deck, presenter guide and downloadable PDF delivery | Author-created deliverables, not verified organizer requirements |

## Exact Dynamic sources and API-version caveat

- https://www.dynamic.xyz/docs/node/wallets/server-wallets/overview — developer-owned backend wallet; MPC native addons require supported Linux/macOS Node; backend storage obligations.
- https://www.dynamic.xyz/docs/node/wallets/server-wallets/viem-wallet-client — getWalletClient, explicit chain configuration, standard signing/transaction methods. Omitted network configuration defaults to mainnet; this entry never omits it.
- https://www.dynamic.xyz/docs/node/reference/evm/sign-typed-data — current metadata-first SDK shape, distinct from older example code.
- https://github.com/dynamic-labs-oss/examples/blob/main/examples/nodejs-server-wallets/package.json — inspected blob `29868262d0bed5e5a71161b312b7843288343496`: pins node-evm `0.0.225` and viem `2.38.2`.
- https://github.com/dynamic-labs-oss/examples/blob/main/examples/nodejs-server-wallets/src/server-wallet/send-transaction.ts — inspected blob `fc804adee2bb0ab45b0d2f8c6fd6c807d5ffb8ab`: accountAddress-based getWalletClient + explicit chain.
- https://github.com/dynamic-labs-oss/examples/blob/main/examples/nodejs-server-wallets/src/server-wallet/sign-typed-data.ts — inspected blob `80f4b4983b1304860cb7cdadf1754ee9beb2ce0c`: explicit Base Sepolia domain, chain ID 84532.

The new runner targets the **pinned example API**, not an invented hybrid of old examples and newer metadata-first documentation. The native SDK and lockfile must be installed, audited, and verified on a supported OS before any credentials are used. A docs match is not a compatibility test or supply-chain qualification. No simulation, provider policy, x402, or MPP support is claimed by this entry.

## Organizer questions still unresolved

1. What is the precise deadline and submission form, including time zone?
2. Does the Dynamic track accept a Base Sepolia transaction for the working-action requirement?
3. May entrants reuse their own pre-existing open-source Risk Fork runtime if new integration work is disclosed?
4. Is a public repository required, and what are the demo/video/presentation limits?
5. Does a deterministic autonomous decision agent qualify, or is live LLM inference specifically required?

These questions must not be silently converted into assumptions. The code, testnet runner and presentation can be prepared before answers arrive, but final eligibility remains unresolved.
