"""
LangGraph execute() adapter for Agoragentic with runnable demo, error handling,
and local receipt generation.

This file is importable without LangGraph installed; the demo falls back to a
minimal local runner when langgraph is unavailable.
"""

from __future__ import annotations

import json
import hashlib
import os
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterable, Mapping, MutableMapping, Optional, TypedDict

import requests

try:
    from langchain_core.tools import tool
except Exception:  # pragma: no cover
    def tool(func: Callable[..., Any]) -> Callable[..., Any]:
        return func

try:
    from langgraph.graph import END, START, StateGraph

    HAS_LANGGRAPH = True
except Exception:  # pragma: no cover
    END = "__end__"
    START = "__start__"
    StateGraph = None
    HAS_LANGGRAPH = False


AGORAGENTIC_BASE_URL = os.environ.get("AGORAGENTIC_BASE_URL", "https://agoragentic.com")
DEFAULT_RETRYABLE_STATUS_CODES = frozenset({408, 409, 425, 429, 500, 502, 503, 504})
SUCCESS_EXECUTION_STATUSES = frozenset({"completed", "succeeded", "success"})
FAILED_EXECUTION_STATUSES = frozenset({"failed", "error", "cancelled"})
TERMINAL_EXECUTION_STATUSES = SUCCESS_EXECUTION_STATUSES | FAILED_EXECUTION_STATUSES


class AgoragenticError(RuntimeError):
    """Base class for adapter failures."""


@dataclass
class AgoragenticAPIError(AgoragenticError):
    message: str
    status_code: Optional[int] = None
    payload: Optional[Any] = None

    def __str__(self) -> str:
        if self.status_code is None:
            return self.message
        return f"{self.message} (status={self.status_code})"


class AgoragenticRetryExhausted(AgoragenticAPIError):
    """Raised when retry budget is exhausted."""


class AgoragenticExecutionFailed(AgoragenticAPIError):
    """Raised when execute() reaches a failed terminal state."""


class AgoragenticTimeout(AgoragenticAPIError):
    """Raised when execution never reaches a terminal state."""


@dataclass
class ExecutionReceipt:
    receipt_id: str
    adapter: str
    task: str
    status: str
    started_at: float
    finished_at: float
    duration_ms: int
    invocation_id: Optional[str] = None
    remote_receipt_id: Optional[str] = None
    remote_receipt: Optional[Dict[str, Any]] = None
    attempts: int = 1
    input_preview: Dict[str, Any] = field(default_factory=dict)
    output_preview: Dict[str, Any] = field(default_factory=dict)
    error: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "receipt_id": self.receipt_id,
            "adapter": self.adapter,
            "task": self.task,
            "status": self.status,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "duration_ms": self.duration_ms,
            "invocation_id": self.invocation_id,
            "remote_receipt_id": self.remote_receipt_id,
            "remote_receipt": self.remote_receipt,
            "attempts": self.attempts,
            "input_preview": self.input_preview,
            "output_preview": self.output_preview,
            "error": self.error,
            "metadata": self.metadata,
        }


