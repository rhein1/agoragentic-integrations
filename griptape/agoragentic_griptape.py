"""Execute-first Agoragentic activities for Griptape agents and workflows."""

import math
import os
from typing import Any, Dict, Optional

from griptape.tools import BaseTool
from griptape.utils.decorators import activity
from schema import Optional as SchemaOptional
from schema import Or, Schema


DEFAULT_BASE_URL = "https://agoragentic.com"
RETRYABLE_STATUSES = {408, 425, 429, 500, 502, 503, 504}


def _validation_error(message: str) -> Dict[str, Any]:
    return {
        "ok": False,
        "error": {"code": "invalid_input", "message": message},
        "retryable": False,
    }


def _valid_max_cost(value: Optional[float]) -> bool:
    if value is None:
        return True
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return value >= 0
    return isinstance(value, float) and math.isfinite(value) and value >= 0


class AgoragenticClient:
    """HTTP client shared by the Griptape activity methods."""

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        session: Any = None,
    ) -> None:
        self.api_key = os.getenv("AGORAGENTIC_API_KEY", "") if api_key is None else api_key
        self.base_url = (base_url or os.getenv("AGORAGENTIC_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")
        if session is None:
            try:
                import requests
            except ImportError as exc:
                raise RuntimeError("Install requests to use the Griptape adapter") from exc
            session = requests.Session()
        self.session = session

    def _headers(self) -> Dict[str, str]:
        headers = {"Accept": "application/json", "Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    def _request(self, method: str, path: str, timeout: int, **kwargs: Any) -> Dict[str, Any]:
        try:
            response = self.session.request(
                method,
                f"{self.base_url}{path}",
                headers=self._headers(),
                timeout=timeout,
                **kwargs,
            )
        except Exception as exc:
            return {
                "ok": False,
                "error": {"code": "network_error", "message": str(exc)[:500]},
                "retryable": True,
            }

        status_code = int(getattr(response, "status_code", 0))
        try:
            payload = response.json()
        except (TypeError, ValueError):
            text = str(getattr(response, "text", ""))[:500]
            payload = {"message": text or "Non-JSON response"}

        if 200 <= status_code < 300:
            return payload if isinstance(payload, dict) else {"result": payload}

        if isinstance(payload, dict):
            raw_error = payload.get("error")
            if isinstance(raw_error, dict):
                message = raw_error.get("message") or raw_error.get("code")
            else:
                message = raw_error or payload.get("message")
        else:
            message = None
        result: Dict[str, Any] = {
            "ok": False,
            "error": {"code": "http_error", "message": str(message or f"HTTP {status_code}")[:500]},
            "status_code": status_code,
            "retryable": status_code in RETRYABLE_STATUSES,
        }
        retry_after = getattr(response, "headers", {}).get("Retry-After")
        if retry_after:
            result["retry_after"] = retry_after
        return result

    def execute(
        self,
        task: str,
        input_data: Optional[Dict[str, Any]] = None,
        max_cost: Optional[float] = None,
    ) -> Dict[str, Any]:
        if not isinstance(task, str) or not task.strip():
            return _validation_error("task must be a non-empty string")
        if input_data is not None and not isinstance(input_data, dict):
            return _validation_error("input_data must be an object")
        if not _valid_max_cost(max_cost):
            return _validation_error("max_cost must be a non-negative number")

        constraints: Dict[str, Any] = {}
        if max_cost is not None:
            constraints["max_cost"] = max_cost
        return self._request(
            "POST",
            "/api/execute",
            timeout=90,
            json={"task": task.strip(), "input": input_data or {}, "constraints": constraints},
        )

    def match(self, task: str, max_cost: Optional[float] = None) -> Dict[str, Any]:
        if not isinstance(task, str) or not task.strip():
            return _validation_error("task must be a non-empty string")
        if not _valid_max_cost(max_cost):
            return _validation_error("max_cost must be a non-negative number")

        params: Dict[str, Any] = {"task": task.strip()}
        if max_cost is not None:
            params["max_cost"] = max_cost
        return self._request("GET", "/api/execute/match", timeout=30, params=params)


class AgoragenticTool(BaseTool):
    """Griptape tool with execute-first Agent OS activities."""

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        session: Any = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        self._client = AgoragenticClient(api_key=api_key, base_url=base_url, session=session)

    @activity(
        config={
            "description": "Route a task through Agent OS. May call a paid listing; max_cost sets the USDC ceiling.",
            "schema": Schema(
                {
                    "task": str,
                    SchemaOptional("input_data", default={}): dict,
                    SchemaOptional("max_cost"): Or(int, float),
                }
            ),
        }
    )
    def agoragentic_execute(self, *, values: Dict[str, Any]) -> Dict[str, Any]:
        """Execute a routed capability call and return receipt-backed evidence."""
        return self._client.execute(
            values.get("task", ""),
            values.get("input_data"),
            values.get("max_cost"),
        )

    @activity(
        config={
            "description": "Preview Agent OS providers, prices, and trust signals without executing or spending.",
            "schema": Schema(
                {
                    "task": str,
                    SchemaOptional("max_cost"): Or(int, float),
                }
            ),
        }
    )
    def agoragentic_match(self, *, values: Dict[str, Any]) -> Dict[str, Any]:
        """Preview routed providers without spending."""
        return self._client.match(values.get("task", ""), values.get("max_cost"))


__all__ = ["AgoragenticClient", "AgoragenticTool"]
