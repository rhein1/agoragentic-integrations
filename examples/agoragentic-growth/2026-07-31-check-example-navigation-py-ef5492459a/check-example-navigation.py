#!/usr/bin/env python3
"""Offline checks for documented examples and repository-relative navigation."""

from __future__ import annotations

import argparse
import re
import sys
import tempfile
from pathlib import Path
from typing import Iterable, List, NamedTuple, Sequence, Tuple
from urllib.parse import unquote, urlsplit


ENTRYPOINT_SUFFIXES = {".mjs", ".js", ".py"}
MARKDOWN_SUFFIXES = {".md", ".markdown"}
LINK_RE = re.compile(r"(?<!!)\[([^\]]*)\]\(([^)\n]+)\)")
HTML_LINK_RE = re.compile(r"""(?i)<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']""")
NAV_HINT_RE = re.compile(r"(?i)(?:nav|menu|sidebar|toc|navigation)")
MAIN_GUARD_RE = re.compile(
    r"""(?m)(?:if\s+require\.main\s*===\s*module|import\.meta\.url|__name__\s*==\s*['"]__main__['"])"""
)


class Finding(NamedTuple):
    code: str
    path: str
    detail: str

    def line(self) -> str:
        return f"{self.code}: {self.path}: {self.detail}"


def relative_files(root: Path) -> Iterable[Path]:
    for path in root.rglob("*"):
        if path.is_file() and ".git" not in path.parts:
            yield path


def is_external(target: str) -> bool:
    parsed = urlsplit(target)
    return bool(parsed.scheme or parsed.netloc) or target.startswith(("#", "mailto:"))


def clean_target(raw: str) -> str:
    target = raw.strip().split(None, 1)[0]
    target = target.strip("<>")
    return unquote(urlsplit(target).path)


def link_targets(text: str) -> Iterable[Tuple[str, str]]:
    for match in LINK_RE.finditer(text):
        yield match.group(2), match.group(1).strip()
    for match in HTML_LINK_RE.finditer(text):
        yield match.group(1), ""


def resolve_link(source: Path, target: str, root: Path) -> Path:
    path = clean_target(target)
    if path.startswith("/"):
        return root / path.lstrip("/")
    return (source.parent / path).resolve()


def check_relative_links(root: Path) -> List[Finding]:
    findings: List[Finding] = []
    for source in relative_files(root):
        if source.suffix.lower() not in MARKDOWN_SUFFIXES:
            continue
        try:
            text = source.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            findings.append(Finding(
                "unreadable_markdown",
                str(source.relative_to(root)),
                "file is not UTF-8 text",
            ))
            continue
        for raw, label in link_targets(text):
            target = clean_target(raw)
            if not target or is_external(raw):
                continue
            resolved = resolve_link(source, raw, root)
            try:
                resolved.relative_to(root.resolve())
            except ValueError:
                findings.append(Finding(
                    "link_escapes_root",
                    str(source.relative_to(root)),
                    f"relative target {target!r} leaves repository root",
                ))
                continue
            if not resolved.exists():
                shown = label or target
                findings.append(Finding(
                    "missing_relative_link",
                    str(source.relative_to(root)),
                    f"{shown!r} points to {target!r}",
                ))
    return findings


def navigation_targets(root: Path) -> List[Tuple[Path, str, str]]:
    found: List[Tuple[Path, str, str]] = []
    for source in relative_files(root):
        if source.suffix.lower() not in MARKDOWN_SUFFIXES:
            continue
        try:
            text = source.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        for raw, label in link_targets(text):
            if is_external(raw) or not clean_target(raw):
                continue
            if NAV_HINT_RE.search(source.name) or NAV_HINT_RE.search(label):
                found.append((source, clean_target(raw), label))
    return found


def check_duplicate_navigation(root: Path) -> List[Finding]:
    findings: List[Finding] = []
    seen: dict[Tuple[str, str], Tuple[Path, str]] = {}
    for source, target, label in navigation_targets(root):
        key = (str(source.resolve()), target.lower())
        if key in seen:
            previous, previous_label = seen[key]
            detail = f"also listed at {previous.name!r}"
            if previous_label and label and previous_label != label:
                detail += f" with label {previous_label!r}"
            findings.append(Finding(
                "duplicate_navigation_target",
                str(source.relative_to(root)),
                f"{target!r}; {detail}",
            ))
        else:
            seen[key] = (source, label)
    return findings


