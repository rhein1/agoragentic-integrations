# Risk Fork client adoption

Risk Fork now has source-only integration packets for Claude Code, Codex, and Cursor. The packets are deliberately inactive. They prepare exact local stdio configuration for review without editing a client configuration, starting a gateway, contacting a provider, or claiming live protection.

The current `mcp/risk-forkd.js` entrypoint is still diagnostic-only and exits with code 78. It does not yet advertise the required `risk_fork_protect` tool. Therefore **there is no supported activation command in this tranche**. The client work is ready to bind only after the separately reviewed gateway and provider gates are complete.

## Boundary

```text
Claude Code / Codex / Cursor
            |
            | local MCP stdio; one expected tool
            v
one-tool-stdio-gate.mjs
            |
            | exact absolute path + SHA-256
            v
        risk-forkd
            |
            | separately qualified host boundary (not present here)
            v
 disposable provider child + clean import + verified cleanup
```

The local stdio gate accepts only MCP initialization, ping, `tools/list`, `tools/call`, and the client lifecycle notifications `notifications/initialized` and `notifications/cancelled`. It rejects resource, prompt, notification-shaped tool-call, and arbitrary method access; rejects all gateway-initiated requests and notifications; requires a closed JSON-RPC result-or-error response shape; rejects any call other than `risk_fork_protect`; reads and hashes the gateway once through a nonblocking open file descriptor, then streams those verified bytes to a child bootstrap instead of reopening the mutable pathname; strips inherited environment authority before spawning the gateway; and fails closed if the gateway advertises zero, two, paginated, differently named, or non-object-input tools. At most 16 requests may be in flight, each has a 30-second deadline, and input or output backpressure, premature gateway-output EOF, or asynchronous pipe failure closes the gate rather than accumulating an unbounded queue or leaking an uncaught process error. A cooperative gateway may exit cleanly after client EOF; an unexpected pre-EOF exit remains a failure.

The future `risk-forkd` gateway must own the exact `risk_fork_protect` input schema. The client snippets do not invent a competing schema, and the gate currently requires an object-root `inputSchema` before forwarding the descriptor. This is not yet a schema-integrity proof: the recorded `risk-forkd.js` hash binds only that launcher file, not its generated sibling runtime closure or eventual descriptor. The machine-readable packet therefore sets `runtime_closure_bound` and `tool_input_schema_bound` to `false`. Activation requires a separately reviewed immutable closure/descriptor binding and a regenerated client packet.

The packet JSON Schema is a structural guardrail, not a closed proof of canonical client semantics. Consumers must call the exported `verifyRiskForkClientAdoptionPacket(packet)` function from `@agoragentic/risk-fork/client-adoption` after parsing a packet and before relying on it. The verifier performs no filesystem, network, client SDK, gateway, or provider I/O. It deterministically reconstructs the selected client's exact canonical output count, order, filenames, active destinations, content, prompt posture, and default-off control flags from the recorded gateway binding and the current Node executable, then rejects missing, extra, duplicate, cross-client, reordered, active, or contradictory output records. Because it is pure, it does not attest that recorded hashes match current files; the planning CLI compares the gateway's exact bytes with a reviewed expected digest, while `verify-review` re-reads those files and compares the complete review directory against regenerated content. JSON Schema acceptance alone is insufficient.

This gate is an interface-reduction control, not an isolation boundary. It cannot turn an unqualified gateway or provider into real protection.

The generated configurations embed no credential values. Their empty `env` maps add no client-configured variables, but they do not prove the client gave the gate process an empty inherited environment. The reviewed gate does not forward that inherited environment to `risk-forkd`; a production host must additionally pin and verify the gate itself and provide a sanitized launcher boundary. The packet records the gate hash for offline review, while the gate actively enforces the separately supplied gateway hash.

## Preview the packets

From a pinned source checkout with Node.js 20 or newer:

```bash
npm --prefix risk-fork ci --ignore-scripts
node risk-fork/scripts/client-adoption.mjs status
node risk-fork/scripts/client-adoption.mjs plan --client all
```

