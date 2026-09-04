# Get started with Risk Fork

Agoragentic Risk Fork is an Apache-2.0 experimental protocol and reference
implementation created by Jeremy Borden / Agoragentic. Choose the demonstration
path to see it work, or the host integration path to develop an adapter.

## Run the visual demonstration

Use the [hackathon quickstart](https://github.com/rhein1/agoragentic-integrations/blob/main/risk-fork/hackathon/docs/QUICKSTART.md) from a pinned
source checkout or a verified offline release kit. The demo includes a local
MCP server and a Flight Recorder. It accepts named synthetic scenarios only.

```powershell
npm --prefix risk-fork ci --ignore-scripts --no-audit --no-fund
node risk-fork/hackathon/bin/risk-fork-demo.mjs doctor
node risk-fork/hackathon/bin/risk-fork-demo.mjs run --scenario e2b-malicious-mcp-containment
node risk-fork/hackathon/bin/risk-fork-demo.mjs serve
```

The demo uses a local reference adapter or an injected fake E2B SDK. It grants
no external-action authority and provides no live isolation or traffic
protection. The hackathon files are distributed in the repository/offline ZIP;
they are intentionally excluded from the core npm tarball.

## Install a local package candidate

The candidate package is `@agoragentic/risk-fork@0.1.0-alpha.1`, ESM, Node 20+.
Registry publication must be confirmed on the official release before using an
npm registry installation command. You can test the real package today:

```powershell
npm --prefix risk-fork ci --ignore-scripts --no-audit --no-fund
npm --prefix risk-fork run test:package
```

That check packs the actual tarball, installs it into a fresh consumer using
the local npm cache, imports package exports, runs the local lifecycle and MCP
host example, and checks verified cleanup. It removes its temporary consumer.
It does not publish the package or contact a sandbox provider.

To retain a tarball for your own project, run `npm pack --ignore-scripts` in the
`risk-fork` directory, then `npm install --ignore-scripts <absolute-tarball-path>`
in your project. Dependencies may be fetched during this ordinary installation.
The packed `examples/local-reference.mjs` is runnable with local Node.

## Integrate at the host boundary

Read [MCP_HOST_ADAPTER.md](./MCP_HOST_ADAPTER.md) and run its complete example.
The trusted application owns the controller, descriptor resolver, provider,
policy and operation builders. It presents an opaque session interface to the
agent and validates each operation before executing it.

A model prompt or MCP tool description is discovery, not enforcement. Every
instruction-bearing read and consequential tool path must pass through the
host. An agent retaining an independent shell, network client or direct MCP
transport can bypass a wrapper. The host must remove or intercept those paths.

The source adapter is for local protocol integration. Production remains
blocked by real provider qualification, mandatory host installation and durable
production authorization. E2B allocation remains disabled in source. See
[SECURITY_MODEL.md](./SECURITY_MODEL.md) and the current status in [README.md](./README.md).

## Contribute and cite

Report a reproducible issue with the exact commit, Node/client versions,
synthetic scenario, sanitized receipt and expected result. Do not attach raw
credentials, private workspaces or customer data. Useful contributions include
adversarial test cases, provider conformance, client onboarding and framework
adapters. Cite [CITATION.cff](./CITATION.cff); preserve [NOTICE](./NOTICE) in
applicable redistributions.
