"""
Python compatibility models for Agoragentic Rust framework HTTP/JSON runtimes.

These dataclasses mirror the serialized Rust contracts used by
``GET /health``, ``GET /.well-known/agent-card.json``, ``GET /tools``,
``POST /invoke``, ``POST /a2a/invoke``, and
``GET /schema/agoragentic-rust-framework.json``. They intentionally use only
the Python standard library so SDK users can validate and construct payloads
without a Rust binding or generated binary dependency.
"""

from __future__ import annotations

from dataclasses import dataclass, field, fields, is_dataclass
from enum import Enum
from typing import Any, Dict, List, Literal, Mapping, Optional, Union
import uuid


JsonValue = Union[None, bool, int, float, str, List["JsonValue"], Dict[str, "JsonValue"]]
InvocationStatusLiteral = Literal[
    "accepted",
    "running",
    "completed",
    "failed",
    "blocked",
    "cancelled",
]

RUST_FRAMEWORK_SCHEMA_ID = "https://agoragentic.com/schema/agoragentic-rust-framework.v1.json"
RUST_FRAMEWORK_LOCAL_SCHEMA_PATH = "/schema/agoragentic-rust-framework.json"
RUST_FRAMEWORK_LOCAL_AGENT_CARD_PATH = "/.well-known/agent-card.json"


class InvocationStatus(str, Enum):
    ACCEPTED = "accepted"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    BLOCKED = "blocked"
    CANCELLED = "cancelled"


class AgentErrorType(str, Enum):
    SERIALIZATION = "Serialization"
    TOOL = "Tool"
    DUPLICATE_TOOL = "DuplicateTool"
    PROVIDER = "Provider"
    INVALID_REQUEST = "InvalidRequest"
    NOT_FOUND = "NotFound"
    POLICY_BLOCKED = "PolicyBlocked"
    RUNTIME = "Runtime"


def _asdict(value: Any) -> Any:
    if isinstance(value, Enum):
        return value.value
    if is_dataclass(value):
        return {entry.name: _asdict(getattr(value, entry.name)) for entry in fields(value)}
    if isinstance(value, list):
        return [_asdict(item) for item in value]
    if isinstance(value, dict):
        return {key: _asdict(item) for key, item in value.items()}
    return value


def to_json_dict(value: Any) -> Dict[str, Any]:
    """Convert a Rust framework compatibility model into a JSON-ready dict."""
    converted = _asdict(value)
    if not isinstance(converted, dict):
        raise TypeError("to_json_dict expected a dataclass or mapping that converts to a dict")
    return converted


