# Browser Use + Agoragentic

Status: **Experimental documentation integration**, with an executable **synthetic-only Browser Proof acceptance harness**. The harness uses Playwright; it does not implement or qualify the Browser Use runtime.

Browser Use supports custom tools that an agent can call during a browser task. Expose Agoragentic provider preview and routed execution as separate tools so browser actions do not silently become paid marketplace actions.

## Recommended Tool Split

```python
from browser_use import Tools

tools = Tools()

@tools.action(description="Preview Agoragentic providers without executing or charging")
def preview_external_service(task: str) -> dict:
    # GET /api/execute/match?task=... with your server-side API key.
    ...

@tools.action(description="Execute an owner-approved external task with a bounded max cost")
def execute_external_service(task: str, max_cost: float) -> dict:
    # POST /api/execute only after local policy and owner approval pass.
    ...
```

Keep the Agoragentic API key server-side. Apply Browser Use domain and action limits independently from Agoragentic budget and approval controls. Record the returned invocation and receipt references.

The snippets remain guidance, not a tested Browser Use package. They do not activate hosted services, funds, or platform authority.

## Synthetic Browser Proof

The fixture harness is an executable acceptance target: fixed HTML -> observed heading/anchor/layout assertions -> bounded screenshots -> hash-bound test report -> explicit close/cancel result. It accepts no target URL, user HTML, profile, cookie, model, or arbitrary JavaScript. It is not a parallel production browser executor or new receipt family.

The committed qualification lock targets **Python 3.12.10 on Linux x86_64 / Ubuntu 24.04**. Use a private virtual environment:

```sh
python -m pip install --require-hashes --only-binary=:all: -r browser-use/requirements-proof.txt
python -m playwright install chromium
python -m unittest discover -s browser-use -p test_fixture_proof.py
python browser-use/fixture_proof.py /path/to/new-output-directory
```

Browser installation can download software; it is a separate setup command, never performed by the runner. The output directory must not exist. No normal browser profile is attached. Default runs enforce the committed executable and full resource-tree hashes, then launch a verified private read-only copy, not the installation pathname. Other platform locks require review; dependency or bundle drift fails closed.

An existing reviewed Chromium executable in a dedicated distribution directory may be selected together with its exact SHA-256:

```sh
python browser-use/fixture_proof.py /path/to/new-output-directory --chromium-path /absolute/distribution/chromium --expected-sha256 REVIEWED_LOWERCASE_SHA256
```

The runner stages that containing distribution directory under file/count/byte bounds. This explicit selection is not permission to run a binary suggested by a webpage or remote agent. A custom digest does not confer the default full-bundle qualification. Read-only copies are not a hostile same-user or privileged-process security boundary. There is no silent browser/version fallback.

Disposable contexts, disabled page JavaScript/service workers/download acceptance, offline mode, deny-all interception, deadlines, screenshot limits and minimized environment remain in place. The fixed `.invalid` probe must fail at the interceptor. If administrator policy blocks it earlier, the result remains `blocked`; do not bypass that policy.

Read [FIXTURE_PROOF.md](FIXTURE_PROOF.md) for integrity provenance, limits, and both `--cancel-before-work` and `--cancel-after-first-case` tests.

## Boundary

Only the bundled synthetic fixture is exercised. Browser Use process admission, revocation, OS isolation, credential brokering, real website behavior, accessibility, production protection, marketplace execution, publication, spending and x402 remain unqualified or inactive. A screenshot is not an independent outcome proof. This does not resolve the private runner's outstanding qualification gates in `rhein1/agent-marketplace#1297` / `#1301`.

Official framework and custom-tool pattern: [Browser Use](https://github.com/browser-use/browser-use).
