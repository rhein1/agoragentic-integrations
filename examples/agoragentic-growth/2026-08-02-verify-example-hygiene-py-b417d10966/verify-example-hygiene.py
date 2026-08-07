#!/usr/bin/env python3
"""Offline checks for example entrypoints, Markdown links, and navigation quality."""

from __future__ import annotations

import argparse
import ast
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Sequence, Tuple


MARKDOWN_SUFFIXES = {".md", ".markdown"}
CODE_SUFFIXES = {".py", ".js", ".mjs", ".cjs"}
SKIP_PARTS = {".git", "node_modules", "__pycache__", ".venv", "venv"}
REFERENCE_DEFINITION_RE = re.compile(
    r"^\s{0,3}\[([^\]]+)\]:\s*(?:<([^>]+)>|(\S+))", re.MULTILINE
)
REFERENCE_USAGE_RE = re.compile(r"(?<!!)\[([^\]]+)\]\[([^\]]*)\]")
FENCE_RE = re.compile(r"^\s*(`{3,}|~{3,})")


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


def reference_label(value: str) -> str:
    return " ".join(value.strip().lower().split())


def markdown_prose(text: str) -> str:
    """Remove code regions so bracketed source examples are not parsed as links."""
    lines = []
    closing_fence = None
    for line in text.splitlines(keepends=True):
        fence = FENCE_RE.match(line)
        if fence:
            marker = fence.group(1)[0]
            if closing_fence is None:
                closing_fence = marker
            elif marker == closing_fence:
                closing_fence = None
            lines.append("\n" if line.endswith("\n") else "")
            continue
        if closing_fence is not None or line.startswith(("    ", "\t")):
            lines.append("\n" if line.endswith("\n") else "")
            continue
        lines.append(re.sub(r"`+[^`\n]*`+", "", line))
    return "".join(lines)


def check_local_target(root: Path, source: Path, target: str,
                       missing_code: str, outside_code: str) -> List[Finding]:
    if not target or target.startswith(("#", "http://", "https://", "mailto:")):
        return []
    resolved = relative_target(source, target)
    try:
        resolved.relative_to(root.resolve())
    except ValueError:
        return [Finding(str(source.relative_to(root)), outside_code, target)]
    if not resolved.exists():
        return [Finding(str(source.relative_to(root)), missing_code, target)]
    return []


def check_markdown_links(root: Path) -> List[Finding]:
    findings: List[Finding] = []
    pattern = re.compile(r"!?\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)")
    for source in files_under(root, MARKDOWN_SUFFIXES):
        text = markdown_prose(source.read_text(encoding="utf-8", errors="replace"))
        for target in pattern.findall(text):
            findings.extend(check_local_target(
                root, source, target, "missing_relative_link", "link_outside_root"
            ))

        definitions = {}
        for match in REFERENCE_DEFINITION_RE.finditer(text):
            label = reference_label(match.group(1))
            target = match.group(2) or match.group(3) or ""
            if label in definitions:
                findings.append(Finding(str(source.relative_to(root)),
                                        "duplicate_reference_definition", label))
                continue
            definitions[label] = target
            findings.extend(check_local_target(
                root, source, target,
                "missing_reference_link", "reference_link_outside_root"
            ))

        for match in REFERENCE_USAGE_RE.finditer(text):
            label = reference_label(match.group(2) or match.group(1))
            if label and label not in definitions:
                findings.append(Finding(str(source.relative_to(root)),
                                        "missing_reference_definition", label))
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


def check_entrypoints(root: Path) -> List[Finding]:
    findings: List[Finding] = []
    node = shutil.which("node")
    for path in files_under(root, CODE_SUFFIXES):
        if not is_example_path(path, root) or path.name == "__init__.py":
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
        elif node is None:
            findings.append(Finding(relative, "javascript_check_unavailable",
                                    "node --check is required for JavaScript validation"))
        else:
            result = subprocess.run(
                [node, "--check", str(path)],
                capture_output=True,
                text=True,
                timeout=15,
                check=False,
            )
            if result.returncode != 0:
                detail = next(
                    (line.strip() for line in result.stderr.splitlines() if line.strip()),
                    "node --check failed",
                )
                findings.append(Finding(relative, "javascript_syntax_error", detail))
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
                  if is_example_path(path, root) and path.name != "__init__.py")
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
        ("bad_js_balanced", "examples/demo/index.mjs", "const = ;\n",
         "", "", True),
        ("missing_link", "README.md", "", "README.md",
         "- [Missing](examples/nope/main.py)\n", True),
        ("missing_reference", "README.md", "", "README.md",
         "See [Missing][no-such-definition].\n", True),
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

    with tempfile.TemporaryDirectory(prefix="example-hygiene-escape-") as folder:
        container = Path(folder)
        root = container / "repo"
        root.mkdir()
        (container / "outside.md").write_text("outside\n", encoding="utf-8")
        (root / "README.md").write_text(
            "[outside]: ../outside.md\nSee [Outside][outside].\n",
            encoding="utf-8",
        )
        codes = {finding.code for finding in validate(root)}
        if "reference_link_outside_root" not in codes:
            print("SELF_TEST_FAIL reference_escape: unexpected result")
            return 1

    print("self-tests: 8 passed")
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
