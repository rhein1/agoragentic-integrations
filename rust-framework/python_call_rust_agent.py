#!/usr/bin/env python3
"""Call a local Agoragentic Rust Framework runtime over HTTP/JSON."""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from typing import Any, Dict, Optional


BASE_URL = os.environ.get("AGORAGENTIC_RUST_AGENT_URL", "http://127.0.0.1:8080").rstrip("/")


def request_json(path: str, method: str = "GET", body: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    if not BASE_URL.startswith(("http://", "https://")):
        raise ValueError("AGORAGENTIC_RUST_AGENT_URL must be an http(s) URL")

    payload = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        f"{BASE_URL}{path}",
        data=payload,
        method=method,
        headers={"Content-Type": "application/json"},
    )

    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{path} failed with HTTP {exc.code}: {detail}") from exc


def main() -> int:
    health = request_json("/health")
    tools = request_json("/tools")
    openapi = request_json("/openapi.json")

    typed_request = {
        "request_id": "req_public_python_example",
        "agent_id": health.get("agent_id", "rust-agent"),
        "task": "summarize",
        "input": {
            "text": "Rust agents expose HTTP/JSON contracts for Python callers."
        },
        "trace": {"trace_id": "trace_public_python_example"},
        "limits": {"timeout_ms": 30000, "max_cost_usdc": 0},
    }

    typed_invoke = request_json("/invoke", method="POST", body=typed_request)
    raw_invoke = request_json(
        "/invoke",
        method="POST",
        body={
            "text": "Raw JSON payloads remain compatible with simple marketplace-style callers."
        },
    )

    summary = {
        "runtime": {
            "framework": health.get("framework"),
            "framework_version": health.get("framework_version"),
            "transport": health.get("runtime", {}).get("transport"),
            "harness_compatible": health.get("runtime", {}).get("harness_compatible") is True,
        },
        "tools_count": len(tools.get("tools", [])) if isinstance(tools.get("tools"), list) else 0,
        "openapi_paths": sorted((openapi.get("paths") or {}).keys()),
        "typed_invoke": {
            "status": typed_invoke.get("status"),
            "request_id": typed_invoke.get("request_id"),
            "trace_id": (typed_invoke.get("trace") or {}).get("trace_id"),
        },
        "raw_invoke": {
            "status": raw_invoke.get("status"),
            "request_id": raw_invoke.get("request_id"),
        },
        "authority_boundary": {
            "hosted_router_execute_changed": False,
            "direct_invoke_changed": False,
            "wallet_spend_enabled": False,
            "x402_settlement_enabled": False,
            "marketplace_publication_enabled": False,
            "trust_mutation_enabled": False,
            "native_bindings_required": False,
        },
    }

    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # pragma: no cover - command-line error path
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