The source checkout uses its sibling `mcp/risk-forkd.js` and a finite reviewed digest allowlist pinned in the planning script by default. The allowlist contains only the exact LF and CRLF raw-byte forms of the checked-in source, and the packet records which matching raw digest was read. An installed tarball has no monorepo sibling, so supply the exact external gateway and its independently reviewed digest explicitly:

```bash
npm run client:plan -- --gateway /absolute/path/to/risk-forkd.js --gateway-sha256 "$REVIEWED_GATEWAY_SHA256"
```

Set `REVIEWED_GATEWAY_SHA256` only from the gateway's signed release or other independently authenticated provenance; it must have the form `sha256:` plus 64 lowercase hexadecimal characters. Do not derive that expected value from the same mutable path immediately before planning. The explicit path and digest must be supplied together, the path must be absolute, canonical, free of credential-shaped material, and end in `risk-forkd.js`, and the accepted bytes must match the reviewed digest. Packet generation also uses a nonblocking descriptor, a bounded allocation, metadata checks, and repeated identical reads separated by a short stability window to detect observed changes. Those reads are defense in depth, not an atomic filesystem snapshot or provenance proof. The digest is the acceptance authority. The planner, one-tool gate, package-integrity evidence, and mechanism that supplies the expected digest remain part of the trusted local-host boundary. This does not qualify the gateway or its dependency closure, and it does not defend against a same-privilege local host that can replace both the trusted command inputs and executable files.

`plan` prints the complete packet to stdout and writes nothing. To create review files in a new local directory:

```bash
node risk-fork/scripts/client-adoption.mjs write-review \
  --client all \
  --gateway /absolute/path/to/risk-forkd.js \
  --gateway-sha256 "$REVIEWED_GATEWAY_SHA256" \
  --output /absolute/path/to/new-review-directory \
  --yes
```

On Windows PowerShell, use an absolute Windows path on one line:

```powershell
$reviewedGatewaySha256 = 'sha256:<64 lowercase hexadecimal characters from signed provenance>'
node risk-fork/scripts/client-adoption.mjs write-review --client all --gateway C:\absolute\path\to\risk-forkd.js --gateway-sha256 $reviewedGatewaySha256 --output C:\temp\risk-fork-client-review --yes
```

The helper creates only filenames containing `.disabled.` plus `manifest.json`. It refuses an existing output directory and never writes `.mcp.json`, `.codex/config.toml`, `.cursor/mcp.json`, `.claude/settings.json`, or a user-level client configuration.

Verify the review packet offline:

```bash
node risk-fork/scripts/client-adoption.mjs verify-review \
  --manifest /absolute/path/to/new-review-directory/manifest.json \
  --gateway /absolute/path/to/risk-forkd.js \
  --gateway-sha256 "$REVIEWED_GATEWAY_SHA256"
```

Verification requires the exact current gate, the independently reviewed gateway digest, exact expected filenames, byte-for-byte generated content, and no extra directory entries. Editing a file and rewriting its manifest hash is rejected because the manifest cannot supply its own replacement gateway authority.

Each output's `prompt_posture` describes only what that one candidate file contributes. It does not claim every client or higher-precedence policy must prompt: standalone MCP files carry no prompt rule, Claude's separate settings file supplies the explicit `ask` rule, Codex supplies an explicit per-tool prompt, and Cursor supplies only default/best-effort posture.

## Codex packet

The Codex TOML is the strongest native client configuration in this tranche:

- `enabled = false` keeps the server off;
- `required = true` makes a future enabled server fail startup or resume when it cannot initialize;
- `enabled_tools = ["risk_fork_protect"]` limits the exposed server tools;
- the server default and exact tool override both use `approval_mode = "prompt"`; and
- the command and arguments use absolute local files rather than npm or `npx` resolution; the packet records the gate hash and passes the gateway hash to the gate for runtime enforcement.

