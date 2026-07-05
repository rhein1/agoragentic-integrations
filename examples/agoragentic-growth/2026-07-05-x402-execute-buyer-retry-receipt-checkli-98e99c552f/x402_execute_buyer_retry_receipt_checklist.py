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
RETRYABLE_STATUS_CODES = {408, 409, 425, 429, 500, 502, 503, 504}
TERMINAL_RECEIPT_STATES = {"settled", "completed", "paid", "succeeded"}


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
            lines.append(f"[{'PASS' if item.ok else 'FAIL'}] {item.name}: {item.detail}")
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
    payment_challenge: JsonDict


class X402ReceiptChecklistClient:
    def __init__(
        self,
        base_url: str,
        payment_signer: PaymentSigner,
        timeout: float = 5.0,
        max_attempts: int = 3,
        sleep_seconds: float = 0.2,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.payment_signer = payment_signer
        self.timeout = timeout
        self.max_attempts = max_attempts
        self.sleep_seconds = sleep_seconds

    def execute(self, quote_id: str, payload: Mapping[str, Any]) -> ExecuteResult:
        idempotency_key = f"execute-{quote_id}-{uuid.uuid4().hex[:12]}"
        request_body = {"quote_id": quote_id, "input": dict(payload)}
        request_headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Idempotency-Key": idempotency_key,
        }

        payment_token: Optional[str] = None
        payment_challenge: JsonDict = {}
        last_error: Optional[BaseException] = None

        for attempt in range(1, self.max_attempts + 1):
            current_headers = dict(request_headers)
            if payment_token:
                current_headers["X-PAYMENT"] = payment_token
                current_headers["X-RETRY-ATTEMPT"] = str(attempt)

            status_code, headers, body = self._post_json("/api/execute", request_body, current_headers)

            if status_code == 402:
                if payment_token is not None:
                    raise RuntimeError("paid retry was rejected with another HTTP 402; refusing to replay stale payment")
                challenge = self._extract_challenge(headers, body)
                payment_challenge = dict(challenge)
                payment_token = self.payment_signer(challenge)
                continue

            if status_code in RETRYABLE_STATUS_CODES:
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
                    payment_challenge=payment_challenge,
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
        challenge = result.payment_challenge or {}
        challenge_amount = self._first_nonempty(challenge.get("amount"), challenge.get("max_amount_usdc"), challenge.get("maxAmountRequired"), challenge.get("price"))
        challenge_asset = self._first_nonempty(challenge.get("asset"), challenge.get("currency"), challenge.get("token"))
        challenge_seller = self._first_nonempty(challenge.get("seller"), challenge.get("receiver"), challenge.get("pay_to"), challenge.get("payTo"))

        report.add("http success", 200 <= result.status_code < 300, f"status_code={result.status_code}")
        report.add("receipt id", bool(receipt_id), f"receipt_id={receipt_id!r}")
        report.add("invocation id", bool(invocation_id), f"invocation_id={invocation_id!r}")
        report.add("quote id matches", quote_id == expected_quote_id, f"quote_id={quote_id!r}, expected={expected_quote_id!r}")
        report.add("terminal receipt status", state in TERMINAL_RECEIPT_STATES, f"status={state!r}")
        report.add(
            "paid asset matches challenge",
            bool(paid_asset) and (not challenge_asset or str(paid_asset).lower() == str(challenge_asset).lower()),
            f"asset={paid_asset!r}, challenge_asset={challenge_asset!r}",
        )
        report.add(
            "paid amount matches challenge",
            bool(paid_amount) and (not challenge_amount or str(paid_amount) == str(challenge_amount)),
            f"amount={paid_amount!r}, challenge_amount={challenge_amount!r}",
        )
        report.add(
            "seller matches challenge",
            bool(seller) and (not challenge_seller or str(seller) == str(challenge_seller)),
            f"seller={seller!r}, challenge_seller={challenge_seller!r}",
        )
        report.add("payment proof hash present", bool(payment_hash), f"payment_hash={payment_hash!r}")
        report.add(
            "idempotency echoed",
            echoed_idempotency == result.idempotency_key,
            f"echoed={echoed_idempotency!r}, expected={result.idempotency_key!r}",
        )
        report.add(
            "buyer retried after payment",
            result.attempts >= 2,
            f"attempts={result.attempts} (1=challenge, 2+=paid retry path)",
        )
        report.add(
            "payment token reused",
            bool(result.payment_token),
            f"payment_token_prefix={result.payment_token[:20]!r}",
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
                return response.status, self._normalize_headers(dict(response.headers.items())), self._parse_json(raw)
        except HTTPError as exc:
            raw = exc.read().decode("utf-8")
            return exc.code, self._normalize_headers(dict(exc.headers.items())), self._parse_json(raw)
        except URLError as exc:
            raise RuntimeError(f"network error: {exc}") from exc

    @staticmethod
    def _extract_challenge(headers: Mapping[str, str], body: Mapping[str, Any]) -> JsonDict:
        challenge_header = (
            headers.get("x-payment-required")
            or headers.get("payment-required")
            or headers.get("x-payment-requirements")
            or headers.get("payment-requirements")
        )
        if challenge_header:
            parsed_header = X402ReceiptChecklistClient._parse_json_or_base64(challenge_header)
            if isinstance(parsed_header, dict):
                return dict(parsed_header)
        challenge_body = (
            body.get("payment_required")
            or body.get("payment_requirements")
            or body.get("paymentRequired")
            or body.get("paymentRequirements")
            or body.get("challenge")
            or body
        )
        if isinstance(challenge_body, dict):
            return dict(challenge_body)
        raise RuntimeError("402 response missing usable challenge")

    @staticmethod
    def _extract_receipt(headers: Mapping[str, str], body: Mapping[str, Any]) -> JsonDict:
        receipt = body.get("receipt")
        if isinstance(receipt, dict):
            return dict(receipt)

        for key in ("x-payment-receipt", "payment-receipt", "x-payment-response", "payment-response"):
            header_value = headers.get(key)
            if not header_value:
                continue
            parsed = X402ReceiptChecklistClient._parse_json_or_base64(header_value)
            if isinstance(parsed, dict):
                return parsed

        raise RuntimeError("success response missing receipt")

    @staticmethod
    def _parse_json(raw: str) -> JsonDict:
        if not raw:
            return {}
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            return {"raw": raw}
        return parsed if isinstance(parsed, dict) else {"value": parsed}

    @staticmethod
    def _parse_json_or_base64(value: str) -> Any:
        candidates = [value]
        try:
            candidates.append(base64.b64decode(value.encode("utf-8"), validate=True).decode("utf-8"))
        except Exception:
            pass
        for candidate in candidates:
            try:
                return json.loads(candidate)
            except Exception:
                continue
        return None

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


class DemoPaidCallHandler(BaseHTTPRequestHandler):
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
        client = X402ReceiptChecklistClient(
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
