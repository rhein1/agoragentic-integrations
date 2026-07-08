from __future__ import annotations

# local no-spend adapter; returns usage receipts only.

import argparse
import atexit
import hashlib
import json
import os
import queue
import subprocess
import sys
import threading
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping

DEFAULT_PROVIDER_ID = "sibyl-memory"
DEFAULT_PROVIDER_NAME = "Sibyl-Memory"
DEFAULT_NAMESPACE = os.environ.get("SIBYL_MEMORY_NAMESPACE", "default")
DEFAULT_TIMEOUT_MS = int(os.environ.get("SIBYL_MEMORY_TIMEOUT_MS", "30000"))
DEFAULT_LIMIT = int(os.environ.get("SIBYL_MEMORY_LIMIT", "5"))
MAX_TOP_K = 50
DEFAULT_TASK = "search relevant memory for the user request"
COMPATIBLE_NAME_PATTERNS = ("memory", "memories", "recall", "retrieve", "search", "find", "context")
MUTATING_TOOL_PATTERNS = ("write", "store", "save", "insert", "upsert", "create", "delete", "remove", "mutate")


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def stable_id(prefix: str, *parts: Any) -> str:
    digest = hashlib.sha256()
    for part in parts:
        digest.update(str(part).encode("utf-8"))
        digest.update(b"\x1f")
    return f"{prefix}_{digest.hexdigest()[:24]}"


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest_payload(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def byte_len(value: Any) -> int:
    return len(canonical_json(value).encode("utf-8"))


def clone_json(value: Any) -> Any:
    return json.loads(json.dumps(value))


def normalize_tool_descriptor(tool: Mapping[str, Any]) -> dict[str, Any]:
    schema = tool.get("inputSchema") if isinstance(tool.get("inputSchema"), Mapping) else {}
    return {
        "name": str(tool.get("name") or ""),
        "description": str(tool.get("description") or ""),
        "inputSchema": clone_json(schema) if schema else {"type": "object", "properties": {}},
    }


class McpProtocolError(RuntimeError):
    pass


class SibylToolSelectionError(RuntimeError):
    pass


@dataclass(frozen=True)
class UsageReceipt:
    provider_id: str
    provider_name: str
    tool_name: str
    ok: bool
    started_at: str
    finished_at: str
    duration_ms: int
    namespace: str
    input_digest: str
    output_digest: str
    input_bytes: int
    output_bytes: int
    invocation_id: str
    manifest_id: str
    error_type: str | None = None
    error_message: str | None = None


class McpJsonRpcClient:
    def __init__(
        self,
        command: list[str],
        *,
        cwd: str | None = None,
        env: Mapping[str, str] | None = None,
        timeout_ms: int = DEFAULT_TIMEOUT_MS,
        protocol_version: str = "2024-11-05",
    ) -> None:
        if not command:
            raise ValueError("command must not be empty")
        self.command = list(command)
        self.cwd = cwd
        merged_env = os.environ.copy()
        if env:
            merged_env.update({str(k): str(v) for k, v in env.items()})
        self.env = merged_env
        self.timeout_ms = timeout_ms
        self.protocol_version = protocol_version
        self._process: subprocess.Popen[str] | None = None
        self._request_id = 0
        self._responses: dict[int, queue.Queue[dict[str, Any]]] = {}
        self._stderr_lines: list[str] = []
        self._lock = threading.Lock()
        self._reader_thread: threading.Thread | None = None
        self._stderr_thread: threading.Thread | None = None
        self._closed = False

    def start(self) -> None:
        if self._process is not None:
            return
        self._process = subprocess.Popen(
            self.command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=self.cwd,
            env=self.env,
            text=True,
            bufsize=1,
        )
        self._reader_thread = threading.Thread(target=self._read_stdout, name="sibyl-mcp-stdout", daemon=True)
        self._stderr_thread = threading.Thread(target=self._read_stderr, name="sibyl-mcp-stderr", daemon=True)
        self._reader_thread.start()
        self._stderr_thread.start()
        init_result = self._request(
            "initialize",
            {
                "protocolVersion": self.protocol_version,
                "clientInfo": {
                    "name": "agoragentic-sibyl-memory-adapter",
                    "version": "1.0.0",
                },
                "capabilities": {},
            },
        )
        if not isinstance(init_result, Mapping):
            raise McpProtocolError("MCP initialize response must be an object")
        self._notify("notifications/initialized", {})

    def list_tools(self) -> list[dict[str, Any]]:
        self.start()
        result = self._request("tools/list", {})
        tools = result.get("tools") if isinstance(result, Mapping) else None
        if not isinstance(tools, list):
            raise McpProtocolError("tools/list response missing tools array")
        return [normalize_tool_descriptor(tool) for tool in tools if isinstance(tool, Mapping)]

    def call_tool(self, name: str, arguments: Mapping[str, Any]) -> dict[str, Any]:
        self.start()
        result = self._request("tools/call", {"name": name, "arguments": dict(arguments)})
        if not isinstance(result, Mapping):
            raise McpProtocolError("tools/call response must be an object")
        return dict(result)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        process = self._process
        self._process = None
        if process is None:
            return
        try:
            if process.stdin:
                process.stdin.close()
        except OSError:
            pass
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)

    @property
    def stderr_text(self) -> str:
        return "\n".join(self._stderr_lines).strip()

    def _notify(self, method: str, params: Mapping[str, Any]) -> None:
        self._write({"jsonrpc": "2.0", "method": method, "params": dict(params)})

    def _request(self, method: str, params: Mapping[str, Any]) -> dict[str, Any]:
        with self._lock:
            self._request_id += 1
            request_id = self._request_id
            response_queue: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=1)
            self._responses[request_id] = response_queue
            self._write({"jsonrpc": "2.0", "id": request_id, "method": method, "params": dict(params)})
        timeout_seconds = self.timeout_ms / 1000.0
        try:
            message = response_queue.get(timeout=timeout_seconds)
        except queue.Empty as exc:
            self._responses.pop(request_id, None)
            raise TimeoutError(f"Timed out waiting for MCP response to {method} after {self.timeout_ms}ms") from exc
        if "error" in message and message["error"] is not None:
            error = message["error"]
            if isinstance(error, Mapping):
                raise McpProtocolError(str(error.get("message") or f"MCP error for {method}"))
            raise McpProtocolError(f"MCP error for {method}: {error}")
        result = message.get("result")
        if not isinstance(result, Mapping):
            return {} if result is None else {"value": result}
        return dict(result)

    def _write(self, payload: Mapping[str, Any]) -> None:
        process = self._process
        if process is None or process.stdin is None:
            raise RuntimeError("MCP process is not running")
        process.stdin.write(json.dumps(payload) + "\n")
        process.stdin.flush()

    def _read_stdout(self) -> None:
        process = self._process
        if process is None or process.stdout is None:
            return
        for raw_line in process.stdout:
            line = raw_line.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(message, Mapping):
                continue
            message_id = message.get("id")
            if isinstance(message_id, int):
                response_queue = self._responses.pop(message_id, None)
                if response_queue is not None:
                    response_queue.put(dict(message))

    def _read_stderr(self) -> None:
        process = self._process
        if process is None or process.stderr is None:
            return
        for raw_line in process.stderr:
            line = raw_line.rstrip()
            if line:
                self._stderr_lines.append(line)