Codex documents project and user `config.toml`, stdio MCP `command`/`args`, `enabled`, `required`, `enabled_tools`, and per-tool approval modes in its [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

Do not change `enabled` to `true` until the gateway advertises exactly `risk_fork_protect`, its executor and provider have current qualification evidence, and an owner has approved the exact deployment and traffic boundary.

## Claude Code packet

The Claude Code review packet contains:

- a project-scoped `.mcp.json` candidate using local stdio and an empty explicit environment map; and
- a settings candidate that lists `risk_fork` in `disabledMcpjsonServers` and keeps the exact tool on the `ask` path.

Interactive Claude Code sessions require project-server approval. Anthropic documents that `claude -p`, Agent SDK, cloud sessions, and a bypass configuration can load project `.mcp.json` servers without that interactive prompt, so the packet's `disabledMcpjsonServers` setting is the all-mode default-off control. Its permission rules evaluate deny, then ask, then allow. See Anthropic's [MCP reference](https://code.claude.com/docs/en/mcp), [settings reference](https://code.claude.com/docs/en/settings-reference), and [permission reference](https://code.claude.com/docs/en/permissions).

Do not use `--dangerously-skip-permissions`, `bypassPermissions`, a blanket MCP allow rule, or a committed setting that silently approves the server. Claude Code does not provide the same `enabled_tools` server allowlist as Codex in `.mcp.json`; the checked-in one-tool gate is therefore the hard local tool-surface control for this packet.

## Cursor IDE packet

The Cursor review packet covers Cursor IDE Run Modes only. Cursor CLI is unsupported by this packet because its permissions live separately in `.cursor/cli.json` or `~/.cursor/cli-config.json`; the shared `.cursor/mcp.json` can still be discovered by CLI without inheriting the IDE policy candidate. Do not use this packet with Cursor CLI.

The Cursor IDE review packet contains:

- a project `.cursor/mcp.json` candidate using local stdio and an empty explicit environment map; and
- a `.cursor/permissions.json` candidate with no auto-approved MCP tool plus a best-effort Auto-review block instruction for the exact gateway tool.

Cursor IDE asks for MCP connection and tool approval by default. The packet adds no auto-approved MCP entry, but user and project permission arrays combine, team policy has higher precedence, and Run Everything bypasses this posture; inspect the effective Cursor IDE settings before any future activation. See Cursor's [MCP documentation](https://cursor.com/docs/mcp), [CLI MCP documentation](https://cursor.com/docs/cli/mcp), and [permissions reference](https://cursor.com/docs/reference/permissions).

Do not use Run Everything or an MCP allowlist entry for Risk Fork. Do not use the shared MCP candidate with Cursor CLI or `agent --approve-mcps`; a separate CLI-specific default-off packet and test evidence are required first. Cursor's classifier guidance and allowlists are not the isolation boundary; the one-tool gate and the eventual Risk Fork host boundary are separate controls.

## What activation must prove

Before any client packet can become active, a separate exact-head change and runtime qualification must establish all of the following:

1. `risk-forkd` starts through a reviewed host-owned binding and advertises exactly `risk_fork_protect`.
2. Every risky operation is classified and executed in a fresh disposable child before the parent observes untrusted output.
3. The child receives no inherited credentials, sockets, writable parent state, wallet authority, or deployment authority.
4. Network destinations, arguments, risk level, one-use authorization, cleanup, and clean import are independently verified.
5. Provider lifecycle, cleanup, latency, and cost evidence is current for the exact deployed bytes.
6. Client-specific tests prove the enabled configuration on the exact Claude Code, Codex, and Cursor versions being claimed.
7. A traffic-bound receipt proves the real agent action traversed the gateway; a config file, healthy process, or green CI run is not enough.

Until then, the truthful status remains:

```json
{
  "source_available": true,
  "client_review_packets_available": true,
  "client_enabled": false,
  "executor_bound": false,
  "provider_authority_granted": false,
  "hosted_authority_granted": false,
  "production_authority_granted": false,
  "provider_calls": 0,
  "live_traffic_protected": false
}
```

## Scope

Even after activation, a Risk Fork MCP tool protects only operations the agent routes through that tool. It does not automatically intercept a client's built-in shell, browser, filesystem, IDE, or other MCP tools. Real protection requires the host or framework to make the Risk Fork decision path mandatory before those risky effects can occur.

The packet itself is small local text. It stores no fork, VM, sandbox, workspace, credential, or provider state on GitHub, AWS, E2B, or Agoragentic. Runtime fork storage and deletion belong to the separately qualified provider lifecycle.

## License

Risk Fork client-adoption source is licensed under Apache License 2.0 with the rest of the Risk Fork package.
