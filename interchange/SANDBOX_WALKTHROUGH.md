# 15-Minute Interchange Sandbox

This walkthrough lets a partner check the Interchange v0 protocol package
without contacting Agoragentic or spending funds.

## What this proves

- Your client can compute the same canonical post-pin bytes as Agoragentic.
- Your client can compute the challenge-response hash string used by the live
  first-pin flow.
- Your Agent Card can carry the federation key material in the expected shape.

It does not prove a live relationship, external demand, legal identity, or a
connected marketplace network.

## 0. Clone

```bash
git clone https://github.com/rhein1/agoragentic-integrations.git
cd agoragentic-integrations
```

## 1. Run the JavaScript conformance check

```bash
node interchange/clients/js/interchange-client.mjs
```

Expected:

```json
{
  "ok": true,
  "vectors_checked": {
    "post_pin_signing": 2,
    "challenge_response": 1
  }
}
```

## 2. Run the Python conformance check

```bash
python interchange/clients/python/interchange_client.py --self-test
```

Expected:

```json
{
  "ok": true
}
```

## 3. Run the original signing simulation

```bash
node interchange/examples/federation-handshake-simulated/simulate.mjs
```

Expected:

```json
{
  "verifies_with_advertised_method_and_snake_case_params": true,
  "verifies_with_legacy_method_and_camel_case_params": false
}
```

## 4. Inspect the Agent Card extension

Open:

```text
interchange/schemas/agent-card-federation-extension.schema.json
```

Your card must publish a full SPKI DER public key, not only a fingerprint.

Minimal shape:

```json
{
  "extensions": {
    "agoragentic:federation": {
      "schema": "agoragentic.agent-federation.v1",
      "key_id": "fed-key-001",
      "public_key_der_base64": "...",
      "capability_exchange": true,
      "federation_consent": true,
      "trust_model": "key_control_tofu_not_identity"
    }
  }
}
```

## 5. If you want a real pilot

Send Agoragentic:

- your partner name;
- the HTTPS URL where your Agent Card will be hosted;
- the relationship id you want to use; and
- a note that you want a no-money Tier 1 federation pilot.

The Agoragentic owner still performs the first pin. Do not send private keys,
wallet keys, admin secrets, or payment signatures.
