#!/usr/bin/env python3
from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import os
import sys
import time
import traceback
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Dict, List, Mapping, MutableMapping, Optional, Protocol, Sequence, Tuple, Union

USAGE_RECEIPT_SCHEMA = "agoragentic:usage-receipt:v1"
EXECUTION_RESULT_SCHEMA = "agoragentic:langgraph-execute-result:v1"
DEFAULT_TIMEOUT_SECONDS = 60.0


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def stable_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True, default=str)


def deep_clone(value: Any) -> Any:
    return json.loads(json.dumps(value, ensure_ascii=False, default=str))


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def estimate_text_units(value: Any) -> int:
    text = stable_json(value)
    return max(1, len(text) // 4)


def ensure_mapping(value: Optional[Mapping[str, Any]], *, name: str) -> Dict[str, Any]:
    if value is None:
        return {}
    if not isinstance(value, Mapping):
        raise TypeError(f"{name} must be a mapping")
    return {str(k): deep_clone(v) for k, v in value.items()}


def prepare_execution_config(config: Optional[Mapping[str, Any]]) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    if config is None:
        return {}, {}
    if not isinstance(config, Mapping):
        raise TypeError("config must be a mapping")
    execution_config = {str(k): v for k, v in config.items()}
    receipt_config = {str(k): deep_clone(v) for k, v in config.items()}
    return execution_config, receipt_config


def compact_error(error: BaseException) -> Dict[str, Any]:
    return {
        "type": error.__class__.__name__,
        "message": str(error),
        "traceback": "".join(traceback.format_exception(type(error), error, error.__traceback__)).strip(),
    }


def pluck(mapping: Mapping[str, Any], path: Sequence[str]) -> Any:
    cur: Any = mapping
    for part in path:
        if not isinstance(cur, Mapping) or part not in cur:
            return None
        cur = cur[part]
    return cur


def normalize_usage(raw: Optional[Mapping[str, Any]], *, input_value: Any, output_value: Any) -> Dict[str, int]:
    usage = dict(raw or {})
    candidates = [
        ("input_tokens", ["input_tokens"]),
        ("input_tokens", ["prompt_tokens"]),
        ("input_tokens", ["usage_metadata", "input_tokens"]),
        ("input_tokens", ["token_usage", "prompt_tokens"]),
        ("output_tokens", ["output_tokens"]),
        ("output_tokens", ["completion_tokens"]),
        ("output_tokens", ["usage_metadata", "output_tokens"]),
        ("output_tokens", ["token_usage", "completion_tokens"]),
        ("total_tokens", ["total_tokens"]),
        ("total_tokens", ["usage_metadata", "total_tokens"]),
        ("total_tokens", ["token_usage", "total_tokens"]),
    ]
    resolved: Dict[str, int] = {}
    for target_key, path in candidates:
        if target_key in resolved:
            continue
        value = pluck(usage, path)
        if isinstance(value, bool):
            continue
        if isinstance(value, (int, float)):
            resolved[target_key] = int(value)
    if "input_tokens" not in resolved:
        resolved["input_tokens"] = estimate_text_units(input_value)
    if "output_tokens" not in resolved:
        resolved["output_tokens"] = estimate_text_units(output_value)
    if "total_tokens" not in resolved:
        resolved["total_tokens"] = resolved["input_tokens"] + resolved["output_tokens"]
    return resolved


def normalize_output_payload(result: Any, *, execution_input: Any) -> Tuple[Any, Dict[str, int], Dict[str, Any]]:
    metadata: Dict[str, Any] = {}
    if isinstance(result, Mapping):
        raw_usage = None
        for key in ("usage", "usage_metadata", "token_usage", "llm_usage"):
            if isinstance(result.get(key), Mapping):
                raw_usage = result[key]
                break
        normalized_usage = normalize_usage(raw_usage, input_value=execution_input, output_value=result)
        metadata["output_type"] = "mapping"
        return deep_clone(result), normalized_usage, metadata
    normalized_usage = normalize_usage(None, input_value=execution_input, output_value=result)
    metadata["output_type"] = type(result).__name__
    return deep_clone(result), normalized_usage, metadata


class SupportsInvoke(Protocol):
    def invoke(self, input: Any, config: Optional[Mapping[str, Any]] = None) -> Any:
        ...


class SupportsAInvoke(Protocol):
    async def ainvoke(self, input: Any, config: Optional[Mapping[str, Any]] = None) -> Any:
        ...


@dataclass
class ExecutionReceipt:
    schema: str
    receipt_id: str
    trace_id: str
    span_id: str
    status: str
    started_at: str
    finished_at: str
    duration_ms: int
    actor: str
    workflow: str
    execution_mode: str
    input_sha256: str
    output_sha256: Optional[str]
    usage: Dict[str, int]
    cost: Dict[str, Any]
    attributes: Dict[str, Any] = field(default_factory=dict)
    error: Optional[Dict[str, Any]] = None


@dataclass
class ExecuteResponse:
    schema: str
    ok: bool
    trace_id: str
    span_id: str
    workflow: str
    output: Optional[Any]
    usage_receipt: Dict[str, Any]
    langfuse: Dict[str, Any]
    wrapper: Dict[str, Any]
    error: Optional[Dict[str, Any]] = None


class LocalExecutionError(RuntimeError):
    pass


class SimpleLangfuseSpan:
    def __init__(self, trace_id: str, span_id: str, sink: Optional[List[Dict[str, Any]]] = None) -> None:
        self.trace_id = trace_id
        self.id = span_id
        self._sink = sink if sink is not None else []
        self._events: List[Dict[str, Any]] = []

    def update(self, **payload: Any) -> None:
        self._events.append({"type": "update", "payload": deep_clone(payload)})

    def event(self, **payload: Any) -> None:
        self._events.append({"type": "event", "payload": deep_clone(payload)})

    def end(self, **payload: Any) -> None:
        self._events.append({"type": "end", "payload": deep_clone(payload)})
        self._sink.append(
            {
                "trace_id": self.trace_id,
                "span_id": self.id,
                "events": deep_clone(self._events),
            }
        )


class SimpleLangfuseTrace:
    def __init__(self, trace_id: str, sink: Optional[List[Dict[str, Any]]] = None) -> None:
        self.id = trace_id
        self._sink = sink if sink is not None else []

    def span(self, *, name: str, input: Any = None, metadata: Any = None, tags: Any = None) -> SimpleLangfuseSpan:
        span_id = uuid.uuid4().hex
        self._sink.append(
            {
                "trace_id": self.id,
                "trace_opened": {
                    "name": name,
                    "input": deep_clone(input),
                    "metadata": deep_clone(metadata),
                    "tags": deep_clone(tags),
                },
            }
        )
        return SimpleLangfuseSpan(self.id, span_id, self._sink)

    def generation(self, **payload: Any) -> SimpleLangfuseSpan:
        return self.span(name=payload.get("name", "generation"), input=payload.get("input"), metadata=payload.get("metadata"))


class SimpleLangfuseClient:
    def __init__(self) -> None:
        self.records: List[Dict[str, Any]] = []

    def trace(self, *, name: str, user_id: Optional[str] = None, session_id: Optional[str] = None, input: Any = None, metadata: Any = None, tags: Any = None) -> SimpleLangfuseTrace:
        trace_id = uuid.uuid4().hex
        self.records.append(
            {
                "trace_id": trace_id,
                "trace_created": {
                    "name": name,
                    "user_id": user_id,
                    "session_id": session_id,
                    "input": deep_clone(input),
                    "metadata": deep_clone(metadata),
                    "tags": deep_clone(tags),
                },
            }
        )
        return SimpleLangfuseTrace(trace_id, self.records)

    def flush(self) -> None:
        return None


class LangfuseObservation:
    def __init__(self, client: Any, *, name: str, input_value: Any, metadata: Any, tags: Sequence[str], user_id: Optional[str], session_id: Optional[str]) -> None:
        self.client = client
        self.trace = None
        self.span = None
        self._context = None
        self._records: List[Dict[str, Any]] = []
        self.trace_id = uuid.uuid4().hex
        self.span_id = uuid.uuid4().hex

        if hasattr(client, "start_as_current_observation"):
            self._context = client.start_as_current_observation(
                name=name,
                as_type="span",
                input=input_value,
                metadata={**dict(metadata or {}), "user_id": user_id, "session_id": session_id},
            )
            self.span = self._context.__enter__()
            self.trace_id = str(getattr(self.span, "trace_id", self.trace_id))
            self.span_id = str(getattr(self.span, "id", getattr(self.span, "observation_id", self.span_id)))
            return

        if hasattr(client, "trace"):
            self.trace = client.trace(name=name, user_id=user_id, session_id=session_id, input=input_value, metadata=metadata, tags=tags)
            self.trace_id = str(getattr(self.trace, "id", self.trace_id))
            self.span = self.trace.span(name="local.langgraph.execute", input=input_value, metadata=metadata, tags=tags)
            self.span_id = str(getattr(self.span, "id", self.span_id))
            return

        self.span = SimpleLangfuseSpan(self.trace_id, self.span_id, self._records)

    def update(self, **payload: Any) -> None:
        if hasattr(self.span, "update"):
            self.span.update(**payload)

    def event(self, **payload: Any) -> None:
        if hasattr(self.span, "event"):
            self.span.event(**payload)

    def end(self, **payload: Any) -> None:
        if hasattr(self.span, "end"):
            self.span.end(**payload)
        if self._context is not None:
            self._context.__exit__(None, None, None)


def build_langfuse_client() -> Any:
    try:
        from langfuse import Langfuse  # type: ignore
    except Exception:
        return SimpleLangfuseClient()
    public_key = os.getenv("LANGFUSE_PUBLIC_KEY")
    secret_key = os.getenv("LANGFUSE_SECRET_KEY")
    host = os.getenv("LANGFUSE_HOST")
    kwargs: Dict[str, Any] = {}
    if public_key:
        kwargs["public_key"] = public_key
    if secret_key:
        kwargs["secret_key"] = secret_key
    if host:
        kwargs["host"] = host
    if not kwargs:
        return SimpleLangfuseClient()
    return Langfuse(**kwargs)


class LocalExecutionWrapper:
    def __init__(self, *, timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS) -> None:
        self.timeout_seconds = float(timeout_seconds)

    async def run(
        self,
        graph: Any,
        *,
        graph_input: Any,
        config: Optional[Mapping[str, Any]] = None,
        force_async: Optional[bool] = None,
    ) -> Any:
        if force_async is True:
            return await self._run_async(graph, graph_input, config)
        if force_async is False:
            return await self._run_sync(graph, graph_input, config)
        if hasattr(graph, "ainvoke") and callable(getattr(graph, "ainvoke")):
            return await self._run_async(graph, graph_input, config)
        if hasattr(graph, "invoke") and callable(getattr(graph, "invoke")):
            return await self._run_sync(graph, graph_input, config)
        if callable(graph):
            fn = graph
            if inspect.iscoroutinefunction(fn):
                return await self._run_coro(self._call_async_callable(fn, graph_input, config))
            return await self._run_blocking(lambda: self._call_sync_callable(fn, graph_input, config))
        raise LocalExecutionError("graph must provide invoke(), ainvoke(), or be callable")

    async def _run_async(self, graph: Any, graph_input: Any, config: Optional[Mapping[str, Any]]) -> Any:
        coro = graph.ainvoke(graph_input, config=config)
        return await self._run_coro(coro)

    async def _run_sync(self, graph: Any, graph_input: Any, config: Optional[Mapping[str, Any]]) -> Any:
        return await self._run_blocking(lambda: graph.invoke(graph_input, config=config))

    async def _run_coro(self, coro: Awaitable[Any]) -> Any:
        return await asyncio.wait_for(coro, timeout=self.timeout_seconds)

    async def _run_blocking(self, fn: Callable[[], Any]) -> Any:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, fn)

    @staticmethod
    def _callable_accepts_config(fn: Callable[..., Any]) -> bool:
        try:
            signature = inspect.signature(fn)
        except (TypeError, ValueError):
            return True
        positional = [
            parameter
            for parameter in signature.parameters.values()
            if parameter.kind in (parameter.POSITIONAL_ONLY, parameter.POSITIONAL_OR_KEYWORD)
        ]
        has_varargs = any(parameter.kind == parameter.VAR_POSITIONAL for parameter in signature.parameters.values())
        return has_varargs or len(positional) >= 2 or "config" in signature.parameters

    async def _call_async_callable(self, fn: Callable[..., Awaitable[Any]], graph_input: Any, config: Optional[Mapping[str, Any]]) -> Any:
        if self._callable_accepts_config(fn):
            return await fn(graph_input, config)
        return await fn(graph_input)

    def _call_sync_callable(self, fn: Callable[..., Any], graph_input: Any, config: Optional[Mapping[str, Any]]) -> Any:
        if self._callable_accepts_config(fn):
            return fn(graph_input, config)
        return fn(graph_input)


