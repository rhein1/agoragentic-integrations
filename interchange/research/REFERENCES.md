# Primary Protocol and Ecosystem References

Retrieved 2026-08-14. These sources define external protocols or document public
ecosystem discussions. They do not prove Agoragentic's production behavior;
production evidence is linked from the case studies and chronology.

## Normative and primary specifications

| Topic | Primary source | Use in the paper |
|---|---|---|
| A2A | [A2A Protocol specification](https://a2a-protocol.org/latest/specification/) and [official repository](https://github.com/a2aproject/A2A) | Agent Cards, task/message lifecycle, protocol bindings, extensions, and interoperability model. Pin the cited version at submission time. |
| x402 v2 | [x402 protocol specification](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md) | Payment-required, signed retry, verification/settlement roles, CAIP-2 network identifiers, replay controls, and transport boundaries. |
| CAIP-2 | [CAIP-2 Blockchain ID Specification](https://standards.chainagnostic.org/CAIPs/caip-2) | Meaning and syntax of `eip155:8453`. |
| ERC-3009 | [Transfer With Authorization](https://eips.ethereum.org/EIPS/eip-3009) | Signed transfer authorizations, nonce use, validity windows, and relayer submission. |
| ERC-20 | [Token Standard](https://eips.ethereum.org/EIPS/eip-20) | `Transfer(address,address,uint256)` event interpretation. |
| Base | [Base RPC overview](https://docs.base.org/base-chain/api-reference/rpc-overview) | Base mainnet chain id `8453` and standard JSON-RPC endpoint behavior. |
| Ed25519 | [RFC 8032](https://www.rfc-editor.org/info/rfc8032/) | Ed25519 signing and verification primitive. |
| Ed25519 SPKI | [RFC 8410](https://www.rfc-editor.org/info/rfc8410/) | SubjectPublicKeyInfo encoding for Ed25519 public keys. |
| Official MCP Registry | [Registry overview](https://modelcontextprotocol.io/registry/about) and [API reference](https://registry.modelcontextprotocol.io/docs) | Registry metadata, namespaces, downstream-aggregator role, preview status, and API contract. |

## Public ecosystem discussions and implementation context

These are discussion evidence, not normative specifications:

- [A2A discussion #741](https://github.com/a2aproject/A2A/discussions/741):
  registry status, canonical Agent Card URLs, and the emerging distinction
  between discoverability and authorization overlays.
- [Global A2A Registry issue #4](https://github.com/A2ARegistry/GlobalA2ARegistry/issues/4):
  provenance and contact-consent discussion used while designing the bounded
  source reader.
- [Agent Index issue #19](https://github.com/agentsystems/agent-index/issues/19),
  [issue #20](https://github.com/agentsystems/agent-index/issues/20), and
  [PR #21](https://github.com/agentsystems/agent-index/pull/21): public source
  activity examined while testing candidate qualification. Repository activity
  or inclusion was never treated as contact consent.

## Agoragentic primary evidence

- Original charter: [agent-marketplace issue #520](https://github.com/rhein1/agent-marketplace/issues/520).
- Living activation/adoption gate: [issue #1100](https://github.com/rhein1/agent-marketplace/issues/1100).
- Anchor human record: [`../ANCHOR_X402_PILOT.md`](../ANCHOR_X402_PILOT.md).
- Anchor machine evidence:
  [`../evidence/anchor-x402-pilot-2026-07.json`](../evidence/anchor-x402-pilot-2026-07.json).
- Production research ledger:
  [`../evidence/interchange-production-research-ledger.v1.json`](../evidence/interchange-production-research-ledger.v1.json).
- Base outbound-canary transaction:
  [`0x9b01...7d44`](https://basescan.org/tx/0x9b01b4b465e1a764182f796095923fb341608175b01752d6b80631b779bb7d44).
- Base modern-client transaction:
  [`0x705c...6e95`](https://basescan.org/tx/0x705c7a146774289c9e26aea991eac31c82bede037f497b4994bf3d32bbcc6e95).

## Citation discipline

- Cite a protocol specification for what a protocol defines.
- Cite the production ledger or case study for what Agoragentic observed.
- Cite the chain transaction for value movement and block inclusion.
- Do not use a registry listing as evidence of contact consent, trust, or
  operational authority.
- Record the exact protocol/specification version in the submitted paper; the
  `latest` A2A and preview MCP Registry documents can change after this snapshot.
