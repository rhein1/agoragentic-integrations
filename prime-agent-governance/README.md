# Agoragentic Prime Agent extension

Put a bounded Agoragentic policy and evidence boundary around Prime Agent lifecycle and tool events.

```text
Prime Agent session
-> classify proposed tool call
-> allow / interactive review / deny
-> observe redacted result evidence
-> produce a clearly labeled local receipt
```

## What this alpha implements

- Prime Agent lifecycle registration for session, agent, tool, compaction, and shutdown events;
- conservative read/write/network/spend/deploy/publish/trust classification, including `ipython` `input.code`;
- exact principal, agent, session, tool-call, capability, and input-hash binding for high-impact actions;
- mandatory synchronous verification by a host-trusted principal-authority verifier;
- one-time consumption of authority IDs and action hashes to reject local replay;
- fail-closed behavior when authority or interactive review is unavailable;
- proposal-only authority requests with a maximum 15-minute lifetime;
- bounded redaction and hash-based evidence;
- `/agora-status` and `agoragentic_status` read-only surfaces;
- local receipts that explicitly are not settlement, certification, trust endorsement, or marketplace verification.

Local policy allowlists and interactive confirmation cannot authorize spend, deploy, publish, or trust actions. Those actions require an active exact grant plus a trusted verifier supplied by the host. Unknown IPython code also fails closed.

## Prime Agent v0.7.1 contract

The package metadata and deterministic fixture target Prime Agent `v0.7.1` at commit `95afd319a78ae017a41241d50b013d656a0685ce`:

- the root `package.json` declares `pi.extensions: ["./index.mjs"]` and the `pi-package` keyword;
- the Node.js floor matches Prime Agent's `>=22.8.0` engine;
- session fixtures use `type`, `reason`, and optional `previousSessionFile`;
- tool fixtures use `type`, `toolCallId`, `toolName`, and `input.code` for IPython.

Install or test the local package with the upstream package path shape:

```bash
prime-agent package install ./prime-agent-governance
prime-agent -e ./prime-agent-governance
```

The default export has no authority provider and therefore denies every high-impact call. A host wrapper that enables such calls must instantiate `createAgoragenticPrimeExtension()` with trusted `principalRef`, `agentRef`, and `sessionRef` values, an action-time `resolveAuthority` callback, and a synchronous `verifyAuthority` callback.

An accepted grant uses `agoragentic.prime-agent.authority-grant.v1` and must contain a nonempty `authority_id`, valid `issued_at` and `expires_at`, exact principal/agent/session references, the exact action hash returned by `buildAuthorityBinding()`, and the exact capability. `verifyAuthority(grant, binding)` must independently verify the principal's signature or equivalent integrity proof and return literal `true`. The extension consumes a successful authority ID and action hash before execution; a production verifier should enforce the same nonce rule durably across process restarts.

## Local validation

From this directory:

```bash
npm run check
npm test
npm run pack:dry
```

From the repository root:

```bash
node --test test/integration-inventory-holds.test.mjs
node scripts/verify-integrations-json.js
```

The package remains absent from the public integration list. Its centrally owned, expiring inventory hold lives in `integrations.json`; package-local files cannot grant or extend that hold.

## Hard boundary

Prime Agent executes model-generated Python and project commands with the user's operating-system permissions. Its daemon, workers, and kernels improve lifecycle containment, not security isolation. Static classification cannot prove that every nested Python side effect was observed.

For payment-bearing or production use, run Prime Agent inside a restricted Agent OS lane and enforce network, filesystem, process, credential, and payment operations at external chokepoints.

The package and fixtures target the exact version above. No partnership or end-to-end runtime compatibility claim is made until an external Prime Agent host run is reviewed and the central inventory hold is deliberately removed.
