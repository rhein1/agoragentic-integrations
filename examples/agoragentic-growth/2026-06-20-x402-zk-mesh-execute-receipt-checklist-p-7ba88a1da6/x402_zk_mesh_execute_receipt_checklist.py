#!/usr/bin/env python3
# demo — moves no real funds
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import threading
import time
import uuid
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Dict, List, Mapping, MutableMapping, Optional, Tuple
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


JsonDict = Dict[str, Any]
PaymentSigner = Callable[[JsonDict], str]


@dataclass
class ChecklistItem:
    name: str
    ok: bool
    detail: str


@dataclass
class ReceiptChecklistReport:
    items: List[ChecklistItem] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return all(item.ok for item in self.items)

    def add(self, name: str, ok: bool, detail: str) -> None:
        self.items.append(ChecklistItem(name=name, ok=ok, detail=detail))

    def as_text(self) -> str:
        lines = []
        for item in self.items:
            status = "PASS" if item.ok else "FAIL"
            lines.append(f"[{status}] {item.name}: {item.detail}")
        lines.append(f"OVERALL: {'PASS' if self.ok else 'FAIL'}")
        return "\n".join(lines)


@dataclass
class ExecuteResult:
    status_code: int
    body: JsonDict
    receipt: JsonDict
    headers: Dict[str, str]
    attempts: int
    idempotency_key: str
    payment_token: str


