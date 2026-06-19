"""
demo - moves no real funds
"""

from __future__ import annotations

import json
import os
import socket
import threading
import time
import uuid
from dataclasses import dataclass, field, asdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Dict, List, Optional
from urllib.error import HTTPError
from urllib.request import Request, urlopen


def _json_dumps(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), sort_keys=True)


def _uuid() -> str:
    return str(uuid.uuid4())


@dataclass
class Budget:
    max_calls: int = 10
    max_spend_usd: float = 1.00


@dataclass
class Receipt:
    tool_name: str
    request_id: str
    idempotency_key: str
    ok: bool
    amount_usd: float = 0.0
    authorization_id: Optional[str] = None
    receipt_id: Optional[str] = None
    result_summary: Optional[str] = None
    raw: Dict[str, Any] = field(default_factory=dict)


@dataclass
class ExecutionResult:
    output: Any
    receipt: Receipt


class BudgetExceededError(RuntimeError):
    pass


class PaymentRequiredError(RuntimeError):
    pass


class RemoteExecutionError(RuntimeError):
    pass


class ReceiptLedger:
    def __init__(self, budget: Budget) -> None:
        self.budget = budget
        self.calls_made = 0
        self.total_spend_usd = 0.0
        self.receipts: List[Receipt] = []

    def assert_can_call(self) -> None:
        if self.calls_made >= self.budget.max_calls:
            raise BudgetExceededError(
                f"call budget exceeded: {self.calls_made}/{self.budget.max_calls}"
            )
        if self.total_spend_usd > self.budget.max_spend_usd:
            raise BudgetExceededError(
                f"spend budget exceeded: ${self.total_spend_usd:.4f}/${self.budget.max_spend_usd:.4f}"
            )

    def record(self, receipt: Receipt) -> None:
        projected_calls = self.calls_made + 1
        projected_spend = self.total_spend_usd + float(receipt.amount_usd or 0.0)
        if projected_calls > self.budget.max_calls:
            raise BudgetExceededError(
                f"recording receipt would exceed call budget: {projected_calls}/{self.budget.max_calls}"
            )
        if projected_spend > self.budget.max_spend_usd:
            raise BudgetExceededError(
                f"recording receipt would exceed spend budget: ${projected_spend:.4f}/${self.budget.max_spend_usd:.4f}"
            )
        self.calls_made = projected_calls
        self.total_spend_usd = projected_spend
        self.receipts.append(receipt)

    def summary(self) -> Dict[str, Any]:
        return {
            "calls_made": self.calls_made,
            "max_calls": self.budget.max_calls,
            "total_spend_usd": round(self.total_spend_usd, 4),
            "max_spend_usd": self.budget.max_spend_usd,
            "receipt_count": len(self.receipts),
        }


PayCallback = Callable[[Dict[str, Any]], str]


