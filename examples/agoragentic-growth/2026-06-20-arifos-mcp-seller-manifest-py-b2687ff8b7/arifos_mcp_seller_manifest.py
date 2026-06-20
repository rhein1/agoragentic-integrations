#!/usr/bin/env python3
# demo — moves no real funds

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import secrets
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Tuple


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def stable_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def estimate_tokens(payload: Any) -> int:
    text = stable_json(payload)
    return max(1, len(text) // 4)


def make_idempotency_key(seed: Optional[str] = None) -> str:
    material = seed or f"{time.time_ns()}:{os.getpid()}:{secrets.token_hex(8)}"
    return f"idem_{sha256_text(material)[:24]}"


@dataclass
class ToolSpec:
    name: str
    description: str
    input_schema: Dict[str, Any]
    handler: Callable[[Dict[str, Any]], Any]


class UsageReceiptError(RuntimeError):
    pass


class LocalArifosExecutor:
    def __init__(self, seller_id: str = "arifos.local", version: str = "0.1.0") -> None:
        self.seller_id = seller_id
        self.version = version
        self._tools: Dict[str, ToolSpec] = {}
        self._receipts_by_key: Dict[Tuple[str, str], Dict[str, Any]] = {}
        self._results_by_key: Dict[Tuple[str, str], Any] = {}
        self._register_builtin_tools()

    def _register_builtin_tools(self) -> None:
        self.register_tool(
            ToolSpec(
                name="arifos.normalize_text",
                description="Trim whitespace, collapse runs of spaces, and optionally lowercase text.",
                input_schema={
                    "type": "object",
                    "properties": {
                        "text": {"type": "string", "minLength": 1},
                        "lowercase": {"type": "boolean", "default": False},
                    },
                    "required": ["text"],
                    "additionalProperties": False,
                },
                handler=self._normalize_text,
            )
        )
        self.register_tool(
            ToolSpec(
                name="arifos.extract_keywords",
                description="Return unique keywords from text using a small local heuristic.",
                input_schema={
                    "type": "object",
                    "properties": {
                        "text": {"type": "string", "minLength": 1},
                        "min_length": {"type": "integer", "minimum": 2, "default": 4},
                        "limit": {"type": "integer", "minimum": 1, "maximum": 50, "default": 12},
                    },
                    "required": ["text"],
                    "additionalProperties": False,
                },
                handler=self._extract_keywords,
            )
        )

    def register_tool(self, spec: ToolSpec) -> None:
        self._tools[spec.name] = spec

    def manifest(self, base_url: str = "http://localhost:8787") -> Dict[str, Any]:
        tools = []
        for spec in self._tools.values():
            tools.append(
                {
                    "name": spec.name,
                    "description": spec.description,
                    "input_schema": spec.input_schema,
                    "pricing": {
                        "model": "usage_receipt",
                        "currency": "USD",
                        "unit": "call",
                        "amount": "0.0000",
                        "note": "local demo; emits receipts but charges nothing",
                    },
                    "usage_receipts": {
                        "enabled": True,
                        "format": "agoragentic.usage-receipt/v1",
                        "fields": [
                            "receipt_id",
                            "idempotency_key",
                            "tool",
                            "started_at",
                            "finished_at",
                            "duration_ms",
                            "input_sha256",
                            "output_sha256",
                            "usage",
                            "outcome",
                        ],
                    },
                }
            )

        return {
            "schema_version": "agoragentic.marketplace.manifest/v1alpha1",
            "seller": {
                "id": self.seller_id,
                "name": "Arifos Local MCP Seller Template",
                "version": self.version,
                "contact": "maintainer@example.invalid",
            },
            "listing": {
                "slug": "arifos-local-mcp-template",
                "title": "Arifos local MCP capability template",
                "summary": "Sample seller listing manifest with local execute() wrapper and usage receipts.",
                "visibility": "draft",
                "categories": ["mcp", "tooling", "receipts"],
                "tags": ["arifos", "mcp", "usage-receipts", "local-wrapper"],
            },
            "capability": {
                "protocol": "mcp",
                "transport": {
                    "mode": "local-wrapper",
                    "execute_endpoint": f"{base_url.rstrip('/')}/execute",
                    "note": "This sample runs locally in-process and emits receipts for each call.",
                },
                "tools": tools,
            },
            "trust": {
                "receipt_examples_available": True,
                "data_retention": "none-by-default",
                "network_required": False,
                "payment_note": "No real payment is authorized or settled by this sample.",
            },
            "examples": {
                "manifest_cmd": f"{os.path.basename(sys.argv[0])} manifest",
                "execute_cmd": f"{os.path.basename(sys.argv[0])} execute arifos.normalize_text --args '{json.dumps({'text': '  Hello   Marketplace  ', 'lowercase': True})}'",
            },
        }

    def execute(self, tool_name: str, args: Dict[str, Any], idempotency_key: Optional[str] = None) -> Dict[str, Any]:
        if tool_name not in self._tools:
            raise UsageReceiptError(f"unknown tool: {tool_name}")

        key = (tool_name, idempotency_key or make_idempotency_key(stable_json(args)))
        if key in self._receipts_by_key:
            return {
                "result": self._results_by_key[key],
                "usage_receipt": self._receipts_by_key[key],
                "reused_idempotent_result": True,
            }

        started = time.time()
        started_at = utc_now()
        input_digest = sha256_text(stable_json(args))

        spec = self._tools[tool_name]
        self._validate_args(spec.input_schema, args)
        result = spec.handler(args)

        finished = time.time()
        finished_at = utc_now()
        duration_ms = int(round((finished - started) * 1000))
        output_digest = sha256_text(stable_json(result))

        usage = {
            "calls": 1,
            "input_tokens_est": estimate_tokens(args),
            "output_tokens_est": estimate_tokens(result),
        }

        receipt = {
            "schema": "agoragentic.usage-receipt/v1",
            "receipt_id": f"ur_{sha256_text(f'{key[1]}:{tool_name}:{finished_ns() }')[:24]}",
            "seller_id": self.seller_id,
            "tool": tool_name,
            "idempotency_key": key[1],
            "started_at": started_at,
            "finished_at": finished_at,
            "duration_ms": duration_ms,
            "input_sha256": input_digest,
            "output_sha256": output_digest,
            "usage": usage,
            "outcome": "ok",
            "payment": {
                "required": False,
                "authorized": False,
                "settled": False,
                "note": "demo only; no real funds moved",
            },
            "environment": {
                "python": platform.python_version(),
                "platform": platform.platform(),
            },
        }

        self._receipts_by_key[key] = receipt
        self._results_by_key[key] = result
        return {
            "result": result,
            "usage_receipt": receipt,
            "reused_idempotent_result": False,
        }

    def _normalize_text(self, args: Dict[str, Any]) -> Dict[str, Any]:
        text = " ".join(args["text"].split())
        if args.get("lowercase", False):
            text = text.lower()
        return {
            "text": text,
            "length": len(text),
        }

    def _extract_keywords(self, args: Dict[str, Any]) -> Dict[str, Any]:
        raw = args["text"]
        min_length = int(args.get("min_length", 4))
        limit = int(args.get("limit", 12))
        stop = {
            "about", "after", "again", "also", "and", "are", "been", "before", "being",
            "between", "could", "from", "have", "into", "just", "more", "most", "other",
            "over", "same", "such", "that", "their", "there", "these", "they", "this",
            "those", "very", "what", "when", "where", "which", "while", "with", "would",
            "your",
        }
        cleaned = []
        token = []
        for ch in raw:
            if ch.isalnum():
                token.append(ch.lower())
            else:
                if token:
                    cleaned.append("".join(token))
                    token = []
        if token:
            cleaned.append("".join(token))

        seen = set()
        keywords: List[str] = []
        for word in cleaned:
            if len(word) < min_length or word in stop or word.isdigit():
                continue
            if word not in seen:
                seen.add(word)
                keywords.append(word)
            if len(keywords) >= limit:
                break

        return {
            "keywords": keywords,
            "count": len(keywords),
        }

    def _validate_args(self, schema: Dict[str, Any], args: Dict[str, Any]) -> None:
        if schema.get("type") != "object" or not isinstance(args, dict):
            raise UsageReceiptError("arguments must be an object")

        allowed = set(schema.get("properties", {}).keys())
        required = set(schema.get("required", []))
        additional_ok = schema.get("additionalProperties", True)

        missing = sorted(required - set(args.keys()))
        if missing:
            raise UsageReceiptError(f"missing required argument(s): {', '.join(missing)}")

        if not additional_ok:
            extra = sorted(set(args.keys()) - allowed)
            if extra:
                raise UsageReceiptError(f"unexpected argument(s): {', '.join(extra)}")

        for key, value in args.items():
            prop = schema.get("properties", {}).get(key)
            if prop is None:
                continue
            self._validate_type(key, value, prop)

    def _validate_type(self, key: str, value: Any, prop: Dict[str, Any]) -> None:
        kind = prop.get("type")
        if kind == "string":
            if not isinstance(value, str):
                raise UsageReceiptError(f"{key} must be a string")
            if "minLength" in prop and len(value) < int(prop["minLength"]):
                raise UsageReceiptError(f"{key} must be at least {prop['minLength']} characters")
        elif kind == "boolean":
            if not isinstance(value, bool):
                raise UsageReceiptError(f"{key} must be a boolean")
        elif kind == "integer":
            if isinstance(value, bool) or not isinstance(value, int):
                raise UsageReceiptError(f"{key} must be an integer")
            if "minimum" in prop and value < int(prop["minimum"]):
                raise UsageReceiptError(f"{key} must be >= {prop['minimum']}")
            if "maximum" in prop and value > int(prop["maximum"]):
                raise UsageReceiptError(f"{key} must be <= {prop['maximum']}")


def finished_ns() -> int:
    return time.time_ns()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Sample MCP seller listing manifest with local execute() wrapper and usage receipts."
    )
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("manifest", help="Print the sample seller listing manifest as JSON")

    ex = sub.add_parser("execute", help="Execute a local tool and print result + usage receipt as JSON")
    ex.add_argument("tool", help="Tool name, e.g. arifos.normalize_text")
    ex.add_argument("--args", default="{}", help="JSON object of tool arguments")
    ex.add_argument("--idempotency-key", default=None, help="Optional idempotency key to reuse receipts")

    sub.add_parser("selftest", help="Run a small inline self-test")

    return parser