def documented_entrypoints(root: Path) -> List[Tuple[Path, Path]]:
    entries: List[Tuple[Path, Path]] = []
    for source in relative_files(root):
        if source.suffix.lower() not in MARKDOWN_SUFFIXES:
            continue
        try:
            text = source.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        for raw, _ in link_targets(text):
            target = clean_target(raw)
            if is_external(raw) or Path(target).suffix.lower() not in ENTRYPOINT_SUFFIXES:
                continue
            candidate = resolve_link(source, raw, root)
            if candidate.is_file():
                entries.append((source, candidate))
    unique = {
        (source.resolve(), entry.resolve()): (source, entry)
        for source, entry in entries
    }
    return list(unique.values())


def check_entrypoints(root: Path) -> List[Finding]:
    findings: List[Finding] = []
    entries = documented_entrypoints(root)
    for source, entry in entries:
        relative = str(entry.relative_to(root))
        try:
            text = entry.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            findings.append(Finding(
                "unreadable_entrypoint",
                relative,
                f"documented by {source.relative_to(root)}",
            ))
            continue
        if not text.strip():
            findings.append(Finding(
                "empty_entrypoint",
                relative,
                f"documented by {source.relative_to(root)}",
            ))
            continue
        if entry.suffix.lower() in {".mjs", ".js", ".py"} and not MAIN_GUARD_RE.search(text):
            findings.append(Finding(
                "entrypoint_without_main_guard",
                relative,
                "add a direct-execution guard for offline smoke use",
            ))
    return findings


def check(root: Path) -> List[Finding]:
    return (
        check_relative_links(root)
        + check_duplicate_navigation(root)
        + check_entrypoints(root)
    )


def render(findings: Sequence[Finding]) -> int:
    if not findings:
        print("example entrypoints: checked")
        print("relative links: checked")
        print("navigation targets: checked")
        print("AGOS_RUNTIME_OK")
        return 0
    print(f"offline repository checks failed ({len(findings)} finding(s))")
    for finding in findings:
        print(f"  {finding.line()}")
    return 1


def self_test() -> int:
    cases = [
        ("valid", "# Home\n\n[run](examples/run.py)\n", True),
        ("missing-link", "[bad](missing.md)\n", False),
        ("escape", "[bad](../../outside.md)\n", False),
        ("duplicate-nav", "[nav](one.md)\n[nav](one.md)\n", False),
        ("empty-entry", "[run](run.py)\n", False),
    ]
    failures = 0
    for name, readme, expected_ok in cases:
        with tempfile.TemporaryDirectory(prefix="example-check-") as directory:
            root = Path(directory)
            (root / "README.md").write_text(readme, encoding="utf-8")
            if name in {"valid", "empty-entry"}:
                (root / "examples").mkdir()
                content = "if __name__ == '__main__':\n    print('ok')\n"
                if name == "empty-entry":
                    content = ""
                (root / "examples" / "run.py").write_text(content, encoding="utf-8")
            if name == "duplicate-nav":
                (root / "nav.md").write_text(
                    "[nav](one.md)\n[nav](one.md)\n",
                    encoding="utf-8",
                )
            actual_ok = not check(root)
            if actual_ok != expected_ok:
                print(f"self-test failure: {name}", file=sys.stderr)
                failures += 1
    if failures:
        return 1
    print("self-tests: passed")
    print("AGOS_RUNTIME_OK")
    return 0


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "root",
        nargs="?",
        type=Path,
        default=Path("."),
        help="repository root to check",
    )
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="run deterministic checks without reading a repository",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    if args.self_test:
        return self_test()
    root = args.root.expanduser().resolve()
    if not root.is_dir():
        print(f"repository root is not a directory: {root}", file=sys.stderr)
        return 2
    return render(check(root))


if __name__ == "__main__":
    raise SystemExit(main())
