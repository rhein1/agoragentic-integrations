# Offline Example Entrypoint Smoke Check

This helper checks Python and JavaScript entrypoints documented by README files
under `examples/`. It reads local files only, parses Python with the standard
library, and uses `node --check` for JavaScript syntax without executing the
examples.

From the repository root, run the regression suite:

```sh
python examples/agoragentic-growth/2026-07-24-smoke-example-entrypoints-py-4beccab84c/smoke-example-entrypoints.py --self-test
```

Check the repository's documented example entrypoints:

Replace `--self-test` with `--root .` in the command above.

Python 3.10 or newer is required. Node.js must be available when JavaScript
entrypoints are present. Findings are deterministic and the command exits
nonzero when documentation, paths, or syntax need attention.
