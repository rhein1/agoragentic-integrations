#!/usr/bin/env python3
"""Offline checks for example entrypoints, Markdown links, and navigation quality."""

from __future__ import annotations

import argparse
import ast
import os
import re
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Sequence, Tuple


ENTRYPOINT_NAMES = {
    "main.py",
    "app.py",
    "example.py",
    "index.js",
    "index.mjs",
    "index.cjs",
    "main.js",
    "main.mjs",
    "main.cjs",
}
MARKDOWN_SUFFIXES = {".md", ".markdown"}
CODE_SUFFIXES = {".py", ".js", ".mjs", ".cjs"}
SKIP_PARTS = {".git", "node_modules", "__pycache__", ".venv", "venv"}


@dataclass(frozen=True)
class Finding:
    path: str
    code: str
    detail: str

    def render(self) -> str:
        return f"{self.path}: {self.code}: {self.detail}"


def files_under(root: Path, suffixes: Iterable[str]) -> Iterable[Path]:
    wanted = set(suffixes)
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in wanted:
            continue
        if any(part in SKIP_PARTS for part in path.relative_to(root).parts):
            continue
        yield path


def is_example_path(path: Path, root: Path) -> bool:
    parts = {part.lower() for part in path.relative_to(root).parts}
    return "examples" in parts or "example" in parts


def relative_target(source: Path, target: str) -> Path:
    clean = target.split("#", 1)[0].split("?", 1)[0]
    return (source.parent / clean).resolve()


def check_markdown_links(root: Path) -> List[Finding]:
    findings: List[Finding] = []
    pattern = re.compile(r"!?\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)")
    for source in files_under(root, MARKDOWN_SUFFIXES):
        text = source.read_text(encoding="utf-8", errors="replace")
        for target in pattern.findall(text):
            if not target or target.startswith(("#", "http://", "https://", "mailto:")):
                continue
            resolved = relative_target(source, target)
            try:
                resolved.relative_to(root.resolve())
            except ValueError:
                findings.append(Finding(str(source.relative_to(root)),
                                        "link_outside_root", target))
                continue
            if not resolved.exists():
                findings.append(Finding(str(source.relative_to(root)),
                                        "missing_relative_link", target))
    return findings


def navigation_entries(text: str) -> List[Tuple[str, int]]:
    entries: List[Tuple[str, int]] = []
    link_pattern = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+\[([^\]]+)\]\(([^)]+)\)")
    for number, line in enumerate(text.splitlines(), 1):
        match = link_pattern.match(line)
        if match:
            label, target = match.groups()
            entries.append((f"{label.strip()}\t{target.split('#', 1)[0].strip()}", number))
    return entries


def check_duplicate_navigation(root: Path) -> List[Finding]:
    findings: List[Finding] = []
    for source in files_under(root, MARKDOWN_SUFFIXES):
        seen = {}
        for entry, line in navigation_entries(source.read_text(encoding="utf-8",
                                                               errors="replace")):
            if entry in seen:
                findings.append(Finding(str(source.relative_to(root)),
                                        "duplicate_navigation_entry",
                                        f"line {line} repeats line {seen[entry]}"))
            else:
                seen[entry] = line
    return findings


def balanced_javascript(text: str) -> bool:
    pairs = {")": "(", "]": "[", "}": "{"}
    stack: List[str] = []
    quote = ""
    escaped = False
    for char in text:
        if quote:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = ""
            continue
        if char in "'\"`":
            quote = char
        elif char in "([{":
            stack.append(char)
        elif char in ")]}":
            if not stack or stack.pop() != pairs[char]:
                return False
    return not stack and not quote


def check_entrypoints(root: Path) -> List[Finding]:
    findings: List[Finding] = []
    for path in files_under(root, CODE_SUFFIXES):
        if not is_example_path(path, root) or path.name not in ENTRYPOINT_NAMES:
            continue
        relative = str(path.relative_to(root))
        text = path.read_text(encoding="utf-8", errors="replace")
        if not text.strip():
            findings.append(Finding(relative, "empty_entrypoint", "file has no source"))
            continue
        if path.suffix == ".py":
            try:
                ast.parse(text, filename=relative)
            except SyntaxError as error:
                findings.append(Finding(relative, "python_syntax_error",
                                        f"line {error.lineno}: {error.msg}"))
        elif not balanced_javascript(text):
            findings.append(Finding(relative, "javascript_structure_error",
                                    "unbalanced delimiters or unterminated string"))
    return findings


def validate(root: Path) -> List[Finding]:
    root = root.resolve()
    return check_entrypoints(root) + check_markdown_links(root) + check_duplicate_navigation(root)


def print_report(findings: Sequence[Finding], root: Path) -> int:
    if findings:
        for finding in findings:
            print(f"FAIL {finding.render()}")
        print(f"AGOS_RUNTIME_FAIL ({len(findings)} finding(s))")
        return 1
    checked = sum(1 for path in files_under(root, CODE_SUFFIXES)
                  if is_example_path(path, root) and path.name in ENTRYPOINT_NAMES)
    print(f"OK checked {checked} example entrypoint(s), local links, and navigation")
    print("AGOS_RUNTIME_OK")
    return 0


def self_test() -> int:
    cases = [
        ("valid", "examples/demo/main.py", "def main():\n    return 1\n",
         "README.md", "- [Demo](examples/demo/main.py)\n", False),
        ("bad_python", "examples/demo/main.py", "def main(:\n", "",
         "", True),
        ("bad_js", "examples/demo/index.mjs", "export function main() {\n",
         "", "", True),
        ("missing_link", "README.md", "", "README.md",
         "- [Missing](examples/nope/main.py)\n", True),
        ("duplicate_nav", "README.md", "", "README.md",
         "- [Demo](examples/demo/main.py)\n- [Demo](examples/demo/main.py)\n", True),
    ]
    for name, code_name, code, doc_name, doc, expected_bad in cases:
        with tempfile.TemporaryDirectory(prefix="example-hygiene-") as folder:
            root = Path(folder)
            code_path = root / code_name
            code_path.parent.mkdir(parents=True, exist_ok=True)
            code_path.write_text(code, encoding="utf-8")
            if doc_name:
                (root / doc_name).write_text(doc, encoding="utf-8")
            findings = validate(root)
            if bool(findings) != expected_bad:
                print(f"SELF_TEST_FAIL {name}: unexpected result")
                return 1
    print("self-tests: 5 passed")
    print("AGOS_RUNTIME_OK")
    return 0


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Check local example entrypoints, relative Markdown links, and navigation."
    )
    parser.add_argument("--root", type=Path, default=Path("."),
                        help="repository root (default: current directory)")
    parser.add_argument("--self-test", action="store_true",
                        help="run deterministic fixture tests")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    if args.self_test:
        return self_test()
    root = args.root.resolve()
    if not root.is_dir():
        print(f"FAIL root_not_directory: {root}")
        print("AGOS_RUNTIME_FAIL (1 finding)")
        return 1
    return print_report(validate(root), root)


if __name__ == "__main__":
    raise SystemExit(main())
