#!/usr/bin/env python3
"""Offline checker for documented example entrypoints and relative Markdown links."""

from __future__ import annotations

import argparse
import os
import re
import sys
import tempfile
from pathlib import Path
from typing import Iterable, List, NamedTuple, Sequence, Tuple


README_NAMES = {"README.md", "CONTRIBUTING.md", "EXAMPLES.md", "GETTING_STARTED.md"}
EXAMPLE_WORDS = ("example", "examples", "quickstart", "getting started", "usage", "run ")
ENTRYPOINT_SUFFIXES = {".py", ".mjs", ".js", ".ts", ".tsx", ".sh"}
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv"}
LINK_RE = re.compile(r"(?<!!)\[([^\]]*)\]\(([^)\s]+)(?:\s+[\"'][^)]*[\"'])?\)")
FENCE_RE = re.compile(r"^```(?:[A-Za-z0-9_+-]+)?\s*$")


class Finding(NamedTuple):
    path: str
    line: int
    code: str
    message: str


def iter_files(root: Path, names: set[str]) -> Iterable[Path]:
    for directory, subdirs, files in os.walk(root):
        subdirs[:] = sorted(d for d in subdirs if d not in SKIP_DIRS)
        for name in sorted(files):
            if name in names:
                yield Path(directory) / name


def is_local_target(target: str) -> bool:
    return not (
        target.startswith(("#", "/", "mailto:", "http://", "https://"))
        or re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", target)
    )


def clean_target(target: str) -> str:
    return target.split("#", 1)[0].split("?", 1)[0]


def looks_like_entrypoint(path: Path, label: str = "") -> bool:
    text = f"{path.name} {label}".lower()
    return path.suffix.lower() in ENTRYPOINT_SUFFIXES or any(
        word in text for word in ("entrypoint", "example", "quickstart", "run")
    )


def documented_regions(lines: Sequence[str]) -> List[Tuple[int, str]]:
    regions: List[Tuple[int, str]] = []
    in_fence = False
    for number, line in enumerate(lines, 1):
        if FENCE_RE.match(line.strip()):
            in_fence = not in_fence
            continue
        if not in_fence:
            regions.append((number, line))
    return regions


def check_readme(readme: Path, root: Path) -> List[Finding]:
    findings: List[Finding] = []
    lines = readme.read_text(encoding="utf-8").splitlines()
    for number, line in documented_regions(lines):
        for match in LINK_RE.finditer(line):
            label, raw_target = match.groups()
            if not is_local_target(raw_target):
                continue
            target = clean_target(raw_target)
            if not target:
                continue
            destination = (readme.parent / target).resolve()
            try:
                destination.relative_to(root.resolve())
            except ValueError:
                findings.append(Finding(str(readme.relative_to(root)), number,
                                        "link_escapes_root",
                                        f"relative link leaves repository: {raw_target}"))
                continue
            if not destination.exists():
                findings.append(Finding(str(readme.relative_to(root)), number,
                                        "missing_relative_link",
                                        f"documented target does not exist: {raw_target}"))
            elif looks_like_entrypoint(destination, label) and not destination.is_file():
                findings.append(Finding(str(readme.relative_to(root)), number,
                                        "entrypoint_not_file",
                                        f"documented entrypoint is not a file: {raw_target}"))
    return findings


def check_entrypoint_mentions(readme: Path, root: Path) -> List[Finding]:
    findings: List[Finding] = []
    lines = readme.read_text(encoding="utf-8").splitlines()
    for number, line in documented_regions(lines):
        lowered = line.lower()
        if not any(word in lowered for word in EXAMPLE_WORDS):
            continue
        for token in re.findall(r"`([^`]+)`|(?<![\w./-])([\w./-]+\.(?:py|mjs|js|ts|tsx|sh))", line):
            value = next((part for part in token if part), "")
            if not value or not is_local_target(value):
                continue
            destination = (readme.parent / value).resolve()
            if not destination.exists():
                findings.append(Finding(str(readme.relative_to(root)), number,
                                        "missing_example_entrypoint",
                                        f"example command references missing file: {value}"))
            elif not destination.is_file():
                findings.append(Finding(str(readme.relative_to(root)), number,
                                        "entrypoint_not_file",
                                        f"example command target is not a file: {value}"))
    return findings


def check(root: Path) -> List[Finding]:
    findings: List[Finding] = []
    for readme in iter_files(root, README_NAMES):
        findings.extend(check_readme(readme, root))
        findings.extend(check_entrypoint_mentions(readme, root))
    return findings


def render(findings: Sequence[Finding]) -> str:
    if not findings:
        return "No broken documented example entrypoints or relative links found."
    return "\n".join(
        f"{item.path}:{item.line}: {item.code}: {item.message}"
        for item in findings
    )


def write_fixture(root: Path, readme: str, entrypoint: bool = True) -> None:
    docs = root / "examples"
    docs.mkdir(parents=True)
    if entrypoint:
        (docs / "hello.py").write_text("print('ok')\n", encoding="utf-8")
    (docs / "README.md").write_text(readme, encoding="utf-8")


def self_test() -> None:
    cases = [
        ("[run](hello.py)\n", True, []),
        ("[run](missing.py)\n", True, ["missing_relative_link", "missing_example_entrypoint"]),
        ("Run `missing.py` as an example.\n", True, ["missing_example_entrypoint"]),
        ("[external](https://example.test/missing.py)\n", False, []),
        ("[anchor](#hello)\n", False, []),
        ("[outside](../../secret.py)\n", True, ["link_escapes_root"]),
        ("[dir](hello.py#section)\n", True, []),
    ]
    for text, entrypoint, expected in cases:
        with tempfile.TemporaryDirectory(prefix="example-check-") as name:
            root = Path(name)
            write_fixture(root, text, entrypoint)
            actual = [finding.code for finding in check(root)]
            assert actual == expected, (text, actual, expected)
    with tempfile.TemporaryDirectory(prefix="example-check-") as name:
        root = Path(name)
        (root / "README.md").write_text(
            "```text\n[ignored](missing.py)\n```\n", encoding="utf-8"
        )
        assert check(root) == []
    print("AGOS_RUNTIME_OK")


def main(argv: Sequence[str]) -> int:
    parser = argparse.ArgumentParser(
        description="Check documented local example entrypoints without network access."
    )
    parser.add_argument("root", nargs="?", default=".", type=Path,
                        help="repository root to inspect (default: current directory)")
    parser.add_argument("--self-test", action="store_true",
                        help="run deterministic local tests")
    args = parser.parse_args(argv)
    if args.self_test:
        self_test()
        return 0
    root = args.root.resolve()
    if not root.is_dir():
        print(f"error: repository root is not a directory: {root}", file=sys.stderr)
        return 2
    findings = check(root)
    print(render(findings))
    if findings:
        print(f"\n{len(findings)} finding(s); fix documented paths before publishing.")
        return 1
    print("AGOS_RUNTIME_OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
