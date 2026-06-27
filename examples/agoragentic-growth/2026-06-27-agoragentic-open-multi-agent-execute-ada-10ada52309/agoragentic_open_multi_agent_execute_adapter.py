#!/usr/bin/env python3
"""
Agoragentic adapter for LangGraph workflows that need to execute
open-multi-agent style tasks through Agoragentic's execute() route,
then preserve usage receipts in graph state.

Runtime dependencies: Python standard library only.
Optional integrations:
- langchain-core: build a @tool wrapper
- langgraph: build a StateGraph demo

Environment:
    AGORAGENTIC_API_KEY=amk_your_key
    AGORAGENTIC_BASE_URL=https://agoragentic.com
"""

from __future__ import annotations

import copy
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterable, List, Mapping, MutableMapping, Optional, Sequence, Tuple

AGORAGENTIC_BASE_URL = os.environ.get("AGORAGENTIC_BASE_URL", "https://agoragentic.com").rstrip("/")
PENDING_STATUSES = {"queued", "pending", "running", "processing", "accepted", "in_progress"}
TERMINAL_ERROR_STATUSES = {"failed", "error", "cancelled", "rejected", "timed_out"}


@dataclass
class HTTPResult:
    status_code: int
    headers: Dict[str, str]
    json_body: Any
    text_body: str = ""


class HTTPTransport:
    def request(
        self,
        method: str,
        url: str,
        *,
        headers: Optional[Mapping[str, str]] = None,
        json_payload: Any = None,
        timeout: float = 30.0,
    ) -> HTTPResult:
        raise NotImplementedError


class UrllibTransport(HTTPTransport):
    def request(
        self,
        method: str,
        url: str,
        *,
        headers: Optional[Mapping[str, str]] = None,
        json_payload: Any = None,
        timeout: float = 30.0,
    ) -> HTTPResult:
        payload_bytes = None
        outbound_headers = {"Accept": "application/json"}
        if headers:
            outbound_headers.update(dict(headers))
        if json_payload is not None:
            payload_bytes = json.dumps(json_payload).encode("utf-8")
            outbound_headers.setdefault("Content-Type", "application/json")
        request = urllib.request.Request(
            url=url,
            data=payload_bytes,
            headers=outbound_headers,
            method=method.upper(),
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                body = response.read().decode("utf-8")
                return HTTPResult(
                    status_code=response.getcode(),
                    headers=dict(response.headers.items()),
                    json_body=_safe_json_loads(body),
                    text_body=body,
                )
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8")
            return HTTPResult(
                status_code=exc.code,
                headers=dict(exc.headers.items()) if exc.headers else {},
                json_body=_safe_json_loads(body),
                text_body=body,
            )
        except urllib.error.URLError as exc:
            raise AgoragenticNetworkError(f"Network error while calling {url}: {exc.reason}") from exc


class StubTransport(HTTPTransport):
    def __init__(self, routes: Mapping[Tuple[str, str], Any]):
        self.routes = dict(routes)
        self.calls: List[Dict[str, Any]] = []

    def request(
        self,
        method: str,
        url: str,
        *,
        headers: Optional[Mapping[str, str]] = None,
        json_payload: Any = None,
        timeout: float = 30.0,
    ) -> HTTPResult:
        del timeout
        parsed = urllib.parse.urlparse(url)
        route_key = (method.upper(), parsed.path)
        if route_key not in self.routes:
            raise AssertionError(f"No stubbed route for {route_key}")
        route = self.routes[route_key]
        request_snapshot = {
            "method": method.upper(),
            "path": parsed.path,
            "query": urllib.parse.parse_qs(parsed.query),
            "headers": dict(headers or {}),
            "json_payload": copy.deepcopy(json_payload),
        }
        self.calls.append(request_snapshot)
        result = route(request_snapshot) if callable(route) else route
        if isinstance(result, HTTPResult):
            return result
        return HTTPResult(status_code=200, headers={"Content-Type": "application/json"}, json_body=result, text_body=json.dumps(result))


class AgoragenticError(RuntimeError):
    pass


class AgoragenticStateError(AgoragenticError):
    pass


class AgoragenticNetworkError(AgoragenticError):
    pass


class AgoragenticAPIError(AgoragenticError):
    def __init__(self, status_code: int, message: str, payload: Any = None, *, headers: Optional[Mapping[str, str]] = None):
        super().__init__(message)
        self.status_code = status_code
        self.payload = payload
        self.headers = dict(headers or {})


@dataclass
class UsageReceipt:
    receipt_id: Optional[str]
    invocation_id: Optional[str]
    provider: Optional[str]
    status: Optional[str]
    cost_usdc: Optional[float]
    currency: str
    created_at: Optional[str]
    settlement: Dict[str, Any]
    usage: Dict[str, Any]
    raw: Any = field(repr=False)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "receipt_id": self.receipt_id,
            "invocation_id": self.invocation_id,
            "provider": self.provider,
            "status": self.status,
            "cost_usdc": self.cost_usdc,
            "currency": self.currency,
            "created_at": self.created_at,
            "settlement": copy.deepcopy(self.settlement),
            "usage": copy.deepcopy(self.usage),
            "raw": copy.deepcopy(self.raw),
        }


