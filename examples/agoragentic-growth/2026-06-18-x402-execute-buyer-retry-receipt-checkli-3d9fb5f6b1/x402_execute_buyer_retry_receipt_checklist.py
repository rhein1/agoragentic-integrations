#!/usr/bin/env python3
"""x402 paid-call receipt + execute() retry checklist — RUNNABLE DEMO / SIMULATION.

This is a self-contained example. It moves NO real funds: the "buyer" mints an
HMAC-signed *demo* receipt over a hardcoded demo secret ("demo-shared-secret"), and the
built-in demo server verifies that same HMAC. There is no wallet, private key, EIP-3009
authorization, USDC transfer, facilitator, or on-chain settlement anywhere in this file;
``payment_verified`` is true only inside this closed demo HMAC loop. Use it to exercise the
402 -> receipt -> retry control flow and the receipt checklist; for production, supply a
real wallet/facilitator and a real receipt signature scheme.
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Dict, Iterable, List, Mapping, MutableMapping, Optional, Tuple


RECEIPT_HEADER = "X-Payment-Receipt"
REQUIREMENT_HEADER = "X-Payment-Requirements"
DEFAULT_TIMEOUT_SECONDS = 10.0


@dataclass(frozen=True)
class PaymentRequirement:
    network: str
    amount: str
    asset: str
    pay_to: str
    nonce: str
    expiry: int
    resource: Optional[str] = None

    @classmethod
    def from_mapping(cls, data: Mapping[str, Any]) -> "PaymentRequirement":
        return cls(
            network=str(data["network"]),
            amount=str(data["amount"]),
            asset=str(data["asset"]),
            pay_to=str(data["pay_to"]),
            nonce=str(data["nonce"]),
            expiry=int(data["expiry"]),
            resource=str(data["resource"]) if "resource" in data and data["resource"] is not None else None,
        )

    def to_mapping(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "network": self.network,
            "amount": self.amount,
            "asset": self.asset,
            "pay_to": self.pay_to,
            "nonce": self.nonce,
            "expiry": self.expiry,
        }
        if self.resource is not None:
            out["resource"] = self.resource
        return out


class ReceiptChecklistError(Exception):
    pass


class PaymentRequiredError(Exception):
    def __init__(self, status: int, body: str, requirements: List[PaymentRequirement]) -> None:
        super().__init__(f"payment required: HTTP {status}")
        self.status = status
        self.body = body
        self.requirements = requirements


@dataclass
class Response:
    status: int
    headers: Dict[str, str]
    body: str

    def json(self) -> Any:
        return json.loads(self.body)


def _canonicalize_headers(headers: Optional[Mapping[str, str]]) -> Dict[str, str]:
    return {str(k): str(v) for k, v in (headers or {}).items()}


def _json_bytes(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")


def parse_payment_requirements(raw_value: str) -> List[PaymentRequirement]:
    data = json.loads(raw_value)
    if isinstance(data, dict):
        data = [data]
    if not isinstance(data, list) or not data:
        raise ReceiptChecklistError("payment requirements must be a non-empty JSON object or list")
    return [PaymentRequirement.from_mapping(item) for item in data]


def build_demo_receipt(requirement: PaymentRequirement, secret: str, payer: str = "integration-test-buyer") -> Dict[str, Any]:
    payload = {
        "version": "x402-demo-1",
        "payer": payer,
        "payment_id": f"pay_{uuid.uuid4().hex}",
        "issued_at": int(time.time()),
        "network": requirement.network,
        "amount": requirement.amount,
        "asset": requirement.asset,
        "pay_to": requirement.pay_to,
        "nonce": requirement.nonce,
        "expiry": requirement.expiry,
    }
    signature = hmac.new(secret.encode("utf-8"), _json_bytes(payload), hashlib.sha256).hexdigest()
    payload["signature"] = signature
    return payload


def validate_receipt_checklist(
    receipt: Mapping[str, Any],
    requirement: PaymentRequirement,
    *,
    now: Optional[int] = None,
    required_fields: Optional[Iterable[str]] = None,
) -> List[str]:
    errors: List[str] = []
    required = list(
        required_fields
        or [
            "version",
            "payer",
            "payment_id",
            "issued_at",
            "network",
            "amount",
            "asset",
            "pay_to",
            "nonce",
            "expiry",
            "signature",
        ]
    )

    for field_name in required:
        if field_name not in receipt:
            errors.append(f"missing field: {field_name}")

    if errors:
        return errors

    def expect_equal(field_name: str, expected: Any) -> None:
        actual = receipt.get(field_name)
        if str(actual) != str(expected):
            errors.append(f"{field_name} mismatch: expected {expected!r}, got {actual!r}")

    expect_equal("network", requirement.network)
    expect_equal("amount", requirement.amount)
    expect_equal("asset", requirement.asset)
    expect_equal("pay_to", requirement.pay_to)
    expect_equal("nonce", requirement.nonce)
    expect_equal("expiry", requirement.expiry)

    now_value = int(time.time()) if now is None else int(now)
    try:
        issued_at = int(receipt["issued_at"])
    except Exception:
        errors.append(f"issued_at must be an integer, got {receipt.get('issued_at')!r}")
        issued_at = now_value

    try:
        expiry = int(receipt["expiry"])
    except Exception:
        errors.append(f"expiry must be an integer, got {receipt.get('expiry')!r}")
        expiry = requirement.expiry

    if issued_at > now_value + 300:
        errors.append("issued_at is too far in the future")
    if expiry < now_value:
        errors.append("receipt is expired")

    payment_id = str(receipt.get("payment_id", ""))
    if not payment_id.strip():
        errors.append("payment_id must be non-empty")

    signature = str(receipt.get("signature", ""))
    if len(signature) < 16:
        errors.append("signature looks too short to be useful")

    return errors


def verify_demo_receipt_signature(receipt: Mapping[str, Any], secret: str) -> bool:
    if "signature" not in receipt:
        return False
    signed = dict(receipt)
    signature = str(signed.pop("signature"))
    expected = hmac.new(secret.encode("utf-8"), _json_bytes(signed), hashlib.sha256).hexdigest()
    return hmac.compare_digest(signature, expected)


def _http_request(
    method: str,
    url: str,
    *,
    headers: Optional[Mapping[str, str]] = None,
    body: Optional[bytes] = None,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> Response:
    req = urllib.request.Request(url=url, method=method.upper(), headers=_canonicalize_headers(headers), data=body)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return Response(
                status=resp.status,
                headers=dict(resp.headers.items()),
                body=resp.read().decode("utf-8"),
            )
    except urllib.error.HTTPError as err:
        return Response(
            status=err.code,
            headers=dict(err.headers.items()),
            body=err.read().decode("utf-8"),
        )


def execute(
    method: str,
    url: str,
    *,
    buyer: Callable[[List[PaymentRequirement], Response], Mapping[str, Any]],
    headers: Optional[Mapping[str, str]] = None,
    json_body: Optional[Any] = None,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> Response:
    request_headers: Dict[str, str] = {"Accept": "application/json", **_canonicalize_headers(headers)}
    body_bytes = _json_bytes(json_body) if json_body is not None else None
    if json_body is not None and "Content-Type" not in {k.title(): v for k, v in request_headers.items()}:
        request_headers["Content-Type"] = "application/json"

    first = _http_request(method, url, headers=request_headers, body=body_bytes, timeout=timeout)
    if first.status != 402:
        return first

    requirement_value = first.headers.get(REQUIREMENT_HEADER)
    if not requirement_value:
        raise PaymentRequiredError(first.status, first.body, [])

    requirements = parse_payment_requirements(requirement_value)
    receipt = dict(buyer(requirements, first))
    if not receipt:
        raise ReceiptChecklistError("buyer returned an empty receipt")
    checklist_errors = validate_receipt_checklist(receipt, requirements[0])
    if checklist_errors:
        raise ReceiptChecklistError("invalid receipt from buyer: " + "; ".join(checklist_errors))

    retry_headers = dict(request_headers)
    retry_headers[RECEIPT_HEADER] = json.dumps(receipt, sort_keys=True)
    second = _http_request(method, url, headers=retry_headers, body=body_bytes, timeout=timeout)
    return second


class DemoPaidCallHandler(BaseHTTPRequestHandler):
    secret = "demo-shared-secret"
    requirement = PaymentRequirement(
        network="base-sepolia",
        amount="0.01",
        asset="USDC",
        pay_to="0x1111111111111111111111111111111111111111",
        nonce="demo-nonce-001",
        expiry=int(time.time()) + 3600,
        resource="/execute",
    )

    def log_message(self, fmt: str, *args: Any) -> None:
        return

    def _write_json(self, status: int, payload: Mapping[str, Any], extra_headers: Optional[Mapping[str, str]] = None) -> None:
        body = json.dumps(payload, sort_keys=True).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        content_length = int(self.headers.get("Content-Length", "0"))
        raw_body = self.rfile.read(content_length) if content_length else b""
        try:
            body = json.loads(raw_body.decode("utf-8") or "{}")
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._write_json(400, {"ok": False, "error": "invalid_request_json"})
            return

        if self.path != "/execute":
            self._write_json(404, {"ok": False, "error": "not_found"})
            return

        raw_receipt = self.headers.get(RECEIPT_HEADER)
        if not raw_receipt:
            self._write_json(
                402,
                {
                    "ok": False,
                    "error": "payment_required",
                    "hint": "retry with a buyer-generated receipt in X-Payment-Receipt",
                },
                extra_headers={REQUIREMENT_HEADER: json.dumps(self.requirement.to_mapping(), sort_keys=True)},
            )
            return

        try:
            receipt = json.loads(raw_receipt)
        except json.JSONDecodeError:
            self._write_json(400, {"ok": False, "error": "invalid_receipt_json"})
            return

        checklist_errors = validate_receipt_checklist(receipt, self.requirement)
        if checklist_errors:
            self._write_json(400, {"ok": False, "error": "invalid_receipt", "details": checklist_errors})
            return

        if not verify_demo_receipt_signature(receipt, self.secret):
            self._write_json(400, {"ok": False, "error": "bad_signature"})
            return

        self._write_json(
            200,
            {
                "ok": True,
                "result": {
                    "echo": body,
                    "payment_verified": True,
                    "payment_id": receipt["payment_id"],
                },
            },
        )


def start_demo_server(host: str = "127.0.0.1", port: int = 0) -> Tuple[ThreadingHTTPServer, threading.Thread]:
    server = ThreadingHTTPServer((host, port), DemoPaidCallHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread


def demo_buyer(requirements: List[PaymentRequirement], _: Response) -> Mapping[str, Any]:
    requirement = requirements[0]
    return build_demo_receipt(requirement, DemoPaidCallHandler.secret)


def self_test() -> None:
    req = DemoPaidCallHandler.requirement
    receipt = build_demo_receipt(req, DemoPaidCallHandler.secret)
    errors = validate_receipt_checklist(receipt, req)
    assert not errors, f"unexpected checklist errors: {errors}"
    assert verify_demo_receipt_signature(receipt, DemoPaidCallHandler.secret), "signature should verify"

    bad = dict(receipt)
    bad["nonce"] = "tampered"
    tampered_errors = validate_receipt_checklist(bad, req)
    assert tampered_errors, "tampered receipt should fail checklist"

    bad_sig = dict(receipt)
    bad_sig["signature"] = "deadbeef"
    assert not verify_demo_receipt_signature(bad_sig, DemoPaidCallHandler.secret), "bad signature should fail"


def run_demo() -> int:
    self_test()
    server, thread = start_demo_server()
    del thread
    host, port = server.server_address[0], server.server_address[1]
    url = f"http://{host}:{port}/execute"
    try:
        result = execute(
            "POST",
            url,
            buyer=demo_buyer,
            json_body={"op": "ping", "payload": {"message": "hello paid world"}},
        )
        print(json.dumps({"status": result.status, "body": result.json()}, indent=2, sort_keys=True))
        if result.status != 200:
            return 1
        return 0
    finally:
        server.shutdown()
        server.server_close()


def main() -> int:
    parser = argparse.ArgumentParser(description="x402 paid-call receipt checklist with execute() retry demo")
    parser.add_argument(
        "--url",
        help="Optional external URL to call instead of the built-in demo server. The endpoint should answer 402 with X-Payment-Requirements.",
    )
    parser.add_argument(
        "--method",
        default="POST",
        help="HTTP method for --url mode (default: POST)",
    )
    parser.add_argument(
        "--body",
        default='{"op":"ping"}',
        help="JSON request body for --url mode (default: {\"op\":\"ping\"})",
    )
    args = parser.parse_args()

    self_test()

    if not args.url:
        return run_demo()

    try:
        body = json.loads(args.body)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"--body must be valid JSON: {exc}") from exc

    response = execute(args.method, args.url, buyer=demo_buyer, json_body=body)
    print(json.dumps({"status": response.status, "body": response.json()}, indent=2, sort_keys=True))
    return 0 if response.status < 400 else 1


if __name__ == "__main__":
    raise SystemExit(main())