def score_tool(tool: Mapping[str, Any], task: str = DEFAULT_TASK, preferred_tool_name: str | None = None) -> int:
    name = str(tool.get("name") or "")
    if preferred_tool_name and name == preferred_tool_name:
        return 1000
    text = f"{name} {tool.get('description') or ''}".lower()
    task_text = task.lower()
    score = 0

    def add_if(token: str, points: int) -> None:
        nonlocal score
        if token in text:
            score += points

    add_if("memory", 24)
    add_if("memories", 24)
    add_if("search", 20 if any(word in task_text for word in ("search", "find")) else 10)
    add_if("find", 18 if "find" in task_text else 8)
    add_if("recall", 20 if any(word in task_text for word in ("recall", "remember")) else 10)
    add_if("retrieve", 20 if "retrieve" in task_text else 10)
    add_if("query", 18 if "query" in task_text else 6)
    add_if("semantic", 14 if "semantic" in task_text else 4)
    add_if("vector", 10 if "vector" in task_text else 2)
    add_if("context", 10 if "context" in task_text else 3)
    if is_mutating_tool(tool):
        score -= 1000
    return score


def is_mutating_tool(tool: Mapping[str, Any]) -> bool:
    text = f"{tool.get('name') or ''} {tool.get('description') or ''}".lower()
    return any(pattern in text for pattern in MUTATING_TOOL_PATTERNS)


