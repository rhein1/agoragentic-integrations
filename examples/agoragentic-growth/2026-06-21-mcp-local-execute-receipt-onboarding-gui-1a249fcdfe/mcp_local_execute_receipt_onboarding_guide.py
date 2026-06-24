#!/usr/bin/env python3
"""demo — moves no real funds"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import threading
import time
import uuid
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Dict, List, Mapping, Optional, Tuple
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


JsonDict = Dict[str, Any]
PayCallback = Callable[[Mapping[str, Any]], str]


@dataclass
class ExecuteResponse:
    status_code: int
    body: JsonDict
    receipt: JsonDict
    attempts: int
    idempotency_key: str
    payment_authorization: str


class LocalExecuteWrapper:
    """
    Minimal execute() wrapper for a governed MCP integration.

    Safety properties:
    - Requires a caller-supplied pay callback before authorizing a payment.
    - Only authorizes when the server explicitly returns HTTP 402.
    - Reuses the same authorization on retries to avoid double-paying.
    - Always sends an idempotency key.
    """

    def __init__(
        self,
        base_url: str,
        *,
        timeout: float = 5.0,
        max_attempts: int = 4,
        retry_backoff_seconds: float = 0.05,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.max_attempts = max_attempts
        self.retry_backoff_seconds = retry_backoff_seconds

    def execute(
        self,
        *,
        tool_name: str,
        tool_input: Mapping[str, Any],
        pay: Optional[PayCallback] = None,
        idempotency_key: Optional[str] = None,
    ) -> ExecuteResponse:
        idem = idempotency_key or f"mcp-execute-{uuid.uuid4().hex}"
        authorization: Optional[str] = None

        request_body = {
            "tool": tool_name,
            "input": dict(tool_input),
            "receipt_requested": True,
        }

        for attempt in range(1, self.max_attempts + 1):
            headers = {
                "Content-Type": "application/json",
                "Accept": "application/json",
                "Idempotency-Key": idem,
            }
            if authorization:
                headers["X-PAYMENT"] = authorization
                headers["X-RETRY-ATTEMPT"] = str(attempt)

            status_code, response_headers, response_body = self._post_json("/execute", request_body, headers)

            if status_code == 402:
                if authorization:
                    raise RuntimeError("server returned a second 402 after payment authorization was already issued")
                if pay is None:
                    raise RuntimeError("HTTP 402 received but no pay callback was supplied")
                if attempt >= self.max_attempts:
                    raise RuntimeError("HTTP 402 received on final attempt; refusing to authorize an unsent payment")
                challenge = self._extract_payment_challenge(response_headers, response_body)
                authorization = pay(challenge)
                continue

            if 200 <= status_code < 300:
                receipt = self._extract_receipt(response_headers, response_body)
                return ExecuteResponse(
                    status_code=status_code,
                    body=response_body,
                    receipt=receipt,
                    attempts=attempt,
                    idempotency_key=idem,
                    payment_authorization=authorization or "",
                )

            if status_code in {408, 425, 429, 500, 502, 503, 504} and attempt < self.max_attempts:
                time.sleep(self.retry_backoff_seconds)
                continue

            message = response_body.get("error") or response_body.get("message") or f"HTTP {status_code}"
            raise RuntimeError(f"execute failed on attempt {attempt}: {message}")

        raise RuntimeError("execute exhausted retries")

    def _post_json(
        self, path: str, payload: Mapping[str, Any], headers: Mapping[str, str]
    ) -> Tuple[int, Dict[str, str], JsonDict]:
        request = Request(
            f"{self.base_url}{path}",
            data=json.dumps(payload).encode("utf-8"),
            headers=dict(headers),
            method="POST",
        )
        try:
            with urlopen(request, timeout=self.timeout) as response:
                raw = response.read().decode("utf-8")
                return response.status, self._normalize_headers(response.headers), self._parse_json_body(raw)
        except HTTPError as exc:
            raw = exc.read().decode("utf-8")
            return exc.code, self._normalize_headers(exc.headers), self._parse_json_body(raw)
        except URLError as exc:
            raise RuntimeError(f"network error: {exc}") from exc

    @staticmethod
    def _parse_json_body(raw: str) -> JsonDict:
        if not raw:
            return {}
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                return parsed
            return {"raw_body": parsed}
        except json.JSONDecodeError:
            return {"raw_body": raw}

    @staticmethod
    def _normalize_headers(headers: Mapping[str, Any]) -> Dict[str, str]:
        return {str(k).lower(): str(v) for k, v in headers.items()}

    @staticmethod
    def _extract_payment_challenge(headers: Mapping[str, str], body: Mapping[str, Any]) -> JsonDict:
        header_value = headers.get("x-payment-required") or headers.get("payment-required")
        if header_value:
            parsed = LocalExecuteWrapper._parse_json_or_base64(header_value)
            if isinstance(parsed, dict) and LocalExecuteWrapper._is_usable_payment_challenge(parsed):
                return parsed
        payload = body.get("payment_required") or body.get("challenge") or body
        if isinstance(payload, dict) and LocalExecuteWrapper._is_usable_payment_challenge(payload):
            return dict(payload)
        raise RuntimeError("402 response missing usable payment challenge")

    @staticmethod
    def _parse_json_or_base64(value: str) -> Any:
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            try:
                decoded = base64.b64decode(value.encode("utf-8"), validate=True).decode("utf-8")
                return json.loads(decoded)
            except Exception:
                return None

    @staticmethod
    def _is_usable_payment_challenge(challenge: Mapping[str, Any]) -> bool:
        required = ("amount", "asset", "pay_to", "resource", "nonce")
        return all(challenge.get(key) for key in required)

    @staticmethod
    def _extract_receipt(headers: Mapping[str, str], body: Mapping[str, Any]) -> JsonDict:
        receipt = body.get("receipt")
        if isinstance(receipt, dict):
            return dict(receipt)

        receipt_id = body.get("receipt_id") or body.get("id")
        if isinstance(receipt_id, str) and receipt_id:
            return {
                "receipt_id": receipt_id,
                "source": "top-level-receipt-id",
            }

        for key in ("x-payment-receipt", "payment-receipt"):
            raw = headers.get(key)
            if not raw:
                continue
            try:
                decoded = base64.b64decode(raw.encode("utf-8"), validate=True).decode("utf-8")
                parsed = json.loads(decoded)
                if isinstance(parsed, dict):
                    return parsed
            except Exception:
                try:
                    parsed = json.loads(raw)
                    if isinstance(parsed, dict):
                        return parsed
                except Exception:
                    pass
        raise RuntimeError("success response missing receipt")


class DemoExecuteServer(ThreadingHTTPServer):
    def __init__(self, server_address: Tuple[str, int], secret: bytes) -> None:
        super().__init__(server_address, DemoExecuteHandler)
        self.secret = secret
        self.request_count = 0
        self.challenge_count = 0
        self.pay_callback_count = 0
        self.paid_retry_count = 0
        self.last_idempotency_key: Optional[str] = None
        self.last_payment_token: Optional[str] = None
        self.tool_name = "weather.lookup"
        self.price = "0.01"
        self.asset = "USDC"
        self.receipt_status = "demo-accepted"
        self.seller = "demo-mcp-seller"


class DemoExecuteHandler(BaseHTTPRequestHandler):
    server: DemoExecuteServer

    def do_POST(self) -> None:
        if self.path != "/execute":
            self._send_json(404, {"error": "not found"})
            return

        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
        tool_name = body.get("tool")
        tool_input = body.get("input") or {}
        idem = self.headers.get("Idempotency-Key", "")
        payment_token = self.headers.get("X-PAYMENT")

        self.server.request_count += 1
        self.server.last_idempotency_key = idem

        if tool_name != self.server.tool_name:
            self._send_json(400, {"error": f"unknown tool {tool_name!r}"})
            return

        challenge = {
            "kind": "demo-hmac",
            "asset": self.server.asset,
            "amount": self.server.price,
            "pay_to": self.server.seller,
            "resource": tool_name,
            "nonce": idem,
        }

        if not payment_token:
            self.server.challenge_count += 1
            self._send_json(402, {"payment_required": challenge}, extra_headers={"X-Payment-Required": json.dumps(challenge)})
            return

        if not self._is_valid_payment(payment_token, challenge):
            self._send_json(403, {"error": "invalid payment authorization"})
            return

        self.server.paid_retry_count += 1
        if self.server.paid_retry_count == 1:
            self._send_json(503, {"error": "temporary upstream saturation; retry with same payment authorization"})
            return

        self.server.last_payment_token = payment_token
        receipt = {
            "receipt_id": f"rcpt_{hashlib.sha256(idem.encode('utf-8')).hexdigest()[:12]}",
            "invocation_id": f"invoke_{hashlib.sha256((idem + tool_name).encode('utf-8')).hexdigest()[:12]}",
            "status": self.server.receipt_status,
            "amount": self.server.price,
            "asset": self.server.asset,
            "seller": self.server.seller,
            "tool": tool_name,
            "quote_id": f"quote_{idem[-12:]}",
            "idempotency_key": idem,
            "payment_hash": hashlib.sha256(payment_token.encode("utf-8")).hexdigest(),
        }
        result = {
            "ok": True,
            "tool": tool_name,
            "output": {
                "forecast": "sunny",
                "location": tool_input.get("location", "unknown"),
            },
            "receipt": receipt,
        }
        self._send_json(200, result)

    def _is_valid_payment(self, token: str, challenge: Mapping[str, Any]) -> bool:
        expected = demo_pay_callback_factory(self.server.secret, counter=None)(challenge)
        return hmac.compare_digest(token, expected)

    def _send_json(self, status: int, payload: JsonDict, extra_headers: Optional[Mapping[str, str]] = None) -> None:
        encoded = json.dumps(payload, sort_keys=True).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        if extra_headers:
            for key, value in extra_headers.items():
                self.send_header(key, value)
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, fmt: str, *args: Any) -> None:
        return


def demo_pay_callback_factory(secret: bytes, counter: Optional[List[int]]) -> PayCallback:
    def pay(challenge: Mapping[str, Any]) -> str:
        if counter is not None:
            counter[0] += 1
        canonical = json.dumps(dict(challenge), sort_keys=True, separators=(",", ":")).encode("utf-8")
        digest = hmac.new(secret, canonical, hashlib.sha256).hexdigest()
        token = {
            "scheme": "demo-hmac",
            "authorization": digest,
            "challenge_sha256": hashlib.sha256(canonical).hexdigest(),
        }
        return base64.b64encode(json.dumps(token, sort_keys=True).encode("utf-8")).decode("utf-8")

    return pay


def build_markdown_guide(result: ExecuteResponse, server: DemoExecuteServer) -> str:
    receipt = result.receipt
    lines = [
        "# Onboard a new MCP tool with a local execute() wrapper and receipt flow",
        "",
        "This example is a local, runnable template. It simulates payment authorization with an HMAC demo secret and moves no real funds.",
        "",
        "## 1. Define the MCP tool contract",
        f"- Tool name: `{server.tool_name}`",
        "- Input shape: JSON object",
        "- Output shape: JSON object",
        "- Receipt requirement: every successful paid invocation returns a receipt object",
        "",
        "## 2. Wrap all calls through a local execute() function",
        "- Always POST one normalized request body to `/execute`.",
        "- Always send an `Idempotency-Key` header.",
        "- Keep tool name and tool input in the request body so the wrapper stays generic.",
        "",
        "## 3. Gate payment behind an explicit callback",
        "- The wrapper accepts a required `pay(challenge) -> authorization` callback for paid tools.",
        "- It does not authorize payment up front.",
        "- It only calls `pay(...)` after an explicit HTTP 402 response.",
        "",
        "## 4. Reuse payment authorization on retries",
        "- This matters for x402-style or paid-call flows: do not pay again on every retry.",
        "- In the demo, the first paid retry gets a transient 503.",
        "- The wrapper retries with the same `X-PAYMENT` authorization and the same idempotency key.",
        "",
        "## 5. Require and persist a receipt",
        "- On success, extract the receipt from the JSON body or a receipt header.",
        "- Persist the idempotency key, invocation id, receipt id, seller, asset, amount, and payment proof hash.",
        "",
        "## 6. Demo evidence",
        f"- HTTP status: `{result.status_code}`",
        f"- Attempts: `{result.attempts}`",
        f"- Idempotency key: `{result.idempotency_key}`",
        f"- Receipt id: `{receipt.get('receipt_id')}`",
        f"- Invocation id: `{receipt.get('invocation_id')}`",
        f"- Receipt status: `{receipt.get('status')}`",
        f"- Seller: `{receipt.get('seller')}`",
        f"- Amount: `{receipt.get('amount')} {receipt.get('asset')}`",
        f"- Server challenge count: `{server.challenge_count}`",
        f"- Server paid retry count: `{server.paid_retry_count}`",
        "",
        "## 7. Copy/paste checklist for a real integration",
        "- Replace the demo server with your local broker, agent runtime, or MCP bridge.",
        "- Keep the same wrapper behavior: idempotency key always, pay only on 402, reuse authorization after payment, extract a receipt on success.",
        "- Keep the payment callback caller-supplied so production payment signing stays outside the wrapper.",
        "- Treat broadcast or submitted payment attempts as non-terminal unless your receipt flow actually verifies settlement.",
        "",
        "## 8. Run it",
        "- `python examples/mcp_local_execute_receipt_onboarding_guide.py`",
        "- The script self-tests the retry and receipt behavior, then prints this guide.",
    ]
    return "\n".join(lines)


def _self_test() -> None:
    secret = b"demo-secret-only"
    server = DemoExecuteServer(("127.0.0.1", 0), secret=secret)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        base_url = f"http://127.0.0.1:{server.server_address[1]}"
        wrapper = LocalExecuteWrapper(base_url)
        pay_counter = [0]
        result = wrapper.execute(
            tool_name=server.tool_name,
            tool_input={"location": "berlin"},
            pay=demo_pay_callback_factory(secret, pay_counter),
        )

        assert result.status_code == 200
        assert result.body["ok"] is True
        assert result.body["output"]["forecast"] == "sunny"
        assert pay_counter[0] == 1, f"expected exactly one payment authorization, got {pay_counter[0]}"
        assert server.challenge_count == 1, f"expected one 402 challenge, got {server.challenge_count}"
        assert server.paid_retry_count == 2, f"expected two paid attempts, got {server.paid_retry_count}"
        assert result.attempts == 3, f"expected 3 attempts total, got {result.attempts}"
        assert result.receipt["idempotency_key"] == result.idempotency_key
        assert result.receipt["status"] == "demo-accepted"
        assert result.payment_authorization == server.last_payment_token
        assert result.receipt["receipt_id"].startswith("rcpt_")

        assert LocalExecuteWrapper._parse_json_body("temporary outage") == {"raw_body": "temporary outage"}
        challenge = {
            "amount": "0.01",
            "asset": "USDC",
            "pay_to": "demo-mcp-seller",
            "resource": server.tool_name,
            "nonce": "idem_123",
        }
        encoded_challenge = base64.b64encode(json.dumps(challenge).encode("utf-8")).decode("utf-8")
        assert LocalExecuteWrapper._extract_payment_challenge({"payment-required": encoded_challenge}, {}) == challenge
        try:
            LocalExecuteWrapper._extract_payment_challenge({}, {"error": "missing challenge"})
            raise AssertionError("expected unusable payment challenge to fail closed")
        except RuntimeError as exc:
            assert "missing usable payment challenge" in str(exc)
        assert LocalExecuteWrapper._extract_receipt({}, {"receipt_id": "rcpt_minimal"})["receipt_id"] == "rcpt_minimal"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=1.0)

    final_attempt_server = DemoExecuteServer(("127.0.0.1", 0), secret=secret)
    final_attempt_thread = threading.Thread(target=final_attempt_server.serve_forever, daemon=True)
    final_attempt_thread.start()
    try:
        final_attempt_wrapper = LocalExecuteWrapper(
            f"http://127.0.0.1:{final_attempt_server.server_address[1]}",
            max_attempts=1,
        )
        pay_counter = [0]
        try:
            final_attempt_wrapper.execute(
                tool_name=final_attempt_server.tool_name,
                tool_input={"location": "berlin"},
                pay=demo_pay_callback_factory(secret, pay_counter),
            )
            raise AssertionError("expected final-attempt 402 to fail before payment authorization")
        except RuntimeError as exc:
            assert "final attempt" in str(exc)
        assert pay_counter[0] == 0
    finally:
        final_attempt_server.shutdown()
        final_attempt_server.server_close()
        final_attempt_thread.join(timeout=1.0)


def main() -> None:
    _self_test()

    secret = b"demo-secret-only"
    server = DemoExecuteServer(("127.0.0.1", 0), secret=secret)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        base_url = f"http://127.0.0.1:{server.server_address[1]}"
        wrapper = LocalExecuteWrapper(base_url)
        result = wrapper.execute(
            tool_name=server.tool_name,
            tool_input={"location": "berlin"},
            pay=demo_pay_callback_factory(secret, counter=[0]),
        )
        print(build_markdown_guide(result, server))
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=1.0)


if __name__ == "__main__":
    main()
