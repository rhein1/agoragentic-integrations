#!/usr/bin/env python3
"""Offline smoke checks for runnable examples and their documentation."""

import argparse
import os
import re
import sys
import tempfile
from pathlib import Path
from urllib.parse import unquote, urlsplit


ENTRYPOINT_NAMES = (
    "main.py",
    "run.py",
    "example.py",
    "demo.py",
    "index.py",
    "main.mjs",
    "run.mjs",
    "example.mjs",
    "demo.mjs",
    "index.mjs",
    "main.js",
    "run.js",
    "example.js",
    "demo.js",
    "index.js",
)
SOURCE_SUFFIXES = {".py", ".mjs", ".js"}
LINK_RE = re.compile(r"(?<!!)\[[^\]]+\]\(([^)\s]+)(?:\s+['\"][^'\"]*['\"])?\)")
HEADING_RE = re.compile(r"^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$")


def relative_files(root, suffixes=None):
    """Return regular files below root in stable relative-path order."""
    found = []
    if not root.exists():
        return found
    for path in root.rglob("*"):
        if not path.is_file() or path.is_symlink():
            continue
        if suffixes is None or path.suffix.lower() in suffixes:
            found.append(path)
    return sorted(found, key=lambda item: item.as_posix())


def markdown_links(path):
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        return [], ["cannot_read_document: {} ({})".format(path, exc)]
    links = []
    for match in LINK_RE.finditer(text):
        target = match.group(1).strip().strip("<>")
        if target:
            links.append(target)
    return links, []


def is_external(target):
    parsed = urlsplit(target)
    return bool(parsed.scheme or parsed.netloc) or target.startswith("//")


def resolve_doc_target(document, target):
    parsed = urlsplit(unquote(target))
    if parsed.fragment and not parsed.path:
        return document, parsed.fragment
    if is_external(target) or not parsed.path:
        return None, parsed.fragment
    candidate = (document.parent / parsed.path).resolve()
    return candidate, parsed.fragment


def heading_anchors(document):
    try:
        text = document.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        return set()
    anchors = set()
    for line in text.splitlines():
        match = HEADING_RE.match(line)
        if not match:
            continue
        value = re.sub(r"[^\w\s-]", "", match.group(1).lower())
        anchors.add(re.sub(r"\s+", "-", value).strip("-"))
    return anchors


def check_document(document, root):
    findings = []
    links, errors = markdown_links(document)
    for message in errors:
        findings.append(("error", message))
    seen = {}
    for target in links:
        path, fragment = resolve_doc_target(document, target)
        if path is None:
            continue
        normalized = os.path.normcase(os.path.normpath(str(path)))
        if normalized in seen:
            findings.append((
                "error",
                "{}: duplicate navigation target '{}' (also linked as '{}')".format(
                    document.relative_to(root), target, seen[normalized]
                ),
            ))
        else:
            seen[normalized] = target
        if not path.exists():
            findings.append((
                "error",
                "{}: broken relative link '{}'".format(
                    document.relative_to(root), target
                ),
            ))
        elif fragment and path.suffix.lower() in {".md", ".markdown"}:
            if fragment.lower() not in heading_anchors(path):
                findings.append((
                    "error",
                    "{}: missing document anchor '{}' in '{}'".format(
                        document.relative_to(root), fragment, path.relative_to(root)
                    ),
                ))
    return findings


def candidate_entrypoints(directory):
    candidates = []
    for name in ENTRYPOINT_NAMES:
        path = directory / name
        if path.is_file() and not path.is_symlink():
            candidates.append(path)
    return candidates


def check_entrypoint(path, root):
    findings = []
    relative = path.relative_to(root)
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        return [("error", "{}: cannot read entrypoint ({})".format(relative, exc))]
    if not text.strip():
        findings.append(("error", "{}: entrypoint is empty".format(relative)))
    if path.suffix.lower() not in SOURCE_SUFFIXES:
        findings.append(("error", "{}: unsupported entrypoint type".format(relative)))
    if path.suffix.lower() == ".py" and "def " not in text and "if __name__" not in text:
        findings.append((
            "warning",
            "{}: Python entrypoint has no function or main guard".format(relative),
        ))
    if path.suffix.lower() in {".js", ".mjs"} and not re.search(
        r"\b(import|export|function|const|let|var)\b", text
    ):
        findings.append((
            "warning",
            "{}: JavaScript entrypoint has no recognizable module code".format(relative),
        ))
    return findings


def discover_example_directories(examples):
    directories = []
    if not examples.is_dir():
        return directories
    for directory in sorted(
        (item for item in examples.rglob("*") if item.is_dir()),
        key=lambda item: item.as_posix(),
    ):
        if (directory / "README.md").is_file() or candidate_entrypoints(directory):
            directories.append(directory)
    return directories


def run_checks(root):
    findings = []
    examples = root / "examples"
    if not examples.is_dir():
        return [("error", "{}: missing examples directory".format(examples))]
    directories = discover_example_directories(examples)
    if not directories:
        findings.append(("warning", "examples: no runnable example directories discovered"))
    for directory in directories:
        readme = directory / "README.md"
        if not readme.is_file():
            findings.append((
                "error",
                "{}: missing README.md".format(directory.relative_to(root)),
            ))
        entries = candidate_entrypoints(directory)
        if not entries:
            findings.append((
                "error",
                "{}: no recognized entrypoint ({})".format(
                    directory.relative_to(root), ", ".join(ENTRYPOINT_NAMES)
                ),
            ))
        for entrypoint in entries:
            findings.extend(check_entrypoint(entrypoint, root))
        if readme.is_file():
            findings.extend(check_document(readme, root))
    return findings


def format_findings(findings):
    lines = []
    for severity, message in findings:
        lines.append("{}: {}".format(severity.upper(), message))
    return lines


def self_test():
    cases = (
        ("valid example", True, "[Guide](README.md)\n", "def main():\n    return 1\n"),
        ("missing readme target", False, "[Guide](missing.md)\n", "def main():\n    pass\n"),
        ("duplicate navigation", False, "[A](README.md) [B](README.md)\n", "def main():\n    pass\n"),
        ("missing entrypoint", False, "# Example\n", ""),
        ("empty entrypoint", False, "[Guide](README.md)\n", ""),
    )
    for name, expected_ok, readme, source in cases:
        with tempfile.TemporaryDirectory(prefix="example-smoke-") as temp:
            root = Path(temp)
            directory = root / "examples" / "fixture"
            directory.mkdir(parents=True)
            (directory / "README.md").write_text(readme, encoding="utf-8")
            if source:
                (directory / "main.py").write_text(source, encoding="utf-8")
            findings = run_checks(root)
            actual_ok = not any(level == "error" for level, _ in findings)
            if actual_ok != expected_ok:
                raise AssertionError("{}: expected {}, got {}".format(
                    name, expected_ok, format_findings(findings)
                ))
    print("AGOS_RUNTIME_OK")
    return 0


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root",
        type=Path,
        default=Path(__file__).resolve().parent.parent,
        help="repository root (default: parent of scripts)",
    )
    parser.add_argument("--self-test", action="store_true")
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    if args.self_test:
        return self_test()
    root = args.root.resolve()
    findings = run_checks(root)
    for line in format_findings(findings):
        print(line)
    errors = sum(level == "error" for level, _ in findings)
    print("Checked {}: {} error(s), {} warning(s)".format(
        root,
        errors,
        sum(level == "warning" for level, _ in findings),
    ))
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
