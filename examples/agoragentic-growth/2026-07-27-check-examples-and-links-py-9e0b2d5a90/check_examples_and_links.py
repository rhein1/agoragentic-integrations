#!/usr/bin/env python3
"""Offline checks for example entrypoints and relative Markdown links."""

from __future__ import annotations

import argparse
import ast
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Iterable, List, Optional, Sequence, Tuple

LINK_RE = re.compile(r"!?\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)")
REFERENCE_DEFINITION_RE = re.compile(
    r"^\s{0,3}\[([^\]]+)\]:\s*(?:<([^>]+)>|(\S+))"
)
REFERENCE_USAGE_RE = re.compile(r"!?\[([^\]]+)\]\[([^\]]*)\]")
ENTRY_NAMES = re.compile(
    r"(?:^|[-_.])(example|demo|run|smoke|quickstart|x402_execute)(?:[-_.]|$)",
    re.IGNORECASE,
)
SOURCE_SUFFIXES = {".py", ".mjs", ".js", ".cjs"}
SKIP_PARTS = {".git", "node_modules", "__pycache__", ".venv", "venv"}
NODE_CHECK_TIMEOUT_SECONDS = 10


def files_under(root: Path) -> Iterable[Path]:
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        if any(part in SKIP_PARTS for part in path.relative_to(root).parts):
            continue
        yield path


def normalize_reference_label(label: str) -> str:
    return " ".join(label.split()).casefold()


def is_relative_target(target: str) -> bool:
    if not target or target.startswith(("#", "/", "//")):
        return False
    return re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", target) is None


def relative_links(path: Path) -> Tuple[List[Tuple[str, int]], Optional[Tuple[str, int]]]:
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return [], None

    visible_lines: List[Tuple[int, str]] = []
    in_fence = False
    for number, line in enumerate(text.splitlines(), 1):
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        visible_lines.append((number, line))

    definitions = {}
    for number, line in visible_lines:
        match = REFERENCE_DEFINITION_RE.match(line)
        if not match:
            continue
        target = (match.group(2) or match.group(3) or "").strip()
        definitions.setdefault(
            normalize_reference_label(match.group(1)), (target, number)
        )

    links: List[Tuple[str, int]] = []
    for number, line in visible_lines:
        for match in LINK_RE.finditer(line):
            target = match.group(1).strip().strip("<>")
            if is_relative_target(target):
                links.append((target.split("#", 1)[0].split("?", 1)[0], number))

        if REFERENCE_DEFINITION_RE.match(line):
            continue
        for match in REFERENCE_USAGE_RE.finditer(line):
            label = match.group(2) or match.group(1)
            normalized = normalize_reference_label(label)
            definition = definitions.get(normalized)
            if definition is None:
                return links, (label, number)
            target, _definition_line = definition
            target = target.strip().strip("<>")
            if is_relative_target(target):
                links.append((target.split("#", 1)[0].split("?", 1)[0], number))
    return links, None


def first_broken_link(root: Path) -> Optional[str]:
    for document in files_under(root):
        if document.suffix.lower() not in {".md", ".markdown"}:
            continue
        links, missing_reference = relative_links(document)
        if missing_reference:
            label, line = missing_reference
            return (
                f"{document.relative_to(root)}:{line}: "
                f"missing reference definition: {label}"
            )
        for target, line in links:
            if not target:
                continue
            resolved = (document.parent / target).resolve()
            try:
                resolved.relative_to(root.resolve())
            except ValueError:
                return f"{document.relative_to(root)}:{line}: link escapes repository: {target}"
            if not resolved.exists():
                return f"{document.relative_to(root)}:{line}: missing relative link: {target}"
    return None


def is_entrypoint(path: Path, root: Path) -> bool:
    if path.suffix.lower() not in SOURCE_SUFFIXES:
        return False
    relative = path.relative_to(root)
    if "examples" not in {part.lower() for part in relative.parts}:
        return False
    stem = path.stem.lower()
    return bool(ENTRY_NAMES.search(stem)) or path.name.lower() in {
        "main.py",
        "main.mjs",
        "main.js",
        "index.mjs",
        "index.js",
    }