class AgoragenticExecuteClient:
    def __init__(
        self,
        base_url: str,
        ledger: ReceiptLedger,
        pay: Optional[PayCallback] = None,
        timeout_seconds: float = 10.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.ledger = ledger
        self.pay = pay
        self.timeout_seconds = timeout_seconds

    def execute(
        self,
        tool_name: str,
        arguments: Dict[str, Any],
        *,
        idempotency_key: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> ExecutionResult:
        self.ledger.assert_can_call()

        idem = idempotency_key or _uuid()
        payload = {
            "tool_name": tool_name,
            "arguments": arguments,
            "budget": {
                "remaining_calls_before_request": self.ledger.budget.max_calls - self.ledger.calls_made,
                "remaining_spend_usd_before_request": round(
                    self.ledger.budget.max_spend_usd - self.ledger.total_spend_usd, 4
                ),
            },
            "metadata": metadata or {},
        }

        authorization_id: Optional[str] = None
        challenge: Optional[Dict[str, Any]] = None

        for attempt in range(2):
            response = self._post_json(
                "/execute",
                payload,
                idempotency_key=idem,
                authorization_id=authorization_id,
            )

            status = response["status"]
            if status == 402:
                challenge = response.get("payment_required") or {}
                if authorization_id is not None:
                    # Reuse the existing authorization on retries; do not re-authorize.
                    continue
                if self.pay is None:
                    raise PaymentRequiredError(
                        f"tool {tool_name!r} requires payment; no pay callback was supplied"
                    )
                authorization_id = self.pay(challenge)
                if not authorization_id or not isinstance(authorization_id, str):
                    raise PaymentRequiredError("pay callback did not return a valid authorization id")
                continue

            if status != 200:
                raise RemoteExecutionError(
                    f"execute failed with status {status}: {response.get('error', 'unknown error')}"
                )

            receipt_payload = response.get("receipt") or {}
            receipt = Receipt(
                tool_name=tool_name,
                request_id=response.get("request_id", _uuid()),
                idempotency_key=idem,
                ok=True,
                amount_usd=float(receipt_payload.get("amount_usd", 0.0) or 0.0),
                authorization_id=receipt_payload.get("authorization_id") or authorization_id,
                receipt_id=receipt_payload.get("receipt_id"),
                result_summary=response.get("summary"),
                raw=response,
            )
            self.ledger.record(receipt)
            return ExecutionResult(output=response.get("output"), receipt=receipt)

        if challenge is not None:
            raise PaymentRequiredError(
                f"tool {tool_name!r} still returned HTTP 402 after reusing the existing authorization"
            )
        raise RemoteExecutionError(f"tool {tool_name!r} failed without a terminal response")

    def _post_json(
        self,
        path: str,
        payload: Dict[str, Any],
        *,
        idempotency_key: str,
        authorization_id: Optional[str],
    ) -> Dict[str, Any]:
        headers = {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotency_key,
        }
        if authorization_id:
            headers["X-Payment-Authorization"] = authorization_id

        req = Request(
            self.base_url + path,
            data=_json_dumps(payload).encode("utf-8"),
            headers=headers,
            method="POST",
        )

        try:
            with urlopen(req, timeout=self.timeout_seconds) as resp:
                body = resp.read().decode("utf-8")
                return json.loads(body)
        except HTTPError as exc:
            body = exc.read().decode("utf-8")
            try:
                return json.loads(body)
            except json.JSONDecodeError as err:
                raise RemoteExecutionError(
                    f"non-json error response from execute endpoint: {body[:200]}"
                ) from err


def make_execute_tool(
    client: AgoragenticExecuteClient,
    tool_name: str,
    description: str,
):
    """
    Returns an OpenAI Agents SDK function_tool when available.
    Falls back to a plain Python callable with the same behavior.
    """
    try:
        from agents import function_tool  # type: ignore
    except Exception:
        function_tool = None

    def _runner(arguments_json: str) -> str:
        arguments = json.loads(arguments_json)
        result = client.execute(tool_name, arguments)
        return json.dumps(
            {
                "output": result.output,
                "receipt": asdict(result.receipt),
                "budget": client.ledger.summary(),
            },
            indent=2,
            sort_keys=True,
        )

    _runner.__name__ = f"agoragentic_{tool_name}"
    _runner.__doc__ = (
        description
        + "\n\nPass a JSON object string for the tool arguments. "
        + "The wrapper enforces local budget limits and returns a receipt."
    )

    if function_tool is None:
        return _runner

    return function_tool(name_override=_runner.__name__, description_override=description)(_runner)


class _DemoExecuteHandler(BaseHTTPRequestHandler):
    server_version = "AgoragenticDemo/0.1"
    protocol_version = "HTTP/1.1"

    charge_table = {
        "free_echo": 0.0,
        "premium_weather": 0.02,
    }

    def log_message(self, fmt: str, *args: Any) -> None:
        return

    def do_POST(self) -> None:
        if self.path != "/execute":
            self._send_json(404, {"status": 404, "error": "not found"})
            return

        length = int(self.headers.get("Content-Length", "0"))
        data = self.rfile.read(length).decode("utf-8")
        payload = json.loads(data or "{}")

        tool_name = payload.get("tool_name")
        arguments = payload.get("arguments") or {}
        idempotency_key = self.headers.get("Idempotency-Key", "")
        auth = self.headers.get("X-Payment-Authorization")

        if not tool_name or not idempotency_key:
            self._send_json(400, {"status": 400, "error": "missing tool_name or idempotency key"})
            return

        amount = float(self.charge_table.get(tool_name, 0.0))
        request_id = f"req_{idempotency_key[:12]}"

        if amount > 0.0 and auth is None:
            self._send_json(
                402,
                {
                    "status": 402,
                    "request_id": request_id,
                    "payment_required": {
                        "amount_usd": amount,
                        "currency": "USD",
                        "memo": f"demo authorization for {tool_name}",
                        "idempotency_key": idempotency_key,
                    },
                },
            )
            return

        if tool_name == "free_echo":
            output = {
                "echo": arguments,
                "executed_by": "demo-server",
                "paid": False,
            }
            summary = "echoed input"
        elif tool_name == "premium_weather":
            city = arguments.get("city", "unknown")
            output = {
                "city": city,
                "forecast": "sunny",
                "temperature_c": 24,
                "source": "demo-server",
                "paid": amount > 0.0,
            }
            summary = f"returned weather for {city}"
        else:
            self._send_json(
                400,
                {
                    "status": 400,
                    "request_id": request_id,
                    "error": f"unknown tool {tool_name!r}",
                },
            )
            return

        receipt = {
            "receipt_id": f"rcpt_{idempotency_key[:12]}",
            "authorization_id": auth,
            "amount_usd": amount,
            "charged": amount > 0.0,
            "settlement_state": "authorized-demo-only",
        }
        self._send_json(
            200,
            {
                "status": 200,
                "request_id": request_id,
                "summary": summary,
                "output": output,
                "receipt": receipt,
            },
        )

    def _send_json(self, status: int, body: Dict[str, Any]) -> None:
        encoded = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


def _pick_free_port() -> int:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = int(sock.getsockname()[1])
    sock.close()
    return port


def _start_demo_server() -> tuple[ThreadingHTTPServer, str]:
    port = _pick_free_port()
    server = ThreadingHTTPServer(("127.0.0.1", port), _DemoExecuteHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, f"http://127.0.0.1:{port}"


def _demo_pay_callback(challenge: Dict[str, Any]) -> str:
    amount = challenge.get("amount_usd")
    idem = challenge.get("idempotency_key", "missing-idem")
    return f"demo-auth-{amount}-{idem[:8]}"


def _run_self_test() -> None:
    server, base_url = _start_demo_server()
    try:
        ledger = ReceiptLedger(Budget(max_calls=3, max_spend_usd=0.05))
        client = AgoragenticExecuteClient(base_url=base_url, ledger=ledger, pay=_demo_pay_callback)

        free_result = client.execute("free_echo", {"message": "hello", "n": 1})
        assert free_result.output["echo"]["message"] == "hello"
        assert free_result.receipt.amount_usd == 0.0
        assert free_result.receipt.authorization_id is None

        paid_result = client.execute("premium_weather", {"city": "Berlin"})
        assert paid_result.output["city"] == "Berlin"
        assert paid_result.receipt.amount_usd == 0.02
        assert paid_result.receipt.authorization_id is not None
        assert ledger.calls_made == 2
        assert abs(ledger.total_spend_usd - 0.02) < 1e-9

        wrapper = make_execute_tool(
            client,
            "premium_weather",
            "Fetch a premium weather result through Agoragentic execute().",
        )
        wrapped_output = wrapper('{"city":"Lisbon"}')
        wrapped_data = json.loads(wrapped_output)
        assert wrapped_data["output"]["city"] == "Lisbon"
        assert wrapped_data["receipt"]["amount_usd"] == 0.02
        assert wrapped_data["budget"]["calls_made"] == 3

        print("SELF-TEST OK")
        print(json.dumps({"base_url": base_url, "ledger": ledger.summary()}, indent=2, sort_keys=True))
        print(json.dumps(wrapped_data, indent=2, sort_keys=True))
    finally:
        time.sleep(0.05)
        server.shutdown()
        server.server_close()


def _run_optional_agents_sdk_demo() -> int:
    try:
        from agents import Agent, Runner  # type: ignore
    except Exception:
        print("OpenAI Agents SDK not installed; skipping SDK demo.")
        return 0

    server, base_url = _start_demo_server()
    try:
        ledger = ReceiptLedger(Budget(max_calls=2, max_spend_usd=0.05))
        client = AgoragenticExecuteClient(base_url=base_url, ledger=ledger, pay=_demo_pay_callback)
        weather_tool = make_execute_tool(
            client,
            "premium_weather",
            "Return weather data using Agoragentic execute() with receipt tracking.",
        )

        agent = Agent(
            name="weather-demo",
            instructions=(
                "Use the provided tool. "
                "Call it with a JSON string object containing the city field."
            ),
            tools=[weather_tool],
        )
        result = Runner.run_sync(agent, "Get the premium weather for Tokyo.")
        print(result.final_output)
        print(json.dumps({"ledger": ledger.summary()}, indent=2, sort_keys=True))
        return 0
    finally:
        time.sleep(0.05)
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    mode = os.environ.get("AGORAGENTIC_DEMO_MODE", "selftest").strip().lower()
    if mode == "agents":
        raise SystemExit(_run_optional_agents_sdk_demo())
    _run_self_test()
