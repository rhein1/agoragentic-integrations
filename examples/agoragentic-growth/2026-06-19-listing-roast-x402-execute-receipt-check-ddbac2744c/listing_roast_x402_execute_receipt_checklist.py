#!/usr/bin/env python3
# demo — moves no real funds.

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
PayCallback = Callable[[JsonDict, JsonDict], str]


@dataclass
class ChecklistItem:
    name: str
    ok: bool
    detail: str


@dataclass
class ReceiptChecklist:
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
    attempts: int
    idempotency_key: str
    payment_authorization: str
    challenge: JsonDict
    request_body: JsonDict
    request_path: str


class ListingRoastX402Client:
    def __init__(
        self,
        base_url: str,
        *,
        pay_callback: Optional[PayCallback] = None,
        timeout: float = 5.0,
        max_attempts: int = 4,
        retry_sleep_seconds: float = 0.05,
        user_agent: str = "listing-roast-x402-checklist/1.0",
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.pay_callback = pay_callback
        self.timeout = timeout
        self.max_attempts = max_attempts
        self.retry_sleep_seconds = retry_sleep_seconds
        self.user_agent = user_agent

    def execute(
        self,
        quote_id: str,
        roast_input: Mapping[str, Any],
        *,
        path: str = "/api/listing-roast/execute",
    ) -> ExecuteResult:
        idempotency_key = f"listing-roast-{quote_id}-{uuid.uuid4().hex[:12]}"
        request_body = {
            "quote_id": quote_id,
            "input": dict(roast_input),
        }
        base_headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Idempotency-Key": idempotency_key,
            "User-Agent": self.user_agent,
        }

        payment_authorization: Optional[str] = None
        challenge: Optional[JsonDict] = None
        paid_request_count = 0
        saw_402 = False
        last_retryable_error: Optional[str] = None

        for attempt in range(1, self.max_attempts + 1):
            headers = dict(base_headers)
            if payment_authorization is not None:
                headers["X-Payment"] = payment_authorization
                headers["X-Retry-Attempt"] = str(attempt)
                paid_request_count += 1

            status_code, response_headers, body = self._post_json(path, request_body, headers)

            if status_code == 402:
                saw_402 = True
                if payment_authorization is not None:
                    raise RuntimeError("server returned HTTP 402 after payment authorization; refusing to re-authorize")
                challenge = self._extract_challenge(response_headers, body)
                payment_authorization = self._authorize_payment(challenge, request_body)
                continue

            if status_code in {408, 409, 425, 429, 500, 502, 503, 504}:
                last_retryable_error = f"retryable HTTP {status_code}"
                if attempt < self.max_attempts:
                    time.sleep(self.retry_sleep_seconds)
                    continue

            if 200 <= status_code < 300:
                if not saw_402:
                    raise RuntimeError("success path did not include an HTTP 402 payment challenge")
                if challenge is None or payment_authorization is None:
                    raise RuntimeError("success path missing payment challenge or authorization")
                receipt = self._extract_receipt(response_headers, body)
                if paid_request_count < 1:
                    raise RuntimeError("success path did not include a paid retry")
                return ExecuteResult(
                    status_code=status_code,
                    body=body,
                    receipt=receipt,
                    attempts=attempt,
                    idempotency_key=idempotency_key,
                    payment_authorization=payment_authorization,
                    challenge=challenge,
                    request_body=request_body,
                    request_path=path,
                )

            detail = body.get("error") or body.get("message") or f"HTTP {status_code}"
            raise RuntimeError(f"listing-roast execute failed after {attempt} attempt(s): {detail}")

        raise RuntimeError(f"listing-roast execute exhausted retries: {last_retryable_error or 'unknown error'}")

    def build_receipt_checklist(self, result: ExecuteResult, *, expected_quote_id: str) -> ReceiptChecklist:
        receipt = result.receipt
        invocation = result.body.get("invocation") or {}
        checklist = ReceiptChecklist()

        receipt_id = self._first_nonempty(receipt.get("receipt_id"), receipt.get("id"))
        receipt_invocation_id = self._first_nonempty(receipt.get("invocation_id"), receipt.get("invocation"))
        response_invocation_id = self._first_nonempty(invocation.get("id"), result.body.get("invocation_id"))
        quote_id = self._first_nonempty(
            receipt.get("quote_id"),
            result.body.get("quote_id"),
            result.body.get("quote", {}).get("id") if isinstance(result.body.get("quote"), dict) else None,
        )
        amount = self._first_nonempty(receipt.get("amount"), receipt.get("amount_usdc"))
        asset = self._first_nonempty(receipt.get("asset"), receipt.get("currency"), receipt.get("token"))
        seller = self._first_nonempty(receipt.get("seller"), receipt.get("receiver"), receipt.get("pay_to"))
        payment_hash = self._first_nonempty(receipt.get("payment_hash"), receipt.get("proof_hash"))
        echoed_idempotency = self._first_nonempty(receipt.get("idempotency_key"), result.body.get("idempotency_key"))
        status_text = str(self._first_nonempty(receipt.get("status"), receipt.get("state"), "")).lower()
        output = result.body.get("output") or {}

        checklist.add("http success", 200 <= result.status_code < 300, f"status_code={result.status_code}")
        checklist.add("receipt id present", bool(receipt_id), f"receipt_id={receipt_id!r}")
        checklist.add(
            "receipt invocation matches response",
            bool(receipt_invocation_id)
            and bool(response_invocation_id)
            and receipt_invocation_id == response_invocation_id,
            f"receipt_invocation_id={receipt_invocation_id!r}, response_invocation_id={response_invocation_id!r}",
        )
        checklist.add("quote id matches", quote_id == expected_quote_id, f"quote_id={quote_id!r}, expected={expected_quote_id!r}")
        checklist.add("idempotency echoed", echoed_idempotency == result.idempotency_key, f"echoed={echoed_idempotency!r}")
        checklist.add("asset matches challenge", asset == result.challenge.get("asset"), f"asset={asset!r}, expected={result.challenge.get('asset')!r}")
        checklist.add("amount matches challenge", amount == result.challenge.get("amount"), f"amount={amount!r}, expected={result.challenge.get('amount')!r}")
        checklist.add("seller matches challenge", seller == result.challenge.get("seller"), f"seller={seller!r}, expected={result.challenge.get('seller')!r}")
        checklist.add("payment proof hash present", bool(payment_hash), f"payment_hash={payment_hash!r}")
        checklist.add(
            "paid retry happened",
            result.attempts >= 2,
            f"attempts={result.attempts} (attempt 1=402, attempt 2=paid retry path)",
        )
        checklist.add(
            "payment authorization reused",
            bool(result.payment_authorization),
            f"authorization_prefix={result.payment_authorization[:20]!r}",
        )
        checklist.add(
            "service returned listing roast output",
            isinstance(output, dict) and output.get("kind") == "listing_roast",
            f"output_kind={output.get('kind')!r}",
        )
        checklist.add(
            "receipt status is demo-safe and non-terminal",
            status_text in {"demo-accepted", "accepted", "pending", "authorized-demo-only"},
            f"status={status_text!r}",
        )
        return checklist

    def _authorize_payment(self, challenge: JsonDict, request_body: JsonDict) -> str:
        if self.pay_callback is None:
            raise RuntimeError(
                "real payment authorization is disabled by default; provide pay_callback explicitly to authorize a payment challenge"
            )
        return self.pay_callback(challenge, request_body)

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
                return response.status, self._normalize_headers(response.headers), self._parse_json_body(raw)
        except HTTPError as exc:
            raw = exc.read().decode("utf-8")
            return exc.code, self._normalize_headers(exc.headers), self._parse_json_body(raw)
        except URLError as exc:
            raise RuntimeError(f"network error: {exc}") from exc

    @staticmethod
    def _extract_challenge(headers: Mapping[str, str], body: Mapping[str, Any]) -> JsonDict:
        raw = headers.get("x-payment-required") or headers.get("payment-required")
        if raw:
            try:
                parsed = self._parse_header_json(raw)
                if isinstance(parsed, dict):
                    return dict(parsed)
            except Exception:
                pass

        challenge = body.get("payment_required") or body.get("challenge")
        if isinstance(challenge, dict):
            return dict(challenge)

        raise RuntimeError("402 response missing usable payment challenge")

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
        return {str(key).lower(): str(value) for key, value in headers.items()}

    @staticmethod
    def _parse_json_body(raw: str) -> JsonDict:
        try:
            parsed = json.loads(raw or "{}")
            return dict(parsed) if isinstance(parsed, dict) else {"value": parsed}
        except json.JSONDecodeError:
            return {"error": "non_json_response", "raw_body": raw[:200]}

    @staticmethod
    def _parse_header_json(raw: str) -> JsonDict:
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            parsed = json.loads(base64.b64decode(raw.encode("utf-8")).decode("utf-8"))
        if not isinstance(parsed, dict):
            raise ValueError("header did not decode to an object")
        return parsed

    @staticmethod
    def _first_nonempty(*values: Any) -> Any:
        for value in values:
            if value is None:
                continue
            if isinstance(value, str) and not value.strip():
                continue
            return value
        return None


