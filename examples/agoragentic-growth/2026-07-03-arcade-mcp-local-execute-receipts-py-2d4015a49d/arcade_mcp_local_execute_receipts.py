#!/usr/bin/env python3
"""
ArcadeAI arcade-mcp local execute() adapter with error handling and simulated usage receipts.

This module wraps locally registered tool callables behind a single execute() entrypoint,
produces JSONL usage receipts for every attempt, and can optionally expose the wrapper as
an Arcade MCP tool when arcade_mcp_server is installed.

The usage receipts in this file are simulated local records; they do not represent payment
settlement, on-chain state, or marketplace verification.

Run:
    python3 arcade_mcp_local_execute_receipts.py --self-test
    python3 arcade_mcp_local_execute_receipts.py --demo
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import inspect
import json
import os
import sys
import tempfile
import traceback
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, Mapping, Optional
from uuid import uuid4

try:
    from arcade_mcp_server import MCPApp
except Exception:  # pragma: no cover - optional dependency
    MCPApp = None  # type: ignore[assignment]

JsonDict = Dict[str, Any]
ToolCallable = Callable[..., Any]
DEFAULT_RECEIPT_LOG_PATH = Path(os.environ.get("ARCADE_MCP_USAGE_LOG_PATH", ".arcade-mcp-usage.jsonl"))
DEFAULT_RECEIPT_NAMESPACE = os.environ.get("ARCADE_MCP_USAGE_NAMESPACE", "arcade-mcp-local")


class ArcadeExecuteError(RuntimeError):
    """Raised when local execute() fails in a structured way."""

    def __init__(
        self,
        message: str,
        *,
        code: str,
        retryable: bool = False,
        details: Optional[Mapping[str, Any]] = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable
        self.details = dict(details or {})

    def to_dict(self) -> JsonDict:
        return {
            "message": str(self),
            "code": self.code,
            "retryable": self.retryable,
            "details": self.details,
        }


@dataclass
class UsageReceipt:
    receipt_id: str
    request_id: str
    namespace: str
    tool_name: str
    status: str
    started_at: str
    finished_at: str
    duration_ms: int
    input_sha256: str
    output_sha256: Optional[str]
    error_code: Optional[str]
    simulated: bool
    usage_units: int
    usage_cost_units: int
    receipt_signature: str
    metadata: JsonDict


@dataclass
class ExecuteResult:
    ok: bool
    tool_name: str
    request_id: str
    status: str
    output: Any
    receipt: JsonDict
    error: Optional[JsonDict]


@dataclass(frozen=True)
class LocalArcadeContext:
    """Small simulated context for local tools that expect Arcade-injected context."""

    request_id: str
    namespace: str
    metadata: JsonDict
    simulated: bool = True


class ArcadeLocalExecuteAdapter:
    """Standalone local execute() wrapper for Arcade-style MCP tools."""

    def __init__(
        self,
        tools: Optional[Mapping[str, ToolCallable]] = None,
        *,
        usage_log_path: Path | str = DEFAULT_RECEIPT_LOG_PATH,
        receipt_namespace: str = DEFAULT_RECEIPT_NAMESPACE,
        receipt_secret: Optional[str] = None,
    ) -> None:
        self.tools: Dict[str, ToolCallable] = dict(tools or {})
        self.usage_log_path = Path(usage_log_path)
        self.receipt_namespace = receipt_namespace
        self.receipt_secret = receipt_secret or os.environ.get("ARCADE_MCP_RECEIPT_SECRET", "demo-local-receipt-secret")

    def register_tool(self, name: Optional[str] = None, func: Optional[ToolCallable] = None):
        """Register a tool by name or as a decorator."""
        if callable(name) and func is None:
            func = name
            self.tools[func.__name__] = func
            return func

        if func is not None:
            self.tools[name or func.__name__] = func
            return func

        def decorator(inner: ToolCallable) -> ToolCallable:
            self.tools[name or inner.__name__] = inner
            return inner

        return decorator

    def list_tools(self) -> list[str]:
        return sorted(self.tools)

    def execute(
        self,
        tool_name: str,
        arguments: Optional[Mapping[str, Any]] = None,
        *,
        request_id: Optional[str] = None,
        metadata: Optional[Mapping[str, Any]] = None,
    ) -> ExecuteResult:
        started = _utcnow()
        request_id = request_id or f"arcade_exec_{uuid4().hex}"
        safe_arguments = dict(arguments or {})
        safe_metadata = dict(metadata or {})
        input_fingerprint = _stable_sha256({"tool_name": tool_name, "arguments": safe_arguments, "metadata": safe_metadata})

        if not tool_name or not str(tool_name).strip():
            error = ArcadeExecuteError("tool_name is required", code="invalid_request", retryable=False)
            return self._finalize_failure(
                tool_name=str(tool_name or ""),
                request_id=request_id,
                started=started,
                arguments=safe_arguments,
                metadata=safe_metadata,
                input_fingerprint=input_fingerprint,
                error=error,
            )

        tool = self.tools.get(tool_name)
        if tool is None:
            error = ArcadeExecuteError(
                f"tool not found: {tool_name}",
                code="tool_not_found",
                retryable=False,
                details={"available_tools": self.list_tools()},
            )
            return self._finalize_failure(
                tool_name=tool_name,
                request_id=request_id,
                started=started,
                arguments=safe_arguments,
                metadata=safe_metadata,
                input_fingerprint=input_fingerprint,
                error=error,
            )

        try:
            bound_arguments = self._bind_arguments(
                tool,
                safe_arguments,
                request_id=request_id,
                metadata=safe_metadata,
                receipt_namespace=self.receipt_namespace,
            )
        except TypeError as exc:
            error = ArcadeExecuteError(
                f"invalid arguments for {tool_name}: {exc}",
                code="invalid_arguments",
                retryable=False,
                details={"traceback": traceback.format_exc(limit=1)},
            )
            return self._finalize_failure(
                tool_name=tool_name,
                request_id=request_id,
                started=started,
                arguments=safe_arguments,
                metadata=safe_metadata,
                input_fingerprint=input_fingerprint,
                error=error,
            )

        try:
            output = tool(*bound_arguments[0], **bound_arguments[1])
            if inspect.isawaitable(output):
                output = self._await_sync(output)
        except ArcadeExecuteError as exc:
            return self._finalize_failure(
                tool_name=tool_name,
                request_id=request_id,
                started=started,
                arguments=safe_arguments,
                metadata=safe_metadata,
                input_fingerprint=input_fingerprint,
                error=exc,
            )
        except Exception as exc:  # pragma: no cover - exercised by self-test via boom tool
            error = ArcadeExecuteError(
                f"tool execution failed: {exc}",
                code="tool_execution_failed",
                retryable=False,
                details={"traceback": traceback.format_exc(limit=8)},
            )
            return self._finalize_failure(
                tool_name=tool_name,
                request_id=request_id,
                started=started,
                arguments=safe_arguments,
                metadata=safe_metadata,
                input_fingerprint=input_fingerprint,
                error=error,
            )

        return self._finalize_success(
            tool_name=tool_name,
            request_id=request_id,
            started=started,
            arguments=safe_arguments,
            metadata=safe_metadata,
            input_fingerprint=input_fingerprint,
            output=output,
        )

    async def execute_async(
        self,
        tool_name: str,
        arguments: Optional[Mapping[str, Any]] = None,
        *,
        request_id: Optional[str] = None,
        metadata: Optional[Mapping[str, Any]] = None,
    ) -> ExecuteResult:
        started = _utcnow()
        request_id = request_id or f"arcade_exec_{uuid4().hex}"
        safe_arguments = dict(arguments or {})
        safe_metadata = dict(metadata or {})
        input_fingerprint = _stable_sha256({"tool_name": tool_name, "arguments": safe_arguments, "metadata": safe_metadata})

        if not tool_name or not str(tool_name).strip():
            error = ArcadeExecuteError("tool_name is required", code="invalid_request", retryable=False)
            return self._finalize_failure(
                tool_name=str(tool_name or ""),
                request_id=request_id,
                started=started,
                arguments=safe_arguments,
                metadata=safe_metadata,
                input_fingerprint=input_fingerprint,
                error=error,
            )

        tool = self.tools.get(tool_name)
        if tool is None:
            error = ArcadeExecuteError(
                f"tool not found: {tool_name}",
                code="tool_not_found",
                retryable=False,
                details={"available_tools": self.list_tools()},
            )
            return self._finalize_failure(
                tool_name=tool_name,
                request_id=request_id,
                started=started,
                arguments=safe_arguments,
                metadata=safe_metadata,
                input_fingerprint=input_fingerprint,
                error=error,
            )

        try:
            bound_arguments = self._bind_arguments(
                tool,
                safe_arguments,
                request_id=request_id,
                metadata=safe_metadata,
                receipt_namespace=self.receipt_namespace,
            )
        except TypeError as exc:
            error = ArcadeExecuteError(
                f"invalid arguments for {tool_name}: {exc}",
                code="invalid_arguments",
                retryable=False,
                details={"traceback": traceback.format_exc(limit=1)},
            )
            return self._finalize_failure(
                tool_name=tool_name,
                request_id=request_id,
                started=started,
                arguments=safe_arguments,
                metadata=safe_metadata,
                input_fingerprint=input_fingerprint,
                error=error,
            )

        try:
            output = tool(*bound_arguments[0], **bound_arguments[1])
            if inspect.isawaitable(output):
                output = await output
        except ArcadeExecuteError as exc:
            return self._finalize_failure(
                tool_name=tool_name,
                request_id=request_id,
                started=started,
                arguments=safe_arguments,
                metadata=safe_metadata,
                input_fingerprint=input_fingerprint,
                error=exc,
            )
        except Exception as exc:  # pragma: no cover - mirrors sync failure handling
            error = ArcadeExecuteError(
                f"tool execution failed: {exc}",
                code="tool_execution_failed",
                retryable=False,
                details={"traceback": traceback.format_exc(limit=8)},
            )
            return self._finalize_failure(
                tool_name=tool_name,
                request_id=request_id,
                started=started,
                arguments=safe_arguments,
                metadata=safe_metadata,
                input_fingerprint=input_fingerprint,
                error=error,
            )

        return self._finalize_success(
            tool_name=tool_name,
            request_id=request_id,
            started=started,
            arguments=safe_arguments,
            metadata=safe_metadata,
            input_fingerprint=input_fingerprint,
            output=output,
        )

    def _finalize_success(
        self,
        *,
        tool_name: str,
        request_id: str,
        started: datetime,
        arguments: Mapping[str, Any],
        metadata: Mapping[str, Any],
        input_fingerprint: str,
        output: Any,
    ) -> ExecuteResult:
        finished = _utcnow()
        output_fingerprint = _stable_sha256(output)
        receipt = self._build_receipt(
            tool_name=tool_name,
            request_id=request_id,
            started=started,
            finished=finished,
            input_fingerprint=input_fingerprint,
            output_fingerprint=output_fingerprint,
            error_code=None,
            arguments=arguments,
            output=output,
            metadata=metadata,
            status="completed",
        )
        self._append_usage_receipt(receipt)
        return ExecuteResult(
            ok=True,
            tool_name=tool_name,
            request_id=request_id,
            status="completed",
            output=output,
            receipt=asdict(receipt),
            error=None,
        )

    async def execute_async_tool(self, tool_name: str, arguments: Optional[Mapping[str, Any]] = None) -> JsonDict:
        result = await self.execute_async(tool_name=tool_name, arguments=arguments or {})
        return {
            "ok": result.ok,
            "tool_name": result.tool_name,
            "request_id": result.request_id,
            "status": result.status,
            "output": result.output,
            "receipt": result.receipt,
            "error": result.error,
        }

    def build_arcade_tool(self) -> ToolCallable:
        """Return a single tool function suitable for MCPApp.tool(...)."""

        def local_execute(tool_name: str, arguments: Optional[Mapping[str, Any]] = None) -> JsonDict:
            result = self.execute(tool_name=tool_name, arguments=arguments or {})
            return {
                "ok": result.ok,
                "tool_name": result.tool_name,
                "request_id": result.request_id,
                "status": result.status,
                "output": result.output,
                "receipt": result.receipt,
                "error": result.error,
            }

        local_execute.__name__ = "execute"
        local_execute.__doc__ = "Execute a locally registered Arcade MCP tool and emit a simulated usage receipt."
        return local_execute

    def create_mcp_app(self, name: str = "arcade_local_execute", version: str = "0.1.0"):
        """Create an MCP app if arcade_mcp_server is installed."""
        if MCPApp is None:
            raise RuntimeError("Install arcade-mcp-server to expose this adapter as an MCP app")
        app = MCPApp(name=name, version=version)
        app.tool(self.build_arcade_tool())
        return app

    def _finalize_failure(
        self,
        *,
        tool_name: str,
        request_id: str,
        started: datetime,
        arguments: Mapping[str, Any],
        metadata: Mapping[str, Any],
        input_fingerprint: str,
        error: ArcadeExecuteError,
    ) -> ExecuteResult:
        finished = _utcnow()
        receipt = self._build_receipt(
            tool_name=tool_name,
            request_id=request_id,
            started=started,
            finished=finished,
            input_fingerprint=input_fingerprint,
            output_fingerprint=None,
            error_code=error.code,
            arguments=arguments,
            output=None,
            metadata={**dict(metadata), "error": error.to_dict()},
            status="failed",
        )
        self._append_usage_receipt(receipt)
        return ExecuteResult(
            ok=False,
            tool_name=tool_name,
            request_id=request_id,
            status="failed",
            output=None,
            receipt=asdict(receipt),
            error=error.to_dict(),
        )

    def _build_receipt(
        self,
        *,
        tool_name: str,
        request_id: str,
        started: datetime,
        finished: datetime,
        input_fingerprint: str,
        output_fingerprint: Optional[str],
        error_code: Optional[str],
        arguments: Mapping[str, Any],
        output: Any,
        metadata: Mapping[str, Any],
        status: str,
    ) -> UsageReceipt:
        duration_ms = max(0, int((finished - started).total_seconds() * 1000))
        usage_units = self._estimate_usage_units(tool_name=tool_name, arguments=arguments, output=output, error_code=error_code)
        usage_cost_units = usage_units
        receipt_id = f"urcpt_{uuid4().hex}"
        signature_payload = {
            "receipt_id": receipt_id,
            "request_id": request_id,
            "namespace": self.receipt_namespace,
            "tool_name": tool_name,
            "status": status,
            "input_sha256": input_fingerprint,
            "output_sha256": output_fingerprint,
            "error_code": error_code,
            "usage_units": usage_units,
            "usage_cost_units": usage_cost_units,
        }
        receipt_signature = hashlib.sha256(
            (json.dumps(signature_payload, sort_keys=True, default=str) + self.receipt_secret).encode("utf-8")
        ).hexdigest()
        receipt_metadata = {
            "arguments_preview": _redacted_preview("input", input_fingerprint),
            "output_preview": _redacted_preview("output", output_fingerprint),
            **dict(metadata),
        }
        return UsageReceipt(
            receipt_id=receipt_id,
            request_id=request_id,
            namespace=self.receipt_namespace,
            tool_name=tool_name,
            status=status,
            started_at=started.isoformat(),
            finished_at=finished.isoformat(),
            duration_ms=duration_ms,
            input_sha256=input_fingerprint,
            output_sha256=output_fingerprint,
            error_code=error_code,
            simulated=True,
            usage_units=usage_units,
            usage_cost_units=usage_cost_units,
            receipt_signature=receipt_signature,
            metadata=receipt_metadata,
        )

    @staticmethod
    def _bind_arguments(
        tool: ToolCallable,
        arguments: Mapping[str, Any],
        *,
        request_id: str,
        metadata: Mapping[str, Any],
        receipt_namespace: str,
    ) -> tuple[tuple[Any, ...], dict[str, Any]]:
        signature = inspect.signature(tool)
        prepared_arguments = dict(arguments)
        for name, parameter in signature.parameters.items():
            if name in prepared_arguments:
                continue
            if parameter.default is not inspect.Parameter.empty:
                continue
            if parameter.kind not in (inspect.Parameter.POSITIONAL_OR_KEYWORD, inspect.Parameter.KEYWORD_ONLY):
                continue
            if _looks_like_arcade_context_parameter(name, parameter):
                prepared_arguments[name] = LocalArcadeContext(
                    request_id=request_id,
                    namespace=receipt_namespace,
                    metadata=dict(metadata),
                )
        bound = signature.bind(**prepared_arguments)
        bound.apply_defaults()
        return bound.args, bound.kwargs

    @staticmethod
    def _estimate_usage_units(*, tool_name: str, arguments: Mapping[str, Any], output: Any, error_code: Optional[str]) -> int:
        base = len(tool_name) + len(json.dumps(arguments, sort_keys=True, default=str))
        output_weight = 0 if output is None else len(json.dumps(output, sort_keys=True, default=str))
        penalty = 5 if error_code else 0
        return max(1, (base + output_weight) // 32 + penalty)

    def _append_usage_receipt(self, receipt: UsageReceipt) -> None:
        self.usage_log_path.parent.mkdir(parents=True, exist_ok=True)
        with self.usage_log_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(asdict(receipt), sort_keys=True, default=str) + "\n")

    @staticmethod
    def _await_sync(awaitable: Any) -> Any:
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return asyncio.run(awaitable)
        if hasattr(awaitable, "close"):
            awaitable.close()
        raise ArcadeExecuteError(
            "async tool requires execute_async when an event loop is already running",
            code="async_tool_requires_execute_async",
            retryable=False,
        )


def build_demo_adapter(usage_log_path: Path | str = DEFAULT_RECEIPT_LOG_PATH) -> ArcadeLocalExecuteAdapter:
    adapter = ArcadeLocalExecuteAdapter(usage_log_path=usage_log_path)

    @adapter.register_tool("sum_numbers")
    def sum_numbers(a: float, b: float) -> JsonDict:
        return {"result": a + b, "operation": "sum"}

    @adapter.register_tool("reverse_text")
    def reverse_text(text: str, uppercase: bool = False) -> JsonDict:
        value = text[::-1]
        return {"result": value.upper() if uppercase else value, "operation": "reverse_text"}

    @adapter.register_tool("guarded_lookup")
    def guarded_lookup(key: str) -> JsonDict:
        if key == "missing":
            raise ArcadeExecuteError("lookup key was not found", code="not_found", retryable=False)
        return {"key": key, "value": f"demo:{key}"}

    @adapter.register_tool("boom")
    def boom() -> None:
        raise RuntimeError("simulated tool crash")

    @adapter.register_tool
    def bare_decorator(value: str) -> JsonDict:
        return {"result": value, "operation": "bare_decorator"}

    @adapter.register_tool("async_echo")
    async def async_echo(value: str) -> JsonDict:
        await asyncio.sleep(0)
        return {"result": value, "operation": "async_echo"}

    @adapter.register_tool("internal_type_error")
    def internal_type_error(value: str) -> JsonDict:
        raise TypeError(f"internal type error for {value}")

    @adapter.register_tool("context_echo")
    def context_echo(context: LocalArcadeContext, value: str) -> JsonDict:
        return {
            "context_request_id": context.request_id,
            "context_namespace": context.namespace,
            "value": value,
        }

    return adapter


def _read_jsonl(path: Path) -> list[JsonDict]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def run_self_test() -> None:
    with tempfile.TemporaryDirectory(prefix="arcade-mcp-local-") as tmpdir:
        log_path = Path(tmpdir) / "usage.jsonl"
        adapter = build_demo_adapter(log_path)

        success = adapter.execute("sum_numbers", {"a": 2, "b": 5}, request_id="req_ok")
        assert success.ok is True
        assert success.output == {"result": 7, "operation": "sum"}
        assert success.receipt["simulated"] is True
        assert success.receipt["status"] == "completed"
        assert success.receipt["metadata"]["arguments_preview"].startswith("input_preview_redacted_by_default")
        assert success.receipt["metadata"]["output_preview"].startswith("output_preview_redacted_by_default")
        assert '"a"' not in success.receipt["metadata"]["arguments_preview"]
        assert '"result"' not in success.receipt["metadata"]["output_preview"]

        invalid_args = adapter.execute("sum_numbers", {"a": 2}, request_id="req_bad_args")
        assert invalid_args.ok is False
        assert invalid_args.error is not None
        assert invalid_args.error["code"] == "invalid_arguments"

        missing = adapter.execute("does_not_exist", {}, request_id="req_missing")
        assert missing.ok is False
        assert missing.error is not None
        assert missing.error["code"] == "tool_not_found"

        guarded = adapter.execute("guarded_lookup", {"key": "missing"}, request_id="req_guarded")
        assert guarded.ok is False
        assert guarded.error is not None
        assert guarded.error["code"] == "not_found"

        crashed = adapter.execute("boom", {}, request_id="req_crash")
        assert crashed.ok is False
        assert crashed.error is not None
        assert crashed.error["code"] == "tool_execution_failed"

        bare = adapter.execute("bare_decorator", {"value": "ok"}, request_id="req_bare")
        assert bare.ok is True
        assert bare.output == {"result": "ok", "operation": "bare_decorator"}

        async_result = adapter.execute("async_echo", {"value": "awaited"}, request_id="req_async")
        assert async_result.ok is True
        assert async_result.output == {"result": "awaited", "operation": "async_echo"}

        async_result_2 = asyncio.run(adapter.execute_async("async_echo", {"value": "awaited_async"}, request_id="req_async_2"))
        assert async_result_2.ok is True
        assert async_result_2.output == {"result": "awaited_async", "operation": "async_echo"}

        internal_type_error = adapter.execute("internal_type_error", {"value": "boom"}, request_id="req_internal_type_error")
        assert internal_type_error.ok is False
        assert internal_type_error.error is not None
        assert internal_type_error.error["code"] == "tool_execution_failed"

        sensitive = adapter.execute(
            "reverse_text",
            {"text": "secret-token-123", "uppercase": False},
            request_id="req_sensitive",
        )
        assert "secret-token-123" not in sensitive.receipt["metadata"]["arguments_preview"]
        assert "321-nekot-terces" not in sensitive.receipt["metadata"]["output_preview"]

        context_result = adapter.execute("context_echo", {"value": "ok"}, request_id="req_context")
        assert context_result.ok is True
        assert context_result.output == {
            "context_request_id": "req_context",
            "context_namespace": DEFAULT_RECEIPT_NAMESPACE,
            "value": "ok",
        }

        entries = _read_jsonl(log_path)
        assert len(entries) == 11
        assert [entry["request_id"] for entry in entries] == [
            "req_ok",
            "req_bad_args",
            "req_missing",
            "req_guarded",
            "req_crash",
            "req_bare",
            "req_async",
            "req_async_2",
            "req_internal_type_error",
            "req_sensitive",
            "req_context",
        ]
        assert entries[0]["output_sha256"]
        assert entries[1]["error_code"] == "invalid_arguments"
        assert entries[2]["error_code"] == "tool_not_found"
        assert entries[3]["error_code"] == "not_found"
        assert entries[4]["error_code"] == "tool_execution_failed"
        assert entries[8]["error_code"] == "tool_execution_failed"
        assert all(entry["simulated"] is True for entry in entries)
        assert all(entry["receipt_signature"] for entry in entries)

    print("self-test passed")


def run_demo() -> None:
    log_path = Path.cwd() / ".arcade-mcp-demo-usage.jsonl"
    adapter = build_demo_adapter(log_path)
    calls = [
        adapter.execute("sum_numbers", {"a": 3, "b": 9}, request_id="demo_sum"),
        adapter.execute("reverse_text", {"text": "Arcade MCP", "uppercase": True}, request_id="demo_reverse"),
        adapter.execute("guarded_lookup", {"key": "missing"}, request_id="demo_missing"),
    ]
    payload = {
        "tools": adapter.list_tools(),
        "results": [
            {
                "request_id": result.request_id,
                "tool_name": result.tool_name,
                "ok": result.ok,
                "status": result.status,
                "output": result.output,
                "error": result.error,
                "receipt_id": result.receipt["receipt_id"],
                "usage_units": result.receipt["usage_units"],
            }
            for result in calls
        ],
        "usage_log_path": str(log_path),
        "mcp_app_available": MCPApp is not None,
    }
    print(json.dumps(payload, indent=2, sort_keys=True))


def main(argv: Optional[Iterable[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Arcade MCP local execute adapter with simulated usage receipts")
    parser.add_argument("--self-test", action="store_true", help="run inline assertions")
    parser.add_argument("--demo", action="store_true", help="run a demo execution")
    args = parser.parse_args(list(argv) if argv is not None else None)

    if args.self_test:
        run_self_test()
        return 0

    run_demo()
    return 0


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _stable_sha256(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, default=str).encode("utf-8")).hexdigest()


def _truncate_json(value: Any, limit: int = 240) -> str:
    text = json.dumps(value, sort_keys=True, default=str)
    return text if len(text) <= limit else text[: limit - 3] + "..."


def _redacted_preview(label: str, sha256_value: Optional[str]) -> str:
    fingerprint = sha256_value or "none"
    return f"{label}_preview_redacted_by_default sha256={fingerprint}"


def _looks_like_arcade_context_parameter(name: str, parameter: inspect.Parameter) -> bool:
    if name in {"context", "ctx"}:
        return True
    annotation = parameter.annotation
    if annotation is inspect.Parameter.empty:
        return False
    annotation_name = getattr(annotation, "__name__", "") or str(annotation)
    return annotation_name.lower().endswith("context")


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
