# Claude Agent SDK preflight and Commerce Agents source adapter

**Source candidate. Local tests are not live SDK, MCP, commerce, or payment qualification.**
This directory extends the existing integration; it is not a new framework or product.

The Python and TypeScript helpers now fail closed. Pending human approval returns
`allowed: false`; changing a preference or adding an API key never enables paid
execution. The helpers do not authenticate users, execute tools, enforce filesystem
isolation, verify settlements, or provide a production approval service.

## What is available

| Component | Scope |
| --- | --- |
| Python and TypeScript preflight | Decimal spend-cap validation; unknown tools denied; paid execution always blocked |
| SDK callback and registration factory | Installed Python/TypeScript SDK wire contracts; real CLI 2.1.263 enforces the TypeScript adapter's unsupported-tool deny in a local Messages fixture |
| Receipt display projection | Drops freeform/nested receipt fields; not a verifier or a general PII filter |
| [Commerce Agents integration](commerce/README.md) | Pinned upstream interface bridge, local SQLite fixture, shared-executor conformance driver, optional canonical Harness composition |

Only `agoragentic_match`, `agoragentic_search`, and `agoragentic_categories` pass
local preflight. Even for those names, the callback returns `{}` rather than an
`allow` permission override, so other host checks remain in force. This does not
make the currently disabled remote MCP relay safe to use. Unknown/MCP-prefixed
names are denied; do not strip arbitrary server prefixes to grant permission.

`agoragentic_execute` and `agoragentic_invoke` never return an allow decision here,
including zero-budget calls. Explicitly available free platform execution needs
its own qualified host integration; zero price alone does not establish one.

## Install the Python adapter

Copy `claude-agent-sdk/agoragentic_claude_agent.py` into your project, preserving
the filename `agoragentic_claude_agent.py`. The adapter uses only the Python
standard library until the host explicitly calls `sdk_hooks()`. Installing or
importing it does not start an SDK client, make a network request, or grant tool
authority. The catalog copy instruction is exercised from a clean temporary
consumer project by `test/framework-adapter-contracts.test.mjs`.

The TypeScript source remains available at
`claude-agent-sdk/agoragentic_claude_agent.ts` for hosts that separately install
and qualify the pinned TypeScript SDK. It is not installed by the Python copy step.

## Offline verification

Python 3.11+ and Node 22.16+ (or Node 24) are sufficient for the hermetic suite.
No SDK, model account, network service, API key, or wallet is needed.

```bash
python claude-agent-sdk/agoragentic_claude_agent.py
python claude-agent-sdk/adapter.test.py
node --experimental-strip-types --test claude-agent-sdk/adapter.test.mjs
python claude-agent-sdk/commerce/demo.py
```

The existing `test/framework-adapter-contracts.test.mjs` invokes both test lanes
inside the repository's existing `adapter-conformance` CI job. No new workflow,
scheduler, deployment, or paid canary is introduced.

Optional TypeScript static checking with an installed compiler:

```bash
tsc claude-agent-sdk/agoragentic_claude_agent.ts --noEmit --strict --target ES2022 --module nodenext
```

## Explicit SDK registration

After separately installing and qualifying the actual Claude Agent SDK, the
Python host can pass `adapter.sdk_hooks()` to `ClaudeAgentOptions(hooks=...)`.
The TypeScript host can pass `adapter.sdkHooks()` to the SDK options. Construct
these objects in trusted host code, never from model-supplied configuration.
These hooks intentionally deny all tools outside the small preflight surface;
do not install them globally and assume other tools have been integrated.

The callback denies pending work instead of emitting a textual approval request
while returning success. It starts no SDK client, network request, or tool call.
An external authenticated approval-and-execution path remains separate work.
The hermetic Python registration test uses a constructor stub. The separate
dependency-backed tests instantiate the actual SDK and dispatch callbacks through
its real control protocol using a synthetic CLI peer. This verifies serialization
of deny decisions, not enforcement by a real Claude Code process.

The separate `npm --prefix claude-agent-sdk run test:cli` lane runs the actual
checksum-verified CLI against a loopback Messages fixture. Its inert Write control
produces one effect and one successful PostToolUse event; the adapter's deny produces
neither. This covers TypeScript unsupported-tool denial, not Python CLI enforcement,
commerce-tool approval through a model, MCP, or a production runtime.

See [qualification evidence](commerce/QUALIFICATION.md) for exact versions and
reproduction commands. The private npm package is development tooling only.

The current official hook contract is documented in the
[SDK hooks reference](https://code.claude.com/docs/en/agent-sdk/hooks).

## Configuration and compatibility changes

`permissions.example.json` uses the supported nested `permissions` object.
Legacy flat objects and finite numeric caps remain accepted. Decimal strings
are preferred; at most six fractional digits are accepted. Booleans, negative
values, non-finite numbers, exponent strings, malformed values, duplicate JSON
keys, and unknown policy fields are rejected. A missing explicitly named policy
file is an error, not permission to fall back to defaults.

This is intentionally a behavior-breaking safety correction:

- Pending approval changed from allowed to blocked.
- Unknown tools no longer default to allowed.
- `require_hitl_for_spend: false` does not authorize spending.
- `publish_receipts_publicly` does not grant disclosure or publication authority.
- No tool is actually given file access by `allow_file_access_before_execution`.

`handle_post_execution` / `handlePostExecution` creates a **lossy receipt display
projection**, retaining only a bounded status vocabulary and a projection label.
It does not mutate the original signed receipt. The host must preserve original
evidence separately for verification. Non-receipt output is not sanitized here;
this is not arbitrary secret detection or a general data-loss-prevention system.
No receipt, key, address, transaction hash, or tool payload is logged by the helper.

## Release boundary

Platform custody remains an owner-controlled Interchange-completion gate. This
source does not inspect or alter production configuration, fund/sign/retry/settle
paid work, enable a remote MCP server, or replace the existing money path. The
payment architecture is retained, not retired; a future reopening requires a
separate explicit host/release decision and current live authority.

[Codex implementation handoff and acceptance gates](commerce/CODEX_HANDOFF.md)
