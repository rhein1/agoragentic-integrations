"""LangGraph execute() buyer adapter plus ELF seller listing manifest example.

This file is self-contained, uses only the Python standard library at runtime,
and includes a runnable demo with stubbed marketplace responses.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable, Dict, Iterable, List, Mapping, MutableMapping, Optional


AGORAGENTIC_BASE_URL = os.environ.get("AGORAGENTIC_BASE_URL", "https://agoragentic.com").rstrip("/")


@dataclass
class HTTPResult:
    status_code: int
    headers: Dict[str, str]
    json_body: Any


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
        request = urllib.request.Request(url=url, data=payload_bytes, headers=outbound_headers, method=method.upper())
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                body = response.read().decode("utf-8")
                parsed = json.loads(body) if body else None
                return HTTPResult(
                    status_code=response.getcode(),
                    headers=dict(response.headers.items()),
                    json_body=parsed,
                )
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8")
            try:
                parsed = json.loads(body) if body else None
            except json.JSONDecodeError:
                parsed = {"error": body or exc.reason}
            return HTTPResult(
                status_code=exc.code,
                headers=dict(exc.headers.items()) if exc.headers else {},
                json_body=parsed,
            )


class StubTransport(HTTPTransport):
    def __init__(self, routes: Mapping[tuple[str, str], Any]):
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
        response_factory = self.routes[route_key]
        self.calls.append(
            {
                "method": method.upper(),
                "path": parsed.path,
                "query": urllib.parse.parse_qs(parsed.query),
                "headers": dict(headers or {}),
                "json_payload": json_payload,
            }
        )
        if callable(response_factory):
            result = response_factory(parsed=parsed, headers=dict(headers or {}), json_payload=json_payload)
        else:
            result = response_factory
        if isinstance(result, HTTPResult):
            return result
        return HTTPResult(status_code=200, headers={"Content-Type": "application/json"}, json_body=result)


class AgoragenticAPIError(RuntimeError):
    def __init__(self, status_code: int, message: str, payload: Any = None):
        super().__init__(message)
        self.status_code = status_code
        self.payload = payload


class AgoragenticExecuteBuyerAdapter:
    """Buyer-side adapter for LangGraph state nodes that call Agoragentic execute()."""

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
    ) -> Any:
        url = self.base_url + path
        if query:
            encoded = urllib.parse.urlencode([(key, value) for key, value in query.items() if value is not None], doseq=True)
            url = f"{url}?{encoded}"
        result = self.transport.request(
            method,
            url,
            headers=self.headers,
            json_payload=json_payload,
            timeout=timeout or self.timeout_seconds,
        )
        if result.status_code >= 400:
            message = _extract_error_message(result.json_body) or f"Agoragentic API returned HTTP {result.status_code}"
            raise AgoragenticAPIError(result.status_code, message, payload=result.json_body)
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
        if tags:
            query["tags"] = ",".join(tag for tag in tags if tag)
        return self._request("GET", "/api/execute/match", query=query)

    def execute(
        self,
        task: str,
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

    def create_langgraph_node(
        self,
        *,
        task_key: str = "task",
        input_key: str = "input",
        constraints_key: str = "constraints",
        output_key: str = "agoragentic",
        preview_first_default: bool = True,
    ) -> Callable[[MutableMapping[str, Any]], MutableMapping[str, Any]]:
        def node(state: MutableMapping[str, Any]) -> MutableMapping[str, Any]:
            task = state.get(task_key)
            if not isinstance(task, str) or not task.strip():
                raise ValueError(f"state[{task_key!r}] must be a non-empty string")
            input_data = _ensure_mapping(state.get(input_key))
            constraints = _ensure_mapping(state.get(constraints_key))
            preview_first = bool(state.get("preview_first", preview_first_default))
            dry_run = bool(state.get("dry_run", False))
            adapter_result: Dict[str, Any] = {
                "task": task,
                "input": input_data,
                "constraints": constraints,
            }
            if preview_first:
                adapter_result["match"] = self.match(
                    task,
                    max_cost=_as_optional_float(constraints.get("max_cost")),
                    category=_as_optional_str(constraints.get("category")),
                    tags=_as_optional_tags(constraints.get("tags")),
                )
            if dry_run:
                adapter_result["executed"] = False
                new_state = dict(state)
                new_state[output_key] = adapter_result
                return new_state
            execution = self.execute(task, input_data=input_data, constraints=constraints)
            adapter_result["executed"] = True
            adapter_result["execution"] = execution
            receipt_id = execution.get("receipt_id") if isinstance(execution, Mapping) else None
            if isinstance(receipt_id, str) and receipt_id:
                adapter_result["receipt"] = self.receipt(receipt_id)
            new_state = dict(state)
            new_state[output_key] = adapter_result
            return new_state

        return node


def build_agoragentic_langgraph_tools(api_key: Optional[str] = None, *, base_url: str = AGORAGENTIC_BASE_URL):
    """Build LangChain-compatible tools when langchain_core is installed."""
    adapter = AgoragenticExecuteBuyerAdapter(api_key=api_key, base_url=base_url)
    try:
        from langchain_core.tools import tool
    except Exception as exc:  # pragma: no cover
        raise RuntimeError("Install langchain-core to build LangGraph tools") from exc

    @tool
    def agoragentic_match(task: str, max_cost: Optional[float] = None, category: Optional[str] = None) -> Dict[str, Any]:
        return adapter.match(task=task, max_cost=max_cost, category=category)

    @tool
    def agoragentic_execute(
        task: str,
        input_data: Optional[Dict[str, Any]] = None,
        constraints: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        return adapter.execute(task=task, input_data=input_data or {}, constraints=constraints or {})

    @tool
    def agoragentic_status(invocation_id: str) -> Dict[str, Any]:
        return adapter.status(invocation_id)

    @tool
    def agoragentic_receipt(receipt_id: str) -> Dict[str, Any]:
        return adapter.receipt(receipt_id)

    return [agoragentic_match, agoragentic_execute, agoragentic_status, agoragentic_receipt]


def build_elf_seller_listing_manifest(
    *,
    service_id: str = "elf-agent-builder.execute",
    service_name: str = "ELF Agent Builder Governed Execute",
    endpoint_url: str = "https://example.invalid/agora/v1/execute",
    price_model: str = "quote",
    category: str = "developer-tools",
) -> Dict[str, Any]:
    """Create a seller listing manifest for an ELF-built agent exposed through Agent OS."""
    return {
        "schema": "agoragentic.integration.http-listing.v1",
        "id": service_id,
        "name": service_name,
        "description": "Expose an ELF-built agent as a governed execute() endpoint with budget constraints, receipt references, and marketplace-compatible metadata.",
        "provider": {
            "name": "ELF Agent Builder",
            "runtime": "self_hosted",
            "endpoint_url": endpoint_url,
            "recommended_endpoint_path": urllib.parse.urlparse(endpoint_url).path or "/agora/v1/execute",
        },
        "listing": {
            "category": category,
            "listing_type": "api",
            "pricing_model": price_model,
            "tags": [
                "elf",
                "langgraph",
                "agent-os",
                "marketplace",
                "receipts",
                "governed-runtime",
            ],
        },
        "input_schema": {
            "type": "object",
            "additionalProperties": False,
            "required": ["task", "input"],
            "properties": {
                "task": {
                    "type": "string",
                    "minLength": 1,
                    "description": "Intent to route through Agoragentic execute().",
                },
                "input": {
                    "type": "object",
                    "additionalProperties": True,
                    "description": "Task payload forwarded to the governed runtime.",
                },
                "constraints": {
                    "type": "object",
                    "additionalProperties": True,
                    "description": "Budget, approval, trace, and provider constraints.",
                    "properties": {
                        "max_cost": {"type": "number", "minimum": 0},
                        "require_receipt": {"type": "boolean", "default": True},
                        "approval_token": {"type": "string"},
                        "category": {"type": "string"},
                        "tags": {
                            "type": "array",
                            "items": {"type": "string"},
                        },
                    },
                },
            },
        },
        "output_schema": {
            "type": "object",
            "additionalProperties": True,
            "required": ["ok", "invocation_id", "status", "result"],
            "properties": {
                "ok": {"type": "boolean"},
                "invocation_id": {"type": "string"},
                "status": {"type": "string"},
                "result": {},
                "receipt_id": {"type": "string"},
                "receipt": {
                    "type": "object",
                    "additionalProperties": True,
                    "description": "Optional normalized receipt details when available.",
                },
            },
        },
        "upstream_mapping": {
            "protocol": "http-json",
            "method": "POST",
            "path": urllib.parse.urlparse(endpoint_url).path or "/agora/v1/execute",
            "body": {
                "task": "${input.task}",
                "input": "${input.input}",
                "constraints": "${input.constraints}",
            },
            "auth": "Bearer token or deployment-secret passthrough handled by the self-hosted ELF runtime",
        },
        "sandbox_probe": {
            "input": {
                "task": "summarize",
                "input": {"text": "ELF seller probe"},
                "constraints": {"max_cost": 0.05, "require_receipt": True},
            },
            "expected": {
                "ok": True,
                "status": "completed_or_accepted",
                "receipt_id": "string_optional",
            },
        },
        "guardrails": [
            "Do not execute without honoring caller-supplied budget and approval constraints.",
            "Do not publish secrets, raw private prompts, private keys, or environment contents in outputs or receipts.",
            "Record invocation_id and receipt_id for reconciliation when paid work occurs.",
            "Use execute() for routed provider selection instead of hardcoding marketplace providers.",
        ],
    }


def run_minimal_langgraph_demo(adapter: AgoragenticExecuteBuyerAdapter) -> Dict[str, Any]:
    """Run a minimal stateful example. Uses LangGraph when available, falls back to a plain node call."""
    node = adapter.create_langgraph_node()
    initial_state = {
        "task": "summarize",
        "input": {"text": "ELF builders need governed runtime examples."},
        "constraints": {"max_cost": 0.25, "require_receipt": True, "category": "developer-tools"},
    }
    try:
        from typing_extensions import TypedDict
        from langgraph.graph import END, START, StateGraph

        class GraphState(TypedDict, total=False):
            task: str
            input: Dict[str, Any]
            constraints: Dict[str, Any]
            agoragentic: Dict[str, Any]

        graph = StateGraph(GraphState)
        graph.add_node("route_execute", node)
        graph.add_edge(START, "route_execute")
        graph.add_edge("route_execute", END)
        return graph.compile().invoke(initial_state)
    except Exception:
        return node(initial_state)


def _extract_error_message(payload: Any) -> str:
    if isinstance(payload, Mapping):
        for key in ("error", "message", "detail"):
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                return value
    if isinstance(payload, str):
        return payload
    return ""


def _ensure_mapping(value: Any) -> Dict[str, Any]:
    if value is None:
        return {}
    if not isinstance(value, Mapping):
        raise ValueError("expected a mapping-compatible state value")
    return dict(value)


def _as_optional_float(value: Any) -> Optional[float]:
    if value is None or value == "":
        return None
    return float(value)


def _as_optional_str(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _as_optional_tags(value: Any) -> Optional[List[str]]:
    if value is None:
        return None
    if isinstance(value, str):
        return [tag.strip() for tag in value.split(",") if tag.strip()]
    if isinstance(value, Iterable):
        tags = [str(tag).strip() for tag in value if str(tag).strip()]
        return tags or None
    return None


def _demo_stub_adapter() -> AgoragenticExecuteBuyerAdapter:
    base_url = "https://demo.agoragentic.invalid"

    def match_response(**_: Any) -> Dict[str, Any]:
        return {
            "task": "summarize",
            "matches": [
                {
                    "provider_id": "elf-demo-summarizer",
                    "price_estimate": 0.02,
                    "currency": "USDC",
                    "category": "developer-tools",
                }
            ],
        }

    def execute_response(**_: Any) -> Dict[str, Any]:
        return {
            "ok": True,
            "status": "completed",
            "invocation_id": "inv_demo_123",
            "receipt_id": "rcpt_demo_123",
            "result": {
                "summary": "ELF can expose a governed LangGraph runtime through Agoragentic execute()."
            },
        }

    def receipt_response(**_: Any) -> Dict[str, Any]:
        return {
            "receipt_id": "rcpt_demo_123",
            "status": "recorded",
            "amount": 0.02,
            "currency": "USDC",
            "invocation_id": "inv_demo_123",
        }

    transport = StubTransport(
        {
            ("GET", "/api/execute/match"): match_response,
            ("POST", "/api/execute"): execute_response,
            ("GET", "/api/commerce/receipts/rcpt_demo_123"): receipt_response,
        }
    )
    return AgoragenticExecuteBuyerAdapter(api_key="amk_demo", base_url=base_url, transport=transport)


def _self_test() -> Dict[str, Any]:
    adapter = _demo_stub_adapter()
    final_state = run_minimal_langgraph_demo(adapter)
    manifest = build_elf_seller_listing_manifest(endpoint_url="https://elf.example.com/agora/v1/execute")
    ag_result = final_state["agoragentic"]
    assert ag_result["executed"] is True
    assert ag_result["execution"]["invocation_id"] == "inv_demo_123"
    assert ag_result["receipt"]["receipt_id"] == "rcpt_demo_123"
    assert manifest["schema"] == "agoragentic.integration.http-listing.v1"
    assert manifest["provider"]["runtime"] == "self_hosted"
    assert manifest["upstream_mapping"]["body"]["task"] == "${input.task}"
    return {
        "demo_state": final_state,
        "elf_manifest": manifest,
    }


def main(argv: List[str]) -> int:
    result = _self_test()
    if "--manifest-only" in argv:
        print(json.dumps(result["elf_manifest"], indent=2, sort_keys=True))
        return 0
    if "--state-only" in argv:
        print(json.dumps(result["demo_state"], indent=2, sort_keys=True))
        return 0
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
