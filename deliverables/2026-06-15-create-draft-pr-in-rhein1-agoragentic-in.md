# Agent OS Integration Guide

This guide shows how to connect a governed local agent runtime to an MCP server, expose a single `execute()` tool wrapper, and record execution receipts for audit and debugging.

The example below is intentionally minimal:

- local-only by default
- one MCP tool: `execute`
- explicit allowlist for runnable agent commands
- structured receipt logging for every invocation
- no direct shell passthrough from MCP clients

## What this integration provides

A local MCP server can act as the boundary between:

- an MCP client such as Claude Desktop, Cursor, Goose, or another agent host
- a governed local agent runtime such as an Agent OS worker, wrapper script, or brokered task runner

Instead of exposing raw shell access, the server exposes a single tool:

- `execute(task, agent, metadata?)`

That tool:

1. validates the requested agent
2. invokes a local wrapper command
3. captures stdout, stderr, exit code, and timing
4. writes a receipt to disk
5. returns a bounded response to the MCP client

## Prerequisites

- Python 3.10+
- a local agent runtime or wrapper command you can invoke from the terminal
- an MCP client that can launch a local stdio server

Install the Python MCP SDK:

```bash
python -m venv .venv
source .venv/bin/activate
pip install mcp
```

## Recommended directory layout

```text
agent-os-mcp/
├── receipts/
├── server.py
└── runner.sh
```

- `server.py` is the MCP server
- `runner.sh` is the local execution wrapper
- `receipts/` stores append-only execution receipts

## Step 1: create the local execution wrapper

Create `runner.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

AGENT_NAME="${1:?agent name required}"
TASK_TEXT="${2:?task text required}"

case "$AGENT_NAME" in
  planner|builder|reviewer)
    ;;
  *)
    echo "unsupported agent: $AGENT_NAME" >&2
    exit 64
    ;;
esac

WORKDIR="${AGENT_OS_WORKDIR:-$PWD}"

cd "$WORKDIR"

# Replace this block with the actual local runtime invocation used by your project.
# The important part is that the wrapper accepts controlled inputs and does not
# expose arbitrary shell execution.
exec python -m agoragentic_integrations.local_agent \
  --agent "$AGENT_NAME" \
  --task "$TASK_TEXT"
```

Make it executable:

```bash
chmod +x runner.sh
```

Notes:

- keep the allowlist in the wrapper, not only in the MCP layer
- do not pass untrusted input through `bash -c`
- prefer direct argv execution over shell interpolation

## Step 2: create the MCP server

Create `server.py`:

