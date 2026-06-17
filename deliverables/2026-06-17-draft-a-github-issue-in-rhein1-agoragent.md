## Summary

The repo already has several receipt-shaped artifacts, but they are not validated against one shared x402 receipt schema. That makes it easy for one integration to emit `receipt_id`, another to emit `id`, another to omit settlement proof fields, and downstream tooling to break on shape drift.

This issue proposes adding one canonical JSON Schema for x402 receipts and validating the existing example receipt against it.

## Why this helps

- gives every integration one reusable receipt contract
- prevents malformed or partial receipt payloads from breaking downstream flows
- makes examples, docs, and tests agree on field names and required proof metadata
- aligns the x402 examples with the repo’s existing schema-first pattern

## Existing context in this repo

There is already a strong foundation for this:

- `specs/ACP-SPEC.md` defines a settlement receipt shape
- `examples/x402/text-summarizer-receipt.example.json` already shows an x402-style receipt example
- `harness-core/schema/local-receipt.v1.json` shows the repo is already comfortable shipping JSON Schemas
- several other fixtures use receipt-like payloads with slightly different field names

What is missing is one standard schema specifically for x402 integration receipts.

## Proposal

Add:

- `x402/schema/receipt.schema.json`
- `x402/test/receipt-schema.test.mjs`

and validate:

- `examples/x402/text-summarizer-receipt.example.json`

against that schema in CI.

## Proposed schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://agoragentic.com/schema/x402-receipt.schema.json",
  "title": "Agoragentic x402 Receipt",
  "description": "Normalized receipt for x402-backed executions across integrations.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "receipt_id",
    "schema",
    "service",
    "payment",
    "request",
    "result",
    "proof"
  ],
  "properties": {
    "receipt_id": {
      "type": "string",
      "minLength": 1
    },
    "schema": {
      "type": "string",
      "const": "agoragentic.x402.receipt.v1"
    },
    "example_only": {
      "type": "boolean"
    },
    "service": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "slug",
        "resource",
        "payment_protocol"
      ],
      "properties": {
        "slug": {
          "type": "string",
          "minLength": 1
        },
        "resource": {
          "type": "string",
          "format": "uri"
        },
        "payment_protocol": {
          "type": "string",
          "const": "x402"
        }
      }
    },
    "payment": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "network",
        "asset",
        "amount_usdc",
        "settlement_status"
      ],
      "properties": {
        "network": {
          "type": "string",
          "enum": ["base"]
        },
        "asset": {
          "type": "string",
          "const": "USDC"
        },
        "amount_usdc": {
          "type": "string",
          "pattern": "^(0|[1-9]\\d*)(\\.\\d{1,6})?$"
        },
        "settlement_status": {
          "type": "string",
          "enum": ["pending", "settled", "failed", "not_applicable"]
        },
        "transaction_hash": {
          "type": "string",
          "pattern": "^0x[a-fA-F0-9]{64}$"
        }
      }
    },
    "request": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "input_hash",
        "idempotency_key"
      ],
      "properties": {
        "input_hash": {
          "type": "string",
          "pattern": "^sha256:[a-zA-Z0-9._-]+$"
        },
        "idempotency_key": {
          "type": "string",
          "minLength": 1
        }
      }
    },
    "result": {
      "type": "object",
      "additionalProperties": true,
      "required": [
        "status"
      ],
      "properties": {
        "status": {
          "type": "string",
          "enum": ["succeeded", "failed"]
        },
        "summary": {
          "type": "string"
        }
      }
    },
    "proof": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "payment_header_present",
        "receipt_header_present",
        "reconciliation"
      ],
      "properties": {
        "payment_header_present": {
          "type": "boolean"
        },
        "receipt_header_present": {
          "type": "boolean"
        },
        "reconciliation": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "prediction_held",
            "mismatch_score"
          ],
          "properties": {
            "prediction_held": {
              "type": "boolean"
            },
            "mismatch_score": {
              "type": "number",
              "minimum": 0
            }
          }
        }
      }
    },
    "links": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "status": {
          "type": "string",
          "format": "uri"
        },
        "discovery_check": {
          "type": "string",
          "format": "uri"
        },
        "receipt": {
          "type": "string",
          "format": "uri"
        }
      }
    }
  }
}
```

## Example receipt that should validate

This is intentionally close to the existing `examples/x402/text-summarizer-receipt.example.json`, with the schema identifier normalized to the proposed standard:

```json
{
  "receipt_id": "rcpt_example_text_summarizer",
  "schema": "agoragentic.x402.receipt.v1",
  "example_only": true,
  "service": {
    "slug": "text-summarizer",
    "resource": "https://x402.agoragentic.com/v1/text-summarizer",
    "payment_protocol": "x402"
  },
  "payment": {
    "network": "base",
    "asset": "USDC",
    "amount_usdc": "0.10",
    "settlement_status": "settled"
  },
  "request": {
    "input_hash": "sha256:example",
    "idempotency_key": "example-idempotency-key"
  },
  "result": {
    "status": "succeeded",
    "summary": "hello world"
  },
  "proof": {
    "payment_header_present": true,
    "receipt_header_present": true,
    "reconciliation": {
      "prediction_held": true,
      "mismatch_score": 0
    }
  },
  "links": {
    "status": "https://x402.agoragentic.com/status.json",
    "discovery_check": "https://agoragentic.com/api/discovery/check"
  }
}
```

## Minimal test case

A small Node test is enough to prove the schema works and catches missing required receipt fields.

```js
import test from "node:test";
import assert from "node:assert/strict";
import Ajv from "ajv";
import addFormats from "ajv-formats";

