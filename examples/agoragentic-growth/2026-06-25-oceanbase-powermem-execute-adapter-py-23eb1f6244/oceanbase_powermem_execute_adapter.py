"""LangGraph execute() buyer adapter plus OceanBase/PowerMem seller listing example.

Usage:
    python oceanbase_powermem_execute_adapter.py --self-test
    python oceanbase_powermem_execute_adapter.py --listing
    python oceanbase_powermem_execute_adapter.py --example-state

Drop into a LangGraph project:
    from oceanbase_powermem_execute_adapter import (
        BudgetPolicy,
        HttpTransport,
        OceanbasePowerMemBuyerAdapter,
        build_langgraph_execute_node,
    )

    adapter = OceanbasePowerMemBuyerAdapter(
        transport=HttpTransport(api_key="amk_your_key"),
        budget_policy=BudgetPolicy(max_cost_usdc=0.25),
    )
    node = build_langgraph_execute_node(adapter)

The returned node accepts a dict-like state with:
    {
        "task": "oceanbase.hybrid_retrieve",
        "input": {
            "tenant_id": "tenant-123",
            "query": "find memory chunks about vector search tuning",
            "namespace": "powermem-prod",
            "top_k": 5
        }
    }

It appends a normalized receipt under:
    state["agoragentic_receipt"]
    state["receipts"]
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
from dataclasses import asdict, dataclass, field
from typing import Any, Callable, Dict, List, Mapping, MutableMapping, Optional, Sequence, Tuple
from urllib import error, parse, request

DEFAULT_BASE_URL = os.environ.get("AGORAGENTIC_BASE_URL", "https://agoragentic.com")
DEFAULT_TIMEOUT_SECONDS = 30
DEFAULT_USER_AGENT = "agoragentic-langgraph-oceanbase-powermem/1.0"


class AdapterError(RuntimeError):
    """Raised when budget policy, response shape, or transport requirements fail."""


@dataclass(frozen=True)
class BudgetPolicy:
    name: str = "oceanbase_powermem_default"
    currency: str = "USDC"
    max_cost_usdc: float = 1.0
    soft_warn_cost_usdc: float = 0.5
    require_receipt: bool = True
    allowed_tasks: Tuple[str, ...] = (
        "powermem.write_memory",
        "powermem.read_memory",
        "powermem.search_memory",
        "oceanbase.hybrid_retrieve",
    )
    metadata: Dict[str, Any] = field(default_factory=dict)

    def allows(self, task: str) -> bool:
        return not self.allowed_tasks or task in self.allowed_tasks

    def to_constraints(self) -> Dict[str, Any]:
        constraints: Dict[str, Any] = {
            "max_cost": round(self.max_cost_usdc, 6),
            "currency": self.currency,
            "require_receipt": self.require_receipt,
        }
        if self.metadata:
            constraints["budget_policy"] = self.metadata
        return constraints


@dataclass(frozen=True)
class UsageReceipt:
    ok: bool
    task: str
    quote_id: Optional[str]
    invocation_id: Optional[str]
    receipt_id: Optional[str]
    provider_name: Optional[str]
    listing_name: Optional[str]
    cost_usdc: Optional[float]
    settlement: Optional[str]
    idempotency_key: str
    budget_policy: str
    evidence: Dict[str, Any]
    uncertainty: List[str]


class HttpTransport:
    """Small JSON transport around urllib so the file runs without external deps."""

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        api_key: Optional[str] = None,
        timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
        user_agent: str = DEFAULT_USER_AGENT,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key or os.environ.get("AGORAGENTIC_API_KEY")
        self.timeout_seconds = timeout_seconds
        self.user_agent = user_agent

    def _headers(self, extra: Optional[Mapping[str, str]] = None) -> Dict[str, str]:
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": self.user_agent,
        }
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        if extra:
            headers.update({str(k): str(v) for k, v in extra.items()})
        return headers

    def request_json(
        self,
        method: str,
        path: str,
        *,
        params: Optional[Mapping[str, Any]] = None,
        body: Optional[Mapping[str, Any]] = None,
        extra_headers: Optional[Mapping[str, str]] = None,
    ) -> Dict[str, Any]:
        url = f"{self.base_url}{path}"
        if params:
            filtered = {k: v for k, v in params.items() if v is not None and v != ""}
            if filtered:
                url = f"{url}?{parse.urlencode(filtered, doseq=True)}"
        payload = None if body is None else json.dumps(body).encode("utf-8")
        req = request.Request(url, data=payload, method=method.upper(), headers=self._headers(extra_headers))
        try:
            with request.urlopen(req, timeout=self.timeout_seconds) as response:
                raw = response.read().decode("utf-8")
                return json.loads(raw) if raw else {}
        except error.HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")
            try:
                payload_json = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                payload_json = {"raw": raw}
            raise AdapterError(f"HTTP {exc.code} calling {path}: {payload_json}") from exc
        except error.URLError as exc:
            raise AdapterError(f"Network error calling {path}: {exc}") from exc


class OceanbasePowerMemBuyerAdapter:
    """Governed execute() wrapper for LangGraph-style buyer flows."""

    def __init__(
        self,
        transport: Optional[HttpTransport] = None,
        *,
        budget_policy: Optional[BudgetPolicy] = None,
    ) -> None:
        self.transport = transport or HttpTransport()
        self.budget_policy = budget_policy or BudgetPolicy()

    @staticmethod
    def _stable_json(value: Any) -> str:
        return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)

    @classmethod
    def _stable_idempotency_key(
        cls,
        task: str,
        input_data: Mapping[str, Any],
        constraints: Mapping[str, Any],
        quote_id: Optional[str],
        metadata: Optional[Mapping[str, Any]],
    ) -> str:
        explicit = None
        if metadata:
            explicit = metadata.get("idempotency_key") or metadata.get("idempotencyKey")
        if explicit:
            return str(explicit)
        slug = task.replace(".", "_").replace("/", "_")
        fingerprint = hashlib.sha256(
            cls._stable_json(
                {
                    "task": task,
                    "input": dict(input_data),
                    "constraints": dict(constraints),
                    "quote_id": quote_id or "dynamic_execute",
                }
            ).encode("utf-8")
        ).hexdigest()[:24]
        return f"idem_{slug}_{fingerprint}"

    @staticmethod
    def _coerce_float(value: Any) -> Optional[float]:
        if value is None or value == "":
            return None
        try:
            return float(value)
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _first_present(*values: Any) -> Any:
        for value in values:
            if value is not None and value != "":
                return value
        return None

    @staticmethod
    def _is_pending_approval(payload: Mapping[str, Any]) -> bool:
        status = str(payload.get("status") or payload.get("state") or "").lower()
        approval = payload.get("approval") if isinstance(payload.get("approval"), Mapping) else {}
        approval_status = str(approval.get("status") or "").lower()
        return bool(
            status in {"pending_approval", "approval_required", "requires_approval"}
            or approval_status in {"pending", "pending_approval", "approval_required"}
            or payload.get("approval_id")
            or payload.get("approvalId")
        )

    def match(self, task: str, *, budget_policy: Optional[BudgetPolicy] = None) -> Dict[str, Any]:
        policy = budget_policy or self.budget_policy
        if not policy.allows(task):
            raise AdapterError(f"Task {task!r} is not allowed by budget policy {policy.name!r}")
        return self.transport.request_json(
            "GET",
            "/api/execute/match",
            params={
                "task": task,
                "max_cost": round(policy.max_cost_usdc, 6),
            },
        )

    def execute(
        self,
        task: str,
        input_data: Optional[Mapping[str, Any]] = None,
        *,
        budget_policy: Optional[BudgetPolicy] = None,
        extra_constraints: Optional[Mapping[str, Any]] = None,
        quote_id: Optional[str] = None,
        metadata: Optional[Mapping[str, Any]] = None,
    ) -> UsageReceipt:
        policy = budget_policy or self.budget_policy
        if not policy.allows(task):
            raise AdapterError(f"Task {task!r} is not allowed by budget policy {policy.name!r}")

        match_payload = self.match(task, budget_policy=policy) if quote_id is None else {}
        resolved_quote_id = quote_id or match_payload.get("quote_id") or match_payload.get("quote", {}).get("quote_id")

        matched_price = self._coerce_float(
            match_payload.get("price_usdc")
            or match_payload.get("price")
            or match_payload.get("match", {}).get("price_usdc")
            or match_payload.get("match", {}).get("price")
        )
        if matched_price is not None and matched_price > policy.max_cost_usdc:
            raise AdapterError(
                f"Matched price {matched_price:.6f} exceeds max_cost_usdc={policy.max_cost_usdc:.6f} for {policy.name}"
            )

        constraints = dict(extra_constraints or {})
        extra_max_cost = self._coerce_float(constraints.get("max_cost"))
        constraints.update(policy.to_constraints())
        if extra_max_cost is not None:
            constraints["max_cost"] = round(min(extra_max_cost, policy.max_cost_usdc), 6)
        if extra_constraints:
            constraints["caller_constraints"] = {
                key: value
                for key, value in dict(extra_constraints).items()
                if key not in {"max_cost", "currency", "require_receipt"}
            }

        input_payload = dict(input_data or {})
        idempotency_key = self._stable_idempotency_key(
            task,
            input_payload,
            constraints,
            resolved_quote_id,
            metadata,
        )
        body: Dict[str, Any] = {
            "task": task,
            "input": input_payload,
            "constraints": constraints,
            "metadata": {
                "adapter": "langgraph_oceanbase_powermem",
                "idempotency_key": idempotency_key,
                **dict(metadata or {}),
            },
        }
        if resolved_quote_id:
            body["quote_id"] = resolved_quote_id

        execution_payload = self.transport.request_json(
            "POST",
            "/api/execute",
            body=body,
            extra_headers={"Idempotency-Key": idempotency_key},
        )
        receipt = self._normalize_receipt(
            task=task,
            policy=policy,
            idempotency_key=idempotency_key,
            quote_id=resolved_quote_id,
            match_payload=match_payload,
            execution_payload=execution_payload,
        )
        if policy.require_receipt and not receipt.receipt_id and not self._is_pending_approval(execution_payload):
            raise AdapterError(f"Execution for task {task!r} returned no receipt_id under policy {policy.name!r}")
        return receipt

    def _normalize_receipt(
        self,
        *,
        task: str,
        policy: BudgetPolicy,
        idempotency_key: str,
        quote_id: Optional[str],
        match_payload: Mapping[str, Any],
        execution_payload: Mapping[str, Any],
    ) -> UsageReceipt:
        provider_name = (
            execution_payload.get("provider_name")
            or execution_payload.get("provider")
            or execution_payload.get("result", {}).get("provider")
            or match_payload.get("provider_name")
            or match_payload.get("match", {}).get("name")
            or match_payload.get("match", {}).get("provider")
        )
        listing_name = (
            execution_payload.get("listing_name")
            or execution_payload.get("result", {}).get("listing_name")
            or match_payload.get("match", {}).get("name")
        )
        receipt_payload = execution_payload.get("receipt", {}) if isinstance(execution_payload.get("receipt"), Mapping) else {}
        cost = self._coerce_float(
            self._first_present(
                execution_payload.get("cost_usdc"),
                execution_payload.get("cost"),
                execution_payload.get("price_usdc"),
                execution_payload.get("price"),
                receipt_payload.get("cost_usdc"),
                receipt_payload.get("cost"),
            )
        )
        settlement = (
            execution_payload.get("settlement")
            or receipt_payload.get("settlement")
            or execution_payload.get("status")
            or "unknown"
        )
        receipt_id = execution_payload.get("receipt_id") or receipt_payload.get("receipt_id")
        invocation_id = execution_payload.get("invocation_id") or execution_payload.get("invocation", {}).get("id")
        uncertainty: List[str] = []

        if self._is_pending_approval(execution_payload):
            uncertainty.append(
                "Execution is pending approval; surface approval evidence to the supervisor and retry after approval."
            )
        if settlement == "unknown":
            uncertainty.append("Response omitted settlement; reconcile with a receipt endpoint before treating the run as closed.")
        elif settlement not in {"settled", "completed"}:
            uncertainty.append(
                f"Settlement is reported as {settlement!r}; treat it as non-final until a receipt or proof endpoint confirms terminal state."
            )
        if cost is None:
            uncertainty.append("Response omitted cost fields; rely on quote and upstream receipt reconciliation.")
        if receipt_id is None:
            uncertainty.append("Response omitted receipt_id; downstream reconciliation is limited.")

        evidence = {
            "match": match_payload,
            "execute": execution_payload,
            "budget": {
                "max_cost_usdc": policy.max_cost_usdc,
                "soft_warn_cost_usdc": policy.soft_warn_cost_usdc,
                "allowed_tasks": list(policy.allowed_tasks),
            },
        }
        return UsageReceipt(
            ok=receipt_id is not None,
            task=task,
            quote_id=quote_id,
            invocation_id=invocation_id,
            receipt_id=receipt_id,
            provider_name=provider_name,
            listing_name=listing_name,
            cost_usdc=cost,
            settlement=settlement,
            idempotency_key=idempotency_key,
            budget_policy=policy.name,
            evidence=evidence,
            uncertainty=uncertainty,
        )


def build_langgraph_execute_node(
    adapter: OceanbasePowerMemBuyerAdapter,
    *,
    budget_policy: Optional[BudgetPolicy] = None,
    task_field: str = "task",
    input_field: str = "input",
) -> Callable[[MutableMapping[str, Any]], MutableMapping[str, Any]]:
    """Return a LangGraph-compatible node callable.

    The returned function is intentionally plain Python so it works with:
    - LangGraph StateGraph nodes
    - direct dict-based tests
    - local demos without installing langgraph
    """

    def node(state: MutableMapping[str, Any]) -> MutableMapping[str, Any]:
        task = state.get(task_field)
        if not task:
            raise AdapterError(f"State is missing required field {task_field!r}")
        input_data = state.get(input_field, {})
        receipt = adapter.execute(str(task), input_data, budget_policy=budget_policy)
        next_state = dict(state)
        next_state["agoragentic_receipt"] = asdict(receipt)
        next_state.setdefault("receipts", []).append(asdict(receipt))
        return next_state

    return node


def build_oceanbase_powermem_seller_listing() -> Dict[str, Any]:
    """Return a seller-listing example for a governed OceanBase/PowerMem runtime."""
    return {
        "name": "oceanbase_powermem_governed_runtime",
        "version": "1.0.0",
        "category": "memory",
        "summary": "OceanBase + PowerMem memory runtime exposed through Agoragentic execute() with governed budgets and usage receipts.",
        "provider": {
            "name": "oceanbase-powermem",
            "routing_mode": "execute",
            "receipts_supported": True,
        },
        "pricing": {
            "price_model": "per_run",
            "currency": "USDC",
            "examples": {
                "powermem.write_memory": 0.12,
                "powermem.read_memory": 0.04,
                "powermem.search_memory": 0.06,
                "oceanbase.hybrid_retrieve": 0.18,
            },
        },
        "budget_policy_examples": [
            {
                "name": "safe_default",
                "max_cost_usdc": 0.25,
                "soft_warn_cost_usdc": 0.15,
                "allowed_tasks": [
                    "powermem.write_memory",
                    "powermem.read_memory",
                    "powermem.search_memory",
                ],
                "receipt_requirement": "receipt_id required on every run",
            },
            {
                "name": "retrieval_heavy",
                "max_cost_usdc": 0.5,
                "soft_warn_cost_usdc": 0.3,
                "allowed_tasks": [
                    "powermem.read_memory",
                    "powermem.search_memory",
                    "oceanbase.hybrid_retrieve",
                ],
                "receipt_requirement": "receipt_id plus invocation_id recommended",
            },
        ],
        "usage_receipt_fields": [
            "quote_id",
            "invocation_id",
            "receipt_id",
            "cost",
            "settlement",
            "provider_name",
            "listing_name",
            "idempotency_key",
        ],
        "input_schema": {
            "type": "object",
            "required": ["tenant_id", "query"],
            "properties": {
                "tenant_id": {"type": "string"},
                "query": {"type": "string"},
                "namespace": {"type": "string"},
                "document": {"type": "string"},
                "top_k": {"type": "integer", "minimum": 1, "maximum": 50},
                "metadata": {"type": "object"},
            },
        },
        "output_contract": {
            "result": {
                "memory_hits": "array",
                "latency_ms": "number",
                "usage_receipt": "object",
            },
            "notes": [
                "Receipt evidence should be returned with every call.",
                "Cost and settlement must remain informational until receipt reconciliation confirms terminal status.",
            ],
        },
        "langgraph_usage": {
            "node_name": "governed_oceanbase_powermem_execute",
            "state_fields": {
                "task": "task name routed through execute()",
                "input": "task payload",
                "agoragentic_receipt": "normalized run receipt",
            },
        },
    }


class MockTransport(HttpTransport):
    """Demo transport for self-test; never touches live APIs or funds."""

    def __init__(self) -> None:
        super().__init__(base_url="https://mock.agoragentic.local", api_key="amk_demo")
        self.calls: List[Dict[str, Any]] = []

    def request_json(
        self,
        method: str,
        path: str,
        *,
        params: Optional[Mapping[str, Any]] = None,
        body: Optional[Mapping[str, Any]] = None,
        extra_headers: Optional[Mapping[str, str]] = None,
    ) -> Dict[str, Any]:
        self.calls.append(
            {
                "method": method,
                "path": path,
                "params": dict(params or {}),
                "body": dict(body or {}),
                "headers": dict(extra_headers or {}),
            }
        )
        if path == "/api/execute/match" and method.upper() == "GET":
            task = str((params or {}).get("task", ""))
            quoted_cost = {
                "powermem.write_memory": 0.12,
                "powermem.read_memory": 0.04,
                "powermem.search_memory": 0.06,
                "oceanbase.hybrid_retrieve": 0.18,
            }.get(task, 0.22)
            if task == "powermem.search_memory":
                return {
                    "candidates": [
                        {
                            "name": "oceanbase_powermem_governed_runtime",
                            "provider": "oceanbase-powermem",
                            "price_usdc": quoted_cost,
                        }
                    ],
                    "match": {
                        "name": "oceanbase_powermem_governed_runtime",
                        "provider": "oceanbase-powermem",
                        "price_usdc": quoted_cost,
                    },
                }
            return {
                "quote_id": f"quote_{task.replace('.', '_')}",
                "match": {
                    "name": "oceanbase_powermem_governed_runtime",
                    "provider": "oceanbase-powermem",
                    "price_usdc": quoted_cost,
                },
            }
        if path == "/api/execute" and method.upper() == "POST":
            body = dict(body or {})
            metadata = dict(body.get("metadata") or {})
            input_payload = dict(body.get("input") or {})
            if input_payload.get("simulate_pending_approval"):
                return {
                    "status": "pending_approval",
                    "approval_id": "approval_demo_123",
                    "retry_after_approval": True,
                    "instructions": "Supervisor approval required before a receipt is created.",
                }
            fingerprint = hashlib.sha256(json.dumps(input_payload, sort_keys=True).encode("utf-8")).hexdigest()[:16]
            if input_payload.get("simulate_cost_usdc"):
                return {
                    "success": True,
                    "provider_name": "oceanbase-powermem",
                    "listing_name": "oceanbase_powermem_governed_runtime",
                    "invocation_id": f"inv_{fingerprint}",
                    "receipt": {
                        "receipt_id": f"rcpt_{fingerprint}",
                        "cost_usdc": 0.06,
                        "settlement": "submitted",
                    },
                }
            return {
                "success": True,
                "provider_name": "oceanbase-powermem",
                "listing_name": "oceanbase_powermem_governed_runtime",
                "invocation_id": f"inv_{fingerprint}",
                "receipt_id": f"rcpt_{fingerprint}",
                "cost": 0.18 if body.get("task") == "oceanbase.hybrid_retrieve" else 0.12,
                "settlement": "submitted",
                "result": {
                    "memory_hits": [
                        {"id": "mem_001", "score": 0.98, "namespace": input_payload.get("namespace", "default")},
                        {"id": "mem_002", "score": 0.91, "namespace": input_payload.get("namespace", "default")},
                    ],
                    "latency_ms": 83,
                    "echo_idempotency_key": metadata.get("idempotency_key"),
                },
            }
        raise AdapterError(f"MockTransport does not support {method} {path}")


def _assert(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def run_self_test() -> Dict[str, Any]:
    listing = build_oceanbase_powermem_seller_listing()
    _assert(listing["provider"]["receipts_supported"] is True, "listing must advertise receipt support")
    _assert("budget_policy_examples" in listing, "listing must include budget policy examples")

    transport = MockTransport()
    policy = BudgetPolicy(
        name="retrieval_demo",
        max_cost_usdc=0.2,
        soft_warn_cost_usdc=0.1,
        allowed_tasks=("oceanbase.hybrid_retrieve", "powermem.search_memory"),
        metadata={"owner": "oceanbase/powermem", "receipt_level": "standard"},
    )
    adapter = OceanbasePowerMemBuyerAdapter(transport=transport, budget_policy=policy)
    node = build_langgraph_execute_node(adapter, budget_policy=policy)

    state = {
        "task": "oceanbase.hybrid_retrieve",
        "input": {
            "tenant_id": "tenant-demo",
            "query": "Find the latest memory chunks about OceanBase vector search tuning.",
            "namespace": "powermem-demo",
            "top_k": 2,
        },
    }
    result_state = node(state)
    receipt = result_state["agoragentic_receipt"]
    _assert(receipt["receipt_id"].startswith("rcpt_"), "receipt_id should be normalized")
    _assert(receipt["settlement"] == "submitted", "self-test should preserve non-final settlement wording")
    _assert(receipt["cost_usdc"] == 0.18, "hybrid retrieve should use the quoted paid example")
    _assert(len(result_state["receipts"]) == 1, "node should append one receipt")

    search_input = {
        "tenant_id": "tenant-demo",
        "query": "Find PowerMem chunks without requiring a durable quote.",
        "namespace": "powermem-demo",
        "simulate_cost_usdc": True,
    }
    search_receipt = adapter.execute(
        "powermem.search_memory",
        search_input,
        budget_policy=policy,
        extra_constraints={"max_cost": 99, "preferred_provider": "oceanbase-powermem"},
    )
    search_execute_call = [call for call in transport.calls if call["path"] == "/api/execute"][-1]
    _assert(search_receipt.quote_id is None, "execute should allow dynamic pricing when match returns no quote_id")
    _assert(search_receipt.cost_usdc == 0.06, "receipt.cost_usdc should be normalized")
    _assert("quote_id" not in search_execute_call["body"], "dynamic execute should omit quote_id")
    _assert(search_execute_call["body"]["constraints"]["max_cost"] == 0.2, "extra constraints must not raise policy cap")
    _assert(
        search_execute_call["body"]["constraints"]["caller_constraints"]["preferred_provider"] == "oceanbase-powermem",
        "non-budget caller constraints should remain visible",
    )

    search_receipt_retry = adapter.execute(
        "powermem.search_memory",
        search_input,
        budget_policy=policy,
        extra_constraints={"max_cost": 99, "preferred_provider": "oceanbase-powermem"},
    )
    _assert(
        search_receipt.idempotency_key == search_receipt_retry.idempotency_key,
        "same task/input/policy retry should preserve idempotency key",
    )

    approval_receipt = adapter.execute(
        "powermem.search_memory",
        {
            "tenant_id": "tenant-demo",
            "query": "Needs supervisor approval before execution.",
            "simulate_pending_approval": True,
        },
        budget_policy=policy,
    )
    _assert(approval_receipt.receipt_id is None, "pending approval should not fabricate a receipt")
    _assert(
        any("pending approval" in warning for warning in approval_receipt.uncertainty),
        "pending approval should be surfaced as actionable uncertainty",
    )

    blocked_policy = BudgetPolicy(name="too_small", max_cost_usdc=0.05, allowed_tasks=("oceanbase.hybrid_retrieve",))
    try:
        adapter.execute("oceanbase.hybrid_retrieve", state["input"], budget_policy=blocked_policy)
    except AdapterError as exc:
        blocked_error = str(exc)
    else:
        raise AssertionError("expected budget policy to block overspend")
    _assert("exceeds max_cost_usdc" in blocked_error, "overspend should be rejected with evidence")

    disallowed_policy = BudgetPolicy(name="read_only", max_cost_usdc=0.2, allowed_tasks=("powermem.read_memory",))
    try:
        adapter.execute("powermem.write_memory", {"tenant_id": "tenant-demo", "query": "store memory"}, budget_policy=disallowed_policy)
    except AdapterError as exc:
        denied_error = str(exc)
    else:
        raise AssertionError("expected task allow-list enforcement")
    _assert("not allowed" in denied_error, "allow-list rejection should be explicit")

    return {
        "ok": True,
        "seller_listing_name": listing["name"],
        "budget_policy_example_count": len(listing["budget_policy_examples"]),
        "receipt": receipt,
        "warnings": receipt["uncertainty"],
        "transport_calls": transport.calls,
        "blocked_error": blocked_error,
        "denied_error": denied_error,
    }


def main(argv: Sequence[str]) -> int:
    if "--self-test" in argv or len(argv) == 1:
        summary = run_self_test()
        print(json.dumps(summary, indent=2, sort_keys=True))
        return 0

    if "--listing" in argv:
        print(json.dumps(build_oceanbase_powermem_seller_listing(), indent=2, sort_keys=True))
        return 0

    if "--example-state" in argv:
        example_state = {
            "task": "oceanbase.hybrid_retrieve",
            "input": {
                "tenant_id": "tenant-prod",
                "query": "search memory for retry-safe receipt examples",
                "namespace": "support-bot",
                "top_k": 5,
            },
        }
        print(json.dumps(example_state, indent=2, sort_keys=True))
        return 0

    print("Usage: python oceanbase_powermem_execute_adapter.py [--self-test|--listing|--example-state]", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