def select_memory_tool(
    tools: Iterable[Mapping[str, Any]],
    *,
    task: str = DEFAULT_TASK,
    preferred_tool_name: str | None = None,
) -> dict[str, Any]:
    normalized = [normalize_tool_descriptor(tool) for tool in tools]
    if preferred_tool_name:
        for tool in normalized:
            if tool["name"] == preferred_tool_name:
                if is_mutating_tool(tool):
                    raise SibylToolSelectionError(f"Preferred tool {preferred_tool_name!r} is mutating and cannot be used for retrieval")
                return tool
        raise SibylToolSelectionError(f"Preferred tool {preferred_tool_name!r} was not present in MCP tools/list")
    normalized = [tool for tool in normalized if not is_mutating_tool(tool)]
    if not normalized:
        raise SibylToolSelectionError("No non-mutating Sibyl-Memory retrieval tool was discovered")
    ranked = sorted(
        ((score_tool(tool, task, preferred_tool_name), tool) for tool in normalized),
        key=lambda item: item[0],
        reverse=True,
    )
    if not ranked:
        raise SibylToolSelectionError("No MCP tools were exposed by the Sibyl-Memory server")
    score, tool = ranked[0]
    name = tool["name"].lower()
    if score <= 0 and not any(token in name for token in COMPATIBLE_NAME_PATTERNS):
        raise SibylToolSelectionError("No compatible Sibyl-Memory retrieval tool was discovered")
    return tool


QUERY_ALIASES = ("query", "text", "prompt", "search", "question", "input")
LIMIT_ALIASES = ("limit", "top_k", "topK", "k", "max_results", "maxResults")
NAMESPACE_ALIASES = ("namespace", "collection", "memory_space", "scope")
FILTER_ALIASES = ("filters", "metadata_filter", "metadata", "where")


def choose_key(properties: Mapping[str, Any], aliases: Iterable[str]) -> str | None:
    for alias in aliases:
        if alias in properties:
            return alias
    return None


def schema_allows_extra(schema: Mapping[str, Any]) -> bool:
    return schema.get("additionalProperties", True) is not False


def build_tool_arguments(tool: Mapping[str, Any], params: Mapping[str, Any]) -> dict[str, Any]:
    if isinstance(params.get("tool_arguments"), Mapping):
        explicit_args = dict(params["tool_arguments"])
        for key in LIMIT_ALIASES:
            if key in explicit_args:
                validate_limit(explicit_args[key])
        return explicit_args
    schema = tool.get("inputSchema") if isinstance(tool.get("inputSchema"), Mapping) else {}
    properties = schema.get("properties") if isinstance(schema.get("properties"), Mapping) else {}
    allow_extra = schema_allows_extra(schema)
    args: dict[str, Any] = {}
    query_key = choose_key(properties, QUERY_ALIASES) or ("query" if allow_extra else None)
    limit_key = choose_key(properties, LIMIT_ALIASES) or ("limit" if allow_extra else None)
    namespace_key = choose_key(properties, NAMESPACE_ALIASES) or ("namespace" if allow_extra else None)
    filters_key = choose_key(properties, FILTER_ALIASES) or ("filters" if allow_extra else None)

    query = params.get("query") or params.get("text") or params.get("prompt") or params.get("input")
    if not isinstance(query, str) or not query.strip():
        raise ValueError("input_data must include a non-empty query string")
    if query_key is None:
        raise ValueError("selected MCP tool schema does not accept a query argument")
    args[query_key] = query.strip()

    limit = params.get("limit", params.get("top_k", DEFAULT_LIMIT))
    limit_int = validate_limit(limit)
    if limit_key is not None:
        args[limit_key] = limit_int

    namespace = params.get("namespace", DEFAULT_NAMESPACE)
    if namespace_key is not None and (namespace_key in properties or namespace != DEFAULT_NAMESPACE):
        args[namespace_key] = str(namespace)

    if filters_key is not None and filters_key in properties and isinstance(params.get("filters"), Mapping):
        args[filters_key] = dict(params["filters"])

    for extra_key, extra_value in params.items():
        if extra_key in {"query", "text", "prompt", "input", "limit", "top_k", "namespace", "filters", "tool_arguments"}:
            continue
        if allow_extra and extra_key not in args:
            args[extra_key] = extra_value
    return args


