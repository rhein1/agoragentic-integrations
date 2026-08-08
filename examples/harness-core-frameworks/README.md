# Harness Core Framework Wrapping Examples

These declarative examples pin the selective OSS scope from issue #855. They define mapping inputs for existing frameworks and local runtimes; they are not executable adapters and do not prove that a framework action ran. In the package adapter catalog, these paths remain `status: "stub"` with `authority: "local_no_spend_mapping_only"`.

The examples do not replace framework runtimes and do not grant hosted provisioning, wallet spend, x402 activation, marketplace publication, trust mutation, provider dispatch, private ECF export, or owner-approval bypass. Claude Code `PreToolUse` enforcement is a separate packaged adapter and is not represented by this example inventory.

Inventory:

- `langgraph`
- `crewai`
- `mcp`
- `codex`
- `hermes`
- `rust_reference_runtime`

Machine-readable inventory: `framework-wrapping-examples.json`.

Validate the inventory locally from this directory:

```sh
node ./validate.mjs
```
