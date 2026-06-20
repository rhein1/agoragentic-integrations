#!/usr/bin/env python3
"""demo — the built-in self-test simulates payment authorization and moves no real funds."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence

DEFAULT_BASE_URL = os.environ.get("AGORAGENTIC_URL", "https://agoragentic.com").rstrip("/")
DEFAULT_USER_AGENT = "agoragentic/x402-paid-execute-receipt-checklist-python/1.0"
DEFAULT_TIMEOUT_SECONDS = 30.0
DEFAULT_TRANSPORT_RETRIES = 2
TRANSIENT_STATUS_CODES = {408, 425, 429, 500, 502, 503, 504}


@dataclass
class SimpleResponse:
    status: int
    headers: Dict[str, str]
    body_text: str

    def json(self) -> Optional[Any]:
        return try_parse_json(self.body_text)


@dataclass
class RequestContext:
    url: str
    method: str
    headers: Dict[str, str]
    body: Dict[str, Any]


@dataclass
class PaymentChallenge:
    raw: str
    parsed: Any
    amount: Optional[str]
    asset: Optional[str]
    pay_to: Optional[str]
    scheme: Optional[str]


@dataclass
class PaymentAuthorization:
    authorization_header: Optional[str] = None
    payment_signature: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)

    def is_usable(self) -> bool:
        return bool(self.authorization_header or self.payment_signature)


@dataclass
class ExecuteReceipt:
    ok: bool
    status: int
    task: Optional[str]
    quote_id: str
    quote: Optional[Dict[str, Any]]
    input: Dict[str, Any]
    idempotency_key: str
    challenge_count: int
    attempts: List[Dict[str, Any]]
    payment_authorization_reused: bool
    payment_receipt_header: Optional[str]
    payment_response_header: Optional[str]
    invocation_id: Optional[str]
    result: Any
    invocation_proof: Optional[Dict[str, Any]]
    receipt_checklist: List[Dict[str, Any]]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "ok": self.ok,
            "status": self.status,
            "task": self.task,
            "quote_id": self.quote_id,
            "quote": self.quote,
            "input": self.input,
            "idempotency_key": self.idempotency_key,
            "challenge_count": self.challenge_count,
            "attempts": self.attempts,
            "payment_authorization_reused": self.payment_authorization_reused,
            "payment_receipt_header": self.payment_receipt_header,
            "payment_response_header": self.payment_response_header,
            "invocation_id": self.invocation_id,
            "result": self.result,
            "invocation_proof": self.invocation_proof,
            "receipt_checklist": self.receipt_checklist,
        }


def make_idempotency_key() -> str:
    return str(uuid.uuid4())


def delay(seconds: float) -> None:
    time.sleep(seconds)


def try_parse_json(text: str) -> Optional[Any]:
    if not text:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


def decode_maybe_base64_json(text: str) -> Optional[Any]:
    trimmed = str(text or "").strip()
    if not trimmed:
        return None
    direct = try_parse_json(trimmed)
    if direct is not None:
        return direct
    try:
        decoded = base64.b64decode(trimmed).decode("utf-8")
    except Exception:
        return None
    return try_parse_json(decoded)


def normalize_headers(headers: Optional[Mapping[str, Any]]) -> Dict[str, str]:
    normalized: Dict[str, str] = {}
    if not headers:
        return normalized
    for key, value in headers.items():
        if isinstance(value, (list, tuple)):
            normalized[str(key)] = ", ".join(str(item) for item in value)
        else:
            normalized[str(key)] = str(value)
    return normalized


def get_header(headers: Optional[Mapping[str, Any]], name: str) -> Optional[str]:
    if not headers:
        return None
    wanted = name.lower()
    for key, value in headers.items():
        if str(key).lower() == wanted:
            if isinstance(value, (list, tuple)):
                return ", ".join(str(item) for item in value)
            return str(value)
    return None


def pick_headers(headers: Optional[Mapping[str, Any]], names: Sequence[str]) -> Dict[str, str]:
    selected: Dict[str, str] = {}
    for name in names:
        value = get_header(headers, name)
        if value:
            selected[name] = value
    return selected


def is_transient_status(status: int) -> bool:
    return status in TRANSIENT_STATUS_CODES


def summarize_challenge(raw_payment_required: str) -> PaymentChallenge:
    parsed = decode_maybe_base64_json(raw_payment_required)
    first = parsed[0] if isinstance(parsed, list) and parsed else parsed
    if not isinstance(first, dict):
        return PaymentChallenge(
            raw=raw_payment_required,
            parsed=parsed,
            amount=None,
            asset=None,
            pay_to=None,
            scheme=None,
        )
    return PaymentChallenge(
        raw=raw_payment_required,
        parsed=parsed,
        amount=first.get("maxAmountRequired") or first.get("amount") or first.get("value"),
        asset=first.get("asset") or first.get("currency"),
        pay_to=first.get("payTo") or first.get("receiver") or first.get("address"),
        scheme=first.get("scheme") or first.get("protocol") or "x402",
    )


def parse_response_body(response: SimpleResponse) -> Dict[str, Any]:
    parsed = response.json()
    return {
        "text": response.body_text,
        "json": parsed,
        "data": parsed if parsed is not None else response.body_text,
    }


FetchImpl = Callable[[str, str, Mapping[str, str], Optional[str], float], SimpleResponse]
PayCallback = Callable[[Dict[str, Any]], PaymentAuthorization]


class X402PaidExecuteReceiptBuyer:
    def __init__(
        self,
        *,
        base_url: str = DEFAULT_BASE_URL,
        fetch_impl: Optional[FetchImpl] = None,
        user_agent: str = DEFAULT_USER_AGENT,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
        pay: Optional[PayCallback] = None,
        transport_retries: int = DEFAULT_TRANSPORT_RETRIES,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.fetch_impl = fetch_impl or default_fetch
        self.user_agent = user_agent
        self.timeout_seconds = timeout_seconds
        self.default_pay = pay
        self.transport_retries = transport_retries
        self.authorization_cache: Dict[str, PaymentAuthorization] = {}

    def preview(self, task: str, constraints: Optional[Mapping[str, Any]] = None) -> Dict[str, Any]:
        if not isinstance(task, str) or not task.strip():
            raise ValueError("preview(task) requires a non-empty task string")

        params = {"task": task}
        for key, value in (constraints or {}).items():
            if value is None or value == "":
                continue
            params[str(key)] = str(value)
        url = f"{self.base_url}/api/x402/execute/match?{urllib.parse.urlencode(params)}"
        response = self.fetch_impl(
            "GET",
            url,
            {
                "Accept": "application/json",
                "User-Agent": self.user_agent,
            },
            None,
            self.timeout_seconds,
        )
        body = parse_response_body(response)
        if response.status < 200 or response.status >= 300:
            raise RuntimeError(f"preview failed with HTTP {response.status}: {body['text'] or 'no body'}")
        return body["json"] or {}

    def execute(
        self,
        task: str,
        input_payload: Optional[Dict[str, Any]] = None,
        *,
        constraints: Optional[Mapping[str, Any]] = None,
        quote: Optional[Dict[str, Any]] = None,
        quote_id: Optional[str] = None,
        idempotency_key: Optional[str] = None,
        pay: Optional[PayCallback] = None,
        fetch_proof: bool = True,
        transport_retries: Optional[int] = None,
    ) -> ExecuteReceipt:
        if quote is not None:
            resolved_quote = quote
        elif quote_id is not None:
            resolved_quote = {}
        else:
            resolved_quote = self.preview(task, constraints)
        resolved_quote_id = resolved_quote.get("quote_id") or quote_id
        if not resolved_quote_id:
            raise RuntimeError("preview did not return quote_id; cannot execute paid call")
        return self.execute_quote(
            resolved_quote_id,
            input_payload or {},
            task=task,
            quote=resolved_quote,
            idempotency_key=idempotency_key,
            pay=pay,
            fetch_proof=fetch_proof,
            transport_retries=transport_retries,
        )

    def execute_quote(
        self,
        quote_id: str,
        input_payload: Optional[Dict[str, Any]] = None,
        *,
        task: Optional[str] = None,
        quote: Optional[Dict[str, Any]] = None,
        idempotency_key: Optional[str] = None,
        pay: Optional[PayCallback] = None,
        fetch_proof: bool = True,
        transport_retries: Optional[int] = None,
    ) -> ExecuteReceipt:
        if not isinstance(quote_id, str) or not quote_id.strip():
            raise ValueError("execute_quote(quote_id, input_payload) requires a non-empty quote_id string")

        idem_key = idempotency_key or make_idempotency_key()
        payment_cache_key = f"{quote_id}:{idem_key}"
        pay_callback = pay or self.default_pay
        request_body = {"quote_id": quote_id, "input": input_payload or {}}
        url = f"{self.base_url}/api/x402/execute"
        attempts: List[Dict[str, Any]] = []
        payment_authorization = self.authorization_cache.get(payment_cache_key)
        challenge_count = 0
        retries_remaining = self.transport_retries if transport_retries is None else transport_retries

        while True:
            headers: Dict[str, str] = {
                "Accept": "application/json",
                "Content-Type": "application/json",
                "Idempotency-Key": idem_key,
                "User-Agent": self.user_agent,
            }
            if payment_authorization and payment_authorization.authorization_header:
                headers["Authorization"] = payment_authorization.authorization_header
            if payment_authorization and payment_authorization.payment_signature:
                headers["PAYMENT-SIGNATURE"] = payment_authorization.payment_signature

            try:
                response = self.fetch_impl(
                    "POST",
                    url,
                    headers,
                    json.dumps(request_body),
                    self.timeout_seconds,
                )
            except Exception as exc:
                attempts.append(
                    {
                        "type": "transport_error",
                        "idempotency_key": idem_key,
                        "reused_payment_authorization": bool(payment_authorization),
                        "message": str(exc),
                    }
                )
                if retries_remaining > 0:
                    retries_remaining -= 1
                    delay(0.15)
                    continue
                raise

            body = parse_response_body(response)
            selected_headers = pick_headers(
                response.headers,
                [
                    "payment-required",
                    "PAYMENT-REQUIRED",
                    "payment-response",
                    "PAYMENT-RESPONSE",
                    "payment-receipt",
                    "Payment-Receipt",
                    "x-request-id",
                    "x-invocation-id",
                ],
            )
            attempts.append(
                {
                    "type": "http",
                    "status": response.status,
                    "idempotency_key": idem_key,
                    "reused_payment_authorization": bool(payment_authorization),
                    "headers": selected_headers,
                }
            )

            if response.status == 402:
                challenge_count += 1
                if payment_authorization is not None:
                    raise RuntimeError(
                        "paid retry returned another 402; refusing to create another payment "
                        "authorization without a new buyer decision"
                    )
                raw_payment_required = get_header(response.headers, "PAYMENT-REQUIRED") or get_header(
                    response.headers, "payment-required"
                )
                if not raw_payment_required:
                    raise RuntimeError("HTTP 402 received without PAYMENT-REQUIRED header")
                if pay_callback is None:
                    raise RuntimeError("paid execution requires an explicit pay callback after HTTP 402")

                challenge = summarize_challenge(raw_payment_required)
                payment_authorization = pay_callback(
                    {
                        "challenge": {
                            "raw": challenge.raw,
                            "parsed": challenge.parsed,
                            "amount": challenge.amount,
                            "asset": challenge.asset,
                            "pay_to": challenge.pay_to,
                            "scheme": challenge.scheme,
                        },
                        "quote_id": quote_id,
                        "idempotency_key": idem_key,
                        "request": {
                            "url": url,
                            "method": "POST",
                            "body": request_body,
                            "headers": dict(headers),
                        },
                        "prior_authorization": None
                        if payment_authorization is None
                        else {
                            "authorization_header": payment_authorization.authorization_header,
                            "payment_signature": payment_authorization.payment_signature,
                            "metadata": payment_authorization.metadata,
                        },
                        "response_body": body["json"] if body["json"] is not None else body["text"],
                    }
                )
                if not isinstance(payment_authorization, PaymentAuthorization) or not payment_authorization.is_usable():
                    raise RuntimeError("pay callback must return a usable PaymentAuthorization")
                self.authorization_cache[payment_cache_key] = payment_authorization
                delay(0.05)
                continue

            if is_transient_status(response.status) and retries_remaining > 0:
                retries_remaining -= 1
                delay(0.15)
                continue

            payload = body["json"] if isinstance(body["json"], dict) else None
            invocation_id = (
                (payload or {}).get("invocation_id")
                or (payload or {}).get("invocationId")
                or get_header(response.headers, "x-invocation-id")
            )
            invocation_proof = None
            if invocation_id and fetch_proof:
                try:
                    invocation_proof = self.fetch_invocation_proof(invocation_id)
                except Exception:
                    invocation_proof = None

            receipt_seed = {
                "ok": 200 <= response.status < 300,
                "status": response.status,
                "task": task,
                "quote_id": quote_id,
                "quote": quote,
                "input": input_payload or {},
                "idempotency_key": idem_key,
                "challenge_count": challenge_count,
                "attempts": attempts,
                "payment_authorization_reused": any(
                    bool(entry.get("reused_payment_authorization")) for entry in attempts
                ),
                "payment_receipt_header": get_header(response.headers, "Payment-Receipt")
                or get_header(response.headers, "payment-receipt"),
                "payment_response_header": get_header(response.headers, "PAYMENT-RESPONSE")
                or get_header(response.headers, "payment-response"),
                "invocation_id": invocation_id,
                "result": body["json"] if body["json"] is not None else body["text"],
                "invocation_proof": invocation_proof,
            }
            checklist = build_receipt_checklist(receipt_seed)
            return ExecuteReceipt(receipt_checklist=checklist, **receipt_seed)

    def fetch_invocation_proof(self, invocation_id: str) -> Dict[str, Any]:
        url = f"{self.base_url}/api/x402/invocations/{urllib.parse.quote(invocation_id)}/proof"
        response = self.fetch_impl(
            "GET",
            url,
            {
                "Accept": "application/json",
                "User-Agent": self.user_agent,
            },
            None,
            self.timeout_seconds,
        )
        body = parse_response_body(response)
        if response.status < 200 or response.status >= 300:
            raise RuntimeError(f"proof lookup failed with HTTP {response.status}")
        return body["json"] or {}


def build_receipt_checklist(receipt: Mapping[str, Any]) -> List[Dict[str, Any]]:
    proof = receipt.get("invocation_proof") if isinstance(receipt.get("invocation_proof"), dict) else None
    on_chain = proof.get("on_chain") if isinstance(proof, dict) and isinstance(proof.get("on_chain"), dict) else None
    proof_status = on_chain.get("status") if on_chain else None
    attempts = receipt.get("attempts") if isinstance(receipt.get("attempts"), list) else []
    return [
        {
            "item": "idempotency_key_sent",
            "pass": bool(receipt.get("idempotency_key")),
            "evidence": receipt.get("idempotency_key") or "missing",
        },
        {
            "item": "payment_challenge_observed_before_authorization",
            "pass": int(receipt.get("challenge_count") or 0) > 0,
            "evidence": f"challenge_count={int(receipt.get('challenge_count') or 0)}",
        },
        {
            "item": "authorization_not_created_until_http_402",
            "pass": any(entry.get("status") == 402 for entry in attempts),
            "evidence": f"attempts={len(attempts)}",
        },
        {
            "item": "payment_authorization_reused_on_retry",
            "pass": bool(receipt.get("payment_authorization_reused")),
            "evidence": f"reused={bool(receipt.get('payment_authorization_reused'))}",
        },
        {
            "item": "paid_call_completed",
            "pass": bool(receipt.get("ok")),
            "evidence": f"http_status={receipt.get('status')}",
        },
        {
            "item": "payment_receipt_header_present",
            "pass": bool(receipt.get("payment_receipt_header")),
            "evidence": receipt.get("payment_receipt_header") or "missing",
        },
        {
            "item": "payment_response_header_present",
            "pass": bool(receipt.get("payment_response_header")),
            "evidence": receipt.get("payment_response_header") or "missing",
        },
        {
            "item": "invocation_id_captured",
            "pass": bool(receipt.get("invocation_id")),
            "evidence": receipt.get("invocation_id") or "missing",
        },
        {
            "item": "proof_status_not_overclaimed",
            "pass": proof_status is None or proof_status in {"pending_submission", "submitted", "verified"},
            "evidence": proof_status or "not-fetched",
        },
    ]


def default_fetch(method: str, url: str, headers: Mapping[str, str], body: Optional[str], timeout_seconds: float) -> SimpleResponse:
    request = urllib.request.Request(url=url, method=method, headers=dict(headers))
    data = body.encode("utf-8") if body is not None else None
    try:
        with urllib.request.urlopen(request, data=data, timeout=timeout_seconds) as response:
            body_text = response.read().decode("utf-8", errors="replace")
            return SimpleResponse(
                status=response.getcode(),
                headers=normalize_headers(response.headers.items()),
                body_text=body_text,
            )
    except urllib.error.HTTPError as exc:
        body_text = exc.read().decode("utf-8", errors="replace")
        return SimpleResponse(
            status=exc.code,
            headers=normalize_headers(exc.headers.items()),
            body_text=body_text,
        )


def response_json(status: int, body: Dict[str, Any], headers: Optional[Mapping[str, str]] = None) -> SimpleResponse:
    merged_headers = {"content-type": "application/json"}
    if headers:
        merged_headers.update(dict(headers))
    return SimpleResponse(status=status, headers=merged_headers, body_text=json.dumps(body))


class MockFetch:
    def __init__(self) -> None:
        self.seen: Dict[str, Any] = {
            "preview_calls": 0,
            "execute_calls": 0,
            "proof_calls": 0,
            "idempotency_keys": [],
            "payment_signatures": [],
        }
        payment_required_object = [
            {
                "scheme": "exact",
                "network": "base",
                "asset": "USDC",
                "maxAmountRequired": "25000",
                "payTo": "0x0000000000000000000000000000000000000abc",
            }
        ]
        self.encoded_challenge = base64.b64encode(json.dumps(payment_required_object).encode("utf-8")).decode("ascii")

    def __call__(
        self,
        method: str,
        url: str,
        headers: Mapping[str, str],
        body: Optional[str],
        timeout_seconds: float,
    ) -> SimpleResponse:
        del timeout_seconds
        parsed = urllib.parse.urlparse(url)
        if parsed.path == "/api/x402/execute/match" and method == "GET":
            self.seen["preview_calls"] += 1
            return response_json(
                200,
                {
                    "quote_id": "quote_demo_123",
                    "match": {
                        "id": "listing_demo_456",
                        "name": "Agoragentic demo receipt service",
                        "price_usdc": "0.025",
                    },
                },
            )

        if parsed.path == "/api/x402/execute" and method == "POST":
            self.seen["execute_calls"] += 1
            idempotency_key = get_header(headers, "Idempotency-Key")
            self.seen["idempotency_keys"].append(idempotency_key)
            payment_signature = get_header(headers, "PAYMENT-SIGNATURE")
            if payment_signature:
                self.seen["payment_signatures"].append(payment_signature)

            if not payment_signature:
                return response_json(
                    402,
                    {
                        "error": "payment_required",
                        "detail": "attach PAYMENT-SIGNATURE and retry the same idempotency key",
                    },
                    {"PAYMENT-REQUIRED": self.encoded_challenge},
                )

            if self.seen["execute_calls"] == 2:
                return response_json(503, {"error": "temporary_upstream_error"})

            parsed_body = try_parse_json(body or "{}") or {}
            return response_json(
                200,
                {
                    "success": True,
                    "invocation_id": "inv_demo_789",
                    "result": {
                        "accepted": True,
                        "settled": False,
                        "note": "service executed after payment challenge retry",
                        "echo": parsed_body.get("input"),
                    },
                },
                {
                    "Payment-Receipt": "receipt_demo_001",
                    "PAYMENT-RESPONSE": "payment_response_demo_001",
                    "x-invocation-id": "inv_demo_789",
                },
            )

        if parsed.path == "/api/x402/invocations/inv_demo_789/proof" and method == "GET":
            self.seen["proof_calls"] += 1
            return response_json(
                200,
                {
                    "decision_hash": "0xabc123",
                    "on_chain": {
                        "status": "submitted",
                        "chain": "eip155:8453",
                    },
                },
            )

        return response_json(404, {"error": f"unhandled path: {parsed.path}"})


class DemoPayCallback:
    def __init__(self) -> None:
        self.pay_calls = 0

    def __call__(self, payload: Dict[str, Any]) -> PaymentAuthorization:
        self.pay_calls += 1
        token = hashlib.sha256(
            json.dumps(
                {
                    "challenge": payload.get("challenge"),
                    "idempotency_key": payload.get("idempotency_key"),
                    "pay_calls": self.pay_calls,
                    "prior": bool(payload.get("prior_authorization")),
                },
                sort_keys=True,
            ).encode("utf-8")
        ).hexdigest()
        challenge = payload.get("challenge") or {}
        return PaymentAuthorization(
            payment_signature=f"demo-payment-signature-{token}",
            metadata={
                "mode": "demo",
                "pay_calls": self.pay_calls,
                "challenge_summary": {
                    "amount": challenge.get("amount"),
                    "asset": challenge.get("asset"),
                    "pay_to": challenge.get("pay_to"),
                },
            },
        )


def run_self_test() -> Dict[str, Any]:
    fetch_impl = MockFetch()
    pay = DemoPayCallback()
    buyer = X402PaidExecuteReceiptBuyer(
        base_url="https://example.invalid",
        fetch_impl=fetch_impl,
        pay=pay,
        transport_retries=2,
    )
    receipt = buyer.execute(
        "x402 buyer retry receipt checklist demo",
        {"prompt": "prove the buyer retry path reuses authorization"},
        constraints={"max_cost": "0.05"},
    )
    checklist_passed = all(item["pass"] for item in receipt.receipt_checklist)
    same_idempotency_key = len(set(fetch_impl.seen["idempotency_keys"])) == 1
    pay_called_once = pay.pay_calls == 1
    signed_attempts = len(fetch_impl.seen["payment_signatures"])
    if not checklist_passed:
        raise RuntimeError(f"self-test checklist failed: {json.dumps(receipt.receipt_checklist, indent=2)}")
    if not same_idempotency_key:
        raise RuntimeError(
            f"self-test expected a single idempotency key, saw {json.dumps(fetch_impl.seen['idempotency_keys'])}"
        )
    if not pay_called_once:
        raise RuntimeError(f"self-test expected one pay callback call, saw {pay.pay_calls}")
    if signed_attempts != 2:
        raise RuntimeError(f"self-test expected authorization reuse across retry, saw {signed_attempts} signed attempts")

    direct_quote_fetch = MockFetch()
    direct_quote_pay = DemoPayCallback()
    direct_quote_buyer = X402PaidExecuteReceiptBuyer(
        base_url="https://example.invalid",
        fetch_impl=direct_quote_fetch,
        pay=direct_quote_pay,
        transport_retries=2,
    )
    direct_quote_receipt = direct_quote_buyer.execute(
        "x402 buyer retry receipt checklist demo",
        {"prompt": "use existing quote"},
        quote_id="quote_direct_123",
    )
    if direct_quote_fetch.seen["preview_calls"] != 0:
        raise RuntimeError("execute(..., quote_id=...) should not call preview()")
    if not direct_quote_receipt.ok:
        raise RuntimeError("direct quote execution should complete in the self-test")

    repeated_402_pay = DemoPayCallback()
    encoded_challenge = direct_quote_fetch.encoded_challenge

    def repeated_402_fetch(
        method: str,
        url: str,
        headers: Mapping[str, str],
        body: Optional[str],
        timeout_seconds: float,
    ) -> SimpleResponse:
        del method, url, headers, body, timeout_seconds
        return response_json(402, {"error": "payment_required_again"}, {"PAYMENT-REQUIRED": encoded_challenge})

    repeated_402_buyer = X402PaidExecuteReceiptBuyer(
        base_url="https://example.invalid",
        fetch_impl=repeated_402_fetch,
        pay=repeated_402_pay,
        transport_retries=0,
    )
    try:
        repeated_402_buyer.execute_quote("quote_repeat_402", {"prompt": "do not pay twice"})
    except RuntimeError as exc:
        if "refusing to create another payment authorization" not in str(exc):
            raise
    else:
        raise RuntimeError("second 402 after authorization should fail")
    if repeated_402_pay.pay_calls != 1:
        raise RuntimeError(f"repeated 402 should call pay once, saw {repeated_402_pay.pay_calls}")

    return {
        "summary": "self-test passed",
        "preview_calls": fetch_impl.seen["preview_calls"],
        "execute_calls": fetch_impl.seen["execute_calls"],
        "proof_calls": fetch_impl.seen["proof_calls"],
        "pay_calls": pay.pay_calls,
        "idempotency_key": receipt.idempotency_key,
        "checklist": receipt.receipt_checklist,
        "direct_quote_preview_calls": direct_quote_fetch.seen["preview_calls"],
        "repeated_402_pay_calls": repeated_402_pay.pay_calls,
    }


def run_live_demo(task: str, simulate_pay: bool, max_cost: str, fetch_proof: bool) -> Dict[str, Any]:
    pay = DemoPayCallback() if simulate_pay else None
    buyer = X402PaidExecuteReceiptBuyer(base_url=DEFAULT_BASE_URL, pay=pay)
    receipt = buyer.execute(
        task,
        {
            "message": "x402 buyer retry receipt checklist demo",
            "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        },
        constraints={"max_cost": max_cost},
        fetch_proof=fetch_proof,
    )
    return receipt.to_dict()


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="x402 paid execute buyer receipt checklist")
    parser.add_argument("task", nargs="?", default="echo", help="task string for execute/match")
    parser.add_argument("--self-test", action="store_true", help="run the built-in no-spend self-test")
    parser.add_argument(
        "--simulate-pay",
        action="store_true",
        help="use a demo pay callback after HTTP 402; for testing only and moves no real funds",
    )
    parser.add_argument("--max-cost", default=os.environ.get("MAX_COST", "0.05"), help="max cost constraint")
    parser.add_argument("--no-proof", action="store_true", help="skip invocation proof lookup")
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)
    try:
        if args.self_test:
            print(json.dumps(run_self_test(), indent=2))
            return 0
        live_receipt = run_live_demo(
            task=args.task,
            simulate_pay=args.simulate_pay,
            max_cost=args.max_cost,
            fetch_proof=not args.no_proof,
        )
        print(json.dumps(live_receipt, indent=2))
        if not live_receipt.get("ok") or not all(
            item.get("pass") for item in live_receipt.get("receipt_checklist", [])
        ):
            return 1
        return 0
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