class LangGraphLangfuseLocalExecuteAdapter:
    def __init__(
        self,
        graph: Any,
        *,
        workflow: str = "langgraph-workflow",
        actor: str = "local-operator",
        langfuse_client: Optional[Any] = None,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
        default_cost_per_1k_input_tokens: float = 0.0,
        default_cost_per_1k_output_tokens: float = 0.0,
    ) -> None:
        self.graph = graph
        self.workflow = str(workflow)
        self.actor = str(actor)
        self.langfuse = langfuse_client or build_langfuse_client()
        self.wrapper = LocalExecutionWrapper(timeout_seconds=timeout_seconds)
        self.default_cost_per_1k_input_tokens = float(default_cost_per_1k_input_tokens)
        self.default_cost_per_1k_output_tokens = float(default_cost_per_1k_output_tokens)

    def execute(
        self,
        trace_data: Mapping[str, Any],
        *,
        graph_input: Optional[Any] = None,
        config: Optional[Mapping[str, Any]] = None,
        metadata: Optional[Mapping[str, Any]] = None,
        tags: Optional[Sequence[str]] = None,
        actor: Optional[str] = None,
        workflow: Optional[str] = None,
        force_async: Optional[bool] = None,
    ) -> Dict[str, Any]:
        return asyncio.run(
            self.aexecute(
                trace_data,
                graph_input=graph_input,
                config=config,
                metadata=metadata,
                tags=tags,
                actor=actor,
                workflow=workflow,
                force_async=force_async,
            )
        )

    async def aexecute(
        self,
        trace_data: Mapping[str, Any],
        *,
        graph_input: Optional[Any] = None,
        config: Optional[Mapping[str, Any]] = None,
        metadata: Optional[Mapping[str, Any]] = None,
        tags: Optional[Sequence[str]] = None,
        actor: Optional[str] = None,
        workflow: Optional[str] = None,
        force_async: Optional[bool] = None,
    ) -> Dict[str, Any]:
        if not isinstance(trace_data, Mapping):
            raise TypeError("trace_data must be a mapping")

        normalized_trace = ensure_mapping(trace_data, name="trace_data")
        execution_config, normalized_config = prepare_execution_config(config)
        normalized_metadata = ensure_mapping(metadata, name="metadata")
        effective_actor = actor or str(normalized_trace.get("user_id") or self.actor)
        effective_workflow = workflow or str(normalized_trace.get("name") or self.workflow)
        execution_input = graph_input if graph_input is not None else normalized_trace.get("input", normalized_trace)

        observation = LangfuseObservation(
            self.langfuse,
            name=effective_workflow,
            user_id=normalized_trace.get("user_id"),
            session_id=normalized_trace.get("session_id"),
            input_value=execution_input,
            metadata={**normalized_metadata, "source_trace": normalized_trace},
            tags=list(tags or []),
        )

        started_ns = time.time_ns()
        started_at = utc_now_iso()
        input_hash = sha256_text(stable_json(execution_input))

        try:
            output = await self.wrapper.run(
                self.graph,
                graph_input=execution_input,
                config=execution_config,
                force_async=force_async,
            )
            normalized_output, usage, output_meta = normalize_output_payload(output, execution_input=execution_input)
            finished_ns = time.time_ns()
            finished_at = utc_now_iso()
            cost = self._estimate_cost(usage)
            receipt = ExecutionReceipt(
                schema=USAGE_RECEIPT_SCHEMA,
                receipt_id=uuid.uuid4().hex,
                trace_id=observation.trace_id,
                span_id=observation.span_id,
                status="completed",
                started_at=started_at,
                finished_at=finished_at,
                duration_ms=max(0, int((finished_ns - started_ns) / 1_000_000)),
                actor=effective_actor,
                workflow=effective_workflow,
                execution_mode="local_wrapper",
                input_sha256=input_hash,
                output_sha256=sha256_text(stable_json(normalized_output)),
                usage=usage,
                cost=cost,
                attributes={
                    "config": normalized_config,
                    "metadata": normalized_metadata,
                    "trace_name": normalized_trace.get("name"),
                    "session_id": normalized_trace.get("session_id"),
                    **output_meta,
                },
            )
            observation.update(output=normalized_output, metadata={"usage_receipt": asdict(receipt)})
            observation.end(level="DEFAULT", status_message="completed")
            if hasattr(self.langfuse, "flush"):
                self.langfuse.flush()
            response = ExecuteResponse(
                schema=EXECUTION_RESULT_SCHEMA,
                ok=True,
                trace_id=receipt.trace_id,
                span_id=receipt.span_id,
                workflow=effective_workflow,
                output=normalized_output,
                usage_receipt=asdict(receipt),
                langfuse={
                    "client": self.langfuse.__class__.__name__,
                    "trace_id": receipt.trace_id,
                    "span_id": receipt.span_id,
                    "flushed": bool(hasattr(self.langfuse, "flush")),
                },
                wrapper={
                    "name": self.wrapper.__class__.__name__,
                    "timeout_seconds": self.wrapper.timeout_seconds,
                    "force_async": force_async,
                },
                error=None,
            )
            return asdict(response)
        except Exception as error:
            finished_ns = time.time_ns()
            finished_at = utc_now_iso()
            error_payload = compact_error(error)
            receipt = ExecutionReceipt(
                schema=USAGE_RECEIPT_SCHEMA,
                receipt_id=uuid.uuid4().hex,
                trace_id=observation.trace_id,
                span_id=observation.span_id,
                status="failed",
                started_at=started_at,
                finished_at=finished_at,
                duration_ms=max(0, int((finished_ns - started_ns) / 1_000_000)),
                actor=effective_actor,
                workflow=effective_workflow,
                execution_mode="local_wrapper",
                input_sha256=input_hash,
                output_sha256=None,
                usage=normalize_usage(None, input_value=execution_input, output_value={"error": error_payload["message"]}),
                cost=self._estimate_cost(normalize_usage(None, input_value=execution_input, output_value={"error": error_payload["message"]})),
                attributes={
                    "config": normalized_config,
                    "metadata": normalized_metadata,
                    "trace_name": normalized_trace.get("name"),
                    "session_id": normalized_trace.get("session_id"),
                },
                error=error_payload,
            )
            try:
                observation.event(name="execution_error", level="ERROR", status_message=error_payload["message"], output=error_payload)
                observation.end(level="ERROR", status_message="failed")
                if hasattr(self.langfuse, "flush"):
                    self.langfuse.flush()
            except Exception:
                pass
            response = ExecuteResponse(
                schema=EXECUTION_RESULT_SCHEMA,
                ok=False,
                trace_id=receipt.trace_id,
                span_id=receipt.span_id,
                workflow=effective_workflow,
                output=None,
                usage_receipt=asdict(receipt),
                langfuse={
                    "client": self.langfuse.__class__.__name__,
                    "trace_id": receipt.trace_id,
                    "span_id": receipt.span_id,
                    "flushed": bool(hasattr(self.langfuse, "flush")),
                },
                wrapper={
                    "name": self.wrapper.__class__.__name__,
                    "timeout_seconds": self.wrapper.timeout_seconds,
                    "force_async": force_async,
                },
                error=error_payload,
            )
            return asdict(response)

    def _estimate_cost(self, usage: Mapping[str, int]) -> Dict[str, Any]:
        input_tokens = int(usage.get("input_tokens", 0))
        output_tokens = int(usage.get("output_tokens", 0))
        input_cost = (input_tokens / 1000.0) * self.default_cost_per_1k_input_tokens
        output_cost = (output_tokens / 1000.0) * self.default_cost_per_1k_output_tokens
        total_cost = input_cost + output_cost
        return {
            "currency": "USD",
            "input_cost": round(input_cost, 8),
            "output_cost": round(output_cost, 8),
            "total_cost": round(total_cost, 8),
            "pricing_mode": "estimated",
        }


