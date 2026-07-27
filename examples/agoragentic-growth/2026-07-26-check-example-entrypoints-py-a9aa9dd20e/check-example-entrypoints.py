#!/usr/bin/env python3
"""Offline smoke checker for documented example entrypoints.

The checker validates that README command examples point at local files and that
Python entrypoints compile. It does not execute examples or access the network.
"""

from __future__ import annotations

import argparse
import ast
import os
import re
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Optional, Sequence, Tuple


@dataclass(frozen=True)
class Finding:
    path: Path
    line: int
    message: str

    def render(self) -> str:
        return f"{self.path}:{self.line}: {self.message}"


@dataclass(frozen=True)
class Command:
    directory: Path
    line: int
    interpreter: str
    entrypoint: str


INTERPRETERS = {"python", "python3", "node"}
README_NAMES = {"README.md", "readme.md"}
FENCE_RE = re.compile(r"^\s*(```+|~~~+)\s*([^\s]*)")
ENV_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=(?:[^ ]*)\s+")


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return ""


def readmes(root: Path) -> Iterable[Path]:
    for current, directories, files in os.walk(root):
        directories[:] = sorted(d for d in directories if d not in {
            ".git", "node_modules", "__pycache__", ".venv", "venv"
        })
        for name in sorted(files):
            if name in README_NAMES:
                yield Path(current) / name


def command_from_line(directory: Path, number: int, line: str) -> Optional[Command]:
    text = line.strip()
    if not text or text.startswith(("#", "$")):
        text = text[1:].lstrip() if text.startswith("$") else text
    text = ENV_RE.sub("", text)
    parts = text.split()
    if len(parts) < 2 or parts[0] not in INTERPRETERS:
        return None
    interpreter = parts[0]
    entrypoint = parts[1]
    if entrypoint.startswith("-"):
        return None
    if "://" in entrypoint or entrypoint.startswith(("http:", "https:")):
        return None
    return Command(directory, number, interpreter, entrypoint)


def documented_commands(readme: Path) -> List[Command]:
    commands: List[Command] = []
    in_fence = False
    fence = ""
    for number, line in enumerate(read_text(readme).splitlines(), 1):
        match = FENCE_RE.match(line)
        if match:
            marker = match.group(1)
            if not in_fence:
                in_fence, fence = True, marker[0]
            elif marker[0] == fence:
                in_fence, fence = False, ""
            continue
        if in_fence:
            command = command_from_line(readme.parent, number, line)
            if command is not None:
                commands.append(command)
    return commands


def inside_repository(candidate: Path, repository: Path) -> bool:
    try:
        candidate.relative_to(repository)
    except ValueError:
        return False
    return True


def resolve_entrypoint(command: Command, repository: Path) -> Optional[Path]:
    raw = Path(command.entrypoint)
    if raw.is_absolute():
        return None

    repository = repository.resolve()
    readme_candidate = (command.directory / raw).resolve()
    normalized = command.entrypoint.replace("\\", "/")
    explicit_parent = normalized.startswith("../")

    candidates = [readme_candidate]
    if not explicit_parent:
        candidates.append((repository / raw).resolve())

    safe_candidates = [
        candidate for candidate in candidates
        if inside_repository(candidate, repository)
    ]
    if not safe_candidates:
        return None

    for candidate in safe_candidates:
        if candidate.is_file():
            return candidate

    root_style = normalized.removeprefix("./")
    if "/" in root_style and len(safe_candidates) > 1:
        return safe_candidates[-1]
    return safe_candidates[0]


def check_python(path: Path) -> Optional[str]:
    try:
        ast.parse(read_text(path), filename=str(path))
    except SyntaxError as error:
        return f"Python syntax error at line {error.lineno}: {error.msg}"
    return None


def check_command(command: Command, repository: Path) -> Optional[Finding]:
    entrypoint = resolve_entrypoint(command, repository)
    if entrypoint is None:
        return Finding(command.directory, command.line,
                       f"entrypoint escapes repository root: {command.entrypoint}")
    if not entrypoint.is_file():
        return Finding(command.directory, command.line,
                       f"missing {command.interpreter} entrypoint "
                       f"{command.entrypoint} (run it from {command.directory})")
    if command.interpreter in {"python", "python3"}:
        error = check_python(entrypoint)
        if error:
            return Finding(entrypoint, 1, error)
    return None