```python
from __future__ import annotations

import json
import os
import subprocess
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import FastMCP

mcp = FastMCP("agent-os-local")

BASE_DIR = Path(__file__).resolve().parent
RECEIPT_DIR = BASE_DIR / "receipts"
RECEIPT_DIR.mkdir(parents=True, exist_ok=True)

RUNNER = os.environ.get("AGENT_OS_RUNNER", str(BASE_DIR / "runner.sh"))
WORKDIR = os.environ.get("AGENT_OS_WORKDIR", str(BASE_DIR))
ALLOWED_AGENTS = {"planner", "builder", "reviewer"}
MAX_TASK_BYTES = 16_000
DEFAULT_TIMEOUT_SECONDS = 300


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def write_receipt(data: dict[str, Any]) -> str:
    receipt_id = data["receipt_id"]
    path = RECEIPT_DIR / f"{receipt_id}.json"
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return str(path)


def bounded_text(value: str, limit: int = 12_000) -> str:
    if len(value) <= limit:
        return value
    return value[:limit] + "\n...[truncated]"


@mcp.tool()
def execute(task: str, agent: str, metadata: dict[str, Any] | None = None) -> dict[str, Any]:
    """
    Execute a governed local agent task and return a bounded result with a receipt reference.

    Args:
        task: Human-readable task instruction for the local agent runtime.
        agent: Logical agent name. Must be one of the allowlisted agents.
        metadata: Optional structured metadata for correlation, labels, or tracing.
    """
    if agent not in ALLOWED_AGENTS:
        raise ValueError(f"unsupported agent '{agent}'. allowed: {sorted(ALLOWED_AGENTS)}")

    task_bytes = task.encode("utf-8")
    if not task.strip():
        raise ValueError("task must not be empty")
    if len(task_bytes) > MAX_TASK_BYTES:
        raise ValueError(f"task exceeds {MAX_TASK_BYTES} bytes")

    metadata = metadata or {}
    receipt_id = str(uuid.uuid4())
    started_at = utc_now_iso()
    start_time = time.monotonic()

    command = [RUNNER, agent, task]

    try:
        proc = subprocess.run(
            command,
            cwd=WORKDIR,
            capture_output=True,
            text=True,
            timeout=DEFAULT_TIMEOUT_SECONDS,
            check=False,
            env={
                **os.environ,
                "AGENT_OS_RECEIPT_ID": receipt_id,
            },
        )
        duration_ms = int((time.monotonic() - start_time) * 1000)

        receipt = {
            "receipt_id": receipt_id,
            "started_at": started_at,
            "finished_at": utc_now_iso(),
            "duration_ms": duration_ms,
            "status": "ok" if proc.returncode == 0 else "error",
            "agent": agent,
            "command": command,
            "workdir": WORKDIR,
            "metadata": metadata,
            "exit_code": proc.returncode,
            "stdout": bounded_text(proc.stdout),
            "stderr": bounded_text(proc.stderr),
        }
        receipt_path = write_receipt(receipt)

        return {
            "receipt_id": receipt_id,
            "receipt_path": receipt_path,
            "status": receipt["status"],
            "exit_code": proc.returncode,
            "stdout": bounded_text(proc.stdout, limit=4000),
            "stderr": bounded_text(proc.stderr, limit=4000),
            "duration_ms": duration_ms,
        }

    except subprocess.TimeoutExpired as exc:
        duration_ms = int((time.monotonic() - start_time) * 1000)
        receipt = {
            "receipt_id": receipt_id,
            "started_at": started_at,
            "finished_at": utc_now_iso(),
            "duration_ms": duration_ms,
            "status": "timeout",
            "agent": agent,
            "command": command,
            "workdir": WORKDIR,
            "metadata": metadata,
            "exit_code": None,
            "stdout": bounded_text(exc.stdout or ""),
            "stderr": bounded_text(exc.stderr or ""),
        }
        receipt_path = write_receipt(receipt)

        return {
            "receipt_id": receipt_id,
            "receipt_path": receipt_path,
            "status": "timeout",
            "exit_code": None,
            "stdout": bounded_text(exc.stdout or "", limit=4000),
            "stderr": bounded_text(exc.stderr or "", limit=4000),
            "duration_ms": duration_ms,
        }


if __name__ == "__main__":
    mcp.run()
```

## Step 3: understand the receipt format

Each `execute()` call writes one JSON file to `receipts/<receipt_id>.json`.

Example receipt:

```json
{
  "receipt_id": "9c7e6cf4-a521-4943-a855-c6100f2d18c2",
  "started_at": "2026-06-15T03:30:12.124991+00:00",
  "finished_at": "2026-06-15T03:30:14.004223+00:00",
  "duration_ms": 1879,
  "status": "ok",
  "agent": "planner",
  "command": [
    "/path/to/runner.sh",
    "planner",
    "Create a plan for receipt compaction"
  ],
  "workdir": "/path/to/workdir",
  "metadata": {
    "request_id": "req_123",
    "source": "local-dev"
  },
  "exit_code": 0,
  "stdout": "plan created",
  "stderr": ""
}
```

Recommended fields to keep stable:

- `receipt_id`: unique execution identifier
- `started_at`, `finished_at`, `duration_ms`: timing and latency
- `status`: `ok`, `error`, or `timeout`
- `agent`: logical execution target
- `metadata`: caller-supplied correlation data
- `exit_code`, `stdout`, `stderr`: execution result
- `command`, `workdir`: reproducibility context

