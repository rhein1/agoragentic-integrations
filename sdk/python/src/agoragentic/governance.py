"""Fail-closed local governance for existing Python tools.

This module governs only the wrapped in-process call. Its receipts are local
evidence and are never provider, deployment, payment, settlement, or on-chain
proof.
"""

from __future__ import annotations

import functools
import inspect
import json
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Mapping, Optional, Union


POLICY_SCHEMA = "agoragentic.local-governance-policy.v1"
RECEIPT_SCHEMA = "agoragentic.local-action-receipt.v1"
DEFAULT_POLICY_FILE = "agoragentic.yaml"
_DECISIONS = {"allow", "ask", "deny"}
_ACTION_RE = re.compile(r"^(?:\*|[a-z0-9][a-z0-9._:-]{0,127})$")
_ERROR_CODE_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")


class GovernanceError(RuntimeError):
    """Raised when a local action cannot cross its policy boundary."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        receipt: Optional[Dict[str, Any]] = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.receipt = receipt


def create_default_policy() -> Dict[str, Any]:
    """Return the policy emitted by ``npx agoragentic init --yes``."""
    return {
        "schema": POLICY_SCHEMA,
        "default_decision": "ask",
        "receipts": {
            "enabled": True,
            "directory": ".agoragentic/receipts",
        },
        "actions": {
            "process.run": {
                "decision": "ask",
                "approval": "explicit_cli_yes",
            }
        },
        "authority": {
            "spend": "owner_only",
            "retry": "owner_only",
        },
    }


def load_policy(
    policy: Union[str, os.PathLike, Mapping[str, Any]] = DEFAULT_POLICY_FILE,
    *,
    cwd: Optional[Union[str, os.PathLike]] = None,
) -> Dict[str, Any]:
    """Load a policy object or JSON-compatible YAML file."""
    if isinstance(policy, Mapping):
        return _validate_policy(dict(policy))

    root = _project_root(cwd)
    policy_path = _project_path(root, policy, "policy")
    if not policy_path.is_file():
        raise GovernanceError(
            "policy_missing",
            "No local governance policy found at {}. Run "
            '"npx agoragentic init --yes" first.'.format(_relative_path(root, policy_path)),
        )
    try:
        parsed = json.loads(policy_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise GovernanceError(
            "policy_invalid",
            "Policy must use JSON-compatible YAML: {}".format(exc),
        ) from exc
    if not isinstance(parsed, dict):
        raise GovernanceError("policy_invalid", "Policy root must be an object.")
    return _validate_policy(parsed)


def evaluate_policy(
    policy: Mapping[str, Any],
    action: str,
    *,
    approved: bool = False,
) -> Dict[str, Any]:
    """Return the normalized allow, ask, or deny decision for an action."""
    normalized_action = _normalize_action(action)
    validated = _validate_policy(dict(policy))
    rule = validated["actions"].get(normalized_action) or validated["actions"].get("*") or {}
    decision = rule.get("decision") or validated["default_decision"]
    execute = decision == "allow" or (decision == "ask" and approved is True)
    if decision == "deny":
        reason = "policy_denied"
    elif decision == "ask" and not approved:
        reason = "explicit_approval_required"
    else:
        reason = "policy_boundary_passed"
    authority = validated.get("authority") or {}
    return {
        "action": normalized_action,
        "decision": decision,
        "approval_required": decision == "ask",
        "approval_granted": approved if decision == "ask" else None,
        "execute": execute,
        "reason": reason,
        "authority": {
            "spend": authority.get("spend", "owner_only"),
            "retry": authority.get("retry", "owner_only"),
        },
    }


def govern(
    tool: Callable[..., Any],
    *,
    action: str,
    policy: Union[str, os.PathLike, Mapping[str, Any]] = DEFAULT_POLICY_FILE,
    receipts: Optional[bool] = None,
    approved: bool = False,
    approve: Optional[Callable[[Dict[str, Any]], Any]] = None,
    evidence: Optional[Callable[[Any], Any]] = None,
    on_receipt: Optional[Callable[[Optional[Dict[str, Any]]], Any]] = None,
    cwd: Optional[Union[str, os.PathLike]] = None,
) -> Callable[..., Any]:
    """Wrap a sync or async tool with a pre-action policy decision and receipt."""
    if not callable(tool):
        raise TypeError("govern(tool, ...) requires a callable")
    normalized_action = _normalize_action(action)

    if inspect.iscoroutinefunction(tool):
        return _govern_async(
            tool,
            action=normalized_action,
            policy_source=policy,
            receipts=receipts,
            approved=approved,
            approve=approve,
            evidence=evidence,
            on_receipt=on_receipt,
            cwd=cwd,
        )
    return _govern_sync(
        tool,
        action=normalized_action,
        policy_source=policy,
        receipts=receipts,
        approved=approved,
        approve=approve,
        evidence=evidence,
        on_receipt=on_receipt,
        cwd=cwd,
    )


def _govern_sync(
    tool: Callable[..., Any],
    **options: Any,
) -> Callable[..., Any]:
    @functools.wraps(tool)
    def wrapped(*args: Any, **kwargs: Any) -> Any:
        context = _prepare_invocation(options)
        request = _approval_request(context["action"], args, kwargs)
        resolved_approval = bool(options["approved"])
        if context["initial"]["decision"] == "ask" and not resolved_approval and options["approve"]:
            try:
                approval_result = options["approve"](request)
                if inspect.isawaitable(approval_result):
                    if hasattr(approval_result, "close"):
                        approval_result.close()
                    raise GovernanceError(
                        "approval_callback_async",
                        "A synchronous tool requires a synchronous approval callback.",
                    )
                resolved_approval = approval_result is True
            except Exception as exc:
                if isinstance(exc, GovernanceError) and exc.code == "approval_callback_async":
                    error = exc
                else:
                    error = GovernanceError("approval_failed", "Approval callback failed.")
                receipt = _write_pre_execution_failure(context, request, error.code)
                error.receipt = receipt
                raise error from exc

        decision = evaluate_policy(context["policy"], context["action"], approved=resolved_approval)
        _raise_if_blocked(context, decision, request)
        try:
            result = tool(*args, **kwargs)
        except Exception as exc:
            receipt = _write_failed_receipt(context, decision, request, exc)
            try:
                setattr(exc, "agoragentic_receipt", receipt)
            except (AttributeError, TypeError):
                pass
            raise
        if inspect.isawaitable(result):
            if hasattr(result, "close"):
                result.close()
            error = GovernanceError(
                "tool_result_async",
                "A synchronous governed tool returned an awaitable; declare the tool with async def.",
            )
            error.receipt = _write_evidence_failure(context, decision, request, error)
            raise error
        try:
            evidence_result = options["evidence"](result) if options["evidence"] else result
            if inspect.isawaitable(evidence_result):
                if hasattr(evidence_result, "close"):
                    evidence_result.close()
                raise GovernanceError(
                    "evidence_callback_async",
                    "The synchronous evidence callback returned an awaitable.",
                )
        except Exception as exc:
            error = exc if isinstance(exc, GovernanceError) else GovernanceError(
                "evidence_failed",
                "Post-action evidence capture failed after the tool completed.",
            )
            error.receipt = _write_evidence_failure(context, decision, request, error)
            raise error from exc
        receipt = _write_receipt(
            context,
            decision,
            outcome="completed",
            evidence=dict(request, result=_summarize_evidence(evidence_result)),
        )
        _notify_sync(options["on_receipt"], receipt)
        return result

    return wrapped


def _govern_async(
    tool: Callable[..., Any],
    **options: Any,
) -> Callable[..., Any]:
    @functools.wraps(tool)
    async def wrapped(*args: Any, **kwargs: Any) -> Any:
        context = _prepare_invocation(options)
        request = _approval_request(context["action"], args, kwargs)
        resolved_approval = bool(options["approved"])
        if context["initial"]["decision"] == "ask" and not resolved_approval and options["approve"]:
            try:
                approval_result = options["approve"](request)
                if inspect.isawaitable(approval_result):
                    approval_result = await approval_result
                resolved_approval = approval_result is True
            except Exception as exc:
                error = GovernanceError("approval_failed", "Approval callback failed.")
                receipt = _write_pre_execution_failure(context, request, error.code)
                error.receipt = receipt
                raise error from exc

        decision = evaluate_policy(context["policy"], context["action"], approved=resolved_approval)
        _raise_if_blocked(context, decision, request)
        try:
            result = await tool(*args, **kwargs)
        except Exception as exc:
            receipt = _write_failed_receipt(context, decision, request, exc)
            try:
                setattr(exc, "agoragentic_receipt", receipt)
            except (AttributeError, TypeError):
                pass
            raise
        try:
            evidence_result = options["evidence"](result) if options["evidence"] else result
            if inspect.isawaitable(evidence_result):
                evidence_result = await evidence_result
        except Exception as exc:
            error = GovernanceError(
                "evidence_failed",
                "Post-action evidence capture failed after the tool completed.",
            )
            error.receipt = _write_evidence_failure(context, decision, request, exc)
            raise error from exc
        receipt = _write_receipt(
            context,
            decision,
            outcome="completed",
            evidence=dict(request, result=_summarize_evidence(evidence_result)),
        )
        if options["on_receipt"]:
            try:
                callback_result = options["on_receipt"](receipt)
                if inspect.isawaitable(callback_result):
                    await callback_result
            except Exception as exc:
                raise GovernanceError(
                    "receipt_callback_failed",
                    "Receipt callback failed after the tool completed.",
                    receipt=receipt,
                ) from exc
        return result

    return wrapped


def _prepare_invocation(options: Dict[str, Any]) -> Dict[str, Any]:
    root = _project_root(options["cwd"])
    loaded = load_policy(options["policy_source"], cwd=root)
    policy = dict(loaded)
    if options["receipts"] is not None:
        policy["receipts"] = dict(policy.get("receipts") or {})
        policy["receipts"]["enabled"] = options["receipts"] is True
    _validate_policy(policy)
    _prepare_receipt_directory(policy, root)
    return {
        "action": options["action"],
        "policy": policy,
        "root": root,
        "started_at": _now_iso(),
        "initial": evaluate_policy(policy, options["action"], approved=bool(options["approved"])),
    }


def _raise_if_blocked(
    context: Dict[str, Any],
    decision: Dict[str, Any],
    request: Dict[str, Any],
) -> None:
    if decision["execute"]:
        return
    receipt = _write_receipt(
        context,
        decision,
        outcome="not_executed",
        evidence=request,
    )
    raise GovernanceError(
        decision["reason"],
        "Action {} was not executed: {}.".format(context["action"], decision["reason"]),
        receipt=receipt,
    )


def _write_pre_execution_failure(
    context: Dict[str, Any],
    request: Dict[str, Any],
    error_code: str,
) -> Optional[Dict[str, Any]]:
    return _write_receipt(
        context,
        context["initial"],
        outcome="approval_failed",
        evidence=dict(request, error_code=error_code),
    )


def _write_evidence_failure(
    context: Dict[str, Any],
    decision: Dict[str, Any],
    request: Dict[str, Any],
    error: Exception,
) -> Optional[Dict[str, Any]]:
    return _write_receipt(
        context,
        decision,
        outcome="completed_evidence_failed",
        evidence=dict(request, error_code=_safe_error_code(error)),
    )


def _write_failed_receipt(
    context: Dict[str, Any],
    decision: Dict[str, Any],
    request: Dict[str, Any],
    error: Exception,
) -> Optional[Dict[str, Any]]:
    return _write_receipt(
        context,
        decision,
        outcome="failed",
        evidence=dict(request, error_code=_safe_error_code(error)),
    )


def _write_receipt(
    context: Dict[str, Any],
    decision: Dict[str, Any],
    *,
    outcome: str,
    evidence: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    policy = context["policy"]
    if (policy.get("receipts") or {}).get("enabled") is False:
        return None
    directory = _prepare_receipt_directory(policy, context["root"])
    receipt_id = "alr_{}".format(uuid.uuid4().hex)
    receipt = {
        "schema": RECEIPT_SCHEMA,
        "receipt_id": receipt_id,
        "classification": "local_tool_evidence",
        "action": context["action"],
        "decision": decision,
        "outcome": outcome,
        "started_at": context["started_at"],
        "finished_at": _now_iso(),
        "evidence": evidence,
        "proof_scope": {
            "local_boundary": True,
            "host_execution": False,
            "provider_execution": False,
            "deployment": False,
            "payment": False,
            "settlement": False,
            "on_chain_verification": False,
        },
    }
    receipt_path = directory / "{}.json".format(receipt_id)
    with receipt_path.open("x", encoding="utf-8") as handle:
        json.dump(receipt, handle, indent=2, sort_keys=True)
        handle.write("\n")
    try:
        receipt_path.chmod(0o600)
    except OSError:
        pass
    returned = dict(receipt)
    returned["path"] = _relative_path(context["root"], receipt_path)
    return returned


def _prepare_receipt_directory(policy: Dict[str, Any], root: Path) -> Optional[Path]:
    receipts = policy.get("receipts") or {}
    if receipts.get("enabled") is False:
        return None
    directory = _project_path(
        root,
        receipts.get("directory") or ".agoragentic/receipts",
        "receipt directory",
    )
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    return directory


def _validate_policy(policy: Dict[str, Any]) -> Dict[str, Any]:
    if policy.get("schema") != POLICY_SCHEMA:
        raise GovernanceError("policy_invalid", "Policy schema must be {}.".format(POLICY_SCHEMA))
    _validate_decision(policy.get("default_decision"), "default_decision")
    actions = policy.get("actions")
    if not isinstance(actions, dict):
        raise GovernanceError("policy_invalid", "Policy actions must be an object.")
    for action, rule in actions.items():
        _normalize_action(action)
        if not isinstance(rule, dict):
            raise GovernanceError("policy_invalid", "Policy rule for {} must be an object.".format(action))
        _validate_decision(rule.get("decision"), "actions.{}.decision".format(action))
    receipts = policy.get("receipts")
    if receipts is not None:
        if not isinstance(receipts, dict):
            raise GovernanceError("policy_invalid", "Policy receipts must be an object.")
        if "enabled" in receipts and not isinstance(receipts["enabled"], bool):
            raise GovernanceError("policy_invalid", "receipts.enabled must be a boolean.")
        if "directory" in receipts and (
            not isinstance(receipts["directory"], str) or not receipts["directory"].strip()
        ):
            raise GovernanceError("policy_invalid", "receipts.directory must be a non-empty string.")
    authority = policy.get("authority")
    if authority is not None and not isinstance(authority, dict):
        raise GovernanceError("policy_invalid", "Policy authority must be an object.")
    authority = authority or {}
    if authority.get("spend", "owner_only") != "owner_only":
        raise GovernanceError("policy_invalid", "authority.spend must remain owner_only.")
    if authority.get("retry", "owner_only") != "owner_only":
        raise GovernanceError("policy_invalid", "authority.retry must remain owner_only.")
    return policy


def _approval_request(action: str, args: Any, kwargs: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "action": action,
        "argument_count": len(args) + len(kwargs),
        "keyword_names": sorted(str(key) for key in kwargs.keys())[:32],
    }


def _summarize_evidence(value: Any) -> Dict[str, Any]:
    if value is None:
        return {"type": "none"}
    if isinstance(value, Mapping):
        return {"type": "object", "keys": sorted(str(key) for key in value.keys())[:32]}
    if isinstance(value, (list, tuple, set, frozenset)):
        return {"type": "array", "length": len(value)}
    return {"type": type(value).__name__}


def _notify_sync(
    callback: Optional[Callable[[Optional[Dict[str, Any]]], Any]],
    receipt: Optional[Dict[str, Any]],
) -> None:
    if callback is None:
        return
    try:
        result = callback(receipt)
        if inspect.isawaitable(result):
            if hasattr(result, "close"):
                result.close()
            raise GovernanceError(
                "receipt_callback_async",
                "A synchronous tool requires a synchronous receipt callback.",
                receipt=receipt,
            )
    except GovernanceError:
        raise
    except Exception as exc:
        raise GovernanceError(
            "receipt_callback_failed",
            "Receipt callback failed after the tool completed.",
            receipt=receipt,
        ) from exc


def _project_root(cwd: Optional[Union[str, os.PathLike]]) -> Path:
    root = Path(cwd or os.getcwd()).resolve(strict=True)
    if not root.is_dir():
        raise GovernanceError("project_invalid", "Governance cwd must be a directory.")
    return root


def _project_path(root: Path, target: Union[str, os.PathLike], label: str) -> Path:
    candidate = Path(target)
    if not candidate.is_absolute():
        candidate = root / candidate
    resolved = candidate.resolve(strict=False)
    try:
        resolved.relative_to(root)
    except ValueError as exc:
        raise GovernanceError(
            "path_outside_project",
            "{} must stay inside the current project.".format(label),
        ) from exc
    return resolved


def _relative_path(root: Path, target: Path) -> str:
    return target.relative_to(root).as_posix()


def _normalize_action(action: str) -> str:
    normalized = str(action or "").strip().lower()
    if not _ACTION_RE.fullmatch(normalized):
        raise GovernanceError(
            "action_invalid",
            "Action must use lowercase letters, numbers, dots, underscores, colons, or dashes.",
        )
    return normalized


def _validate_decision(value: Any, label: str) -> None:
    if value not in _DECISIONS:
        raise GovernanceError("policy_invalid", "{} must be allow, ask, or deny.".format(label))


def _safe_error_code(error: Exception) -> str:
    code = getattr(error, "code", None)
    if isinstance(code, str) and _ERROR_CODE_RE.fullmatch(code):
        return code
    return type(error).__name__


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


__all__ = [
    "DEFAULT_POLICY_FILE",
    "POLICY_SCHEMA",
    "RECEIPT_SCHEMA",
    "GovernanceError",
    "create_default_policy",
    "evaluate_policy",
    "govern",
    "load_policy",
]
