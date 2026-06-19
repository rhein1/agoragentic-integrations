# demo — moves no real funds.

from __future__ import annotations

import hashlib
import hmac
import json
import os
import sys
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Tuple, TypedDict

try:
    from langgraph.graph import END, StateGraph  # type: ignore

    LANGGRAPH_AVAILABLE = True
except Exception:
    END = "__END__"
    StateGraph = None
    LANGGRAPH_AVAILABLE = False


class AgentState(TypedDict, total=False):
    prompt: str
    metadata: Dict[str, Any]
    trace: List[Dict[str, Any]]
    draft: str
    output: Dict[str, Any]
    endpoint_response: Dict[str, Any]
    idempotency_key: str
    authorization: Optional[Dict[str, Any]]
    authorization_reused: bool
    budget_spent_cents: int
    budget_remaining_cents: int
    graph_backend: str


@dataclass
class BudgetExceededError(RuntimeError):
    message: str


@dataclass
class PaymentRequiredError(RuntimeError):
    challenge: str
    message: str = "x402 payment required but no pay_callback was supplied"


@dataclass
class BudgetTracker:
    limit_cents: int
    spent_cents: int = 0
    line_items: List[Dict[str, Any]] = field(default_factory=list)

    def charge(self, amount_cents: int, reason: str) -> None:
        if amount_cents < 0:
            raise ValueError("amount_cents must be >= 0")
        projected = self.spent_cents + amount_cents
        if projected > self.limit_cents:
            raise BudgetExceededError(
                f"budget exceeded: attempted {projected}c > limit {self.limit_cents}c"
            )
        self.spent_cents = projected
        self.line_items.append(
            {
                "amount_cents": amount_cents,
                "reason": reason,
                "spent_cents_after": self.spent_cents,
                "remaining_cents_after": self.remaining_cents,
            }
        )

    @property
    def remaining_cents(self) -> int:
        return self.limit_cents - self.spent_cents


@dataclass
class X402PaymentAuthorizer:
    pay_callback: Optional[Callable[[Dict[str, Any]], Dict[str, Any]]] = None
    cache: Dict[Tuple[str, str], Dict[str, Any]] = field(default_factory=dict)

    def authorize(self, challenge: str, idempotency_key: str) -> Tuple[Dict[str, Any], bool]:
        cache_key = (challenge, idempotency_key)
        if cache_key in self.cache:
            return self.cache[cache_key], True

        if self.pay_callback is None:
            raise PaymentRequiredError(challenge=challenge)

        payment_request = {
            "scheme": "x402-demo",
            "challenge": challenge,
            "idempotency_key": idempotency_key,
            "timestamp": int(time.time()),
            "note": "demo authorization only; no real funds move",
        }
        authorization = self.pay_callback(payment_request)
        if not isinstance(authorization, dict):
            raise TypeError("pay_callback must return a dict")
        if not authorization.get("authorization"):
            raise ValueError("pay_callback must return dict with non-empty 'authorization'")
        self.cache[cache_key] = authorization
        return authorization, False


