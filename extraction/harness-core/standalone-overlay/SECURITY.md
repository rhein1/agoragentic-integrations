# Security policy

Harness Core is a local no-spend governance kernel. Report vulnerabilities privately to
`security@agoragentic.com`. Do not open a public issue for suspected vulnerabilities, exploit details,
secret exposure, or unsafe authority widening.

## Supported versions

| Version | Status |
|---|---|
| `0.3.x` | Review-gated source candidate until a release is published |
| `0.2.x` | Current npm release line |
| `<0.2` | Unsupported |

## Scope

Security reports may cover policy bypass, approval bypass, receipt or evidence tampering, path escape,
unsafe host-hook behavior, secret retention, dependency compromise, or unexpected wallet, network,
provider, deployment, publication, trust, or spend authority.

Harness Core local receipts are not settlement receipts, certifications, endorsements, or marketplace
verification. The host remains the executor. A report that relies on live provider calls, payments, or
production mutation must be coordinated privately before any test is attempted.
