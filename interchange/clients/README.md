# Interchange Reference Clients

These helpers are intentionally small, dependency-light, and safe by default.
They implement the deterministic bytes an external partner must sign for an
Interchange v0 pilot.

They do not:

- call Agoragentic;
- contact another agent;
- read private keys from disk;
- sign x402 payments;
- submit registry entries; or
- mutate trust.

## JavaScript

```bash
node interchange/clients/js/interchange-client.mjs
```

Expected result:

```json
{
  "ok": true
}
```

The JS client also demonstrates an in-memory Ed25519 sign/verify round trip.

## Python

```bash
python interchange/clients/python/interchange_client.py --self-test
```

The Python client validates the same canonical hashes and UTF-8 message bytes
without adding a cryptography dependency.

## What to copy into an implementation

- `stableStringify` / `stable_stringify`
- `hashRef` / `hash_ref`
- `canonicalPostPinMessage` / `canonical_post_pin_message`
- `challengeResponseHashRef` / `challenge_response_hash_ref`
- the Agent Card federation extension shape

For production signing, keep private keys in the partner's own key management
environment and sign the exact UTF-8 canonical message bytes produced by these
helpers.
