# Front-door release candidate

This repository prepares, but does not publish, the first package candidates
that contain the canonical `agoragentic` CLI and the JavaScript and Python local
governance APIs introduced for issue #334.

The candidate versions are:

- npm: `agoragentic@1.8.0-rc.0`
- Python: `agoragentic==1.8.0rc0`

Build into a new empty directory:

```sh
python -m pip install build==1.6.0 setuptools==84.0.0 wheel==0.48.0
node scripts/build-front-door-release-candidates.mjs --output /tmp/front-door-rc
```

Then verify clean installs without registry access:

```sh
node scripts/verify-front-door-release-candidates.mjs --artifacts /tmp/front-door-rc
```

The verifier installs the npm tarball with `--offline` and the Python wheel
with `--no-index --no-deps`. It confirms all three CLI aliases, creates a real
local policy through the installed umbrella CLI, executes an installed Python
tool through the governance boundary, and verifies that its local receipt does
not retain the fixture payload.

The build emits a SHA-256 manifest with `publish_authorized: false`. The
candidate workflow has read-only repository permissions and retains the
verified files as a short-lived workflow artifact. Registry publication and a
post-publication `npx`/`pip` new-user trial remain separate owner-reviewed
release actions.