class AgoragenticLangGraphClient:
    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: str = AGORAGENTIC_BASE_URL,
        *,
        session: Optional[requests.Session] = None,
        request_timeout: int = 30,
        execute_timeout: int = 90,
        max_retries: int = 3,
        backoff_base: float = 0.5,
        poll_interval: float = 1.0,
        max_status_checks: int = 60,
        sleep: Callable[[float], None] = time.sleep,
        retryable_status_codes: Iterable[int] = DEFAULT_RETRYABLE_STATUS_CODES,
    ):
        self.api_key = api_key or os.environ.get("AGORAGENTIC_API_KEY", "")
        self.base_url = base_url.rstrip("/")
        self.session = session or requests.Session()
        self.request_timeout = request_timeout
        self.execute_timeout = execute_timeout
        self.max_retries = max_retries
        self.backoff_base = backoff_base
        self.poll_interval = poll_interval
        self.max_status_checks = max_status_checks
        self.sleep = sleep
        self.retryable_status_codes = frozenset(retryable_status_codes)
        self.last_request_attempts = 0

    @property
    def headers(self) -> Dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    def _sleep_for_attempt(self, attempt_index: int) -> None:
        if attempt_index <= 0:
            return
        self.sleep(self.backoff_base * (2 ** (attempt_index - 1)))

    @staticmethod
    def _stable_json(value: Any) -> str:
        return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)

    @classmethod
    def _idempotency_key(cls, task: str, input_data: Mapping[str, Any], constraints: Mapping[str, Any]) -> str:
        fingerprint = hashlib.sha256(
            cls._stable_json({"task": task, "input": dict(input_data), "constraints": dict(constraints)}).encode("utf-8")
        ).hexdigest()[:24]
        slug = "".join(ch.lower() if ch.isalnum() else "_" for ch in task).strip("_") or "task"
        return f"idem_{slug}_{fingerprint}"

    @staticmethod
    def _safe_payload(response: requests.Response) -> Any:
        try:
            return response.json()
        except ValueError:
            return response.text

    @staticmethod
    def _extract_error_message(payload: Any) -> str:
        if isinstance(payload, dict):
            for key in ("message", "error", "detail"):
                value = payload.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()
        if isinstance(payload, str):
            return payload.strip()
        return ""

    @staticmethod
    def _execution_status(payload: Any) -> str:
        if not isinstance(payload, dict):
            return ""
        value = payload.get("status") or payload.get("state")
        if isinstance(value, str):
            return value.strip().lower()
        return ""

    @classmethod
    def _is_failed_execution_payload(cls, payload: Any) -> bool:
        if not isinstance(payload, dict):
            return False
        if payload.get("success") is False or payload.get("ok") is False:
            return True
        status = cls._execution_status(payload)
        return status in FAILED_EXECUTION_STATUSES

    @staticmethod
    def _invocation_id(payload: Any) -> Optional[str]:
        if not isinstance(payload, dict):
            return None
        for key in ("invocation_id", "execution_id", "id"):
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        return None

    @staticmethod
    def _receipt_id(payload: Any) -> Optional[str]:
        if not isinstance(payload, dict):
            return None
        for key in ("receipt_id", "receiptId"):
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        nested = payload.get("receipt")
        if isinstance(nested, dict):
            for key in ("id", "receipt_id", "receiptId"):
                value = nested.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()
        if isinstance(nested, str) and nested.strip():
            return nested.strip()
        return None

    def _request(
        self,
        method: str,
        path: str,
        *,
        timeout: Optional[int] = None,
        retryable_status_codes: Optional[Iterable[int]] = None,
        **kwargs: Any,
    ) -> Any:
        retryable_codes = frozenset(retryable_status_codes or self.retryable_status_codes)
        request_headers = dict(self.headers)
        extra_headers = kwargs.pop("headers", None)
        if extra_headers:
            request_headers.update(extra_headers)

        last_error: Optional[BaseException] = None
        last_payload: Any = None
        last_status_code: Optional[int] = None

        for attempt in range(self.max_retries + 1):
            self.last_request_attempts = attempt + 1
            try:
                response = self.session.request(
                    method=method,
                    url=f"{self.base_url}{path}",
                    headers=request_headers,
                    timeout=timeout or self.request_timeout,
                    **kwargs,
                )
            except (requests.Timeout, requests.ConnectionError) as exc:
                last_error = exc
                if attempt >= self.max_retries:
                    raise AgoragenticRetryExhausted(
                        message="Agoragentic request failed after retries",
                        payload={"error": str(exc), "path": path, "method": method},
                    ) from exc
                self._sleep_for_attempt(attempt + 1)
                continue

            payload = self._safe_payload(response)
            if response.ok:
                return payload

            last_payload = payload
            last_status_code = response.status_code
            if response.status_code in retryable_codes and attempt < self.max_retries:
                self._sleep_for_attempt(attempt + 1)
                continue

            message = self._extract_error_message(payload) or f"Agoragentic request failed for {path}"
            error_cls = AgoragenticRetryExhausted if response.status_code in retryable_codes else AgoragenticAPIError
            raise error_cls(message=message, status_code=response.status_code, payload=payload)

        raise AgoragenticRetryExhausted(
            message="Agoragentic request failed after retries",
            status_code=last_status_code,
            payload=last_payload or {"error": str(last_error) if last_error else "unknown error"},
        )

    def match(self, task: str, max_cost: Optional[float] = None, category: str = "") -> Dict[str, Any]:
        params: Dict[str, Any] = {"task": task}
        if max_cost is not None:
            params["max_cost"] = max_cost
        if category:
            params["category"] = category
        return self._request("GET", "/api/execute/match", params=params)

    def execute(
        self,
        task: str,
        input_data: Optional[Dict[str, Any]] = None,
        constraints: Optional[Dict[str, Any]] = None,
        *,
        wait_for_completion: bool = True,
        status_poll_interval: Optional[float] = None,
        max_status_checks: Optional[int] = None,
    ) -> Dict[str, Any]:
        if not task or not task.strip():
            raise ValueError("task is required")

        payload = {
            "task": task,
            "input": input_data or {},
            "constraints": constraints or {},
        }
        idempotency_key = self._idempotency_key(task, input_data or {}, constraints or {})
        execution = self._request(
            "POST",
            "/api/execute",
            json=payload,
            timeout=self.execute_timeout,
            headers={"Idempotency-Key": idempotency_key},
        )
        attempts = self.last_request_attempts
        if isinstance(execution, dict):
            execution.setdefault("_adapter_attempts", attempts)
            execution.setdefault("_adapter_idempotency_key", idempotency_key)
        if self._is_failed_execution_payload(execution):
            raise AgoragenticExecutionFailed(
                message=self._extract_error_message(execution) or "Agoragentic execution failed",
                payload=execution,
            )
        if not wait_for_completion:
            return execution

        status = self._execution_status(execution)
        if status in SUCCESS_EXECUTION_STATUSES or not status:
            return execution
        if status in FAILED_EXECUTION_STATUSES:
            raise AgoragenticExecutionFailed(
                message=self._extract_error_message(execution) or "Agoragentic execution failed",
                payload=execution,
            )

        invocation_id = self._invocation_id(execution)
        if not invocation_id:
            return execution

        checks_remaining = max_status_checks if max_status_checks is not None else self.max_status_checks
        interval = self.poll_interval if status_poll_interval is None else status_poll_interval

        for _ in range(checks_remaining):
            self.sleep(interval)
            execution = self.status(invocation_id)
            attempts += self.last_request_attempts
            if isinstance(execution, dict):
                execution.setdefault("_adapter_attempts", attempts)
                execution.setdefault("_adapter_idempotency_key", idempotency_key)
                execution.setdefault("invocation_id", invocation_id)
            if self._is_failed_execution_payload(execution):
                raise AgoragenticExecutionFailed(
                    message=self._extract_error_message(execution) or "Agoragentic execution failed",
                    payload=execution,
                )
            status = self._execution_status(execution)
            if status in SUCCESS_EXECUTION_STATUSES or not status:
                return execution
            if status in FAILED_EXECUTION_STATUSES:
                raise AgoragenticExecutionFailed(
                    message=self._extract_error_message(execution) or "Agoragentic execution failed",
                    payload=execution,
                )

        raise AgoragenticTimeout(
            message=f"Execution {invocation_id} did not complete after {checks_remaining} status checks",
            payload={
                "invocation_id": invocation_id,
                "status": status or "timeout",
                "_adapter_attempts": attempts,
                "_adapter_idempotency_key": idempotency_key,
            },
        )

    def status(self, invocation_id: str) -> Dict[str, Any]:
        if not invocation_id or not invocation_id.strip():
            raise ValueError("invocation_id is required")
        return self._request("GET", f"/api/execute/status/{invocation_id.strip()}")

    def receipt(self, receipt_id: str) -> Dict[str, Any]:
        if not receipt_id or not receipt_id.strip():
            raise ValueError("receipt_id is required")
        return self._request("GET", f"/api/commerce/receipts/{receipt_id.strip()}")


