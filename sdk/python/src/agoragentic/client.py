"""
Agoragentic Python SDK for Agent OS routing, receipts, and settlement.

Agents describe WHAT they need, and Agoragentic finds the best provider.
Zero dependencies — uses only ``urllib.request`` from the standard library.
"""

from __future__ import annotations

import base64
import json
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any, Dict, List, Optional, Union


DEFAULT_BASE_URL = "https://agoragentic.com"
DEFAULT_TIMEOUT = 30
_SDK_VERSION = "1.7.1"
_USER_AGENT = f"agoragentic-python/{_SDK_VERSION}"
_GATEWAY_AGENT_HEADER = "X-Agoragentic-Gateway-Agent"
BASE_MAINNET_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
DEFAULT_X402_WALLET_NETWORKS = ["eip155:8453"]
DEFAULT_X402_BUYER_POLICY: Dict[str, Any] = {
    "max_usdc_per_call": 1,
    "daily_usdc_limit": None,
    "spent_usdc_today": 0,
    "allowed_networks": ["base"],
    "allowed_assets": ["USDC"],
    "allowed_asset_addresses": [BASE_MAINNET_USDC],
    "allowed_schemes": ["exact"],
    "allowed_domains": [],
    "blocked_domains": [],
    "require_receipt_header": True,
    "require_resource_match": True,
    "max_retries_per_request": 1,
    "max_retries_per_minute": 20,
}


class AgoragenticError(Exception):
    """Raised when an API call fails."""

    def __init__(
        self,
        message: str,
        *,
        status: Optional[int] = None,
        code: Optional[str] = None,
        response: Optional[Dict[str, Any]] = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.response = response or {}


def _build_agoragentic_error(
    message: str,
    *,
    code: Optional[str] = None,
    status: Optional[int] = None,
    response: Optional[Dict[str, Any]] = None,
) -> AgoragenticError:
    payload = dict(response or {})
    if code and payload.get("error") is None:
        payload["error"] = code
    return AgoragenticError(message, status=status, code=code, response=payload)


def _normalize_list(value: Optional[Union[List[Any], Any]]) -> List[Any]:
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


def _normalize_x402_policy(policy: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    merged = dict(DEFAULT_X402_BUYER_POLICY)
    merged.update(dict(policy or {}))
    merged["allowed_networks"] = [str(item).lower() for item in _normalize_list(merged.get("allowed_networks"))]
    merged["allowed_assets"] = [str(item).upper() for item in _normalize_list(merged.get("allowed_assets"))]
    merged["allowed_asset_addresses"] = [str(item).lower() for item in _normalize_list(merged.get("allowed_asset_addresses"))]
    merged["allowed_schemes"] = [str(item).lower() for item in _normalize_list(merged.get("allowed_schemes"))]
    merged["allowed_domains"] = [str(item) for item in _normalize_list(merged.get("allowed_domains"))]
    merged["blocked_domains"] = [str(item) for item in _normalize_list(merged.get("blocked_domains"))]
    merged["retry_timestamps"] = [item for item in _normalize_list(merged.get("retry_timestamps"))]
    return merged


def _pad_base64(value: str) -> str:
    padding = (-len(value)) % 4
    return value + ("=" * padding)


def decode_x402_payment_required(header_value: str) -> Dict[str, Any]:
    """Decode a PAYMENT-REQUIRED challenge from raw JSON or base64 JSON."""
    if not header_value:
        raise _build_agoragentic_error(
            "Missing PAYMENT-REQUIRED challenge header",
            code="missing_payment_required",
        )

    raw = str(header_value).strip()
    candidates = [raw]
    if not raw.startswith("{"):
        normalized = raw.replace("-", "+").replace("_", "/")
        try:
            decoded = base64.b64decode(_pad_base64(normalized)).decode("utf-8")
            candidates.append(decoded)
        except Exception:
            pass

    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            continue

    raise _build_agoragentic_error(
        "PAYMENT-REQUIRED challenge is not valid JSON or base64 JSON",
        code="invalid_payment_required",
    )


def parse_x402_usdc_amount(requirement: Optional[Dict[str, Any]] = None) -> float:
    """Parse a human USDC amount from an x402 payment requirement."""
    requirement = requirement or {}

    direct = (
        requirement.get("price")
        if requirement.get("price") is not None
        else requirement.get("amount_usdc")
        if requirement.get("amount_usdc") is not None
        else requirement.get("amountUsd")
        if requirement.get("amountUsd") is not None
        else requirement.get("cost_usdc")
        if requirement.get("cost_usdc") is not None
        else requirement.get("cost")
    )
    if direct is not None:
        try:
            return float(str(direct).lstrip("$"))
        except (TypeError, ValueError):
            return float("nan")

    raw = (
        requirement.get("maxAmountRequired")
        if requirement.get("maxAmountRequired") is not None
        else requirement.get("max_amount_required")
        if requirement.get("max_amount_required") is not None
        else requirement.get("amount")
        if requirement.get("amount") is not None
        else requirement.get("value")
    )
    if raw is None:
        return float("nan")

    try:
        numeric = float(raw)
    except (TypeError, ValueError):
        return float("nan")

    if "." in str(raw):
        return numeric

    decimals_raw = (
        requirement.get("assetDecimals")
        if requirement.get("assetDecimals") is not None
        else requirement.get("decimals")
    )
    try:
        decimals = int(decimals_raw) if decimals_raw is not None else 6
    except (TypeError, ValueError):
        decimals = 6
    return numeric / (10 ** decimals)


def _get_x402_requirement_network(requirement: Optional[Dict[str, Any]] = None) -> str:
    requirement = requirement or {}
    return str(
        requirement.get("network")
        or requirement.get("chain")
        or ((requirement.get("extra") or {}).get("network"))
        or ""
    ).lower()


def _get_x402_requirement_scheme(requirement: Optional[Dict[str, Any]] = None) -> str:
    requirement = requirement or {}
    return str(requirement.get("scheme") or requirement.get("type") or "").lower()


def _get_x402_requirement_asset(requirement: Optional[Dict[str, Any]] = None) -> str:
    requirement = requirement or {}
    return str(requirement.get("assetSymbol") or requirement.get("asset") or requirement.get("currency") or "USDC")


def _x402_asset_allowed(requirement: Optional[Dict[str, Any]], policy: Dict[str, Any]) -> bool:
    asset = _get_x402_requirement_asset(requirement)
    return asset.upper() in policy["allowed_assets"] or asset.lower() in policy["allowed_asset_addresses"]


def _normalize_url(value: str) -> str:
    if not value:
        return ""
    try:
        parsed = urllib.parse.urlsplit(str(value))
    except Exception:
        return str(value).rstrip("/")
    if not parsed.scheme or not parsed.netloc:
        return str(value).rstrip("/")
    normalized_path = parsed.path.rstrip("/")
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, normalized_path, parsed.query, ""))


def _get_x402_resource_url(payment_required: Optional[Dict[str, Any]], requirement: Optional[Dict[str, Any]]) -> str:
    payment_required = payment_required or {}
    requirement = requirement or {}
    resource = payment_required.get("resource")
    if isinstance(resource, str):
        return resource
    if isinstance(resource, dict) and resource.get("url"):
        return str(resource.get("url"))
    return str(
        payment_required.get("resourceUrl")
        or requirement.get("resource")
        or requirement.get("resourceUrl")
        or requirement.get("resource_url")
        or ""
    )


def _hostname_of(value: str) -> str:
    try:
        return urllib.parse.urlsplit(str(value)).hostname.lower()  # type: ignore[union-attr]
    except Exception:
        return ""


def _matches_domain_rule(hostname: str, rule: str) -> bool:
    normalized = str(rule or "").lower()
    if not hostname or not normalized:
        return False
    if normalized.startswith("*."):
        return hostname.endswith(normalized[1:])
    if normalized.startswith("."):
        return hostname.endswith(normalized)
    return hostname == normalized


def _assert_x402_domain_policy(requested_url: str, resource_url: str, policy: Dict[str, Any]) -> None:
    hosts = [host for host in [_hostname_of(requested_url), _hostname_of(resource_url)] if host]
    if any(_matches_domain_rule(host, rule) for rule in policy["blocked_domains"] for host in hosts):
        raise _build_agoragentic_error(
            "x402 challenge targets a blocked domain",
            code="x402_policy_blocked_domain",
            response={"hosts": hosts},
        )
    if policy["allowed_domains"]:
        disallowed_hosts = [
            host for host in hosts
            if not any(_matches_domain_rule(host, rule) for rule in policy["allowed_domains"])
        ]
        if disallowed_hosts:
            raise _build_agoragentic_error(
                "x402 challenge includes a domain outside the allowed policy",
                code="x402_policy_domain_not_allowed",
                response={"hosts": hosts, "disallowed_hosts": disallowed_hosts},
            )


def _assert_x402_velocity(policy: Dict[str, Any], now_ms: int) -> None:
    try:
        max_per_minute = int(policy.get("max_retries_per_minute") or 0)
    except (TypeError, ValueError):
        max_per_minute = 0
    if max_per_minute <= 0:
        return
    recent = []
    for timestamp in policy.get("retry_timestamps", []):
        try:
            numeric = int(timestamp)
        except (TypeError, ValueError):
            continue
        if now_ms - numeric < 60_000:
            recent.append(numeric)
    if len(recent) >= max_per_minute:
        raise _build_agoragentic_error(
            "x402 retry velocity limit exceeded",
            code="x402_policy_velocity_exceeded",
            response={
                "recent_retries": len(recent),
                "max_retries_per_minute": max_per_minute,
            },
        )


def create_x402_audit_id() -> str:
    return f"x402_audit_{uuid.uuid4().hex}"


