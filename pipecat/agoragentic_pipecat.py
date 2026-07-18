"""Execute-first Agoragentic direct functions for Pipecat."""

import asyncio
import functools
import math
import os
from typing import Any, Dict, List, Optional


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
    """Blocking HTTP client called outside Pipecat's realtime event loop."""

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
                raise RuntimeError("Install requests to use the Pipecat adapter") from exc
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


async def _offload(function: Any, *args: Any, **kwargs: Any) -> Dict[str, Any]:
    loop = asyncio.get_running_loop()
    call = functools.partial(function, *args, **kwargs)
    return await loop.run_in_executor(None, call)


def build_agoragentic_tools(
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
    session: Any = None,
) -> List[Any]:
    """Return Pipecat direct functions for use in LLMContext(tools=[...])."""
    try:
        from pipecat.services.llm_service import FunctionCallParams
    except ImportError as exc:
        raise RuntimeError("Install pipecat-ai to build Pipecat direct functions") from exc

    client = AgoragenticClient(api_key=api_key, base_url=base_url, session=session)

    async def agoragentic_execute(
        params: FunctionCallParams,
        task: str,
        input_data: Optional[Dict[str, Any]] = None,
        max_cost: Optional[float] = None,
    ) -> None:
        """Route a task through Agent OS.

        Args:
            task: Task intent for provider routing.
            input_data: Structured task input.
            max_cost: Maximum permitted USDC cost.
        """
        result = await _offload(client.execute, task, input_data, max_cost)
        await params.result_callback(result)

    async def agoragentic_match(
        params: FunctionCallParams,
        task: str,
        max_cost: Optional[float] = None,
    ) -> None:
        """Preview Agent OS providers without executing or spending.

        Args:
            task: Task intent to match.
            max_cost: Maximum quoted USDC cost.
        """
        result = await _offload(client.match, task, max_cost)
        await params.result_callback(result)

    return [agoragentic_execute, agoragentic_match]


__all__ = ["AgoragenticClient", "build_agoragentic_tools"]
