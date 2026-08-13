#!/usr/bin/env python3
"""Offline repository hygiene checks for documented examples and entrypoints."""

from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path
from typing import Dict, Iterable, List, Sequence, Tuple


Finding = Tuple[str, str, str]

MARKDOWN_LINK = re.compile(r"!?\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)")
COMMAND = re.compile(
    r"^\s*(?:[$>]\s*)?(?P<tool>python3?|node)\s+(?P<path>[^\s;&|]+)"
)
LIST_LINK = re.compile(r"^\s*[-*+]\s+\[[^\]]+\]\(([^)\s]+)")
FENCE = re.compile(r"^\s*(```+|~~~+)")


def clean_target(raw: str) -> str:
    target = raw.strip().strip("<>")
    if "#" in target:
        target = target.split("#", 1)[0]
    return target


def is_external(target: str) -> bool:
    lowered = target.lower()
    return (
        not target
        or target.startswith("#")
        or lowered.startswith(("http://", "https://", "mailto:", "tel:"))
        or lowered.startswith(("data:", "javascript:"))
    )


def relative_path(source: Path, target: str, root: Path) -> Path:
    target_path = Path(target.replace("/", os.sep))
    if target_path.is_absolute():
        return target_path
    return (source.parent / target_path).resolve()


def looks_like_example(path_text: str) -> bool:
    lowered = path_text.lower()
    return (
        "/example" in lowered
        or lowered.startswith("examples/")
        or "/fixtures/" in lowered
        or lowered.startswith("fixture/")
    )


def supported_entrypoint(tool: str, path: Path) -> bool:
    suffixes = {
        "python": {".py"},
        "python3": {".py"},
        "node": {".js", ".mjs", ".cjs"},
    }
    return path.suffix.lower() in suffixes[tool]


def check_markdown(
    source: Path, text: str, root: Path
) -> List[Finding]:
    findings: List[Finding] = []
    lines = text.splitlines()
    seen_navigation = set()
    in_list = False
    in_fence = False
    fence_marker = ""
    for number, line in enumerate(lines, 1):
        fence = FENCE.match(line)
        if fence:
            marker = fence.group(1)
            if not in_fence:
                in_fence = True
                fence_marker = marker[0]
            elif marker[0] == fence_marker:
                in_fence = False
            continue

        list_match = LIST_LINK.match(line)
        if list_match:
            in_list = True
            target = clean_target(list_match.group(1))
            if not is_external(target):
                key = target.casefold()
                if key in seen_navigation:
                    findings.append(
                        ("duplicate_navigation_entry", source, number, target)
                    )
                seen_navigation.add(key)
        elif line.strip() and not line.lstrip().startswith(("- ", "* ", "+ ")):
            in_list = False
            seen_navigation.clear()

        for match in MARKDOWN_LINK.finditer(line):
            target = clean_target(match.group(1))
            if is_external(target):
                continue
            destination = relative_path(source, target, root)
            if not destination.exists():
                code = (
                    "missing_example_file"
                    if looks_like_example(target)
                    else "broken_relative_link"
                )
                findings.append((code, source, number, target))

        if in_fence:
            command = COMMAND.match(line)
            if not command:
                continue
            tool = command.group("tool")
            raw_path = command.group("path").rstrip("`'\".,:)")
            if raw_path.startswith(("-", "$")) or is_external(raw_path):
                continue
            destination = relative_path(source, raw_path, root)
            if not destination.is_file() or not supported_entrypoint(
                tool, destination
            ):
                findings.append(
                    (
                        "non_runnable_documented_entrypoint",
                        source,
                        number,
                        f"{tool} {raw_path}",
                    )
                )
    return findings


def iter_markdown(root: Path) -> Iterable[Path]:
    excluded = {".git", "node_modules", ".venv", "venv"}
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in {".md", ".markdown"}:
            continue
        if any(part in excluded for part in path.relative_to(root).parts):
            continue
        yield path


def validate(root: Path) -> List[Finding]:
    findings: List[Finding] = []
    for path in iter_markdown(root):
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeError) as exc:
            findings.append(("unreadable_document", path, 0, str(exc)))
            continue
        findings.extend(check_markdown(path, text, root))
    return findings


def format_finding(finding: Finding) -> str:
    code, source, line, detail = finding
    location = f"{source}:{line}" if line else str(source)
    return f"{code}: {location}: {detail}"


def virtual_findings(files: Dict[str, str]) -> List[str]:
    """Run the same checks against an in-memory miniature repository."""
    root = Path("/virtual-repository").resolve()
    findings: List[Finding] = []
    for name, text in files.items():
        source = root / name
        for finding in check_markdown(source, text, root):
            code, _, line, detail = finding
            findings.append((code, source, line, detail))
    existing = {str((root / name).resolve()) for name in files}
    filtered = []
    for code, source, line, detail in findings:
        if code in {
            "broken_relative_link",
            "missing_example_file",
            "non_runnable_documented_entrypoint",
        }:
            target = detail.split(" ", 1)[-1]
            candidate = str(relative_path(source, target, root))
            if candidate in existing:
                continue
        filtered.append(code)
    return filtered


def self_test() -> None:
    cases = [
        (
            "valid example and link",
            {"README.md": "[example](examples/run.py)\n\n```sh\npython examples/run.py\n```"},
            [],
        ),
        (
            "missing example",
            {"README.md": "[example](examples/missing.py)"},
            ["missing_example_file"],
        ),
        (
            "broken relative link",
            {"README.md": "[guide](docs/missing.md)"},
            ["broken_relative_link"],
        ),
        (
            "duplicate navigation",
            {"README.md": "- [Guide](guide.md)\n- [Again](guide.md)"},
            ["duplicate_navigation_entry"],
        ),
        (
            "non runnable entrypoint",
            {"README.md": "```sh\nnode examples/missing.mjs\n```"},
            ["non_runnable_documented_entrypoint"],
        ),
        (
            "external links ignored",
            {"README.md": "[site](https://example.invalid/x)"},
            [],
        ),
    ]
    for name, files, expected in cases:
        actual = virtual_findings(files)
        if actual != expected:
            raise AssertionError(f"{name}: expected {expected}, got {actual}")
    print("self-tests: 6 passed")
    print("AGOS_RUNTIME_OK")


def main(argv: Sequence[str]) -> int:
    parser = argparse.ArgumentParser(
        description="Check documented examples, links, navigation, and entrypoints."
    )
    parser.add_argument(
        "root",
        nargs="?",
        default=".",
        help="repository root to scan (default: current directory)",
    )
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="run deterministic in-memory regression tests",
    )
    args = parser.parse_args(argv)
    if args.self_test:
        self_test()
        return 0

    root = Path(args.root).resolve()
    if not root.is_dir():
        print(f"repository root is not a directory: {root}", file=sys.stderr)
        return 2
    findings = validate(root)
    for finding in findings:
        print(format_finding(finding))
    print(f"checked markdown files under {root}")
    if findings:
        print(f"{len(findings)} finding(s)")
        return 1
    print("AGOS_RUNTIME_OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