def validate_limit(value: Any) -> int:
    try:
        limit_int = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("limit/top_k must be an integer") from exc
    if limit_int <= 0:
        raise ValueError("limit/top_k must be positive")
    if limit_int > MAX_TOP_K:
        raise ValueError(f"limit/top_k must be <= {MAX_TOP_K}")
    return limit_int


@dataclass
class SibylMemoryExecuteAdapter:
    command: list[str]
    preferred_tool_name: str | None = None
    namespace: str = DEFAULT_NAMESPACE
    timeout_ms: int = DEFAULT_TIMEOUT_MS
    cwd: str | None = None
    env: dict[str, str] = field(default_factory=dict)
    provider_id: str = DEFAULT_PROVIDER_ID
    provider_name: str = DEFAULT_PROVIDER_NAME

    def __post_init__(self) -> None:
        self._client = McpJsonRpcClient(
            self.command,
            cwd=self.cwd,
            env=self.env,
            timeout_ms=self.timeout_ms,
        )
        atexit.register(self.close)

    def close(self) -> None:
        self._client.close()

    def list_tools(self) -> list[dict[str, Any]]:
        return self._client.list_tools()

    def build_manifest(self) -> dict[str, Any]:
        return {
            "schema": "agoragentic.integration.local-provider.v1",
            "id": f"{self.provider_id}.execute_memory",
            "name": "Sibyl-Memory Local Execute Wrapper",
            "description": "Route a bounded local memory-retrieval task through a Sibyl-Memory MCP server and return an Agoragentic-style usage receipt.",
            "provider": {
                "name": self.provider_name,
                "runtime": "local",
                "endpoint_url": None,
                "requires_owner_hosting": True,
            },
            "listing": {
                "category": "developer-tools",
                "listing_type": "service",
                "pricing_model": "free",
                "tags": [
                    "sibyl-memory",
                    "mcp",
                    "execute-wrapper",
                    "local-first",
                    "memory-retrieval",
                ],
            },
            "input_schema": {
                "type": "object",
                "additionalProperties": True,
                "required": ["query"],
                "properties": {
                    "query": {
                        "type": "string",
                        "minLength": 1,
                        "description": "Natural-language memory retrieval query.",
                    },
                    "top_k": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 50,
                        "default": DEFAULT_LIMIT,
                    },
                    "namespace": {
                        "type": "string",
                        "default": self.namespace,
                    },
                    "filters": {
                        "type": "object",
                        "additionalProperties": True,
                    },
                    "tool_arguments": {
                        "type": "object",
                        "additionalProperties": True,
                        "description": "Optional explicit MCP arguments to send as-is to the selected Sibyl tool.",
                    },
                },
            },
            "output_schema": {
                "type": "object",
                "additionalProperties": True,
                "required": ["ok", "tool", "result", "receipt", "manifest"],
                "properties": {
                    "ok": {"type": "boolean"},
                    "tool": {"type": "string"},
                    "result": {"type": ["object", "array", "string", "number", "boolean", "null"]},
                    "receipt": {
                        "type": "object",
                        "required": [
                            "provider_id",
                            "provider_name",
                            "tool_name",
                            "ok",
                            "started_at",
                            "finished_at",
                            "duration_ms",
                            "namespace",
                            "input_digest",
                            "output_digest",
                            "invocation_id",
                            "manifest_id",
                        ],
                        "additionalProperties": True,
                    },
                    "manifest": {
                        "type": "object",
                        "required": ["schema", "id", "provider", "input_schema", "output_schema"],
                        "additionalProperties": True,
                    },
                },
            },
            "sandbox_probe": {
                "input": {
                    "query": "decision about refund workflow",
                    "top_k": 2,
                    "namespace": self.namespace,
                },
                "expected": {
                    "ok": True,
                    "receipt.provider_id": self.provider_id,
                },
            },
            "guardrails": [
                "Run entirely against a local owner-hosted Sibyl-Memory MCP server.",
                "Do not read secrets, credentials, key material, or raw environment files into memory results.",
                "Keep retrieval bounded by top_k and preserve source metadata when the server returns it.",
            ],
        }

    def write_manifest(self, path: str | Path) -> Path:
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(self.build_manifest(), indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        return target

    def execute(
        self,
        task: str,
        input_data: Mapping[str, Any] | None = None,
        constraints: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        started_at = time.time()
        input_payload = {
            "task": task,
            "input": dict(input_data or {}),
            "constraints": dict(constraints or {}),
        }
        manifest = self.build_manifest()
        manifest_id = str(manifest["id"])
        invocation_id = stable_id("inv", task, input_payload, manifest_id, time.time_ns())
        namespace = str((input_data or {}).get("namespace") or self.namespace)
        tool_name = self.preferred_tool_name or ""
        try:
            tools = self.list_tools()
            selected_tool = select_memory_tool(tools, task=task, preferred_tool_name=self.preferred_tool_name)
            tool_name = selected_tool["name"]
            tool_arguments = build_tool_arguments(selected_tool, {**dict(input_data or {}), "namespace": namespace})
            raw_result = self._client.call_tool(tool_name, tool_arguments)
            if raw_result.get("isError") is True:
                raise McpProtocolError(f"MCP tool {tool_name} returned isError=true: {extract_tool_error_message(raw_result)}")
            normalized_result = self._normalize_tool_result(raw_result)
            return self._build_response(
                tool_name=tool_name,
                ok=True,
                result=normalized_result,
                error=None,
                namespace=namespace,
                manifest=manifest,
                invocation_id=invocation_id,
                input_payload=input_payload,
                started_at=started_at,
            )
        except Exception as exc:
            return self._build_response(
                tool_name=tool_name or "unresolved_tool",
                ok=False,
                result=None,
                error={"type": exc.__class__.__name__, "message": str(exc)},
                namespace=namespace,
                manifest=manifest,
                invocation_id=invocation_id,
                input_payload=input_payload,
                started_at=started_at,
            )

    def _normalize_tool_result(self, result: Mapping[str, Any]) -> Any:
        if "structuredContent" in result:
            return clone_json(result["structuredContent"])
        if "content" in result:
            content = result["content"]
            if isinstance(content, list):
                flattened: list[Any] = []
                for item in content:
                    if isinstance(item, Mapping) and item.get("type") == "text":
                        flattened.append(item.get("text", ""))
                    else:
                        flattened.append(item)
                return flattened
            return clone_json(content)
        return clone_json(dict(result))

    def _build_response(
        self,
        *,
        tool_name: str,
        ok: bool,
        result: Any,
        error: Mapping[str, Any] | None,
        namespace: str,
        manifest: Mapping[str, Any],
        invocation_id: str,
        input_payload: Mapping[str, Any],
        started_at: float,
    ) -> dict[str, Any]:
        finished_at = time.time()
        output_payload = result if error is None else dict(error)
        receipt = UsageReceipt(
            provider_id=self.provider_id,
            provider_name=self.provider_name,
            tool_name=tool_name,
            ok=ok,
            started_at=datetime.fromtimestamp(started_at, tz=timezone.utc).isoformat(),
            finished_at=datetime.fromtimestamp(finished_at, tz=timezone.utc).isoformat(),
            duration_ms=max(0, round((finished_at - started_at) * 1000)),
            namespace=namespace,
            input_digest=digest_payload(input_payload),
            output_digest=digest_payload(output_payload),
            input_bytes=byte_len(input_payload),
            output_bytes=byte_len(output_payload),
            invocation_id=invocation_id,
            manifest_id=str(manifest["id"]),
            error_type=None if error is None else str(error.get("type") or "RuntimeError"),
            error_message=None if error is None else str(error.get("message") or ""),
        )
        return {
            "ok": ok,
            "tool": tool_name,
            "result": result,
            "error": None if error is None else dict(error),
            "receipt": asdict(receipt),
            "manifest": clone_json(manifest),
        }


def extract_tool_error_message(result: Mapping[str, Any]) -> str:
    content = result.get("content")
    if isinstance(content, list):
        texts = [
            str(item.get("text"))
            for item in content
            if isinstance(item, Mapping) and item.get("type") == "text" and item.get("text")
        ]
        if texts:
            return " ".join(texts)[:300]
    return "tool call failed"


def fake_sibyl_search(arguments: Mapping[str, Any]) -> dict[str, Any]:
    query = str(arguments.get("query") or arguments.get("text") or "").strip()
    limit = int(arguments.get("limit") or arguments.get("top_k") or 3)
    namespace = str(arguments.get("namespace") or "default")
    corpus = [
        {
            "id": "mem_1",
            "text": "Refund requests require a receipt lookup before approval.",
            "score": 0.98,
            "source": "policy",
        },
        {
            "id": "mem_2",
            "text": "Escalate trust-state changes to a human reviewer.",
            "score": 0.86,
            "source": "runbook",
        },
        {
            "id": "mem_3",
            "text": "Sibyl-Memory indexes local notes for retrieval over MCP.",
            "score": 0.71,
            "source": "docs",
        },
    ]
    lowered = query.lower()
    ranked = sorted(
        corpus,
        key=lambda item: (lowered in item["text"].lower(), item["score"]),
        reverse=True,
    )[: max(1, limit)]
    return {
        "content": [{"type": "text", "text": f"Found {len(ranked)} memory hits for: {query}"}],
        "structuredContent": {
            "query": query,
            "namespace": namespace,
            "results": ranked,
            "provider": "sibyl-memory-demo",
        },
    }


def run_fake_mcp_server() -> int:
    tools = [
        {
            "name": "sibyl_memory.search_memories",
            "description": "Search memory entries relevant to a natural-language query.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "limit": {"type": "integer", "minimum": 1, "default": 5},
                    "namespace": {"type": "string", "default": "default"},
                },
                "required": ["query"],
            },
        },
        {
            "name": "sibyl_memory.store_memory",
            "description": "Store a memory entry.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "text": {"type": "string"},
                    "namespace": {"type": "string"},
                },
                "required": ["text"],
            },
        },
    ]
    handlers = {"sibyl_memory.search_memories": fake_sibyl_search}
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(message, Mapping):
            continue
        method = message.get("method")
        request_id = message.get("id")
        if method == "initialize" and request_id is not None:
            response = {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "serverInfo": {"name": "sibyl-memory-demo", "version": "0.1.0"},
                    "capabilities": {"tools": {}},
                },
            }
        elif method == "tools/list" and request_id is not None:
            response = {"jsonrpc": "2.0", "id": request_id, "result": {"tools": tools}}
        elif method == "tools/call" and request_id is not None:
            params = message.get("params") if isinstance(message.get("params"), Mapping) else {}
            tool_name = params.get("name")
            arguments = params.get("arguments") if isinstance(params.get("arguments"), Mapping) else {}
            handler = handlers.get(str(tool_name))
            if handler is None:
                response = {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "error": {"code": -32601, "message": f"Unknown tool: {tool_name}"},
                }
            else:
                response = {"jsonrpc": "2.0", "id": request_id, "result": handler(arguments)}
        else:
            continue
        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()
    return 0


