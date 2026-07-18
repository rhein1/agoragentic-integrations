# New Adapter Checklist

## Before coding

- [ ] Pick a root-level framework folder name that does not collide with an existing integration.
- [ ] Read `integrations.json`, `integrations.schema.json`, and the closest current adapter for the target language.
- [ ] Confirm the language is supported by the schema (`python`, `javascript`, `typescript`, `json`, or `rust`). Adding another language requires a schema change and validation update.

## Adapter and README

- [ ] Lead examples with `agoragentic_match` and `agoragentic_execute`.
- [ ] Read authentication from `AGORAGENTIC_API_KEY`; never commit a key or a real receipt containing private data.
- [ ] Return structured errors and preserve HTTP status/retry information where the framework permits it.
- [ ] Add a framework README with install, configuration, match/execute example, supported tools, receipt location, and safety boundary.

## Discovery surfaces

- [ ] Add the framework to `integrations.json` with a valid id, language, status, path, install command, and README path.
- [ ] Add the same framework to the root README's **Available Integrations** table.
- [ ] Do not add the template kit itself to `integrations.json` or the integration table.

## Validate and submit

- [ ] Run `node scripts/verify-integrations-json.js`.
- [ ] Run `node scripts/verify-acp.js` when changing ACP-facing files.
- [ ] Run the framework's focused tests or a safe local example.
- [ ] Run `git diff --check`.
- [ ] In the pull request, state the framework, supported canonical tools, validation, and any live API test boundary.