def check_root(root: Path) -> Tuple[List[Command], List[Finding]]:
    repository = root.resolve()
    commands: List[Command] = []
    findings: List[Finding] = []
    for readme in readmes(repository):
        found = documented_commands(readme)
        commands.extend(found)
        for command in found:
            finding = check_command(command, repository)
            if finding:
                findings.append(finding)
    return commands, findings


def make_case(files: dict[str, str]) -> Path:
    root = Path(tempfile.mkdtemp(prefix="entrypoint-smoke-"))
    for name, content in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    return root


def self_test() -> int:
    cases = [
        (
            "valid python example",
            {"README.md": "```sh\npython examples/run.py\n```\n",
             "examples/run.py": "print('offline')\n"},
            0,
        ),
        (
            "missing entrypoint",
            {"README.md": "```sh\npython examples/missing.py\n```\n"},
            1,
        ),
        (
            "invalid python",
            {"README.md": "```sh\npython examples/run.py\n```\n",
             "examples/run.py": "def broken(:\n"},
            1,
        ),
        (
            "node file existence",
            {"README.md": "```sh\nnode examples/run.mjs\n```\n",
             "examples/run.mjs": "console.log('offline');\n"},
            0,
        ),
        (
            "commands outside fences ignored",
            {"README.md": "python examples/missing.py\n"},
            0,
        ),
        (
            "environment prefix accepted",
            {"README.md": "```sh\nMODE=test python ./run.py\n```\n",
             "run.py": "print('ok')\n"},
            0,
        ),
        (
            "parent path accepted within repository",
            {"docs/README.md": "```sh\npython ../examples/run.py\n```\n",
             "examples/run.py": "print('ok')\n"},
            0,
        ),
        (
            "repository path accepted from nested README",
            {"docs/README.md": "```sh\npython examples/run.py\n```\n",
             "examples/run.py": "print('ok')\n"},
            0,
        ),
        (
            "README-local path remains supported",
            {"docs/README.md": "```sh\npython ./run.py\n```\n",
             "docs/run.py": "print('ok')\n"},
            0,
        ),
        (
            "parent path escaping repository rejected",
            {"docs/README.md": "```sh\npython ../../outside.py\n```\n"},
            1,
        ),
        (
            "unsupported command ignored",
            {"README.md": "```sh\ncurl https://example.invalid\n```\n"},
            0,
        ),
    ]
    failures = 0
    for name, files, expected in cases:
        root = make_case(files)
        _, findings = check_root(root)
        actual = int(bool(findings))
        if actual != expected:
            print(f"self-test failed: {name}: expected {expected}, got {actual}")
            failures += 1
    if failures:
        return 1
    print("self-test cases:", len(cases))
    print("AGOS_RUNTIME_OK")
    return 0


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Check local Python and Node entrypoints documented in README files."
    )
    parser.add_argument("root", nargs="?", default=".",
                        help="repository root to inspect (default: current directory)")
    parser.add_argument("--self-test", action="store_true",
                        help="run deterministic checker self-tests")
    return parser.parse_args(argv)


def main(argv: Sequence[str]) -> int:
    args = parse_args(argv)
    if args.self_test:
        return self_test()
    root = Path(args.root).expanduser().resolve()
    if not root.is_dir():
        print(f"error: repository root is not a directory: {root}", file=sys.stderr)
        return 2
    commands, findings = check_root(root)
    if not commands:
        print(f"no Python or Node entrypoints found in README code fences under {root}")
    else:
        print(f"checked {len(commands)} documented entrypoint(s) under {root}")
    for finding in findings:
        print(f"ERROR {finding.render()}")
    if findings:
        print(f"failed: {len(findings)} issue(s); fix the documented path or working directory")
        return 1
    print("passed: entrypoints exist and Python sources parse without execution")
    print("AGOS_RUNTIME_OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