def run_self_test() -> dict[str, Any]:
    writer_only_tool = {
        "name": "sibyl_memory.store_memory",
        "description": "Store a memory entry.",
        "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}},
    }
    try:
        select_memory_tool([writer_only_tool])
        raise AssertionError("writer-only tool should not be selected for retrieval")
    except SibylToolSelectionError:
        pass

    closed_query_tool = {
        "name": "sibyl_memory.search_memories",
        "description": "Search memory entries.",
        "inputSchema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {"query": {"type": "string"}},
        },
    }
    assert build_tool_arguments(closed_query_tool, {"query": "refund", "top_k": 2, "namespace": "demo"}) == {"query": "refund"}
    try:
        build_tool_arguments(closed_query_tool, {"query": "refund", "top_k": 999})
        raise AssertionError("oversized top_k should be rejected")
    except ValueError as exc:
        assert "<= 50" in str(exc)

    adapter = SibylMemoryExecuteAdapter(
        command=[sys.executable, __file__, "--fake-mcp-server"],
        namespace="demo-space",
    )
    try:
        tools = adapter.list_tools()
        assert any(tool["name"] == "sibyl_memory.search_memories" for tool in tools)
        manifest = adapter.build_manifest()
        assert manifest["provider"]["runtime"] == "local"
        result = adapter.execute(
            "search relevant memory for the user request",
            {"query": "refund workflow receipt", "top_k": 2},
        )
        assert result["ok"] is True
        assert result["tool"] == "sibyl_memory.search_memories"
        normalized = result["result"]
        assert isinstance(normalized, Mapping)
        assert normalized.get("provider") == "sibyl-memory-demo"
        assert len(normalized.get("results", [])) == 2
        assert result["receipt"]["provider_id"] == DEFAULT_PROVIDER_ID
        assert result["manifest"]["id"] == f"{DEFAULT_PROVIDER_ID}.execute_memory"
        repeated = adapter.execute(
            "search relevant memory for the user request",
            {"query": "refund workflow receipt", "top_k": 2},
        )
        assert repeated["receipt"]["invocation_id"] != result["receipt"]["invocation_id"]

        original_call_tool = adapter._client.call_tool
        adapter._client.call_tool = lambda _name, _arguments: {
            "isError": True,
            "content": [{"type": "text", "text": "memory backend unavailable"}],
        }
        failed = adapter.execute(
            "search relevant memory for the user request",
            {"query": "refund workflow receipt", "top_k": 2},
        )
        adapter._client.call_tool = original_call_tool
        assert failed["ok"] is False
        assert failed["receipt"]["ok"] is False
        assert failed["error"]["type"] == "McpProtocolError"
        return {
            "self_test": "passed",
            "tool_count": len(tools),
            "selected_tool": result["tool"],
            "result": result,
        }
    finally:
        adapter.close()


