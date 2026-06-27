"""
CrewAI execute() adapter with receipt normalization for llm-agents-radar.

This module exports a CrewAI BaseTool that routes work through Agoragentic
execute(), polls for a receipt when needed, and returns a structured audit-ready
payload that llm-agents-radar can persist.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Type

import requests

try:
    from pydantic import BaseModel, Field
except ImportError:  # pragma: no cover
    class BaseModel:  # type: ignore[override]
        def __init__(self, **kwargs: Any) -> None:
            for key, value in kwargs.items():
                setattr(self, key, value)

    def Field(default: Any = None, **_: Any) -> Any:
        return default

try:
    from crewai.tools import BaseTool
except ImportError:  # pragma: no cover
    try:
        from crewai_tools import BaseTool
    except ImportError:
        class BaseTool:  # type: ignore[override]
            name: str = ""
            description: str = ""
            args_schema: Optional[Type[BaseModel]] = None

            def __init__(self, **kwargs: Any) -> None:
                for key, value in kwargs.items():
                    setattr(self, key, value)


AGORAGENTIC_BASE_URL = os.environ.get("AGORAGENTIC_BASE_URL", "https://agoragentic.com")
RUNNING_STATES = {"queued", "pending", "running", "processing", "accepted"}


class ExecuteReceiptSchema(BaseModel):
    task: str = Field(description="Task name or intent for Agoragentic execute().")
    input_data: Dict[str, Any] = Field(default_factory=dict, description="JSON-compatible input payload.")
    max_cost: Optional[float] = Field(default=None, description="Optional maximum spend in USDC.")
    wait_for_receipt: bool = Field(default=True, description="Poll status until a receipt is available.")
    poll_interval_seconds: float = Field(default=1.0, ge=0.1, description="Seconds between status polls.")
    timeout_seconds: float = Field(default=30.0, ge=1.0, description="Maximum time to wait for a receipt.")
    radar_run_id: Optional[str] = Field(default=None, description="Optional llm-agents-radar run identifier.")
    radar_tags: List[str] = Field(default_factory=list, description="Optional audit tags for downstream tracking.")


class AgoragenticError(RuntimeError):
    """Raised when Agoragentic returns a transport or application error."""


@dataclass
class ReceiptWaitResult:
    status_payload: Optional[Dict[str, Any]]
    receipt_payload: Optional[Dict[str, Any]]
    warning: Optional[str] = None


class AgoragenticClient:
    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: str = AGORAGENTIC_BASE_URL,
        session: Optional[Any] = None,
    ) -> None:
        self.api_key = api_key or os.environ.get("AGORAGENTIC_API_KEY", "")
        self.base_url = base_url.rstrip("/")
        self.session = session or requests.Session()

    @property
    def headers(self) -> Dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    def _request(self, method: str, path: str, **kwargs: Any) -> Dict[str, Any]:
        response = self.session.request(
            method=method,
            url=f"{self.base_url}{path}",
            headers={**self.headers, **kwargs.pop("headers", {})},
            timeout=kwargs.pop("timeout", 30),
            **kwargs,
        )
        try:
            payload = response.json()
        except ValueError:
            payload = {"message": getattr(response, "text", "") or "Non-JSON response from Agoragentic"}

        status_code = getattr(response, "status_code", 500)
        if status_code >= 400:
            message = payload.get("message") or payload.get("error") or getattr(response, "reason", "request failed")
            raise AgoragenticError(f"{status_code} {message}")

        if isinstance(payload, dict) and payload.get("error") and status_code >= 300:
            message = payload.get("message") or payload.get("error")
            raise AgoragenticError(str(message))
        return payload

    def execute(self, task: str, input_data: Optional[Dict[str, Any]] = None, max_cost: Optional[float] = None) -> Dict[str, Any]:
        constraints: Dict[str, Any] = {}
        if max_cost is not None:
            constraints["max_cost"] = max_cost
        return self._request(
            "POST",
            "/api/execute",
            json={"task": task, "input": input_data or {}, "constraints": constraints},
            timeout=90,
        )

    def status(self, invocation_id: str) -> Dict[str, Any]:
        return self._request("GET", f"/api/execute/status/{invocation_id}", timeout=30)

    def receipt(self, receipt_id: str) -> Dict[str, Any]:
        return self._request("GET", f"/api/commerce/receipts/{receipt_id}", timeout=30)

    def wait_for_receipt(
        self,
        invocation_id: str,
        receipt_id: Optional[str] = None,
        poll_interval_seconds: float = 1.0,
        timeout_seconds: float = 30.0,
    ) -> ReceiptWaitResult:
        deadline = time.time() + timeout_seconds
        latest_status: Optional[Dict[str, Any]] = None
        latest_receipt_id = receipt_id

        while time.time() <= deadline:
            if latest_receipt_id:
                return ReceiptWaitResult(
                    status_payload=latest_status,
                    receipt_payload=self.receipt(latest_receipt_id),
                )

            latest_status = self.status(invocation_id)
            latest_receipt_id = latest_status.get("receipt_id") or latest_status.get("receipt") or latest_receipt_id
            state = str(latest_status.get("status", "")).lower()

            if latest_receipt_id and state not in RUNNING_STATES:
                return ReceiptWaitResult(
                    status_payload=latest_status,
                    receipt_payload=self.receipt(latest_receipt_id),
                )

            time.sleep(poll_interval_seconds)

        receipt_payload = self.receipt(latest_receipt_id) if latest_receipt_id else None
        return ReceiptWaitResult(
            status_payload=latest_status,
            receipt_payload=receipt_payload,
            warning=f"Timed out after {timeout_seconds} seconds while waiting for a receipt",
        )


def _first_present(*values: Any) -> Any:
    for value in values:
        if value is not None:
            return value
    return None


def _extract_provider_name(source: Dict[str, Any]) -> Optional[str]:
    provider = source.get("provider")
    if isinstance(provider, dict):
        return provider.get("name") or provider.get("id")
    return provider or source.get("provider_name")


def normalize_receipt(receipt_payload: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not receipt_payload:
        return None

    source = receipt_payload.get("receipt") if isinstance(receipt_payload.get("receipt"), dict) else receipt_payload
    usage = source.get("usage") if isinstance(source.get("usage"), dict) else {}
    settlement = source.get("settlement") if isinstance(source.get("settlement"), dict) else {}

    return {
        "receipt_id": _first_present(source.get("receipt_id"), source.get("id")),
        "invocation_id": source.get("invocation_id"),
        "provider": _extract_provider_name(source),
        "task": source.get("task"),
        "status": _first_present(source.get("status"), settlement.get("status"), settlement.get("state")),
        "cost_usdc": _first_present(source.get("cost"), source.get("price_charged"), source.get("amount")),
        "currency": source.get("currency") or "USDC",
        "created_at": _first_present(source.get("created_at"), source.get("timestamp")),
        "settlement": {
            "network": _first_present(settlement.get("network"), settlement.get("chain"), source.get("network"), source.get("chain")),
            "status": _first_present(settlement.get("status"), settlement.get("state"), source.get("settlement_status")),
            "transaction_hash": _first_present(settlement.get("transaction_hash"), settlement.get("tx_hash"), settlement.get("tx"), source.get("transaction_hash"), source.get("tx_hash")),
        },
        "usage": {
            "input_tokens": _first_present(usage.get("input_tokens"), usage.get("prompt_tokens")),
            "output_tokens": _first_present(usage.get("output_tokens"), usage.get("completion_tokens")),
            "total_tokens": usage.get("total_tokens"),
            "unit_count": _first_present(usage.get("unit_count"), usage.get("requests"), 1),
            "model": usage.get("model"),
        },
        "raw": receipt_payload,
    }


def build_radar_record(
    execution_payload: Dict[str, Any],
    receipt_payload: Optional[Dict[str, Any]] = None,
    radar_run_id: Optional[str] = None,
    radar_tags: Optional[List[str]] = None,
) -> Dict[str, Any]:
    normalized_receipt = normalize_receipt(receipt_payload)
    output = _first_present(
        execution_payload.get("output"),
        execution_payload.get("result"),
        execution_payload.get("response"),
    )

    provider_name = _extract_provider_name(execution_payload)
    if provider_name is None and normalized_receipt:
        provider_name = normalized_receipt.get("provider")

    status = execution_payload.get("status", "accepted")
    invocation_id = _first_present(execution_payload.get("invocation_id"), normalized_receipt and normalized_receipt.get("invocation_id"))
    receipt_id = _first_present(
        execution_payload.get("receipt_id"),
        execution_payload.get("receipt"),
        normalized_receipt and normalized_receipt.get("receipt_id"),
    )
    cost_usdc = _first_present(
        execution_payload.get("cost"),
        execution_payload.get("price_charged"),
        normalized_receipt and normalized_receipt.get("cost_usdc"),
    )

    return {
        "tool": "agoragentic_execute",
        "status": status,
        "task": execution_payload.get("task"),
        "provider": provider_name,
        "invocation_id": invocation_id,
        "receipt_id": receipt_id,
        "cost_usdc": cost_usdc,
        "result": output,
        "receipt": normalized_receipt,
        "radar": {
            "run_id": radar_run_id,
            "tags": radar_tags or [],
            "audit_line": render_radar_audit_line(
                task=execution_payload.get("task"),
                provider=provider_name,
                invocation_id=invocation_id,
                receipt_id=receipt_id,
                status=status,
                cost_usdc=cost_usdc,
                total_tokens=((normalized_receipt or {}).get("usage") or {}).get("total_tokens"),
            ),
        },
    }


def render_radar_audit_line(
    task: Optional[str],
    provider: Optional[str],
    invocation_id: Optional[str],
    receipt_id: Optional[str],
    status: Optional[str],
    cost_usdc: Optional[Any],
    total_tokens: Optional[Any],
) -> str:
    segments = [
        f"task={task or 'unknown'}",
        f"provider={provider or 'unknown'}",
        f"status={status or 'unknown'}",
        f"invocation_id={invocation_id or 'missing'}",
        f"receipt_id={receipt_id or 'missing'}",
        f"cost_usdc={cost_usdc if cost_usdc is not None else 'unknown'}",
        f"total_tokens={total_tokens if total_tokens is not None else 'unknown'}",
    ]
    return " | ".join(segments)


class AgoragenticRadarExecuteTool(BaseTool):
    name: str = "agoragentic_execute"
    description: str = (
        "Route work through Agoragentic execute(), wait for a receipt when requested, "
        "and return a structured llm-agents-radar audit record."
    )
    args_schema: Type[BaseModel] = ExecuteReceiptSchema
    api_key: str = ""
    base_url: str = AGORAGENTIC_BASE_URL
    session: Optional[Any] = None

    def _client(self) -> AgoragenticClient:
        return AgoragenticClient(api_key=self.api_key, base_url=self.base_url, session=self.session)

    def _run(
        self,
        task: str,
        input_data: Optional[Dict[str, Any]] = None,
        max_cost: Optional[float] = None,
        wait_for_receipt: bool = True,
        poll_interval_seconds: float = 1.0,
        timeout_seconds: float = 30.0,
        radar_run_id: Optional[str] = None,
        radar_tags: Optional[List[str]] = None,
    ) -> str:
        client = self._client()
        execution_payload = client.execute(task=task, input_data=input_data or {}, max_cost=max_cost)
        receipt_payload = None
        receipt_id = _first_present(execution_payload.get("receipt_id"), execution_payload.get("receipt"))

        if receipt_id:
            receipt_payload = client.receipt(str(receipt_id))
        elif wait_for_receipt and execution_payload.get("invocation_id"):
            wait_result = client.wait_for_receipt(
                invocation_id=str(execution_payload["invocation_id"]),
                receipt_id=None,
                poll_interval_seconds=poll_interval_seconds,
                timeout_seconds=timeout_seconds,
            )
            if wait_result.status_payload:
                execution_payload = {**execution_payload, **wait_result.status_payload}
            if wait_result.warning:
                execution_payload["warning"] = wait_result.warning
            receipt_payload = wait_result.receipt_payload

        record = build_radar_record(
            execution_payload=execution_payload,
            receipt_payload=receipt_payload,
            radar_run_id=radar_run_id,
            radar_tags=radar_tags,
        )
        if execution_payload.get("warning"):
            record["warning"] = execution_payload["warning"]
        return json.dumps(record, indent=2, sort_keys=True)


def build_llm_agents_radar_example(
    api_key: Optional[str] = None,
    base_url: str = AGORAGENTIC_BASE_URL,
) -> Dict[str, Any]:
    try:
        from crewai import Agent, Crew, Task
    except ImportError as exc:  # pragma: no cover
        raise ImportError("CrewAI is required to build the example crew. Install with: pip install crewai") from exc

    tool = AgoragenticRadarExecuteTool(api_key=api_key or "", base_url=base_url)
    agent = Agent(
        role="llm-agents-radar dispatcher",
        goal="Run external tools through Agoragentic and keep receipt-backed audit records.",
        backstory="You monitor and log agent tool activity with durable invocation and receipt evidence.",
        tools=[tool],
        verbose=True,
    )
    task = Task(
        description=(
            "Use agoragentic_execute to run the task 'weather' with latitude 40.7128 and longitude -74.0060. "
            "Return the full audit record including radar.audit_line, invocation_id, receipt_id, cost_usdc, result, and receipt."
        ),
        expected_output="A JSON object containing the execution result and a receipt-backed radar audit record.",
        agent=agent,
    )
    crew = Crew(agents=[agent], tasks=[task], verbose=True)
    return {"agent": agent, "task": task, "crew": crew}


class _MockResponse:
    def __init__(self, payload: Dict[str, Any], status_code: int = 200) -> None:
        self._payload = payload
        self.status_code = status_code
        self.reason = "OK"
        self.text = json.dumps(payload)

    def json(self) -> Dict[str, Any]:
        return self._payload


class _MockSession:
    def __init__(self) -> None:
        self.status_calls = 0
        self.requests: List[Dict[str, Any]] = []

    def request(self, method: str, url: str, **kwargs: Any) -> _MockResponse:
        self.requests.append({"method": method, "url": url, "json": kwargs.get("json")})

        if url.endswith("/api/execute") and method == "POST":
            payload = kwargs["json"]
            return _MockResponse(
                {
                    "status": "accepted",
                    "task": payload["task"],
                    "invocation_id": "inv_radar_123",
                    "provider": {"id": "provider.weather", "name": "Weather Provider"},
                    "output": {"forecast": "sunny", "temperature_f": 71},
                }
            )

        if url.endswith("/api/execute/status/inv_radar_123") and method == "GET":
            self.status_calls += 1
            if self.status_calls == 1:
                return _MockResponse(
                    {
                        "status": "running",
                        "invocation_id": "inv_radar_123",
                    }
                )
            return _MockResponse(
                {
                    "status": "completed",
                    "invocation_id": "inv_radar_123",
                    "provider": {"id": "provider.weather", "name": "Weather Provider"},
                    "receipt_id": "rcpt_radar_456",
                }
            )

        if url.endswith("/api/commerce/receipts/rcpt_radar_456") and method == "GET":
            return _MockResponse(
                {
                    "receipt": {
                        "receipt_id": "rcpt_radar_456",
                        "invocation_id": "inv_radar_123",
                        "provider": {"id": "provider.weather", "name": "Weather Provider"},
                        "task": "weather",
                        "status": "completed",
                        "cost": 0.02,
                        "currency": "USDC",
                        "created_at": "2026-06-27T15:00:00Z",
                        "settlement": {
                            "network": "base",
                            "status": "confirmed",
                            "transaction_hash": "0xabc123",
                        },
                        "usage": {
                            "input_tokens": 120,
                            "output_tokens": 45,
                            "total_tokens": 165,
                            "unit_count": 1,
                            "model": "example-model",
                        },
                    }
                }
            )

        return _MockResponse({"message": f"Unhandled route: {method} {url}"}, status_code=404)


def _self_test() -> Dict[str, Any]:
    session = _MockSession()
    tool = AgoragenticRadarExecuteTool(
        api_key="amk_test",
        base_url="https://mock.agoragentic.local",
        session=session,
    )
    rendered = tool._run(
        task="weather",
        input_data={"latitude": 40.7128, "longitude": -74.0060},
        max_cost=0.05,
        wait_for_receipt=True,
        poll_interval_seconds=0.01,
        timeout_seconds=1.0,
        radar_run_id="radar_run_001",
        radar_tags=["demo", "weather"],
    )
    payload = json.loads(rendered)

    assert payload["tool"] == "agoragentic_execute"
    assert payload["status"] == "completed"
    assert payload["provider"] == "Weather Provider"
    assert payload["invocation_id"] == "inv_radar_123"
    assert payload["receipt_id"] == "rcpt_radar_456"
    assert payload["result"]["forecast"] == "sunny"
    assert payload["receipt"]["settlement"]["network"] == "base"
    assert payload["receipt"]["usage"]["total_tokens"] == 165
    assert payload["radar"]["run_id"] == "radar_run_001"
    assert "receipt_id=rcpt_radar_456" in payload["radar"]["audit_line"]
    assert len(session.requests) >= 3
    return payload


def main() -> None:
    print(json.dumps(_self_test(), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
