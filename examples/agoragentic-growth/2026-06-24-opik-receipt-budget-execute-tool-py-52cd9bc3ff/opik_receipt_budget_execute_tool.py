from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import os
import sys
import threading
import time
import traceback
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Tuple

try:
    from crewai.tools import BaseTool  # type: ignore
except Exception:
    class BaseTool:  # minimal fallback so the file runs without CrewAI installed
        name: str = "tool"
        description: str = ""

        def run(self, *args: Any, **kwargs: Any) -> Any:
            return self._run(*args, **kwargs)

        def _run(self, *args: Any, **kwargs: Any) -> Any:
            raise NotImplementedError

try:
    from pydantic import BaseModel, Field  # type: ignore
except Exception:
    class BaseModel:
        def __init__(self, **kwargs: Any) -> None:
            for key, value in kwargs.items():
                setattr(self, key, value)

        def model_dump(self) -> Dict[str, Any]:
            return dict(self.__dict__)

    def Field(default: Any = None, **_: Any) -> Any:
        return default


class ExecuteToolInput(BaseModel):
    input_text: str = Field(default="")
    payload: Dict[str, Any] = Field(default_factory=dict)


class BudgetExceededError(RuntimeError):
    pass


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def compact_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def truncate_text(value: str, limit: int = 500) -> str:
    if len(value) <= limit:
        return value
    return value[: limit - 3] + "..."


