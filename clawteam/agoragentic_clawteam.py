"""Bounded Agoragentic match/execute bridge for ClawTeam workers.

The bridge has no ClawTeam runtime dependency. A ClawTeam worker can invoke the
CLI directly, or Python code can construct ``AgoragenticClawTeamAdapter``.
Paid execution is fail-closed behind both a positive cap and ``allow_paid``.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from decimal import Decimal, InvalidOperation
from functools import partial
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


DEFAULT_BASE_URL = "https://agoragentic.com"
DEFAULT_TIMEOUT_SECONDS = 20.0
DEFAULT_MAX_RESPONSE_BYTES = 1_048_576
MAX_CAP_USDC = Decimal("10000")
MAX_INPUT_JSON_CHARS = 200_000
LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost"}


class AgoragenticClawTeamError(RuntimeError):
    """Structured adapter failure safe to surface to a worker."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        status: int | None = None,
        retryable: bool = False,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.status = status
        self.retryable = retryable

    def as_dict(self) -> dict[str, Any]:
        return {
            "ok": False,
            "error": {
                "code": self.code,
                "message": str(self),
                "status": self.status,
                "retryable": self.retryable,
            },
        }


class _NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: N802
        return None


Transport = Callable[[str, str, dict[str, str], bytes | None, float, int], tuple[int, bytes]]


def _validated_base_url(value: str, *, allow_insecure_loopback: bool) -> str:
    parsed = urlsplit(value)
    host = (parsed.hostname or "").lower()
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise AgoragenticClawTeamError("invalid_base_url", "Base URL cannot contain credentials, query, or fragment.")
    if parsed.path not in ("", "/"):
        raise AgoragenticClawTeamError("invalid_base_url", "Base URL cannot contain a path.")
    if parsed.scheme == "https" and host == "agoragentic.com" and parsed.port in (None, 443):
        return "https://agoragentic.com"
    if allow_insecure_loopback and parsed.scheme == "http" and host in LOOPBACK_HOSTS:
        return value.rstrip("/")
    raise AgoragenticClawTeamError(
        "invalid_base_url",
        "Base URL must be https://agoragentic.com; HTTP loopback is allowed only for explicit tests.",
    )


def _default_transport(
    method: str,
    url: str,
    headers: dict[str, str],
    body: bytes | None,
    timeout: float,
    max_response_bytes: int,
) -> tuple[int, bytes]:
    request = Request(url, data=body, headers=headers, method=method)
    opener = build_opener(_NoRedirects())
    try:
        with opener.open(request, timeout=timeout) as response:
            payload = response.read(max_response_bytes + 1)
            if len(payload) > max_response_bytes:
                raise AgoragenticClawTeamError("response_too_large", "Router response exceeded the configured byte cap.")
            return int(response.status), payload
    except HTTPError as error:
        payload = error.read(max_response_bytes + 1)
        if len(payload) > max_response_bytes:
            payload = b""
        return int(error.code), payload
    except URLError as error:
        raise AgoragenticClawTeamError("network_error", "Router request failed.", retryable=True) from error


def _nonempty_task(task: str) -> str:
    normalized = str(task or "").strip()
    if not normalized or len(normalized) > 500:
        raise AgoragenticClawTeamError("invalid_task", "task must contain 1 to 500 characters.")
    return normalized


def _cap(value: str | int | float | Decimal) -> Decimal:
    try:
        cap = Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise AgoragenticClawTeamError("invalid_max_cost", "max_cost_usdc must be a decimal amount.") from None
    if not cap.is_finite() or cap < 0 or cap > MAX_CAP_USDC or cap.as_tuple().exponent < -6:
        raise AgoragenticClawTeamError(
            "invalid_max_cost",
            "max_cost_usdc must be between 0 and 10000 with at most 6 decimal places.",
        )
    return cap


def _canonical_decimal(value: Decimal) -> str:
    rendered = format(value, "f")
    return rendered.rstrip("0").rstrip(".") if "." in rendered else rendered


def _json_number(value: Decimal) -> int | float:
    rendered = _canonical_decimal(value)
    return int(rendered) if "." not in rendered else float(rendered)