def build_demo_adapter() -> SibylMemoryExecuteAdapter:
    command_env = os.environ.get("SIBYL_MEMORY_COMMAND")
    if command_env:
        command = command_env.split()
    else:
        command = [sys.executable, __file__, "--fake-mcp-server"]
    return SibylMemoryExecuteAdapter(
        command=command,
        preferred_tool_name=os.environ.get("SIBYL_MEMORY_TOOL_NAME") or None,
        namespace=os.environ.get("SIBYL_MEMORY_NAMESPACE", DEFAULT_NAMESPACE),
        timeout_ms=DEFAULT_TIMEOUT_MS,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Sibyl-Memory local execute() adapter with MCP manifest integration")
    parser.add_argument("--fake-mcp-server", action="store_true", help="Run the embedded demo MCP server")
    parser.add_argument("--self-test", action="store_true", help="Run inline self-test against the embedded fake MCP server")
    parser.add_argument("--print-manifest", action="store_true", help="Print the MCP integration manifest JSON")
    parser.add_argument("--write-manifest", metavar="PATH", help="Write the MCP manifest JSON to PATH")
    parser.add_argument("--query", default="refund workflow receipt", help="Demo query for execute()")
    parser.add_argument("--top-k", type=int, default=2, help="Demo result limit")
    parser.add_argument("--namespace", default=DEFAULT_NAMESPACE, help="Demo namespace")
    args = parser.parse_args(argv)

    if args.fake_mcp_server:
        return run_fake_mcp_server()

    if args.self_test:
        print(json.dumps(run_self_test(), indent=2, ensure_ascii=False))
        return 0

    adapter = build_demo_adapter()
    try:
        if args.print_manifest:
            print(json.dumps(adapter.build_manifest(), indent=2, ensure_ascii=False))
            return 0
        if args.write_manifest:
            path = adapter.write_manifest(args.write_manifest)
            print(json.dumps({"wrote_manifest": str(path)}, indent=2, ensure_ascii=False))
            return 0
        result = adapter.execute(
            "search relevant memory for the user request",
            {"query": args.query, "top_k": args.top_k, "namespace": args.namespace},
        )
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return 0 if result.get("ok") else 1
    finally:
        adapter.close()


if __name__ == "__main__":
    raise SystemExit(main())
