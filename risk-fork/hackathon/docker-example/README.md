# Optional local Docker MCP example

> DEMO ONLY — LOCAL DOCKER STDIO MCP EXAMPLE — NOT E2B — NOT HOSTED OR PRODUCTION PROTECTION

This is a separate developer experiment, not the default Risk Fork demo and not
an E2B qualification. It serves one synthetic, instruction-bearing MCP tool so
you can observe how your client treats untrusted discovery text. The built-in
probe uses no model, provider, Marketplace, wallet, credential, or paid API. It
does not protect an arbitrary MCP server or establish live Risk Fork interception.

Requirements: Node.js 20+ and a **locally preloaded**, trusted `node:22-alpine`
Linux image in a local Docker daemon. The runner never pulls, builds, or installs
an image. Check availability before running:

```powershell
docker image inspect node:22-alpine --format '{{.Id}}'
```

On Windows, the default path requires an actual `docker.exe` and Docker
Desktop's Linux engine. A PowerShell-only `docker.ps1`/`docker.cmd` wrapper is
not executed. If Docker is available only inside a local WSL distribution,
select that distribution explicitly before `probe` or `serve`:

```powershell
$env:RISK_FORK_DOCKER_WSL_DISTRO = 'Ubuntu-24.04'
wsl.exe -d Ubuntu-24.04 --exec docker image inspect node:22-alpine --format '{{.Id}}'
node risk-fork/hackathon/docker-example/runner.mjs probe
```

Replace the distribution name with an installed local distribution; names are
validated and passed as one argument with WSL's `--exec` mode, never through a shell. The runner checks
that Docker's selected endpoint inside WSL is a local Unix socket. It strips
Docker host/context overrides from the WSL `docker` invocation. A missing WSL
distribution or image fails before a container is started.

If the image is missing, stop. Obtaining Docker or the image is a separate,
owner-controlled setup step that may use network or incur bandwidth/compute
costs. A local tag is not supply-chain attestation. The runner checks the local
image's ID, Linux OS, environment shape, lack of declared volumes, and lack of
healthcheck, then invokes that exact image ID. Review the image source before
trusting it. Do not use an image containing private data or credentials.

From the repository root, run the no-spend deterministic probe:

```powershell
node risk-fork/hackathon/docker-example/runner.mjs probe
```

The probe exchanges `initialize`, `tools/list`, and `tools/call` with the
synthetic server over stdio, sending `notifications/initialized` only after
the initialize response. It verifies the closed response, then checks the
exact container's absence. A successful response says
`verified_local_mcp_probe`, `provider_calls: 0`, and
`cleanup: "verified_absent"`. Missing image, remote daemon context, Windows
container engine, unexpected image environment, timeout, protocol error, or
uncertain cleanup fails closed. The runner never falls back to the host Node
process or to the fake-E2B path.

To let a local MCP client connect, configure the client to execute the local
Node binary with the absolute path to `runner.mjs` and the single argument
`serve`. Do not use `npx` or a registry package. The server is deliberately
short-lived (60 seconds, 16 MCP messages) and will end the session after those
limits. The runner reserves stdout for JSON-RPC and sends only sanitized status
to stderr. Use a disposable client profile with other tools disabled, no
credentials, and no private workspace: the tool description is deliberately
instruction-bearing test data. Client setup is manual and not verified by this example. A third-party
client may make its own model/API calls or incur usage even though this MCP
fixture itself cannot call a provider or spend.

The container is started with a local-only daemon context,
`--pull=never`, `--network=none`, `--read-only`, UID/GID `65534:65534`, all
capabilities dropped, no new privileges, memory/CPU/PID limits, and no TTY.
There are no user-specified host bind mounts, image-declared volumes, published ports, forwarded host environment
variables, Docker socket mount, or provider keys. The reviewed fixture source
is passed directly to the preloaded Node image as a bounded `--eval` argument,
not copied from a host mount. The container is named and labelled with a fresh
random nonce. On completion or error the runner only force-removes a container
whose exact name, ID, and ownership label match that nonce, and separately
checks absence. An unreachable daemon leaves cleanup `unknown`, never success.
After verifying a local Docker endpoint, the runner pins that exact endpoint for
image inspection, launch, and cleanup. Launch and cleanup use a new empty Docker
client config directory, so user-level proxy settings cannot be injected into
the fixture; the directory is removed only when it is empty. In WSL, that
directory is created inside the selected local distribution. If the Docker
client never exits after bounded termination attempts, cleanup remains
`unknown`, even if a container absence check appears to pass.

Docker daemon access is powerful and is not a security boundary for an
untrusted *host user*. Do not expose this runner as a public web launch service
or give it a remote Docker endpoint. On Windows, use Docker Desktop's Linux
container engine; native Windows containers are refused. Docker Desktop/WSL
configuration, image provenance, and kernel isolation remain outside this
example's proof. The synthetic server does not attempt real exfiltration,
filesystem mutation, or outbound traffic, so a passing probe proves only this
bounded local MCP exchange and observed cleanup—not general containment,
E2B behavior, production readiness, or protection of a real client's context.

Docker's documented [run flags](https://docs.docker.com/reference/cli/docker/container/run)
and [daemon security boundary](https://docs.docker.com/engine/security/) are
worth reviewing before using Docker with less controlled code.