def check_javascript(path: Path) -> Optional[str]:
    node = shutil.which("node")
    if node is None:
        return "JavaScript syntax check requires Node.js"
    try:
        result = subprocess.run(
            [node, "--check", str(path)],
            capture_output=True,
            check=False,
            text=True,
            timeout=NODE_CHECK_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        return "JavaScript syntax check timed out"
    except OSError as exc:
        return f"cannot run JavaScript syntax check ({exc})"
    if result.returncode == 0:
        return None
    output = result.stderr or result.stdout
    diagnostic = next(
        (line.strip() for line in output.splitlines() if "SyntaxError" in line),
        f"Node.js exited with status {result.returncode}",
    )
    return f"JavaScript syntax error: {diagnostic}"


def check_entrypoint(path: Path) -> Optional[str]:
    try:
        source = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        return f"cannot read entrypoint ({exc})"
    if not source.strip():
        return "entrypoint is empty"
    if path.suffix.lower() == ".py":
        try:
            ast.parse(source, filename=str(path))
        except SyntaxError as exc:
            return f"Python syntax error at line {exc.lineno}: {exc.msg}"
    else:
        if "\x00" in source:
            return "entrypoint contains a NUL byte"
        return check_javascript(path)
    return None


def check_repository(root: Path) -> List[str]:
    findings: List[str] = []
    if not root.is_dir():
        return [f"repository root does not exist: {root}"]
    link_error = first_broken_link(root)
    if link_error:
        findings.append(link_error)
    for path in files_under(root):
        if not is_entrypoint(path, root):
            continue
        problem = check_entrypoint(path)
        if problem:
            findings.append(f"{path.relative_to(root)}: {problem}")
    return findings


def make_file(root: Path, name: str, text: str) -> None:
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def self_test() -> int:
    cases = [
        (
            "valid-inline-python",
            {"README.md": "[example](examples/demo.py)\n", "examples/demo.py": "print('ok')\n"},
            None,
        ),
        (
            "valid-reference-python",
            {
                "README.md": "[example][demo]\n\n[demo]: examples/demo.py\n",
                "examples/demo.py": "print('ok')\n",
            },
            None,
        ),
        (
            "missing-inline-link",
            {"README.md": "[gone](examples/nope.py)\n"},
            "missing relative link",
        ),
        (
            "missing-reference-definition",
            {"README.md": "[gone][missing-ref]\n"},
            "missing reference definition: missing-ref",
        ),
        (
            "reference-escape",
            {"README.md": "[outside][escape]\n\n[escape]: ../outside.md\n"},
            "link escapes repository",
        ),
        (
            "bad-python",
            {"README.md": "[ok](examples/demo.py)\n", "examples/demo.py": "def broken(:\n"},
            "Python syntax error",
        ),
        (
            "bad-javascript",
            {"README.md": "[ok](examples/demo.mjs)\n", "examples/demo.mjs": "const = ;\n"},
            "JavaScript syntax error",
        ),
        (
            "valid-javascript-string-delimiter",
            {
                "README.md": "[ok](examples/demo.mjs)\n",
                "examples/demo.mjs": 'console.log("{");\n',
            },
            None,
        ),
    ]
    for name, files, expected_finding in cases:
        with tempfile.TemporaryDirectory(prefix="agos-check-") as directory:
            root = Path(directory) / "repository"
            root.mkdir()
            for filename, content in files.items():
                make_file(root, filename, content)
            findings = check_repository(root)
            if expected_finding is None and findings:
                print(f"self-test failed: {name}: {findings}", file=sys.stderr)
                return 1
            if expected_finding is not None and not any(
                expected_finding in finding for finding in findings
            ):
                print(
                    f"self-test failed: {name}: expected {expected_finding!r}, "
                    f"got {findings}",
                    file=sys.stderr,
                )
                return 1
    print("AGOS_RUNTIME_OK")
    return 0


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Check local example entrypoints and relative Markdown links."
    )
    parser.add_argument(
        "root",
        nargs="?",
        default=".",
        help="repository root to inspect (default: current directory)",
    )
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="run deterministic tests using temporary local fixtures",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str]) -> int:
    arguments = parse_args(argv)
    if arguments.self_test:
        return self_test()
    root = Path(arguments.root).expanduser().resolve()
    findings = check_repository(root)
    if findings:
        print("AGOS_RUNTIME_FAIL")
        for finding in findings:
            print(f"- {finding}")
        return 1
    entrypoints = sum(
        1 for path in files_under(root) if is_entrypoint(path, root)
    )
    print(f"checked {entrypoints} example entrypoint(s)")
    print("relative Markdown links are intact")
    print("AGOS_RUNTIME_OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
