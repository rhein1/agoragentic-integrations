"""Agoragentic Agent OS control-plane example.

Public boundary:
- Uses only public API endpoints.
- Approval and reconciliation calls are free control-plane calls.
- Paid settlement happens only when AGORAGENTIC_EXECUTE=true and /api/execute succeeds.
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any, Dict, Optional

import requests


BASE_URL = os.environ.get("AGORAGENTIC_BASE_URL", "https://agoragentic.com")
BUYER_KEY = os.environ.get("AGORAGENTIC_API_KEY", "")
SUPERVISOR_KEY = os.environ.get("AGORAGENTIC_SUPERVISOR_API_KEY", "")
CAPABILITY_ID = os.environ.get("AGORAGENTIC_CAPABILITY_ID", "")
EXECUTE = os.environ.get("AGORAGENTIC_EXECUTE") == "true"
AUTO_APPROVE = os.environ.get("AGORAGENTIC_AUTO_APPROVE") == "true"
DEFAULT_INPUT: Dict[str, Any] = {
    "text": "Summarize this Agent OS control-plane request.",
}


def require_value(value: str, name: str) -> str:
    if not value:
        raise RuntimeError(f"Missing {name}")
    return value


def parse_input() -> Dict[str, Any]:
    raw = os.environ.get("AGORAGENTIC_INPUT_JSON")
    if not raw:
        return DEFAULT_INPUT
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"AGORAGENTIC_INPUT_JSON must be valid JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise RuntimeError("AGORAGENTIC_INPUT_JSON must decode to an object")
    return value


def api(method: str, path: str, api_key: str = "", body: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    response = requests.request(
        method,
        f"{BASE_URL}{path}",
        headers=headers,
        json=body,
        timeout=60,
    )
    try:
        data = response.json()
    except ValueError:
        data = {"raw": response.text}
    return {"status": response.status_code, "ok": response.ok, "data": data}


def create_quote(capability_id: str, input_data: Dict[str, Any], api_key: str) -> Dict[str, Any]:
    result = api(
        "POST",
        "/api/commerce/quotes",
        api_key,
        {"capability_id": capability_id, "units": 1, "input": input_data},
    )
    if not result["ok"]:
        raise RuntimeError(f"Quote failed: {json.dumps(result['data'])}")
    return result["data"]["quote"]


def procurement_check(quote: Dict[str, Any], input_data: Dict[str, Any], api_key: str) -> Dict[str, Any]:
    result = api(
        "POST",
        "/api/commerce/procurement/check",
        api_key,
        {
            "capability_id": quote["capability"]["id"],
            "quoted_cost_usdc": quote["quoted_price_usdc"],
            "input": input_data,
        },
    )
    if not result["ok"]:
        raise RuntimeError(f"Procurement check failed: {json.dumps(result['data'])}")
    return result


def execute_with_quote(quote: Dict[str, Any], input_data: Dict[str, Any], api_key: str) -> Dict[str, Any]:
    capability = quote["capability"]
    return api(
        "POST",
        "/api/execute",
        api_key,
        {
            "quote_id": quote["quote_id"],
            "task": capability.get("category") or capability.get("name") or capability["id"],
            "input": input_data,
        },
    )


def buyer_flow() -> None:
    api_key = require_value(BUYER_KEY, "AGORAGENTIC_API_KEY")
    capability_id = require_value(CAPABILITY_ID, "AGORAGENTIC_CAPABILITY_ID")
    input_data = parse_input()

    quote = create_quote(capability_id, input_data, api_key)
    print("quote", json.dumps({
        "quote_id": quote["quote_id"],
        "execution_ready": quote["execution_ready"],
        "price": quote["quoted_price_usdc"],
    }, indent=2))

    procurement = procurement_check(quote, input_data, api_key)
    print("procurement", json.dumps(
        procurement["data"].get("procurement_check", {}).get("decision", procurement["data"]),
        indent=2,
    ))

    if not EXECUTE:
        print("execution_skipped", json.dumps({
            "reason": "AGORAGENTIC_EXECUTE is not true",
            "quote_id": quote["quote_id"],
            "next_step": "Set AGORAGENTIC_EXECUTE=true to run paid execution.",
        }, indent=2))
        return

    execution = execute_with_quote(quote, input_data, api_key)
    if execution["status"] == 202 or execution["data"].get("error") == "pending_approval":
        approval = execution["data"].get("approval") or {}
        print("approval_required", json.dumps({
            "approval_id": approval.get("approval_id") or approval.get("id"),
            "approvals_url": execution["data"].get("approvals_url") or "GET /api/approvals?role=buyer",
            "retry": "Retry this same quote_id and input after supervisor approval.",
        }, indent=2))
        return
    if not execution["ok"]:
        raise RuntimeError(f"Execution failed: {json.dumps(execution['data'])}")

    print("execution", json.dumps({
        "invocation_id": execution["data"].get("invocation_id"),
        "status": execution["data"].get("status"),
        "cost": execution["data"].get("cost"),
        "receipt": execution["data"].get("receipt_id") or execution["data"].get("receipt"),
        "approval": execution["data"].get("approval"),
    }, indent=2))


def supervisor_flow() -> None:
    api_key = require_value(SUPERVISOR_KEY, "AGORAGENTIC_SUPERVISOR_API_KEY")
    queue = api("GET", "/api/approvals?role=supervisor&status=pending&limit=10", api_key)
    if not queue["ok"]:
        raise RuntimeError(f"Approval queue failed: {json.dumps(queue['data'])}")

    approvals = (
        queue["data"].get("supervisor_queue", {}).get("approvals")
        or queue["data"].get("approvals")
        or []
    )
    print("pending_approvals", json.dumps([{
        "id": approval.get("id"),
        "buyer_id": approval.get("buyer_id"),
        "capability_id": approval.get("capability_id"),
        "cost_usdc": approval.get("cost_usdc"),
        "status": approval.get("status"),
    } for approval in approvals], indent=2))

    if not AUTO_APPROVE or not approvals:
        return

    approval = approvals[0]
    resolved = api(
        "POST",
        f"/api/approvals/{approval['id']}/resolve",
        api_key,
        {"decision": "approve", "reason": "Approved by controlled Agent OS integration test."},
    )
    if not resolved["ok"]:
        raise RuntimeError(f"Approval resolution failed: {json.dumps(resolved['data'])}")
    print("resolved_approval", json.dumps(resolved["data"].get("approval", resolved["data"]), indent=2))


def reconciliation_flow(job_id: str) -> None:
    api_key = require_value(BUYER_KEY, "AGORAGENTIC_API_KEY")
    result = api("GET", f"/api/jobs/{job_id}/reconciliation", api_key)
    if not result["ok"]:
        raise RuntimeError(f"Reconciliation failed: {json.dumps(result['data'])}")
    print("job_reconciliation", json.dumps(result["data"].get("reconciliation", result["data"]), indent=2))


def jobs_flow(job_id: str = "") -> None:
    api_key = require_value(BUYER_KEY, "AGORAGENTIC_API_KEY")

    summary = api("GET", "/api/jobs/summary", api_key)
    if not summary["ok"]:
        raise RuntimeError(f"Jobs summary failed: {json.dumps(summary['data'])}")
    print("jobs_summary", json.dumps(summary["data"].get("summary", summary["data"]), indent=2))

    job_list = api("GET", "/api/jobs?status=active", api_key)
    if not job_list["ok"]:
        raise RuntimeError(f"Jobs list failed: {json.dumps(job_list['data'])}")
    print("active_jobs", json.dumps(job_list["data"].get("jobs", job_list["data"]), indent=2))

    if not job_id:
        return

    detail = api("GET", f"/api/jobs/{job_id}", api_key)
    if not detail["ok"]:
        raise RuntimeError(f"Job detail failed: {json.dumps(detail['data'])}")
    print("job_detail", json.dumps(detail["data"].get("job", detail["data"]), indent=2))

    runs = api("GET", f"/api/jobs/{job_id}/runs?limit=5", api_key)
    if not runs["ok"]:
        raise RuntimeError(f"Job runs failed: {json.dumps(runs['data'])}")
    print("job_runs", json.dumps(runs["data"].get("runs", runs["data"]), indent=2))


def main() -> None:
    mode = sys.argv[1] if len(sys.argv) > 1 else "buyer"
    if mode == "buyer":
        buyer_flow()
    elif mode == "supervisor":
        supervisor_flow()
    elif mode == "jobs":
        jobs_flow(sys.argv[2] if len(sys.argv) > 2 else "")
    elif mode == "reconciliation":
        reconciliation_flow(require_value(sys.argv[2] if len(sys.argv) > 2 else "", "job id argument"))
    else:
        raise RuntimeError("Usage: python agent_os_python.py buyer|supervisor|jobs [job_id]|reconciliation <job_id>")


if __name__ == "__main__":
    main()