class ExecuteState(TypedDict, total=False):
    task: str
    input: Dict[str, Any]
    constraints: Dict[str, Any]
    status: str
    result: Dict[str, Any]
    receipt: Dict[str, Any]
    error: str
    recovery: Dict[str, Any]
    fetch_remote_receipt: bool


class LangGraphExecuteAdapter:
    def __init__(self, client: AgoragenticLangGraphClient, *, adapter_name: str = "agoragentic_langgraph_execute"):
        self.client = client
        self.adapter_name = adapter_name

    @staticmethod
    def _preview_map(data: Any, *, max_items: int = 8, max_string: int = 160) -> Dict[str, Any]:
        if not isinstance(data, Mapping):
            if data is None:
                return {}
            return {"value": LangGraphExecuteAdapter._preview_value(data, max_string=max_string)}
        preview: Dict[str, Any] = {}
        for index, (key, value) in enumerate(data.items()):
            if index >= max_items:
                preview["..."] = f"{len(data) - max_items} more keys"
                break
            preview[str(key)] = LangGraphExecuteAdapter._preview_value(value, max_string=max_string)
        return preview

    @staticmethod
    def _preview_value(value: Any, *, max_string: int = 160) -> Any:
        if isinstance(value, str):
            return value if len(value) <= max_string else value[: max_string - 3] + "..."
        if isinstance(value, (int, float, bool)) or value is None:
            return value
        if isinstance(value, Mapping):
            return {str(k): LangGraphExecuteAdapter._preview_value(v, max_string=max_string) for k, v in list(value.items())[:5]}
        if isinstance(value, list):
            return [LangGraphExecuteAdapter._preview_value(v, max_string=max_string) for v in value[:5]]
        return repr(value)

    def _build_receipt(
        self,
        *,
        task: str,
        input_data: Optional[Dict[str, Any]],
        started_at: float,
        finished_at: float,
        result: Optional[Dict[str, Any]] = None,
        error: Optional[str] = None,
        remote_receipt: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        invocation_id = self.client._invocation_id(result) if result else None
        remote_receipt_id = self.client._receipt_id(result) if result else None
        status = self.client._execution_status(result) if result else "error"
        if status not in TERMINAL_EXECUTION_STATUSES:
            status = "completed" if error is None else "error"

        receipt = ExecutionReceipt(
            receipt_id=f"local-{uuid.uuid4().hex}",
            adapter=self.adapter_name,
            task=task,
            status=status,
            started_at=started_at,
            finished_at=finished_at,
            duration_ms=max(0, int(round((finished_at - started_at) * 1000))),
            invocation_id=invocation_id,
            remote_receipt_id=remote_receipt_id,
            remote_receipt=remote_receipt,
            attempts=max(1, int((result or {}).get("_adapter_attempts") or 1)),
            input_preview=self._preview_map(input_data or {}),
            output_preview=self._preview_map((result or {}).get("output", result or {})),
            error=error,
            metadata={
                "base_url": self.client.base_url,
                "has_remote_receipt": bool(remote_receipt_id),
            },
        )
        return receipt.as_dict()

    def execute(self, state: ExecuteState) -> ExecuteState:
        task = (state.get("task") or "").strip()
        if not task:
            raise ValueError("state.task is required")

        input_data = dict(state.get("input") or {})
        constraints = dict(state.get("constraints") or {})
        started_at = time.time()

        try:
            result = self.client.execute(task=task, input_data=input_data, constraints=constraints, wait_for_completion=True)
            remote_receipt: Optional[Dict[str, Any]] = None
            if state.get("fetch_remote_receipt", True):
                remote_receipt_id = self.client._receipt_id(result)
                if remote_receipt_id:
                    try:
                        remote_receipt = self.client.receipt(remote_receipt_id)
                    except AgoragenticError as receipt_error:
                        remote_receipt = {"fetch_error": str(receipt_error), "receipt_id": remote_receipt_id}

            finished_at = time.time()
            receipt = self._build_receipt(
                task=task,
                input_data=input_data,
                started_at=started_at,
                finished_at=finished_at,
                result=result,
                remote_receipt=remote_receipt,
            )
            return {
                **state,
                "status": "completed",
                "result": result,
                "receipt": receipt,
                "error": "",
            }
        except AgoragenticError as exc:
            finished_at = time.time()
            payload = exc.payload if isinstance(exc, AgoragenticAPIError) and isinstance(exc.payload, dict) else {}
            receipt = self._build_receipt(
                task=task,
                input_data=input_data,
                started_at=started_at,
                finished_at=finished_at,
                result=payload or None,
                error=str(exc),
            )
            return {
                **state,
                "status": "error",
                "result": payload,
                "receipt": receipt,
                "error": str(exc),
            }

    @staticmethod
    def route_after_execute(state: ExecuteState) -> str:
        return "recover" if state.get("status") == "error" else "done"

    @staticmethod
    def recover(state: ExecuteState) -> ExecuteState:
        receipt = state.get("receipt") or {}
        return {
            **state,
            "recovery": {
                "recommended_action": "Inspect receipt.error, invocation_id, and remote receipt metadata before retrying.",
                "receipt_id": receipt.get("receipt_id"),
                "invocation_id": receipt.get("invocation_id"),
                "error": state.get("error", ""),
            }
        }


def build_agoragentic_langgraph_tools(api_key: Optional[str] = None) -> list[Callable[..., Dict[str, Any]]]:
    client = AgoragenticLangGraphClient(api_key=api_key)

    @tool
    def agoragentic_match(task: str, max_cost: Optional[float] = None, category: str = "") -> Dict[str, Any]:
        """Preview routed providers before execution."""
        return client.match(task=task, max_cost=max_cost, category=category)

    @tool
    def agoragentic_execute(
        task: str,
        input_data: Optional[Dict[str, Any]] = None,
        max_cost: Optional[float] = None,
        wait_for_completion: bool = True,
    ) -> Dict[str, Any]:
        """Execute work through Agoragentic with retrying transport and completion polling."""
        constraints: Dict[str, Any] = {}
        if max_cost is not None:
            constraints["max_cost"] = max_cost
        result = client.execute(
            task=task,
            input_data=input_data or {},
            constraints=constraints,
            wait_for_completion=wait_for_completion,
        )
        if isinstance(result, dict):
            result.setdefault("invocation_id", client._invocation_id(result))
            result.setdefault("receipt_id", client._receipt_id(result))
        return result

    @tool
    def agoragentic_status(invocation_id: str) -> Dict[str, Any]:
        """Fetch execution status for an invocation."""
        return client.status(invocation_id)

    @tool
    def agoragentic_receipt(receipt_id: str) -> Dict[str, Any]:
        """Fetch remote receipt metadata."""
        return client.receipt(receipt_id)

    return [agoragentic_match, agoragentic_execute, agoragentic_status, agoragentic_receipt]


class _LocalCompiledGraph:
    def __init__(self, adapter: LangGraphExecuteAdapter):
        self.adapter = adapter

    def invoke(self, state: ExecuteState) -> ExecuteState:
        state = self.adapter.execute(state)
        if self.adapter.route_after_execute(state) == "recover":
            state = self.adapter.recover(state)
        return state


def build_execute_graph(adapter: LangGraphExecuteAdapter) -> Any:
    if not HAS_LANGGRAPH:
        return _LocalCompiledGraph(adapter)

    builder = StateGraph(ExecuteState)
    builder.add_node("execute", adapter.execute)
    builder.add_node("recover", adapter.recover)
    builder.add_edge(START, "execute")
    builder.add_conditional_edges(
        "execute",
        adapter.route_after_execute,
        {
            "done": END,
            "recover": "recover",
        },
    )
    builder.add_edge("recover", END)
    return builder.compile()


class _FakeResponse:
    def __init__(self, status_code: int, payload: Any):
        self.status_code = status_code
        self._payload = payload
        self.ok = 200 <= status_code < 300
        self.text = payload if isinstance(payload, str) else repr(payload)

    def json(self) -> Any:
        if isinstance(self._payload, Exception):
            raise self._payload
        return self._payload


class _FakeSession:
    def __init__(self, responses: list[_FakeResponse]):
        self._responses = list(responses)
        self.calls: list[Dict[str, Any]] = []

    def request(self, method: str, url: str, **kwargs: Any) -> _FakeResponse:
        self.calls.append({"method": method, "url": url, **kwargs})
        if not self._responses:
            raise AssertionError("No fake responses remaining")
        return self._responses.pop(0)


def _test_success_graph_receipt() -> None:
    session = _FakeSession(
        [
            _FakeResponse(200, {"invocation_id": "inv-123", "status": "queued"}),
            _FakeResponse(503, {"error": "temporary upstream outage"}),
            _FakeResponse(
                200,
                {
                    "invocation_id": "inv-123",
                    "status": "completed",
                    "output": {"answer": "done"},
                    "receipt_id": "rcpt-123",
                },
            ),
            _FakeResponse(
                200,
                {
                    "receipt_id": "rcpt-123",
                    "kind": "demo_receipt",
                    "status": "available",
                },
            ),
        ]
    )
    sleeps: list[float] = []
    client = AgoragenticLangGraphClient(
        api_key="amk_test",
        session=session,
        sleep=sleeps.append,
        poll_interval=0.0,
        backoff_base=0.0,
        max_retries=2,
    )
    adapter = LangGraphExecuteAdapter(client)
    graph = build_execute_graph(adapter)

    result = graph.invoke(
        {
            "task": "summarize customer notes",
            "input": {"text": "hello world"},
            "constraints": {"max_cost": 0.05},
            "fetch_remote_receipt": True,
        }
    )

    assert result["status"] == "completed"
    assert result["result"]["output"] == {"answer": "done"}
    assert result["receipt"]["remote_receipt_id"] == "rcpt-123"
    assert result["receipt"]["remote_receipt"]["kind"] == "demo_receipt"
    assert result["receipt"]["attempts"] == 3
    assert len(session.calls) == 4
    assert session.calls[0]["headers"]["Idempotency-Key"].startswith("idem_summarize_customer_notes_")
    assert session.calls[1]["url"].endswith("/api/execute/status/inv-123")
    assert session.calls[2]["url"].endswith("/api/execute/status/inv-123")
    assert session.calls[3]["url"].endswith("/api/commerce/receipts/rcpt-123")
    assert sleeps == [0.0, 0.0]


def _test_failure_graph_routes_recovery() -> None:
    session = _FakeSession(
        [
            _FakeResponse(200, {"invocation_id": "inv-999", "status": "queued"}),
            _FakeResponse(
                200,
                {
                    "invocation_id": "inv-999",
                    "status": "failed",
                    "error": "provider timeout",
                },
            ),
        ]
    )
    client = AgoragenticLangGraphClient(
        api_key="amk_test",
        session=session,
        sleep=lambda _: None,
        poll_interval=0.0,
        backoff_base=0.0,
        max_retries=1,
    )
    adapter = LangGraphExecuteAdapter(client)
    graph = build_execute_graph(adapter)

    result = graph.invoke(
        {
            "task": "classify inbound email",
            "input": {"subject": "Need help"},
            "constraints": {"max_cost": 0.01},
        }
    )

    assert result["status"] == "error"
    assert "provider timeout" in result["error"]
    assert result["recovery"]["recommended_action"].startswith("Inspect receipt.error")
    assert result["receipt"]["status"] == "failed"


def _test_documented_execute_failure_payload() -> None:
    session = _FakeSession([_FakeResponse(200, {"success": False, "error": "budget approval required"})])
    client = AgoragenticLangGraphClient(
        api_key="amk_test",
        session=session,
        sleep=lambda _: None,
        poll_interval=0.0,
        backoff_base=0.0,
        max_retries=1,
    )
    adapter = LangGraphExecuteAdapter(client)
    graph = build_execute_graph(adapter)

    result = graph.invoke(
        {
            "task": "summarize customer notes",
            "input": {"text": "hello world"},
            "constraints": {"max_cost": 0.05},
        }
    )

    assert result["status"] == "error"
    assert "budget approval required" in result["error"]
    assert result["receipt"]["attempts"] == 1


def _test_string_receipt_reference() -> None:
    session = _FakeSession(
        [
            _FakeResponse(200, {"invocation_id": "inv-string", "status": "completed", "receipt": "rcpt-string"}),
            _FakeResponse(200, {"receipt_id": "rcpt-string", "kind": "demo_receipt"}),
        ]
    )
    client = AgoragenticLangGraphClient(
        api_key="amk_test",
        session=session,
        sleep=lambda _: None,
        poll_interval=0.0,
        backoff_base=0.0,
        max_retries=1,
    )
    adapter = LangGraphExecuteAdapter(client)
    graph = build_execute_graph(adapter)

    result = graph.invoke(
        {
            "task": "summarize customer notes",
            "input": {"text": "hello world"},
            "constraints": {"max_cost": 0.05},
        }
    )

    assert result["status"] == "completed"
    assert result["receipt"]["remote_receipt_id"] == "rcpt-string"
    assert session.calls[1]["url"].endswith("/api/commerce/receipts/rcpt-string")


def _test_timeout_preserves_invocation_id() -> None:
    session = _FakeSession(
        [
            _FakeResponse(200, {"invocation_id": "inv-timeout", "status": "queued"}),
            _FakeResponse(200, {"invocation_id": "inv-timeout", "status": "queued"}),
        ]
    )
    client = AgoragenticLangGraphClient(
        api_key="amk_test",
        session=session,
        sleep=lambda _: None,
        poll_interval=0.0,
        backoff_base=0.0,
        max_retries=1,
        max_status_checks=1,
    )
    adapter = LangGraphExecuteAdapter(client)
    graph = build_execute_graph(adapter)

    result = graph.invoke(
        {
            "task": "summarize customer notes",
            "input": {"text": "hello world"},
            "constraints": {"max_cost": 0.05},
        }
    )

    assert result["status"] == "error"
    assert result["receipt"]["invocation_id"] == "inv-timeout"
    assert result["recovery"]["invocation_id"] == "inv-timeout"
    assert result["receipt"]["attempts"] == 2


def _demo_success_run() -> Dict[str, Any]:
    session = _FakeSession(
        [
            _FakeResponse(200, {"invocation_id": "demo-inv-1", "status": "queued"}),
            _FakeResponse(
                200,
                {
                    "invocation_id": "demo-inv-1",
                    "status": "completed",
                    "output": {
                        "summary": "Three action items identified.",
                        "priority": "high",
                    },
                    "receipt_id": "demo-rcpt-1",
                },
            ),
            _FakeResponse(
                200,
                {
                    "receipt_id": "demo-rcpt-1",
                    "kind": "demo_receipt",
                    "verification": "simulated",
                },
            ),
        ]
    )
    client = AgoragenticLangGraphClient(
        api_key="amk_demo",
        session=session,
        sleep=lambda _: None,
        poll_interval=0.0,
        backoff_base=0.0,
        max_retries=1,
    )
    adapter = LangGraphExecuteAdapter(client)
    graph = build_execute_graph(adapter)
    return graph.invoke(
        {
            "task": "triage support inbox",
            "input": {
                "messages": [
                    "Customer cannot log in after password reset.",
                    "Enterprise prospect requests pricing details.",
                    "Refund requested for duplicate charge.",
                ]
            },
            "constraints": {"max_cost": 0.15},
            "fetch_remote_receipt": True,
        }
    )


def main() -> None:
    _test_success_graph_receipt()
    _test_failure_graph_routes_recovery()
    _test_documented_execute_failure_payload()
    _test_string_receipt_reference()
    _test_timeout_preserves_invocation_id()
    demo = _demo_success_run()
    print(json.dumps({"langgraph_installed": HAS_LANGGRAPH, "demo_result": demo}, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
