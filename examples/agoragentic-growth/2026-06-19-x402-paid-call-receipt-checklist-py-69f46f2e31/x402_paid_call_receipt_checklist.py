"""demo - moves no real funds."""

from __future__ import annotations

import base64
import hashlib
import json
import threading
import time
import uuid
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any, Callable, Dict, List, Mapping, Optional
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


@dataclass
class HttpResponse:
    status: int
    headers: Dict[str, str]
    body: bytes

    def json(self) -> Dict[str, Any]:
        if not self.body:
            return {}
        return json.loads(self.body.decode("utf-8"))


@dataclass
class PaymentAuthorization:
    scheme: str
    token: str
    authorization_id: str
    note: str = ""


@dataclass
class ExecutionResult:
    response: HttpResponse
    payment_authorization: Optional[PaymentAuthorization]
    attempts: int
    idempotency_key: str
    checklist: List[Dict[str, Any]]


class PaymentRequiredError(RuntimeError):
    pass


class PaidCallExecutor:
    def __init__(
        self,
        timeout_seconds: float = 10.0,
        retryable_statuses: Optional[List[int]] = None,
        backoff_seconds: float = 0.15,
    ) -> None:
        self.timeout_seconds = timeout_seconds
        if retryable_statuses is None:
            retryable_statuses = [429, 500, 502, 503, 504]
        self.retryable_statuses = set(retryable_statuses)
        self.backoff_seconds = backoff_seconds

    def execute(
        self,
        url: str,
        method: str,
        payload: Mapping[str, Any],
        headers: Optional[Mapping[str, str]] = None,
        pay: Optional[
            Callable[[Mapping[str, Any], str, Optional[PaymentAuthorization]], PaymentAuthorization]
        ] = None,
        max_attempts: int = 4,
    ) -> ExecutionResult:
        if max_attempts < 1:
            raise ValueError("max_attempts must be >= 1")

        base_headers = dict(headers or {})
        idempotency_key = base_headers.get("X-Idempotency-Key", str(uuid.uuid4()))
        base_headers["X-Idempotency-Key"] = idempotency_key
        base_headers.setdefault("Content-Type", "application/json")
        payment_authorization: Optional[PaymentAuthorization] = None
        last_response: Optional[HttpResponse] = None

        for attempt in range(1, max_attempts + 1):
            request_headers = dict(base_headers)
            if payment_authorization is not None:
                request_headers["Authorization"] = (
                    f"{payment_authorization.scheme} {payment_authorization.token}"
                )
                request_headers["PAYMENT-SIGNATURE"] = payment_authorization.token
                request_headers["X-Payment-Authorization-Id"] = (
                    payment_authorization.authorization_id
                )

            response = self._request(
                url=url,
                method=method,
                payload=payload,
                headers=request_headers,
            )
            last_response = response

            if response.status == 402:
                if pay is None:
                    raise PaymentRequiredError(
                        "Server returned HTTP 402 but no pay callback was supplied."
                    )
                if attempt >= max_attempts:
                    raise PaymentRequiredError(
                        "Server returned HTTP 402 on the final attempt; refusing to authorize a payment "
                        "that cannot be retried."
                    )
                requirement = self._extract_payment_requirement(response)
                payment_authorization = pay(
                    requirement,
                    idempotency_key,
                    payment_authorization,
                )
                continue

            if response.status in self.retryable_statuses and attempt < max_attempts:
                time.sleep(self.backoff_seconds * attempt)
                continue

            checklist = build_receipt_checklist(
                response=response,
                idempotency_key=idempotency_key,
                payment_authorization=payment_authorization,
            )
            return ExecutionResult(
                response=response,
                payment_authorization=payment_authorization,
                attempts=attempt,
                idempotency_key=idempotency_key,
                checklist=checklist,
            )

        assert last_response is not None
        checklist = build_receipt_checklist(
            response=last_response,
            idempotency_key=idempotency_key,
            payment_authorization=payment_authorization,
        )
        return ExecutionResult(
            response=last_response,
            payment_authorization=payment_authorization,
            attempts=max_attempts,
            idempotency_key=idempotency_key,
            checklist=checklist,
        )

    def _request(
        self,
        url: str,
        method: str,
        payload: Mapping[str, Any],
        headers: Mapping[str, str],
    ) -> HttpResponse:
        data = json.dumps(payload).encode("utf-8")
        request = Request(url=url, data=data, headers=dict(headers), method=method.upper())

        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                return HttpResponse(
                    status=response.status,
                    headers={k: v for k, v in response.headers.items()},
                    body=response.read(),
                )
        except HTTPError as error:
            return HttpResponse(
                status=error.code,
                headers={k: v for k, v in error.headers.items()},
                body=error.read(),
            )
        except URLError as error:
            raise RuntimeError(f"Network error calling {url}: {error}") from error

    @staticmethod
    def _extract_payment_requirement(response: HttpResponse) -> Dict[str, Any]:
        header_value = _get_header(
            response.headers,
            "X-Payment-Required",
            "PAYMENT-REQUIRED",
            "payment-required",
        )
        if header_value:
            return _parse_header_json(header_value)
        body = response.json()
        if isinstance(body, dict) and isinstance(body.get("payment_required"), dict):
            return body["payment_required"]
        raise PaymentRequiredError("HTTP 402 response did not include payment requirements.")


