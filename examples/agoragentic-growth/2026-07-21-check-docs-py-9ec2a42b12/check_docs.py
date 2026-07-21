#!/usr/bin/env python3
"""Offline Markdown checker for relative links, headings, and local targets."""
from __future__ import annotations

import argparse
import re
import sys
import tempfile
from pathlib import Path
from urllib.parse import unquote, urlsplit

EXIT_OK = 0
EXIT_FINDINGS = 1
EXIT_USAGE = 2
HEADING_RE = re.compile(r"^( {0,3})(#{1,6})(.*)$")
LINK_RE = re.compile(r"!?\[([^\]]*)\]\(([^)\s]+)(?:\s+['\"].*?['\"])?\)")
REF_RE = re.compile(r"^\s*\[([^\]]+)\]:\s*(\S+)")
REF_USE_RE = re.compile(r"!?\[([^\]]+)\]\[([^\]]*)\]")
FENCE_RE = re.compile(r"^\s*(```|~~~)")
BAD_LINK_SCHEMES = {"http", "https", "mailto", "tel", "ftp", "data"}


def display(path: Path, root: Path) -> str:
    try:
        return str(path.relative_to(root))
    except ValueError:
        return str(path)


def slugify(text: str) -> str:
    text = re.sub(r"`([^`]*)`", r"\1", text)
    text = re.sub(r"<[^>]+>", "", text)
    text = text.strip().lower()
    text = re.sub(r"[^\w\s-]", "", text, flags=re.UNICODE)
    return re.sub(r"[\s-]+", "-", text).strip("-")


def heading_text(raw: str) -> str:
    value = raw.strip()
    value = re.sub(r"\s+#+\s*$", "", value).strip()
    return value


def reference_label(raw: str) -> str:
    return " ".join(raw.split()).casefold()


def markdown_files(root: Path) -> list[Path]:
    ignored = {".git", ".hg", ".svn", "node_modules", "venv", ".venv"}
    result = []
    for path in root.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in {".md", ".markdown"}:
            continue
        if any(part in ignored for part in path.parts):
            continue
        result.append(path)
    return sorted(result, key=lambda item: item.as_posix())


def read_lines(path: Path) -> list[str]:
    return path.read_text(encoding="utf-8").splitlines()


def collect_document(
    path: Path,
) -> tuple[list[tuple[int, str]], dict[str, int], list[str]]:
    headings = []
    anchors = {}
    errors = []
    try:
        lines = read_lines(path)
    except (OSError, UnicodeError) as exc:
        return [], {}, [f"{path}: cannot read file: {exc}"]
    fenced = False
    for number, line in enumerate(lines, 1):
        fence = FENCE_RE.match(line)
        if fence:
            fenced = not fenced
            continue
        if fenced:
            continue
        match = HEADING_RE.match(line)
        if match:
            marks, tail = match.group(2), match.group(3)
            if not tail.startswith(" "):
                errors.append(f"{path}:{number}: malformed heading (missing space)")
                continue
            text = heading_text(tail)
            if not text:
                errors.append(f"{path}:{number}: malformed heading (empty text)")
                continue
            if len(marks) > 6:
                errors.append(
                    f"{path}:{number}: malformed heading (too many levels)"
                )
                continue
            slug = slugify(text)
            headings.append((number, slug))
            if slug and slug not in anchors:
                anchors[slug] = number
            continue
        if line.lstrip().startswith("#") and line.lstrip().startswith("#" * 7):
            errors.append(
                f"{path}:{number}: malformed heading (too many levels)"
            )
        reference = REF_RE.match(line)
        if reference:
            continue
    counts = {}
    for number, slug in headings:
        if slug:
            counts[slug] = counts.get(slug, 0) + 1
    for slug, count in sorted(counts.items()):
        if count > 1:
            locations = [
                str(number) for number, item in headings if item == slug
            ]
            errors.append(
                f"{path}:{','.join(locations)}: duplicate heading #{slug}"
            )
    return headings, anchors, errors


def target_path(source: Path, target: str) -> tuple[Path | None, str | None]:
    parsed = urlsplit(target)
    if parsed.scheme.lower() in BAD_LINK_SCHEMES or parsed.netloc:
        return None, None
    if parsed.scheme:
        return None, None
    fragment = unquote(parsed.fragment)
    raw_path = unquote(parsed.path)
    if not raw_path:
        return source, fragment or None
    return (source.parent / raw_path).resolve(), fragment or None