def _mapping(value: Mapping[str, Any], model_name: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise TypeError(f"{model_name}.from_dict expected a mapping")
    return value


def _string_list(value: Optional[Any]) -> List[str]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise TypeError("expected a list of strings")
    return [str(item) for item in value]


@dataclass
class TraceContext:
    trace_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    parent_span_id: Optional[str] = None
    marketplace_invocation_id: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return _asdict(self)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "TraceContext":
        item = _mapping(data, cls.__name__)
        return cls(
            trace_id=str(item.get("trace_id") or str(uuid.uuid4())),
            parent_span_id=item.get("parent_span_id"),
            marketplace_invocation_id=item.get("marketplace_invocation_id"),
        )


@dataclass
class ReceiptRef:
    receipt_id: str
    vendor_id: str
    amount_usdc: str

    def to_dict(self) -> Dict[str, Any]:
        return _asdict(self)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "ReceiptRef":
        item = _mapping(data, cls.__name__)
        return cls(
            receipt_id=str(item.get("receipt_id", "")),
            vendor_id=str(item.get("vendor_id", "")),
            amount_usdc=str(item.get("amount_usdc", "0")),
        )


@dataclass
class InvocationContext:
    messages: List[JsonValue] = field(default_factory=list)
    memory_refs: List[str] = field(default_factory=list)
    receipt_refs: List[ReceiptRef] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return _asdict(self)

    @classmethod
    def from_dict(cls, data: Optional[Mapping[str, Any]]) -> "InvocationContext":
        if data is None:
            return cls()
        item = _mapping(data, cls.__name__)
        return cls(
            messages=list(item.get("messages") or []),
            memory_refs=_string_list(item.get("memory_refs")),
            receipt_refs=[
                ReceiptRef.from_dict(ref)
                for ref in item.get("receipt_refs") or []
                if isinstance(ref, Mapping)
            ],
        )


@dataclass
class InvocationLimits:
    timeout_ms: int = 30000
    max_tokens: int = 8000
    max_cost_usdc: str = "0"

    def to_dict(self) -> Dict[str, Any]:
        return _asdict(self)

    @classmethod
    def from_dict(cls, data: Optional[Mapping[str, Any]]) -> "InvocationLimits":
        if data is None:
            return cls()
        item = _mapping(data, cls.__name__)
        return cls(
            timeout_ms=int(item.get("timeout_ms", 30000)),
            max_tokens=int(item.get("max_tokens", 8000)),
            max_cost_usdc=str(item.get("max_cost_usdc", "0")),
        )


@dataclass
class AgentError:
    type: str
    message: str

    def to_dict(self) -> Dict[str, Any]:
        return _asdict(self)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "AgentError":
        item = _mapping(data, cls.__name__)
        return cls(type=str(item.get("type", "")), message=str(item.get("message", "")))


@dataclass
class InvocationRequest:
    request_id: str
    agent_id: str
    task: str
    input: JsonValue
    context: InvocationContext = field(default_factory=InvocationContext)
    trace: TraceContext = field(default_factory=TraceContext)
    limits: InvocationLimits = field(default_factory=InvocationLimits)

    def to_dict(self) -> Dict[str, Any]:
        return _asdict(self)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "InvocationRequest":
        item = _mapping(data, cls.__name__)
        return cls(
            request_id=str(item.get("request_id", "")),
            agent_id=str(item.get("agent_id", "")),
            task=str(item.get("task", "")),
            input=item.get("input"),
            context=InvocationContext.from_dict(item.get("context")),
            trace=TraceContext.from_dict(item.get("trace") or {}),
            limits=InvocationLimits.from_dict(item.get("limits")),
        )


def invocation_request_from_raw(payload: Mapping[str, Any]) -> InvocationRequest:
    """Build a typed request from raw marketplace-compatible input payload."""
    item = _mapping(payload, "invocation_request_from_raw")
    if item.get("request_id") is not None and item.get("task") is not None and "input" in item:
        return InvocationRequest.from_dict(item)
    return InvocationRequest(
        request_id=str(item.get("request_id") or str(uuid.uuid4())),
        agent_id=str(item.get("agent_id") or ""),
        task=str(item.get("task") or "default"),
        input=dict(item),
        context=InvocationContext.from_dict(item.get("context") if isinstance(item.get("context"), Mapping) else None),
        trace=TraceContext.from_dict(item.get("trace") if isinstance(item.get("trace"), Mapping) else {}),
        limits=InvocationLimits.from_dict(item.get("limits") if isinstance(item.get("limits"), Mapping) else None),
    )


@dataclass
class InvocationResponse:
    request_id: str
    agent_id: str
    status: InvocationStatus
    output: Optional[JsonValue]
    tool_calls: List[JsonValue]
    memory_refs: List[str]
    events: List[JsonValue]
    error: Optional[AgentError]
    trace: TraceContext

    def to_dict(self) -> Dict[str, Any]:
        return _asdict(self)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "InvocationResponse":
        item = _mapping(data, cls.__name__)
        error = item.get("error")
        return cls(
            request_id=str(item.get("request_id", "")),
            agent_id=str(item.get("agent_id", "")),
            status=InvocationStatus(str(item.get("status", "failed"))),
            output=item.get("output"),
            tool_calls=list(item.get("tool_calls") or []),
            memory_refs=_string_list(item.get("memory_refs")),
            events=list(item.get("events") or []),
            error=AgentError.from_dict(error) if isinstance(error, Mapping) else None,
            trace=TraceContext.from_dict(item.get("trace") or {}),
        )


@dataclass
class ToolSideEffects:
    network: bool = False
    filesystem: bool = False
    wallet: bool = False
    external_write: bool = False

    def to_dict(self) -> Dict[str, Any]:
        return _asdict(self)

    @classmethod
    def from_dict(cls, data: Optional[Mapping[str, Any]]) -> "ToolSideEffects":
        if data is None:
            return cls()
        item = _mapping(data, cls.__name__)
        return cls(
            network=bool(item.get("network", False)),
            filesystem=bool(item.get("filesystem", False)),
            wallet=bool(item.get("wallet", False)),
            external_write=bool(item.get("external_write", False)),
        )


@dataclass
class ToolSpec:
    name: str
    description: str
    input_schema: Optional[JsonValue] = None
    output_schema: Optional[JsonValue] = None
    side_effects: ToolSideEffects = field(default_factory=ToolSideEffects)

    def to_dict(self) -> Dict[str, Any]:
        return _asdict(self)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "ToolSpec":
        item = _mapping(data, cls.__name__)
        return cls(
            name=str(item.get("name", "")),
            description=str(item.get("description", "")),
            input_schema=item.get("input_schema"),
            output_schema=item.get("output_schema"),
            side_effects=ToolSideEffects.from_dict(item.get("side_effects")),
        )


@dataclass
class ToolCall:
    call_id: str
    name: str
    input: JsonValue

    def to_dict(self) -> Dict[str, Any]:
        return _asdict(self)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "ToolCall":
        item = _mapping(data, cls.__name__)
        return cls(
            call_id=str(item.get("call_id", "")),
            name=str(item.get("name", "")),
            input=item.get("input"),
        )


@dataclass
class ToolResult:
    call_id: str
    name: str
    output: Optional[JsonValue] = None
    error: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return _asdict(self)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "ToolResult":
        item = _mapping(data, cls.__name__)
        return cls(
            call_id=str(item.get("call_id", "")),
            name=str(item.get("name", "")),
            output=item.get("output"),
            error=item.get("error"),
        )


@dataclass
class RuntimeInfo:
    language: str
    transport: str
    harness_compatible: bool

    def to_dict(self) -> Dict[str, Any]:
        return _asdict(self)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "RuntimeInfo":
        item = _mapping(data, cls.__name__)
        return cls(
            language=str(item.get("language", "")),
            transport=str(item.get("transport", "")),
            harness_compatible=bool(item.get("harness_compatible", False)),
        )


@dataclass
class RustFrameworkHealth:
    status: str
    framework: str
    framework_version: str
    agent_id: str
    runtime: RuntimeInfo

    def to_dict(self) -> Dict[str, Any]:
        return _asdict(self)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "RustFrameworkHealth":
        item = _mapping(data, cls.__name__)
        return cls(
            status=str(item.get("status", "")),
            framework=str(item.get("framework", "")),
            framework_version=str(item.get("framework_version", "")),
            agent_id=str(item.get("agent_id", "")),
            runtime=RuntimeInfo.from_dict(item.get("runtime") or {}),
        )


HealthResponse = RustFrameworkHealth


@dataclass
class AgentCardInterface:
    url: str
    protocolBinding: str
    protocolVersion: str

    def to_dict(self) -> Dict[str, Any]:
        return _asdict(self)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "AgentCardInterface":
        item = _mapping(data, cls.__name__)
        return cls(
            url=str(item.get("url", "")),
            protocolBinding=str(item.get("protocolBinding", "")),
            protocolVersion=str(item.get("protocolVersion", "")),
        )


@dataclass
class AgentCardProvider:
    organization: str
    url: str

    def to_dict(self) -> Dict[str, Any]:
        return _asdict(self)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "AgentCardProvider":
        item = _mapping(data, cls.__name__)
        return cls(
            organization=str(item.get("organization", "")),
            url=str(item.get("url", "")),
        )


@dataclass
class AgentCardCapabilities:
    streaming: bool
    pushNotifications: bool
    stateTransitionHistory: bool
    extendedAgentCard: bool

    def to_dict(self) -> Dict[str, Any]:
        return _asdict(self)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "AgentCardCapabilities":
        item = _mapping(data, cls.__name__)
        return cls(
            streaming=bool(item.get("streaming", False)),
            pushNotifications=bool(item.get("pushNotifications", False)),
            stateTransitionHistory=bool(item.get("stateTransitionHistory", False)),
            extendedAgentCard=bool(item.get("extendedAgentCard", False)),
        )


@dataclass
class AgentCardSkill:
    id: str
    name: str
    description: str
    tags: List[str] = field(default_factory=list)
    inputModes: List[str] = field(default_factory=list)
    outputModes: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return _asdict(self)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "AgentCardSkill":
        item = _mapping(data, cls.__name__)
        return cls(
            id=str(item.get("id", "")),
            name=str(item.get("name", "")),
            description=str(item.get("description", "")),
            tags=_string_list(item.get("tags")),
            inputModes=_string_list(item.get("inputModes")),
            outputModes=_string_list(item.get("outputModes")),
        )


@dataclass
class AgentCardResponse:
    name: str
    description: str
    supportedInterfaces: List[AgentCardInterface]
    provider: AgentCardProvider
    version: str
    documentationUrl: str
    capabilities: AgentCardCapabilities
    defaultInputModes: List[str]
    defaultOutputModes: List[str]
    skills: List[AgentCardSkill]
    extensions: Dict[str, JsonValue] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return _asdict(self)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "AgentCardResponse":
        item = _mapping(data, cls.__name__)
        return cls(
            name=str(item.get("name", "")),
            description=str(item.get("description", "")),
            supportedInterfaces=[
                AgentCardInterface.from_dict(interface)
                for interface in item.get("supportedInterfaces") or []
                if isinstance(interface, Mapping)
            ],
            provider=AgentCardProvider.from_dict(item.get("provider") or {}),
            version=str(item.get("version", "")),
            documentationUrl=str(item.get("documentationUrl", "")),
            capabilities=AgentCardCapabilities.from_dict(item.get("capabilities") or {}),
            defaultInputModes=_string_list(item.get("defaultInputModes")),
            defaultOutputModes=_string_list(item.get("defaultOutputModes")),
            skills=[
                AgentCardSkill.from_dict(skill)
                for skill in item.get("skills") or []
                if isinstance(skill, Mapping)
            ],
            extensions=dict(item.get("extensions") or {}),
        )


@dataclass
class A2aJsonRpcRequest:
    jsonrpc: str
    method: str
    params: Optional[JsonValue] = None
    id: Optional[JsonValue] = None

    def to_dict(self) -> Dict[str, Any]:
        return _asdict(self)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "A2aJsonRpcRequest":
        item = _mapping(data, cls.__name__)
        return cls(
            jsonrpc=str(item.get("jsonrpc", "2.0")),
            method=str(item.get("method", "")),
            params=item.get("params"),
            id=item.get("id"),
        )


@dataclass
class A2aJsonRpcError:
    code: int
    message: str
    data: Optional[JsonValue] = None

    def to_dict(self) -> Dict[str, Any]:
        return _asdict(self)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "A2aJsonRpcError":
        item = _mapping(data, cls.__name__)
        return cls(
            code=int(item.get("code", 0)),
            message=str(item.get("message", "")),
            data=item.get("data"),
        )


@dataclass
class A2aJsonRpcResponse:
    jsonrpc: str
    id: Optional[JsonValue] = None
    result: Optional[JsonValue] = None
    error: Optional[A2aJsonRpcError] = None

    def to_dict(self) -> Dict[str, Any]:
        return _asdict(self)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "A2aJsonRpcResponse":
        item = _mapping(data, cls.__name__)
        error = item.get("error")
        return cls(
            jsonrpc=str(item.get("jsonrpc", "2.0")),
            id=item.get("id"),
            result=item.get("result"),
            error=A2aJsonRpcError.from_dict(error) if isinstance(error, Mapping) else None,
        )


__all__ = [
    "A2aJsonRpcError",
    "A2aJsonRpcRequest",
    "A2aJsonRpcResponse",
    "AgentCardCapabilities",
    "AgentCardInterface",
    "AgentCardProvider",
    "AgentCardResponse",
    "AgentCardSkill",
    "AgentError",
    "AgentErrorType",
    "HealthResponse",
    "InvocationContext",
    "InvocationLimits",
    "InvocationRequest",
    "InvocationResponse",
    "InvocationStatus",
    "InvocationStatusLiteral",
    "JsonValue",
    "RUST_FRAMEWORK_LOCAL_AGENT_CARD_PATH",
    "RUST_FRAMEWORK_LOCAL_SCHEMA_PATH",
    "RUST_FRAMEWORK_SCHEMA_ID",
    "ReceiptRef",
    "RuntimeInfo",
    "RustFrameworkHealth",
    "ToolCall",
    "ToolResult",
    "ToolSideEffects",
    "ToolSpec",
    "TraceContext",
    "invocation_request_from_raw",
    "to_json_dict",
]
