#!/usr/bin/env python3
"""Offline checks for example entrypoints and local guide navigation."""

from __future__ import annotations

import argparse
import re
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Sequence, Tuple


ENTRYPOINT_NAMES = frozenset(
    {
        "main.py",
        "example.py",
        "index.py",
        "main.mjs",
        "example.mjs",
        "index.mjs",
        "main.js",
        "example.js",
        "index.js",
    }
)
GUIDE_NAMES = frozenset({"README.md", "GUIDE.md", "CONTRIBUTING.md"})
LINK_RE = re.compile(r"(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+['\"][^'\"]*['\"])?\)")
IMPORT_RE = re.compile(
    r"""(?:from\s*|import\s*\(\s*)["'](\.{1,2}/[^"']+)["']"""
)


@dataclass(frozen=True)
class Finding:
    code: str
    path: Path
    detail: str

    def format(self, root: Path) -> str:
        try:
            shown = self.path.relative_to(root)
        except ValueError:
            shown = self.path
        return f"{self.code}: {shown}: {self.detail}"


def is_local_target(value: str) -> bool:
    """Return whether a Markdown destination is a repository-local path."""
    cleaned = value.strip().split("#", 1)[0]
    return bool(cleaned) and not (
        cleaned.startswith(("http://", "https://", "mailto:", "tel:"))
        or cleaned.startswith("//")
        or cleaned.startswith("#")
    )


def resolve_markdown_target(source: Path, target: str) -> Path:
    cleaned = target.strip().split("#", 1)[0]
    return (source.parent / cleaned).resolve()


def markdown_targets(path: Path) -> Iterable[Tuple[str, int]]:
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        for match in LINK_RE.finditer(line):
            yield match.group(1), number


def static_relative_imports(path: Path) -> Iterable[Tuple[str, int]]:
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        for match in IMPORT_RE.finditer(line):
            yield match.group(1), number


def import_resolves(source: Path, specifier: str) -> bool:
    candidate = (source.parent / specifier).resolve()
    choices = (candidate, Path(f"{candidate}.py"), Path(f"{candidate}.mjs"),
               Path(f"{candidate}.js"), candidate / "index.mjs",
               candidate / "index.js", candidate / "index.py")
    return any(item.is_file() for item in choices)


def find_entrypoints(root: Path) -> List[Path]:
    paths = [
        path for path in root.rglob("*")
        if path.is_file()
        and path.name in ENTRYPOINT_NAMES
        and ".git" not in path.parts
        and "__pycache__" not in path.parts
    ]
    return sorted(paths)


def find_guides(root: Path) -> List[Path]:
    paths = [
        path for path in root.rglob("*")
        if path.is_file()
        and path.name in GUIDE_NAMES
        and ".git" not in path.parts
    ]
    return sorted(paths)


def check_entrypoints(root: Path) -> List[Finding]:
    findings: List[Finding] = []
    for path in find_entrypoints(root):
        if not path.read_text(encoding="utf-8").strip():
            findings.append(Finding("empty_entrypoint", path, "file has no source"))
        if path.suffix in {".mjs", ".js"}:
            for specifier, line in static_relative_imports(path):
                if not import_resolves(path, specifier):
                    findings.append(
                        Finding(
                            "missing_static_import",
                            path,
                            f"line {line} references {specifier}",
                        )
                    )
    return findings


def check_navigation(root: Path) -> List[Finding]:
    findings: List[Finding] = []
    for guide in find_guides(root):
        for target, line in markdown_targets(guide):
            if not is_local_target(target):
                continue
            resolved = resolve_markdown_target(guide, target)
            if not resolved.is_file():
                findings.append(
                    Finding(
                        "missing_local_navigation",
                        guide,
                        f"line {line} references {target}",
                    )
                )
    return findings


def inspect(root: Path) -> List[Finding]:
    if not root.is_dir():
        return [Finding("missing_root", root, "repository root is not a directory")]
    return check_entrypoints(root) + check_navigation(root)


def run_self_test() -> None:
    cases = (
        ("valid fixture", True, True),
        ("broken guide link", True, False),
        ("empty entrypoint", False, True),
        ("broken module import", False, True),
    )
    for name, entry_ok, guide_ok in cases:
        with tempfile.TemporaryDirectory(prefix="example-navigation-") as raw:
            root = Path(raw)
            examples = root / "examples" / name.replace(" ", "-")
            examples.mkdir(parents=True)
            entry = examples / "main.mjs"
            guide = examples / "README.md"
            entry.write_text(
                "export function run() { return 1; }\n"
                if entry_ok
                else ("" if name == "empty entrypoint" else
                      'import "./missing.mjs";\n'),
                encoding="utf-8",
            )
            destination = examples / "guide.md"
            if guide_ok:
                destination.write_text("# Guide\n", encoding="utf-8")
                link = "guide.md"
            else:
                link = "missing-guide.md"
            guide.write_text(f"# Example\n\n[Guide]({link})\n", encoding="utf-8")
            findings = inspect(root)
            codes = {finding.code for finding in findings}
            expected = set()
            if not entry_ok:
                expected.add(
                    "empty_entrypoint" if name == "empty entrypoint"
                    else "missing_static_import"
                )
            if not guide_ok:
                expected.add("missing_local_navigation")
            if codes != expected:
                raise AssertionError(f"{name}: expected {expected}, got {codes}")
    print("fixture self-tests: passed")


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Check example entrypoints and local Markdown navigation."
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
        help="run deterministic temporary-fixture tests",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str]) -> int:
    args = parse_args(argv)
    if args.self_test:
        run_self_test()
    root = Path(args.root).expanduser().resolve()
    findings = inspect(root)
    if findings:
        for finding in findings:
            print(finding.format(root), file=sys.stderr)
        print(f"navigation check: {len(findings)} finding(s)", file=sys.stderr)
        return 1
    print(f"navigation check: {len(find_entrypoints(root))} entrypoint(s), "
          f"{len(find_guides(root))} guide(s)")
    print("AGOS_RUNTIME_OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
