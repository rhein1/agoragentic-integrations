#!/usr/bin/env python3
"""Offline documentation checker for example entrypoints and navigation links."""

from __future__ import annotations

import argparse
import re
import sys
import tempfile
from pathlib import Path
from typing import Iterable, List, NamedTuple, Sequence, Tuple
from urllib.parse import unquote


LINK_RE = re.compile(r"(?<!!)\[[^\]]+\]\(\s*<?([^)\s>]+)>?(?:\s+['\"][^'\"]*['\"])?\s*\)")
PATH_RE = re.compile(
    r"(?<![\w./-])((?:examples|example)/[\w./-]+\.(?:py|mjs|js|ts|sh))(?![\w.-])"
)
ENTRYPOINT_SUFFIXES = {".py", ".mjs", ".js", ".ts", ".sh"}
SKIP_PREFIXES = ("http://", "https://", "mailto:", "tel:", "data:")


class Finding(NamedTuple):
    code: str
    file: str
    line: int
    detail: str


def markdown_files(root: Path) -> Iterable[Path]:
    for path in sorted(root.rglob("*")):
        if path.is_file() and path.suffix.lower() in {".md", ".markdown"}:
            if ".git" not in path.parts and "node_modules" not in path.parts:
                yield path


def clean_target(raw: str) -> str:
    target = unquote(raw.strip())
    if "#" in target:
        target = target.split("#", 1)[0]
    if "?" in target:
        target = target.split("?", 1)[0]
    return target


def is_relative(raw: str) -> bool:
    target = raw.strip()
    return bool(target) and not target.startswith(SKIP_PREFIXES) and not target.startswith("#")


def relative_path(source: Path, target: str, root: Path) -> Path:
    return (source.parent / clean_target(target)).resolve()


def example_command_path(token: str, root: Path) -> Path:
    """Resolve bare examples/... command operands from the repository root."""
    return (root / clean_target(token)).resolve()


def display_path(path: Path, root: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return path.as_posix()


def is_example_entrypoint(path: Path, root: Path) -> bool:
    try:
        relative = path.relative_to(root).as_posix().lower()
    except ValueError:
        return False
    return (
        (relative.startswith("examples/") or relative.startswith("example/"))
        and path.suffix.lower() in ENTRYPOINT_SUFFIXES
    )


def add_finding(
    findings: List[Finding],
    code: str,
    source: Path,
    line: int,
    detail: str,
    root: Path,
) -> None:
    findings.append(Finding(code, display_path(source, root), line, detail))


def scan_file(path: Path, root: Path, findings: List[Finding]) -> None:
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return

    for line_number, line in enumerate(text.splitlines(), 1):
        links = list(LINK_RE.finditer(line))
        for match in links:
            raw = match.group(1)
            if not is_relative(raw):
                continue
            target = clean_target(raw)
            if not target:
                continue
            resolved = relative_path(path, target, root)
            normalized = display_path(resolved, root)

            if not resolved.exists():
                code = (
                    "missing_example_entrypoint"
                    if is_example_entrypoint(resolved, root)
                    else "broken_relative_link"
                )
                add_finding(findings, code, path, line_number, normalized, root)

        for match in PATH_RE.finditer(line):
            token = match.group(1)
            resolved = example_command_path(token, root)
            if resolved.exists():
                continue
            if is_example_entrypoint(resolved, root):
                add_finding(
                    findings,
                    "missing_example_entrypoint",
                    path,
                    line_number,
                    display_path(resolved, root),
                    root,
                )


def check_repository(root: Path) -> List[Finding]:
    root = root.resolve()
    findings: List[Finding] = []
    for markdown in markdown_files(root):
        scan_file(markdown, root, findings)
    return sorted(findings, key=lambda item: (item.file, item.line, item.code, item.detail))


def write_fixture(root: Path, files: dict) -> None:
    for name, content in files.items():
        destination = root / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(content, encoding="utf-8")


def run_self_test() -> None:
    cases: Sequence[Tuple[str, dict, set]] = (
        (
            "valid links and entrypoint",
            {
                "README.md": "[run](examples/demo/run.py)\n",
                "examples/demo/run.py": "print('ok')\n",
            },
            set(),
        ),
        (
            "broken navigation link",
            {"README.md": "[missing](docs/nope.md)\n"},
            {"broken_relative_link"},
        ),
        (
            "missing example entrypoint",
            {"README.md": "[run](examples/demo/run.py)\n"},
            {"missing_example_entrypoint"},
        ),
        (
            "repeated navigation links are allowed",
            {
                "README.md": "[one](docs/guide.md)\n[two](docs/guide.md)\n",
                "docs/guide.md": "# Guide\n",
            },
            set(),
        ),
        (
            "root-relative command entrypoint",
            {
                "docs/README.md": "python examples/demo/run.py\n",
                "examples/demo/run.py": "print('ok')\n",
            },
            set(),
        ),
        (
            "missing root-relative command entrypoint",
            {"docs/README.md": "node examples/demo/missing.mjs\n"},
            {"missing_example_entrypoint"},
        ),
        (
            "external links ignored",
            {"README.md": "[site](https://example.invalid/nope)\n"},
            set(),
        ),
    )

    for title, files, expected in cases:
        with tempfile.TemporaryDirectory(prefix="offline-doc-check-") as name:
            root = Path(name)
            write_fixture(root, files)
            actual = {finding.code for finding in check_repository(root)}
            if actual != expected:
                raise AssertionError(
                    "{}: expected {!r}, got {!r}".format(title, expected, actual)
                )
    print("self-test cases: {}".format(len(cases)))
    print("AGOS_RUNTIME_OK")


def report(findings: Sequence[Finding]) -> None:
    for finding in findings:
        print(
            "{}:{}: {} ({})".format(
                finding.file, finding.line, finding.code, finding.detail
            )
        )
    if findings:
        print("findings: {}".format(len(findings)))
    else:
        print("findings: 0")


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Check Markdown relative links and documented example entrypoints."
    )
    parser.add_argument("root", nargs="?", default=".", help="repository root")
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="run deterministic checker tests instead of scanning a repository",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str]) -> int:
    args = parse_args(argv)
    if args.self_test or len(argv) == 0:
        run_self_test()
        return 0

    root = Path(args.root)
    if not root.is_dir():
        print("error: repository root is not a directory: {}".format(root), file=sys.stderr)
        return 2

    findings = check_repository(root)
    report(findings)
    return 1 if findings else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