def build_receipt_checklist(
    response: HttpResponse,
    idempotency_key: str,
    payment_authorization: Optional[PaymentAuthorization],
) -> List[Dict[str, Any]]:
    body: Dict[str, Any]
    try:
        body = response.json()
    except Exception:
        body = {}

    receipt = body.get("receipt") if isinstance(body, dict) else None
    if not isinstance(receipt, dict):
        receipt_header = _get_header(response.headers, "Payment-Receipt", "X-Payment-Receipt")
        if receipt_header:
            try:
                receipt = _parse_header_json(receipt_header)
            except Exception:
                receipt = {}
        else:
            receipt = {}

    checks: List[Dict[str, Any]] = []

    def add(name: str, ok: bool, evidence: str) -> None:
        checks.append({"name": name, "ok": ok, "evidence": evidence})

    add(
        "http_success",
        200 <= response.status < 300,
        f"status={response.status}",
    )
    add(
        "json_content_type",
        response.headers.get("Content-Type", "").startswith("application/json"),
        f"content_type={response.headers.get('Content-Type', '')}",
    )
    add(
        "receipt_present",
        bool(receipt),
        f"receipt_keys={sorted(receipt.keys()) if receipt else []}",
    )
    add(
        "idempotency_key_sent_and_echoed",
        receipt.get("idempotency_key") == idempotency_key,
        f"expected={idempotency_key} actual={receipt.get('idempotency_key')}",
    )
    add(
        "authorization_reused_or_matched",
        (
            payment_authorization is None
            or receipt.get("authorization_id") == payment_authorization.authorization_id
        ),
        (
            f"expected={getattr(payment_authorization, 'authorization_id', None)} "
            f"actual={receipt.get('authorization_id')}"
        ),
    )
    add(
        "server_claims_single_charge",
        receipt.get("charge_count") == 1,
        f"charge_count={receipt.get('charge_count')}",
    )
    add(
        "settlement_claim_is_non_terminal_demo_safe",
        receipt.get("settlement_status") in {"demo-accepted", "accepted", "pending"},
        f"settlement_status={receipt.get('settlement_status')}",
    )
    add(
        "tool_result_present",
        isinstance(body.get("result"), dict),
        f"result_type={type(body.get('result')).__name__}",
    )
    return checks


def deterministic_demo_pay(
    requirement: Mapping[str, Any],
    idempotency_key: str,
    prior_authorization: Optional[PaymentAuthorization] = None,
) -> PaymentAuthorization:
    if prior_authorization is not None:
        return prior_authorization

    digest = hashlib.sha256(
        (
            requirement.get("asset", "demo")
            + "|"
            + requirement.get("amount", "0")
            + "|"
            + idempotency_key
        ).encode("utf-8")
    ).hexdigest()

    authorization_id = f"demo-auth-{digest[:16]}"
    token = f"demo-token-{digest[:32]}"
    return PaymentAuthorization(
        scheme="X402",
        token=token,
        authorization_id=authorization_id,
        note="Deterministic demo authorization derived from requirement + idempotency key.",
    )