def to_jsonable(value: Any, depth: int = 0) -> Any:
    if depth > 4:
        return truncate_text(repr(value), 300)
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, bytes):
        return {"type": "bytes", "sha256": hashlib.sha256(value).hexdigest(), "size": len(value)}
    if isinstance(value, Mapping):
        return {str(k): to_jsonable(v, depth + 1) for k, v in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [to_jsonable(v, depth + 1) for v in value]
    if hasattr(value, "model_dump") and callable(value.model_dump):
        try:
            return to_jsonable(value.model_dump(), depth + 1)
        except Exception:
            pass
    if hasattr(value, "dict") and callable(value.dict):
        try:
            return to_jsonable(value.dict(), depth + 1)
        except Exception:
            pass
    if hasattr(value, "__dict__"):
        try:
            return to_jsonable(vars(value), depth + 1)
        except Exception:
            pass
    return truncate_text(repr(value), 300)


def payload_digest(payload: Any) -> str:
    blob = compact_json(to_jsonable(payload)).encode("utf-8")
    return hashlib.sha256(blob).hexdigest()


def summarize_output(value: Any, limit: int = 240) -> str:
    text = compact_json(to_jsonable(value))
    return truncate_text(text, limit)


def maybe_parse_json_text(text: str) -> Tuple[Any, bool]:
    if not isinstance(text, str):
        return text, False
    stripped = text.strip()
    if not stripped:
        return text, False
    if stripped[0] not in "{[":
        return text, False
    try:
        return json.loads(stripped), True
    except Exception:
        return text, False


async def _await_if_needed(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value


def resolve_maybe_async(value: Any) -> Any:
    if not inspect.isawaitable(value):
        return value
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(_await_if_needed(value))

    holder: Dict[str, Any] = {}
    error: Dict[str, BaseException] = {}

    def runner() -> None:
        try:
            holder["value"] = asyncio.run(_await_if_needed(value))
        except BaseException as exc:  # pragma: no cover
            error["error"] = exc

    thread = threading.Thread(target=runner, daemon=True)
    thread.start()
    thread.join()
    if "error" in error:
        raise error["error"]
    return holder.get("value")


@dataclass
class BudgetSnapshot:
    currency: str
    total_budget: float
    spent: float
    remaining: float
    per_call_budget: Optional[float]
    receipt_count: int


class BudgetLedger:
    def __init__(
        self,
        total_budget: float,
        *,
        currency: str = "credits",
        per_call_budget: Optional[float] = None,
    ) -> None:
        if total_budget < 0:
            raise ValueError("total_budget must be non-negative")
        if per_call_budget is not None and per_call_budget < 0:
            raise ValueError("per_call_budget must be non-negative")
        self.currency = currency
        self.total_budget = float(total_budget)
        self.per_call_budget = None if per_call_budget is None else float(per_call_budget)
        self._spent = 0.0
        self._receipt_count = 0
        self._lock = threading.Lock()

    def snapshot(self) -> BudgetSnapshot:
        with self._lock:
            remaining = max(0.0, self.total_budget - self._spent)
            return BudgetSnapshot(
                currency=self.currency,
                total_budget=self.total_budget,
                spent=round(self._spent, 6),
                remaining=round(remaining, 6),
                per_call_budget=self.per_call_budget,
                receipt_count=self._receipt_count,
            )

    def can_spend(self, amount: float) -> Tuple[bool, str]:
        if amount < 0:
            return False, "negative spend is not allowed"
        snap = self.snapshot()
        if self.per_call_budget is not None and amount > self.per_call_budget:
            return False, (
                f"estimated cost {amount:.6f} exceeds per-call budget "
                f"{self.per_call_budget:.6f} {self.currency}"
            )
        if amount > snap.remaining:
            return False, (
                f"estimated cost {amount:.6f} exceeds remaining budget "
                f"{snap.remaining:.6f} {self.currency}"
            )
        return True, ""

    def charge(self, amount: float) -> BudgetSnapshot:
        if amount < 0:
            raise ValueError("amount must be non-negative")
        with self._lock:
            if self.per_call_budget is not None and amount > self.per_call_budget:
                raise BudgetExceededError(
                    f"actual cost {amount:.6f} exceeds per-call budget "
                    f"{self.per_call_budget:.6f} {self.currency}"
                )
            remaining = self.total_budget - self._spent
            if amount > remaining:
                raise BudgetExceededError(
                    f"actual cost {amount:.6f} exceeds remaining budget "
                    f"{remaining:.6f} {self.currency}"
                )
            self._spent += amount
            self._receipt_count += 1
            remaining_after = max(0.0, self.total_budget - self._spent)
            return BudgetSnapshot(
                currency=self.currency,
                total_budget=self.total_budget,
                spent=round(self._spent, 6),
                remaining=round(remaining_after, 6),
                per_call_budget=self.per_call_budget,
                receipt_count=self._receipt_count,
            )


@dataclass
class ExecutionReceipt:
    receipt_id: str
    tool_name: str
    opik_project: str
    opik_experiment: Optional[str]
    status: str
    started_at: str
    finished_at: str
    duration_ms: int
    input_digest: str
    input_preview: Any
    output_preview: Optional[str]
    error_type: Optional[str]
    error_message: Optional[str]
    stack_preview: Optional[str]
    estimated_cost: float
    actual_cost: float
    currency: str
    budget: Dict[str, Any]
    metadata: Dict[str, Any]

    def as_dict(self) -> Dict[str, Any]:
        return asdict(self)


class OpikReceiptSink:
    """
    Best-effort Opik event sink with a JSONL fallback.

    If an `opik` package is present, this sink tries a few common client/event methods.
    When none are available, it still writes receipts to a local JSONL file so the demo
    remains runnable and the receipts are preserved.
    """

    def __init__(
        self,
        *,
        project_name: str = "crewai-execute-tool",
        experiment_name: Optional[str] = None,
        jsonl_path: Optional[str] = None,
        also_stderr: bool = False,
    ) -> None:
        self.project_name = project_name
        self.experiment_name = experiment_name
        self.jsonl_path = jsonl_path or os.environ.get("OPIK_RECEIPT_JSONL", "opik_receipts.jsonl")
        self.also_stderr = also_stderr
        self._client = None
        self._module = None

        try:
            import opik  # type: ignore

            self._module = opik
            client_cls = getattr(opik, "Opik", None)
            if callable(client_cls):
                try:
                    self._client = client_cls()
                except Exception:
                    self._client = None
        except Exception:
            self._module = None
            self._client = None

    def _emit_via_client(self, receipt: Dict[str, Any]) -> bool:
        payload = {
            "name": "crewai.execute.receipt",
            "project_name": self.project_name,
            "experiment_name": self.experiment_name,
            "metadata": receipt,
        }
        client = self._client
        if client is None:
            return False

        attempts: List[Tuple[str, Tuple[Any, ...], Dict[str, Any]]] = [
            ("log_event", tuple(), payload),
            ("track", ("crewai.execute.receipt",), {"metadata": receipt}),
            ("log", (payload,), {}),
            ("create_event", tuple(), payload),
        ]
        for method_name, args, kwargs in attempts:
            method = getattr(client, method_name, None)
            if callable(method):
                try:
                    method(*args, **kwargs)
                    return True
                except TypeError:
                    continue
                except Exception:
                    return False
        return False

    def _emit_via_module(self, receipt: Dict[str, Any]) -> bool:
        module = self._module
        if module is None:
            return False

        track = getattr(module, "track", None)
        if callable(track):
            try:
                @track(name="crewai.execute.receipt")
                def _capture(**kwargs: Any) -> Dict[str, Any]:
                    return kwargs

                _capture(
                    project_name=self.project_name,
                    experiment_name=self.experiment_name,
                    metadata=receipt,
                )
                return True
            except Exception:
                return False
        return False

    def _emit_jsonl(self, receipt: Dict[str, Any]) -> None:
        line = compact_json(receipt)
        with open(self.jsonl_path, "a", encoding="utf-8") as handle:
            handle.write(line + "\n")
        if self.also_stderr:
            print(line, file=sys.stderr)

    def emit(self, receipt: ExecutionReceipt) -> None:
        receipt_dict = receipt.as_dict()
        delivered = self._emit_via_client(receipt_dict)
        if not delivered:
            delivered = self._emit_via_module(receipt_dict)
        self._emit_jsonl(receipt_dict)


def default_cost_estimator(payload: Dict[str, Any]) -> float:
    text = compact_json(to_jsonable(payload))
    base = 0.05
    size_component = min(2.5, len(text) / 1000.0)
    return round(base + size_component, 6)


def default_actual_cost_estimator(payload: Dict[str, Any], result: Any) -> float:
    input_cost = default_cost_estimator(payload)
    output_cost = len(summarize_output(result, 1000)) / 4000.0
    return round(input_cost + min(0.75, output_cost), 6)


class OpikReceiptBudgetExecuteTool(BaseTool):
    name: str = "opik_receipt_budget_execute"
    description: str = (
        "Wraps an execute callable with budget enforcement and receipt tracking "
        "for CrewAI and Opik."
    )
    args_schema = ExecuteToolInput

    def __init__(
        self,
        *,
        execute_fn: Callable[..., Any],
        total_budget: float,
        currency: str = "credits",
        per_call_budget: Optional[float] = None,
        tool_name: str = "opik_receipt_budget_execute",
        description: Optional[str] = None,
        opik_sink: Optional[OpikReceiptSink] = None,
        estimate_cost: Optional[Callable[[Dict[str, Any]], float]] = None,
        estimate_actual_cost: Optional[Callable[[Dict[str, Any], Any], float]] = None,
        failure_cost: float = 0.0,
        extra_metadata: Optional[Dict[str, Any]] = None,
    ) -> None:
        self.execute_fn = execute_fn
        self.name = tool_name
        self.description = description or self.description
        self.budget = BudgetLedger(
            total_budget=total_budget,
            currency=currency,
            per_call_budget=per_call_budget,
        )
        self.opik_sink = opik_sink or OpikReceiptSink()
        self.estimate_cost = estimate_cost or default_cost_estimator
        self.estimate_actual_cost = estimate_actual_cost or default_actual_cost_estimator
        self.failure_cost = max(0.0, float(failure_cost))
        self.extra_metadata = extra_metadata or {}

    def execute(self, *args: Any, **kwargs: Any) -> Any:
        receipt_id = f"rcpt_{uuid.uuid4().hex}"
        started_at = utc_now_iso()
        started_monotonic = time.monotonic()
        payload = {"args": to_jsonable(args), "kwargs": to_jsonable(kwargs)}
        input_hash = payload_digest(payload)
        input_preview = to_jsonable(payload)
        estimated_cost = round(float(self.estimate_cost(payload)), 6)

        allowed, reason = self.budget.can_spend(estimated_cost)
        if not allowed:
            finished_at = utc_now_iso()
            snap = self.budget.snapshot()
            receipt = ExecutionReceipt(
                receipt_id=receipt_id,
                tool_name=self.name,
                opik_project=self.opik_sink.project_name,
                opik_experiment=self.opik_sink.experiment_name,
                status="budget_rejected",
                started_at=started_at,
                finished_at=finished_at,
                duration_ms=int((time.monotonic() - started_monotonic) * 1000),
                input_digest=input_hash,
                input_preview=input_preview,
                output_preview=None,
                error_type="BudgetExceededError",
                error_message=reason,
                stack_preview=None,
                estimated_cost=estimated_cost,
                actual_cost=0.0,
                currency=snap.currency,
                budget=asdict(snap),
                metadata=dict(self.extra_metadata),
            )
            self.opik_sink.emit(receipt)
            raise BudgetExceededError(reason)

        try:
            result = resolve_maybe_async(self.execute_fn(*args, **kwargs))
            actual_cost = round(float(self.estimate_actual_cost(payload, result)), 6)
            snap = self.budget.charge(actual_cost)
            finished_at = utc_now_iso()
            receipt = ExecutionReceipt(
                receipt_id=receipt_id,
                tool_name=self.name,
                opik_project=self.opik_sink.project_name,
                opik_experiment=self.opik_sink.experiment_name,
                status="success",
                started_at=started_at,
                finished_at=finished_at,
                duration_ms=int((time.monotonic() - started_monotonic) * 1000),
                input_digest=input_hash,
                input_preview=input_preview,
                output_preview=summarize_output(result),
                error_type=None,
                error_message=None,
                stack_preview=None,
                estimated_cost=estimated_cost,
                actual_cost=actual_cost,
                currency=snap.currency,
                budget=asdict(snap),
                metadata=dict(self.extra_metadata),
            )
            self.opik_sink.emit(receipt)
            return result
        except Exception as exc:
            finished_at = utc_now_iso()
            charge_amount = self.failure_cost
            try:
                snap = self.budget.charge(charge_amount)
            except BudgetExceededError:
                snap = self.budget.snapshot()
            receipt = ExecutionReceipt(
                receipt_id=receipt_id,
                tool_name=self.name,
                opik_project=self.opik_sink.project_name,
                opik_experiment=self.opik_sink.experiment_name,
                status="error",
                started_at=started_at,
                finished_at=finished_at,
                duration_ms=int((time.monotonic() - started_monotonic) * 1000),
                input_digest=input_hash,
                input_preview=input_preview,
                output_preview=None,
                error_type=type(exc).__name__,
                error_message=str(exc),
                stack_preview=truncate_text(traceback.format_exc(), 1200),
                estimated_cost=estimated_cost,
                actual_cost=charge_amount,
                currency=snap.currency,
                budget=asdict(snap),
                metadata=dict(self.extra_metadata),
            )
            self.opik_sink.emit(receipt)
            raise

    def _run(self, input_text: str = "", payload: Optional[Dict[str, Any]] = None, **kwargs: Any) -> Any:
        payload = dict(payload or {})
        if input_text and not payload:
            parsed, ok = maybe_parse_json_text(input_text)
            if ok and isinstance(parsed, dict):
                payload = parsed
            else:
                payload = {"input_text": input_text}
        payload.update(kwargs)
        return self.execute(**payload)


def demo_worker(task: str, repeat: int = 1, fail: bool = False) -> Dict[str, Any]:
    if fail:
        raise ValueError("demo failure requested")
    result = " ".join(task.upper() for _ in range(repeat))
    return {"task": task, "repeat": repeat, "result": result, "length": len(result)}


def _print_demo_banner(path: str) -> None:
    print(f"receipts_jsonl={path}")
    print("demo_start")


def _print_demo_result(label: str, value: Any) -> None:
    print(f"{label}={compact_json(to_jsonable(value))}")


def main(argv: Optional[Iterable[str]] = None) -> int:
    _ = list(argv or sys.argv[1:])
    sink = OpikReceiptSink(
        project_name="demo-crewai-governed-runtime",
        experiment_name="self-test",
        jsonl_path=os.environ.get("OPIK_RECEIPT_JSONL", "opik_receipts.jsonl"),
        also_stderr=False,
    )
    tool = OpikReceiptBudgetExecuteTool(
        execute_fn=demo_worker,
        total_budget=3.0,
        per_call_budget=1.5,
        currency="credits",
        tool_name="demo_governed_execute",
        description="Demo governed execute wrapper with receipt + budget tracking.",
        opik_sink=sink,
        failure_cost=0.05,
        extra_metadata={"demo": True, "note": "self-test only"},
    )

    _print_demo_banner(sink.jsonl_path)

    first = tool.execute(task="ship receipt tracking", repeat=1)
    _print_demo_result("first_call", first)

    second = tool._run(payload={"task": "wrap execute", "repeat": 2})
    _print_demo_result("second_call", second)

    try:
        tool.execute(task="force an error", fail=True)
    except Exception as exc:
        _print_demo_result("third_call_error", {"type": type(exc).__name__, "message": str(exc)})

    try:
        tool.execute(task="consume remaining budget", repeat=10)
    except Exception as exc:
        _print_demo_result("fourth_call_budget", {"type": type(exc).__name__, "message": str(exc)})

    _print_demo_result("final_budget", asdict(tool.budget.snapshot()))
    print("demo_done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