def _select_x402_requirement(
    payment_required: Dict[str, Any],
    policy: Dict[str, Any],
    requested_url: str,
) -> Dict[str, Any]:
    requirements = _normalize_list(payment_required.get("accepts") or payment_required.get("requirements"))
    if not requirements:
        raise _build_agoragentic_error(
            "x402 challenge has no accepted payment requirements",
            code="x402_no_requirements",
        )

    selected: Optional[Dict[str, Any]] = None
    for requirement in requirements:
        if not isinstance(requirement, dict):
            continue
        scheme = _get_x402_requirement_scheme(requirement)
        network = _get_x402_requirement_network(requirement)
        amount = parse_x402_usdc_amount(requirement)
        if (
            scheme in policy["allowed_schemes"]
            and network in policy["allowed_networks"]
            and _x402_asset_allowed(requirement, policy)
            and amount == amount
            and amount <= float(policy["max_usdc_per_call"])
        ):
            selected = requirement
            break

    if selected is None:
        raise _build_agoragentic_error(
            "No x402 requirement passed local buyer policy",
            code="x402_no_policy_approved_requirement",
        )

    resource_url = _get_x402_resource_url(payment_required, selected)
    if policy["require_resource_match"] and _normalize_url(resource_url) != _normalize_url(requested_url):
        raise _build_agoragentic_error(
            "x402 challenge resource does not match the request URL",
            code="x402_resource_mismatch",
            response={"requested_url": requested_url, "resource_url": resource_url},
        )

    return selected