class X402ZkMeshReceiptChecklistClient:
    def __init__(
        self,
        base_url: str,
        payment_signer: PaymentSigner,
        timeout: float = 5.0,
        max_attempts: int = 4,
        sleep_seconds: float = 0.2,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.payment_signer = payment_signer
        self.timeout = timeout
        self.max_attempts = max_attempts
        self.sleep_seconds = sleep_seconds

    def execute(self, quote_id: str, payload: Mapping[str, Any]) -> ExecuteResult:
        idempotency_key = f"x402-execute-{quote_id}-{uuid.uuid4().hex[:12]}"
        request_body = {"quote_id": quote_id, "input": dict(payload)}
        request_headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Idempotency-Key": idempotency_key,
        }

        payment_token: Optional[str] = None
        last_error: Optional[BaseException] = None

        for attempt in range(1, self.max_attempts + 1):
            current_headers = dict(request_headers)
            if payment_token:
                current_headers["X-PAYMENT"] = payment_token
                current_headers["X-RETRY-ATTEMPT"] = str(attempt)

            status_code, headers, body = self._post_json("/api/execute", request_body, current_headers)

            if status_code == 402:
                if payment_token is not None:
                    raise RuntimeError("server returned 402 after payment was already authorized")
                challenge = self._extract_challenge(headers, body)
                payment_token = self.payment_signer(challenge)
                continue

            if status_code in {408, 409, 425, 429, 500, 502, 503, 504}:
                last_error = RuntimeError(f"retryable status {status_code}")
                if attempt < self.max_attempts:
                    time.sleep(self.sleep_seconds)
                    continue

            if 200 <= status_code < 300:
                receipt = self._extract_receipt(headers, body)
                return ExecuteResult(
                    status_code=status_code,
                    body=body,
                    receipt=receipt,
                    headers=headers,
                    attempts=attempt,
                    idempotency_key=idempotency_key,
                    payment_token=payment_token or "",
                )

            detail = body.get("error") or body.get("message") or f"HTTP {status_code}"
            raise RuntimeError(f"execute failed after {attempt} attempt(s): {detail}")

        raise RuntimeError(f"execute exhausted retries: {last_error}")

    def build_receipt_checklist(self, result: ExecuteResult, expected_quote_id: str) -> ReceiptChecklistReport:
        receipt = result.receipt or {}
        body = result.body or {}
        invocation = body.get("invocation") or {}
        report = ReceiptChecklistReport()

        receipt_id = self._first_nonempty(receipt.get("receipt_id"), receipt.get("id"))
        invocation_id = self._first_nonempty(
            receipt.get("invocation_id"),
            invocation.get("id"),
            body.get("invocation_id"),
        )
        paid_amount = self._first_nonempty(receipt.get("amount"), receipt.get("amount_usdc"))
        paid_asset = self._first_nonempty(receipt.get("asset"), receipt.get("currency"), receipt.get("token"))
        quote_id = self._first_nonempty(receipt.get("quote_id"), body.get("quote_id"), body.get("quote", {}).get("id"))
        state = str(self._first_nonempty(receipt.get("status"), receipt.get("state"), "")).lower()
        seller = self._first_nonempty(receipt.get("seller"), receipt.get("receiver"), receipt.get("pay_to"))
        payment_hash = self._first_nonempty(receipt.get("payment_hash"), receipt.get("proof_hash"))
        echoed_idempotency = self._first_nonempty(receipt.get("idempotency_key"), body.get("idempotency_key"))
        retry_reused_payment = bool(body.get("retry_reused_payment"))

        report.add("http success", 200 <= result.status_code < 300, f"status_code={result.status_code}")
        report.add("receipt id", bool(receipt_id), f"receipt_id={receipt_id!r}")
        report.add("invocation id", bool(invocation_id), f"invocation_id={invocation_id!r}")
        report.add("quote id matches", quote_id == expected_quote_id, f"quote_id={quote_id!r}, expected={expected_quote_id!r}")
        report.add("settled status", state == "settled", f"status={state!r}")
        report.add("paid asset present", bool(paid_asset), f"asset={paid_asset!r}")
        report.add("paid amount present", bool(paid_amount), f"amount={paid_amount!r}")
        report.add("seller present", bool(seller), f"seller={seller!r}")
        report.add("payment proof hash present", bool(payment_hash), f"payment_hash={payment_hash!r}")
        report.add(
            "idempotency echoed",
            echoed_idempotency == result.idempotency_key,
            f"echoed={echoed_idempotency!r}, expected={result.idempotency_key!r}",
        )
        report.add(
            "buyer retried after payment",
            result.attempts >= 3,
            f"attempts={result.attempts} (1=challenge, 2+=paid retry path)",
        )
        report.add(
            "payment authorization reused on retry",
            retry_reused_payment,
            f"retry_reused_payment={retry_reused_payment}",
        )
        return report

    def _post_json(self, path: str, payload: Mapping[str, Any], headers: Mapping[str, str]) -> Tuple[int, Dict[str, str], JsonDict]:
        body_bytes = json.dumps(payload).encode("utf-8")
        request = Request(
            f"{self.base_url}{path}",
            data=body_bytes,
            headers=dict(headers),
            method="POST",
        )
        try:
            with urlopen(request, timeout=self.timeout) as response:
                raw = response.read().decode("utf-8")
                return response.status, self._normalize_headers(response.headers), json.loads(raw or "{}")
        except HTTPError as exc:
            raw = exc.read().decode("utf-8")
            return exc.code, self._normalize_headers(exc.headers), json.loads(raw or "{}")
        except URLError as exc:
            raise RuntimeError(f"network error: {exc}") from exc

    @staticmethod
    def _extract_challenge(headers: Mapping[str, str], body: Mapping[str, Any]) -> JsonDict:
        challenge_header = headers.get("x-payment-required") or headers.get("payment-required")
        if challenge_header:
            try:
                return json.loads(challenge_header)
            except json.JSONDecodeError:
                pass
        challenge_body = body.get("payment_required") or body.get("challenge") or body
        if isinstance(challenge_body, dict):
            return dict(challenge_body)
        raise RuntimeError("402 response missing usable challenge")

    @staticmethod
    def _extract_receipt(headers: Mapping[str, str], body: Mapping[str, Any]) -> JsonDict:
        receipt = body.get("receipt")
        if isinstance(receipt, dict):
            return dict(receipt)

        for key in ("x-payment-receipt", "payment-receipt"):
            header_value = headers.get(key)
            if not header_value:
                continue
            try:
                decoded = base64.b64decode(header_value.encode("utf-8"), validate=True).decode("utf-8")
                parsed = json.loads(decoded)
                if isinstance(parsed, dict):
                    return parsed
            except Exception:
                try:
                    parsed = json.loads(header_value)
                    if isinstance(parsed, dict):
                        return parsed
                except Exception:
                    continue

        raise RuntimeError("success response missing receipt")

    @staticmethod
    def _normalize_headers(headers: Mapping[str, Any]) -> Dict[str, str]:
        return {str(k).lower(): str(v) for k, v in headers.items()}

    @staticmethod
    def _first_nonempty(*values: Any) -> Any:
        for value in values:
            if value is None:
                continue
            if isinstance(value, str) and not value.strip():
                continue
            return value
        return None


class DemoPaidCallServer(ThreadingHTTPServer):
    def __init__(self, server_address: Tuple[str, int], secret: bytes) -> None:
        super().__init__(server_address, DemoPaidCallHandler)
        self.secret = secret
        self.challenge_count = 0
        self.paid_attempt_count = 0
        self.last_idempotency_key: Optional[str] = None
        self.quote_id = "quote_demo_x402"
        self.expected_amount = "0.25"
        self.asset = "USDC"
        self.seller = "demo-seller"
        self.first_paid_token: Optional[str] = None