@dataclass
class X402ReceiptGenerator:
    secret: str = field(
        default_factory=lambda: os.environ.get("X402_DEMO_SECRET", "x402-demo-secret")
    )

    def generate(
        self,
        *,
        prompt: str,
        output: Dict[str, Any],
        metadata: Dict[str, Any],
        budget: BudgetTracker,
        trace: List[Dict[str, Any]],
        idempotency_key: str,
        authorization: Optional[Dict[str, Any]],
        authorization_reused: bool,
        graph_backend: str,
    ) -> Dict[str, Any]:
        trace_json = _stable_json(trace)
        output_json = _stable_json(output)
        auth_value = None if authorization is None else authorization.get("authorization")

        payload = {
            "version": "x402-demo-receipt/v1",
            "note": "demo receipt — no real settlement or on-chain verification",
            "idempotency_key": idempotency_key,
            "graph_backend": graph_backend,
            "budget": {
                "limit_cents": budget.limit_cents,
                "spent_cents": budget.spent_cents,
                "remaining_cents": budget.remaining_cents,
                "line_items": budget.line_items,
            },
            "payment": {
                "scheme": "x402-demo",
                "authorized": authorization is not None,
                "authorization_reused": authorization_reused,
                "authorization_digest": _sha256(auth_value or ""),
            },
            "audit": {
                "prompt_digest": _sha256(prompt),
                "output_digest": _sha256(output_json),
                "trace_digest": _sha256(trace_json),
                "trace_steps": len(trace),
                "metadata_digest": _sha256(_stable_json(metadata)),
                "generated_at_unix": int(time.time()),
            },
        }

        signature = hmac.new(
            self.secret.encode("utf-8"),
            _stable_json(payload).encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()

        payload["signature"] = signature
        return payload


@dataclass
class PhoenixExecuteAdapter:
    budget_limit_cents: int = 25
    receipt_generator: X402ReceiptGenerator = field(default_factory=X402ReceiptGenerator)
    endpoint: Optional[Callable[[Dict[str, Any], Dict[str, str]], Dict[str, Any]]] = None
    pay_callback: Optional[Callable[[Dict[str, Any]], Dict[str, Any]]] = None
    tool_name: str = "phoenix-agent-builder"

    def execute(
        self,
        prompt: str,
        *,
        metadata: Optional[Dict[str, Any]] = None,
        idempotency_key: Optional[str] = None,
    ) -> Dict[str, Any]:
        if not isinstance(prompt, str) or not prompt.strip():
            raise ValueError("prompt must be a non-empty string")

        metadata = dict(metadata or {})
        if idempotency_key is None:
            idempotency_key = str(uuid.uuid4())

        budget = BudgetTracker(limit_cents=self.budget_limit_cents)
        authorizer = X402PaymentAuthorizer(pay_callback=self.pay_callback)
        trace: List[Dict[str, Any]] = []
        shared: Dict[str, Any] = {
            "prompt": prompt,
            "metadata": metadata,
            "trace": trace,
            "budget": budget,
            "endpoint": self.endpoint,
            "authorizer": authorizer,
            "authorization": None,
            "authorization_reused": False,
            "idempotency_key": idempotency_key,
            "tool_name": self.tool_name,
        }

        state = self._run_graph(shared)
        output = state["output"]
        authorization = state.get("authorization")
        authorization_reused = state.get("authorization_reused", False)
        graph_backend = state.get("graph_backend", "unknown")

        receipt = self.receipt_generator.generate(
            prompt=prompt,
            output=output,
            metadata=metadata,
            budget=budget,
            trace=trace,
            idempotency_key=idempotency_key,
            authorization=authorization,
            authorization_reused=authorization_reused,
            graph_backend=graph_backend,
        )

        return {
            "ok": True,
            "tool": self.tool_name,
            "idempotency_key": idempotency_key,
            "graph_backend": graph_backend,
            "result": output,
            "budget": {
                "limit_cents": budget.limit_cents,
                "spent_cents": budget.spent_cents,
                "remaining_cents": budget.remaining_cents,
            },
            "trace": trace,
            "x402_receipt": receipt,
        }

    def _run_graph(self, shared: Dict[str, Any]) -> AgentState:
        if LANGGRAPH_AVAILABLE:
            return self._run_langgraph(shared)
        return self._run_fallback(shared)

    def _run_langgraph(self, shared: Dict[str, Any]) -> AgentState:
        graph = StateGraph(AgentState)
        graph.add_node("plan", self._node_plan(shared))
        graph.add_node("invoke", self._node_invoke(shared))
        graph.add_node("finalize", self._node_finalize(shared))
        graph.set_entry_point("plan")
        graph.add_edge("plan", "invoke")
        graph.add_edge("invoke", "finalize")
        graph.add_edge("finalize", END)
        app = graph.compile()

        initial: AgentState = {
            "prompt": shared["prompt"],
            "metadata": shared["metadata"],
            "trace": shared["trace"],
            "idempotency_key": shared["idempotency_key"],
            "authorization": None,
            "authorization_reused": False,
            "graph_backend": "langgraph",
        }
        return app.invoke(initial)

    def _run_fallback(self, shared: Dict[str, Any]) -> AgentState:
        state: AgentState = {
            "prompt": shared["prompt"],
            "metadata": shared["metadata"],
            "trace": shared["trace"],
            "idempotency_key": shared["idempotency_key"],
            "authorization": None,
            "authorization_reused": False,
            "graph_backend": "fallback",
        }
        state = self._node_plan(shared)(state)
        state = self._node_invoke(shared)(state)
        state = self._node_finalize(shared)(state)
        return state

    def _node_plan(self, shared: Dict[str, Any]) -> Callable[[AgentState], AgentState]:
        budget: BudgetTracker = shared["budget"]
        trace: List[Dict[str, Any]] = shared["trace"]

        def node(state: AgentState) -> AgentState:
            budget.charge(1, "langgraph.plan")
            draft = (
                f"Plan for prompt: {state['prompt'][:120]}"
                f"{'...' if len(state['prompt']) > 120 else ''}"
            )
            trace.append(
                {
                    "step": "plan",
                    "budget_spent_cents": budget.spent_cents,
                    "draft_digest": _sha256(draft),
                }
            )
            state["draft"] = draft
            state["budget_spent_cents"] = budget.spent_cents
            state["budget_remaining_cents"] = budget.remaining_cents
            return state

        return node

    def _node_invoke(self, shared: Dict[str, Any]) -> Callable[[AgentState], AgentState]:
        budget: BudgetTracker = shared["budget"]
        trace: List[Dict[str, Any]] = shared["trace"]
        endpoint = shared["endpoint"]
        authorizer: X402PaymentAuthorizer = shared["authorizer"]
        idempotency_key: str = shared["idempotency_key"]

        def node(state: AgentState) -> AgentState:
            budget.charge(2, "langgraph.invoke")

            headers = {
                "Idempotency-Key": idempotency_key,
                "X-Agent-Tool": shared["tool_name"],
            }
            payload = {
                "prompt": state["prompt"],
                "draft": state.get("draft", ""),
                "metadata": state.get("metadata", {}),
            }

            if endpoint is None:
                endpoint_response = {
                    "status_code": 200,
                    "body": {
                        "mode": "local-demo",
                        "answer": f"Executed locally for prompt: {state['prompt']}",
                        "audit_summary": "No remote Phoenix endpoint configured; used local adapter path.",
                    },
                }
            else:
                endpoint_response = endpoint(payload, headers)
                if endpoint_response.get("status_code") == 402:
                    challenge = str(
                        endpoint_response.get("x402_challenge")
                        or endpoint_response.get("body", {}).get("x402_challenge")
                        or "x402-demo-challenge"
                    )
                    authorization, reused = authorizer.authorize(challenge, idempotency_key)
                    headers["X-Payment-Authorization"] = authorization["authorization"]
                    retry_response = endpoint(payload, headers)
                    if retry_response.get("status_code") == 402:
                        raise RuntimeError("endpoint still requires payment after authorization retry")
                    endpoint_response = retry_response
                    state["authorization"] = authorization
                    state["authorization_reused"] = reused

            status_code = int(endpoint_response.get("status_code", 500))
            if status_code >= 400:
                raise RuntimeError(f"endpoint failed with status_code={status_code}")

            trace.append(
                {
                    "step": "invoke",
                    "budget_spent_cents": budget.spent_cents,
                    "idempotency_key": idempotency_key,
                    "status_code": status_code,
                    "authorized": state.get("authorization") is not None,
                    "authorization_reused": state.get("authorization_reused", False),
                }
            )
            state["endpoint_response"] = endpoint_response
            state["budget_spent_cents"] = budget.spent_cents
            state["budget_remaining_cents"] = budget.remaining_cents
            return state

        return node

    def _node_finalize(self, shared: Dict[str, Any]) -> Callable[[AgentState], AgentState]:
        budget: BudgetTracker = shared["budget"]
        trace: List[Dict[str, Any]] = shared["trace"]

        def node(state: AgentState) -> AgentState:
            budget.charge(1, "langgraph.finalize")
            body = dict(state.get("endpoint_response", {}).get("body", {}))
            result = {
                "prompt": state["prompt"],
                "draft": state.get("draft", ""),
                "response": body,
                "budget_spent_cents": budget.spent_cents,
                "budget_remaining_cents": budget.remaining_cents,
            }
            trace.append(
                {
                    "step": "finalize",
                    "budget_spent_cents": budget.spent_cents,
                    "result_digest": _sha256(_stable_json(result)),
                }
            )
            state["output"] = result
            state["budget_spent_cents"] = budget.spent_cents
            state["budget_remaining_cents"] = budget.remaining_cents
            return state

        return node


def execute(
    prompt: str,
    *,
    budget_limit_cents: int = 25,
    metadata: Optional[Dict[str, Any]] = None,
    endpoint: Optional[Callable[[Dict[str, Any], Dict[str, str]], Dict[str, Any]]] = None,
    pay_callback: Optional[Callable[[Dict[str, Any]], Dict[str, Any]]] = None,
    idempotency_key: Optional[str] = None,
) -> Dict[str, Any]:
    adapter = PhoenixExecuteAdapter(
        budget_limit_cents=budget_limit_cents,
        endpoint=endpoint,
        pay_callback=pay_callback,
    )
    return adapter.execute(prompt, metadata=metadata, idempotency_key=idempotency_key)


def _stable_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


class _FakePhoenixEndpoint:
    def __init__(self) -> None:
        self.calls: List[Dict[str, Any]] = []

    def __call__(self, payload: Dict[str, Any], headers: Dict[str, str]) -> Dict[str, Any]:
        self.calls.append({"payload": payload, "headers": dict(headers)})
        auth = headers.get("X-Payment-Authorization")
        if not auth:
            return {
                "status_code": 402,
                "x402_challenge": "demo-paywall/phoenix-run",
                "body": {"message": "payment required"},
            }

        return {
            "status_code": 200,
            "body": {
                "mode": "remote-demo",
                "answer": f"Phoenix executed: {payload['prompt']}",
                "received_idempotency_key": headers.get("Idempotency-Key"),
                "received_authorization_digest": _sha256(auth),
            },
        }


def _demo_pay_callback(payment_request: Dict[str, Any]) -> Dict[str, Any]:
    material = _stable_json(payment_request)
    token = hmac.new(
        b"demo-pay-callback-secret",
        material.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return {
        "authorization": f"demo-auth:{token}",
        "scheme": "x402-demo",
        "issued_for": payment_request["challenge"],
    }


def _self_test() -> Dict[str, Any]:
    endpoint = _FakePhoenixEndpoint()
    fixed_idempotency_key = "demo-idempotency-key-123"

    result = execute(
        "Build a production-safe Phoenix agent execution trace.",
        budget_limit_cents=10,
        metadata={"tenant": "demo", "component": "phoenix"},
        endpoint=endpoint,
        pay_callback=_demo_pay_callback,
        idempotency_key=fixed_idempotency_key,
    )

    assert result["ok"] is True
    assert result["budget"]["spent_cents"] == 4
    assert result["budget"]["remaining_cents"] == 6
    assert result["idempotency_key"] == fixed_idempotency_key
    assert result["result"]["response"]["mode"] == "remote-demo"
    assert result["x402_receipt"]["payment"]["authorized"] is True
    assert len(endpoint.calls) == 2
    assert endpoint.calls[0]["headers"]["Idempotency-Key"] == fixed_idempotency_key
    assert endpoint.calls[1]["headers"]["Idempotency-Key"] == fixed_idempotency_key
    assert "X-Payment-Authorization" not in endpoint.calls[0]["headers"]
    assert "X-Payment-Authorization" in endpoint.calls[1]["headers"]

    return result


def main(argv: List[str]) -> int:
    if len(argv) > 1 and argv[1] == "--self-test":
        result = _self_test()
        print(_stable_json(result))
        return 0

    prompt = (
        argv[1]
        if len(argv) > 1
        else "Summarize why budget tracking and x402 receipts matter for agent execution."
    )

    result = execute(
        prompt,
        budget_limit_cents=8,
        metadata={"demo": True},
    )
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
