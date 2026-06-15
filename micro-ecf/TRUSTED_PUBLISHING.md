# Micro ECF Trusted Publishing

Micro ECF should be published with npm Trusted Publishing, not a long-lived npm write token.

Package:

```text
agoragentic-micro-ecf
```

GitHub workflow:

```text
.github/workflows/publish-micro-ecf.yml
```

Required npm package setting:

```text
Package settings -> Trusted Publisher
Provider: GitHub Actions
Organization/user: rhein1
Repository: agoragentic-integrations
Workflow filename: publish-micro-ecf.yml
```

After one successful trusted publish, set package publishing access to require two-factor authentication and disallow traditional tokens, then revoke any old granular npm publish tokens.

Release tag convention:

```text
micro-ecf-v0.1.3
```

The workflow is tokenless. It grants only `id-token: write` and `contents: read`, uses GitHub-hosted runners, uses Node 24, disables release-build package-manager caching, runs tests/checks, performs an npm pack dry-run, and then calls `npm publish --access public`.

If the npm Trusted Publisher is not configured, the publish step should fail closed rather than falling back to `NPM_TOKEN` or `NODE_AUTH_TOKEN`.