def check_link(
    root: Path,
    source: Path,
    target: str,
    anchors: dict[Path, dict[str, int]],
) -> str | None:
    path, fragment = target_path(source, target)
    if path is None:
        return None
    try:
        path.relative_to(root.resolve())
    except ValueError:
        return f"{source}: link escapes repository: {target}"
    if not path.exists():
        return f"{source}: missing local target: {target}"
    if path.is_dir():
        index = path / "README.md"
        if not index.exists():
            return f"{source}: local target is a directory: {target}"
        path = index
    if fragment and path.suffix.lower() in {".md", ".markdown"}:
        if path not in anchors:
            _, found, _ = collect_document(path)
            anchors[path] = found
        if fragment.lower() not in anchors[path]:
            return f"{source}: missing heading anchor: {target}"
    return None


def check_file(
    root: Path,
    path: Path,
    anchors: dict[Path, dict[str, int]],
) -> list[str]:
    _, own_anchors, errors = collect_document(path)
    anchors[path] = own_anchors
    try:
        lines = read_lines(path)
    except (OSError, UnicodeError):
        return errors
    definitions: dict[str, tuple[str, int]] = {}
    fenced = False
    for number, line in enumerate(lines, 1):
        fence = FENCE_RE.match(line)
        if fence:
            fenced = not fenced
            continue
        if fenced:
            continue
        reference = REF_RE.match(line)
        if reference:
            label = reference_label(reference.group(1))
            definitions.setdefault(label, (reference.group(2), number))
    fenced = False
    for number, line in enumerate(lines, 1):
        fence = FENCE_RE.match(line)
        if fence:
            fenced = not fenced
            continue
        if fenced:
            continue
        for match in LINK_RE.finditer(line):
            problem = check_link(root, path, match.group(2), anchors)
            if problem:
                errors.append(f"{problem} (line {number})")
        reference = REF_RE.match(line)
        if reference:
            problem = check_link(root, path, reference.group(2), anchors)
            if problem:
                errors.append(f"{problem} (line {number})")
            continue
        for match in REF_USE_RE.finditer(line):
            raw_label = match.group(2) or match.group(1)
            if reference_label(raw_label) not in definitions:
                errors.append(
                    f"{path}: undefined reference label: {raw_label} "
                    f"(line {number})"
                )
    return errors


def check(root: Path) -> list[str]:
    root = root.resolve()
    if not root.is_dir():
        return [f"{root}: repository root is not a directory"]
    files = markdown_files(root)
    anchors: dict[Path, dict[str, int]] = {}
    findings = []
    for path in files:
        findings.extend(check_file(root, path, anchors))
    return sorted(findings)


def render(findings: list[str]) -> None:
    if findings:
        for finding in findings:
            print(finding)
        print(f"{len(findings)} documentation issue(s) found.")
    else:
        print("Documentation check passed.")


def run_self_test() -> int:
    with tempfile.TemporaryDirectory(prefix="check-docs-") as name:
        root = Path(name)
        good = root / "good.md"
        good.write_text(
            "# Good\n\n[Other](other.md#target)\n\n"
            "[Reference][other]\n\n[Collapsed][]\n\n"
            "[other]: other.md#target\n[collapsed]: other.md#target\n",
            encoding="utf-8",
        )
        (root / "other.md").write_text("# Target\n", encoding="utf-8")
        assert check(root) == []
        bad = root / "bad.md"
        bad.write_text(
            "# Repeat\n# Repeat\n\n[missing](nope.md)\n\n"
            "[bad-anchor](other.md#absent)\n\n"
            "[missing-reference]: absent.md\n\n"
            "[undefined][missing-ref]\n\n[collapsed-missing][]\n##broken\n",
            encoding="utf-8",
        )
        findings = check(root)
        assert len(findings) == 7, findings
        assert any("duplicate heading" in item for item in findings)
        assert any("missing local target" in item for item in findings)
        assert any("absent.md" in item for item in findings)
        assert any("missing heading anchor" in item for item in findings)
        assert any("malformed heading" in item for item in findings)
        assert any("undefined reference label: missing-ref" in item for item in findings)
        assert any(
            "undefined reference label: collapsed-missing" in item
            for item in findings
        )
        bad.unlink()
        assert check(root) == []
    print("AGOS_RUNTIME_OK")
    return EXIT_OK


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Check repository Markdown links and headings without network access."
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
        help="run the deterministic temporary-fixture self-test",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return int(exc.code)
    if args.self_test:
        return run_self_test()
    root = Path(args.root)
    try:
        findings = check(root)
    except (OSError, ValueError) as exc:
        print(f"checker error: {exc}", file=sys.stderr)
        return EXIT_USAGE
    render(findings)
    if findings:
        return EXIT_FINDINGS
    print("AGOS_RUNTIME_OK")
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