## Step 4: connect the server to an MCP client

Most MCP clients support launching a local stdio server.

A typical client configuration looks like this:

```json
{
  "mcpServers": {
    "agent-os-local": {
      "command": "/absolute/path/to/.venv/bin/python",
      "args": ["/absolute/path/to/server.py"],
      "env": {
        "AGENT_OS_RUNNER": "/absolute/path/to/runner.sh",
        "AGENT_OS_WORKDIR": "/absolute/path/to/your/project"
      }
    }
  }
}
```

Update the paths for your environment.

After configuring the client, restart it and verify that the `agent-os-local` server appears with a single `execute` tool.

## Step 5: test the integration locally

Start the server through your MCP client, then invoke:

- `agent = "planner"`
- `task = "Summarize the steps needed to add receipt rotation"`

Expected behavior:

1. the MCP client lists the `execute` tool
2. the tool returns structured output
3. a new receipt file appears under `receipts/`
4. the receipt contains the same `receipt_id` returned to the client

If you want to test the wrapper directly first:

```bash
./runner.sh planner "Summarize the steps needed to add receipt rotation"
```

## Step 6: add basic governance controls

The minimum safe controls for a local integration are:

### 1. Agent allowlist

Only permit known logical agent names:

```python
ALLOWED_AGENTS = {"planner", "builder", "reviewer"}
```

Do not accept arbitrary executables from tool input.

### 2. Size limits

Cap task payload size to avoid runaway requests:

```python
MAX_TASK_BYTES = 16_000
```

### 3. Timeouts

Set a default subprocess timeout:

```python
DEFAULT_TIMEOUT_SECONDS = 300
```

### 4. Bounded output

Truncate large stdout and stderr before returning or persisting them.

### 5. Append-only receipts

Treat receipt files as audit artifacts. Avoid in-place mutation after write.

### 6. Metadata for correlation

Pass `metadata` from the caller for request IDs, ticket numbers, or run labels.

## Step 7: optional improvements

Once the minimal integration works, consider adding:

- receipt rotation by age or size
- a second tool for `get_receipt(receipt_id)`
- JSON schema validation for `metadata`
- per-agent timeout overrides
- a queue or broker between MCP and execution
- a policy layer for task classification before execution
- redaction rules for sensitive output before receipt persistence

## Troubleshooting

### Tool appears but execution always fails

Check:

- `AGENT_OS_RUNNER` points to an executable file
- `runner.sh` is executable
- the underlying runtime command exists in the active environment

### Receipts are not written

Check:

- the `receipts/` directory exists
- the process has write permissions
- `server.py` is running from the expected directory

### Agent is rejected as unsupported

Make sure the requested agent is present in both places:

- `ALLOWED_AGENTS` in `server.py`
- the allowlist `case` block in `runner.sh`

### Output is truncated

That is expected when stdout or stderr exceed the configured bounds. Use the receipt file for the persisted bounded record, or adjust the truncation limits if your runtime emits larger outputs.

## Security notes

This pattern is safer than exposing raw shell access, but it is not a sandbox by itself.

Keep these constraints in place:

- do not forward arbitrary shell commands from MCP tool input
- do not use `shell=True`
- do not interpolate untrusted input into `bash -c`
- keep the execution wrapper narrow and allowlisted
- log every invocation with a receipt ID
- run the local runtime with the least privileges it needs

## Summary

A practical Agent OS integration does not need a large surface area. A single governed `execute()` MCP tool, backed by a local wrapper and receipt logging, is enough to:

- expose local agent execution to MCP-compatible clients
- preserve a stable control boundary
- retain execution evidence for debugging and audit
- keep the integration simple enough to review and maintain

If your project already has an internal runner, you can usually adopt this guide by replacing only the `runner.sh` command body and preserving the MCP server, validation, and receipt structure.