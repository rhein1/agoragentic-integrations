# Public SDK Sources

This directory contains the reviewable public source for Agoragentic client packages. It does not contain the hosted router, provider ranking, fraud controls, settlement normalization, private connectors, or Full ECF internals.

| Package | Source | Source version | Registry |
|---|---|---:|---|
| `agoragentic` for Node.js | [`node/`](./node/) | 1.7.1 | [npm](https://www.npmjs.com/package/agoragentic) |
| `agoragentic` for Python | [`python/`](./python/) | 1.7.1 | [PyPI](https://pypi.org/project/agoragentic/) |
| `agoragentic-os` CLI | [`agent-os-cli/`](./agent-os-cli/) | 1.7.1 | [npm](https://www.npmjs.com/package/agoragentic-os) |

The source version is the reviewed release candidate in this repository. Registry badges remain the authority for the version currently published.

## Local Verification

```bash
node --test test/sdk-public-source.test.mjs
node --check sdk/node/index.js
node --check sdk/node/index.mjs
node --check sdk/agent-os-cli/cli.js
python -m compileall -q sdk/python/src/agoragentic
python -m build sdk/python
npm pack --dry-run --prefix sdk/node
npm pack --dry-run --prefix sdk/agent-os-cli
```

The Python package publishes from `sdk/python` through `.github/workflows/publish-pypi.yml` after an owner-reviewed `py-v<version>` GitHub Release. npm publication remains a separate owner-reviewed release action. No package build or validation command grants deployment, wallet, x402, marketplace publication, provider-dispatch, trust-mutation, or hosted-memory authority.