class DemoListingRoastServer(ThreadingHTTPServer):
    def __init__(self, server_address: Tuple[str, int], secret: bytes) -> None:
        super().__init__(server_address, DemoListingRoastHandler)
        self.secret = secret
        self.quote_id = "quote_listing_roast_demo"
        self.price_amount = "0.35"
        self.price_asset = "USDC"
        self.seller = "listing-roast-x402-service"
        self.challenge_count = 0
        self.paid_attempt_count = 0
        self.last_idempotency_key: Optional[str] = None


class DemoListingRoastHandler(BaseHTTPRequestHandler):
    server: DemoListingRoastServer

    def do_POST(self) -> None:
        if self.path != "/api/listing-roast/execute":
            self._send_json(404, {"error": "not found"})
            return

        length = int(self.headers.get("Content-Length", "0"))
        payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
        quote_id = payload.get("quote_id")
        roast_input = payload.get("input") or {}
        idempotency_key = self.headers.get("Idempotency-Key")
        payment_token = self.headers.get("X-Payment")

        if quote_id != self.server.quote_id:
            self._send_json(400, {"error": f"unknown quote_id {quote_id!r}"})
            return

        if not isinstance(roast_input, dict) or not roast_input.get("listing_url"):
            self._send_json(400, {"error": "missing listing_url"})
            return

        if payment_token is None:
            self.server.challenge_count += 1
            challenge = {
                "quote_id": self.server.quote_id,
                "amount": self.server.price_amount,
                "asset": self.server.price_asset,
                "seller": self.server.seller,
                "network": "base-sepolia",
                "nonce": f"nonce-{self.server.challenge_count}",
            }
            self._send_json(
                402,
                {"error": "payment required", "payment_required": challenge},
                extra_headers={
                    "PAYMENT-REQUIRED": base64.b64encode(json.dumps(challenge).encode("utf-8")).decode("ascii")
                },
            )
            return

        if not idempotency_key:
            self._send_json(400, {"error": "missing idempotency key"})
            return

        if not self._verify_payment(payment_token, payload):
            self._send_json(401, {"error": "invalid payment authorization"})
            return

        if self.server.last_idempotency_key is None:
            self.server.last_idempotency_key = idempotency_key
        elif self.server.last_idempotency_key != idempotency_key:
            self._send_json(409, {"error": "idempotency key changed between paid retries"})
            return

        self.server.paid_attempt_count += 1
        if self.server.paid_attempt_count == 1:
            self._send_json(503, {"error": "transient upstream timeout after payment authorization"})
            return

        invocation_id = f"inv_{uuid.uuid4().hex[:12]}"
        roast = self._build_roast(roast_input)
        receipt = {
            "receipt_id": f"rcpt_{uuid.uuid4().hex[:12]}",
            "quote_id": self.server.quote_id,
            "invocation_id": invocation_id,
            "idempotency_key": idempotency_key,
            "status": "demo-accepted",
            "amount": self.server.price_amount,
            "asset": self.server.price_asset,
            "seller": self.server.seller,
            "payment_hash": hashlib.sha256(payment_token.encode("utf-8")).hexdigest(),
            "settled_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        response = {
            "ok": True,
            "quote_id": self.server.quote_id,
            "idempotency_key": idempotency_key,
            "invocation": {"id": invocation_id, "status": "completed"},
            "output": roast,
            "receipt": receipt,
        }
        encoded_receipt = base64.b64encode(json.dumps(receipt).encode("utf-8")).decode("ascii")
        self._send_json(200, response, extra_headers={"X-Payment-Receipt": encoded_receipt})

    def log_message(self, format: str, *args: Any) -> None:
        return

    def _verify_payment(self, token: str, request_body: JsonDict) -> bool:
        try:
            envelope = json.loads(base64.b64decode(token.encode("utf-8")).decode("utf-8"))
        except Exception:
            return False

        challenge = envelope.get("challenge")
        signature = envelope.get("signature")
        if not isinstance(challenge, dict) or not isinstance(signature, str):
            return False

        canonical = json.dumps(challenge, sort_keys=True, separators=(",", ":")).encode("utf-8")
        expected = hmac.new(self.server.secret, canonical, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, signature):
            return False

        expected_fingerprint = hashlib.sha256(
            json.dumps(request_body, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        return envelope.get("request_fingerprint") == expected_fingerprint

    def _build_roast(self, roast_input: JsonDict) -> JsonDict:
        listing_url = str(roast_input.get("listing_url", ""))
        title = str(roast_input.get("title", "Untitled listing"))
        return {
            "kind": "listing_roast",
            "listing_url": listing_url,
            "summary": f"{title}: tighten the title, add proof screenshots, and lead with buyer outcome instead of features.",
            "findings": [
                "Title is descriptive but not outcome-first.",
                "Social proof is implied but not evidenced.",
                "Call to action is present but not specific about deliverable or response time.",
            ],
            "suggested_rewrite": f"{title} — get a sharper offer, stronger proof blocks, and a buyer-focused listing narrative for {listing_url}.",
        }

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


def make_demo_pay_callback(secret: bytes) -> PayCallback:
    def pay_callback(challenge: JsonDict, request_body: JsonDict) -> str:
        canonical = json.dumps(challenge, sort_keys=True, separators=(",", ":")).encode("utf-8")
        signature = hmac.new(secret, canonical, hashlib.sha256).hexdigest()
        envelope = {
            "challenge": challenge,
            "signature": signature,
            "request_fingerprint": hashlib.sha256(
                json.dumps(request_body, sort_keys=True, separators=(",", ":")).encode("utf-8")
            ).hexdigest(),
        }
        return base64.b64encode(json.dumps(envelope).encode("utf-8")).decode("ascii")

    return pay_callback


def run_demo() -> Tuple[ExecuteResult, ReceiptChecklist]:
    secret = b"demo-listing-roast-shared-secret"
    server = DemoListingRoastServer(("127.0.0.1", 0), secret)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        client = ListingRoastX402Client(
            base_url=f"http://127.0.0.1:{server.server_address[1]}",
            pay_callback=make_demo_pay_callback(secret),
            max_attempts=4,
            retry_sleep_seconds=0.03,
        )
        result = client.execute(
            server.quote_id,
            {
                "listing_url": "https://example.com/listings/demo-agent",
                "title": "Demo Agent Listing",
                "audience": "founders",
            },
        )
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
    assert result.receipt["quote_id"] == "quote_listing_roast_demo"
    assert result.receipt["idempotency_key"] == result.idempotency_key
    assert result.body["output"]["kind"] == "listing_roast"

    two_attempt_result = ExecuteResult(
        status_code=result.status_code,
        body=result.body,
        receipt=result.receipt,
        attempts=2,
        idempotency_key=result.idempotency_key,
        payment_authorization=result.payment_authorization,
        challenge=result.challenge,
        request_body=result.request_body,
        request_path=result.request_path,
    )
    two_attempt_checklist = ListingRoastX402Client("http://example.invalid").build_receipt_checklist(
        two_attempt_result,
        expected_quote_id="quote_listing_roast_demo",
    )
    assert two_attempt_checklist.ok, two_attempt_checklist.as_text()

    mismatched_receipt = dict(result.receipt)
    mismatched_receipt["invocation_id"] = "inv_other"
    mismatched_result = ExecuteResult(
        status_code=result.status_code,
        body=result.body,
        receipt=mismatched_receipt,
        attempts=result.attempts,
        idempotency_key=result.idempotency_key,
        payment_authorization=result.payment_authorization,
        challenge=result.challenge,
        request_body=result.request_body,
        request_path=result.request_path,
    )
    mismatch_checklist = ListingRoastX402Client("http://example.invalid").build_receipt_checklist(
        mismatched_result,
        expected_quote_id="quote_listing_roast_demo",
    )
    assert not mismatch_checklist.ok, "mismatched receipt invocation should fail checklist"

    wrong_terms_receipt = dict(result.receipt)
    wrong_terms_receipt["amount"] = "0.01"
    wrong_terms_result = ExecuteResult(
        status_code=result.status_code,
        body=result.body,
        receipt=wrong_terms_receipt,
        attempts=result.attempts,
        idempotency_key=result.idempotency_key,
        payment_authorization=result.payment_authorization,
        challenge=result.challenge,
        request_body=result.request_body,
        request_path=result.request_path,
    )
    wrong_terms_checklist = ListingRoastX402Client("http://example.invalid").build_receipt_checklist(
        wrong_terms_result,
        expected_quote_id="quote_listing_roast_demo",
    )
    assert not wrong_terms_checklist.ok, "receipt payment terms should match the challenge"


if __name__ == "__main__":
    _self_test()
    result, checklist = run_demo()
    print("listing-roast-x402-service execute() buyer retry example")
    print(f"request_path={result.request_path}")
    print(f"status_code={result.status_code}")
    print(f"attempts={result.attempts}")
    print(f"idempotency_key={result.idempotency_key}")
    print(f"receipt_id={result.receipt.get('receipt_id')}")
    print(f"invocation_id={result.receipt.get('invocation_id')}")
    print(checklist.as_text())