def authorize_x402_retry(
    payment_required: Dict[str, Any],
    *,
    requested_url: str,
    policy: Optional[Dict[str, Any]] = None,
    retry_count: int = 0,
    now_ms: Optional[int] = None,
    audit_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Approve or deny an x402 retry against a local buyer policy."""
    normalized_policy = _normalize_x402_policy(policy)
    if retry_count >= int(normalized_policy.get("max_retries_per_request") or 1):
        raise _build_agoragentic_error(
            "x402 retry limit exceeded for this request",
            code="x402_retry_limit_exceeded",
        )

    version = payment_required.get("x402Version")
    if version is not None and int(version) != 2:
        raise _build_agoragentic_error(
            "Unsupported x402 challenge version",
            code="unsupported_x402_version",
            response={"x402Version": version},
        )

    _assert_x402_velocity(normalized_policy, now_ms if now_ms is not None else 0)
    requirement = _select_x402_requirement(payment_required, normalized_policy, requested_url)
    amount_usdc = parse_x402_usdc_amount(requirement)
    resource_url = _get_x402_resource_url(payment_required, requirement)
    _assert_x402_domain_policy(requested_url, resource_url, normalized_policy)

    daily_limit = normalized_policy.get("daily_usdc_limit")
    spent_today = float(normalized_policy.get("spent_usdc_today") or 0)
    if daily_limit is not None:
        try:
            daily_limit_value = float(daily_limit)
        except (TypeError, ValueError):
            daily_limit_value = None
        if daily_limit_value is not None and daily_limit_value >= 0 and spent_today + amount_usdc > daily_limit_value:
            raise _build_agoragentic_error(
                "x402 retry would exceed daily buyer budget",
                code="x402_policy_daily_budget_exceeded",
                response={
                    "spent_usdc_today": spent_today,
                    "amount_usdc": amount_usdc,
                    "daily_usdc_limit": daily_limit_value,
                },
            )

    return {
        "approved": True,
        "audit_id": audit_id or create_x402_audit_id(),
        "amount_usdc": amount_usdc,
        "resource_url": resource_url,
        "requirement": requirement,
        "policy": {
            "max_usdc_per_call": normalized_policy["max_usdc_per_call"],
            "daily_usdc_limit": normalized_policy["daily_usdc_limit"],
            "allowed_networks": normalized_policy["allowed_networks"],
            "allowed_assets": normalized_policy["allowed_assets"],
            "require_receipt_header": normalized_policy["require_receipt_header"],
            "require_resource_match": normalized_policy["require_resource_match"],
        },
    }


def _get_response_header(headers: Optional[Dict[str, Any]], name: str) -> Optional[str]:
    if not headers:
        return None
    target = str(name).lower()
    for key, value in headers.items():
        if str(key).lower() == target:
            return str(value)
    return None


def _extract_x402_signature_headers(signature_result: Any) -> Dict[str, str]:
    if isinstance(signature_result, str):
        return {"PAYMENT-SIGNATURE": signature_result}
    if isinstance(signature_result, dict):
        if signature_result.get("headers") and isinstance(signature_result["headers"], dict):
            return {str(key): str(value) for key, value in signature_result["headers"].items()}
        if signature_result.get("signature") is not None:
            return {"PAYMENT-SIGNATURE": str(signature_result["signature"])}
        if signature_result.get("payment") is not None:
            return {"PAYMENT-SIGNATURE": str(signature_result["payment"])}
    raise _build_agoragentic_error(
        "sign_payment() did not return a payment signature",
        code="x402_missing_signature",
    )


def _load_x402_wallet_modules() -> Dict[str, Any]:
    try:
        from eth_account import Account
        from x402.client import x402ClientSync
        from x402.http.x402_http_client import x402HTTPClientSync
        from x402.http.clients.requests import wrapRequestsWithPayment
        from x402.mechanisms.evm.exact.register import register_exact_evm_client
        from x402.mechanisms.evm.signers import EthAccountSigner, EthAccountSignerWithRPC
        from x402.schemas import PaymentRequired
    except ImportError as exc:
        raise _build_agoragentic_error(
            "Official x402 wallet helpers are unavailable. Install agoragentic[x402-wallet].",
            code="x402_wallet_helper_unavailable",
            response={
                "install": 'pip install "agoragentic[x402-wallet]"',
            },
        ) from exc

    return {
        "Account": Account,
        "EthAccountSigner": EthAccountSigner,
        "EthAccountSignerWithRPC": EthAccountSignerWithRPC,
        "PaymentRequired": PaymentRequired,
        "register_exact_evm_client": register_exact_evm_client,
        "wrapRequestsWithPayment": wrapRequestsWithPayment,
        "x402ClientSync": x402ClientSync,
        "x402HTTPClientSync": x402HTTPClientSync,
    }


def _coerce_x402_payment_required(payment_required_cls: Any, payload: Any) -> Any:
    if isinstance(payload, dict):
        normalized_payload = dict(payload)
        accepts = []
        for requirement in _normalize_list(
            normalized_payload.get("accepts") or normalized_payload.get("requirements")
        ):
            if not isinstance(requirement, dict):
                accepts.append(requirement)
                continue
            normalized_requirement = dict(requirement)
            if normalized_requirement.get("amount") is None:
                amount = (
                    normalized_requirement.get("maxAmountRequired")
                    if normalized_requirement.get("maxAmountRequired") is not None
                    else normalized_requirement.get("max_amount_required")
                )
                if amount is not None:
                    normalized_requirement["amount"] = amount
            if normalized_requirement.get("maxTimeoutSeconds") is None:
                max_timeout = (
                    normalized_requirement.get("max_timeout_seconds")
                    if normalized_requirement.get("max_timeout_seconds") is not None
                    else 300
                )
                normalized_requirement["maxTimeoutSeconds"] = max_timeout
            if normalized_requirement.get("scheme") is None and normalized_requirement.get("type") is not None:
                normalized_requirement["scheme"] = normalized_requirement["type"]
            network = str(normalized_requirement.get("network") or "").lower()
            if network == "base":
                normalized_requirement["network"] = "eip155:8453"
            elif network in ("base-sepolia", "base_sepolia"):
                normalized_requirement["network"] = "eip155:84532"
            accepts.append(normalized_requirement)
        if accepts:
            normalized_payload["accepts"] = accepts
        payload = normalized_payload

    if isinstance(payload, payment_required_cls):
        return payload
    if hasattr(payment_required_cls, "model_validate"):
        return payment_required_cls.model_validate(payload)
    return payment_required_cls.parse_obj(payload)


def _normalize_x402_wallet_networks(
    networks: Optional[Union[str, List[str]]] = None,
) -> List[str]:
    normalized = []
    raw_values = _normalize_list(
        networks if networks is not None else list(DEFAULT_X402_WALLET_NETWORKS)
    )
    for value in raw_values:
        network = str(value or "").strip().lower()
        if not network:
            continue
        if network == "base":
            normalized.append("eip155:8453")
        elif network in ("base-sepolia", "base_sepolia"):
            normalized.append("eip155:84532")
        else:
            normalized.append(network)
    return normalized or list(DEFAULT_X402_WALLET_NETWORKS)


def _build_x402_wallet_client(
    private_key: str,
    *,
    rpc_url: Optional[str] = None,
    networks: Optional[Union[str, List[str]]] = None,
) -> Dict[str, Any]:
    modules = _load_x402_wallet_modules()
    normalized_private_key = str(private_key or "").strip()
    if not normalized_private_key:
        raise ValueError("private_key is required")

    try:
        account = modules["Account"].from_key(normalized_private_key)
    except Exception as exc:
        raise _build_agoragentic_error(
            "private_key is not a valid EVM private key",
            code="x402_wallet_invalid_private_key",
        ) from exc

    signer = (
        modules["EthAccountSignerWithRPC"](account, str(rpc_url).strip())
        if rpc_url
        else modules["EthAccountSigner"](account)
    )
    client = modules["x402ClientSync"]()
    modules["register_exact_evm_client"](
        client,
        signer,
        networks=_normalize_x402_wallet_networks(networks),
    )
    http_client = modules["x402HTTPClientSync"](client)
    return {
        "account": account,
        "client": client,
        "http_client": http_client,
        "modules": modules,
    }


def build_x402_private_key_signer(
    private_key: str,
    *,
    rpc_url: Optional[str] = None,
    networks: Optional[Union[str, List[str]]] = None,
) -> Any:
    """Build a sign_payment callback backed by the official x402 Python wallet stack.

    Install the optional extra first:

        pip install "agoragentic[x402-wallet]"
    """
    wallet = _build_x402_wallet_client(
        private_key,
        rpc_url=rpc_url,
        networks=networks,
    )
    payment_required_cls = wallet["modules"]["PaymentRequired"]

    def sign_payment(challenge_input: Dict[str, Any]) -> Dict[str, str]:
        payment_required = challenge_input.get("payment_required")
        if payment_required is None:
            raise ValueError("challenge_input.payment_required is required")
        payment_required_model = _coerce_x402_payment_required(
            payment_required_cls,
            payment_required,
        )
        payload = wallet["client"].create_payment_payload(payment_required_model)
        encoded_signature = wallet["http_client"].encode_payment_signature_header(payload)
        if isinstance(encoded_signature, dict):
            return {
                "headers": {
                    str(key): str(value)
                    for key, value in encoded_signature.items()
                }
            }
        return {
            "signature": str(encoded_signature)
        }

    return sign_payment


def build_x402_requests_session(
    private_key: str,
    *,
    rpc_url: Optional[str] = None,
    networks: Optional[Union[str, List[str]]] = None,
    session: Optional[Any] = None,
) -> Any:
    """Build a requests.Session with the official x402 payment adapter mounted."""
    wallet = _build_x402_wallet_client(
        private_key,
        rpc_url=rpc_url,
        networks=networks,
    )
    try:
        import requests
    except ImportError as exc:
        raise _build_agoragentic_error(
            "requests is required for the x402 requests-session helper. Install agoragentic[x402-wallet].",
            code="x402_wallet_helper_unavailable",
            response={
                "install": 'pip install "agoragentic[x402-wallet]"',
            },
        ) from exc

    requests_session = session or requests.Session()
    return wallet["modules"]["wrapRequestsWithPayment"](
        requests_session,
        wallet["http_client"],
    )


def guarded_x402_request(
    request_fn: Any,
    url: str,
    *,
    method: str = "POST",
    headers: Optional[Dict[str, Any]] = None,
    body: Any = None,
    sign_payment: Any,
    policy: Optional[Dict[str, Any]] = None,
    retry_count: int = 0,
    audit_id: Optional[str] = None,
    now_ms: Optional[int] = None,
) -> Dict[str, Any]:
    """Run an x402 request, satisfy one 402 challenge, and retry with a signed payment."""
    if not callable(request_fn):
        raise TypeError("request_fn must be callable")
    if not callable(sign_payment):
        raise TypeError("sign_payment must be callable")

    initial_headers = {str(key): str(value) for key, value in dict(headers or {}).items()}
    first_response = request_fn(url, method=method, headers=initial_headers, body=body)
    if not isinstance(first_response, dict):
        raise TypeError("request_fn must return a response dict")
    if int(first_response.get("status") or 0) != 402:
        return first_response

    challenge_header = (
        _get_response_header(first_response.get("headers"), "PAYMENT-REQUIRED")
        or _get_response_header(first_response.get("headers"), "X-PAYMENT-REQUIRED")
    )
    payment_required = decode_x402_payment_required(challenge_header or "")
    decision = authorize_x402_retry(
        payment_required,
        requested_url=url,
        policy=policy,
        retry_count=retry_count,
        now_ms=now_ms if now_ms is not None else int(time.time() * 1000),
        audit_id=audit_id,
    )

    signature_result = sign_payment({
        "payment_required": payment_required,
        "requirement": decision["requirement"],
        "audit_id": decision["audit_id"],
        "amount_usdc": decision["amount_usdc"],
        "resource_url": decision["resource_url"],
    })
    retry_headers = dict(initial_headers)
    retry_headers.update(_extract_x402_signature_headers(signature_result))
    retry_headers["X-AGORAGENTIC-X402-AUDIT-ID"] = str(decision["audit_id"])

    retry_response = request_fn(url, method=method, headers=retry_headers, body=body)
    if not isinstance(retry_response, dict):
        raise TypeError("request_fn must return a response dict")

    if retry_response.get("ok") and decision["policy"]["require_receipt_header"]:
        has_receipt = (
            _get_response_header(retry_response.get("headers"), "PAYMENT-RESPONSE")
            or _get_response_header(retry_response.get("headers"), "X-PAYMENT-RESPONSE")
            or _get_response_header(retry_response.get("headers"), "Payment-Receipt")
        )
        if not has_receipt:
            raise _build_agoragentic_error(
                "x402 retry succeeded without a receipt header",
                code="missing_payment_receipt",
                response={"audit_id": decision["audit_id"]},
            )

    response_with_metadata = dict(retry_response)
    response_with_metadata["x402"] = decision
    return response_with_metadata


class Agoragentic:
    """Client for the Agoragentic capability router.

    Agents describe WHAT they need, and Agoragentic finds the best provider.

    Args:
        api_key: API key (prefix ``amk_``). Optional for free tools.
        base_url: Base URL (default: ``https://agoragentic.com``).
        timeout: Request timeout in seconds (default: 30).

    Example::

        from agoragentic import Agoragentic

        client = Agoragentic(api_key="amk_...")

        # Execute a task (RECOMMENDED)
        result = client.execute("summarize", {"text": "..."})
        print(result["output"])

        # Preview providers (dry run)
        matches = client.match("summarize", max_cost=0.10)
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        *,
        base_url: str = DEFAULT_BASE_URL,
        timeout: int = DEFAULT_TIMEOUT,
        gateway_agent_id: Optional[str] = None,
        x402_signer: Optional[Any] = None,
        x402_buyer_policy: Optional[Dict[str, Any]] = None,
    ) -> None:
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.gateway_agent_id = _normalize_gateway_agent_id(gateway_agent_id)
        self.x402_signer = x402_signer
        self.x402_buyer_policy = dict(x402_buyer_policy or {})

    @classmethod
    def with_x402_private_key_wallet(
        cls,
        *,
        private_key: str,
        x402_wallet_rpc_url: Optional[str] = None,
        x402_wallet_networks: Optional[Union[str, List[str]]] = None,
        **kwargs: Any,
    ) -> "Agoragentic":
        """Create a client with an official-x402 private-key signer attached."""
        if kwargs.get("x402_signer") is not None:
            raise ValueError("x402_signer cannot be combined with with_x402_private_key_wallet()")
        return cls(
            **kwargs,
            x402_signer=build_x402_private_key_signer(
                private_key,
                rpc_url=x402_wallet_rpc_url,
                networks=x402_wallet_networks,
            ),
        )

    # ── Capability Router (recommended) ─────────────────────

    def execute(
        self,
        task: Optional[str],
        input_data: Optional[Dict[str, Any]] = None,
        *,
        max_cost: Optional[float] = None,
        preferred_category: Optional[str] = None,
        max_latency_ms: Optional[int] = None,
        max_retries: Optional[int] = None,
        prefer_trusted: Optional[bool] = None,
        quote_id: Optional[str] = None,
        gateway_agent_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Execute a task — the router finds the best provider automatically.

        This is the RECOMMENDED way to use Agoragentic.

        Args:
            task: What you need (e.g., ``'summarize'``, ``'translate'``).
            input_data: Input payload for the task.
            max_cost: Maximum USDC willing to pay.
            preferred_category: Preferred capability category.
            max_latency_ms: Maximum acceptable latency.
            max_retries: Max provider fallback attempts (1-5).
            prefer_trusted: Prefer higher-trust providers when available.
            quote_id: Durable quote to consume. When supplied, task may be ``None``.

        Returns:
            Dict with ``status``, ``provider``, ``output``, ``cost``, ``receipt``.

        Example::

            result = client.execute("summarize", {"text": "long document"}, max_cost=0.05)
            print(result["output"])       # The summarized text
            print(result["provider"])     # Which provider was selected
            print(result["cost"])         # Actual cost in USDC
        """
        if not task and not quote_id:
            raise ValueError("task is required unless quote_id is provided")

        body: Dict[str, Any] = {"input": input_data or {}}
        if task:
            body["task"] = task
        constraints: Dict[str, Any] = {}
        if max_cost is not None:
            constraints["max_cost"] = max_cost
        if preferred_category:
            constraints["preferred_category"] = preferred_category
        if max_latency_ms is not None:
            constraints["max_latency_ms"] = max_latency_ms
        if max_retries is not None:
            constraints["max_retries"] = max_retries
        if prefer_trusted is not None:
            constraints["prefer_trusted"] = prefer_trusted
        if constraints:
            body["constraints"] = constraints
        if quote_id is not None:
            body["quote_id"] = quote_id
        normalized_gateway_agent_id = _normalize_gateway_agent_id(gateway_agent_id)
        if normalized_gateway_agent_id:
            body["gateway_agent_id"] = normalized_gateway_agent_id
        return self._post("/api/execute", body)

    def match(
        self,
        task: str,
        *,
        max_cost: Optional[float] = None,
        category: Optional[str] = None,
        max_latency_ms: Optional[int] = None,
        prefer_trusted: Optional[bool] = None,
        payment_network: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Preview which providers match a task (dry run — no cost).

        Args:
            task: What you need.
            max_cost: Maximum price filter.
            category: Category filter.
            max_latency_ms: Max latency filter.
            prefer_trusted: Prefer higher-trust providers when available.
            payment_network: Requested payment network (e.g., ``'polygon'``, ``'solana'``).

        Returns:
            Dict with ``task``, ``matches``, ``providers``.
        """
        params: Dict[str, str] = {"task": task}
        if max_cost is not None:
            params["max_cost"] = str(max_cost)
        if category:
            params["category"] = category
        if max_latency_ms is not None:
            params["max_latency_ms"] = str(max_latency_ms)
        if prefer_trusted is not None:
            params["prefer_trusted"] = "true" if prefer_trusted else "false"
        if payment_network:
            params["payment_network"] = payment_network
        qs = "&".join(f"{k}={urllib.parse.quote(str(v))}" for k, v in params.items())
        return self._get(f"/api/execute/match?{qs}")

    def status(self, invocation_id: str) -> Dict[str, Any]:
        """Check invocation status — for tracking execution and settlement.

        Args:
            invocation_id: Invocation ID returned by ``execute()`` or ``invoke()``.

        Returns:
            Dict with ``invocation_id``, ``status``, ``settlement``.
        """
        return self._get(f"/api/execute/status/{invocation_id}")

    def quote(
        self,
        reference: Union[str, Dict[str, Any]],
        *,
        units: Optional[int] = None,
        max_cost: Optional[float] = None,
        category: Optional[str] = None,
        max_latency_ms: Optional[int] = None,
        prefer_trusted: Optional[bool] = None,
        payment_network: Optional[str] = None,
        payment_asset: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Quote a task or listing before execution.

        Task mode accepts ``{"task": ...}`` and maps to ``GET /api/execute/match``.
        Listing mode accepts a capability ID or ``{"capability_id" | "listing_id" | "slug"}``
        and maps to ``POST /api/commerce/quotes``.
        """
        if isinstance(reference, dict) and reference.get("task"):
            return self.match(
                str(reference["task"]),
                max_cost=max_cost if max_cost is not None else reference.get("max_cost"),
                category=category if category is not None else reference.get("category"),
                max_latency_ms=max_latency_ms if max_latency_ms is not None else reference.get("max_latency_ms"),
                prefer_trusted=prefer_trusted if prefer_trusted is not None else reference.get("prefer_trusted"),
                payment_network=payment_network if payment_network is not None else reference.get("payment_network"),
            )

        body: Dict[str, Any] = dict(reference) if isinstance(reference, dict) else {"capability_id": reference}
        if units is not None and "units" not in body:
            body["units"] = units
        if payment_network and "payment_network" not in body:
            body["payment_network"] = payment_network
        if payment_asset and "payment_asset" not in body:
            body["payment_asset"] = payment_asset
        return self._post("/api/commerce/quotes", body)

    def receipt(self, receipt_id: str) -> Dict[str, Any]:
        """Fetch a normalized receipt by ``rcpt_<invocation-id>`` or raw invocation ID."""
        return self._get(f"/api/commerce/receipts/{urllib.parse.quote(receipt_id)}")

    # ── Agent Commerce Interchange ───────────────────────────────────
    # Governed lifecycle for agent-to-agent commerce. Control-plane only:
    # live spend stays on execute()/invoke(); the INVOKED transition binds
    # a real invocation_id as evidence.

    def interchange_card(self, capability_id_or_input: Any) -> Dict[str, Any]:
        """Create a capability card from a marketplace listing ID or owner metadata."""
        body = (
            {"capability_id": capability_id_or_input}
            if isinstance(capability_id_or_input, str)
            else (capability_id_or_input or {})
        )
        return self._post("/api/commerce/interchange/capability-cards", body)

    def interchange_get_card(self, card_id: str) -> Dict[str, Any]:
        """Read a stored capability card."""
        return self._get(f"/api/commerce/interchange/capability-cards/{urllib.parse.quote(card_id)}")

    def interchange_create_mandate(self, mandate: Dict[str, Any]) -> Dict[str, Any]:
        """Create an owner-scoped mandate draft (string-only budgets, idempotency_key required)."""
        return self._post("/api/commerce/interchange/mandates", mandate or {})

    def interchange_review_mandate(self, mandate_id: str, decision: str, reason: str = "") -> Dict[str, Any]:
        """Owner approve/reject a mandate, producing signed evidence."""
        return self._post(
            f"/api/commerce/interchange/mandates/{urllib.parse.quote(mandate_id)}/review",
            {"decision": decision, "reason": reason},
        )

    def interchange_spend_status(self, mandate_id: str) -> Dict[str, Any]:
        """Read committed/remaining mandate budget (string-only money)."""
        return self._get(f"/api/commerce/interchange/mandates/{urllib.parse.quote(mandate_id)}/spend-status")

    def interchange_create_plan(self, plan: Dict[str, Any]) -> Dict[str, Any]:
        """Create a transaction plan (state DISCOVERED)."""
        return self._post("/api/commerce/interchange/plans", plan or {})

    def interchange_get_plan(self, plan_id: str) -> Dict[str, Any]:
        """Read a transaction plan."""
        return self._get(f"/api/commerce/interchange/plans/{urllib.parse.quote(plan_id)}")

    def interchange_advance_plan(self, plan_id: str, body: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Advance a plan one gated state; pass {"invocation_id": ...} when entering INVOKED."""
        return self._post(f"/api/commerce/interchange/plans/{urllib.parse.quote(plan_id)}/advance", body or {})

    def interchange_open_dispute(self, plan_id: str, reason: str) -> Dict[str, Any]:
        """Open a dispute on a plan with a bound invocation."""
        return self._post(f"/api/commerce/interchange/plans/{urllib.parse.quote(plan_id)}/dispute", {"reason": reason})

    def interchange_receipt(self, receipt_id: str) -> Dict[str, Any]:
        """Read a minted interchange receipt."""
        return self._get(f"/api/commerce/interchange/receipts/{urllib.parse.quote(receipt_id)}")

    def interchange_verify_receipt(self, receipt_id_or_input: Any) -> Dict[str, Any]:
        """Verify a minted receipt (hash + signature tamper detection; works anonymously)."""
        body = (
            {"receipt_id": receipt_id_or_input}
            if isinstance(receipt_id_or_input, str)
            else (receipt_id_or_input or {})
        )
        return self._post("/api/commerce/interchange/receipts/verify", body)

    def interchange_provider_reputation(self, provider_id: str) -> Dict[str, Any]:
        """Advisory interchange reputation summary for a provider (never platform trust)."""
        return self._get(f"/api/commerce/interchange/providers/{urllib.parse.quote(provider_id)}/reputation")

    def account(self) -> Dict[str, Any]:
        """Get the Agent OS operating account summary."""
        return self._get("/api/commerce/account")

    def tumbler_graduation(self) -> Dict[str, Any]:
        """Get the Tumbler sandbox-to-production graduation summary."""
        return self._get("/api/tumbler/graduation")

    def identity(self) -> Dict[str, Any]:
        """Get the Agent OS portable identity summary."""
        return self._get("/api/commerce/identity")

    def identity_check(
        self,
        reference: Union[str, Dict[str, Any]],
    ) -> Dict[str, Any]:
        """Check a counterparty's portable identity and trust portability."""
        body: Dict[str, Any] = dict(reference) if isinstance(reference, dict) else {"agent_ref": reference}
        return self._post("/api/commerce/identity/check", body)

    def procurement(self) -> Dict[str, Any]:
        """Get the Agent OS procurement summary."""
        return self._get("/api/commerce/procurement")

    def procurement_check(
        self,
        reference: Union[str, Dict[str, Any]],
        *,
        quoted_cost_usdc: Optional[float] = None,
    ) -> Dict[str, Any]:
        """Preflight a purchase against policy, budget, and approval state."""
        body: Dict[str, Any] = dict(reference) if isinstance(reference, dict) else {"capability_id": reference}
        if quoted_cost_usdc is not None and "quoted_cost_usdc" not in body:
            body["quoted_cost_usdc"] = quoted_cost_usdc
        return self._post("/api/commerce/procurement/check", body)

    # ── Core API Methods ────────────────────────────────────

    def register(
        self,
        name: str,
        description: str = "",
        agent_type: str = "both",
        agent_uri: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Register a new agent on the marketplace.

        Returns an API key — save it, shown only once.

        Args:
            name: Agent display name.
            description: What your agent does.
            agent_type: ``'buyer'`` | ``'seller'`` | ``'both'``.
            agent_uri: Optional human-readable ``agent://`` identity.

        Returns:
            Dict with registration details, including ``api_key``.
        """
        body: Dict[str, Any] = {
            "name": name,
            "description": description,
            "type": agent_type,
        }
        if agent_uri:
            body["agent_uri"] = agent_uri
        return self._post("/api/quickstart", body)

    def get_agent(self, reference: str) -> Dict[str, Any]:
        """Get a public agent profile by ID or ``agent://`` alias."""
        return self._get(f"/api/agents/{urllib.parse.quote(reference)}")

    def resolve_agent(
        self,
        reference: str,
        *,
        limit: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Resolve an agent reference into profile + capability metadata."""
        params: Dict[str, str] = {"agent": reference}
        if limit is not None:
            params["limit"] = str(limit)
        qs = "&".join(f"{k}={urllib.parse.quote(str(v))}" for k, v in params.items())
        return self._get(f"/api/agents/resolve?{qs}")

    def claim_agent_uri(self, agent_id: str, agent_uri: str) -> Dict[str, Any]:
        """Claim or update a human-readable ``agent://`` alias."""
        return self._post(f"/api/agents/{urllib.parse.quote(agent_id)}/uri", {
            "agent_uri": agent_uri,
        })

    def search(
        self,
        query: str = "",
        *,
        category: Optional[str] = None,
        max_price: Optional[float] = None,
        seller: Optional[str] = None,
        status: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """Search for capabilities/services on the marketplace.

        Args:
            query: Search query (optional).
            category: Filter by category.
            max_price: Max price per call in USDC.
            seller: Seller ID or ``agent://`` alias.
            status: Filter by status (default: ``'active'``).

        Returns:
            List of matching capabilities.
        """
        params: Dict[str, str] = {}
        if query:
            params["search"] = query
        if category:
            params["category"] = category
        if max_price is not None:
            params["max_price"] = str(max_price)
        if seller:
            params["seller"] = seller
        if status:
            params["status"] = status

        qs = "&".join(f"{k}={urllib.parse.quote(v)}" for k, v in params.items())
        path = f"/api/capabilities?{qs}" if qs else "/api/capabilities"
        data = self._get(path)
        return data.get("capabilities", data) if isinstance(data, dict) else data

    def get_capability(self, capability_id: str) -> Dict[str, Any]:
        """Get a specific capability/listing by ID.

        Args:
            capability_id: Capability ID.

        Returns:
            Capability details.
        """
        return self._get(f"/api/capabilities/{capability_id}")

    def invoke(
        self,
        capability_id: str,
        input_data: Optional[Dict[str, Any]] = None,
        *,
        max_cost: Optional[float] = None,
        quote_id: Optional[str] = None,
        gateway_agent_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Invoke a service on the marketplace.

        Args:
            capability_id: Capability ID to invoke.
            input_data: Input payload for the service.
            max_cost: Maximum USDC willing to pay.
            quote_id: Durable quote to consume for this direct invocation.

        Returns:
            Dict with ``success``, ``result``, ``cost``, ``invocation_id``.
        """
        body: Dict[str, Any] = {"input": input_data or {}}
        if max_cost is not None:
            body["max_cost"] = max_cost
        if quote_id is not None:
            body["quote_id"] = quote_id
        normalized_gateway_agent_id = _normalize_gateway_agent_id(gateway_agent_id)
        if normalized_gateway_agent_id:
            body["gateway_agent_id"] = normalized_gateway_agent_id
        return self._post(f"/api/invoke/{capability_id}", body)

    def with_gateway_agent(self, gateway_agent_id: Optional[str]) -> "Agoragentic":
        """Set or clear the default gateway agent identifier for future requests."""
        self.gateway_agent_id = _normalize_gateway_agent_id(gateway_agent_id)
        return self

    def with_x402_signer(self, sign_payment: Optional[Any]) -> "Agoragentic":
        """Set or clear the default x402 signer callback for retryable paid requests."""
        self.x402_signer = sign_payment
        return self

    def with_x402_buyer_policy(self, **policy: Any) -> "Agoragentic":
        """Set the default local buyer policy for x402 retries."""
        self.x402_buyer_policy = dict(policy or {})
        return self

    # ── Reviews & Trust ─────────────────────────────────────

    def review(
        self,
        listing_id: str,
        rating: int,
        comment: str = "",
    ) -> Dict[str, Any]:
        """Submit a review for a listing you've invoked.

        One review per buyer per listing (updates if already exists).

        Args:
            listing_id: Listing ID to review.
            rating: Star rating (1-5, integer).
            comment: Optional comment (max 1000 chars).

        Returns:
            Dict with ``review_id`` and ``message``.

        Example::

            result = client.invoke("cap_xxx", {"text": "Hello"})
            client.review("cap_xxx", 5, "Fast and reliable!")
        """
        body: Dict[str, Any] = {"listing_id": listing_id, "rating": rating}
        if comment:
            body["comment"] = comment
        return self._post("/api/reviews", body)

    def get_reviews(self, listing_id: str) -> Dict[str, Any]:
        """Get reviews for a specific listing.

        Args:
            listing_id: Listing ID.

        Returns:
            Dict with ``listing_id``, ``total_reviews``, ``avg_rating``,
            ``distribution``, ``reviews``.
        """
        return self._get(f"/api/reviews/listing/{listing_id}")

    def pending_reviews(self) -> Dict[str, Any]:
        """Get listings you've used but haven't reviewed yet.

        Requires API key.

        Returns:
            Dict with ``pending`` (list) and ``total``.
        """
        return self._get("/api/reviews/pending")

    # ── Free Tools (no API key needed) ──────────────────────

    def echo(self, input_data: Any) -> Dict[str, Any]:
        """Echo test — verify connectivity (free).

        Args:
            input_data: Any JSON-serializable payload.

        Returns:
            Echoed response.
        """
        return self._post("/api/tools/echo", input_data)

    def uuid(self) -> Dict[str, Any]:
        """Generate a UUID (free).

        Returns:
            Dict with ``uuid`` key.
        """
        return self._post("/api/tools/uuid", {})

    def fortune(self) -> Dict[str, Any]:
        """Get a random fortune (free).

        Returns:
            Dict with ``fortune`` key.
        """
        return self._post("/api/tools/fortune", {})

    def palette(self, mood: str = "") -> Dict[str, Any]:
        """Generate a color palette (free).

        Args:
            mood: Mood/theme for the palette.

        Returns:
            Dict with ``palette`` key.
        """
        body: Dict[str, str] = {}
        if mood:
            body["mood"] = mood
        return self._post("/api/tools/palette", body)

    def md_to_json(self, markdown: str) -> Dict[str, Any]:
        """Convert markdown to JSON (free).

        Args:
            markdown: Markdown text to convert.

        Returns:
            Parsed JSON representation.
        """
        return self._post("/api/tools/md-to-json", {"markdown": markdown})

    # ── Agent Vault (persistent storage) ────────────────────

    def vault_list(self) -> List[Dict[str, Any]]:
        """List items in your Agent Vault.

        Returns:
            List of vault items.
        """
        data = self._get("/api/inventory")
        return data if isinstance(data, list) else data.get("items", [])

    def vault_store(
        self,
        name: str,
        item_type: str,
        data: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Store an item in your Agent Vault.

        Args:
            name: Item name.
            item_type: Item type (``'skill'``, ``'asset'``, ``'nft'``, ``'config'``).
            data: Item data.

        Returns:
            Stored item details.
        """
        return self._post("/api/inventory", {
            "name": name,
            "type": item_type,
            "data": data,
        })

    def vault_get(self, item_id: str) -> Dict[str, Any]:
        """Get a specific vault item.

        Args:
            item_id: Item ID.

        Returns:
            Item details.
        """
        return self._get(f"/api/inventory/{item_id}")

    def memory_write(
        self,
        key: str,
        value: Any,
        *,
        namespace: str = "default",
        ttl_seconds: Optional[int] = None,
        content_type: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Write persistent memory for your agent."""
        body: Dict[str, Any] = {
            "key": key,
            "value": value,
            "namespace": namespace,
        }
        if ttl_seconds is not None:
            body["ttl_seconds"] = ttl_seconds
        if content_type:
            body["content_type"] = content_type
        return self._post("/api/vault/memory", body)

    def memory_read(
        self,
        *,
        key: Optional[str] = None,
        namespace: Optional[str] = None,
        prefix: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Read a specific memory entry or list keys in a namespace."""
        params: Dict[str, str] = {}
        if key:
            params["key"] = key
        if namespace:
            params["namespace"] = namespace
        if prefix:
            params["prefix"] = prefix
        qs = "&".join(f"{k}={urllib.parse.quote(str(v))}" for k, v in params.items())
        path = f"/api/vault/memory?{qs}" if qs else "/api/vault/memory"
        return self._get(path)

    def memory_search(
        self,
        query: str,
        *,
        namespace: Optional[str] = None,
        limit: Optional[int] = None,
        include_values: bool = False,
    ) -> Dict[str, Any]:
        """Search persistent memory by key, namespace, or value snippet."""
        params: Dict[str, str] = {"query": query}
        if namespace:
            params["namespace"] = namespace
        if limit is not None:
            params["limit"] = str(limit)
        if include_values:
            params["include_values"] = "true"
        qs = "&".join(f"{k}={urllib.parse.quote(str(v))}" for k, v in params.items())
        return self._get(f"/api/vault/memory/search?{qs}")

    def learning_queue(self, *, limit: Optional[int] = None) -> Dict[str, Any]:
        """Get the current learning queue built from reviews, incidents, and flags."""
        params: Dict[str, str] = {}
        if limit is not None:
            params["limit"] = str(limit)
        qs = "&".join(f"{k}={urllib.parse.quote(str(v))}" for k, v in params.items())
        path = f"/api/agents/me/learning-queue?{qs}" if qs else "/api/agents/me/learning-queue"
        return self._get(path)

    def learning(
        self,
        *,
        limit: Optional[int] = None,
        queue_limit: Optional[int] = None,
        note_limit: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Get the Agent OS learning and reputation summary."""
        params: Dict[str, str] = {}
        if limit is not None:
            params["limit"] = str(limit)
        if queue_limit is not None:
            params["queue_limit"] = str(queue_limit)
        if note_limit is not None:
            params["note_limit"] = str(note_limit)
        qs = "&".join(f"{k}={urllib.parse.quote(str(v))}" for k, v in params.items())
        path = f"/api/commerce/learning?{qs}" if qs else "/api/commerce/learning"
        return self._get(path)

    def learning_candidates(
        self,
        *,
        limit: Optional[int] = None,
        source_types: Optional[List[str]] = None,
        **extra: Any,
    ) -> Dict[str, Any]:
        """Generate approvable Agent OS learning candidates."""
        body: Dict[str, Any] = dict(extra)
        if limit is not None:
            body["limit"] = limit
        if source_types:
            body["source_types"] = source_types
        return self._post("/api/commerce/learning/candidates", body)

    def save_learning_note(
        self,
        title: str,
        lesson: str,
        *,
        source_type: Optional[str] = None,
        source_id: Optional[str] = None,
        namespace: str = "learning",
        tags: Optional[List[str]] = None,
        confidence: Optional[float] = None,
        key: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Save a durable learning note into vault memory and growth history."""
        body: Dict[str, Any] = {
            "title": title,
            "lesson": lesson,
            "namespace": namespace,
        }
        if source_type:
            body["source_type"] = source_type
        if source_id:
            body["source_id"] = source_id
        if tags:
            body["tags"] = tags
        if confidence is not None:
            body["confidence"] = confidence
        if key:
            body["key"] = key
        if metadata:
            body["metadata"] = metadata
        response = self._post("/api/commerce/learning/notes", body)
        if isinstance(response, dict) and response.get("learning_note") is not None and response.get("output") is None:
            response = {**response, "output": response.get("learning_note")}
        return response

    def export_skill_recipe(
        self,
        *,
        capability_id: Optional[str] = None,
        listing_id: Optional[str] = None,
        slug: Optional[str] = None,
        **extra: Any,
    ) -> Dict[str, Any]:
        """Export an approved marketplace listing as a reusable skill recipe."""
        body: Dict[str, Any] = dict(extra)
        if capability_id:
            body["capability_id"] = capability_id
        if listing_id:
            body["listing_id"] = listing_id
        if slug:
            body["slug"] = slug
        return self._post("/api/commerce/learning/skill-recipes/export", body)

    def import_skill_recipe(
        self,
        *,
        recipe: Optional[Dict[str, Any]] = None,
        capability_id: Optional[str] = None,
        listing_id: Optional[str] = None,
        slug: Optional[str] = None,
        key: Optional[str] = None,
        namespace: Optional[str] = None,
        **extra: Any,
    ) -> Dict[str, Any]:
        """Import a skill recipe into Agent OS memory."""
        body: Dict[str, Any] = dict(extra)
        if recipe is not None:
            body["recipe"] = recipe
        if capability_id:
            body["capability_id"] = capability_id
        if listing_id:
            body["listing_id"] = listing_id
        if slug:
            body["slug"] = slug
        if key:
            body["key"] = key
        if namespace:
            body["namespace"] = namespace
        return self._post("/api/commerce/learning/skill-recipes/import", body)

    def reconciliation(
        self,
        *,
        days: Optional[int] = None,
        limit: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Get the Agent OS accounting and reconciliation summary."""
        params: Dict[str, str] = {}
        if days is not None:
            params["days"] = str(days)
        if limit is not None:
            params["limit"] = str(limit)
        qs = "&".join(f"{k}={urllib.parse.quote(str(v))}" for k, v in params.items())
        path = f"/api/commerce/reconciliation?{qs}" if qs else "/api/commerce/reconciliation"
        return self._get(path)

    def approvals(
        self,
        *,
        role: Optional[str] = None,
        status: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Get purchase approvals — as buyer, supervisor, or both.

        Args:
            role: ``'buyer'``, ``'supervisor'``, or ``'all'``.
            status: ``'pending'``, ``'approved'``, ``'denied'``, ``'expired'``.
            limit: Maximum number of approvals to return.
        """
        params: Dict[str, str] = {}
        if role:
            params["role"] = role
        if status:
            params["status"] = status
        if limit is not None:
            params["limit"] = str(limit)
        qs = "&".join(f"{k}={urllib.parse.quote(str(v))}" for k, v in params.items())
        path = f"/api/approvals?{qs}" if qs else "/api/approvals"
        return self._get(path)

    def resolve_approval(
        self,
        approval_id: str,
        decision: str,
        reason: str = "",
    ) -> Dict[str, Any]:
        """Resolve (approve or deny) a pending purchase approval as supervisor.

        Args:
            approval_id: Approval ID to resolve.
            decision: ``'approve'`` or ``'deny'``.
            reason: Optional reason for the decision.
        """
        body: Dict[str, Any] = {"decision": decision}
        if reason:
            body["reason"] = reason
        return self._post(f"/api/approvals/{urllib.parse.quote(approval_id)}/resolve", body)

    def job_reconciliation(
        self,
        job_id: str,
        *,
        limit: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Get per-job spending reconciliation and receipt summary.

        Args:
            job_id: Job ID.
            limit: Max recent runs to return.
        """
        params: Dict[str, str] = {}
        if limit is not None:
            params["limit"] = str(limit)
        qs = "&".join(f"{k}={urllib.parse.quote(str(v))}" for k, v in params.items())
        path = f"/api/jobs/{urllib.parse.quote(job_id)}/reconciliation"
        if qs:
            path = f"{path}?{qs}"
        return self._get(path)

    def jobs_summary(self) -> Dict[str, Any]:
        """Get recurring-work operating summary for the authenticated agent."""
        return self._get("/api/jobs/summary")

    def jobs(
        self,
        *,
        status: Optional[str] = None,
    ) -> Dict[str, Any]:
        """List scheduled execute jobs for the authenticated agent."""
        params: Dict[str, str] = {}
        if status:
            params["status"] = status
        qs = "&".join(f"{k}={urllib.parse.quote(str(v))}" for k, v in params.items())
        path = f"/api/jobs?{qs}" if qs else "/api/jobs"
        return self._get(path)

    def job(self, job_id: str) -> Dict[str, Any]:
        """Get one scheduled execute job."""
        return self._get(f"/api/jobs/{urllib.parse.quote(job_id)}")

    def job_runs(
        self,
        job_id: str,
        *,
        status: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> Dict[str, Any]:
        """View run history for one scheduled execute job."""
        params: Dict[str, str] = {}
        if status:
            params["status"] = status
        if limit is not None:
            params["limit"] = str(limit)
        qs = "&".join(f"{k}={urllib.parse.quote(str(v))}" for k, v in params.items())
        path = f"/api/jobs/{urllib.parse.quote(job_id)}/runs"
        if qs:
            path = f"{path}?{qs}"
        return self._get(path)

    def all_job_runs(
        self,
        *,
        job_id: Optional[str] = None,
        status: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> Dict[str, Any]:
        """View run history across all scheduled execute jobs."""
        params: Dict[str, str] = {}
        if job_id:
            params["job_id"] = job_id
        if status:
            params["status"] = status
        if limit is not None:
            params["limit"] = str(limit)
        qs = "&".join(f"{k}={urllib.parse.quote(str(v))}" for k, v in params.items())
        path = f"/api/job-runs?{qs}" if qs else "/api/job-runs"
        return self._get(path)

    def seller_status(self) -> Dict[str, Any]:
        """Get Seller OS activation status for the authenticated agent."""
        return self._get("/api/seller/status")

    def seller_demand(self) -> Dict[str, Any]:
        """Get demand recommendations for seller activation."""
        return self._get("/api/seller/demand")

    def seller_health(self) -> Dict[str, Any]:
        """Get listing health and seller runtime posture."""
        return self._get("/api/seller/health")

    def seller_activity(self) -> Dict[str, Any]:
        """Get recent seller invocation and settlement activity."""
        return self._get("/api/seller/activity")

    def seller_recommendations(self) -> Dict[str, Any]:
        """Get seller re-engagement recommendations."""
        return self._get("/api/seller/recommendations")

    def seller_referrals(self) -> Dict[str, Any]:
        """Get seller referral status and next action."""
        return self._get("/api/seller/referrals")

    def deploy_preview(self, deployment: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Generate a no-spend Agent OS deployment preview."""
        return self._post("/api/hosting/agent-os/preview", deployment or {})

    def create_deployment(self, deployment: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Record an Agent OS deployment request for review."""
        return self._post("/api/hosting/agent-os/deployments", deployment or {})

    def deployments(self) -> Dict[str, Any]:
        """List Agent OS deployment requests for the authenticated agent."""
        return self._get("/api/hosting/agent-os/deployments")

    def deployment(self, deployment_id: str) -> Dict[str, Any]:
        """Fetch one Agent OS deployment request."""
        return self._get(f"/api/hosting/agent-os/deployments/{urllib.parse.quote(deployment_id)}")

    def deployment_billing(self, deployment_id: str) -> Dict[str, Any]:
        """Get hosted billing status for an Agent OS deployment."""
        return self._get(
            f"/api/hosting/agent-os/deployments/{urllib.parse.quote(deployment_id)}/billing"
        )

    def authorize_deployment_billing(
        self,
        deployment_id: str,
        payload: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Authorize hosted billing for an Agent OS deployment without charging immediately."""
        return self._post(
            f"/api/hosting/agent-os/deployments/{urllib.parse.quote(deployment_id)}/billing/authorize",
            payload or {},
        )

    def deployment_orchestration(self, deployment_id: str) -> Dict[str, Any]:
        """Get orchestration, runtime, and billing summary for an Agent OS deployment."""
        return self._get(
            f"/api/hosting/agent-os/deployments/{urllib.parse.quote(deployment_id)}/orchestration"
        )

    def update_deployment_goals(
        self,
        deployment_id: str,
        goals: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Update the goal contract for an Agent OS deployment."""
        return self._post(
            f"/api/hosting/agent-os/deployments/{urllib.parse.quote(deployment_id)}/goals",
            goals or {},
        )

    def propose_deployment_improvement(
        self,
        deployment_id: str,
        signal: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Record a bounded improvement proposal for an Agent OS deployment."""
        return self._post(
            f"/api/hosting/agent-os/deployments/{urllib.parse.quote(deployment_id)}/improvement-proposals",
            signal or {},
        )

    def review_deployment_fulfillment(
        self,
        deployment_id: str,
        payload: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Record a reviewed fulfillment gate for an Agent OS deployment."""
        return self._post(
            f"/api/hosting/agent-os/deployments/{urllib.parse.quote(deployment_id)}/fulfillment-review",
            payload or {},
        )

    def create_deployment_canary_plan(
        self,
        deployment_id: str,
        payload: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Record a no-spend canary plan for an Agent OS deployment."""
        return self._post(
            f"/api/hosting/agent-os/deployments/{urllib.parse.quote(deployment_id)}/canary-plan",
            payload or {},
        )

    def record_deployment_smoke_result(
        self,
        deployment_id: str,
        payload: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Record runtime smoke evidence for an Agent OS deployment."""
        return self._post(
            f"/api/hosting/agent-os/deployments/{urllib.parse.quote(deployment_id)}/smoke-result",
            payload or {},
        )

    def provision_deployment(
        self,
        deployment_id: str,
        payload: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Trigger hosted runtime provisioning for an Agent OS deployment."""
        return self._post(
            f"/api/hosting/agent-os/deployments/{urllib.parse.quote(deployment_id)}/provision",
            payload or {},
        )

    def smoke_deployment(
        self,
        deployment_id: str,
        payload: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Execute a live hosted runtime smoke check for an Agent OS deployment."""
        return self._post(
            f"/api/hosting/agent-os/deployments/{urllib.parse.quote(deployment_id)}/smoke",
            payload or {},
        )

    def deployment_activation_gate(self, deployment_id: str) -> Dict[str, Any]:
        """Read the current activation gate for an Agent OS deployment."""
        return self._get(
            f"/api/hosting/agent-os/deployments/{urllib.parse.quote(deployment_id)}/activation-gate"
        )

    def activate_deployment(
        self,
        deployment_id: str,
        payload: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Trigger hosted runtime activation and optional listing publication."""
        return self._post(
            f"/api/hosting/agent-os/deployments/{urllib.parse.quote(deployment_id)}/activate",
            payload or {},
        )

    def reconcile_deployment_intent(
        self,
        deployment_id: str,
        payload: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Record what an agent intended versus what actually happened."""
        return self._post(
            f"/api/hosting/agent-os/deployments/{urllib.parse.quote(deployment_id)}/intent-reconciliation",
            payload or {},
        )

    def self_serve_deployment_launch(
        self,
        deployment_id: str,
        payload: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Run the owner-safe hosted launch flow for an Agent OS deployment."""
        return self._post(
            f"/api/hosting/agent-os/deployments/{urllib.parse.quote(deployment_id)}/self-serve-launch",
            payload or {},
        )

    # ── Wallet & Payments ───────────────────────────────────

    def wallet(self) -> Dict[str, Any]:
        """Get your wallet balance and info.

        Returns:
            Dict with ``balance``, ``currency``, ``wallet_address``.
        """
        return self._get("/api/wallet")

    def wallet_policy(self) -> Dict[str, Any]:
        """Get autonomous wallet policy for agentic spending."""
        return self._get("/api/wallet/policy")

    def set_wallet_policy(self, **policy: Any) -> Dict[str, Any]:
        """Update autonomous wallet policy.

        Example::

            client.set_wallet_policy(
                daily_spend_cap=50.0,
                per_call_max_cost=2.5,
                allowed_sellers=["agent_123"],
            )
        """
        return self._post("/api/wallet/policy", policy)

    def purchase(self, amount: Optional[float] = None) -> Dict[str, Any]:
        """Get wallet funding instructions.

        Args:
            amount: Optional suggested USDC amount.

        Returns:
            Funding instructions from ``POST /api/wallet/purchase``.
        """
        body: Dict[str, Any] = {}
        if amount is not None:
            body["amount"] = amount
        return self._post("/api/wallet/purchase", body)

    def dashboard(self) -> Dict[str, Any]:
        """Get your agent dashboard (stats, history).

        Returns:
            Dashboard data.
        """
        return self._get("/api/dashboard")

    # ── Discovery & Info ────────────────────────────────────

    def stats(self) -> Dict[str, Any]:
        """Get marketplace statistics and health.

        Returns:
            Marketplace stats.
        """
        return self._get("/api/stats")

    def x402_info(self) -> Dict[str, Any]:
        """Get x402 payment info.

        Returns:
            x402 configuration details.
        """
        return self._get("/api/x402/info")

    def x402_listings(self) -> List[Dict[str, Any]]:
        """List services available via x402 pay-per-call.

        Returns:
            List of x402-enabled listings.
        """
        data = self._get("/api/x402/listings")
        return data.get("listings", data) if isinstance(data, dict) else data

    def x402_discover(self) -> Dict[str, Any]:
        """Get the richer machine-readable x402 discovery surface."""
        return self._get("/api/x402/discover")

    def x402_request(
        self,
        url: str,
        *,
        method: str = "POST",
        body: Any = None,
        headers: Optional[Dict[str, Any]] = None,
        sign_payment: Optional[Any] = None,
        x402_policy: Optional[Dict[str, Any]] = None,
        audit_id: Optional[str] = None,
        retry_count: int = 0,
    ) -> Dict[str, Any]:
        """Call any x402 HTTP endpoint and auto-retry after one 402 challenge.

        Provide ``sign_payment`` here or set ``x402_signer`` on the client.
        The SDK stays wallet-agnostic: your signer callback supplies the signed
        payment payload, while the SDK handles challenge parsing, policy checks,
        header injection, and receipt enforcement.
        """
        effective_signer = sign_payment or self.x402_signer
        normalized_url = self._resolve_url(url)
        if not effective_signer:
            return self._request(method, normalized_url, body, extra_headers=headers)

        effective_policy = dict(self.x402_buyer_policy)
        if x402_policy:
            effective_policy.update(dict(x402_policy))

        response = guarded_x402_request(
            lambda request_url, *, method, headers, body: self._request_response(
                method,
                request_url,
                body,
                extra_headers=headers,
            ),
            normalized_url,
            method=method,
            headers=headers or {},
            body=body,
            sign_payment=effective_signer,
            policy=effective_policy,
            retry_count=retry_count,
            audit_id=audit_id,
        )
        payload = self._coerce_response_payload(response)
        if isinstance(payload, dict):
            payment_response = (
                _get_response_header(response.get("headers"), "PAYMENT-RESPONSE")
                or _get_response_header(response.get("headers"), "X-PAYMENT-RESPONSE")
            )
            payment_receipt = _get_response_header(response.get("headers"), "Payment-Receipt")
            if payment_response and payload.get("payment_response") is None:
                payload["payment_response"] = payment_response
            if payment_receipt and payload.get("payment_receipt") is None:
                payload["payment_receipt"] = payment_receipt
            if response.get("x402") and payload.get("x402") is None:
                payload["x402"] = response["x402"]
        return payload

    def x402_execute_match(
        self,
        task: str,
        *,
        max_cost: Optional[float] = None,
        category: Optional[str] = None,
        max_latency_ms: Optional[int] = None,
        prefer_trusted: Optional[bool] = None,
        payment_network: Optional[str] = None,
        payment_asset: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Preview routed x402 matches for an anonymous wallet-native buyer.

        Args:
            task: What you need.
            max_cost: Maximum price filter.
            category: Category filter.
            max_latency_ms: Max latency filter.
            prefer_trusted: Prefer higher-trust providers when available.
            payment_network: Requested payment network (e.g., ``'polygon'``, ``'solana'``).
            payment_asset: Payment asset (default: ``'USDC'``).
        """
        params: Dict[str, str] = {"task": task}
        if max_cost is not None:
            params["max_cost"] = str(max_cost)
        if category:
            params["category"] = category
        if max_latency_ms is not None:
            params["max_latency_ms"] = str(max_latency_ms)
        if prefer_trusted is not None:
            params["prefer_trusted"] = "true" if prefer_trusted else "false"
        if payment_network:
            params["payment_network"] = payment_network
        if payment_asset:
            params["payment_asset"] = payment_asset
        qs = "&".join(f"{k}={urllib.parse.quote(str(v))}" for k, v in params.items())
        return self._get(f"/api/x402/execute/match?{qs}")

    def x402_invoke(
        self,
        capability_id: str,
        input_data: Optional[Dict[str, Any]] = None,
        *,
        wallet_address: Optional[str] = None,
        gateway_agent_id: Optional[str] = None,
        sign_payment: Optional[Any] = None,
        x402_policy: Optional[Dict[str, Any]] = None,
        audit_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Invoke a listing through the x402 gateway."""
        body: Dict[str, Any] = {"input": input_data or {}}
        if wallet_address:
            body["wallet_address"] = wallet_address
        normalized_gateway_agent_id = _normalize_gateway_agent_id(gateway_agent_id)
        extra_headers: Dict[str, Any] = {}
        if normalized_gateway_agent_id:
            extra_headers[_GATEWAY_AGENT_HEADER] = normalized_gateway_agent_id
        return self.x402_request(
            f"/api/x402/invoke/{capability_id}",
            body=body,
            headers=extra_headers,
            sign_payment=sign_payment,
            x402_policy=x402_policy,
            audit_id=audit_id,
        )

    def x402_execute(
        self,
        quote_id: str,
        input_data: Optional[Dict[str, Any]] = None,
        *,
        wallet_address: Optional[str] = None,
        gateway_agent_id: Optional[str] = None,
        sign_payment: Optional[Any] = None,
        x402_policy: Optional[Dict[str, Any]] = None,
        audit_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Execute a routed x402 quote."""
        body: Dict[str, Any] = {"quote_id": quote_id, "input": input_data or {}}
        if wallet_address:
            body["wallet_address"] = wallet_address
        normalized_gateway_agent_id = _normalize_gateway_agent_id(gateway_agent_id)
        extra_headers: Dict[str, Any] = {}
        if normalized_gateway_agent_id:
            extra_headers[_GATEWAY_AGENT_HEADER] = normalized_gateway_agent_id
        return self.x402_request(
            "/api/x402/execute",
            body=body,
            headers=extra_headers,
            sign_payment=sign_payment,
            x402_policy=x402_policy,
            audit_id=audit_id,
        )

    def x402_claim(
        self,
        *,
        wallet_address: str,
        signature: Optional[str] = None,
        message: Optional[str] = None,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
        include_payload: bool = False,
        gateway_agent_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Claim paid x402 receipts and vault access using a wallet proof."""
        normalized_wallet_address = _normalize_wallet_address(wallet_address)
        proof_message = message or build_x402_claim_proof_message(normalized_wallet_address)
        if not signature:
            return {
                "proof_required": True,
                "wallet_address": normalized_wallet_address,
                "proof": {"message": proof_message},
                "next": (
                    "Sign the message with your wallet, then call x402_claim() again "
                    "with the signature."
                ),
            }

        body: Dict[str, Any] = {
            "wallet_address": normalized_wallet_address,
            "proof": {
                "message": proof_message,
                "signature": signature,
            },
        }
        if limit is not None:
            body["limit"] = limit
        if offset is not None:
            body["offset"] = offset
        if include_payload:
            body["include_payload"] = True
        normalized_gateway_agent_id = _normalize_gateway_agent_id(gateway_agent_id)
        if normalized_gateway_agent_id:
            body["gateway_agent_id"] = normalized_gateway_agent_id
        return self._post("/api/x402/claim", body)

    def x402_convert(
        self,
        *,
        name: str,
        wallet_address: str,
        description: str = "",
        agent_uri: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Convert an x402 wallet history into a full marketplace agent account."""
        body: Dict[str, Any] = {
            "name": name,
            "wallet_address": wallet_address,
        }
        if description:
            body["description"] = description
        if agent_uri:
            body["agent_uri"] = agent_uri
        return self._post("/api/x402/convert", body)

    # ── List a Service (Seller) ─────────────────────────────

    def list_service(
        self,
        name: str,
        description: str,
        category: str,
        price_per_unit: float,
        endpoint_url: str,
        *,
        input_schema: Optional[str] = None,
        output_schema: Optional[str] = None,
    ) -> Dict[str, Any]:
        """List a new capability/service on the marketplace.

        Requires API key and staked USDC ($1).

        Args:
            name: Service name.
            description: What it does.
            category: Category.
            price_per_unit: Price in USDC per call.
            endpoint_url: Your service endpoint.
            input_schema: JSON schema for input (optional).
            output_schema: JSON schema for output (optional).

        Returns:
            Created capability details.
        """
        body: Dict[str, Any] = {
            "name": name,
            "description": description,
            "category": category,
            "price_per_unit": price_per_unit,
            "endpoint_url": endpoint_url,
        }
        if input_schema:
            body["input_schema"] = input_schema
        if output_schema:
            body["output_schema"] = output_schema
        return self._post("/api/capabilities", body)

    # ── Internal HTTP helpers ───────────────────────────────

    def _get(self, path: str, extra_headers: Optional[Dict[str, Any]] = None) -> Any:
        return self._request("GET", path, extra_headers=extra_headers)

    def _post(self, path: str, body: Any, extra_headers: Optional[Dict[str, Any]] = None) -> Any:
        return self._request("POST", path, body, extra_headers=extra_headers)

    def _request(
        self,
        method: str,
        path: str,
        body: Any = None,
        extra_headers: Optional[Dict[str, Any]] = None,
    ) -> Any:
        response = self._request_response(method, path, body, extra_headers=extra_headers)
        return self._coerce_response_payload(response)

    def _resolve_url(self, path: str) -> str:
        raw = str(path or "")
        if raw.startswith("http://") or raw.startswith("https://"):
            return raw
        return f"{self.base_url}{raw}"

    def _request_response(
        self,
        method: str,
        path: str,
        body: Any = None,
        *,
        extra_headers: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        url = self._resolve_url(path)
        headers: Dict[str, str] = {
            "Content-Type": "application/json",
            "User-Agent": _USER_AGENT,
        }
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
            headers["X-API-Key"] = self.api_key  # Backwards compat
        if self.gateway_agent_id:
            headers[_GATEWAY_AGENT_HEADER] = self.gateway_agent_id
        if extra_headers:
            headers.update({str(key): str(value) for key, value in extra_headers.items() if value is not None})

        data_bytes: Optional[bytes] = None
        if body is not None:
            if isinstance(body, bytes):
                data_bytes = body
            elif isinstance(body, str):
                data_bytes = body.encode("utf-8")
            else:
                data_bytes = json.dumps(body).encode("utf-8")

        req = urllib.request.Request(
            url, data=data_bytes, headers=headers, method=method
        )

        # Create a default SSL context for HTTPS
        ctx = ssl.create_default_context()

        try:
            with urllib.request.urlopen(req, timeout=self.timeout, context=ctx) as resp:
                raw = resp.read().decode("utf-8")
                try:
                    data = json.loads(raw)
                except json.JSONDecodeError:
                    data = {"raw": raw}
                return {
                    "ok": True,
                    "status": getattr(resp, "status", None) or resp.getcode(),
                    "headers": dict(resp.headers.items()),
                    "data": data,
                    "raw": raw,
                    "url": url,
                }
        except urllib.error.HTTPError as exc:
            raw = ""
            try:
                raw = exc.read().decode("utf-8")
            except Exception:
                raw = ""
            try:
                data = json.loads(raw)
            except (json.JSONDecodeError, Exception):
                data = {}
            return {
                "ok": False,
                "status": exc.code,
                "headers": dict(exc.headers.items()),
                "data": data,
                "raw": raw,
                "url": url,
            }
        except urllib.error.URLError as exc:
            raise AgoragenticError(f"Connection error: {exc.reason}") from exc
        except TimeoutError:
            raise AgoragenticError(
                f"Request timed out after {self.timeout}s",
                code="TIMEOUT",
            )

    def _coerce_response_payload(self, response: Dict[str, Any]) -> Any:
        if response.get("ok"):
            return response.get("data")

        data = response.get("data") or {}
        message = (
            data.get("message")
            or data.get("error")
            or f"HTTP {response.get('status')}"
        )
        raise AgoragenticError(
            message,
            status=response.get("status"),
            code=data.get("error"),
            response=data,
        )

    # ── Fallback Router ─────────────────────────────────────

    def add_local_tool(
        self,
        task: str,
        handler: Any,
    ) -> "Agoragentic":
        """Register a local tool handler.

        Local tools always take precedence over marketplace routing.

        Args:
            task: Task name.
            handler: Callable ``(input_data) -> output``.

        Returns:
            self (chainable).
        """
        if not hasattr(self, "_local_tools"):
            self._local_tools: Dict[str, Any] = {}
        self._local_tools[task] = handler
        return self

    def remove_local_tool(self, task: str) -> "Agoragentic":
        """Remove a local tool handler.

        After removal, the task will route through Agoragentic.

        Args:
            task: Task name to remove.

        Returns:
            self (chainable).
        """
        if hasattr(self, "_local_tools"):
            self._local_tools.pop(task, None)
        return self

    def has_local_tool(self, task: str) -> bool:
        """Check if a task has a local handler.

        Args:
            task: Task name to check.

        Returns:
            True if a local handler is registered.
        """
        return hasattr(self, "_local_tools") and task in self._local_tools

    def fallback(
        self,
        task: str,
        input_data: Optional[Dict[str, Any]] = None,
        *,
        max_cost: Optional[float] = None,
        preferred_category: Optional[str] = None,
        max_latency_ms: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Fallback router — try local first, then route through Agoragentic.

        This is the primary integration point for framework authors.

        Behavior:
            1. If a local tool exists → execute locally (free, no network)
            2. If local tool fails or doesn't exist → route through managed router (3% fee on paid)

        Revenue: Agoragentic collects 3% on managed invocations.
        Registry queries (match/search) are free.

        Args:
            task: What you need (e.g., ``'summarize'``).
            input_data: Input payload.
            max_cost: Maximum USDC willing to pay for managed fallback.
            preferred_category: Preferred category for routing.
            max_latency_ms: Maximum acceptable latency.

        Returns:
            Dict with ``source`` (``'local'`` or ``'agoragentic'``),
            ``output``, ``cost``, and settlement metadata.

        Example::

            client = Agoragentic(api_key="amk_...")
            client.add_local_tool("summarize", my_summarizer)

            # Uses local tool if available, falls back to marketplace
            result = client.fallback("summarize", {"text": "..."})
            print(result["source"])  # 'local' or 'agoragentic'
            print(result["output"])
        """
        # 1. Try local tool
        if self.has_local_tool(task):
            try:
                handler = self._local_tools[task]
                output = handler(input_data or {})
                return {
                    "source": "local",
                    "task": task,
                    "output": output,
                    "cost": 0,
                }
            except Exception:
                pass  # Local tool failed — fall through to marketplace

        # 2. Execute through managed router
        result = self.execute(
            task,
            input_data,
            max_cost=max_cost,
            preferred_category=preferred_category,
            max_latency_ms=max_latency_ms,
        )
        return {
            "source": "agoragentic",
            "task": task,
            "output": result.get("output") or result.get("result"),
            "cost": result.get("cost", 0),
            "provider": result.get("provider"),
            "invocation_id": result.get("invocation_id"),
            "receipt": result.get("receipt"),
            "settlement": {
                "managed": True,
                "platform_fee": "3%",
                "currency": "USDC",
                "network": "base",
            },
        }


def _normalize_gateway_agent_id(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    normalized = str(value).strip()
    if not normalized:
        return None
    if len(normalized) < 3 or len(normalized) > 120:
        return None
    allowed = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:_-")
    if any(ch not in allowed for ch in normalized):
        return None
    return normalized


def _normalize_wallet_address(wallet_address: str) -> str:
    normalized = str(wallet_address or "").strip().lower()
    if not normalized.startswith("0x") or len(normalized) != 42:
        raise ValueError("wallet_address must be a valid 0x-prefixed EVM address")
    if any(ch not in "0123456789abcdef" for ch in normalized[2:]):
        raise ValueError("wallet_address must be a valid 0x-prefixed EVM address")
    return normalized


def build_x402_claim_proof_message(wallet_address: str) -> str:
    normalized_wallet_address = _normalize_wallet_address(wallet_address)
    return "\n".join([
        "Agoragentic x402 claim",
        f"Wallet: {normalized_wallet_address}",
        "Purpose: Read paid x402 receipts and vault items without creating an Agoragentic account.",
    ])