class DemoLangGraph:
    def invoke(self, input: Any, config: Optional[Mapping[str, Any]] = None) -> Dict[str, Any]:
        config = dict(config or {})
        message = ""
        if isinstance(input, Mapping):
            message = str(input.get("message", "")).strip()
        if message == "explode":
            raise ValueError("demo failure from graph.invoke")
        reply = message.upper() if message else "EMPTY"
        return {
            "reply": reply,
            "config_seen": config,
            "usage": {
                "input_tokens": estimate_text_units(input),
                "output_tokens": estimate_text_units({"reply": reply}),
                "total_tokens": estimate_text_units(input) + estimate_text_units({"reply": reply}),
            },
        }


def _demo() -> int:
    adapter = LangGraphLangfuseLocalExecuteAdapter(
        DemoLangGraph(),
        workflow="demo-langgraph",
        actor="demo-user",
        langfuse_client=SimpleLangfuseClient(),
        default_cost_per_1k_input_tokens=0.001,
        default_cost_per_1k_output_tokens=0.002,
    )

    ok_result = adapter.execute(
        {
            "name": "demo-trace",
            "user_id": "user-123",
            "session_id": "session-abc",
            "input": {"message": "hello world"},
        },
        config={"thread_id": "thread-1"},
        metadata={"env": "demo"},
        tags=["demo", "langgraph", "langfuse"],
    )

    assert ok_result["ok"] is True
    assert ok_result["output"]["reply"] == "HELLO WORLD"
    assert ok_result["usage_receipt"]["status"] == "completed"
    assert ok_result["usage_receipt"]["trace_id"]
    assert ok_result["usage_receipt"]["usage"]["total_tokens"] >= 1

    fail_result = adapter.execute(
        {
            "name": "demo-trace-failure",
            "user_id": "user-123",
            "session_id": "session-abc",
            "input": {"message": "explode"},
        },
        config={"thread_id": "thread-2"},
        metadata={"env": "demo"},
        tags=["demo", "error"],
    )

    assert fail_result["ok"] is False
    assert fail_result["usage_receipt"]["status"] == "failed"
    assert "demo failure" in fail_result["error"]["message"]

    print(
        json.dumps(
            {
                "success_case": ok_result,
                "failure_case": fail_result,
            },
            indent=2,
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(_demo())