def _provider_rows(payload: Any) -> list[dict[str, Any]]:
    if not isinstance(payload, dict):
        return []
    for candidate in (
        payload.get("providers"),
        payload.get("matches"),
        payload.get("data", {}).get("providers") if isinstance(payload.get("data"), dict) else None,
    ):
        if isinstance(candidate, list):
            return [row for row in candidate if isinstance(row, dict)]
    return []


def _provider_price(row: dict[str, Any]) -> Decimal | None:
    candidates = [row.get("price_usdc"), row.get("price"), row.get("cost")]
    pricing = row.get("pricing")
    if isinstance(pricing, dict):
        candidates.extend([pricing.get("amount_usdc"), pricing.get("amount")])
    for candidate in candidates:
        if candidate is None or isinstance(candidate, bool):
            continue
        try:
            price = Decimal(str(candidate))
        except InvalidOperation:
            continue
        if price.is_finite() and price >= 0:
            return price
    return None


class AgoragenticClawTeamAdapter:
    """ClawTeam-safe Router client with an explicit no-spend default."""

    def __init__(
        self,
        *,
        api_key: str | None = None,
        base_url: str = DEFAULT_BASE_URL,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
        max_response_bytes: int = DEFAULT_MAX_RESPONSE_BYTES,
        transport: Transport | None = None,
        allow_insecure_loopback: bool = False,
    ) -> None:
        key = api_key or os.environ.get("AGORAGENTIC_API_KEY")
        if not key:
            raise AgoragenticClawTeamError("missing_api_key", "AGORAGENTIC_API_KEY is required.")
        if not isinstance(max_response_bytes, int) or not 1 <= max_response_bytes <= 4_194_304:
            raise AgoragenticClawTeamError("invalid_response_cap", "max_response_bytes must be between 1 and 4194304.")
        if timeout_seconds <= 0 or timeout_seconds > 120:
            raise AgoragenticClawTeamError("invalid_timeout", "timeout_seconds must be greater than 0 and at most 120.")
        self._api_key = key
        self._base_url = _validated_base_url(base_url, allow_insecure_loopback=allow_insecure_loopback)
        self._timeout = float(timeout_seconds)
        self._max_response_bytes = max_response_bytes
        self._transport = transport or _default_transport

    def _request(self, method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        encoded = None if body is None else json.dumps(body, separators=(",", ":")).encode("utf-8")
        headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {self._api_key}",
            "User-Agent": "agoragentic-clawteam/0.1",
        }
        if encoded is not None:
            headers["Content-Type"] = "application/json"
        status, raw = self._transport(
            method,
            urljoin(f"{self._base_url}/", path.lstrip("/")),
            headers,
            encoded,
            self._timeout,
            self._max_response_bytes,
        )
        if len(raw) > self._max_response_bytes:
            raise AgoragenticClawTeamError("response_too_large", "Router response exceeded the configured byte cap.")
        try:
            payload = json.loads(raw.decode("utf-8")) if raw else {}
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise AgoragenticClawTeamError("invalid_json_response", "Router returned invalid JSON.", status=status) from None
        if not isinstance(payload, dict):
            raise AgoragenticClawTeamError("invalid_response_shape", "Router response must be a JSON object.", status=status)
        if status < 200 or status >= 300:
            error = payload.get("error")
            code = error.get("code") if isinstance(error, dict) else payload.get("code")
            message = error.get("message") if isinstance(error, dict) else payload.get("message")
            raise AgoragenticClawTeamError(
                str(code or "router_request_failed"),
                str(message or f"Router request failed with HTTP {status}."),
                status=status,
                retryable=status == 429 or status >= 500,
            )
        return payload

    def match(self, task: str, *, max_cost_usdc: str | int | float | Decimal = "0") -> dict[str, Any]:
        normalized_task = _nonempty_task(task)
        cap = _cap(max_cost_usdc)
        query = urlencode({"task": normalized_task, "max_cost": _canonical_decimal(cap)})
        return self._request("GET", f"/api/execute/match?{query}")

    def execute(
        self,
        task: str,
        input_data: Any,
        *,
        max_cost_usdc: str | int | float | Decimal = "0",
        allow_paid: bool = False,
    ) -> dict[str, Any]:
        normalized_task = _nonempty_task(task)
        cap = _cap(max_cost_usdc)
        if cap > 0 and allow_paid is not True:
            raise AgoragenticClawTeamError(
                "paid_execution_not_authorized",
                "Positive max_cost_usdc also requires allow_paid=True.",
            )
        preview = self.match(normalized_task, max_cost_usdc=cap)
        rows = _provider_rows(preview)
        prices = [_provider_price(row) for row in rows]
        if not rows or any(price is None for price in prices):
            raise AgoragenticClawTeamError(
                "unpriced_match",
                "Execution stopped because the preview did not provide a bounded price for every candidate.",
            )
        if not any(price <= cap for price in prices if price is not None):
            raise AgoragenticClawTeamError("no_provider_within_cap", "No matched provider is within max_cost_usdc.")
        return self._request(
            "POST",
            "/api/execute",
            {
                "task": normalized_task,
                "input": input_data,
                "constraints": {"max_cost": _json_number(cap)},
            },
        )