class DemoPaidCallHandler(BaseHTTPRequestHandler):
    server: DemoPaidCallServer

    def do_POST(self) -> None:
        if self.path != "/api/execute":
            self._send_json(404, {"error": "not found"})
            return

        length = int(self.headers.get("Content-Length", "0"))
        payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
        quote_id = payload.get("quote_id")
        idempotency_key = self.headers.get("Idempotency-Key")
        payment_token = self.headers.get("X-PAYMENT")

        if quote_id != self.server.quote_id:
            self._send_json(400, {"error": f"unknown quote_id {quote_id!r}"})
            return

        if not payment_token:
            self.server.challenge_count += 1
            challenge = {
                "quote_id": self.server.quote_id,
                "amount": self.server.expected_amount,
                "asset": self.server.asset,
                "seller": self.server.seller,
                "nonce": f"nonce-{self.server.challenge_count}",
                "network": "base-sepolia",
            }
            self._send_json(
                402,
                {"error": "payment required", "payment_required": challenge},
                extra_headers={"X-Payment-Required": json.dumps(challenge)},
            )
            return

        if not idempotency_key:
            self._send_json(400, {"error": "missing idempotency key"})
            return

        if not self._verify_payment(payment_token):
            self._send_json(401, {"error": "invalid payment token"})
            return

        if self.server.last_idempotency_key is None:
            self.server.last_idempotency_key = idempotency_key
        elif self.server.last_idempotency_key != idempotency_key:
            self._send_json(409, {"error": "idempotency key changed between retries"})
            return

        if self.server.first_paid_token is None:
            self.server.first_paid_token = payment_token
        retry_reused_payment = self.server.first_paid_token == payment_token

        self.server.paid_attempt_count += 1
        if self.server.paid_attempt_count == 1:
            self._send_json(503, {"error": "transient upstream timeout after payment authorization"})
            return

        invocation_id = f"inv_{uuid.uuid4().hex[:12]}"
        receipt = {
            "receipt_id": f"rcpt_{uuid.uuid4().hex[:12]}",
            "quote_id": self.server.quote_id,
            "invocation_id": invocation_id,
            "idempotency_key": idempotency_key,
            "status": "settled",
            "amount": self.server.expected_amount,
            "asset": self.server.asset,
            "seller": self.server.seller,
            "network": "base-sepolia",
            "payment_hash": hashlib.sha256(payment_token.encode("utf-8")).hexdigest(),
            "settled_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        response = {
            "ok": True,
            "quote_id": self.server.quote_id,
            "idempotency_key": idempotency_key,
            "invocation": {"id": invocation_id, "status": "completed"},
            "retry_reused_payment": retry_reused_payment,
            "output": {
                "message": "paid execution complete",
                "echo": payload.get("input", {}),
            },
            "receipt": receipt,
        }
        encoded_receipt = base64.b64encode(json.dumps(receipt).encode("utf-8")).decode("ascii")
        self._send_json(200, response, extra_headers={"X-Payment-Receipt": encoded_receipt})

    def log_message(self, format: str, *args: Any) -> None:
        return

    def _verify_payment(self, token: str) -> bool:
        try:
            signed = json.loads(base64.b64decode(token.encode("utf-8")).decode("utf-8"))
        except Exception:
            return False
        challenge = signed.get("challenge")
        signature = signed.get("signature")
        if not isinstance(challenge, dict) or not isinstance(signature, str):
            return False
        canonical = json.dumps(challenge, sort_keys=True, separators=(",", ":")).encode("utf-8")
        expected = hmac.new(self.server.secret, canonical, hashlib.sha256).hexdigest()
        return hmac.compare_digest(expected, signature)

    def _send_json(self, status: int, body: Mapping[str, Any], extra_headers: Optional[MutableMapping[str, str]] = None) -> None:
        encoded = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        if extra_headers:
            for key, value in extra_headers.items():
                self.send_header(key, value)
        self.end_headers()
        self.wfile.write(encoded)


def make_demo_payment_signer(secret: bytes) -> PaymentSigner:
    def signer(challenge: JsonDict) -> str:
        canonical = json.dumps(challenge, sort_keys=True, separators=(",", ":")).encode("utf-8")
        signature = hmac.new(secret, canonical, hashlib.sha256).hexdigest()
        envelope = {"challenge": challenge, "signature": signature}
        return base64.b64encode(json.dumps(envelope).encode("utf-8")).decode("ascii")

    return signer


def run_demo() -> Tuple[ExecuteResult, ReceiptChecklistReport]:
    secret = b"demo-shared-secret"
    server = DemoPaidCallServer(("127.0.0.1", 0), secret)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        client = X402ZkMeshReceiptChecklistClient(
            base_url=f"http://127.0.0.1:{server.server_address[1]}",
            payment_signer=make_demo_payment_signer(secret),
            max_attempts=4,
            sleep_seconds=0.05,
        )
        result = client.execute(server.quote_id, {"task": "summarize receipt handling", "max_tokens": 64})
        checklist = client.build_receipt_checklist(result, expected_quote_id=server.quote_id)
        return result, checklist
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=1)


def _self_test() -> None:
    result, checklist = run_demo()
    assert result.status_code == 200, result.status_code
    assert result.attempts == 3, result.attempts
    assert checklist.ok, checklist.as_text()
    assert result.receipt["idempotency_key"] == result.idempotency_key
    assert result.receipt["quote_id"] == "quote_demo_x402"


if __name__ == "__main__":
    _self_test()
    result, checklist = run_demo()
    print("execute() buyer retry example")
    print(f"status_code={result.status_code}")
    print(f"attempts={result.attempts}")
    print(f"idempotency_key={result.idempotency_key}")
    print(f"receipt_id={result.receipt.get('receipt_id')}")
    print(checklist.as_text())
