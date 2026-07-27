#!/usr/bin/env python3
"""Offline checks for example entrypoints and relative Markdown links."""

from __future__ import annotations

import argparse
import ast
import re
import sys
import tempfile
from pathlib import Path
from typing import Iterable, List, Optional, Sequence, Tuple

LINK_RE = re.compile(r"!?\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)")
ENTRY_NAMES = re.compile(
    r"(?:^|[-_.])(example|demo|run|smoke|quickstart|x402_execute)(?:[-_.]|$)",
    re.IGNORECASE,
)
SOURCE_SUFFIXES = {".py", ".mjs", ".js", ".cjs"}
SKIP_PARTS = {".git", "node_modules", "__pycache__", ".venv", "venv"}


def files_under(root: Path) -> Iterable[Path]:
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        if any(part in SKIP_PARTS for part in path.relative_to(root).parts):
            continue
        yield path


def relative_links(path: Path) -> Iterable[Tuple[str, int]]:
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return
    in_fence = False
    for number, line in enumerate(text.splitlines(), 1):
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        for match in LINK_RE.finditer(line):
            target = match.group(1).strip().strip("<>")
            if not target or target.startswith(("#", "/", "//")):
                continue
            if re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", target):
                continue
            yield target.split("#", 1)[0].split("?", 1)[0], number


def first_broken_link(root: Path) -> Optional[str]:
    for document in files_under(root):
        if document.suffix.lower() not in {".md", ".markdown"}:
            continue
        for target, line in relative_links(document):
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
        if source.count("{") != source.count("}"):
            return "unbalanced JavaScript braces"
        if source.count("(") != source.count(")"):
            return "unbalanced JavaScript parentheses"
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
        ("valid", "# Docs\n\n[example](examples/demo.py)\n", True, True),
        ("missing-link", "[gone](examples/nope.py)\n", False, True),
        ("bad-python", "[ok](examples/demo.py)\n", True, False),
        ("bad-js-shape", "[ok](examples/demo.mjs)\n", True, False),
    ]
    for name, markdown, links_ok, entrypoint_ok in cases:
        with tempfile.TemporaryDirectory(prefix="agos-check-") as directory:
            root = Path(directory)
            make_file(root, "README.md", markdown)
            if name == "valid":
                make_file(root, "examples/demo.py", "print('ok')\n")
            elif name == "missing-link":
                pass
            elif name == "bad-python":
                make_file(root, "examples/demo.py", "def broken(:\n")
            else:
                make_file(root, "examples/demo.mjs", "export function demo() {\n")
            findings = check_repository(root)
            got_link_ok = first_broken_link(root) is None
            got_entrypoint_ok = not any(
                "syntax error" in item or "unbalanced" in item for item in findings
            )
            if got_link_ok != links_ok or got_entrypoint_ok != entrypoint_ok:
                print(f"self-test failed: {name}", file=sys.stderr)
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
