# OpenRouter Top-60 Audit Against Agoragentic Integrations

Snapshot date: **2026-08-09**
Repository inspected: `rhein1/agoragentic-integrations@68b732e945fcfa70aeb16692586c14fc1e70c66c`

**Distribution state:** review-only deliverable; no active manifest entry or live compatibility claim.

**Ranking provenance:** ranks, names, and token values were transcribed from user-supplied screenshots. The original screenshots and their hashes are not preserved in this pack, so the ranking is not independently reproducible. `catalog/source-evidence.json` records that limitation and a deterministic hash of the catalog transcription only; it is not a screenshot hash.

The ranking is not a list of sixty interchangeable agent frameworks. It mixes MCP hosts, coding agents, model gateways, remote MCP services, plugin ecosystems, closed consumer applications, and retired products. The audit therefore assigns the correct integration direction instead of manufacturing sixty unsafe or nonfunctional adapters.

## Outcome counts

- `covered_existing`: **5**
- `ready_config`: **12**
- `direct_adapter`: **2**
- `composition_recipe`: **9**
- `provider_recipe`: **4**
- `plugin_scaffold`: **4**
- `vendor_intake`: **8**
- `blocked_no_public_surface`: **10**
- `deprecated`: **2**
- `needs_verification`: **4**

## Full decision matrix