def run_selftest() -> None:
    executor = LocalArifosExecutor()
    manifest = executor.manifest()
    assert manifest["capability"]["protocol"] == "mcp"
    assert manifest["capability"]["tools"], "expected at least one tool"

    first = executor.execute(
        "arifos.normalize_text",
        {"text": "  Hello   Receipts  ", "lowercase": True},
        idempotency_key="demo-key-1",
    )
    second = executor.execute(
        "arifos.normalize_text",
        {"text": "  Hello   Receipts  ", "lowercase": True},
        idempotency_key="demo-key-1",
    )

    assert first["result"]["text"] == "hello receipts"
    assert first["usage_receipt"]["payment"]["settled"] is False
    assert second["reused_idempotent_result"] is True
    assert first["usage_receipt"]["receipt_id"] == second["usage_receipt"]["receipt_id"]

    print("selftest: ok")
    print(json.dumps(first, indent=2, sort_keys=True))


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    executor = LocalArifosExecutor()

    if args.command == "manifest":
        print(json.dumps(executor.manifest(), indent=2, sort_keys=True))
        return 0

    if args.command == "execute":
        try:
            payload = json.loads(args.args)
        except json.JSONDecodeError as exc:
            print(f"invalid --args JSON: {exc}", file=sys.stderr)
            return 2
        if not isinstance(payload, dict):
            print("--args must decode to a JSON object", file=sys.stderr)
            return 2
        try:
            result = executor.execute(args.tool, payload, idempotency_key=args.idempotency_key)
        except UsageReceiptError as exc:
            print(str(exc), file=sys.stderr)
            return 2
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0

    if args.command == "selftest":
        run_selftest()
        return 0

    parser.error("unknown command")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