import schema from "../schema/receipt.schema.json" with { type: "json" };

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const validate = ajv.compile(schema);

test("valid x402 receipt passes schema validation", () => {
  const receipt = {
    receipt_id: "rcpt_example_text_summarizer",
    schema: "agoragentic.x402.receipt.v1",
    example_only: true,
    service: {
      slug: "text-summarizer",
      resource: "https://x402.agoragentic.com/v1/text-summarizer",
      payment_protocol: "x402"
    },
    payment: {
      network: "base",
      asset: "USDC",
      amount_usdc: "0.10",
      settlement_status: "settled"
    },
    request: {
      input_hash: "sha256:example",
      idempotency_key: "example-idempotency-key"
    },
    result: {
      status: "succeeded",
      summary: "hello world"
    },
    proof: {
      payment_header_present: true,
      receipt_header_present: true,
      reconciliation: {
        prediction_held: true,
        mismatch_score: 0
      }
    }
  };

  assert.equal(validate(receipt), true, JSON.stringify(validate.errors, null, 2));
});

test("missing receipt_id fails schema validation", () => {
  const receipt = {
    schema: "agoragentic.x402.receipt.v1",
    service: {
      slug: "text-summarizer",
      resource: "https://x402.agoragentic.com/v1/text-summarizer",
      payment_protocol: "x402"
    },
    payment: {
      network: "base",
      asset: "USDC",
      amount_usdc: "0.10",
      settlement_status: "settled"
    },
    request: {
      input_hash: "sha256:example",
      idempotency_key: "example-idempotency-key"
    },
    result: {
      status: "succeeded"
    },
    proof: {
      payment_header_present: true,
      receipt_header_present: true,
      reconciliation: {
        prediction_held: true,
        mismatch_score: 0
      }
    }
  };

  assert.equal(validate(receipt), false);
  assert.ok(validate.errors?.some((error) => error.instancePath === "" && error.keyword === "required"));
});
```

## Suggested acceptance criteria

- add `x402/schema/receipt.schema.json`
- normalize `examples/x402/text-summarizer-receipt.example.json` to use `schema: "agoragentic.x402.receipt.v1"`
- add a minimal validation test using Ajv or the repo’s preferred validator
- wire the test into CI so receipt drift is caught automatically
- document that integrations emitting x402 receipts should conform to this schema

## Notes on scope

This proposal is intentionally narrow:

- it does not attempt to unify every receipt-like artifact in the repo
- it does not change Harness Core local no-spend receipt semantics
- it only standardizes the x402 receipt contract used by integrations and examples

If this lands, a follow-up issue could define a broader normalized receipt family covering routed execution receipts, local no-spend receipts, and x402 receipts under a shared top-level convention.