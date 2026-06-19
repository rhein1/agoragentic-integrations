#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from textwrap import dedent


@dataclass(frozen=True)
class GuideSpec:
    title: str
    output_path: str
    audience: str
    purpose: str


SPEC = GuideSpec(
    title="Packaging API Micro-SaaS Tools as Governed x402 + execute() Capabilities",
    output_path="docs/guides/x402-execute-micro-saas-builders.md",
    audience="API-first micro-SaaS builders",
    purpose=(
        "Show how to expose a narrow API as a governed agent capability with x402 billing, "
        "receipt capture, budget enforcement, and execute()-style invocation."
    ),
)


def fenced(code: str, language: str = "") -> str:
    fence = "```"
    if language:
        return f"{fence}{language}\n{code.rstrip()}\n{fence}"
    return f"{fence}\n{code.rstrip()}\n{fence}"


def compact_json(value: object) -> str:
    return json.dumps(value, indent=2, sort_keys=False)


def build_markdown(spec: GuideSpec) -> str:
    execute_request = {
        "capability": "lead-enrichment.lookup-company-profile",
        "input": {
            "domain": "acme.example",
            "fields": ["company_name", "industry", "employee_range", "linkedin_url"],
        },
        "budget": {
            "max_usd": "2.50",
            "max_steps": 1,
            "currency": "USDC",
        },
        "policy": {
            "require_receipt": True,
            "require_metering": True,
            "deny_network_fanout": True,
        },
        "billing": {
            "payment_method": "x402",
            "max_authorization_usd": "2.50",
        },
        "caller": {
            "service": "growth-orchestrator",
            "run_id": "run_2026_06_18_1905",
        },
    }

    execute_response = {
        "ok": True,
        "output": {
            "company_name": "Acme",
            "industry": "Industrial Automation",
            "employee_range": "51-200",
            "linkedin_url": "https://www.linkedin.com/company/acme",
        },
        "receipt": {
            "receipt_id": "rcpt_01JX402XYZ",
            "capability": "lead-enrichment.lookup-company-profile",
            "provider": "acme-enrichment-api",
            "metering": {
                "billed_usd": "0.75",
                "currency": "USDC",
                "units": 1,
            },
            "x402": {
                "payment_required": False,
                "authorization_usd": "2.50",
                "captured_usd": "0.75",
            },
            "policy": {
                "budget_ok": True,
                "receipt_present": True,
            },
        },
    }

    tool_manifest = {
        "id": "lead-enrichment.lookup-company-profile",
        "title": "Lookup Company Profile",
        "description": "Returns normalized company profile fields for a single domain.",
        "input_schema": {
            "type": "object",
            "properties": {
                "domain": {"type": "string", "description": "Company domain"},
                "fields": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Requested profile fields",
                },
            },
            "required": ["domain"],
            "additionalProperties": False,
        },
        "output_schema": {
            "type": "object",
            "properties": {
                "company_name": {"type": "string"},
                "industry": {"type": "string"},
                "employee_range": {"type": "string"},
                "linkedin_url": {"type": "string"},
            },
            "required": ["company_name"],
            "additionalProperties": True,
        },
        "governance": {
            "receipt_required": True,
            "budget_enforced": True,
            "idempotent": True,
            "side_effects": "none",
        },
        "billing": {
            "protocol": "x402",
            "pricing": {"per_call_usdc": "0.75"},
        },
    }

    python_wrapper = dedent(
        """
        from typing import Any, Dict, Iterable


        def normalize_domain(domain: str) -> str:
            value = domain.strip().lower()
            for prefix in ("https://", "http://"):
                if value.startswith(prefix):
                    value = value[len(prefix):]
            return value.split("/", 1)[0]


        def select_fields(source: Dict[str, Any], fields: Iterable[str]) -> Dict[str, Any]:
            wanted = list(fields) or list(source.keys())
            return {name: source[name] for name in wanted if name in source}


        def execute_lookup_company_profile(payload: Dict[str, Any]) -> Dict[str, Any]:
            domain = normalize_domain(payload["domain"])

            # Replace this block with your existing API call. The key point:
            # keep your business logic unchanged and wrap it in execute()-shaped I/O.
            upstream_result = {
                "company_name": "Acme",
                "industry": "Industrial Automation",
                "employee_range": "51-200",
                "linkedin_url": f"https://www.linkedin.com/company/{domain.split('.', 1)[0]}",
                "source": "example-upstream-api"
            }

            return select_fields(upstream_result, payload.get("fields", []))
        """
    ).strip()

    receipt_example = {
        "receipt_id": "rcpt_01JX402XYZ",
        "request_id": "req_01JEXECUTEABC",
        "capability": "lead-enrichment.lookup-company-profile",
        "status": "succeeded",
        "input_hash": "sha256:2a8d5f6d4c39c7887c6fbd5f632ba7f1f173c8f5e72420d9d7e2f6f42c15bc5a",
        "metering": {
            "started_at": "2026-06-18T19:05:00Z",
            "finished_at": "2026-06-18T19:05:01Z",
            "duration_ms": 863,
            "units": 1,
            "billed_usd": "0.75",
            "currency": "USDC",
        },
        "budget": {
            "authorized_usd": "2.50",
            "captured_usd": "0.75",
            "remaining_usd": "1.75",
            "within_limit": True,
        },
        "provider": {
            "name": "acme-enrichment-api",
            "version": "2026-06-01",
        },
        "policy": {
            "receipt_required": True,
            "metering_required": True,
            "network_fanout_denied": True,
        },
    }

    curl_snippet = dedent(
        """
        curl -X POST https://your-router.example/api/execute \\
          -H 'content-type: application/json' \\
          -d '{
            "capability": "lead-enrichment.lookup-company-profile",
            "input": {
              "domain": "acme.example",
              "fields": ["company_name", "industry", "employee_range"]
            },
            "budget": {
              "max_usd": "2.50",
              "max_steps": 1,
              "currency": "USDC"
            },
            "policy": {
              "require_receipt": true,
              "require_metering": true,
              "deny_network_fanout": true
            },
            "billing": {
              "payment_method": "x402",
              "max_authorization_usd": "2.50"
            }
          }'
        """
    ).strip()

    md = f"""# {spec.title}

This guide shows {spec.audience} how to take an existing narrow API and expose it as a governed agent capability using x402 for payment authorization and an `execute()` flow for invocation, receipts, and budget enforcement.

## Why this pattern works

If you already run a focused API, you do not need to rewrite your product into an "agent." Instead, package one stable API action as a capability with:

- a strict input schema
- a strict output schema
- explicit per-call pricing
- budget limits on every invocation
- receipt generation for every successful execution
- x402-backed authorization and capture

That gives agent builders something reusable and safe to buy, route, and audit.

## What you start with

Assume you already have a single-purpose API operation such as:

- company enrichment
- lead scoring
- OCR extraction
- transcript cleanup
- shipping quote lookup
- fraud signal lookup
- pricing intelligence lookup

The onboarding path below keeps that upstream logic intact.

## Step 1: Pick one API action and make it atomic

The best capability is a single bounded action, not an entire workflow.

Good examples:

- `lead-enrichment.lookup-company-profile`
- `shipping.quote-domestic-rate`
- `ocr.extract-invoice-fields`
- `fraud.score-email-domain`

Bad examples:

- `run-sales-pipeline`
- `do-all-enrichment`
- `fully-automate-backoffice`

A good capability should have:

- one main purpose
- one billable unit
- predictable latency
- predictable side effects, ideally none
- a response shape that can be validated

## Step 2: Describe the capability as a manifest

Publish a machine-readable manifest so routers and orchestrators know how to call your tool safely.

{fenced(compact_json(tool_manifest), "json")}

Key fields:

1. `id`: stable name for routing and receipts
2. `input_schema`: exact contract for callers
3. `output_schema`: exact contract for downstream automation
4. `governance`: declares receipt and budget expectations
5. `billing`: describes x402 pricing so callers can authorize spend before execution

## Step 3: Wrap your existing API in an execute()-shaped function

You do not need to replace your product logic. Wrap it.

{fenced(python_wrapper, "python")}

The wrapper should do four things:

1. validate input
2. call your existing API logic
3. normalize output into the advertised schema
4. return enough context for downstream receipt generation

## Step 4: Accept execute() requests instead of bespoke per-client RPC

A governed capability should be invokable through a stable request envelope.

Example `POST /api/execute` request:

{fenced(compact_json(execute_request), "json")}

Important pieces:

- `capability`: the exact tool being purchased and invoked
- `input`: only the fields your tool needs
- `budget`: hard ceiling for the run
- `policy`: governance flags the router must enforce
- `billing`: tells the system to use x402 authorization before work begins
- `caller`: optional provenance metadata for audit trails

## Step 5: Enforce budget before calling upstreams

Before you hit your own API or any paid dependency:

1. read `budget.max_usd`
2. compare it to your tool price
3. refuse execution if the authorization ceiling is too low
4. meter actual usage
5. capture only the amount actually consumed

This is the main difference between a plain API call and a governed capability:
the budget is part of the request contract, not an afterthought.

A safe execution sequence is:

1. validate schemas
2. authorize spend with x402
3. evaluate policy gates
4. execute the tool
5. meter actual usage
6. generate receipt
7. capture the billed amount
8. return output plus receipt

## Step 6: Return a receipt on every successful execution

The receipt is what makes the capability auditable.

Example execute response:

{fenced(compact_json(execute_response), "json")}

A more complete receipt body can look like this:

{fenced(compact_json(receipt_example), "json")}

Minimum receipt contents to preserve:

- unique `receipt_id`
- `request_id` or equivalent correlation id
- capability name
- status
- metering data
- authorized amount
- captured amount
- policy evaluation result
- provider/version metadata
- input hash or request fingerprint

## Step 7: Hash inputs instead of storing sensitive payloads in receipts

For auditability, store a deterministic fingerprint of the input payload rather than copying raw customer data into the receipt.

Recommended pattern:

1. canonicalize the request input as JSON
2. hash it with SHA-256
3. store `sha256:<digest>` in the receipt

This preserves verifiability while reducing exposure to sensitive payload duplication.

## Step 8: Keep pricing simple and map it to a billable unit

Micro-SaaS tools work best with one obvious unit:

- per call
- per document
- per 1,000 tokens normalized to a single call ceiling
- per lookup
- per minute analyzed
- per image processed

If your existing API has more complex pricing, expose a narrow tier first.
For example:

- `lookup-company-profile` at 0.75 USDC per call
- `lookup-company-profile-premium` at 2.00 USDC per call

This is easier to authorize in advance and easier to audit later.

## Step 9: Keep policies explicit

Good governance rules are visible in the request and reflected in the receipt.

Useful policy flags:

- `require_receipt`
- `require_metering`
- `deny_network_fanout`
- `allow_side_effects: false`
- `max_runtime_ms`
- `max_retries`
- `idempotency_key_required`

This helps marketplaces and orchestrators decide whether your capability is safe to route automatically.

## Step 10: Provide a caller example that works immediately

A builder should be able to try your capability with one request.

Example:

{fenced(curl_snippet, "bash")}

This is enough for an agent router or orchestrator to:

- pre-authorize spend
- run the tool
- attach the receipt to the run log
- stop execution if the budget would be exceeded

## Step 11: Define failure behavior clearly

Your capability should fail in structured ways.

Recommended classes:

- `validation_error`: input does not match schema
- `budget_exceeded`: authorization is below required spend
- `payment_required`: x402 authorization missing or invalid
- `policy_denied`: governance rule prevented execution
- `upstream_error`: your own API failed
- `timeout`: tool exceeded runtime ceiling

A failed run should still return enough metadata for debugging, but should not claim a successful billable receipt unless work was actually completed and metered.

## Step 12: Start with narrow capability coverage, then expand

Do not publish your whole product surface on day one.

Rollout order:

1. one deterministic read-only tool
2. one clearly priced billable unit
3. receipt validation in staging
4. budget enforcement in production
5. additional capability variants after usage proves stable

This reduces integration risk and makes your receipts easier to trust.

## Reference implementation checklist

Use this checklist when packaging a tool:

- [ ] Capability has one bounded job
- [ ] Input schema is strict
- [ ] Output schema is strict
- [ ] Existing API logic is wrapped, not rewritten
- [ ] x402 authorization happens before execution
- [ ] Actual spend is metered after execution
- [ ] Receipt is returned on success
- [ ] Receipt includes authorization and capture data
- [ ] Input payload is hashed for auditability
- [ ] Failure modes are structured
- [ ] Budget ceilings are enforced on every call

## What this unlocks for API builders

Once your API is packaged this way, it becomes easier to use as a reusable agent capability because the runtime can trust four things:

1. the action is bounded
2. the spend is pre-authorized
3. the result is receipt-backed
4. the budget can be enforced automatically

That lowers onboarding friction for orchestrators and marketplaces while letting you monetize the exact API you already operate.

## Suggested next contribution

If you want to extend this guide later, add:

- a provider-side receipt validator
- a JSON Schema validation example
- a minimal test harness for `execute()` request/response contracts
- a multi-capability pricing catalog
"""

    return md.strip() + "\n"