def agoragentic_match(
    adapter: AgoragenticClawTeamAdapter,
    task: str,
    *,
    max_cost_usdc: str | int | float | Decimal = "0",
) -> dict[str, Any]:
    """Canonical ClawTeam-facing provider preview tool."""
    return adapter.match(task, max_cost_usdc=max_cost_usdc)


def agoragentic_execute(
    adapter: AgoragenticClawTeamAdapter,
    task: str,
    input_data: Any,
    *,
    max_cost_usdc: str | int | float | Decimal = "0",
    allow_paid: bool = False,
) -> dict[str, Any]:
    """Canonical ClawTeam-facing bounded execution tool."""
    return adapter.execute(
        task,
        input_data,
        max_cost_usdc=max_cost_usdc,
        allow_paid=allow_paid,
    )


CLAWTEAM_TOOL_IDS = ("agoragentic_execute", "agoragentic_match")


def get_agoragentic_tools(
    adapter: AgoragenticClawTeamAdapter,
) -> dict[str, Callable[..., dict[str, Any]]]:
    """Return canonical tool IDs mapped to adapter-bound callables."""
    return {
        "agoragentic_execute": partial(agoragentic_execute, adapter),
        "agoragentic_match": partial(agoragentic_match, adapter),
    }


def _parse_input(value: str) -> Any:
    if len(value) > MAX_INPUT_JSON_CHARS:
        raise AgoragenticClawTeamError("input_too_large", "--input-json exceeds 200000 characters.")
    try:
        return json.loads(value)
    except json.JSONDecodeError as error:
        raise AgoragenticClawTeamError("invalid_input_json", "--input-json must contain valid JSON.") from error


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Bounded Agoragentic bridge for ClawTeam workers")
    subparsers = parser.add_subparsers(dest="command", required=True)
    match_parser = subparsers.add_parser("match", help="Preview providers without execution")
    match_parser.add_argument("--task", required=True)
    match_parser.add_argument("--max-cost-usdc", default="0")
    execute_parser = subparsers.add_parser("execute", help="Execute only inside the explicit cost boundary")
    execute_parser.add_argument("--task", required=True)
    execute_parser.add_argument("--input-json", required=True)
    execute_parser.add_argument("--max-cost-usdc", default="0")
    execute_parser.add_argument("--allow-paid", action="store_true")
    args = parser.parse_args(argv)

    try:
        adapter = AgoragenticClawTeamAdapter()
        if args.command == "match":
            result = adapter.match(args.task, max_cost_usdc=args.max_cost_usdc)
        else:
            result = adapter.execute(
                args.task,
                _parse_input(args.input_json),
                max_cost_usdc=args.max_cost_usdc,
                allow_paid=args.allow_paid,
            )
        print(json.dumps({"ok": True, "result": result}, separators=(",", ":")))
        return 0
    except AgoragenticClawTeamError as error:
        print(json.dumps(error.as_dict(), separators=(",", ":")), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
