#!/usr/bin/env python3
"""
Minimal runnable MCP-style server wrapper exposing one governed `execute` tool.

What it demonstrates:
- a tiny MCP-compatible JSON-RPC-over-stdio loop for `initialize`, `tools/list`,
  and `tools/call`
- a governed local runtime around a third-party tool
- policy checks before execution
- execution receipts with hashes, timing, and captured output
- a runnable demo and inline self-test with no external dependencies

Run:
  python3 examples/mcp_execute_json_tool_wrapper.py
  python3 examples/mcp_execute_json_tool_wrapper.py --self-test
  python3 examples/mcp_execute_json_tool_wrapper.py --serve

Example MCP request (newline-delimited JSON):
  {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"demo"}}}
  {"jsonrpc":"2.0","id":2,"method":"tools/list"}
  {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"execute","arguments":{"tool":"python_json_tool","stdin":"{\"a\":1,\"b\":[3,2,1]}"}}}
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shlex
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass
from typing import Any, Dict, List, Optional


def _sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _utc_epoch_ms() -> int:
    return int(time.time() * 1000)


@dataclass(frozen=True)
class GovernedTool:
    name: str
    argv: List[str]
    description: str
    accepts_stdin: bool = True
    max_stdin_bytes: int = 64 * 1024
    timeout_seconds: float = 5.0


class PolicyError(RuntimeError):
    pass


class ExecutionError(RuntimeError):
    pass


class GovernedRuntime:
    """
    Minimal governed local execution runtime.

    Policy model:
    - tool must be selected from an explicit allowlist
    - argv is fixed by policy; callers do not supply arbitrary commands
    - stdin size is capped
    - timeout is enforced
    """

    def __init__(self, tools: List[GovernedTool]) -> None:
        self._tools = {tool.name: tool for tool in tools}

    def describe_tools(self) -> List[Dict[str, Any]]:
        return [
            {
                "name": "execute",
                "description": "Execute an allowlisted local tool and return a receipt plus captured output.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "tool": {
                            "type": "string",
                            "description": "Allowlisted tool name.",
                            "enum": sorted(self._tools.keys()),
                        },
                        "stdin": {
                            "type": "string",
                            "description": "Optional UTF-8 stdin content for the tool.",
                        },
                        "timeout_seconds": {
                            "type": "number",
                            "minimum": 0.1,
                            "description": "Optional caller-requested timeout; effective timeout is min(requested, policy max).",
                        },
                    },
                    "required": ["tool"],
                    "additionalProperties": False,
                },
            }
        ]

    def execute(
        self,
        *,
        tool: str,
        stdin: str = "",
        timeout_seconds: Optional[float] = None,
    ) -> Dict[str, Any]:
        selected = self._tools.get(tool)
        if selected is None:
            raise PolicyError(f"tool not allowlisted: {tool}")

        if not selected.accepts_stdin and stdin:
            raise PolicyError(f"tool does not accept stdin: {tool}")

        stdin_bytes = stdin.encode("utf-8")
        if len(stdin_bytes) > selected.max_stdin_bytes:
            raise PolicyError(
                f"stdin too large for {tool}: {len(stdin_bytes)} bytes > {selected.max_stdin_bytes} bytes"
            )

        effective_timeout = selected.timeout_seconds
        if timeout_seconds is not None:
            effective_timeout = max(0.1, min(float(timeout_seconds), selected.timeout_seconds))

        started_ms = _utc_epoch_ms()
        receipt_id = f"rcpt_{uuid.uuid4().hex[:16]}"
        command_display = " ".join(shlex.quote(part) for part in selected.argv)

        try:
            proc = subprocess.run(
                selected.argv,
                input=stdin_bytes if selected.accepts_stdin else None,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=effective_timeout,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            finished_ms = _utc_epoch_ms()
            partial_stdout = (
                exc.stdout.decode("utf-8", errors="replace")
                if isinstance(exc.stdout, (bytes, bytearray))
                else (exc.stdout or "")
            )
            partial_stderr = (
                exc.stderr.decode("utf-8", errors="replace")
                if isinstance(exc.stderr, (bytes, bytearray))
                else (exc.stderr or "")
            )
            return {
                "ok": False,
                "receipt": {
                    "id": receipt_id,
                    "tool": tool,
                    "command": command_display,
                    "status": "timeout",
                    "started_ms": started_ms,
                    "finished_ms": finished_ms,
                    "duration_ms": finished_ms - started_ms,
                    "policy": {
                        "allowlisted": True,
                        "max_stdin_bytes": selected.max_stdin_bytes,
                        "timeout_seconds": selected.timeout_seconds,
                        "effective_timeout_seconds": effective_timeout,
                    },
                    "request": {
                        "stdin_sha256": _sha256_text(stdin),
                        "stdin_bytes": len(stdin_bytes),
                    },
                    "result": {
                        "exit_code": None,
                        "stdout_sha256": _sha256_text(partial_stdout),
                        "stderr_sha256": _sha256_text(partial_stderr),
                        "stdout_bytes": len(partial_stdout.encode("utf-8")),
                        "stderr_bytes": len(partial_stderr.encode("utf-8")),
                    },
                },
                "stdout": partial_stdout,
                "stderr": partial_stderr or f"timed out after {effective_timeout:.2f}s",
            }
        except OSError as exc:
            raise ExecutionError(f"failed to launch {tool}: {exc}") from exc

        finished_ms = _utc_epoch_ms()
        stdout_text = proc.stdout.decode("utf-8", errors="replace")
        stderr_text = proc.stderr.decode("utf-8", errors="replace")

        return {
            "ok": proc.returncode == 0,
            "receipt": {
                "id": receipt_id,
                "tool": tool,
                "command": command_display,
                "status": "ok" if proc.returncode == 0 else "error",
                "started_ms": started_ms,
                "finished_ms": finished_ms,
                "duration_ms": finished_ms - started_ms,
                "policy": {
                    "allowlisted": True,
                    "max_stdin_bytes": selected.max_stdin_bytes,
                    "timeout_seconds": selected.timeout_seconds,
                    "effective_timeout_seconds": effective_timeout,
                },
                "request": {
                    "stdin_sha256": _sha256_text(stdin),
                    "stdin_bytes": len(stdin_bytes),
                },
                "result": {
                    "exit_code": proc.returncode,
                    "stdout_sha256": _sha256_text(stdout_text),
                    "stderr_sha256": _sha256_text(stderr_text),
                    "stdout_bytes": len(proc.stdout),
                    "stderr_bytes": len(proc.stderr),
                },
            },
            "stdout": stdout_text,
            "stderr": stderr_text,
        }


class MinimalMCPServer:
    """
    Newline-delimited JSON-RPC 2.0 transport with a tiny MCP subset:
    - initialize
    - tools/list
    - tools/call
    """

    def __init__(self, runtime: GovernedRuntime) -> None:
        self.runtime = runtime
        self.server_info = {
            "name": "minimal-governed-execute-wrapper",
            "version": "0.1.0",
        }

    def handle(self, request: Dict[str, Any]) -> Dict[str, Any]:
        req_id = request.get("id")
        method = request.get("method")
        params = request.get("params") or {}

        try:
            if request.get("jsonrpc") != "2.0":
                raise ValueError("jsonrpc must be '2.0'")

            if method == "initialize":
                return self._ok(
                    req_id,
                    {
                        "protocolVersion": "2024-11-05",
                        "capabilities": {"tools": {}},
                        "serverInfo": self.server_info,
                    },
                )

            if method == "tools/list":
                return self._ok(req_id, {"tools": self.runtime.describe_tools()})

            if method == "tools/call":
                name = params.get("name")
                arguments = params.get("arguments") or {}
                if name != "execute":
                    raise PolicyError(f"unknown tool: {name}")
                result = self.runtime.execute(
                    tool=arguments["tool"],
                    stdin=arguments.get("stdin", ""),
                    timeout_seconds=arguments.get("timeout_seconds"),
                )
                return self._ok(
                    req_id,
                    {
                        "content": [
                            {
                                "type": "text",
                                "text": json.dumps(result, indent=2, sort_keys=True),
                            }
                        ],
                        "structuredContent": result,
                        "isError": not result["ok"],
                    },
                )

            raise ValueError(f"unsupported method: {method}")
        except Exception as exc:
            return self._err(req_id, code=-32000, message=str(exc))

    def serve_forever(self) -> int:
        for raw_line in sys.stdin:
            line = raw_line.strip()
            if not line:
                continue
            try:
                request = json.loads(line)
            except json.JSONDecodeError as exc:
                response = self._err(None, code=-32700, message=f"invalid json: {exc}")
            else:
                response = self.handle(request)
            sys.stdout.write(json.dumps(response, separators=(",", ":")) + "\n")
            sys.stdout.flush()
        return 0

    @staticmethod
    def _ok(req_id: Any, result: Dict[str, Any]) -> Dict[str, Any]:
        return {"jsonrpc": "2.0", "id": req_id, "result": result}

    @staticmethod
    def _err(req_id: Any, code: int, message: str) -> Dict[str, Any]:
        return {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}


def build_default_runtime() -> GovernedRuntime:
    python_exe = sys.executable or "python3"
    tools = [
        GovernedTool(
            name="python_json_tool",
            argv=[python_exe, "-m", "json.tool"],
            description="Pretty-print and validate JSON via the Python stdlib json.tool module.",
            accepts_stdin=True,
            max_stdin_bytes=64 * 1024,
            timeout_seconds=5.0,
        )
    ]
    return GovernedRuntime(tools)


def demo() -> int:
    runtime = build_default_runtime()
    print("== Local execute() demo ==")
    sample = '{"agent":"agoragentic","features":["policy","receipts","execution"]}'
    result = runtime.execute(tool="python_json_tool", stdin=sample)
    print("ok:", result["ok"])
    print("receipt_id:", result["receipt"]["id"])
    print("command:", result["receipt"]["command"])
    print("exit_code:", result["receipt"]["result"]["exit_code"])
    print("stdout:")
    print(result["stdout"].rstrip())
    if result["stderr"]:
        print("stderr:")
        print(result["stderr"].rstrip())

    print("\n== Minimal MCP request/response demo ==")
    server = MinimalMCPServer(runtime)
    request = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": "execute",
            "arguments": {
                "tool": "python_json_tool",
                "stdin": '{"x":1,"y":[2,3]}',
            },
        },
    }
    response = server.handle(request)
    print(json.dumps(response, indent=2, sort_keys=True))
    return 0


def self_test() -> int:
    runtime = build_default_runtime()

    ok_result = runtime.execute(tool="python_json_tool", stdin='{"z":1}')
    assert ok_result["ok"] is True
    assert ok_result["receipt"]["status"] == "ok"
    assert '"z": 1' in ok_result["stdout"]

    bad_result = runtime.execute(tool="python_json_tool", stdin='{"z":')
    assert bad_result["ok"] is False
    assert bad_result["receipt"]["status"] == "error"
    assert bad_result["receipt"]["result"]["exit_code"] != 0
    assert bad_result["stderr"]

    try:
        runtime.execute(tool="not_allowlisted", stdin="")
    except PolicyError:
        pass
    else:
        raise AssertionError("expected PolicyError for non-allowlisted tool")

    server = MinimalMCPServer(runtime)
    tools_list = server.handle({"jsonrpc": "2.0", "id": 10, "method": "tools/list"})
    assert tools_list["result"]["tools"][0]["name"] == "execute"

    call_resp = server.handle(
        {
            "jsonrpc": "2.0",
            "id": 11,
            "method": "tools/call",
            "params": {
                "name": "execute",
                "arguments": {"tool": "python_json_tool", "stdin": '{"ok":true}'},
            },
        }
    )
    structured = call_resp["result"]["structuredContent"]
    assert structured["ok"] is True
    assert structured["receipt"]["tool"] == "python_json_tool"

    print("self-test passed")
    return 0


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Minimal governed MCP execute wrapper example")
    parser.add_argument("--serve", action="store_true", help="Run newline-delimited JSON-RPC server over stdio")
    parser.add_argument("--self-test", action="store_true", help="Run inline self-test")
    return parser.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv)
    if args.self_test:
        return self_test()
    if args.serve:
        server = MinimalMCPServer(build_default_runtime())
        return server.serve_forever()
    return demo()


if __name__ == "__main__":
    raise SystemExit(main())