class AgoragenticExecuteClient:
    def __init__(
        self,
        api_key: Optional[str] = None,
        *,
        base_url: str = AGORAGENTIC_BASE_URL,
        transport: Optional[HTTPTransport] = None,
        timeout_seconds: float = 30.0,
    ):
        self.api_key = api_key or os.environ.get("AGORAGENTIC_API_KEY", "")
        self.base_url = base_url.rstrip("/")
        self.transport = transport or UrllibTransport()
        self.timeout_seconds = timeout_seconds

    @property
    def headers(self) -> Dict[str, str]:
        headers = {"Accept": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    def _request(
        self,
        method: str,
        path: str,
        *,
        query: Optional[Mapping[str, Any]] = None,
        json_payload: Any = None,
        timeout: Optional[float] = None,
    ) -> Dict[str, Any]:
        url = self.base_url + path
        if query:
            encoded = urllib.parse.urlencode(
                [(key, value) for key, value in query.items() if value is not None],
                doseq=True,
            )
            if encoded:
                url = f"{url}?{encoded}"
        result = self.transport.request(
            method,
            url,
            headers=self.headers,
            json_payload=json_payload,
            timeout=timeout or self.timeout_seconds,
        )
        if result.status_code >= 400:
            message = _extract_error_message(result.json_body) or f"Agoragentic returned HTTP {result.status_code}"
            raise AgoragenticAPIError(result.status_code, message, result.json_body, headers=result.headers)
        if not isinstance(result.json_body, dict):
            raise AgoragenticAPIError(result.status_code, "Expected JSON object response", result.json_body, headers=result.headers)
        return result.json_body

    def match(
        self,
        task: str,
        *,
        max_cost: Optional[float] = None,
        category: Optional[str] = None,
        tags: Optional[Iterable[str]] = None,
    ) -> Dict[str, Any]:
        query: Dict[str, Any] = {"task": task}
        if max_cost is not None:
            query["max_cost"] = max_cost
        if category:
            query["category"] = category
        tag_values = [tag for tag in (tags or []) if tag]
        if tag_values:
            query["tags"] = ",".join(tag_values)
        return self._request("GET", "/api/execute/match", query=query)

    def execute(
        self,
        task: str,
        *,
        input_data: Optional[Mapping[str, Any]] = None,
        constraints: Optional[Mapping[str, Any]] = None,
    ) -> Dict[str, Any]:
        payload = {
            "task": task,
            "input": dict(input_data or {}),
            "constraints": dict(constraints or {}),
        }
        return self._request("POST", "/api/execute", json_payload=payload, timeout=max(self.timeout_seconds, 90.0))

    def status(self, invocation_id: str) -> Dict[str, Any]:
        return self._request("GET", f"/api/execute/status/{invocation_id}")

    def receipt(self, receipt_id: str) -> Dict[str, Any]:
        return self._request("GET", f"/api/commerce/receipts/{receipt_id}")

    def wait_for_receipt(
        self,
        invocation_id: str,
        *,
        receipt_id: Optional[str] = None,
        poll_interval_seconds: float = 1.0,
        timeout_seconds: float = 60.0,
    ) -> Dict[str, Any]:
        deadline = time.time() + timeout_seconds
        latest_status: Optional[Dict[str, Any]] = None
        current_receipt_id = receipt_id
        while time.time() <= deadline:
            if current_receipt_id:
                receipt_payload = self.receipt(current_receipt_id)
                return {"status": latest_status, "receipt": receipt_payload, "timed_out": False}
            latest_status = self.status(invocation_id)
            current_receipt_id = _extract_receipt_id(latest_status) or current_receipt_id
            status_name = str(latest_status.get("status", "")).lower()
            if status_name in TERMINAL_ERROR_STATUSES:
                return {"status": latest_status, "receipt": None, "timed_out": False}
            if current_receipt_id and status_name not in PENDING_STATUSES:
                return {"status": latest_status, "receipt": self.receipt(current_receipt_id), "timed_out": False}
            time.sleep(max(0.0, poll_interval_seconds))
        result: Dict[str, Any] = {"status": latest_status, "receipt": None, "timed_out": True}
        if current_receipt_id:
            result["receipt"] = self.receipt(current_receipt_id)
        return result


def normalize_receipt(receipt_payload: Optional[Dict[str, Any]]) -> Optional[UsageReceipt]:
    if not receipt_payload:
        return None
    source = receipt_payload.get("receipt", receipt_payload)
    if not isinstance(source, Mapping):
        return None

    provider_name = _provider_name(source.get("provider")) or _provider_name(source.get("selected_provider"))
    settlement_source = source.get("settlement") if isinstance(source.get("settlement"), Mapping) else source
    usage_source = source.get("usage") if isinstance(source.get("usage"), Mapping) else {}

    return UsageReceipt(
        receipt_id=_as_optional_str(source.get("receipt_id") or source.get("id")),
        invocation_id=_as_optional_str(source.get("invocation_id") or source.get("invocation")),
        provider=provider_name,
        status=_as_optional_str(source.get("status") or settlement_source.get("status") or settlement_source.get("state")),
        cost_usdc=_as_optional_float(source.get("cost") or source.get("price_charged") or source.get("amount") or source.get("cost_usdc")),
        currency=_as_optional_str(source.get("currency")) or "USDC",
        created_at=_as_optional_str(source.get("created_at") or source.get("timestamp")),
        settlement={
            "network": _as_optional_str(settlement_source.get("network") or settlement_source.get("chain")),
            "status": _as_optional_str(settlement_source.get("status") or settlement_source.get("state")),
            "transaction_hash": _as_optional_str(
                settlement_source.get("transaction_hash") or settlement_source.get("tx_hash") or settlement_source.get("tx")
            ),
        },
        usage={
            "input_tokens": _as_optional_int(usage_source.get("input_tokens") or usage_source.get("prompt_tokens")),
            "output_tokens": _as_optional_int(usage_source.get("output_tokens") or usage_source.get("completion_tokens")),
            "total_tokens": _as_optional_int(usage_source.get("total_tokens")),
            "model": _as_optional_str(usage_source.get("model")),
            "requests": _as_optional_int(usage_source.get("requests") or usage_source.get("unit_count") or 1),
        },
        raw=receipt_payload,
    )


class OpenMultiAgentLangGraphAdapter:
    """
    Bridge open-multi-agent style workflow state into Agoragentic execute().

    The adapter expects a mutable state mapping and writes a normalized execution
    artifact under `state[output_key]`.
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        *,
        base_url: str = AGORAGENTIC_BASE_URL,
        transport: Optional[HTTPTransport] = None,
        timeout_seconds: float = 30.0,
    ):
        self.client = AgoragenticExecuteClient(
            api_key=api_key,
            base_url=base_url,
            transport=transport,
            timeout_seconds=timeout_seconds,
        )

    def execute_workflow(
        self,
        task: str,
        *,
        input_data: Optional[Mapping[str, Any]] = None,
        constraints: Optional[Mapping[str, Any]] = None,
        preview_first: bool = True,
        poll_for_receipt: bool = True,
        poll_interval_seconds: float = 1.0,
        timeout_seconds: float = 60.0,
    ) -> Dict[str, Any]:
        task_text = _require_non_empty_string(task, "task")
        normalized_input = _ensure_mapping(input_data)
        normalized_constraints = _ensure_mapping(constraints)

        artifact: Dict[str, Any] = {
            "tool": "agoragentic_execute",
            "task": task_text,
            "input": normalized_input,
            "constraints": normalized_constraints,
            "preview": None,
            "execution": None,
            "receipt": None,
            "usage": None,
            "warnings": [],
        }

        if preview_first:
            artifact["preview"] = self.client.match(
                task_text,
                max_cost=_as_optional_float(normalized_constraints.get("max_cost")),
                category=_as_optional_str(normalized_constraints.get("category")),
                tags=_as_optional_tags(normalized_constraints.get("tags")),
            )

        execution = self.client.execute(task_text, input_data=normalized_input, constraints=normalized_constraints)
        artifact["execution"] = execution

        receipt_payload = None
        receipt_id = _extract_receipt_id(execution)
        invocation_id = _extract_invocation_id(execution)
        terminal_status = str(execution.get("status", "accepted")).lower() if isinstance(execution, Mapping) else "accepted"

        if receipt_id:
            receipt_payload = self.client.receipt(receipt_id)
        elif poll_for_receipt and invocation_id and terminal_status in PENDING_STATUSES:
            wait_result = self.client.wait_for_receipt(
                invocation_id,
                receipt_id=receipt_id,
                poll_interval_seconds=poll_interval_seconds,
                timeout_seconds=timeout_seconds,
            )
            status_update = wait_result.get("status")
            if isinstance(status_update, Mapping):
                merged_execution = dict(execution)
                merged_execution.update(status_update)
                execution = merged_execution
                artifact["execution"] = execution
            receipt_payload = wait_result.get("receipt")
            if wait_result.get("timed_out"):
                artifact["warnings"].append(
                    f"Timed out after {timeout_seconds} seconds while waiting for usage receipt"
                )

        normalized_receipt = normalize_receipt(receipt_payload)
        if normalized_receipt:
            artifact["receipt"] = normalized_receipt.to_dict()
            artifact["usage"] = copy.deepcopy(normalized_receipt.usage)
        else:
            artifact["usage"] = _extract_usage_from_execution(execution)

        artifact["status"] = str(execution.get("status", "accepted")) if isinstance(execution, Mapping) else "accepted"
        artifact["provider"] = _provider_name(execution.get("provider")) if isinstance(execution, Mapping) else None
        artifact["invocation_id"] = _extract_invocation_id(execution) or (normalized_receipt.invocation_id if normalized_receipt else None)
        artifact["result"] = _extract_result_payload(execution)
        artifact["cost_usdc"] = _as_optional_float(
            (execution.get("cost") if isinstance(execution, Mapping) else None)
            or (execution.get("price_charged") if isinstance(execution, Mapping) else None)
            or (normalized_receipt.cost_usdc if normalized_receipt else None)
        )

        if str(artifact["status"]).lower() in TERMINAL_ERROR_STATUSES:
            error_message = _extract_error_message(execution) or "Agoragentic execution reported a terminal error"
            artifact["error"] = error_message
            raise AgoragenticAPIError(200, error_message, artifact)

        return artifact

    def build_state_node(
        self,
        *,
        task_key: str = "task",
        input_key: str = "input",
        constraints_key: str = "constraints",
        output_key: str = "agoragentic",
        append_receipts_key: str = "usage_receipts",
        append_messages_key: str = "messages",
        preview_first_default: bool = True,
        poll_for_receipt_default: bool = True,
        poll_interval_seconds: float = 1.0,
        timeout_seconds: float = 60.0,
    ) -> Callable[[MutableMapping[str, Any]], MutableMapping[str, Any]]:
        def node(state: MutableMapping[str, Any]) -> MutableMapping[str, Any]:
            resolved_task = self._resolve_task_from_state(state, task_key=task_key)
            resolved_input = self._resolve_input_from_state(state, input_key=input_key)
            resolved_constraints = self._resolve_constraints_from_state(state, constraints_key=constraints_key)
            preview_first = bool(state.get("preview_first", preview_first_default))
            poll_for_receipt = bool(state.get("poll_for_receipt", poll_for_receipt_default))

            artifact = self.execute_workflow(
                resolved_task,
                input_data=resolved_input,
                constraints=resolved_constraints,
                preview_first=preview_first,
                poll_for_receipt=poll_for_receipt,
                poll_interval_seconds=poll_interval_seconds,
                timeout_seconds=timeout_seconds,
            )

            new_state = dict(state)
            new_state[output_key] = artifact

            existing_receipts = list(state.get(append_receipts_key, [])) if isinstance(state.get(append_receipts_key), list) else []
            if artifact.get("receipt"):
                existing_receipts.append(copy.deepcopy(artifact["receipt"]))
            new_state[append_receipts_key] = existing_receipts

            existing_messages = list(state.get(append_messages_key, [])) if isinstance(state.get(append_messages_key), list) else []
            existing_messages.append(
                {
                    "role": "tool",
                    "name": "agoragentic_execute",
                    "content": json.dumps(
                        {
                            "task": artifact.get("task"),
                            "status": artifact.get("status"),
                            "provider": artifact.get("provider"),
                            "invocation_id": artifact.get("invocation_id"),
                            "result": artifact.get("result"),
                            "usage": artifact.get("usage"),
                        },
                        sort_keys=True,
                    ),
                }
            )
            new_state[append_messages_key] = existing_messages
            return new_state

        return node

    def build_langchain_tool(self, *, name: str = "agoragentic_open_multi_agent_execute") -> Any:
        try:
            from langchain_core.tools import tool
        except Exception as exc:
            raise RuntimeError("Install langchain-core to build the LangGraph tool wrapper") from exc

        adapter = self

        @tool(name)
        def wrapped_tool(
            task: str,
            input_data: Optional[Dict[str, Any]] = None,
            constraints: Optional[Dict[str, Any]] = None,
            preview_first: bool = True,
            poll_for_receipt: bool = True,
            timeout_seconds: float = 60.0,
        ) -> Dict[str, Any]:
            """Route an open-multi-agent task through Agoragentic execute() and return usage receipts."""
            return adapter.execute_workflow(
                task,
                input_data=input_data or {},
                constraints=constraints or {},
                preview_first=preview_first,
                poll_for_receipt=poll_for_receipt,
                timeout_seconds=timeout_seconds,
            )

        return wrapped_tool

    def build_langgraph_demo(self) -> Any:
        try:
            from typing import TypedDict
            from langgraph.graph import END, START, StateGraph
        except Exception as exc:
            raise RuntimeError("Install langgraph to build the demo graph") from exc

        class DemoState(TypedDict, total=False):
            task: str
            input: Dict[str, Any]
            constraints: Dict[str, Any]
            agoragentic: Dict[str, Any]
            usage_receipts: List[Dict[str, Any]]
            messages: List[Dict[str, Any]]

        graph = StateGraph(DemoState)
        graph.add_node("agoragentic_execute", self.build_state_node())
        graph.add_edge(START, "agoragentic_execute")
        graph.add_edge("agoragentic_execute", END)
        return graph.compile()

    def _resolve_task_from_state(self, state: Mapping[str, Any], *, task_key: str) -> str:
        direct_task = state.get(task_key)
        if isinstance(direct_task, str) and direct_task.strip():
            return direct_task.strip()
        workflow = state.get("workflow")
        if isinstance(workflow, Mapping):
            maybe_task = workflow.get("task") or workflow.get("intent") or workflow.get("goal")
            if isinstance(maybe_task, str) and maybe_task.strip():
                return maybe_task.strip()
        for message in reversed(state.get("messages", [])) if isinstance(state.get("messages"), list) else []:
            if not isinstance(message, Mapping):
                continue
            if str(message.get("role", "")).lower() in {"user", "system"}:
                content = message.get("content")
                if isinstance(content, str) and content.strip():
                    return content.strip()
        raise AgoragenticStateError(
            f"Missing workflow task. Expected state[{task_key!r}], state['workflow'].task, or a user message."
        )

    def _resolve_input_from_state(self, state: Mapping[str, Any], *, input_key: str) -> Dict[str, Any]:
        direct = state.get(input_key)
        if isinstance(direct, Mapping):
            return dict(direct)
        workflow = state.get("workflow")
        if isinstance(workflow, Mapping) and isinstance(workflow.get("input"), Mapping):
            return dict(workflow["input"])
        context = state.get("context")
        if isinstance(context, Mapping):
            return dict(context)
        return {}

    def _resolve_constraints_from_state(self, state: Mapping[str, Any], *, constraints_key: str) -> Dict[str, Any]:
        constraints = {}
        direct = state.get(constraints_key)
        if isinstance(direct, Mapping):
            constraints.update(dict(direct))
        workflow = state.get("workflow")
        if isinstance(workflow, Mapping) and isinstance(workflow.get("constraints"), Mapping):
            merged = dict(workflow["constraints"])
            merged.update(constraints)
            constraints = merged
        if "max_cost" not in constraints and state.get("max_cost") is not None:
            constraints["max_cost"] = state.get("max_cost")
        if "category" not in constraints and isinstance(state.get("category"), str):
            constraints["category"] = state.get("category")
        return constraints


def _extract_error_message(payload: Any) -> Optional[str]:
    if isinstance(payload, Mapping):
        for key in ("error", "message", "detail", "description"):
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    if isinstance(payload, str) and payload.strip():
        return payload.strip()
    return None


def _extract_receipt_id(payload: Any) -> Optional[str]:
    if not isinstance(payload, Mapping):
        return None
    for key in ("receipt_id", "receipt", "receiptId"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
        if isinstance(value, Mapping):
            nested = value.get("receipt_id") or value.get("id")
            if isinstance(nested, str) and nested.strip():
                return nested.strip()
    return None


def _extract_invocation_id(payload: Any) -> Optional[str]:
    if not isinstance(payload, Mapping):
        return None
    for key in ("invocation_id", "invocationId", "id"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _extract_result_payload(payload: Any) -> Any:
    if not isinstance(payload, Mapping):
        return payload
    for key in ("output", "result", "response", "data"):
        if key in payload:
            return payload[key]
    return payload


def _extract_usage_from_execution(execution: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(execution, Mapping):
        return None
    usage = execution.get("usage")
    if isinstance(usage, Mapping):
        return {
            "input_tokens": _as_optional_int(usage.get("input_tokens") or usage.get("prompt_tokens")),
            "output_tokens": _as_optional_int(usage.get("output_tokens") or usage.get("completion_tokens")),
            "total_tokens": _as_optional_int(usage.get("total_tokens")),
            "model": _as_optional_str(usage.get("model")),
            "requests": _as_optional_int(usage.get("requests") or usage.get("unit_count") or 1),
        }
    return None


def _provider_name(value: Any) -> Optional[str]:
    if isinstance(value, Mapping):
        for key in ("name", "id", "provider_id"):
            nested = value.get(key)
            if isinstance(nested, str) and nested.strip():
                return nested.strip()
        return None
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _ensure_mapping(value: Optional[Mapping[str, Any]]) -> Dict[str, Any]:
    if value is None:
        return {}
    if not isinstance(value, Mapping):
        raise AgoragenticStateError(f"Expected mapping, got {type(value).__name__}")
    return dict(value)


def _require_non_empty_string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise AgoragenticStateError(f"{label} must be a non-empty string")
    return value.strip()


def _safe_json_loads(text: str) -> Any:
    if not text:
        return {}
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {"message": text}


def _as_optional_str(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, str):
        stripped = value.strip()
        return stripped or None
    return str(value)


def _as_optional_float(value: Any) -> Optional[float]:
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _as_optional_int(value: Any) -> Optional[int]:
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _as_optional_tags(value: Any) -> Optional[Sequence[str]]:
    if value is None:
        return None
    if isinstance(value, str):
        return [tag.strip() for tag in value.split(",") if tag.strip()]
    if isinstance(value, Iterable):
        tags: List[str] = []
        for item in value:
            if isinstance(item, str) and item.strip():
                tags.append(item.strip())
        return tags or None
    return None


def _self_test() -> Dict[str, Any]:
    status_calls = {"count": 0}

    def status_route(_: Dict[str, Any]) -> Dict[str, Any]:
        status_calls["count"] += 1
        if status_calls["count"] == 1:
            return {
                "status": "running",
                "invocation_id": "inv_123",
                "provider": {"id": "open-multi-agent.summarizer", "name": "Open Multi Agent Summarizer"},
            }
        return {
            "status": "completed",
            "invocation_id": "inv_123",
            "provider": {"id": "open-multi-agent.summarizer", "name": "Open Multi Agent Summarizer"},
            "receipt_id": "rcpt_456",
        }

    transport = StubTransport(
        {
            ("GET", "/api/execute/match"): {
                "providers": [
                    {
                        "id": "open-multi-agent.summarizer",
                        "name": "Open Multi Agent Summarizer",
                        "price": 0.03,
                    }
                ]
            },
            ("POST", "/api/execute"): lambda req: {
                "status": "accepted",
                "task": req["json_payload"]["task"],
                "invocation_id": "inv_123",
                "provider": {"id": "open-multi-agent.summarizer", "name": "Open Multi Agent Summarizer"},
                "output": {
                    "workflow_id": "wf_demo_1",
                    "final_response": "Summary complete",
                    "steps_completed": 3,
                },
            },
            ("GET", "/api/execute/status/inv_123"): status_route,
            ("GET", "/api/commerce/receipts/rcpt_456"): {
                "receipt": {
                    "receipt_id": "rcpt_456",
                    "invocation_id": "inv_123",
                    "provider": {"id": "open-multi-agent.summarizer", "name": "Open Multi Agent Summarizer"},
                    "status": "settled",
                    "cost": 0.03,
                    "currency": "USDC",
                    "created_at": "2026-06-26T18:03:00Z",
                    "settlement": {
                        "network": "base",
                        "status": "confirmed",
                        "transaction_hash": "0xabc123",
                    },
                    "usage": {
                        "input_tokens": 321,
                        "output_tokens": 144,
                        "total_tokens": 465,
                        "model": "omagent-router-v1",
                        "requests": 1,
                    },
                }
            },
        }
    )

    adapter = OpenMultiAgentLangGraphAdapter(
        api_key="amk_test",
        base_url="https://mock.agoragentic.local",
        transport=transport,
    )

    node = adapter.build_state_node(poll_interval_seconds=0.0, timeout_seconds=1.0)
    initial_state = {
        "workflow": {
            "task": "Summarize incident notes and produce a handoff",
            "input": {
                "notes": [
                    "provider A timed out",
                    "provider B completed",
                    "customer needs concise summary",
                ],
                "team": "ops",
            },
            "constraints": {"max_cost": 0.05, "category": "operations", "tags": ["summary", "handoff"]},
        },
        "messages": [{"role": "user", "content": "Summarize the notes and generate a handoff."}],
    }
    result_state = node(initial_state)
    artifact = result_state["agoragentic"]

    assert artifact["provider"] == "Open Multi Agent Summarizer"
    assert artifact["invocation_id"] == "inv_123"
    assert artifact["receipt"]["receipt_id"] == "rcpt_456"
    assert artifact["usage"]["total_tokens"] == 465
    assert result_state["usage_receipts"][0]["settlement"]["network"] == "base"
    assert any(call["path"] == "/api/execute" for call in transport.calls)

    return {
        "ok": True,
        "provider": artifact["provider"],
        "invocation_id": artifact["invocation_id"],
        "usage": artifact["usage"],
        "receipt_id": artifact["receipt"]["receipt_id"],
        "transport_calls": len(transport.calls),
    }


if __name__ == "__main__":
    print(json.dumps(_self_test(), indent=2, sort_keys=True))