class DemoPaidCallHandler(BaseHTTPRequestHandler):
    paid_attempts_by_authorization: Dict[str, int] = {}
    charge_count_by_authorization: Dict[str, int] = {}

    def do_POST(self) -> None:
        if self.path != "/mcp/execute":
            self._write_json(404, {"error": "not_found"})
            return

        content_length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(content_length)
        try:
            payload = json.loads(body.decode("utf-8"))
        except Exception:
            self._write_json(400, {"error": "invalid_json"})
            return

        idempotency_key = self.headers.get("X-Idempotency-Key")
        if not idempotency_key:
            self._write_json(400, {"error": "missing_idempotency_key"})
            return

        authorization_header = self.headers.get("Authorization")
        payment_signature = self.headers.get("PAYMENT-SIGNATURE")
        if not authorization_header:
            requirement = {
                "version": 1,
                "scheme": "X402",
                "network": "demo",
                "asset": "USD",
                "amount": "0.05",
                "pay_to": "demo://merchant/mcp",
                "description": "Demo MCP tool call payment requirement.",
            }
            self._write_json(
                402,
                {
                    "error": "payment_required",
                    "payment_required": requirement,
                },
                extra_headers={"X-Payment-Required": json.dumps(requirement)},
            )
            return

        if not authorization_header.startswith("X402 demo-token-"):
            self._write_json(401, {"error": "invalid_authorization"})
            return
        if payment_signature != authorization_header.split(" ", 1)[1]:
            self._write_json(401, {"error": "missing_or_mismatched_payment_signature"})
            return

        auth_token = authorization_header.split(" ", 1)[1]
        authorization_id = self.headers.get("X-Payment-Authorization-Id") or "missing-auth-id"

        attempt_count = self.paid_attempts_by_authorization.get(authorization_id, 0) + 1
        self.paid_attempts_by_authorization[authorization_id] = attempt_count

        if authorization_id not in self.charge_count_by_authorization:
            self.charge_count_by_authorization[authorization_id] = 1

        if attempt_count == 1:
            self._write_json(
                503,
                {
                    "error": "transient_upstream_failure",
                    "detail": "First paid attempt fails to demonstrate retry without re-paying.",
                },
            )
            return

        receipt_id = f"rcpt-{hashlib.sha256((authorization_id + idempotency_key).encode()).hexdigest()[:16]}"
        result = {
            "tool": payload.get("params", {}).get("name", "unknown"),
            "output": {
                "echo_arguments": payload.get("params", {}).get("arguments", {}),
                "paid": True,
                "authorization_token_suffix": auth_token[-8:],
            },
        }
        receipt = {
            "receipt_id": receipt_id,
            "authorization_id": authorization_id,
            "idempotency_key": idempotency_key,
            "amount": "0.05",
            "currency": "USD",
            "resource": self.path,
            "charge_count": self.charge_count_by_authorization[authorization_id],
            "settlement_status": "demo-accepted",
        }
        self._write_json(200, {"result": result, "receipt": receipt})

    def _write_json(
        self,
        status: int,
        payload: Mapping[str, Any],
        extra_headers: Optional[Mapping[str, str]] = None,
    ) -> None:
        encoded = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, format: str, *args: Any) -> None:
        return


def start_demo_server() -> tuple[HTTPServer, str]:
    server = HTTPServer(("127.0.0.1", 0), DemoPaidCallHandler)
    host, port = server.server_address
    url = f"http://{host}:{port}/mcp/execute"
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, url


def _get_header(headers: Mapping[str, str], *names: str) -> Optional[str]:
    normalized = {str(key).lower(): value for key, value in headers.items()}
    for name in names:
        value = normalized.get(name.lower())
        if value:
            return value
    return None


