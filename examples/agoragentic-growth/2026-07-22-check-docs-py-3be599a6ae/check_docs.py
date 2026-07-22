#!/usr/bin/env python3
"""Dependency-free documentation checker for local Markdown files."""
from __future__ import annotations
import argparse
import re
import sys
import tempfile
import unittest
from pathlib import Path
from urllib.parse import unquote, urlsplit

_LINK_RE = re.compile(r"!?\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)")
_REF_RE = re.compile(r"^\s{0,3}\[([^\]]+)\]:\s*(\S+)", re.MULTILINE)
_REF_USE_RE = re.compile(r"!?\[([^\]]+)\]\[([^\]]*)\]")
_FENCE_RE = re.compile(r"^\s{0,3}(`{3,}|~{3,})(.*)$")
_HEADING_RE = re.compile(r"^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$")


def _is_external(target: str) -> bool:
    parsed = urlsplit(target)
    return bool(parsed.scheme or parsed.netloc) or target.startswith(("#", "mailto:"))


def _target_path(source: Path, target: str) -> Path | None:
    target = unquote(target.strip().strip("<>"))
    if _is_external(target):
        return None
    parsed = urlsplit(target)
    path = parsed.path
    if not path:
        return None
    return (source.parent / path).resolve()


def _line_number(text: str, position: int) -> int:
    return text.count("\n", 0, position) + 1


def _reference_label(value: str) -> str:
    return " ".join(value.split()).casefold()


def _destination_error(
    source: Path, root: Path, target: str, line: int, kind: str
) -> str | None:
    destination = _target_path(source, target)
    if destination is None:
        return None
    try:
        destination.relative_to(root)
    except ValueError:
        return f"{source}:{line}: {kind} escapes root: {target}"
    if not destination.exists():
        return f"{source}:{line}: broken local {kind}: {target}"
    return None


def check_file(path: Path, root: Path | None = None) -> list[str]:
    """Return stable, human-readable diagnostics for one Markdown document."""
    path = path.resolve()
    root = (root or path.parent).resolve()
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        return [f"{path}:1: cannot read file: {exc}"]
    errors: list[str] = []
    stack: list[tuple[str, int]] = []
    for number, line in enumerate(text.splitlines(), 1):
        match = _FENCE_RE.match(line)
        if not match:
            continue
        marker = match.group(1)
        kind = marker[0]
        if stack:
            opened, opened_line = stack[-1]
            if kind == opened[0] and len(marker) >= len(opened):
                stack.pop()
        else:
            stack.append((marker, number))
    for marker, number in stack:
        errors.append(f"{path}:{number}: unclosed fenced code block ({marker})")
    for match in _LINK_RE.finditer(text):
        target = match.group(1)
        error = _destination_error(
            path, root, target, _line_number(text, match.start()), "link"
        )
        if error:
            errors.append(error)
    definitions: dict[str, tuple[str, int]] = {}
    for match in _REF_RE.finditer(text):
        label = _reference_label(match.group(1))
        target = match.group(2)
        line = _line_number(text, match.start())
        definitions[label] = (target, line)
        error = _destination_error(path, root, target, line, "reference")
        if error:
            errors.append(error)
    for match in _REF_USE_RE.finditer(text):
        label = match.group(2) or match.group(1)
        if _reference_label(label) not in definitions:
            errors.append(
                f"{path}:{_line_number(text, match.start())}: "
                f"undefined reference: {label}"
            )
    return errors


def discover(root: Path) -> list[Path]:
    """Find Markdown documents without following directory symlinks."""
    return sorted(
        item for item in root.rglob("*")
        if item.is_file() and item.suffix.lower() in {".md", ".markdown"}
    )


def check_tree(root: Path) -> list[str]:
    root = root.resolve()
    if not root.is_dir():
        return [f"{root}: not a directory"]
    errors: list[str] = []
    for path in discover(root):
        errors.extend(check_file(path, root))
    return errors


def _write(directory: Path, name: str, content: str) -> Path:
    path = directory / name
    path.write_text(content, encoding="utf-8")
    return path


class DocumentationCheckerTests(unittest.TestCase):
    def test_clean_documentation(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            _write(root, "guide.md", "# Guide\n\nSee [the next page](next.md).\n\n```python\nprint(1)\n```\n")
            _write(root, "next.md", "# Next\n")
            self.assertEqual(check_tree(root), [])

    def test_broken_relative_link(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            _write(root, "guide.md", "Missing [page](docs/nope.md).\n")
            errors = check_tree(root)
            self.assertEqual(len(errors), 1)
            self.assertIn("broken local link", errors[0])

    def test_broken_reference_link(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            _write(root, "guide.md", "See [page][docs].\n\n[docs]: missing.md\n")
            errors = check_tree(root)
            self.assertEqual(len(errors), 1)
            self.assertIn("broken local reference", errors[0])

    def test_undefined_full_and_collapsed_references(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            _write(root, "guide.md", "See [target][missing] and [collapsed][].\n")
            errors = check_tree(root)
            self.assertEqual(len(errors), 2)
            self.assertTrue(all("undefined reference" in error for error in errors))

    def test_reference_target_cannot_escape_root(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            container = Path(raw)
            root = container / "docs"
            root.mkdir()
            _write(container, "outside.md", "# Outside\n")
            _write(root, "guide.md", "See [outside][out].\n\n[out]: ../outside.md\n")
            errors = check_tree(root)
            self.assertEqual(len(errors), 1)
            self.assertIn("reference escapes root", errors[0])

    def test_malformed_fence(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            _write(root, "guide.md", "```python\nprint('unfinished')\n")
            errors = check_tree(root)
            self.assertEqual(len(errors), 1)
            self.assertIn("unclosed fenced code block", errors[0])

    def test_different_fence_types_do_not_close_each_other(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            _write(root, "guide.md", "```python\n~~~\n")
            errors = check_tree(root)
            self.assertEqual(len(errors), 1)

    def test_query_and_fragment_are_ignored_for_file_lookup(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            _write(root, "guide.md", "[page](next.md?view=full#part)\n")
            _write(root, "next.md", "# Next\n")
            self.assertEqual(check_tree(root), [])

    def test_external_links_are_not_fetched(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            _write(root, "guide.md", "[site](https://example.com/nope) [mail](mailto:a@example.com)\n")
            self.assertEqual(check_tree(root), [])


def run_self_test() -> None:
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(DocumentationCheckerTests)
    result = unittest.TextTestRunner(stream=sys.stderr, verbosity=0).run(suite)
    if not result.wasSuccessful():
        raise SystemExit(1)
    print("AGOS_RUNTIME_OK")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Check local Markdown links and fenced code blocks."
    )
    parser.add_argument("path", nargs="?", type=Path, help="Markdown file or directory")
    parser.add_argument("--self-test", action="store_true", help="run built-in tests")
    args = parser.parse_args(argv)
    if args.self_test or args.path is None:
        run_self_test()
        return 0
    target = args.path.resolve()
    errors = check_file(target, target.parent) if target.is_file() else check_tree(target)
    if errors:
        for error in errors:
            print(error, file=sys.stderr)
        print(f"{len(errors)} documentation issue(s) found.", file=sys.stderr)
        return 1
    print(f"Documentation OK: {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