| Rank | Target | Tokens | Audit result | Integration direction | Action |
|---:|---|---:|---|---|---|
| 1 | Hermes Agent | 33T | `covered_existing` | `inbound_host` | Retain the existing adapter; add it to the cross-ecosystem compatibility map rather than creating a duplicate. |
| 2 | Claude Code | 7.53T | `covered_existing` | `inbound_host` | Retain existing plugin; cross-link OpenRouter model routing and the official OpenRouter skill. |
| 3 | Kilo Code | 7.33T | `ready_config` | `inbound_host` | Install the pinned local stdio relay; public/no-spend tools can be used without an API key, while authenticated tools remain separately gated. |
| 4 | OpenClaw | 4.47T | `ready_config` | `inbound_host` | Add Agoragentic as a streamable-HTTP MCP server; keep authenticated execution approval-gated. |
| 5 | Cline | 3.55T | `covered_existing` | `inbound_host` | Retain current package; add compatibility reference only. |
| 6 | pi | 2.61T | `ready_config` | `inbound_host` | Install `pi-mcp-adapter` and load the local Agoragentic relay. |
| 7 | Descript | 1.76T | `composition_recipe` | `outbound_mcp_service` | Compose Descript and Agoragentic in a shared MCP host; do not mislabel Descript as an agent framework. |
| 8 | Command Code | 1.62T | `ready_config` | `inbound_host` | Register the pinned local stdio relay with `cmd mcp add`; the candidate command does not configure a hosted endpoint. |
| 9 | Hello Minds, powered by Ethoswarm | 1.26T | `vendor_intake` | `proprietary_agent_platform` | Use the generated vendor intake to request a supported custom-tool or MCP registration contract. |
| 10 | ISEKAI ZERO | 988B | `blocked_no_public_surface` | `none` | BLOCKED until a public plugin, MCP, tool, or API surface is documented. |
| 11 | Janitor AI | 971B | `blocked_no_public_surface` | `none` | BLOCKED; OpenRouter provider support alone is not an Agoragentic tool integration surface. |
| 12 | Codex | 948B | `ready_config` | `inbound_host` | Install the local MCP relay and optionally the official OpenRouter SDK skill. |
| 13 | Framer | 887B | `plugin_scaffold` | `embedded_plugin` | Use the scaffold to call `match` from a server-side plugin action; do not expose keys in browser code. |
| 14 | Lemonade | 834B | `vendor_intake` | `embedded_plugin` | Request a documented plugin/tool extension contract before implementation. |
| 15 | Peezy Gateway | 800B | `provider_recipe` | `model_gateway` | Treat Peezy as an outbound inference/provider rail, not an Agoragentic host. |
| 16 | Oh-My-Pi | 786B | `ready_config` | `inbound_host` | Install the HTTP MCP config with environment-expanded bearer auth. |
| 17 | Nous Research API | 742B | `provider_recipe` | `model_gateway` | Use as a model/provider rail while keeping Agoragentic tools separate. |
| 18 | Codebuff | 549B | `direct_adapter` | `embedded_tool` | Use the included no-spend Codebuff custom tools for match, quote, status, and receipt. |
| 19 | Portkey AI | 503B | `composition_recipe` | `gateway_and_mcp` | Compose Portkey observability/gateway controls with Agoragentic execution rather than wrapping one gateway inside another blindly. |
| 20 | Sahasra | 482B | `composition_recipe` | `outbound_mcp_service` | Use the Stan Store MCP composition recipe; Sahasra itself does not expose a separate verified developer contract. |
| 21 | Pieces.app: Ambient Artificial Memory | 452B | `composition_recipe` | `outbound_mcp_service` | Compose Pieces memory with Agoragentic routing, keeping memory evidence separate from settlement receipts. |
| 22 | Cursor | 442B | `covered_existing` | `inbound_host` | Retain current package; add the top-60 compatibility reference. |
| 23 | HackerAI | 415B | `composition_recipe` | `outbound_mcp_service` | Connect HackerAI and Agoragentic as separate MCP servers in the same host; require explicit authorization for penetration-testing actions. |
| 24 | Mira is the leading AI agent inside Telegram | 411B | `blocked_no_public_surface` | `none` | BLOCKED until Mira publishes a bot API, plugin API, MCP, or custom-tool contract. |
| 25 | LangChain | 410B | `covered_existing` | `framework_adapter` | Retain existing adapter and avoid creating an OpenRouter-specific duplicate. |
| 26 | Zed Editor | 367B | `ready_config` | `inbound_host` | Add the remote public MCP config or launch the local relay for authenticated use. |
| 27 | HighLevel | 350B | `composition_recipe` | `crm_api_and_mcp` | Treat HighLevel as a seller/workflow connector with owner-approved messaging and CRM mutation. |
| 28 | Zoo Code | 342B | `ready_config` | `inbound_host` | Install the local relay in `.roo/mcp.json`; this is the active migration target for Roo Code users. |
| 29 | GDevelop | 335B | `plugin_scaffold` | `embedded_plugin` | Use the server-side extension scaffold; never ship an Agoragentic API key in a game/client bundle. |
| 30 | SillyTavern | 297B | `plugin_scaffold` | `embedded_plugin` | Expose only no-spend tools in the extension; route paid execution through a separate owner-controlled backend. |
| 31 | MavenBio | 286B | `blocked_no_public_surface` | `none` | BLOCKED; no public developer integration surface was verified. |
| 32 | Zazen (Freebuff fork) | 258B | `needs_verification` | `possible_framework_fork` | Do not reuse the Codebuff adapter until the fork and SDK compatibility are independently verified. |
| 33 | Sekai | 247B | `blocked_no_public_surface` | `none` | BLOCKED until a documented plugin/API surface exists. |
| 34 | Z Code | 225B | `ready_config` | `inbound_host` | Use the included stdio MCP configuration and verify the client-specific scope. |
| 35 | Craft | 220B | `blocked_no_public_surface` | `none` | BLOCKED until Craft publishes an extension or tool contract. |
| 36 | OpenHands | 220B | `ready_config` | `inbound_host` | Register the local relay through OpenHands MCP configuration/CLI. |
| 37 | Ito | 218B | `vendor_intake` | `github_workflow` | Integrate through GitHub checks/webhooks or a vendor API; do not pretend Ito is an MCP host. |
| 38 | Open WebUI | 212B | `ready_config` | `inbound_host` | Add Agoragentic as a remote MCP server in the admin UI; start with anonymous public tools. |
| 39 | extra.email | 208B | `blocked_no_public_surface` | `none` | BLOCKED until a mail API, plugin framework, or MCP surface is documented. |
| 40 | HammerAI | 190B | `blocked_no_public_surface` | `provider_only_client` | OpenRouter model configuration is not equivalent to Agoragentic tool integration; BLOCKED pending a tool/plugin API. |
| 41 | CSS AI Pro | 183B | `vendor_intake` | `crm_application` | Use the HighLevel connector path or obtain a separate vendor API contract. |
| 42 | claude-mem | 181B | `composition_recipe` | `outbound_mcp_service` | Compose memory retrieval with Agoragentic; never treat recalled text as authority or a settlement receipt. |
| 43 | Roo Code | 170B | `deprecated` | `migration` | Do not ship a new adapter; direct users to Zoo Code or Cline. |
| 44 | shapes inc | 164B | `deprecated` | `none` | Do not implement against a sunset API; retain a tombstone to prevent future duplicate work. |
| 45 | Sophia's LoreBar | 153B | `provider_recipe` | `model_gateway` | Treat as an outbound model/provider rail; it does not make LoreBar an Agoragentic tool host. |
| 46 | SquadStack AI | 143B | `vendor_intake` | `enterprise_voice_api` | Request API documentation, scopes, sandbox, webhook schema, and consent controls before implementation. |
| 47 | LOVE | 137B | `blocked_no_public_surface` | `none` | BLOCKED; exact product and developer surface were not verifiable. |
| 48 | Chub AI | 132B | `plugin_scaffold` | `embedded_plugin_and_gateway` | Use the extension scaffold for no-spend discovery or compose Chub as a separate gateway; keep credentials server-side. |
| 49 | Pocket AI | 124B | `needs_verification` | `unknown` | BLOCKED pending exact vendor URL and public developer documentation. |
| 50 | Halluna | 116B | `blocked_no_public_surface` | `none` | BLOCKED until a plugin/API surface exists. |
| 51 | GitLawb | 116B | `composition_recipe` | `outbound_mcp_and_api` | Compose a GitLawb node as a separate evidence/tool source; pin node identity and trust policy. |
| 52 | ppq.ai | 115B | `provider_recipe` | `model_gateway` | Use as an outbound model/provider rail with explicit budget and data-policy controls. |
| 53 | Orchid | 111B | `needs_verification` | `unknown` | BLOCKED pending a working product URL and developer docs. |
| 54 | Sirius AI Multilingual Data Pipeline | 106B | `vendor_intake` | `data_pipeline` | Request an API, job schema, data-retention policy, and callback/receipt contract. |
| 55 | Landingsite | 105B | `vendor_intake` | `website_builder` | Request a documented plugin/API surface before implementation. |
| 56 | ChainPatrol | 101B | `composition_recipe` | `security_api` | Model ChainPatrol as a seller capability or pre-execution security check once API credentials and exact endpoint contracts are verified. |
| 57 | Letaido | 98.5B | `vendor_intake` | `marketing_connector` | Use vendor intake for connector scopes, job submission, callback, and proof semantics. |
| 58 | Oration AI | 87.6B | `direct_adapter` | `outbound_conversation_api` | Use the included fail-closed adapter: reads are enabled; conversation creation requires both explicit code-level approval and an environment gate. |
| 59 | mimocode | 86.7B | `ready_config` | `inbound_host` | Install the local Agoragentic relay under the exact `mcp` configuration key. |
| 60 | JobLeads LLM | 84.4B | `needs_verification` | `unknown` | BLOCKED pending exact vendor identity and public developer documentation. |

## Rules used

1. A host that can load MCP gets a host-native configuration.
2. A framework with a public SDK gets a bounded tool wrapper.
3. A model gateway is treated as an outbound inference provider, not as an Agoragentic tool host.
4. A remote MCP/API service is composed beside Agoragentic or evaluated as a seller capability.
5. A closed or ambiguous application receives a vendor-intake or blocked record, never a fabricated compatibility claim.
6. Any operation that can spend, message, publish, mutate data, or trigger a call remains approval-gated.


All runnable candidates in this compact pack remain source-only and unverified.