def _parse_header_json(value: str) -> Dict[str, Any]:
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        parsed = json.loads(base64.b64decode(value.encode("utf-8")).decode("utf-8"))
    if not isinstance(parsed, dict):
        raise ValueError("payment header did not decode to an object")
    return parsed


def run_self_test() -> None:
    server, url = start_demo_server()
    try:
        no_retry_executor = PaidCallExecutor(retryable_statuses=[])
        if no_retry_executor.retryable_statuses:
            raise AssertionError("Explicit empty retryable_statuses should disable retryable-status retries.")

        encoded_requirement = base64.b64encode(
            json.dumps({"amount": "0.05", "asset": "USD"}).encode("utf-8")
        ).decode("ascii")
        parsed_requirement = PaidCallExecutor._extract_payment_requirement(
            HttpResponse(status=402, headers={"PAYMENT-REQUIRED": encoded_requirement}, body=b"")
        )
        if parsed_requirement.get("asset") != "USD":
            raise AssertionError("PAYMENT-REQUIRED header should be accepted and decoded.")

        pay_calls = 0

        def forbidden_pay(
            requirement: Mapping[str, Any],
            idempotency_key: str,
            prior_authorization: Optional[PaymentAuthorization] = None,
        ) -> PaymentAuthorization:
            nonlocal pay_calls
            pay_calls += 1
            return deterministic_demo_pay(requirement, idempotency_key, prior_authorization)

        try:
            PaidCallExecutor().execute(
                url=url,
                method="POST",
                payload={"jsonrpc": "2.0", "id": "final-attempt", "method": "tools/call"},
                pay=forbidden_pay,
                max_attempts=1,
            )
            raise AssertionError("Final-attempt 402 should not authorize payment.")
        except PaymentRequiredError:
            if pay_calls != 0:
                raise AssertionError("Payment callback should not be called when no retry remains.")

        executor = PaidCallExecutor()
        payload = {
            "jsonrpc": "2.0",
            "id": "demo-1",
            "method": "tools/call",
            "params": {
                "name": "search_docs",
                "arguments": {"query": "x402 receipt checklist"},
            },
        }
        result = executor.execute(
            url=url,
            method="POST",
            payload=payload,
            pay=deterministic_demo_pay,
            max_attempts=4,
        )

        if result.response.status != 200:
            raise AssertionError(f"Expected 200 response, got {result.response.status}")

        if result.payment_authorization is None:
            raise AssertionError("Expected payment authorization to be created after HTTP 402.")

        body = result.response.json()
        receipt = body.get("receipt", {})
        if receipt.get("charge_count") != 1:
            raise AssertionError(f"Expected single charge, got {receipt.get('charge_count')}")

        if result.attempts != 3:
            raise AssertionError(f"Expected 3 attempts (402, 503, 200), got {result.attempts}")

        if not all(check["ok"] for check in result.checklist):
            raise AssertionError(f"Checklist failed: {json.dumps(result.checklist, indent=2)}")

        receipt_header = base64.b64encode(json.dumps(receipt).encode("utf-8")).decode("ascii")
        header_checks = build_receipt_checklist(
            response=HttpResponse(
                status=200,
                headers={"Content-Type": "application/json", "Payment-Receipt": receipt_header},
                body=json.dumps({"result": body.get("result")}).encode("utf-8"),
            ),
            idempotency_key=result.idempotency_key,
            payment_authorization=result.payment_authorization,
        )
        if not all(check["ok"] for check in header_checks):
            raise AssertionError(f"Header receipt checklist failed: {json.dumps(header_checks, indent=2)}")

        output = {
            "demo": "ok",
            "attempts": result.attempts,
            "idempotency_key": result.idempotency_key,
            "authorization_id": result.payment_authorization.authorization_id,
            "receipt_id": receipt.get("receipt_id"),
            "checklist": result.checklist,
            "result": body.get("result"),
        }
        print(json.dumps(output, indent=2, sort_keys=True))
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    run_self_test()
