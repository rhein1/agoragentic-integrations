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
    payment_challenge: JsonDict


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
        payment_challenge: JsonDict = {}
        last_error: Optional[BaseException] = None

        for attempt in range(1, self.max_attempts + 1):
            current_headers = dict(request_headers)
            if payment_token:
                current_headers["PAYMENT-SIGNATURE"] = payment_token
                current_headers["X-RETRY-ATTEMPT"] = str(attempt)

            status_code, headers, body = self._post_json("/api/x402/execute", request_body, current_headers)

            if status_code == 402:
                if payment_token is not None:
                    raise RuntimeError("server returned 402 after payment was already authorized")
                challenge = self._extract_challenge(headers, body)
                payment_challenge = challenge
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
                    payment_challenge=payment_challenge,
                )

            detail = (
                body.get("error") or body.get("message") or f"HTTP {status_code}"
                if isinstance(body, dict)
                else f"HTTP {status_code}"
            )
            raise RuntimeError(f"execute failed after {attempt} attempt(s): {detail}")

        raise RuntimeError(f"execute exhausted retries: {last_error}")

    def build_receipt_checklist(self, result: ExecuteResult, expected_quote_id: str) -> ReceiptChecklistReport:
        receipt = result.receipt or {}
        body = result.body or {}
        invocation = body.get("invocation") if isinstance(body, dict) else {}
        if not isinstance(invocation, dict):
            invocation = {}
        quote = body.get("quote") if isinstance(body, dict) else {}
        if not isinstance(quote, dict):
            quote = {}
        expected_amount = self._first_nonempty(
            result.payment_challenge.get("amount"),
            result.payment_challenge.get("maxAmountRequired"),
        )
        expected_asset = self._first_nonempty(
            result.payment_challenge.get("asset"),
            result.payment_challenge.get("currency"),
            result.payment_challenge.get("token"),
        )
        report = ReceiptChecklistReport()

        receipt_id = self._first_nonempty(receipt.get("receipt_id"), receipt.get("id"))
        invocation_id = self._first_nonempty(
            receipt.get("invocation_id"),
            invocation.get("id"),
            body.get("invocation_id"),
        )
        paid_amount = self._first_nonempty(receipt.get("amount"), receipt.get("amount_usdc"))
        paid_asset = self._first_nonempty(receipt.get("asset"), receipt.get("currency"), receipt.get("token"))
        quote_id = self._first_nonempty(receipt.get("quote_id"), body.get("quote_id"), quote.get("id"))
        state = str(self._first_nonempty(receipt.get("status"), receipt.get("state"), "")).lower()
        seller = self._first_nonempty(receipt.get("seller"), receipt.get("receiver"), receipt.get("pay_to"))
        payment_hash = self._first_nonempty(receipt.get("payment_hash"), receipt.get("proof_hash"))
        echoed_idempotency = self._first_nonempty(receipt.get("idempotency_key"), body.get("idempotency_key"))

        report.add("http success", 200 <= result.status_code < 300, f"status_code={result.status_code}")
        report.add("receipt id", bool(receipt_id), f"receipt_id={receipt_id!r}")
        report.add("invocation id", bool(invocation_id), f"invocation_id={invocation_id!r}")
        report.add("quote id matches", quote_id == expected_quote_id, f"quote_id={quote_id!r}, expected={expected_quote_id!r}")
        report.add(
            "receipt status acceptable",
            state in {"demo-accepted", "accepted", "pending", "settled", "completed", "paid", "verified", "succeeded"},
            f"status={state!r}",
        )
        report.add(
            "paid asset matches challenge",
            bool(paid_asset) and (expected_asset is None or str(paid_asset) == str(expected_asset)),
            f"asset={paid_asset!r}, expected={expected_asset!r}",
        )
        report.add(
            "paid amount matches challenge",
            bool(paid_amount) and (expected_amount is None or str(paid_amount) == str(expected_amount)),
            f"amount={paid_amount!r}, expected={expected_amount!r}",
        )
        report.add("seller present", bool(seller), f"seller={seller!r}")
        report.add("payment proof hash present", bool(payment_hash), f"payment_hash={payment_hash!r}")
        report.add(
            "idempotency echoed",
            echoed_idempotency == result.idempotency_key,
            f"echoed={echoed_idempotency!r}, expected={result.idempotency_key!r}",
        )
        report.add(
            "buyer retried after payment",
            result.attempts >= 2,
            f"attempts={result.attempts} (1=challenge, 2=first paid retry)",
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
                parsed = json.loads(raw or "{}")
                return response.status, self._normalize_headers(response.headers), parsed if isinstance(parsed, dict) else {}
        except HTTPError as exc:
            raw = exc.read().decode("utf-8")
            parsed = json.loads(raw or "{}")
            return exc.code, self._normalize_headers(exc.headers), parsed if isinstance(parsed, dict) else {}
        except URLError as exc:
            raise RuntimeError(f"network error: {exc}") from exc

    @staticmethod
    def _extract_challenge(headers: Mapping[str, str], body: Mapping[str, Any]) -> JsonDict:
        challenge_header = (
            headers.get("x-payment-required")
            or headers.get("x-payment-requirements")
            or headers.get("payment-required")
            or headers.get("payment-requirements")
        )
        if challenge_header:
            try:
                return _normalize_object_or_first(_decode_json_or_base64(challenge_header))
            except Exception:
                pass
        challenge_body = body.get("payment_required") or body.get("challenge") or body
        try:
            return _normalize_object_or_first(challenge_body)
        except RuntimeError as exc:
            raise RuntimeError("402 response missing usable challenge") from exc

    @staticmethod
    def _receipt_from_identifier(receipt_id: Any) -> Optional[JsonDict]:
        if isinstance(receipt_id, str) and receipt_id.strip():
            return {"receipt_id": receipt_id.strip(), "status": "accepted"}
        return None

    @classmethod
    def _receipt_from_header(cls, header_value: str) -> Optional[JsonDict]:
        try:
            parsed = _decode_json_or_base64(header_value)
            if isinstance(parsed, dict):
                return dict(parsed)
        except Exception:
            pass
        return cls._receipt_from_identifier(header_value)

    @classmethod
    def _extract_receipt(cls, headers: Mapping[str, str], body: Mapping[str, Any]) -> JsonDict:
        receipt = body.get("receipt")
        if isinstance(receipt, dict):
            return dict(receipt)
        identifier_receipt = cls._receipt_from_identifier(body.get("receipt_id") or body.get("id"))
        if identifier_receipt:
            return identifier_receipt

        for key in ("x-payment-receipt", "payment-receipt", "payment-response"):
            header_value = headers.get(key)
            if not header_value:
                continue
            header_receipt = cls._receipt_from_header(header_value)
            if header_receipt:
                return header_receipt

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


def _decode_json_or_base64(value: str) -> Any:
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        decoded = base64.b64decode(value.encode("utf-8"), validate=True).decode("utf-8")
        return json.loads(decoded)


def _normalize_object_or_first(value: Any) -> JsonDict:
    if isinstance(value, list) and value:
        value = value[0]
    if isinstance(value, dict):
        return dict(value)
    raise RuntimeError("value did not decode to an object or non-empty object array")


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
        self.skip_transient_failure = False


class DemoPaidCallHandler(BaseHTTPRequestHandler):
    server: DemoPaidCallServer

    def do_POST(self) -> None:
        if self.path != "/api/x402/execute":
            self._send_json(404, {"error": "not found"})
            return

        length = int(self.headers.get("Content-Length", "0"))
        payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
        quote_id = payload.get("quote_id")
        idempotency_key = self.headers.get("Idempotency-Key")
        payment_token = self.headers.get("PAYMENT-SIGNATURE")

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
                extra_headers={
                    "PAYMENT-REQUIRED": base64.b64encode(
                        json.dumps([challenge]).encode("utf-8")
                    ).decode("ascii")
                },
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
        self.server.paid_attempt_count += 1
        if self.server.paid_attempt_count == 1 and not self.server.skip_transient_failure:
            self._send_json(503, {"error": "transient upstream timeout after payment authorization"})
            return

        invocation_id = f"inv_{uuid.uuid4().hex[:12]}"
        receipt = {
            "receipt_id": f"rcpt_{uuid.uuid4().hex[:12]}",
            "quote_id": self.server.quote_id,
            "invocation_id": invocation_id,
            "idempotency_key": idempotency_key,
            "status": "demo-accepted",
            "amount": self.server.expected_amount,
            "asset": self.server.asset,
            "seller": self.server.seller,
            "network": "base-sepolia",
            "payment_hash": hashlib.sha256(payment_token.encode("utf-8")).hexdigest(),
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
        self._send_json(200, response, extra_headers={"PAYMENT-RESPONSE": encoded_receipt})

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


def run_demo(*, skip_transient_failure: bool = False) -> Tuple[ExecuteResult, ReceiptChecklistReport]:
    secret = b"demo-shared-secret"
    server = DemoPaidCallServer(("127.0.0.1", 0), secret)
    server.skip_transient_failure = skip_transient_failure
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

    two_attempt_result, two_attempt_checklist = run_demo(skip_transient_failure=True)
    assert two_attempt_result.status_code == 200, two_attempt_result.status_code
    assert two_attempt_result.attempts == 2, two_attempt_result.attempts
    assert two_attempt_checklist.ok, two_attempt_checklist.as_text()

    client = X402ZkMeshReceiptChecklistClient(
        base_url="http://127.0.0.1:1",
        payment_signer=lambda challenge: "unused",
    )
    parsed_receipt = client._extract_receipt(
        {"payment-response": base64.b64encode(json.dumps(two_attempt_result.receipt).encode("utf-8")).decode("ascii")},
        {},
    )
    assert parsed_receipt["receipt_id"] == two_attempt_result.receipt["receipt_id"]

    mismatched_receipt = dict(two_attempt_result.receipt)
    mismatched_receipt["asset"] = "WRONG"
    mismatched_result = ExecuteResult(
        status_code=two_attempt_result.status_code,
        body=two_attempt_result.body,
        receipt=mismatched_receipt,
        headers=two_attempt_result.headers,
        attempts=two_attempt_result.attempts,
        idempotency_key=two_attempt_result.idempotency_key,
        payment_token=two_attempt_result.payment_token,
        payment_challenge=two_attempt_result.payment_challenge,
    )
    mismatch_checklist = client.build_receipt_checklist(mismatched_result, expected_quote_id="quote_demo_x402")
    assert not mismatch_checklist.ok
    assert any(item.name == "paid asset matches challenge" and not item.ok for item in mismatch_checklist.items)


if __name__ == "__main__":
    _self_test()
    result, checklist = run_demo()
    print("execute() buyer retry example")
    print(f"status_code={result.status_code}")
    print(f"attempts={result.attempts}")
    print(f"idempotency_key={result.idempotency_key}")
    print(f"receipt_id={result.receipt.get('receipt_id')}")
    print(checklist.as_text())