def render_output(spec: GuideSpec, destination: Path) -> str:
    body = build_markdown(spec)
    checksum = hashlib.sha256(body.encode("utf-8")).hexdigest()
    header = dedent(
        f"""
        <!--
        Generated by: {Path(__file__).name}
        Purpose: {spec.purpose}
        SHA256: {checksum}
        -->
        """
    ).strip()
    return header + "\n\n" + body


def write_guide(path: Path) -> Path:
    content = render_output(SPEC, path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


def self_test() -> None:
    guide = render_output(SPEC, Path(SPEC.output_path))
    required_phrases = [
        SPEC.title,
        "POST /api/execute",
        "receipt",
        "x402",
        "budget",
        "governance",
        "API-first micro-SaaS builders",
    ]
    missing = [phrase for phrase in required_phrases if phrase not in guide]
    assert not missing, f"missing expected guide phrases: {missing}"

    assert "lookup-company-profile" in guide
    assert guide.count("## Step ") >= 10
    assert hashlib.sha256(guide.encode("utf-8")).hexdigest()


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate a documentation guide for packaging x402 + execute() micro-SaaS capabilities."
    )
    parser.add_argument(
        "--output",
        default=SPEC.output_path,
        help=f"Path to write the generated markdown (default: {SPEC.output_path})",
    )
    parser.add_argument(
        "--stdout",
        action="store_true",
        help="Print the generated markdown to stdout instead of writing it.",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Run inline self-tests and exit.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])

    if args.check:
        self_test()
        print("self-test: ok")
        return 0

    output_path = Path(args.output)

    if args.stdout:
        sys.stdout.write(render_output(SPEC, output_path))
        return 0

    written = write_guide(output_path)
    self_test()
    print(f"wrote {written}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
